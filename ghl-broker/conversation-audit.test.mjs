// conversation-audit.test.mjs — the nightly sweep's runner. The analysis is
// tested in shared/conversation-audit.test.mjs; this is the cursor, the
// claims, and that a remedy goes through the same door as the daytime.

import test from "node:test";
import assert from "node:assert/strict";
import { runConversationAudit, startConversationAudit, maybeRunConversationAudit, getAuditJob, _resetJobs, isReaction, CURSOR_NAME, STALE_RUN_MS, RETRY_GAP_MS, MAX_DAILY_TRIES } from "./conversation-audit.js";

const settle = () => new Promise((r) => setTimeout(r, 30));
// 7:20pm Pacific on 2026-09-16.
const NOW = Date.parse("2026-09-17T02:20:00Z");
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const SAVED = { aiApiKey: "k", conversationAi: { version: 2, enabled: true } };

const fakeStore = ({ drafts = [], events = [], offers = [] } = {}) => {
  const rows = [...events]; const cursors = new Map();
  return {
    events: rows, cursors,
    async listReplyDrafts(_l, { status = null, since = null } = {}) {
      return drafts.filter((d) => (!status || (Array.isArray(status) ? status.includes(d.status) : d.status === status)) && (!since || d.createdAt >= since));
    },
    async listContactEventsSince(_l, since, { types = null } = {}) { return rows.filter((e) => e.at >= since && (!types || types.includes(e.type))); },
    async appendContactEvents(_l, contactId, add) {
      let inserted = 0;
      for (const r of add) { if (r.dedupeKey && rows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue; rows.push({ ...r, contactId }); inserted++; }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
    async listOffers() { return offers; },
    async getJobCursor(l, k) { return cursors.get(`${l}|${k}`) || null; },
    async setJobCursor(l, k, v) { cursors.set(`${l}|${k}`, v); return v; },
    async getOfferSettings() { return SAVED; },
  };
};
const deps = (over = {}) => {
  const calls = [];
  return {
    calls,
    ghlLastMessages: async () => new Map([["c9", { at: ago(5), dir: "in" }]]),
    latestInbound: async (contactId) => ({ body: "Is the number still good?", type: "SMS", at: ago(5), contactId }),
    startReply: async (args) => { calls.push(["reply", args.contactId, args.message]); return { job: { id: "j1" } }; },
    startFollowUpSweep: () => { calls.push(["sweep"]); return { id: "fu1" }; },
    queueOfferSend: async (a) => { calls.push(["queue", a.offerId]); },
    requoteFromAgentNumbers: async (a) => { calls.push(["requote", a.contactId]); return { ok: true }; },
    startProactive: async (a) => { calls.push(["proactive", a.contactId, a.kind]); return { job: { id: "p1" } }; },
    ...over,
  };
};

test("a thread GHL saw with no draft row is re-answered through startReply, claimed first", async () => {
  const store = fakeStore();
  const d = deps();
  const { result, acted } = await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  assert.equal(result.findings[0].kind, "unanswered_inbound");
  assert.deepEqual(d.calls, [["reply", "c9", "Is the number still good?"]]);
  assert.equal(acted[0].status, "started");
  assert.ok(store.events.some((e) => e.type === "audit_action" && e.contactId === "c9"), "the claim is on the record");
});

test("a second audit the same night starts nothing twice", async () => {
  const store = fakeStore();
  const d = deps();
  await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  const again = await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW + 600000, pace: 0 });
  assert.equal(d.calls.length, 1);
  // Still unanswered after a try: it goes to Matt's queue, not back to "started".
  assert.equal(again.acted[0].status, "yours");
  assert.equal(again.result.findings[0].action, null);
});

