import test from "node:test";
import assert from "node:assert/strict";
import { auditConversations, auditActions, auditDedupeKey, summarize, AUDIT_KINDS, MAX_REDRAFTS } from "./conversation-audit.js";
import { normalizeConversationAi } from "./conversation-ai.js";

// 7:30pm Pacific on the day of the three quiet threads.
const NOW = Date.parse("2026-09-17T02:30:00Z");
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const CFG = normalizeConversationAi({ version: 2 });
const ladderOn = normalizeConversationAi({ version: 2, parties: { agent: { followUp: { enabled: true, ladders: { offer_nudge: { enabled: true } } } } } });

const draft = (over = {}) => ({ id: `d${Math.random().toString(36).slice(2, 7)}`, contactId: "c1", contactName: "Colin Foote", party: "agent", status: "sent",
  inbound: "Any update?", reply: "Yes, running it today.", intent: "question", createdAt: ago(3), sentAt: ago(2.9), autoSend: { decided: true, reason: "" }, flags: [], ...over });
const offer = (over = {}) => ({ id: "o1", contactId: "c1", contactName: "Colin Foote", address: "15605 NE 1st St, Bellevue, WA 98008", cashAmount: 782500,
  status: "sent", statusAt: ago(100), createdAt: ago(120), sends: [{ ts: ago(100), results: { sms: { ok: true } } }], followUps: [], ...over });
const audit = (args) => auditConversations({ config: CFG, now: NOW, ...args });

test("every kind is present in order, and a day with nothing owed is counted, not listed", () => {
  const r = audit({ drafts: [draft()], events: [], offers: [] });
  assert.deepEqual(AUDIT_KINDS.map((k) => k.key).slice(0, 3), ["unanswered_inbound", "realm_yes_no_offer", "promise_open_overdue"]);
  assert.equal(r.findings.length, 0);
  assert.equal(r.counts.touched, 1);
  assert.equal(r.counts.answered, 1);
  assert.deepEqual(r.quietWins.map((q) => q.contactId), ["c1"]);
  assert.match(summarize(r), /checked 1 thread · 1 answered · 0 queued/);
});

test("an inbound GHL saw with no draft row is unanswered, with a redraft", () => {
  // Angela Jaeger's shape: the reply job hung, nothing was written.
  const ghlLast = new Map([["c9", { at: ago(5), dir: "in" }]]);
  const r = audit({ drafts: [], events: [], offers: [], ghlLast });
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.kind, "unanswered_inbound");
  assert.equal(f.contactId, "c9");
  assert.deepEqual(f.action, { type: "redraft" });
  assert.match(f.why, /nothing was drafted/);
  assert.equal(r.counts.queued, 1);
});

test("a burst that superseded the only reply is unanswered, not in good order", () => {
  // Colin Foote, 2026-09-15: the scheduled reply was superseded by a held one
  // that was later dismissed by hand — nothing ever went.
  const drafts = [
    draft({ id: "a", status: "superseded", createdAt: ago(6), sentAt: null, inbound: "$950k or a little less" }),
    draft({ id: "b", status: "superseded", createdAt: ago(5), sentAt: null, inbound: "Buyer to pay my 3%" }),
  ];
  const r = audit({ drafts, events: [], offers: [] });
  assert.equal(r.findings[0]?.kind, "unanswered_inbound");
  assert.equal(r.findings[0].action?.type, "redraft");
  assert.match(r.findings[0].why, /replaced the only reply/);
});

