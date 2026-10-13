// ghl-stages.test.mjs — GHL's Acquisitions card follows the agent's offers
// (Matt's diagram, 2026-10-13): Tier 2 · Tier 1 · Offer Out · Contract.
//
// What would go wrong without these:
//   - a number we texted would leave the card in Tier 1 (Matt: floated = Offer Out)
//   - a pass on one house would drop an agent to Tier 2 while another house is live
//   - the machine would undo a card Matt dragged in GHL after the last offer event
//   - a closed deal would hold the card at Contract forever, or a won card be reopened
//   - a move into Tier 2 would start GHL's texting nurture
//
//   node --test ghl-stages.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { planStageMoves, planCard, targetStage, normalizeGhlStages, stageKeys, stageKeyOf, boardCounts } from "./ghl-stages.js";

const NOW = Date.parse("2026-10-13T20:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const ACQ = { id: "acq", stages: [
  { id: "s-t1", name: "Tier 1 - Hot/Actionable, Active Deal" }, { id: "s-t2", name: "Tier 2 - Warm, No Active Deal" },
  { id: "s-out", name: "Offer Out" }, { id: "s-cs", name: "Contract Signed" },
] };
const OLD_ACQ = { id: "acq", stages: [
  { id: "s-new", name: "New Lead" }, ...ACQ.stages.slice(0, 2), { id: "s-t3", name: "Tier 3- Cold/Keep Warm" },
  { id: "s-out", name: "Offer Out" }, { id: "s-neg", name: "Negotiations" }, { id: "s-pass", name: "Passed on Offer" },
  { id: "s-ng", name: "Not a Good Deal" }, { id: "s-sent", name: "Contract Sent" }, { id: "s-cs", name: "Contract Signed" }, { id: "s-lost", name: "Lost" },
] };
const card = (contactId, stage, over = {}) => ({ id: `opp-${contactId}`, contactId, pipelineId: "acq", pipelineStageId: stage, status: "open", lastStageChangeAt: ago(20), ...over });
let n = 0;
const offer = (contactId, over = {}) => ({ id: `o-${contactId}-${++n}`, contactId, contactName: `Agent ${contactId}`, address: `${n} ${contactId} St`, cashAmount: 300000, status: "sent", createdAt: ago(10), sends: [{ ts: ago(9) }], ...over });
const plan = (o) => planStageMoves({ acq: ACQ, now: NOW, ...o });
const to = (r) => Object.fromEntries(r.moves.map((m) => [m.contactId, m.to]));

test("stages are found by name; Contract Signed is the contract stage when both exist", () => {
  const k = stageKeys(OLD_ACQ);
  assert.equal(k.tier1, "s-t1");
  assert.equal(k.offerOut, "s-out");
  assert.equal(k.contract, "s-cs");
  assert.equal(stageKeyOf(k, "s-sent"), "contractSent");
  assert.equal(stageKeyOf(stageKeys({ id: "x", stages: [{ id: "only", name: "Contract Sent" }] }), "only"), "contract");
});

test("each offer stage puts the card where Matt drew it", () => {
  const r = plan({
    opportunities: [card("d", "s-t2"), card("f", "s-t1"), card("s", "s-t1"), card("c", "s-t1"), card("h", "s-t1"), card("a", "s-out"), card("p", "s-out")],
    offers: [
      offer("d", { status: "new", sends: [], createdAt: ago(2) }),
      offer("f", { status: "new", sends: [], floatSentAt: ago(1) }),
      offer("s"),
      offer("c", { status: "countered", counter: { amount: 320000 } }),
      offer("h", { realm: { answer: "yes", ts: ago(1) } }),
      offer("a", { status: "accepted", deal: { stage: "under_contract", createdAt: ago(1) } }),
      offer("p", { status: "passed", statusAt: ago(1) }),
    ],
  });
  assert.deepEqual(to(r), { d: "Tier 1", f: "Offer Out", s: "Offer Out", c: "Offer Out", h: "Offer Out", a: "Contract", p: "Tier 2" });
});

test("no reply after the follow-ups sends the card back to Tier 2", () => {
  assert.deepEqual(to(plan({ opportunities: [card("q", "s-out")], offers: [offer("q", { status: "no_response", statusAt: ago(1) })] })), { q: "Tier 2" });
});