test("a redraft the bot would only stand down from, or that would answer the wrong words, is handed over before the claim", async () => {
  const run = (store, d) => runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  // Under contract with them (Christian Simonson, 2026-09-16).
  let store = fakeStore({ offers: [{ id: "o1", contactId: "c9", address: "1415 2nd St", deal: { stage: "under_contract" } }] });
  let d = deps();
  let r = await run(store, d);
  assert.equal(r.acted[0].status, "yours");
  assert.match(r.acted[0].reason, /under contract/);
  // Their newest message has no words; the newest with words is old (Tim Tilbury).
  store = fakeStore(); d = deps({ latestInbound: async () => ({ body: "I'd have to see it", type: "SMS", at: ago(9) }) });
  r = await run(store, d);
  assert.match(r.acted[0].reason, /no text/);
  // Our own sent reply echoed back as their inbound (Julie Leonard).
  const ours = "Sorry that one didn't land. Any chance the seller would counter?";
  store = fakeStore({ drafts: [{ id: "d1", contactId: "c9", status: "sent", inbound: "thanks", reply: ours, createdAt: ago(30), sentAt: ago(30) }] });
  d = deps({ latestInbound: async () => ({ body: ours, type: "Email", at: ago(5) }) });
  r = await run(store, d);
  assert.match(r.acted[0].reason, /echoed/);
  for (const x of [r]) {
    assert.equal(d.calls.length, 0);
    assert.equal(x.result.findings[0].action, null, "on Matt's queue");
    assert.ok(!store.events.some((e) => e.type === "audit_action"), "no claim spent");
  }
});

test("a dry run writes no events and starts nothing; the bot switched off reports and touches nothing", async () => {
  const store = fakeStore();
  const d = deps();
  const dry = await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW, dryRun: true, pace: 0 });
  assert.equal(dry.result.findings.length, 1);
  assert.equal(dry.acted.length, 0);
  assert.equal(store.events.length, 0);
  const off = await runConversationAudit({ client: {}, locationId: "L", saved: { ...SAVED, conversationAi: { version: 2, enabled: false } }, store, sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  assert.equal(off.result.findings.length, 1, "findings are findings");
  assert.match(off.reason, /switched off/);
  assert.equal(d.calls.length, 0);
});

test("a held draft's clock is written with the reply agent's own key, so the two never both set one", async () => {
  const held = { id: "h", contactId: "c1", contactName: "Thomas", party: "agent", status: "draft", inbound: "That are willing to go to 670", reply: "…", intent: "counter", createdAt: ago(4), autoSend: { decided: false, reason: "a counter is a person's call" }, flags: [] };
  const store = fakeStore({ drafts: [held] });
  const d = deps({ ghlLastMessages: async () => new Map() });
  const { acted } = await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  assert.equal(acted[0].status, "clocked");
  const clock = store.events.find((e) => e.type === "checkin_requested");
  assert.match(clock.dedupeKey, /^checkin_requested:unanswered:c1:\d{4}-\d{2}-\d{2}$/);
  assert.equal(clock.data.by, "audit");
  // The reply agent already set it for that day: the audit's is a no-op.
  const store2 = fakeStore({ drafts: [held], events: [{ contactId: "c1", type: "checkin_requested", at: ago(3.9), dedupeKey: clock.dedupeKey, data: { kind: "unanswered", dueAt: clock.data.dueAt } }] });
  const r2 = await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store: store2, sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  assert.equal(r2.acted.length, 0, "the finding already has its clock");
});

test("GHL down: the audit still runs, the no-row case is skipped, and the result says so", async () => {
  const store = fakeStore();
  const d = deps({ ghlLastMessages: async () => { throw new Error("403"); } });
  const { result } = await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  assert.equal(result.ghlRead, false);
  assert.equal(result.findings.length, 0);
});

