// feedback-scan.test.mjs — finding who a house was pitched to, from the
// conversations, when the blast didn't go through the app.

import test from "node:test";
import assert from "node:assert/strict";
import { pitchPatterns, startFeedbackScan, getScanJob, _resetScanJobs } from "./feedback-scan.js";

const settle = () => new Promise((r) => setTimeout(r, 30));
const OFFER = { id: "o1", locationId: "LOC", address: "22018 76th Avenue West, Edmonds, Washington 98026", deal: { createdAt: "2026-09-04T15:59:00.000Z" } };

test("the house is recognised by street line, either suffix, and by city and zip", () => {
  const pats = pitchPatterns(OFFER.address);
  const hit = (s) => pats.some((p) => p.test(s));
  assert.ok(hit("Have a property at 22018 76th Avenue W, Edmonds"));
  assert.ok(hit("22018 76th Avenue West"));
  assert.ok(hit("just got a new flip under contract in Edmonds (98026). This one's solid."));
  assert.equal(hit("a house in Edmonds (22018)"), false, "the house number is not the zip");
  assert.equal(hit("Have one in Issaquah 98029"), false);
});

// A GHL client that serves canned conversations and messages by path.
function fakeGhl({ conversations, messages }) {
  return { call: async (path) => {
    // One page: a second call (with startAfterDate) has nothing older.
    if (path.startsWith("/conversations/search")) return { conversations: /startAfterDate/.test(path) ? [] : conversations, total: conversations.length };
    const m = /\/conversations\/([^/]+)\/messages/.exec(path);
    if (m) return { messages: { messages: messages[m[1]] || [], nextPage: false } };
    throw new Error(`unexpected ${path}`);
  } };
}
const fakeStore = () => {
  const events = [];
  return { events,
    async appendContactEvents(_loc, contactId, rows) { let inserted = 0; for (const r of rows) { if (events.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue; events.push({ ...r, contactId }); inserted++; } return { inserted, skipped: rows.length - inserted }; },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; } };
};
const msg = (dir, body, at) => ({ id: `m-${Math.random()}`, direction: dir, body, dateAdded: at });

test("a conversation where we pitched the house becomes a blast_sent event, with whether they replied", async () => {
  _resetScanJobs();
  const client = fakeGhl({
    conversations: [
      { id: "c1", contactId: "b1", contactName: "Boris D", lastMessageDate: Date.parse("2026-09-07T21:00:00Z") },
      { id: "c2", contactId: "b2", contactName: "Kelly M", lastMessageDate: Date.parse("2026-09-07T20:45:00Z") },
      { id: "c3", contactId: "b3", contactName: "Someone Else", lastMessageDate: Date.parse("2026-09-08T10:00:00Z") },
    ],
    messages: {
      c1: [msg("outbound", "Hi Boris, have a property under contract at 22018 76th Avenue W, Edmonds", "2026-09-07T20:44:00Z"), msg("inbound", "Yup interested", "2026-09-07T20:49:00Z")],
      c2: [msg("outbound", "Hi Kelly got your info from a recent flip... 22018 76th Avenue W", "2026-09-07T20:45:00Z")],
      c3: [msg("outbound", "Hi, I have one in Issaquah 98029", "2026-09-08T10:00:00Z"), msg("inbound", "no thanks", "2026-09-08T10:05:00Z")],
    },
  });
  const store = fakeStore();
  const job = startFeedbackScan({ client, locationId: "LOC", store, offer: OFFER, deps: { paceMs: 0 } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(job.recipients, 2);
  assert.equal(job.replied, 1);
  const ev = store.events.filter((e) => e.type === "blast_sent");
  assert.deepEqual(ev.map((e) => [e.contactId, e.data.replied]).sort(), [["b1", true], ["b2", false]]);
  assert.equal(ev[0].offerId, "o1");
  assert.equal(ev[0].dedupeKey, "blast:o1:b1");
});

test("a reply from before the pitch is not a reply to it", async () => {
  _resetScanJobs();
  const client = fakeGhl({
    conversations: [{ id: "c1", contactId: "b1", lastMessageDate: Date.parse("2026-09-07T21:00:00Z") }],
    messages: { c1: [msg("inbound", "hey any deals?", "2026-09-05T10:00:00Z"), msg("outbound", "22018 76th Avenue W, Edmonds", "2026-09-07T20:44:00Z")] },
  });
  const store = fakeStore();
  const job = startFeedbackScan({ client, locationId: "LOC", store, offer: OFFER, deps: { paceMs: 0 } });
  await settle();
  assert.equal(job.replied, 0);
  assert.equal(store.events[0].data.replied, false);
});

test("running the scan twice records nothing new", async () => {
  _resetScanJobs();
  const client = fakeGhl({ conversations: [{ id: "c1", contactId: "b1", lastMessageDate: Date.parse("2026-09-07T21:00:00Z") }],
    messages: { c1: [msg("outbound", "22018 76th Avenue W", "2026-09-07T20:44:00Z")] } });
  const store = fakeStore();
  startFeedbackScan({ client, locationId: "LOC", store, offer: OFFER, deps: { paceMs: 0 } }); await settle();
  _resetScanJobs();
  const second = startFeedbackScan({ client, locationId: "LOC", store, offer: OFFER, deps: { paceMs: 0 } }); await settle();
  assert.equal(second.recorded, 0);
  assert.equal(store.events.length, 1);
  assert.ok(getScanJob("o1"));
});

test("a second scan cannot start while one is running", () => {
  _resetScanJobs();
  const client = { call: () => new Promise(() => {}) };
  startFeedbackScan({ client, locationId: "LOC", store: fakeStore(), offer: OFFER });
  assert.throws(() => startFeedbackScan({ client, locationId: "LOC", store: fakeStore(), offer: OFFER }), /already running/);
});
