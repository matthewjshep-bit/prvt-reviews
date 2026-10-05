// buyer-pulse.test.mjs — the daily runner. No model, no network: the book and
// startProactive come in through deps.

import test from "node:test";
import assert from "node:assert/strict";
import { maybeRunBuyerPulse, startBuyerPulse, planBuyerPulse, previewBuyerPulse, getBuyerPulseJob, _resetJobs, CURSOR_NAME } from "./buyer-pulse.js";
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
  // The runner reads each buyer from GHL before claiming (2026-09-29): a
  // reachable contact, unless a test says otherwise.
  return { calls, book: async () => book, getContact: async (id) => ({ id, phone: "+12065550100", tags: [] }),
    startProactive: async (args) => { calls.push(args); return { skipped: null, job: { id: `j${calls.length}`, draftId: `d${calls.length}` } }; } };
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

test("each text in a day gets a different way in, and a second batch carries on rather than starting over", async () => {
  _resetJobs();
  const store = fakeStore();
  const s = starter(Array.from({ length: 6 }, (_, i) => buyer(`b${i}`, { score: 50 - i })));
  startBuyerPulse({ locationId: "LOC", saved: saved(), store, deps: s, now: NOW, limit: 2 });
  await done();
  startBuyerPulse({ locationId: "LOC", saved: saved(), store, deps: s, now: NOW + HOUR, limit: 2 });
  await done();
  assert.deepEqual(s.calls.map((c) => c.subject.variant), [0, 1, 2, 3]);
});

/* ---------- DND never burns a seat; a void gives the claim back (2026-09-29) ---------- */

test("an unsubscribed buyer is skipped before the claim, and the seat goes to the next in line", async () => {
  _resetJobs();
  const store = fakeStore();
  const s = starter([buyer("stop", { score: 90 }), buyer("next", { score: 50 }), buyer("third", { score: 10 })]);
  s.getContact = async (id) => ({ id, phone: "+12065550100", tags: [], ...(id === "stop" ? { dndSettings: { SMS: { status: "permanent" } } } : {}) });
  s.markedUnsub = [];
  startBuyerPulse({ locationId: "LOC", saved: saved({ dailyCap: 1, conversedShare: 0 }), store, deps: s, trigger: "manual", now: NOW, client: { call: async () => ({}) } });
  const job = await done();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(s.calls.map((c) => c.contactId), ["next"], "the seat went to the next buyer");
  assert.equal(store.events.some((e) => e.type === "pulse_sent" && e.contactId === "stop"), false, "never claimed");
  assert.ok(store.events.some((e) => e.type === "unsubscribed" && e.contactId === "stop"), "and remembered");
});

test("a check-in the bot stood down on gives the claim back: no seat spent, no cadence started", async () => {
  _resetJobs();
  const store = fakeStore();
  const s = starter([buyer("a")]);
  s.startProactive = async () => ({ skipped: "you replied to them 5 minutes ago — you have the thread" });
  startBuyerPulse({ locationId: "LOC", saved: saved({ dailyCap: 2 }), store, deps: s, trigger: "manual", now: NOW });
  await done();
  assert.ok(store.events.some((e) => e.type === "pulse_voided"));
  const plan = await planBuyerPulse({ locationId: "LOC", saved: saved({ dailyCap: 2 }), store, deps: s, now: NOW + DAY });
  assert.equal(plan.counts.claimedToday, 0);
  assert.deepEqual(plan.picks.map((p) => p.contactId), ["a"], "tomorrow they're picked again — no 30-day wait for a text that never went");
});

// One buyer, one week (2026-10-05): a buyer who got a deal two days ago isn't
// also asked what they're buying. The seat goes to the next in line.
test("a buyer who heard from us this week isn't pulsed, and the next in line gets the seat", async () => {
  _resetJobs();
  const store = fakeStore();
  const sentBlast = { id: "b1", contactId: "busy", status: "sent", party: "investor", outbound: { kind: "blast_open" }, sentAt: ago(2), createdAt: ago(2) };
  store.listReplyDrafts = async (_loc, { status, contactId } = {}) => [sentBlast].filter((d) => (!status || d.status === status) && (!contactId || d.contactId === contactId));
  const s = starter([buyer("busy", { score: 90 }), buyer("next", { score: 50 })]);
  startBuyerPulse({ locationId: "LOC", saved: saved({ dailyCap: 1, conversedShare: 0 }), store, deps: s, trigger: "manual", now: NOW, client: { call: async () => ({}) } });
  const job = await done();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(s.calls.map((c) => c.contactId), ["next"]);
  assert.match(job.results.find((r) => r.contactId === "busy").reason, /heard from us this week/);
  assert.equal(store.events.some((e) => e.type === "pulse_sent" && e.contactId === "busy"), false, "never claimed");
});