test("a held draft with no clock books one with reply-agent's exact key; one with a clock gets no second", () => {
  const held = draft({ id: "h", status: "draft", createdAt: ago(4), sentAt: null, autoSend: { decided: false, reason: "a counter is a person's call" } });
  const r1 = audit({ drafts: [held], events: [], offers: [] });
  assert.equal(r1.findings[0].kind, "unanswered_inbound");
  assert.equal(r1.findings[0].action?.type, "book_checkin");
  assert.equal(r1.findings[0].action.kind, "unanswered");
  assert.ok(Date.parse(r1.findings[0].action.dueAt) > NOW);

  const clocked = [{ contactId: "c1", type: "checkin_requested", at: ago(3.9), data: { kind: "unanswered", dueAt: ago(-40) } }];
  const r2 = audit({ drafts: [held], events: clocked, offers: [] });
  assert.equal(r2.findings[0].action, null, "the clock is already set");
  assert.match(r2.findings[0].why, /check-in set for/);

  // A pending check-in the agent asked for is never overwritten either.
  const theirs = [{ contactId: "c1", type: "checkin_requested", at: ago(30), data: { kind: "date", phrase: "Wednesday", dueAt: ago(-20) } }];
  const r3 = audit({ drafts: [held], events: theirs, offers: [] });
  assert.equal(r3.findings[0].action, null);
});

test("a held draft over a day old is aging; a handled wants_call is yours, never redrafted", () => {
  const old = draft({ id: "o", status: "draft", createdAt: ago(30), sentAt: null, autoSend: { decided: false, reason: "a other is a person's call" } });
  const r = audit({ drafts: [old], events: [], offers: [] });
  assert.equal(r.findings[0].kind, "held_aging");
  const handled = draft({ id: "w", contactId: "c2", contactName: "Tom", status: "handled", intent: "wants_call", reply: "", createdAt: ago(4), sentAt: null });
  const r2 = audit({ drafts: [handled], events: [], offers: [] });
  assert.equal(r2.findings[0].kind, "unanswered_inbound");
  assert.equal(r2.findings[0].action, null);
  assert.match(r2.findings[0].why, /wants call — yours/);
});

test("a person who spoke last owns the thread; unsubscribed and opted-out contacts are never in the list", () => {
  const ghlLast = new Map([["c1", { at: ago(1), dir: "out" }]]);
  const unanswered = draft({ id: "u", status: "draft", createdAt: ago(4), sentAt: null, autoSend: { decided: false, reason: "held" } });
  assert.equal(audit({ drafts: [unanswered], events: [], offers: [], ghlLast }).findings.length, 0, "Matt answered after our last text");
  const byHand = draft({ id: "x", status: "dismissed", createdAt: ago(4), sentAt: null, flags: ["you answered it yourself — the bot stood aside"] });
  assert.equal(audit({ drafts: [byHand], events: [], offers: [] }).findings.length, 0);
  const dnd = [{ contactId: "c1", type: "unsubscribed", at: ago(10), data: {} }];
  assert.equal(audit({ drafts: [unanswered], events: dnd, offers: [] }).findings.length, 0);
  const opt = draft({ id: "p", status: "handled", intent: "opt_out", reply: "", createdAt: ago(2), sentAt: null });
  assert.equal(audit({ drafts: [opt], events: [], offers: [] }).findings.length, 0);
});

test("an owed promise is not re-texted: under two days a row, past two days a morning check-in, never over a pending one", () => {
  const owed = (h) => [{ contactId: "c1", type: "promise_owed", at: ago(h), address: "12 Elm St", data: { what: "number", heldReason: "underwrite held" } }];
  const fresh = audit({ drafts: [], events: owed(10), offers: [] });
  assert.equal(fresh.findings[0].kind, "promise_open_overdue");
  assert.equal(fresh.findings[0].action, null);
  assert.equal(fresh.counts.owed, 1);
  const stale = audit({ drafts: [], events: owed(60), offers: [] });
  assert.equal(stale.findings[0].action?.type, "book_checkin");
  assert.equal(stale.findings[0].action.kind, "promise");
  const pending = [...owed(60), { contactId: "c1", type: "checkin_requested", at: ago(20), data: { kind: "date", dueAt: ago(-30) } }];
  assert.equal(audit({ drafts: [], events: pending, offers: [] }).findings[0].action, null);
  const kept = [...owed(60), { contactId: "c1", type: "promise_kept", at: ago(50), data: { by: "offer" } }];
  assert.equal(audit({ drafts: [], events: kept, offers: [] }).findings.length, 0);
});