test("the audit runs once in its hour, a failed one comes back that evening, and a stale one is not a running one", async () => {
  _resetJobs();
  const store = fakeStore();
  const d = deps({ ghlLastMessages: async () => new Map() });
  const base = { client: {}, locationId: "L", saved: SAVED, store, sendsEnabled: false, deps: d };
  assert.equal(await maybeRunConversationAudit({ ...base, now: Date.parse("2026-09-16T22:10:00Z") }), false, "3pm is not the hour");
  assert.equal(await maybeRunConversationAudit({ ...base, now: NOW }), true, "7:20pm is");
  await settle();
  assert.equal(getAuditJob("L").status, "done");
  const doc = store.cursors.get(`L|${CURSOR_NAME}`).doc;
  assert.equal(doc.run, null);
  assert.equal(doc.last.status, "done");
  assert.equal(await maybeRunConversationAudit({ ...base, now: NOW + 600000 }), false, "already ran tonight");

  // Failed at 7:20: back after the gap, up to the cap, within the window.
  _resetJobs();
  store.cursors.set(`L|${CURSOR_NAME}`, { at: new Date(NOW).toISOString(), doc: { tries: 1, lastDaily: new Date(NOW).toISOString(), failed: true, error: "boom" } });
  assert.equal(await maybeRunConversationAudit({ ...base, now: NOW + RETRY_GAP_MS - 1000 }), false);
  assert.equal(await maybeRunConversationAudit({ ...base, now: NOW + RETRY_GAP_MS + 1000 }), true);
  await settle();
  _resetJobs();
  store.cursors.set(`L|${CURSOR_NAME}`, { at: new Date(NOW).toISOString(), doc: { tries: MAX_DAILY_TRIES, lastDaily: new Date(NOW).toISOString(), failed: true } });
  assert.equal(await maybeRunConversationAudit({ ...base, now: NOW + RETRY_GAP_MS + 1000 }), false, "tries are spent");

  // Vanished mid-run (a deploy): stale after half an hour, retried.
  _resetJobs();
  store.cursors.set(`L|${CURSOR_NAME}`, { at: new Date(NOW).toISOString(), doc: { tries: 1, lastDaily: new Date(NOW).toISOString(), run: { id: "x", startedAt: new Date(NOW).toISOString() } } });
  assert.equal(await maybeRunConversationAudit({ ...base, now: NOW + 10 * 60000 }), false);
  assert.equal(await maybeRunConversationAudit({ ...base, now: NOW + STALE_RUN_MS + RETRY_GAP_MS }), true);
  await settle();
  assert.equal(store.cursors.get(`L|${CURSOR_NAME}`).doc.last.status, "done");
});

test("the run is on the cursor while it goes and summarised there when it's over", async () => {
  _resetJobs();
  const store = fakeStore();
  const job = startConversationAudit({ client: {}, locationId: "L2", saved: SAVED, store, sendsEnabled: true, deps: deps(), trigger: "manual", dryRun: true, now: NOW, pace: 0 });
  assert.equal(job.status, "running");
  await settle();
  const doc = store.cursors.get(`L2|${CURSOR_NAME}`).doc;
  assert.equal(doc.run, null);
  assert.equal(doc.last.dryRun, true);
  assert.equal(doc.last.counts.touched, 1);
  assert.equal(doc.last.findings.length, 1);
});


test("a tapback is not re-answered", async () => {
  assert.equal(isReaction("\u200B\u{1F44D}\u200B to \u201C Sounds good, thanks. \u201D"), true, "Alicia Reid, 2026-09-15");
  assert.equal(isReaction("Liked \u201CHope it signs for them.\u201D"), true);
  assert.equal(isReaction("Sounds good!"), false);
  assert.equal(isReaction("Not a fixer. Thanks for checking"), false);
  const store = fakeStore();
  const d = deps({ latestInbound: async () => ({ body: "\u{1F44D} to \u201CHope it signs.\u201D", type: "SMS", at: ago(5) }) });
  const { acted } = await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  assert.equal(acted[0].status, "skipped");
  assert.match(acted[0].reason, /reaction/);
  assert.equal(d.calls.length, 0);
});