test("a pass on one house leaves the card where the agent's other live house puts it", () => {
  const r = plan({ opportunities: [card("m", "s-out")], offers: [offer("m", { status: "we_passed", statusAt: ago(1) }), offer("m")] });
  assert.equal(r.moves.length, 0);
  assert.equal(targetStage({ offers: [offer("m", { status: "we_passed" }), offer("m", { status: "draft", sends: [], createdAt: ago(1) })], now: NOW }).to, "tier1");
});

test("a held underwrite counts as a house in hand for three weeks", () => {
  assert.equal(targetStage({ offers: [offer("x", { status: "draft", sends: [], createdAt: ago(5) })], now: NOW }).to, "tier1");
  assert.equal(targetStage({ offers: [offer("x", { status: "draft", sends: [], createdAt: ago(30) })], now: NOW }).to, null);
});

test("a row a newer offer on the house replaced doesn't count", () => {
  const old = offer("r", { id: "old", address: "9 Elm St", createdAt: ago(20), sends: [{ ts: ago(19) }] });
  const fresh = offer("r", { id: "new", address: "9 Elm St", status: "passed", createdAt: ago(3), sends: [{ ts: ago(3) }], statusAt: ago(1) });
  assert.equal(targetStage({ offers: [old, fresh], now: NOW }).to, "tier2");
});

test("a card a person moved after the last offer event is left alone and reported", () => {
  const r = plan({ opportunities: [card("y", "s-t2", { lastStageChangeAt: ago(1) })], offers: [offer("y", { createdAt: ago(10), sends: [{ ts: ago(5) }] })] });
  assert.equal(r.moves.length, 0);
  assert.deepEqual(r.youMoved.map((m) => [m.contactId, m.wanted]), [["y", "Offer Out"]]);
  // The per-contact read has no lastStageChangeAt: the offer event is the newest thing we know.
  const edge = planCard({ acq: ACQ, cards: [card("y", "s-t2", { lastStageChangeAt: undefined })], offers: [offer("y")], contactId: "y", now: NOW });
  assert.equal(edge.move.to, "Offer Out");
});

test("a closed deal marks the card won at Contract; a new house later opens a new card", () => {
  const closed = offer("w", { status: "accepted", deal: { stage: "closed", createdAt: ago(30), stageHistory: [{ stage: "closed", ts: ago(2) }] } });
  const r = plan({ opportunities: [card("w", "s-cs")], offers: [closed] });
  assert.deepEqual(r.moves.map((m) => [m.to, m.status]), [["Contract", "won"]]);
  const next = planCard({ acq: ACQ, cards: [card("w", "s-cs", { status: "won" })], offers: [closed, offer("w", { status: "draft", sends: [], createdAt: ago(1) })], contactId: "w", now: NOW });
  assert.equal(next.create?.to, "Tier 1", "a won card is never reopened");
});

test("a deal that fell through goes back to Tier 2", () => {
  const r = plan({ opportunities: [card("z", "s-cs")], offers: [offer("z", { status: "accepted", deal: { stage: "fell_through", stageHistory: [{ stage: "fell_through", ts: ago(1) }] } })] });
  assert.deepEqual(to(r), { z: "Tier 2" });
});

test("an agent with something live and no card gets one; a lost card is reopened instead; nobody gets a card just for Tier 2", () => {
  const r = plan({ opportunities: [card("l", "s-t2", { status: "lost" })], offers: [offer("n"), offer("l"), offer("t", { status: "passed" })] });
  assert.deepEqual(r.creates.map((c) => [c.contactId, c.to, c.name]), [["n", "Offer Out", "Agent n"]]);
  assert.deepEqual(r.moves.map((m) => [m.contactId, m.to, m.status]), [["l", "Offer Out", "open"]]);
});

test("a move into Tier 2 is blocked while a texting nurture workflow is published", () => {
  const args = { opportunities: [card("b", "s-out")], offers: [offer("b", { status: "passed", statusAt: ago(1) })] };
  const blocked = plan({ ...args, nurtureLive: [{ id: "w1", name: "Tier 2+3 nurture" }] });
  assert.match(blocked.moves[0].blocked, /Tier 2\+3 nurture/);
  assert.equal(blocked.counts.blocked, 1);
  assert.equal(plan({ ...args, nurtureLive: [{ id: "w1", name: "Tier 2+3 nurture" }], settings: { allowNurtureTrigger: true } }).moves[0].blocked, undefined);
});