test("a counter two days old with no re-quote, no band, no decline is stalled — their number, ours and the gap ride along", () => {
  const o = offer({ status: "countered", counter: { amount: 850000, at: ago(60), source: "conversation" } });
  const r = audit({ drafts: [], events: [], offers: [o] });
  const f = r.findings[0];
  assert.equal(f.kind, "counter_stalled");
  assert.deepEqual(f.evidence, { theirs: 850000, ours: 782500, gap: 67500, take: false });
  assert.deepEqual(f.action, { type: "nudge_counter" }, "no numbers of theirs to re-run on: keep it alive instead");
  assert.match(f.why, /countered at 850k against our 783k/);
  // With their read on file, the re-quote runs on its own.
  const take = [{ contactId: "c1", type: "agent_estimate", at: ago(55), address: o.address, data: { arv: 1200000, rehab: 60000 } }];
  assert.equal(audit({ drafts: [], events: take, offers: [o] }).findings[0].action?.type, "nudge_counter", "re-quoting is off in this playbook, so it's nudged");
  const requoting = normalizeConversationAi({ version: 2, parties: { agent: { requote: { enabled: true } } } });
  assert.equal(auditConversations({ config: requoting, now: NOW, drafts: [], events: take, offers: [o] }).findings[0].action?.type, "requote");
  // Any movement on price since means it's a negotiation, not a stall.
  assert.equal(audit({ drafts: [], events: [], offers: [{ ...o, requotes: [{ at: ago(30) }] }] }).findings.length, 0);
  assert.equal(audit({ drafts: [], events: [], offers: [{ ...o, declinedOnce: { at: ago(30) } }] }).findings.length, 0);
});

test("a realm yes with nothing sent is first on the list, and queues the send only when the rule is auto and the offer is new", () => {
  const o = offer({ status: "new", sends: [], realm: { answer: "yes", ts: ago(20) } });
  const r = audit({ drafts: [], events: [], offers: [o] });
  assert.equal(r.findings[0].kind, "realm_yes_no_offer");
  assert.equal(r.findings[0].action?.type, "queue_offer_send", "loose: a yes is a yes");
  const careful = normalizeConversationAi({ version: 2, nightlyAudit: { loose: false } });
  assert.equal(auditConversations({ config: careful, now: NOW, drafts: [], events: [], offers: [o] }).findings[0].action, null, "careful mode leaves it to the playbook");
  const auto = normalizeConversationAi({ version: 2, parties: { agent: { sendOffer: { onClearUnderwrite: true } } } });
  assert.equal(auditConversations({ config: auto, now: NOW, drafts: [], events: [], offers: [o] }).findings[0].action?.type, "queue_offer_send");
  const went = { ...o, sends: [{ ts: ago(10), results: { sms: { ok: true } } }] };
  assert.equal(audit({ drafts: [], events: [], offers: [went] }).findings.length, 0);
});

test("a float nobody answered rides the ladder when it's on and stale, and is yours when it's off", () => {
  const o = offer({ status: "new", sends: [], proactive: { realmCheckAt: ago(80) } });
  const off = audit({ drafts: [], events: [], offers: [o] });
  assert.equal(off.findings[0].kind, "float_unanswered");
  assert.equal(off.findings[0].action, null);
  assert.match(off.findings[0].why, /ladder is off/);
  const on = auditConversations({ config: ladderOn, now: NOW, drafts: [], events: [], offers: [o], followUpCursorAt: ago(30) });
  assert.deepEqual(on.findings[0].action, { type: "run_follow_up_sweep" });
  const ranToday = auditConversations({ config: ladderOn, now: NOW, drafts: [], events: [], offers: [o], followUpCursorAt: ago(3) });
  assert.deepEqual(ranToday.findings[0].action, { type: "nudge_offer" }, "the sweep ran today and still left it: nudged directly");
});