test("the plan puts a buyer who never answered a deal first, with that house as the way in", async () => {
  _resetJobs();
  const store = fakeStore({ events: [
    { contactId: "quietly", type: "blast_sent", at: ago(12), address: "3511 NE 153rd St, Lake Forest Park, WA 98155", offerId: "o1" },
    { contactId: "talked", type: "blast_sent", at: ago(12), address: "3511 NE 153rd St, Lake Forest Park, WA 98155", offerId: "o1" },
    { contactId: "talked", type: "text_summary", at: ago(11) },
    { contactId: "shy", type: "pulse_sent", at: ago(70), dedupeKey: "pulse_sent:shy:a" },
    { contactId: "shy", type: "pulse_texted", at: ago(70) },
    { contactId: "shy", type: "pulse_sent", at: ago(35), dedupeKey: "pulse_sent:shy:b" },
    { contactId: "shy", type: "pulse_texted", at: ago(35) },
    // Claimed twice, never sent: not ignored, just never texted.
    { contactId: "unsent", type: "pulse_sent", at: ago(70), dedupeKey: "pulse_sent:unsent:a" },
    { contactId: "unsent", type: "pulse_sent", at: ago(35), dedupeKey: "pulse_sent:unsent:b" },
  ] });
  const s = starter([
    buyer("top", { score: 90 }), buyer("quietly", { score: 5, lastBlastAt: ago(12), lastMessageAt: ago(12) }),
    buyer("talked", { score: 4, lastRepliedAt: ago(11), lastMessageAt: ago(11) }), buyer("shy", { score: 80 }),
  ]);
  const plan = await planBuyerPulse({ locationId: "LOC", saved: saved({ dailyCap: 3, everyDays: 30, conversedShare: 0 }), store, deps: s, now: NOW });
  assert.deepEqual(plan.picks.map((p) => [p.contactId, p.group]), [["quietly", "after_deal"], ["top", "quiet"], ["talked", "conversed"]]);
  assert.equal(plan.picks[0].subject.lastHouse.city, "Lake Forest Park");
  assert.equal(plan.picks[0].subject.lastHouse.how, "no answer");
  assert.equal(plan.counts.afterDeal, 1);
  assert.ok(!plan.picks.some((p) => p.contactId === "shy"), "two unanswered pulses: next one in a quarter");
  const h = (await import("./buyer-pulse.js")).buyerHistory;
  const hist = await h({ store, locationId: "LOC", pulses: store.events.filter((e) => e.type === "pulse_texted"), now: NOW });
  assert.equal(hist.get("shy").unansweredPulses, 2);
  assert.equal(hist.get("unsent")?.unansweredPulses || 0, 0, "claims that never went don't count");
});

test("sample pulse checks are written from the plan and never claimed or sent", async () => {
  const store = fakeStore();
  const s = starter([buyer("a", { score: 50 }), buyer("b", { score: 40 })]);
  const seen = [];
  const out = await previewBuyerPulse({ locationId: "LOC", saved: saved({ dailyCap: 5 }), store, limit: 2, now: NOW,
    deps: { ...s, previewProactive: async (args) => { seen.push(args); return { reply: `It's Matt — ${args.contactId}`, contactName: args.contactId }; } } });
  assert.deepEqual(out.previews.map((p) => p.contactId), ["a", "b"]);
  assert.ok(seen.every((x) => x.kind === "buyer_pulse"));
  assert.match(out.previews[0].reply, /^It's Matt/);
  assert.equal(store.events.length, 0, "nothing claimed");
  assert.equal(s.calls.length, 0, "nothing started");
});
