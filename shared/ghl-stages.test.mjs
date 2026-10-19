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
import { planStageMoves, planCard, planHandMove, targetStage, normalizeGhlStages, stageKeys, stageKeyOf, boardCounts, cardHeldBy, raisedHouses, sameRaisedHouse, validAddress } from "./ghl-stages.js";

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

// Matt, 2026-10-13: Tier 3 is folded into Tier 2. A GHL workflow or a drag
// that still puts a card there doesn't get to keep it there.
test("a card that lands in Tier 3 is moved on, to Tier 2 or wherever the offers put it, whoever moved it there", () => {
  const r = planStageMoves({ acq: OLD_ACQ, now: NOW,
    opportunities: [card("cold", "s-t3", { lastStageChangeAt: ago(0.1) }), card("live", "s-t3", { lastStageChangeAt: ago(0.1) })],
    offers: [offer("live")] });
  assert.deepEqual(to(r), { cold: "Tier 2", live: "Offer Out" });
  assert.equal(r.youMoved.length, 0);
});

test("board counts open cards per kept stage and lumps the rest as old", () => {
  const c = boardCounts({ acq: OLD_ACQ, opportunities: [card("a", "s-t1"), card("b", "s-t2"), card("c", "s-out"), card("d", "s-cs"), card("e", "s-neg"), card("f", "s-sent"), card("g", "s-t2", { status: "lost" })] });
  assert.deepEqual(c, { tier2: 1, tier1: 1, offerOut: 1, contract: 1, old: 2, closed: 1 });
});

test("ships off", () => {
  assert.equal(normalizeGhlStages({}).mode, "off");
  assert.equal(normalizeGhlStages({ mode: "on" }).mode, "on");
  assert.equal(normalizeGhlStages({}).tier2Repliers, false);
  assert.equal(normalizeGhlStages({ tier2Repliers: true }).tier2Repliers, true);
});

// Matt, 2026-10-16 (Deanna W.): she wrote back "no fixers right now, I'll
// call when I have one". Nothing to price, so no offer, so no card, and
// nothing in GHL said to follow up with her. Tier 2 is where he looks.
const said = (id, d) => new Map([[id, ago(d)]]);
const ON = { tier2Repliers: true };

test("an agent we talked with and have no offer for gets a Tier 2 card, so we know to follow up", () => {
  const r = plan({ settings: ON, repliers: said("dw", 0.5) });
  assert.deepEqual(r.creates.map((c) => [c.contactId, c.to, c.replier]), [["dw", "Tier 2", true]]);
  assert.equal(r.counts.tier2Repliers, 1);
  // Every house of theirs passed and no card: the same.
  const passed = plan({ settings: ON, offers: [offer("p", { status: "passed", statusAt: ago(3) })], repliers: said("p", 1) });
  assert.deepEqual(passed.creates.map((c) => [c.contactId, c.to]), [["p", "Tier 2"]]);
  // Switched off, nothing changes.
  assert.equal(plan({ repliers: said("dw", 0.5) }).creates.length, 0);
});

test("a conversation's closed card reopens in Tier 2 only for a word after it was closed; lost and deleted cards stay that way", () => {
  // Abandoned (the migration closed never-repliers), then they wrote: reopened.
  const re = plan({ settings: ON, opportunities: [card("ab", "s-t2", { status: "abandoned", lastStatusChangeAt: ago(3) })], repliers: said("ab", 1) });
  assert.deepEqual(re.moves.map((m) => [m.contactId, m.to, m.status, m.replier]), [["ab", "Tier 2", "open", true]]);
  // Closed after their last word: whoever closed it had seen the conversation.
  assert.equal(plan({ settings: ON, opportunities: [card("ab", "s-t2", { status: "abandoned", lastStatusChangeAt: ago(1) })], repliers: said("ab", 3) }).moves.length, 0);
  // Lost is a person's call.
  const lost = plan({ settings: ON, opportunities: [card("lo", "s-t2", { status: "lost", lastStatusChangeAt: ago(9) })], repliers: said("lo", 1) });
  assert.equal(lost.moves.length + lost.creates.length, 0);
  // A card the app made that isn't there any more was deleted (Tyler E., 2026-10-15).
  assert.equal(plan({ settings: ON, repliers: said("gone", 1), cardsMade: new Set(["gone"]) }).creates.length, 0);
  // A won card stays won; a word since makes a new Tier 2 card.
  const won = plan({ settings: ON, opportunities: [card("wn", "s-cs", { status: "won", lastStatusChangeAt: ago(30) })], repliers: said("wn", 1) });
  assert.deepEqual([won.moves.length, won.creates.map((c) => c.to)], [0, ["Tier 2"]]);
  // An open card is left to the usual rules.
  assert.equal(plan({ settings: ON, opportunities: [card("op", "s-t1", { lastStageChangeAt: ago(2) })], repliers: said("op", 1) }).moves.length, 0);
});