test("an offer out with no follow-up clock is a row; the sweep is asked once per night, not per offer", () => {
  const two = [offer({ id: "o1" }), offer({ id: "o2", contactId: "c2", contactName: "Kim", address: "9 Pine St" })];
  const r = auditConversations({ config: ladderOn, now: NOW, drafts: [], events: [], offers: two, followUpCursorAt: null });
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings.filter((f) => f.action?.type === "run_follow_up_sweep").length, 1);
  assert.equal(r.findings[0].severity, "fyi");
  const off = audit({ drafts: [], events: [], offers: two });
  assert.ok(off.findings.every((f) => f.kind === "offer_no_followup" && f.severity === "soon" && !f.action));
});

test("an offer that gave up sending itself is on the list with the reason; the last chase rung closes the chase", () => {
  const o = offer({ status: "new", sends: [], autoSendGaveUp: { reason: "more than one open offer and the message named no address", at: ago(5) } });
  assert.match(audit({ drafts: [], events: [], offers: [o] }).findings[0].why, /never sent itself — more than one open offer/);
  const chase = [
    { contactId: "c3", type: "address_pending", at: ago(40 * 24), data: { hint: "one in Spanaway soon" } },
    { contactId: "c3", type: "address_chase_sent", at: ago(3 * 24), data: { step: 5, of: 6 } },
  ];
  const r = audit({ drafts: [], events: chase, offers: [] });
  assert.equal(r.findings[0].kind, "chase_exhausted");
  assert.equal(r.findings[0].action?.type, "close_chase");
});

test("dedupe keys are stable on the same state and move with the thread; the redraft cap holds", () => {
  const a = audit({ drafts: [], events: [], offers: [], ghlLast: new Map([["c9", { at: ago(5), dir: "in" }]]) }).findings[0];
  const b = audit({ drafts: [], events: [], offers: [], ghlLast: new Map([["c9", { at: ago(5), dir: "in" }]]) }).findings[0];
  assert.equal(auditDedupeKey(a), auditDedupeKey(b));
  const c = audit({ drafts: [], events: [], offers: [], ghlLast: new Map([["c9", { at: ago(1), dir: "in" }]]) }).findings[0];
  assert.notEqual(auditDedupeKey(a), auditDedupeKey(c));
  const many = new Map(Array.from({ length: MAX_REDRAFTS + 5 }, (_, i) => [`x${i}`, { at: ago(2), dir: "in" }]));
  const r = audit({ drafts: [], events: [], offers: [], ghlLast: many });
  assert.equal(r.counts.queued, MAX_REDRAFTS);
  assert.equal(r.findings.filter((f) => !f.action).length, 5, "the rest are yours");
});

test("Today's queue gets only the rows that are Matt's", () => {
  const drafts = [draft({ id: "h", status: "draft", createdAt: ago(30), sentAt: null, autoSend: { decided: false, reason: "held" } })];
  const r = audit({ drafts, events: [], offers: [offer({ status: "countered", counter: { amount: 900000, at: ago(72) } })] });
  const actions = auditActions({ ...r, finishedAt: r.generatedAt });
  assert.equal(actions.length, 1, "the counter is nudged on its own; the held draft (no guard verdict on it) is yours");
  assert.ok(actions.every((a) => a.kind === "audit_owed"));
  assert.match(actions[0].title, /Held over a day/);
  assert.equal(actions[0].ops[0].key, "open_outbox");
});


test("one row per property, and a ladder that never fired is not 'the ladder has it'", () => {
  const seven = Array.from({ length: 7 }, (_, i) => offer({ id: `v${i}`, address: "21904 Vashon Hwy SW, Vashon, WA", createdAt: ago(1200 - i), statusAt: ago(1200 - i), sends: [{ ts: ago(1200 - i), results: { sms: { ok: true } } }] }));
  const r = auditConversations({ config: ladderOn, now: NOW, drafts: [], events: [], offers: seven, followUpCursorAt: ago(3) });
  assert.equal(r.findings.length, 1, "seven rows on one house is one finding");
  assert.equal(r.findings[0].offerId, "v6", "the newest speaks for the house");
  assert.equal(r.findings[0].severity, "soon");
  assert.match(r.findings[0].why, /50d quiet and the ladder never fired/);
  // Three days quiet with the ladder on: still the ladder's, for information.
  const fresh = auditConversations({ config: ladderOn, now: NOW, drafts: [], events: [], offers: [offer({ statusAt: ago(76), sends: [{ ts: ago(76), results: { sms: { ok: true } } }] })], followUpCursorAt: ago(3) });
  assert.equal(fresh.findings[0].severity, "fyi");
});