test("loose: a held holding-reply is scheduled at the next open minute, and a stalled counter starts a counter_nudge", async () => {
  const held = { id: "h", contactId: "c1", contactName: "Gary", party: "agent", status: "draft", inbound: "Seller wants 850", reply: "Let me run that by my partner and come back to you.", intent: "counter", createdAt: ago(3), autoSendable: true, needsHuman: false, autoSend: { decided: false, reason: "a counter is a person's call" }, flags: [] };
  const stalled = { id: "o1", contactId: "c2", contactName: "Gabe", address: "3831 Bagley Ave N, Seattle, WA", cashAmount: 732000, status: "countered", statusAt: ago(200), createdAt: ago(400), sends: [{ ts: ago(400), results: { sms: { ok: true } } }], followUps: [], counter: { amount: 850000, at: ago(144) } };
  const store = fakeStore({ drafts: [held], offers: [stalled] });
  store.getReplyDraft = async (id) => (id === "h" ? held : null);
  store.updateReplyDraft = async (id, doc) => { Object.assign(held, doc); return true; };
  store.getOffer = async (id) => (id === "o1" ? stalled : null);
  const d = deps({ ghlLastMessages: async () => new Map() });
  const { acted } = await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store, sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  const rel = acted.find((a) => a.action === "release");
  assert.equal(rel.status, "queued");
  assert.equal(held.status, "scheduled");
  assert.ok(Date.parse(held.sendAt) > NOW, "at the next open minute, never now");
  assert.match(held.autoSend.reason, /released by the nightly audit/);
  const nudge = acted.find((a) => a.action === "nudge_counter");
  assert.ok(nudge, JSON.stringify(acted));
  assert.deepEqual(d.calls.find((c) => c[0] === "proactive"), ["proactive", "c2", "counter_nudge"]);
});

test("a run by hand at noon does not count as the night's run", async () => {
  _resetJobs();
  const store = fakeStore();
  const d = deps({ ghlLastMessages: async () => new Map() });
  const noon = Date.parse("2026-09-16T19:40:00Z");
  startConversationAudit({ client: {}, locationId: "L3", saved: SAVED, store, sendsEnabled: false, deps: d, trigger: "manual", dryRun: true, now: noon, pace: 0 });
  await settle();
  assert.ok(store.cursors.get(`L3|${CURSOR_NAME}`).at, "the cursor was stamped by hand");
  _resetJobs();
  assert.equal(await maybeRunConversationAudit({ client: {}, locationId: "L3", saved: SAVED, store, sendsEnabled: false, deps: d, now: NOW }), true, "7pm still runs");
  await settle();
  assert.equal(await maybeRunConversationAudit({ client: {}, locationId: "L3", saved: SAVED, store, sendsEnabled: false, deps: d, now: NOW + 600000 }), false, "and only once");
});

/* ---------- the daytime pass (2026-09-17) ---------- */

const { maybeRunDaytimeDriver, DAY_CURSOR_NAME } = await import("./conversation-audit.js");
const ELEVEN = Date.parse("2026-09-17T18:05:00Z");            // 11:05am Pacific, a Thursday
const agoFrom = (t, h) => new Date(t - h * 3600000).toISOString();
const DAY_SAVED = { aiApiKey: "k", conversationAi: { version: 2, enabled: true, driver: { daytime: { enabled: true } } } };
const heldCounter = (t, minutesOld) => ({ id: "h", contactId: "c1", contactName: "Gary", party: "agent", status: "draft", inbound: "Seller wants 850", reply: "Let me run that by my partner and come back to you.", intent: "counter", createdAt: new Date(t - minutesOld * 60000).toISOString(), autoSendable: true, needsHuman: false, autoSend: { decided: false, reason: "a counter is a person's call" }, flags: [] });
const heldQuestion = (t, minutesOld) => ({ ...heldCounter(t, minutesOld), id: "q", intent: "question", inbound: "when can you close?", reply: "We can close in two weeks.", autoSend: { decided: false, reason: "question is not on the agent auto-send list" } });
const draftStore = (row) => {
  const store = fakeStore({ drafts: [row] });
  store.getReplyDraft = async (id) => (id === row.id ? row : null);
  store.updateReplyDraft = async (id, doc) => { Object.assign(row, doc); return true; };
  return store;
};
const runDay = (store, d, now = ELEVEN) => runConversationAudit({ client: {}, locationId: "L", saved: DAY_SAVED, store, sendsEnabled: true, deps: d, now, pace: 0, mode: "day" });

test("a reply held ten minutes ago is not released at 11am: you may be about to decide it", async () => {
  const row = heldQuestion(ELEVEN, 10);
  const { acted } = await runDay(draftStore(row), deps({ ghlLastMessages: async () => new Map() }));
  assert.equal(acted.some((a) => a.action === "release"), false);
  assert.equal(row.status, "draft");
});