test("a Tier 1 card nothing came of goes to Tier 2 after staleTier1Days of quiet", () => {
  const quiet = plan({ opportunities: [card("q", "s-t1", { lastStageChangeAt: ago(12) })] });
  assert.deepEqual(to(quiet), { q: "Tier 2" });
  assert.equal(plan({ opportunities: [card("q", "s-t1", { lastStageChangeAt: ago(5) })] }).moves.length, 0);
  assert.equal(plan({ opportunities: [card("q", "s-t1", { lastStageChangeAt: ago(12) })], lastIn: new Map([["q", ago(2)]]) }).moves.length, 0);
  assert.equal(plan({ opportunities: [card("q", "s-t1", { lastStageChangeAt: ago(12) })], openPromiseContacts: new Set(["q"]) }).moves.length, 0);
});

test("never two open cards, and never a card in a stage that's going away", () => {
  const r = planStageMoves({ acq: OLD_ACQ, now: NOW,
    opportunities: [card("two", "s-t1"), { ...card("two", "s-t2"), id: "opp-two-b" }, card("neg", "s-neg")],
    offers: [offer("two"), offer("neg")] });
  assert.equal(r.moves.length, 0);
  assert.equal(r.counts.old, 1);
});

test("board counts open cards per kept stage and lumps the rest as old", () => {
  const c = boardCounts({ acq: OLD_ACQ, opportunities: [card("a", "s-t1"), card("b", "s-t2"), card("c", "s-out"), card("d", "s-cs"), card("e", "s-neg"), card("f", "s-sent"), card("g", "s-t2", { status: "lost" })] });
  assert.deepEqual(c, { tier2: 1, tier1: 1, offerOut: 1, contract: 1, old: 2, closed: 1 });
});

test("ships off", () => {
  assert.equal(normalizeGhlStages({}).mode, "off");
  assert.equal(normalizeGhlStages({ mode: "on" }).mode, "on");
});

/* ---------- the one-time move off the old stages ---------- */

const { planMigration } = await import("./ghl-stages.js");

test("old-stage cards land by the facts: live offers where they put them, replied in Tier 2, never replied closed", () => {
  const r = planMigration({ acq: OLD_ACQ, now: NOW, replied: new Set(["talked"]),
    opportunities: [
      card("neg", "s-neg"), card("ng", "s-ng"), card("talked", "s-t3"), card("silent", "s-new"),
      card("deal", "s-sent"), card("closed", "s-lost", { status: "lost" }), card("kept", "s-t1"),
    ],
    offers: [
      offer("neg", { status: "countered", counter: { amount: 320000 } }),
      offer("ng", { status: "we_passed" }),
      offer("deal", { status: "accepted", deal: { stage: "under_contract" } }),
    ] });
  const by = Object.fromEntries(r.moves.map((m) => [m.contactId, [m.to, m.status || "open"]]));
  assert.deepEqual(by, {
    neg: ["Offer Out", "open"], ng: ["Tier 2", "open"], talked: ["Tier 2", "open"], silent: ["Tier 2", "abandoned"],
    deal: ["Contract", "open"], closed: ["Tier 2", "open"],
  });
  assert.equal(by.kept, undefined, "a card already in one of the four stages isn't the migration's");
  assert.equal(r.moves.find((m) => m.contactId === "closed").status, undefined, "a closed card keeps its status");
});

test("the migration moves nothing into Tier 2 while a texting nurture is published, and leaves two open cards to a person", () => {
  const nurtureLive = [{ id: "w", name: "Tier 2+3 nurture" }];
  const r = planMigration({ acq: OLD_ACQ, now: NOW, nurtureLive, replied: new Set(["t"]),
    opportunities: [card("t", "s-t3"), card("s", "s-new"), card("two", "s-neg"), { ...card("two", "s-t1"), id: "opp-two-b" }],
    offers: [] });
  assert.match(r.moves.find((m) => m.contactId === "t").blocked, /nurture/);
  assert.match(r.moves.find((m) => m.contactId === "s").blocked, /nurture/, "a card being closed could still fire a stage-change trigger");
  assert.deepEqual(r.manual.map((m) => m.contactId), ["two"]);
  assert.equal(r.moves.some((m) => m.contactId === "two"), false);
});