/* ---------- loose: fire where it can (Matt, 2026-09-16) ---------- */

test("a held holding-reply the guard passed is sent, not clocked; the gates, needsHuman and 'you have the thread' still hold it", () => {
  const held = (over) => draft({ id: "h", status: "draft", createdAt: ago(4), sentAt: null, autoSendable: true, needsHuman: false,
    autoSend: { decided: false, reason: "a counter is a person's call" }, ...over });
  assert.deepEqual(audit({ drafts: [held()], events: [], offers: [] }).findings[0].action, { type: "release", draftId: "h" });
  assert.equal(audit({ drafts: [held({ autoSendable: false, autoSend: { decided: false, reason: "needs a person: the draft names 500k" } })], events: [], offers: [] }).findings[0].action?.type, "book_checkin", "the money guard is never released");
  assert.equal(audit({ drafts: [held({ needsHuman: true })], events: [], offers: [] }).findings[0].action?.type, "book_checkin");
  assert.equal(audit({ drafts: [held({ autoSend: { decided: false, reason: "you replied to them 12 minutes ago — you have the thread" } })], events: [], offers: [] }).findings[0].action?.type, "book_checkin");
  assert.equal(audit({ drafts: [held({ createdAt: ago(80) })], events: [], offers: [] }).findings[0].action?.type, "book_checkin", "three days old is stale");
  const careful = normalizeConversationAi({ version: 2, nightlyAudit: { loose: false } });
  assert.equal(auditConversations({ config: careful, now: NOW, drafts: [held()], events: [], offers: [] }).findings[0].action?.type, "book_checkin", "careful mode clocks it");
});

test("a stalled counter with nothing to re-run on is nudged; a realm-yes answered four minutes before its stamp is not a finding", () => {
  const o = offer({ status: "countered", counter: { amount: 850000, at: ago(140), source: "conversation" } });
  assert.deepEqual(audit({ drafts: [], events: [], offers: [o] }).findings[0].action, { type: "nudge_counter" });
  // James G Smith: the send at 19:13 answered the yes stamped 19:17.
  const james = offer({ status: "sent", realm: { answer: "yes", ts: ago(20) }, sends: [{ ts: ago(20.07), results: { sms: { ok: true }, email: { ok: true } } }] });
  assert.equal(audit({ drafts: [], events: [], offers: [james] }).findings.length, 0);
  // A ladder that skipped an offer: nudged directly when the ladder is on.
  const skipped = offer({ createdAt: ago(1200), statusAt: ago(1200), sends: [{ ts: ago(1200), results: { sms: { ok: true } } }] });
  assert.deepEqual(auditConversations({ config: ladderOn, now: NOW, drafts: [], events: [], offers: [skipped], followUpCursorAt: ago(3) }).findings[0].action, { type: "nudge_offer" });
});

test("a held reply the gates called locked-but-clean is releasable; rows from before gateClean fall back to autoSendable", () => {
  const gary = draft({ id: "g", status: "draft", createdAt: ago(20), sentAt: null, intent: "counter", autoSendable: false, gateClean: true, needsHuman: false,
    autoSend: { decided: false, reason: "a counter is a person's call" }, flags: ["a counter is a person's call"] });
  assert.deepEqual(audit({ drafts: [gary], events: [], offers: [] }).findings[0].action, { type: "release", draftId: "g" });
  const old = draft({ id: "o", status: "draft", createdAt: ago(20), sentAt: null, autoSendable: false, needsHuman: false, autoSend: { decided: false, reason: "a other is a person's call" } });
  assert.equal(audit({ drafts: [old], events: [], offers: [] }).findings[0].action?.type, "book_checkin", "no verdict on the row: not released");
});
