// needs-matt.test.mjs — what only Matt can do lands in GHL's "Needs Matt"
// stage, and nothing else does (shared/needs-matt.js, planCard's needsMatt).
//
// Matt, 2026-10-22, after the audit found an acceptance held 15 hours, three
// counters up to 46, and an agreed number sitting a week with nothing to tell
// him: "Instead of ping to me they land there."

import test from "node:test";
import assert from "node:assert/strict";
import { needsMattByContact, needsMattKind, PRICE_WAIT_HOURS, COUNTER_WAIT_HOURS } from "./needs-matt.js";
import { planCard, stageKeys, stageKeyOf } from "./ghl-stages.js";

const NOW = Date.parse("2026-10-22T18:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const ACQ = { id: "acq", stages: [
  { id: "s-nm", name: "Needs Matt" },
  { id: "s-t1", name: "Tier 1 - Hot/Actionable, Active Deal" }, { id: "s-t2", name: "Tier 2 - Warm, No Active Deal" },
  { id: "s-out", name: "Offer Out" }, { id: "s-cs", name: "Contract Signed" },
] };
const NO_STAGE = { id: "acq", stages: ACQ.stages.slice(1) };
const card = (contactId, stage, over = {}) => ({ id: `opp-${contactId}`, contactId, pipelineId: "acq", pipelineStageId: stage, status: "open", lastStageChangeAt: hoursAgo(24 * 20), ...over });
const offer = (contactId, over = {}) => ({ id: `o-${contactId}`, contactId, address: "123 Main St, Kent, WA", cashAmount: 715000, status: "countered", createdAt: hoursAgo(24 * 15), sends: [{ ts: hoursAgo(24 * 14) }], ...over });
const yes = { kind: "yes", why: "They agreed on 123 Main St at 715K: approve the number", at: hoursAgo(24 * 7), key: "needs_matt_noted:approve_number:o-ann" };

test("the stage is found by its name", () => {
  const k = stageKeys(ACQ);
  assert.equal(k.needsMatt, "s-nm");
  assert.equal(stageKeyOf(k, "s-nm"), "needsMatt");
  assert.equal(stageKeys(NO_STAGE).needsMatt, undefined);
});

test("an agent's yes puts their card in Needs Matt", () => {
  const need = needsMattByContact([{ id: "approve_number:o-ann", kind: "approve_number", contactId: "ann", offerId: "o-ann", address: "123 Main St, Kent, WA", amount: 715000 }], { now: NOW }).get("ann");
  assert.equal(need.kind, "yes");
  assert.match(need.why, /123 Main St at 715K: approve the number/);
  const r = planCard({ acq: ACQ, cards: [card("ann", "s-out")], offers: [offer("ann")], contactId: "ann", needsMatt: need, now: NOW });
  assert.equal(r.move?.to, "Needs Matt");
  assert.equal(r.move?.toStageId, "s-nm");
});

test("an acceptance the bot held for him lands there; a fresh counter waits for the machine first", () => {
  const drafts = [
    { id: "d-ok", contactId: "bo", party: "agent", intent: "acceptance", createdAt: hoursAgo(15) },
    { id: "d-c1", contactId: "cy", party: "agent", intent: "counter", createdAt: hoursAgo(2) },
    { id: "d-c2", contactId: "di", party: "agent", intent: "counter", createdAt: hoursAgo(COUNTER_WAIT_HOURS + 1) },
  ];
  const rows = drafts.map((d) => ({ id: `draft:${d.id}`, kind: "draft_waiting", draftId: d.id, contactId: d.contactId }));
  const m = needsMattByContact(rows, { drafts, now: NOW });
  assert.equal(m.get("bo")?.kind, "yes");
  assert.equal(m.has("cy"), false);
  assert.equal(m.get("di")?.kind, "counter");
});

