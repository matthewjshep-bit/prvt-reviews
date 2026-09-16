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
  assert.equal(again.acted[0].status, "claimed");
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
  store.cursors.set(`L|${CURSOR_NAME}`, { at: new Date(NOW).toISOString(), doc: { tries: 1, failed: true, error: "boom" } });
  assert.equal(await maybeRunConversationAudit({ ...base, now: NOW + RETRY_GAP_MS - 1000 }), false);
  assert.equal(await maybeRunConversationAudit({ ...base, now: NOW + RETRY_GAP_MS + 1000 }), true);
  await settle();
  _resetJobs();
  store.cursors.set(`L|${CURSOR_NAME}`, { at: new Date(NOW).toISOString(), doc: { tries: MAX_DAILY_TRIES, failed: true } });
  assert.equal(await maybeRunConversationAudit({ ...base, now: NOW + RETRY_GAP_MS + 1000 }), false, "tries are spent");

  // Vanished mid-run (a deploy): stale after half an hour, retried.
  _resetJobs();
  store.cursors.set(`L|${CURSOR_NAME}`, { at: new Date(NOW).toISOString(), doc: { tries: 1, run: { id: "x", startedAt: new Date(NOW).toISOString() } } });
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