test("by day a held reply two hours old that is not a person's call is released, and says who released it", async () => {
  const row = heldQuestion(ELEVEN, 150);
  const { acted } = await runDay(draftStore(row), deps({ ghlLastMessages: async () => new Map() }));
  assert.equal(acted.find((a) => a.action === "release")?.status, "queued");
  assert.equal(row.status, "scheduled");
  assert.match(row.autoSend.reason, /released by the daytime pass/);
});

test("by day a counter is never released however old; the same counter is still released at night", async () => {
  const day = heldCounter(ELEVEN, 300);
  await runDay(draftStore(day), deps({ ghlLastMessages: async () => new Map() }));
  assert.equal(day.status, "draft", "a person's call stays a person's by day");
  const night = heldCounter(NOW, 300);
  await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store: draftStore(night), sendsEnabled: true, deps: deps({ ghlLastMessages: async () => new Map() }), now: NOW, pace: 0 });
  assert.equal(night.status, "scheduled", "the night's rule is unchanged");
});

test("by day the follow-up sweep is not started and the held underwrites are left for the night", async () => {
  const sent = { id: "o1", contactId: "c2", contactName: "Gabe", address: "3831 Bagley Ave N, Seattle, WA", cashAmount: 732000, status: "sent", statusAt: agoFrom(ELEVEN, 200), createdAt: agoFrom(ELEVEN, 400), sends: [{ ts: agoFrom(ELEVEN, 200), results: { sms: { ok: true } } }], followUps: [] };
  const heldUw = { id: "h1", contactId: "c3", address: "1 Oak St, Kent, WA", status: "draft", createdAt: agoFrom(ELEVEN, 30), autoUnderwrite: { jobId: "j", held: ["only 1 priced comps — the price proxy needs 6"], finishedAt: agoFrom(ELEVEN, 30) } };
  const saved = { aiApiKey: "k", conversationAi: { version: 2, enabled: true, driver: { daytime: { enabled: true } }, parties: { agent: { followUp: { enabled: true, ladders: { offer_nudge: { enabled: true } } } } } } };
  const d = deps({ ghlLastMessages: async () => new Map() });
  const { acted, result } = await runConversationAudit({ client: {}, locationId: "L", saved, store: fakeStore({ offers: [sent, heldUw] }), sendsEnabled: true, deps: d, now: ELEVEN, pace: 0, mode: "day" });
  assert.equal(d.calls.some((c) => c[0] === "sweep"), false);
  assert.equal(acted.some((a) => a.action === "run_follow_up_sweep" && a.status === "started"), false);
  assert.equal(result.counts.held, undefined, "no held sweep, so no GHL reads per held house every two hours");
});

test("by day a stalled counter is not nudged when the thread's brake is on", async () => {
  const stalled = { id: "o1", contactId: "c2", contactName: "Gabe", address: "3831 Bagley Ave N, Seattle, WA", cashAmount: 732000, status: "countered", statusAt: agoFrom(ELEVEN, 200), createdAt: agoFrom(ELEVEN, 400), sends: [{ ts: agoFrom(ELEVEN, 400), results: { sms: { ok: true } } }], followUps: [], counter: { amount: 850000, at: agoFrom(ELEVEN, 144) } };
  const cross = { id: "x", contactId: "c2", party: "agent", status: "superseded", intent: "counter", inbound: "I already told you, 850 is the number", reply: "", createdAt: agoFrom(ELEVEN, 40) };
  const store = fakeStore({ offers: [stalled], drafts: [cross] });
  store.getOffer = async () => stalled;
  const d = deps({ ghlLastMessages: async () => new Map() });
  const { acted } = await runConversationAudit({ client: {}, locationId: "L", saved: DAY_SAVED, store, sendsEnabled: true, deps: d, now: ELEVEN, pace: 0, mode: "day" });
  assert.equal(d.calls.some((c) => c[0] === "proactive"), false);
  assert.match(acted.find((a) => a.kind === "counter_stalled")?.reason || "", /irritated|annoyed/);
});

