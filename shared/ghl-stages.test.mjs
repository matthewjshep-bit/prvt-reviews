// ghl-stages.test.mjs — GHL's Acquisitions cards follow the app. Shapes from
// 2026-10-02: 28 cards in Tier 1, about 9 with nothing live in the app, and
// offers out on agents still sitting in Tier 1/2/3.

import test from "node:test";
import assert from "node:assert/strict";
import { planStageMoves, normalizeGhlStages, stageKeys } from "./ghl-stages.js";

const NOW = Date.parse("2026-10-02T20:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const ACQ = { id: "acq", stages: [
  { id: "s-new", name: "New Lead" }, { id: "s-t1", name: "Tier 1 - Hot/Actionable, Active Deal" }, { id: "s-t2", name: "Tier 2 - Warm, No Active Deal" },
  { id: "s-t3", name: "Tier 3- Cold/Keep Warm" }, { id: "s-out", name: "Offer Out" }, { id: "s-neg", name: "Negotiations" }, { id: "s-pass", name: "Passed on Offer" },
  { id: "s-ng", name: "Not a Good Deal" }, { id: "s-cs", name: "Contract Signed" }, { id: "s-lost", name: "Lost" },
] };
const card = (contactId, stage, over = {}) => ({ id: `opp-${contactId}`, contactId, pipelineId: "acq", pipelineStageId: stage, status: "open", lastStageChangeAt: ago(20), ...over });
const offer = (contactId, over = {}) => ({ id: `o-${contactId}-${Math.random().toString(36).slice(2, 6)}`, contactId, address: `${contactId} St`, cashAmount: 300000, status: "sent", createdAt: ago(10), sends: [{ ts: ago(9) }], ...over });
const plan = (o) => planStageMoves({ acq: ACQ, now: NOW, ...o });

test("stages are found by name, however GHL spells them", () => {
  const k = stageKeys(ACQ);
  assert.equal(k.tier1, "s-t1");
  assert.equal(k.tier3, "s-t3");
  assert.equal(k.offerOut, "s-out");
  assert.equal(k.contract, "s-cs");
});

test("an offer out moves a tier card to Offer Out; a counter or a hot offer to Negotiations", () => {
  const { moves } = plan({
    opportunities: [card("a", "s-t1"), card("b", "s-t3"), card("c", "s-out")],
    offers: [offer("a"), offer("b", { status: "countered", counter: { amount: 320000 } }), offer("c", { realm: { answer: "yes", ts: ago(1) } })],
  });
  const by = Object.fromEntries(moves.map((m) => [m.contactId, m.to]));
  assert.deepEqual(by, { a: "Offer Out", b: "Negotiations", c: "Negotiations" });
});

test("when every house is over, the in-flight card says so; ours or theirs", () => {
  const { moves } = plan({
    opportunities: [card("p", "s-out"), card("w", "s-neg")],
    offers: [offer("p", { status: "passed" }), offer("w", { status: "we_passed" })],
  });
  assert.deepEqual(Object.fromEntries(moves.map((m) => [m.contactId, m.to])), { p: "Passed on Offer", w: "Not a Good Deal" });
});

test("a stale Tier 1 would move to Tier 2 — reported, not moved, while off", () => {
  const r = plan({ opportunities: [card("stale", "s-t1", { lastStageChangeAt: ago(15) })], offers: [offer("stale", { status: "passed", statusAt: ago(20) })], lastIn: new Map([["stale", ago(25)]]) });
  assert.equal(r.moves.length, 1);
  assert.equal(r.moves[0].to, "Tier 2 - Warm, No Active Deal");
  assert.match(r.moves[0].why, /nothing open/);
  assert.equal(normalizeGhlStages({}).mode, "off", "it ships off");
  // …not when they wrote last week, owe us nothing, or we owe them.
  assert.equal(plan({ opportunities: [card("stale", "s-t1", { lastStageChangeAt: ago(15) })], lastIn: new Map([["stale", ago(3)]]) }).moves.length, 0);
  assert.equal(plan({ opportunities: [card("stale", "s-t1", { lastStageChangeAt: ago(15) })], openPromiseContacts: new Set(["stale"]) }).moves.length, 0);
  assert.equal(plan({ opportunities: [card("stale", "s-t1", { lastStageChangeAt: ago(4) })] }).moves.length, 0, "not in Tier 1 long enough");
});

test("a published nurture workflow blocks the move", () => {
  const r = plan({ opportunities: [card("stale", "s-t1", { lastStageChangeAt: ago(15) })], nurtureLive: [{ id: "wf", name: "Tier 2+3 nurture" }] });
  assert.match(r.moves[0].blocked, /Tier 2\+3 nurture is published/);
  assert.equal(r.counts.blocked, 1);
  assert.equal(r.counts.planned, 0);
  assert.equal(plan({ opportunities: [card("stale", "s-t1", { lastStageChangeAt: ago(15) })], nurtureLive: [{ id: "wf", name: "Tier 2+3 nurture" }], settings: { allowNurtureTrigger: true } }).moves[0].blocked, undefined);
});

test("never a contract stage, a lost card, a live deal, or an agent with two open cards", () => {
  const r = plan({
    opportunities: [card("k", "s-cs"), card("l", "s-lost"), card("d", "s-t1"), card("two", "s-t1"), card("two", "s-t2", { id: "opp-two-b" })],
    offers: [offer("k"), offer("l"), offer("d", { status: "accepted", deal: { stage: "under_contract" } }), offer("two")],
  });
  assert.deepEqual(r.moves, []);
});