test("no Tier 2 card for a conversation while a texting nurture workflow is published", () => {
  const r = plan({ settings: ON, repliers: said("ng", 1), nurtureLive: [{ id: "w1", name: "Tier 2+3 nurture" }] });
  assert.match(r.creates[0].blocked, /Tier 2\+3 nurture/);
  assert.equal(r.counts.blocked, 1);
  assert.equal(r.counts.created, 0);
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

// Matt, 2026-10-13: "Tier 2 should combine all the previous tier 3's into tier 2".
// 307 live Tier 3 cards had never replied and would have been closed.
test("every Tier 3 card with nothing live joins Tier 2 open, even an agent who never replied", () => {
  const r = planMigration({ acq: OLD_ACQ, now: NOW, replied: new Set(),
    opportunities: [card("cold", "s-t3"), card("live", "s-t3"), card("lead", "s-new")],
    offers: [offer("live")] });
  const by = Object.fromEntries(r.moves.map((m) => [m.contactId, [m.to, m.status || "open"]]));
  assert.deepEqual(by.cold, ["Tier 2", "open"]);
  assert.deepEqual(by.live, ["Offer Out", "open"], "a live offer still puts them where it does");
  assert.deepEqual(by.lead, ["Tier 2", "abandoned"], "a New Lead who never replied is still closed");
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

test("the bot's tier-2/3 tag and TIER 2/3 workflow are the lower-tier moves; TIER 1, leaving a tier and dispositions aren't", async () => {
  const { isLowerTierAction } = await import("./tier-one.js");
  assert.equal(isLowerTierAction({ type: "add_tags", tags: ["tier-3"] }), true);
  assert.equal(isLowerTierAction({ type: "add_tags", tags: ["Tier-2"] }), true);
  assert.equal(isLowerTierAction({ type: "add_to_workflow", workflowName: "TIER 3" }), true);
  assert.equal(isLowerTierAction({ type: "add_tags", tags: ["tier-1"] }), false);
  assert.equal(isLowerTierAction({ type: "add_to_workflow", workflowName: "TIER 1" }), false);
  assert.equal(isLowerTierAction({ type: "add_to_workflow", workflowName: "Tier 2 Disposition" }), false);
  assert.equal(isLowerTierAction({ type: "remove_tags", tags: ["tier-2", "tier-3"] }), false);
});

// Matt, 2026-10-14: Eric B. sat in Tier 1 for 55 days on an August row we
// priced and never sent; Cheryl P. on a duplicate of a house
// we'd passed on. A number that never went out is Tier 1 only while live.
test("a priced offer never sent and quiet 10 days leaves Tier 1", () => {
  const stale = offer("e", { status: "new", sends: [], createdAt: ago(55) });
  const t = targetStage({ offers: [stale], now: NOW, lastIn: ago(55) });
  assert.equal(t.to, "tier2");
  assert.match(t.why, /never sent/);
  assert.equal(targetStage({ offers: [offer("e2", { status: "new", sends: [], createdAt: ago(4) })], now: NOW }).to, "tier1", "a fresh one stays");
  assert.equal(targetStage({ offers: [offer("e3", { status: "new", sends: [], createdAt: ago(30) })], now: NOW, lastIn: ago(2) }).to, "tier2",
    "their texts about something else don't keep an unsent number alive");
  assert.equal(targetStage({ offers: [offer("e5", { status: "new", sends: [], createdAt: ago(30), statusAt: ago(2) })], now: NOW }).to, "tier1", "something on the offer this week does");
  assert.equal(targetStage({ offers: [offer("e4", { status: "draft", sends: [], createdAt: ago(15) })], now: NOW }).to, "tier2", "a held draft gone quiet too");
});

test("a card the app moved itself is not read as one you moved", () => {
  const moved = ago(1);
  const stale = offer("k", { status: "new", sends: [], createdAt: ago(55) });
  const theirs = planCard({ acq: ACQ, cards: [card("k", "s-t1", { lastStageChangeAt: moved })], offers: [stale], contactId: "k", lastIn: ago(55), now: NOW });
  assert.ok(theirs.youMoved, "with no record of ours, a newer card move is yours");
  const ours = planCard({ acq: ACQ, cards: [card("k", "s-t1", { lastStageChangeAt: moved })], offers: [stale], contactId: "k", lastIn: ago(55),
    appMoves: [new Date(Date.parse(moved) + 4000).toISOString()], now: NOW });
  assert.equal(ours.move?.to, "Tier 2", JSON.stringify(ours));
});

// Matt, 2026-10-16 (Toril S.): he passed her house and her card never left
// Tier 1. Her other house, a held draft, kept it there, as the rule says, but
// nothing told him which house or why, so the pass looked broken.
test("a pass that leaves another house live says which house keeps the card, and why", () => {
  const passed = offer("t", { address: "16910 132nd Ave E, Puyallup, WA 98374", status: "we_passed", statusAt: ago(0) });
  const held = offer("t", { address: "29308 158th Ave E, Graham, WA 98338", status: "draft", cashAmount: null, sends: [], createdAt: ago(3) });
  const r = cardHeldBy({ offers: [passed, held], now: NOW });
  assert.equal(r.to, "tier1");
  assert.equal(r.offerId, held.id);
  assert.match(r.text, /stays in Tier 1: 29308 158th Ave E is still being priced/);
  const out = cardHeldBy({ offers: [passed, offer("t", { address: "5 Out St, Kent, WA" })], now: NOW });
  assert.match(out.text, /stays in Offer Out: our number on 5 Out St is still out/);
  assert.equal(cardHeldBy({ offers: [passed], now: NOW }), null, "nothing else live: the card goes to Tier 2, nothing to explain");
  assert.equal(cardHeldBy({ offers: [passed, { ...held, createdAt: ago(15) }], now: NOW }), null, "a draft quiet past staleTier1Days doesn't hold it");
});

// The companion window (Matt, 2026-10-17): he sets an agent's stage by hand.
test("a stage set by hand moves their open card to that stage", () => {
  const r = planHandMove({ acq: ACQ, contactId: "m", to: "tier1", cards: [card("m", "s-t2")] });
  assert.deepEqual(r.move, { contactId: "m", to: "Tier 1", toKey: "tier1", toStageId: "s-t1", opportunityId: "opp-m", from: "Tier 2 - Warm, No Active Deal" });
  assert.equal(planHandMove({ acq: ACQ, contactId: "m", to: "offerOut", cards: [card("m", "s-out")] }).skip, "Already in Offer Out.");
});

test("a stage set by hand with no open card reopens their last card, or makes one; a won card stays won", () => {
  const lost = card("m", "s-out", { status: "lost", updatedAt: ago(3) });
  const r = planHandMove({ acq: ACQ, contactId: "m", to: "tier1", cards: [lost] });
  assert.equal(r.move.opportunityId, "opp-m");
  assert.equal(r.move.status, "open");
  assert.equal(r.move.toStageId, "s-t1");
  const made = planHandMove({ acq: ACQ, contactId: "m", to: "tier2", name: "Agent M", cards: [card("m", "s-cs", { status: "won" })] });
  assert.deepEqual(made.create, { contactId: "m", to: "Tier 2", toKey: "tier2", toStageId: "s-t2", name: "Agent M" });
});

test("a stage set by hand is refused with two open cards, a stage GHL lacks, or a Tier 2 move that would start a texting nurture", () => {
  assert.match(planHandMove({ acq: ACQ, contactId: "m", to: "tier1", cards: [card("m", "s-t2"), card("m", "s-out", { id: "opp-2" })] }).refuse, /two open cards/);
  assert.match(planHandMove({ acq: { id: "acq", stages: ACQ.stages.slice(0, 2) }, contactId: "m", to: "offerOut", cards: [] }).refuse, /no Offer Out stage/);
  assert.match(planHandMove({ acq: ACQ, contactId: "m", to: "tier2", cards: [card("m", "s-t1")], nurtureLive: [{ id: "w", name: "Tier 2+3 nurture" }] }).refuse, /Tier 2\+3 nurture is published/);
  assert.ok(planHandMove({ acq: ACQ, contactId: "m", to: "tier1", cards: [card("m", "s-t2")], nurtureLive: [{ id: "w", name: "Tier 2+3 nurture" }] }).move, "the guard is only for Tier 2");
  assert.match(planHandMove({ acq: ACQ, contactId: "m", to: "won", cards: [] }).refuse, /four Acquisitions stages/);
});

test("the offers don't drag back a card moved in the companion, even when GHL doesn't say when it moved", () => {
  // His offer is Sent (Offer Out); he set Tier 1 by hand yesterday, after the send.
  const opp = card("m", "s-t1", { lastStageChangeAt: undefined });
  const offers = [offer("m", { sends: [{ ts: ago(5) }] })];
  const r = planCard({ acq: ACQ, contactId: "m", cards: [opp], offers, handMoves: [ago(1)], now: NOW });
  assert.ok(r.youMoved, JSON.stringify(r));
  assert.equal(r.youMoved.wanted, "Offer Out");
  // Without the record it would have moved.
  assert.equal(planCard({ acq: ACQ, contactId: "m", cards: [opp], offers, now: NOW }).move?.to, "Offer Out");
  // GHL's own time for the PUT, seconds after the record, is the same move.
  assert.ok(planCard({ acq: ACQ, contactId: "m", cards: [card("m", "s-t1", { lastStageChangeAt: new Date(Date.parse(ago(1)) + 5000).toISOString() })], offers, handMoves: [ago(1)], appMoves: [], now: NOW }).youMoved);
  // The sweep reads the same record.
  assert.equal(planStageMoves({ acq: ACQ, now: NOW, opportunities: [opp], offers, handMoves: new Map([["m", [ago(1)]]]) }).youMoved.length, 1);
});

test("a hand move stands until something new happens on an offer, then the offers win", () => {
  const offers = [offer("m", { sends: [{ ts: ago(1) }] })];   // sent after the hand move
  const r = planCard({ acq: ACQ, contactId: "m", cards: [card("m", "s-t1", { lastStageChangeAt: undefined })], offers, handMoves: [ago(3)], now: NOW });
  assert.equal(r.move?.to, "Offer Out");
});

test("an app move after the hand move is the app's, not his", () => {
  // He set Tier 1 five days ago; the planner moved it to Tier 2 two days ago (recorded); an offer event three days ago.
  const offers = [offer("m", { status: "passed", statusAt: ago(4), sends: [{ ts: ago(6) }] }), offer("m", { status: "new", sends: [], createdAt: ago(3) })];
  const r = planCard({ acq: ACQ, contactId: "m", cards: [card("m", "s-t2", { lastStageChangeAt: ago(2) })], offers, handMoves: [ago(5)], appMoves: [ago(2)], now: NOW });
  assert.ok(!r.youMoved, JSON.stringify(r));
});

/* ---------- a house the conversation raised (2026-10-16) ---------- */

// Matt, 2026-10-16: "Tier 1 should be allowed even if there is no draft or
// offer. As long as they've offered a valid address or have indicated it's
// an actual flip opportunity." An agent answered our first text with "It
// needs a lot of work", the bot asked its one question, nothing was priced,
// and nothing put the card in Tier 1.
const ev = (type, address, data = {}, at = ago(1)) => ({ contactId: "kw", party: "agent", type, address, at, data });
const EDMONDS = "20911 78th Ave W, Edmonds, WA 98026";

test("an agent who says the house needs a lot of work is in Tier 1 with nothing priced", () => {
  const raised = raisedHouses({ events: [ev("property_details", EDMONDS, { condition: "needs a lot of work" })], now: NOW });
  assert.deepEqual(raised.map((h) => [h.address, h.open]), [[EDMONDS, true]]);
  assert.match(raised[0].why, /needs real work/);
  const t = targetStage({ offers: [], raised, now: NOW });
  assert.equal(t.to, "tier1");
  assert.equal(t.raised, EDMONDS);
  const r = planCard({ acq: ACQ, contactId: "kw", raised, now: NOW });
  assert.equal(r.create?.to, "Tier 1");
  assert.equal(r.create?.conversation, true, "the runner checks GHL's tags before making it");
});

test("an agent who gives us a house with a full address is in Tier 1; a street with no number or town isn't", () => {
  const given = raisedHouses({ events: [ev("house_mentioned", "15426 Stone Ave, Shoreline", { note: "rambler", needsAddress: false })], now: NOW });
  assert.equal(given[0]?.open, true);
  assert.match(given[0].why, /they gave us 15426 Stone Ave/);
  assert.equal(raisedHouses({ events: [ev("house_mentioned", "Pine St, Shelton", { needsAddress: true })], now: NOW }).length, 0);
  assert.equal(raisedHouses({ events: [ev("house_mentioned", "123 Main St", { needsAddress: false })], now: NOW }).length, 0, "no town or ZIP to find it by");
  assert.equal(validAddress("13239 166th Ave SE, Renton WA 98059"), true);
});

test("their word that it's turnkey or light work never raises a house, and closes one they raised", () => {
  assert.equal(raisedHouses({ events: [ev("property_details", EDMONDS, { condition: "fully remodeled, move-in ready" })], now: NOW }).length, 0);
  const later = raisedHouses({ events: [
    ev("property_details", EDMONDS, { condition: "needs a lot of work" }, ago(3)),
    ev("property_details", EDMONDS, { condition: "no big stuff, mostly cosmetic", workNeeded: "paint and flooring" }, ago(2)),
  ], now: NOW });
  assert.deepEqual(later.map((h) => h.open), [false]);
  assert.equal(targetStage({ raised: later, now: NOW }).to, "tier2");
});

test("a house we passed on, they passed on, or that sold in the conversation sends the card back to Tier 2", () => {
  for (const why of ["we passed on it", "they passed", "it sold or came off the market"]) {
    const raised = raisedHouses({ events: [
      ev("house_mentioned", EDMONDS, { needsAddress: false }, ago(3)),
      ev("house_closed", EDMONDS, { why }, ago(1)),
    ], now: NOW });
    const r = planCard({ acq: ACQ, contactId: "kw", cards: [card("kw", "s-t1", { lastStageChangeAt: ago(3) })], raised, now: NOW });
    assert.equal(r.move?.to, "Tier 2", why);
    assert.match(r.move.why, new RegExp(why), why);
  }
});

test("an opt-out after the raise closes it", () => {
  const raised = raisedHouses({ events: [ev("house_mentioned", EDMONDS, { needsAddress: false }, ago(3)), ev("unsubscribed", "", {}, ago(1))], now: NOW });
  assert.deepEqual(raised.map((h) => [h.open, h.why]), [[false, "they opted out"]]);
});

test("a house we priced is the offer's to say, however the thread spelled it", () => {
  assert.equal(sameRaisedHouse("15426 Stone Ave, Shoreline", "15426 Stone Ave N, Shoreline, WA 98133"), true);
  assert.equal(sameRaisedHouse("123 Main St, Kent", "123 Main St, Renton"), false);
  const events = [ev("house_mentioned", "15426 Stone Ave, Shoreline", { needsAddress: false })];
  const passed = offer("kw", { address: "15426 Stone Ave N, Shoreline, WA 98133", status: "we_passed", statusAt: ago(0.5) });
  assert.equal(raisedHouses({ events, offers: [passed], now: NOW }).length, 0);
  assert.equal(targetStage({ offers: [passed], raised: raisedHouses({ events, offers: [passed], now: NOW }), now: NOW }).to, "tier2");
});

/* ---------- a house the conversation closed, with a row on it (2026-10-19) ---------- */

// Matt, 2026-10-19: "Why does the app keep moving people into tier 1 that
// shouldn't be there? Tyler Eaton and Loren Kenkman for example."
// Tyler's agent said 1823 Maple St was "great shape, just super dated" and
// turned our number down; a held re-run priced it again five days later,
// never sent, and the card went to Tier 1 ("priced, our number not out yet").
// Loren's agent's house got a held draft the bot passed on as light work; when
// we passed on her other house, that draft pulled the card up to Tier 1.
const MAPLE = "1823 Maple St, Everett, WA 98201";
const tyler = [
  ev("property_details", MAPLE, { condition: "great shape", workNeeded: "just super dated" }, ago(10)),
  ev("agent_estimate", MAPLE, { arv: 439000, rehab: 27000 }, ago(10)),
];

test("an unsent offer on a house the agent called light work doesn't put the card in Tier 1", () => {
  const priced = offer("kw", { address: MAPLE, status: "new", sends: [], createdAt: ago(5) });
  const raised = raisedHouses({ events: tyler, offers: [priced], now: NOW });
  const t = targetStage({ offers: [priced], raised, now: NOW });
  assert.equal(t.to, "tier2");
  assert.match(t.why, /1823 Maple St: they said it's light work/);
  const r = planCard({ acq: ACQ, contactId: "kw", cards: [card("kw", "s-t1", { lastStageChangeAt: ago(5) })], offers: [priced], raised, now: NOW });
  assert.equal(r.move?.to, "Tier 2");
});

test("a held draft on a house the conversation passed doesn't pull the card up to Tier 1", () => {
  const house = "20525 NE 68th St, Redmond, WA 98053";
  const draft = offer("kw", { address: house, status: "draft", sends: [], createdAt: ago(6) });
  const passed = offer("kw", { address: "9 Other Rd, Redmond, WA 98053", status: "we_passed", statusAt: ago(3), sends: [{ ts: ago(5) }] });
  const raised = raisedHouses({ events: [ev("house_closed", house, { why: "we passed on it" }, ago(6))], offers: [draft, passed], now: NOW });
  assert.equal(targetStage({ offers: [draft, passed], raised, now: NOW }).to, "tier2");
});

test("the agent's own word reopens a closed house; our re-pricing doesn't", () => {
  const priced = offer("kw", { address: MAPLE, status: "new", sends: [], createdAt: ago(1) });
  const reopened = raisedHouses({ events: [...tyler, ev("property_details", MAPLE, { condition: "needs a full gut" }, ago(2))], offers: [priced], now: NOW });
  assert.equal(targetStage({ offers: [priced], raised: reopened, now: NOW }).to, "tier1");
});

test("a closed house with our number out is still Offer Out, and the close is kept past the 10 days", () => {
  const out = offer("kw", { address: MAPLE, status: "sent", createdAt: ago(5), sends: [{ ts: ago(5) }] });
  const raised = raisedHouses({ events: tyler, offers: [out], now: NOW });
  assert.equal(targetStage({ offers: [out], raised, now: NOW }).to, "offerOut");
  const old = raisedHouses({ events: [ev("house_closed", MAPLE, { why: "they passed" }, ago(30))], offers: [out], now: NOW });
  assert.deepEqual(old.map((h) => h.open), [false], "a close on a house with a row isn't dropped as stale");
});

// Loren K.: the held draft was on "20525 Ne 68th St" (the map couldn't find
// it); she corrected it to 20526 NE 68th St, Redmond, we priced and passed
// that one, and the draft on the typo held the card in Tier 1.
test("a house number the agent corrected is closed, so its leftover draft doesn't hold Tier 1", () => {
  const typo = "20525 Ne 68th St";
  const real = "20526 NE 68th St, Redmond, WA 98053";
  const draft = offer("kw", { address: typo, status: "draft", sends: [], createdAt: ago(6) });
  const passed = offer("kw", { address: real, status: "we_passed", statusAt: ago(3), sends: [{ ts: ago(5) }] });
  const events = [ev("subject_property_set", real, { from: typo }, ago(6))];
  const raised = raisedHouses({ events, offers: [draft, passed], now: NOW });
  assert.match(raised.find((h) => !h.open)?.why || "", /20525 Ne 68th St: they corrected it to 20526 NE 68th St/);
  assert.equal(targetStage({ offers: [draft, passed], raised, now: NOW }).to, "tier2");
  // Moving on to a different street is a new house, not a correction.
  const moved = raisedHouses({ events: [ev("subject_property_set", "9 Pine St, Redmond, WA 98053", { from: typo }, ago(6))], offers: [draft], now: NOW });
  assert.equal(targetStage({ offers: [draft], raised: moved, now: NOW }).to, "tier1");
});

test("a raise goes quiet after the same 10 days an unsent offer does", () => {
  const raised = raisedHouses({ events: [ev("property_details", EDMONDS, { condition: "needs a lot of work" }, ago(11))], now: NOW });
  assert.equal(raised.length, 0);
});

test("a house they raised never pulls a card down from Offer Out", () => {
  const raised = raisedHouses({ events: [ev("house_mentioned", EDMONDS, { needsAddress: false })], now: NOW });
  assert.equal(targetStage({ offers: [offer("kw")], raised, now: NOW }).to, "offerOut");
});

test("a person's move after the raise stands; a raise after the person's move wins", () => {
  const raised = raisedHouses({ events: [ev("house_mentioned", EDMONDS, { needsAddress: false }, ago(2))], now: NOW });
  const after = planCard({ acq: ACQ, contactId: "kw", cards: [card("kw", "s-t2", { lastStageChangeAt: ago(1) })], raised, now: NOW });
  assert.ok(after.youMoved, JSON.stringify(after));
  const before = planCard({ acq: ACQ, contactId: "kw", cards: [card("kw", "s-t2", { lastStageChangeAt: ago(3) })], raised, now: NOW });
  assert.equal(before.move?.to, "Tier 1");
  assert.equal(before.move?.conversation, true);
});

test("the sweep plans a Tier 1 card for an agent whose conversation raised a house, with no offer", () => {
  const raised = raisedHouses({ events: [ev("property_details", EDMONDS, { condition: "needs a lot of work" })], now: NOW });
  const r = plan({ opportunities: [], offers: [], raised: new Map([["kw", raised]]) });
  assert.deepEqual(r.creates.map((c) => [c.contactId, c.to, c.conversation]), [["kw", "Tier 1", true]]);
  assert.equal(r.counts.conversation, 1);
});

test("after a pass, a house they raised that's still open is named as what keeps the card in Tier 1", () => {
  const raised = raisedHouses({ events: [ev("house_mentioned", EDMONDS, { needsAddress: false })], now: NOW });
  const held = cardHeldBy({ offers: [offer("kw", { status: "we_passed", statusAt: ago(0.5) })], raised, now: NOW });
  assert.match(held?.text || "", /they raised 20911 78th Ave W/);
});

test("Pass on the Tier 1 list closes the house they raised; a pass that named no house closes every house before it", () => {
  const raisedAt = ago(3);
  const named = raisedHouses({ events: [ev("house_mentioned", EDMONDS, { needsAddress: false }, raisedAt), ev("tier1_passed", EDMONDS, { by: "you" }, ago(1))], now: NOW });
  assert.deepEqual(named.map((h) => h.open), [false]);
  const unnamed = raisedHouses({ events: [ev("property_details", EDMONDS, { condition: "needs a lot of work" }, raisedAt), ev("tier1_kicked", "", { by: "you" }, ago(1))], now: NOW });
  assert.deepEqual(unnamed.map((h) => h.open), [false]);
  assert.equal(targetStage({ raised: unnamed, now: NOW }).to, "tier2");
});
