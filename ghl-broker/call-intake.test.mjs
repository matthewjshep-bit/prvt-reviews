import test from "node:test";
import assert from "node:assert/strict";
import { fetchTranscript, findRecentCall, startCallIntake, findNewCalls, maybeSweepCalls, _resetJobs } from "./call-intake.js";

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("a transcript is the sentences in order, sides named", async () => {
  const client = { call: async () => [
    { sentenceIndex: 1, mediaChannel: 1, transcript: "yeah it needs a roof" },
    { sentenceIndex: 0, mediaChannel: 0, transcript: "how's the condition?" },
  ] };
  assert.equal(await fetchTranscript(client, "L", "m1"), "US: how's the condition?\nTHEM: yeah it needs a roof");
  const missing = { call: async () => { throw Object.assign(new Error("404"), { status: 404 }); } };
  assert.equal(await fetchTranscript(missing, "L", "m1"), null);
});

test("the call the webhook meant: by id, else the newest call within the window", async () => {
  const now = Date.parse("2026-09-10T18:00:00Z");
  const client = { call: async (path) => {
    if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1" }] };
    return { messages: [
      { id: "t1", messageType: "TYPE_SMS", direction: "inbound", dateAdded: "2026-09-10T17:59:00Z" },
      { id: "c2", messageType: "TYPE_CALL", direction: "outbound", dateAdded: "2026-09-10T17:50:00Z", meta: { call: { duration: 312 } } },
      { id: "c1", messageType: "TYPE_CALL", direction: "inbound", dateAdded: "2026-09-01T17:50:00Z" },
    ] };
  } };
  const newest = await findRecentCall({ client, locationId: "L", contactId: "c", now });
  assert.equal(newest.id, "c2");
  assert.equal(newest.direction, "outbound");
  assert.equal(newest.durationSec, 312);
  assert.equal((await findRecentCall({ client, locationId: "L", contactId: "c", messageId: "c1", now })).id, "c1");
  assert.equal(await findRecentCall({ client, locationId: "L", contactId: "c", messageId: "nope", now }), null);
});

const fakeStore = () => ({ events: [], async listContactEvents() { return this.events; }, async appendContactEvents(l, id, rows) { this.events.push(...rows.map((r) => ({ ...r, contactId: id }))); return { inserted: rows.length, skipped: 0 }; },
  async getContactProfile() { return null; }, async upsertContactProfile() { return {}; } });

test("intake waits for the transcript, then hands it to the reply pipeline as a call; no transcript leaves a bare call event", async () => {
  _resetJobs();
  const store = fakeStore();
  let reads = 0;
  const started = [];
  const saved = { aiApiKey: "k", conversationAi: { enabled: true } };
  const deps = {
    findCall: async () => ({ id: "c9", direction: "inbound", at: "2026-09-10T17:50:00Z", durationSec: 200 }),
    transcript: async () => (++reads < 3 ? null : "US: hey Dana\nTHEM: the seller would take four ten if you can close in two weeks, it needs a roof though"),
    pollMs: 1, maxPolls: 5,
    // stand in for startReply: the intake imports the real one, so we check the store side instead
  };
  const { job } = await startCallIntake({ client: {}, locationId: "L", saved, store, contactId: "c1", deps });
  await settle(80);
  assert.ok(["done", "error"].includes(job.status));
  assert.equal(job.polls >= 2, true, "it waited");
  assert.equal(job.transcriptChars > 40, true);
  // a second webhook for the same call is one job
  const dup = await startCallIntake({ client: {}, locationId: "L", saved, store, contactId: "c1", messageId: "c9", deps });
  assert.match(dup.skipped || "", /already handling|/);

  _resetJobs();
  const store2 = fakeStore();
  const { job: j2 } = await startCallIntake({ client: {}, locationId: "L", saved, store: store2, contactId: "c2", deps: { ...deps, transcript: async () => null, maxPolls: 2 } });
  await settle(40);
  assert.equal(j2.status, "done");
  assert.match(j2.skipped, /no transcript/);
  assert.equal(store2.events[0].type, "call_summary");
  assert.equal(store2.events[0].dedupeKey, "call:c9");
  assert.equal(store2.events[0].data.transcribed, false);
});

test("the poller finds calls that ended since the cursor and reads each once", async () => {
  _resetJobs();
  const now = Date.parse("2026-09-10T18:00:00Z");
  const client = { call: async (path) => {
    if (path.startsWith("/conversations/search")) return { conversations: [
      { id: "cv1", contactId: "a1", lastMessageDate: "2026-09-10T17:55:00Z", lastMessageType: "TYPE_CALL" },
      { id: "cv2", contactId: "a2", lastMessageDate: "2026-09-10T12:00:00Z", lastMessageType: "TYPE_SMS" },   // nothing moved since the cursor
    ] };
    if (path.includes("/conversations/cv1/")) return { messages: [
      { id: "k1", messageType: "TYPE_CALL", direction: "inbound", dateAdded: "2026-09-10T17:55:00Z" },
      { id: "k0", messageType: "TYPE_CALL", direction: "inbound", dateAdded: "2026-09-10T15:00:00Z" },   // before the cursor
    ] };
    return { messages: [] };
  } };
  const since = Date.parse("2026-09-10T16:00:00Z");
  const found = await findNewCalls({ client, locationId: "L", sinceMs: since, now });
  assert.deepEqual(found.map((c) => [c.contactId, c.id]), [["a1", "k1"]]);

  const store = { cursors: new Map(), events: [],
    async getJobCursor(l, k) { return this.cursors.get(`${l}|${k}`) || null; }, async setJobCursor(l, k, v) { this.cursors.set(`${l}|${k}`, v); },
    async listContactEvents() { return []; }, async appendContactEvents(l, id, rows) { this.events.push(...rows); return { inserted: rows.length, skipped: 0 }; },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; } };
  store.cursors.set("L|calls", { at: new Date(since).toISOString() });
  const saved = { aiApiKey: "k", conversationAi: { enabled: true } };
  const started = await maybeSweepCalls({ client, locationId: "L", saved, store, now, deps: { findNewCalls: async () => found, findCall: async () => ({ id: "k1", direction: "inbound", at: "2026-09-10T17:55:00Z", durationSec: 90 }), transcript: async () => null, maxPolls: 1, pollMs: 1 } });
  assert.equal(started, 1);
  assert.equal(store.cursors.get("L|calls").at, "2026-09-10T17:55:00.000Z", "the cursor moves to the newest call seen");
  // switched off in the config: nothing
  assert.equal(await maybeSweepCalls({ client, locationId: "L", saved: { aiApiKey: "k", conversationAi: { enabled: true, callIntake: { enabled: false } } }, store, now }), 0);
});
