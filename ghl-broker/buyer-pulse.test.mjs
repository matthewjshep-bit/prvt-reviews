// buyer-pulse.test.mjs — the daily runner. No model, no network: the book and
// startProactive come in through deps.

import test from "node:test";
import assert from "node:assert/strict";
import { maybeRunBuyerPulse, startBuyerPulse, planBuyerPulse, getBuyerPulseJob, _resetJobs, CURSOR_NAME } from "./buyer-pulse.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { normalizeDispoAutopilot } from "./dispo-autopilot.js";

const HOUR = 3600000;
const DAY = 24 * HOUR;
// Friday 2026-09-18, 11:05am Pacific.
const NOW = Date.parse("2026-09-18T18:05:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const saved = (pulse = {}) => ({ aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true }), dispoAutopilot: { pulse: { enabled: true, ...pulse } } });
const buyer = (id, over = {}) => ({ contactId: id, name: `Buyer ${id}`, status: "active", phone: "+12065550100", tags: [], score: 10, lastMessageAt: ago(30), ...over });

const fakeStore = ({ events = [], drafts = [] } = {}) => {
  const rows = [...events];
  let cursor = null;
  const writes = [];
  return {
    events: rows, writes,
    get cursor() { return cursor; },
    async listContactEventsSince(_loc, since, { types = null } = {}) { return rows.filter((e) => e.at >= since && (!types || types.includes(e.type))); },
    async appendContactEvents(_loc, contactId, add) {
      let inserted = 0;
      for (const r of add) {
        if (r.dedupeKey && rows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue;
        rows.push({ ...r, contactId }); inserted++;
      }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; },
    async upsertContactProfile() { return {}; },
    async listReplyDrafts(_loc, { status } = {}) { return drafts.filter((d) => !status || d.status === status); },
    async getJobCursor() { return cursor; },
    async setJobCursor(_loc, name, v) { assert.equal(name, CURSOR_NAME); cursor = v; writes.push(JSON.parse(JSON.stringify(v))); },
  };
};
const starter = (book) => {
  const calls = [];
  return { calls, book: async () => book, startProactive: async (args) => { calls.push(args); return { skipped: null, job: { id: `j${calls.length}` } }; } };
};
const done = async (loc = "LOC") => { for (let i = 0; i < 50 && getBuyerPulseJob(loc)?.status === "running"; i++) await new Promise((r) => setImmediate(r)); return getBuyerPulseJob(loc); };

test("it ships off: nothing runs until the pulse check is switched on", async () => {
  _resetJobs();
  assert.equal(normalizeDispoAutopilot({}).pulse.enabled, false);
  const s = starter([buyer("a")]);
  const ran = await maybeRunBuyerPulse({ locationId: "LOC", saved: { ...saved(), dispoAutopilot: {} }, store: fakeStore(), deps: s, now: NOW });
  assert.equal(ran, false);
  assert.equal(s.calls.length, 0);
});

test("in its hour on a workday it claims each buyer, then hands them to the bot as a buyer_pulse", async () => {
  _resetJobs();
  const store = fakeStore();
  const s = starter([buyer("a", { engagement: { blasts: 3 } }), buyer("b", { lastRepliedAt: ago(60) })]);
  const ran = await maybeRunBuyerPulse({ locationId: "LOC", saved: saved(), store, deps: s, now: NOW, sendsEnabled: true, blastsEnabled: true });
  assert.equal(ran, true);
  assert.ok(store.writes[0].doc.run, "the cursor is written before the run");
  const job = await done();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(s.calls.map((c) => [c.contactId, c.kind]), [["a", "buyer_pulse"], ["b", "buyer_pulse"]]);
  assert.equal(s.calls[0].subject.dealsSent, 3);
  assert.equal(s.calls[1].subject.conversed, true);
  assert.equal(store.events.filter((e) => e.type === "pulse_sent").length, 2);
  assert.equal(store.cursor.doc.run, undefined, "and cleared when it finishes");
  assert.equal(store.cursor.doc.last.started, 2);
  const again = await maybeRunBuyerPulse({ locationId: "LOC", saved: saved(), store, deps: s, now: NOW + 20 * 60000 });
  assert.equal(again, false, "a finished day is not repeated");
});

test("not at the weekend, and not outside its hours", async () => {
  _resetJobs();
  const s = starter([buyer("a")]);
  assert.equal(await maybeRunBuyerPulse({ locationId: "LOC", saved: saved(), store: fakeStore(), deps: s, now: NOW + DAY }), false, "Saturday");
  assert.equal(await maybeRunBuyerPulse({ locationId: "LOC", saved: saved(), store: fakeStore(), deps: s, now: NOW - 3 * HOUR }), false, "8am");
});

test("switched on, it drafts; it only sends itself with the second switch and the broker's gates open", async () => {
  for (const [pulse, gates, expectRelease, expectLive] of [
    [{}, { sendsEnabled: true, blastsEnabled: true }, false, true],
    [{ autoSend: true }, { sendsEnabled: true, blastsEnabled: true }, true, true],
    [{ autoSend: true }, { sendsEnabled: true, blastsEnabled: false }, true, false],
  ]) {
    _resetJobs();
    const s = starter([buyer("a")]);
    startBuyerPulse({ locationId: "LOC", saved: saved(pulse), store: fakeStore(), deps: s, now: NOW, ...gates });
    const job = await done();
    assert.equal(Boolean(s.calls[0].deps.releaseHeld), expectRelease);
    assert.equal(s.calls[0].sendsEnabled, expectLive, "DISPO_BLASTS_ENABLED off means the bot is told sends are off");
    assert.equal(job.autoSend, expectRelease && expectLive);
  }
});

test("a dry run names who it would text and touches nobody", async () => {
  _resetJobs();
  const store = fakeStore();
  const s = starter([buyer("a"), buyer("b")]);
  startBuyerPulse({ locationId: "LOC", saved: saved(), store, deps: s, now: NOW, dryRun: true });
  const job = await done();
  assert.equal(job.picked, 2);
  assert.equal(s.calls.length, 0);
  assert.equal(store.events.length, 0);
  assert.deepEqual(job.results.map((r) => r.status), ["would draft", "would draft"]);
});

test("the cap is the day's: a second run the same day only fills the seats still empty", async () => {
  _resetJobs();
  const store = fakeStore();
  const book = Array.from({ length: 8 }, (_, i) => buyer(`b${i}`, { score: 50 - i }));
  const s = starter(book);
  startBuyerPulse({ locationId: "LOC", saved: saved({ dailyCap: 5 }), store, deps: s, now: NOW, limit: 3 });
  await done();
  assert.equal(s.calls.length, 3);
  startBuyerPulse({ locationId: "LOC", saved: saved({ dailyCap: 5 }), store, deps: s, now: NOW + HOUR });
  await done();
  assert.equal(s.calls.length, 5, "two seats were left, not five");
  assert.equal(new Set(s.calls.map((c) => c.contactId)).size, 5, "and nobody twice");
  const plan = await planBuyerPulse({ locationId: "LOC", saved: saved({ dailyCap: 5 }), store, deps: s, now: NOW + 2 * HOUR });
  assert.equal(plan.picks.length, 0);
  assert.equal(plan.counts.seatsLeft, 0);
});

test("a buyer pulsed last month waits out the quarter; a buyer with a draft already waiting is left alone", async () => {
  _resetJobs();
  const store = fakeStore({
    events: [{ contactId: "pulsed", type: "pulse_sent", at: ago(30), dedupeKey: "x" }],
    drafts: [{ contactId: "waiting", status: "draft" }],
  });
  const s = starter([buyer("pulsed"), buyer("waiting"), buyer("fresh")]);
  startBuyerPulse({ locationId: "LOC", saved: saved(), store, deps: s, now: NOW });
  await done();
  assert.deepEqual(s.calls.map((c) => c.contactId), ["fresh"]);
});

test("a run that died is tried again that afternoon, and the dead run's buyers are not texted twice", async () => {
  _resetJobs();
  const store = fakeStore();
  const s = starter([buyer("a"), buyer("b")]);
  await store.setJobCursor("LOC", CURSOR_NAME, { at: new Date(NOW).toISOString(), doc: { tries: 1, lastDaily: new Date(NOW).toISOString(), run: { startedAt: new Date(NOW).toISOString() } } });
  store.events.push({ contactId: "a", type: "pulse_sent", at: new Date(NOW).toISOString(), dedupeKey: "pulse_sent:a:2026-09-18" });
  assert.equal(await maybeRunBuyerPulse({ locationId: "LOC", saved: saved(), store, deps: s, now: NOW + 10 * 60000 }), false, "not stale yet");
  assert.equal(await maybeRunBuyerPulse({ locationId: "LOC", saved: saved(), store, deps: s, now: NOW + 50 * 60000 }), true);
  await done();
  assert.deepEqual(s.calls.map((c) => c.contactId), ["b"]);
});