test("the daytime pass: off by default, every two hours inside its window, never at night, and it never overwrites last night's result", async () => {
  _resetJobs();
  const store = fakeStore();
  const d = deps({ ghlLastMessages: async () => new Map() });
  assert.equal(await maybeRunDaytimeDriver({ client: {}, locationId: "LD", saved: SAVED, store, deps: d, now: ELEVEN }), false, "with the switch off nothing runs by day");
  store.cursors.set(`LD|${CURSOR_NAME}`, { at: ago(16), doc: { last: { id: "last-night" }, lastDaily: ago(16) } });
  assert.equal(await maybeRunDaytimeDriver({ client: {}, locationId: "LD", saved: DAY_SAVED, store, deps: d, now: ELEVEN }), true);
  await settle();
  assert.equal(store.cursors.get(`LD|${CURSOR_NAME}`).doc.last.id, "last-night", "Today's 'From last night' still reads the night");
  const day = store.cursors.get(`LD|${DAY_CURSOR_NAME}`);
  assert.ok(day.doc.last, "the day's result is on its own cursor");
  assert.equal(day.doc.last.trigger, "daytime");
  _resetJobs();
  assert.equal(await maybeRunDaytimeDriver({ client: {}, locationId: "LD", saved: DAY_SAVED, store, deps: d, now: ELEVEN + 60 * 60000 }), false, "a second pass inside two hours is refused");
  assert.equal(await maybeRunDaytimeDriver({ client: {}, locationId: "LD", saved: DAY_SAVED, store, deps: d, now: ELEVEN + 125 * 60000 }), true, "two hours on, it runs again");
  await settle(); _resetJobs();
  assert.equal(await maybeRunDaytimeDriver({ client: {}, locationId: "LD", saved: DAY_SAVED, store, deps: d, now: Date.parse("2026-09-18T02:30:00Z") }), false, "7:30pm Pacific is the night audit's");
  assert.equal(await maybeRunDaytimeDriver({ client: {}, locationId: "LD", saved: DAY_SAVED, store, deps: d, now: Date.parse("2026-09-19T18:05:00Z") }), false, "Saturday: what it starts is machine-started, and weekends are replies only");
});

test("a daytime run that died is retried once it is stale, not before", async () => {
  _resetJobs();
  const store = fakeStore();
  const d = deps({ ghlLastMessages: async () => new Map() });
  store.cursors.set(`LS|${DAY_CURSOR_NAME}`, { at: agoFrom(ELEVEN, 0.2), doc: { lastRun: agoFrom(ELEVEN, 0.2), tries: 1, day: "2026-09-17", run: { id: "dead", startedAt: agoFrom(ELEVEN, 0.2) } } });
  assert.equal(await maybeRunDaytimeDriver({ client: {}, locationId: "LS", saved: DAY_SAVED, store, deps: d, now: ELEVEN }), false, "twelve minutes in, it may still be going");
  assert.equal(await maybeRunDaytimeDriver({ client: {}, locationId: "LS", saved: DAY_SAVED, store, deps: d, now: ELEVEN + STALE_RUN_MS }), true);
  await settle();
});

test("the timers ride the daytime pass, and never the night's", async () => {
  const ran = [];
  const d = deps({ ghlLastMessages: async () => new Map(), runTodayTimers: async () => { ran.push("timers"); return { results: [{ kind: "offer_ready", move: "float", status: "started", contactId: "c1" }] }; } });
  const { acted } = await runConversationAudit({ client: {}, locationId: "L", saved: DAY_SAVED, store: fakeStore(), sendsEnabled: true, deps: d, now: ELEVEN, pace: 0, mode: "day" });
  assert.deepEqual(ran, ["timers"]);
  assert.ok(acted.some((a) => a.kind === "timer_offer_ready" && a.status === "started"));
  await runConversationAudit({ client: {}, locationId: "L", saved: SAVED, store: fakeStore(), sendsEnabled: true, deps: d, now: NOW, pace: 0 });
  assert.deepEqual(ran, ["timers"], "7pm changes nothing");
});