test("a booked call, a call they asked for, a check-in and a closing task never land in Needs Matt", () => {
  const drafts = [
    { id: "d-s", contactId: "ed", party: "agent", intent: "scheduling", createdAt: hoursAgo(26) },
    { id: "d-w", contactId: "fay", party: "agent", intent: "wants_call", createdAt: hoursAgo(26) },
    { id: "d-p", contactId: "gus", party: "agent", intent: "agent_pulse", outbound: { kind: "agent_pulse" }, createdAt: hoursAgo(72) },
  ];
  const rows = [
    ...drafts.map((d) => ({ id: `draft:${d.id}`, kind: "draft_waiting", draftId: d.id, contactId: d.contactId })),
    { id: "call_brought:hal", kind: "call_brought", contactId: "hal" },
    { id: "closing_task_due:o-ivy", kind: "closing_task_due", contactId: "ivy" },
    { id: "investor_price_agreed:o-jo:jo", kind: "investor_price_agreed", contactId: "jo" },
  ];
  assert.equal(needsMattByContact(rows, { drafts, now: NOW }).size, 0);
});

test("a house waiting a day for its price lands in Needs Matt, not before", () => {
  const row = (h) => ({ id: "price_it:o-kay", kind: "price_it", contactId: "kay", offerId: "o-kay", address: "77 Birch Ln, Bellevue, WA", readyAt: hoursAgo(h) });
  assert.equal(needsMattKind(row(3), { now: NOW }), null);
  const need = needsMattByContact([row(PRICE_WAIT_HOURS + 26)], { now: NOW }).get("kay");
  assert.equal(need.kind, "price");
  assert.match(need.why, /Price it on 77 Birch Ln: the agent has waited 2 days/);
  assert.equal(needsMattKind({ kind: "promise_owed", what: "number", owedAt: hoursAgo(30) }, { now: NOW }), "price");
  assert.equal(needsMattKind({ kind: "promise_owed", what: "paper", owedAt: hoursAgo(30) }, { now: NOW }), null);
});

test("one agent with two things shows the most pressing", () => {
  const m = needsMattByContact([
    { id: "price_it:o1", kind: "price_it", contactId: "lu", readyAt: hoursAgo(48) },
    { id: "approve_number:o2", kind: "approve_number", contactId: "lu", amount: 400000 },
  ], { now: NOW });
  assert.equal(m.get("lu").kind, "yes");
});

test("the card leaves Needs Matt once the number is approved", () => {
  const r = planCard({ acq: ACQ, cards: [card("ann", "s-nm", { lastStageChangeAt: hoursAgo(5) })], offers: [offer("ann")], contactId: "ann",
    appMoves: [hoursAgo(5)], needsMatt: null, now: NOW });
  assert.equal(r.move?.to, "Offer Out");
});

test("a card left in Needs Matt with nothing live goes back to Tier 2", () => {
  const r = planCard({ acq: ACQ, cards: [card("mo", "s-nm", { lastStageChangeAt: hoursAgo(5) })], offers: [], contactId: "mo", appMoves: [hoursAgo(5)], now: NOW });
  assert.equal(r.move?.to, "Tier 2");
});

test("a house under contract stays in Contract whatever needs him", () => {
  const r = planCard({ acq: ACQ, cards: [card("ned", "s-cs")], offers: [offer("ned", { status: "accepted" })], contactId: "ned", needsMatt: yes, now: NOW });
  assert.equal(r.move, undefined);
  assert.match(r.skip || "", /already in Contract/);
});

test("no stage named Needs Matt: nothing moves for it", () => {
  const r = planCard({ acq: NO_STAGE, cards: [card("ann", "s-out")], offers: [offer("ann")], contactId: "ann", needsMatt: yes, now: NOW });
  assert.equal(r.move, undefined);
});

test("Matt dragging the card out after it landed is his call", () => {
  const r = planCard({ acq: ACQ, cards: [card("ann", "s-t1", { lastStageChangeAt: hoursAgo(1) })], offers: [offer("ann")], contactId: "ann", needsMatt: yes, now: NOW });
  assert.ok(r.youMoved);
});

test("an agent with no open card gets one in Needs Matt", () => {
  const r = planCard({ acq: ACQ, cards: [], offers: [offer("ann")], contactId: "ann", name: "Agent", needsMatt: yes, now: NOW });
  assert.equal(r.create?.to, "Needs Matt");
});
