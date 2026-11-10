// needs-matt.test.mjs — what only Matt can do lands in GHL's "Needs Matt"
// stage, and nothing else does (shared/needs-matt.js, planCard's needsMatt).
//
// Matt, 2026-10-22, after the audit found an acceptance held 15 hours, three
// counters up to 46, and an agreed number sitting a week with nothing to tell
// him: "Instead of ping to me they land there."

import test from "node:test";
import assert from "node:assert/strict";
import { needsMattByContact, needsMattKind, needsMattPassDue, needsMattPassAt, engineOn, botTakesHouse, PRICE_WAIT_HOURS, PASS_AFTER_HOURS } from "./needs-matt.js";
import { planCard, stageKeys, stageKeyOf } from "./ghl-stages.js";
import { ownerOf } from "./hand-off.js";
import { buildPipeline } from "./pipeline.js";
import { normalizeConversationAi } from "./conversation-ai.js";

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

test("an acceptance the bot held for him lands there; a counter never does, the bot answers it", () => {
  // Matt, 2026-10-22: "Bot holds our number" — a counter is the machine's,
  // however long it has waited.
  const drafts = [
    { id: "d-ok", contactId: "bo", party: "agent", intent: "acceptance", createdAt: hoursAgo(15) },
    { id: "d-c1", contactId: "cy", party: "agent", intent: "counter", createdAt: hoursAgo(2) },
    { id: "d-c2", contactId: "di", party: "agent", intent: "counter", createdAt: hoursAgo(46) },
  ];
  const rows = drafts.map((d) => ({ id: `draft:${d.id}`, kind: "draft_waiting", draftId: d.id, contactId: d.contactId }));
  const m = needsMattByContact(rows, { drafts, now: NOW });
  assert.equal(m.get("bo")?.kind, "yes");
  assert.equal(m.has("cy"), false);
  assert.equal(m.has("di"), false);
});

test("their number on a house we never priced is a house to price, after the same day's wait", () => {
  // 2026-10-20: the seller "won't take less than 540k" on a house with no
  // offer of ours. Nothing for the bot to hold: it needs his number.
  const noOffer = { ok: false, name: "offer_live", detail: "no open offer" };
  const drafts = [
    { id: "d-n", contactId: "ed", party: "agent", intent: "counter", counterAmount: 540000, propertyAddress: "122 Oak St, Seattle, WA",
      createdAt: hoursAgo(PRICE_WAIT_HOURS + 2), exception: { kind: "counter_band", passed: false, checks: [noOffer] } },
    { id: "d-f", contactId: "fay", party: "agent", intent: "counter", counterAmount: 540000,
      createdAt: hoursAgo(3), exception: { kind: "counter_band", passed: false, checks: [noOffer] } },
  ];
  const rows = drafts.map((d) => ({ id: `draft:${d.id}`, kind: "draft_waiting", draftId: d.id, contactId: d.contactId }));
  const m = needsMattByContact(rows, { drafts, now: NOW });
  assert.equal(m.get("ed")?.kind, "price");
  assert.match(m.get("ed").why, /They named 540K on 122 Oak St: price it or pass/);
  assert.equal(m.has("fay"), false);
});

// The 2026-11-09 audit: a far counter on a house we'd priced and never sent
// drew our "too far apart" goodbye. The reply now waits (unsentCounter), and
// the decision is his: float our number, or pass.
test("their number against ours that never went out is a price card, after the same day's wait", () => {
  const d = (id, contactId, hours) => ({ id, contactId, party: "agent", intent: "counter", counterAmount: 755000, propertyAddress: "12 Elm St, Kent, WA",
    createdAt: hoursAgo(hours), unsentCounter: { offerId: `o-${contactId}`, theirs: 755000, ours: 300000 } });
  const drafts = [d("d-u", "uma", PRICE_WAIT_HOURS + 1), d("d-v", "val", 2)];
  const rows = drafts.map((x) => ({ id: `draft:${x.id}`, kind: "draft_waiting", draftId: x.id, contactId: x.contactId, offerId: x.unsentCounter.offerId }));
  const m = needsMattByContact(rows, { drafts, now: NOW });
  assert.equal(m.get("uma")?.kind, "price");
  assert.match(m.get("uma").why, /They named 755K on 12 Elm St, over our 300K that never went out: float ours or pass/);
  assert.equal(m.has("val"), false, "not before the day's wait");
});

// Matt, 2026-11-09 (Mary S., 195 SE Roosevelt): the audit redrafted her one
// price-drop text every couple of days. Each redraft was a new
// draft with a new clock, so the card left Needs Matt for Offer Out at the
// next 7am sweep and came back a day later — three round trips on one text.
test("a redraft of the same text keeps the wait it had, so the card doesn't leave Needs Matt and come back", () => {
  const noOffer = { ok: false, name: "offer_live", detail: "no open offer" };
  const redraft = { id: "d-r2", contactId: "mo", party: "agent", intent: "counter", counterAmount: 899000, propertyAddress: "195 SE Roosevelt Ave, Bend, OR",
    createdAt: hoursAgo(2), waitingSince: hoursAgo(PRICE_WAIT_HOURS + 30), exception: { kind: "counter_band", passed: false, checks: [noOffer] } };
  const row = { id: "draft_waiting:o-mo", kind: "draft_waiting", draftId: redraft.id, contactId: "mo", offerId: "o-mo" };
  const need = needsMattByContact([row], { drafts: [redraft], now: NOW }).get("mo");
  assert.equal(need?.kind, "price", "still his to price: the text has waited more than a day");
  assert.equal(need.at, redraft.waitingSince, "the wait runs from the first draft of the text, not the redraft");
});

test("a number an agent names on a house we walked away from doesn't land in Needs Matt", () => {
  const noOffer = { ok: false, name: "offer_live", detail: "no open offer" };
  const d = { id: "d-ed", contactId: "ek", party: "agent", intent: "counter", counterAmount: 595000, propertyAddress: "624 NW Hill St, Bend, OR",
    createdAt: hoursAgo(PRICE_WAIT_HOURS + 5), exception: { kind: "counter_band", passed: false, checks: [noOffer] } };
  const row = { id: "draft_waiting:o-ek", kind: "draft_waiting", draftId: d.id, contactId: "ek", offerId: "o-ek" };
  assert.equal(needsMattByContact([row], { drafts: [d], now: NOW }).get("ek")?.kind, "price", "on a house we never priced or passed, it's his");
  const m = needsMattByContact([row], { drafts: [d], now: NOW, walkedAway: new Set(["o-ek"]) });
  assert.equal(m.has("ek"), false, "we passed on it: our pass is the answer, the card stays where the offers put it");
});

test("a house still unpriced three days after it landed is the bot's to pass", () => {
  const need = (h, over = {}) => ({ kind: "price", offerId: "o-kay", at: hoursAgo(24 * 9), landedAt: hoursAgo(h), ...over });
  assert.equal(needsMattPassDue(need(PASS_AFTER_HOURS - 1), NOW), false);
  assert.equal(needsMattPassDue(need(PASS_AFTER_HOURS + 1), NOW), true);
  // The stage's first day (2026-10-22): a week-old house had never been seen.
  assert.equal(needsMattPassDue(need(0, { landedAt: null }), NOW), false, "never landed: never passed");
  assert.equal(needsMattPassDue(need(24 * 9, { kind: "yes" }), NOW), false, "a yes is never passed by the machine");
  assert.equal(needsMattPassDue(need(24 * 9, { offerId: null }), NOW), false, "nothing to mark without a row");
});

/* ---------- the pass clock (Matt, 2026-11-10) ---------- */
// The 72-hour clock passed 43 houses unpriced in 16 days, 18 of them over a weekend, and houses
// the engine had priced went with the rest. Now it counts working days, and leaves those alone.

test("a house the engine priced at grade A or B is never passed by the clock, however long it waits", () => {
  const need = (over = {}) => ({ kind: "price", offerId: "o-kay", landedAt: hoursAgo(24 * 9), ...over });
  assert.equal(needsMattPassDue(need(), NOW), true, "no engine number: passed, as before");
  assert.equal(needsMattPassDue(need({ engine: { grade: "A", open: 301000, walkAway: 316000 } }), NOW), false, "grade A");
  assert.equal(needsMattPassDue(need({ engine: { grade: "B", open: 238000, walkAway: 253000 } }), NOW), false, "grade B");
  assert.equal(needsMattPassDue(need({ engine: { grade: "B", open: 0, walkAway: 0 } }), NOW), true, "an engine read with no number is no number");
  assert.equal(needsMattPassAt(need({ engine: { grade: "A", open: 300000 } })), null, "and it has no pass date");
});

// A grade-C number is a house the machine shouldn't buy as it stands (a manufactured home, a short
// sale, a turnkey): it must not sit on Needs Matt for good (Matt's buy box, 2026-11-10).
test("a grade-C house the engine priced still passes after three working days", () => {
  const c = { grade: "C", open: 0, walkAway: 181000 };
  const need = { kind: "price", offerId: "o-cee", landedAt: "2026-10-19T17:00:00Z", engine: c }; // Monday 10am Pacific
  assert.equal(needsMattPassDue(need, Date.parse("2026-10-22T16:00:00Z")), false, "Thursday 9am: 71 working hours");
  assert.equal(needsMattPassDue(need, Date.parse("2026-10-22T17:00:00Z")), true, "Thursday 10am: three working days, like an unpriced house");
  assert.equal(needsMattPassAt(need), "2026-10-22T17:00:00.000Z");
  assert.equal(needsMattPassDue({ ...need, engine: { grade: "B", open: 0, walkAway: 253000 } }, Date.parse("2026-10-30T17:00:00Z")), false, "the same house at grade B waits for Matt");
});

test("the pass clock counts working days: a house that landed Friday morning isn't passed before Wednesday morning", () => {
  const landed = Date.parse("2026-10-16T17:00:00Z"); // Friday 10am Pacific
  const need = { kind: "price", offerId: "o-fri", landedAt: new Date(landed).toISOString() };
  assert.equal(needsMattPassDue(need, Date.parse("2026-10-19T18:00:00Z")), false, "Monday 11am: 72 clock hours, 25 working ones");
  assert.equal(needsMattPassDue(need, Date.parse("2026-10-21T16:00:00Z")), false, "Wednesday 9am: 71 working hours");
  assert.equal(needsMattPassDue(need, Date.parse("2026-10-21T17:00:00Z")), true, "Wednesday 10am: three working days");
  assert.equal(needsMattPassAt(need), "2026-10-21T17:00:00.000Z");
});

test("a day off doesn't count on the pass clock either", () => {
  const need = { kind: "price", offerId: "o-mon", landedAt: "2026-10-19T17:00:00Z" }; // Monday 10am Pacific
  const offDays = ["2026-10-21"]; // the Wednesday
  assert.equal(needsMattPassDue(need, Date.parse("2026-10-22T17:00:00Z")), true, "Thursday 10am without it");
  assert.equal(needsMattPassDue(need, Date.parse("2026-10-22T17:00:00Z"), { offDays }), false, "48 working hours with it");
  assert.equal(needsMattPassDue(need, Date.parse("2026-10-23T17:00:00Z"), { offDays }), true, "Friday 10am");
  assert.equal(needsMattPassAt(need, { offDays }), "2026-10-23T17:00:00.000Z");
});

test("a price card names the engine's number when the engine priced the house", () => {
  const row = { id: "price_it:o-lu", kind: "price_it", contactId: "lu", offerId: "o-lu", address: "12 Alder Ct, Kent, WA", readyAt: hoursAgo(50) };
  const engineByOffer = new Map([["o-lu", { grade: "B", open: 238000, walkAway: 253000 }]]);
  const m = needsMattByContact([row], { now: NOW, engineByOffer }).get("lu");
  assert.equal(m.kind, "price");
  assert.deepEqual(m.engine, { grade: "B", open: 238000, walkAway: 253000 }, "carried on the card, so the clock leaves it");
  assert.equal(m.why, "Price it on 12 Alder Ct: the engine has 238K (grade B) on the draft; the agent has waited 2 days");
  const plain = needsMattByContact([row], { now: NOW }).get("lu");
  assert.equal(plain.engine, undefined);
  assert.equal(plain.why, "Price it on 12 Alder Ct: the agent has waited 2 days for our number");
  assert.deepEqual(engineOn({ offer: { draft: { engine: { grade: "A", open: 301000, walkAway: 316000 } } } }), { grade: "A", open: 301000, walkAway: 316000 });
  assert.deepEqual(engineOn({ record: { v2: { grade: "C", open: 0, walkAway: 181000 } } }), { grade: "C", open: 0, walkAway: 181000 });
  assert.equal(engineOn({ offer: { draft: {} }, record: { v2: { grade: "C", arv: 0 } } }), null);
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

// Matt, 2026-10-22: "this stage should be used sparingly and only for the
// things that the bot was not able to handle." Of the first 14 cards, the
// agent had called three houses cosmetic, and two were rentals with no house
// number: none of those is his to price.
test("a house the agent called cosmetic or turnkey is the bot's to pass, not his to price", () => {
  const draft = (message, over = {}) => ({ id: "o1", address: "3606 220th Pl SW, Mountlake Terrace, WA 98043", status: "draft", autoUnderwrite: { message }, ...over });
  assert.deepEqual(botTakesHouse(draft("Mostly cosmetic"))?.pass, "turnkey");
  assert.equal(botTakesHouse(draft("Not much. From what i saw.. it is some basic touch ups to paint."))?.pass, "turnkey");
  assert.equal(botTakesHouse(draft("It's been fully remodeled, move-in ready"))?.pass, "turnkey");
  assert.equal(botTakesHouse(draft("It is an estate. Condition is not great")), null, "real trouble is his to price");
  assert.equal(botTakesHouse(draft("The roof, siding, paint, plumbing, deck, HVAC are newer. Most windows are older")), null, "big-ticket items named: his look");
  assert.equal(botTakesHouse(draft("Mostly cosmetic", { offMarket: { value: true, at: hoursAgo(5), by: "you" } })), null, "off-market is always his");
});

test("a house with no house number is the bot's to chase, not his to price", () => {
  assert.equal(botTakesHouse({ id: "o2", address: "125th Ave SE", status: "draft", autoUnderwrite: { message: "no it's selling" } })?.chase, true);
  assert.equal(botTakesHouse({ id: "o3", address: "10863 Roseberg Ave S, Seattle, WA 98168", status: "draft", autoUnderwrite: { message: "" } }), null);
  // "796 SE Briarwood Ct" in their text, "Briarwood Ct" on the draft: they
  // gave us the number, so there's nothing to chase. It's his to price.
  assert.equal(botTakesHouse({ id: "o4", address: "Briarwood Ct", status: "draft", autoUnderwrite: { message: "No problem. 796 SE Briarwood Ct" } }), null);
});

// 2026-10-22, the stage's first hour: Jeff D. (an answer we owe on 10863
// Roseberg) stayed in Tier 2 because his card had been dragged there days
// after the promise began. A drag before the need landed is not a drag away
// from it; one after it landed is his call.
test("an old drag doesn't keep a card out of Needs Matt; a drag after it landed does", () => {
  const owed = { kind: "paper", why: "we owe them an answer on 10863 Roseberg", at: hoursAgo(24 * 5), key: "k-jeff" };
  const before = card("jeff", "s-t2", { lastStageChangeAt: hoursAgo(24 * 2) });
  const r = planCard({ acq: ACQ, cards: [before], offers: [], contactId: "jeff", needsMatt: { ...owed, landedAt: hoursAgo(1) }, now: NOW });
  assert.equal(r.move?.to, "Needs Matt", JSON.stringify(r));
  const after = card("jeff", "s-t2", { lastStageChangeAt: hoursAgo(0.5) });
  assert.ok(planCard({ acq: ACQ, cards: [after], offers: [], contactId: "jeff", needsMatt: { ...owed, landedAt: hoursAgo(1) }, now: NOW }).youMoved);
});

/* ---------- an agent's yes, an ask for paper (2026-11-09 audit) ---------- */

// The audit found 45 contacts with a held reply and their text unanswered: a
// seller at our own number quoting our terms back, a Saturday "what do you
// want me to write up", proof of funds asked on our offer. Each was a held
// draft the stage never saw, so the texts closest to a contract waited on
// nobody. The houses, numbers and words below are made up.
const OURS = 512400;
const STREET = "418 Quillfeather Ln";
const house = (over = {}) => ({ id: "o-qf", contactId: "qa", contactName: "Agent", address: `${STREET}, Renton, WA`, cashAmount: OURS,
  status: "sent", statusAt: hoursAgo(24 * 6), createdAt: hoursAgo(24 * 8), sends: [{ ts: hoursAgo(24 * 6) }], ...over });
const held = (inbound, over = {}) => ({ id: "d-qa", contactId: "qa", party: "agent", status: "draft", intent: "other", inbound,
  propertyAddress: `${STREET}, Renton, WA`, createdAt: hoursAgo(1), ...over });
const waiting = (d, offerId = "o-qf") => ({ id: `draft_waiting:${offerId}`, kind: "draft_waiting", draftId: d.id, contactId: d.contactId, offerId, address: d.propertyAddress });
const needFor = (d, offers = [house()]) =>
  needsMattByContact([waiting(d, offers[0]?.id)], { drafts: [d], offersById: new Map(offers.map((o) => [o.id, o])), now: NOW }).get(d.contactId);
const TERMS = "Seller signed off at 512,400 cash. 5k EMD, 10 day inspection, close in 21 days, buyer name and/or assigns. What email should the paperwork go to?";

test("an agent who asks what we want her to write up lands in Needs Matt as a yes", () => {
  for (const words of [
    "Showing wraps at 3. Let me know what you want me to write up",
    "What do you want me to write up?",
    "Would you like me to put the offer together tonight?",
    "Happy to send the offer over to sign once you confirm",
    "Who should I make the offer out to?",
  ]) {
    const need = needFor(held(words));
    assert.equal(need?.kind, "yes", words);
    assert.equal(need.why, `They're writing it up on ${STREET}: send the terms`, words);
  }
  // The model's own read on the draft counts too.
  assert.equal(needFor(held("Sounds good, talk soon", { dealSignal: "writing_up" }))?.kind, "yes");
  // A no is a no, however it's worded.
  assert.equal(needFor(held("I won't write it up at that number")), undefined);
});

test("an agent who says she'll present it to the seller is still the bot's, not a yes", () => {
  assert.equal(needFor(held("Thanks, I'll present it to the seller tonight and get back to you")), undefined);
  assert.equal(needFor(held("I'll present your 512,400 to the seller tonight")), undefined, "our number alone is not our terms");
});

test("an agent asking for proof of funds on our offer lands in Needs Matt the same hour", () => {
  const d = held("Can you send a bank letter with it?", { intent: "proof_of_funds", createdAt: hoursAgo(0.2) });
  const need = needFor(d);
  assert.equal(need?.kind, "paper");
  assert.equal(need.why, `They asked for proof of funds on ${STREET}`);
  // The terms of the paper, on an offer of ours that went out: also his.
  for (const words of ["What earnest amount and how many inspection days?", "What LLC name goes on it?", "Send it signed and I'll take it from there", "I need a buyer agency form before I write anything"]) {
    const n = needFor(held(words));
    assert.equal(n?.kind, "paper", words);
    assert.equal(n.why, `They asked about the paper on ${STREET}: send the terms`, words);
  }
  // The same words with nothing of ours out on the house are the bot's.
  assert.equal(needFor(held("What earnest amount and how many inspection days?"), [house({ status: "draft", sends: [] })]), undefined);
  // And a counter stays on the counter hold.
  assert.equal(needFor(held("Seller would do 540 with a 10 day inspection", { intent: "counter", counterAmount: 540000 })), undefined);
});

// Review, 2026-11-09: a counter that names our number on the way to theirs
// read as our terms quoted back, and talk about the house read as an ask
// for the paper. Made-up words.
test("a counter at their own number that mentions ours and an inspection stays on the counter hold", () => {
  const counter = held("Thanks for the 512,400. Seller would do 540,000 with a 10 day inspection", { intent: "counter", counterAmount: 540000 });
  assert.equal(needFor(counter), undefined);
  const offersById = new Map([[house().id, house()]]);
  assert.equal(ownerOf(waiting(counter), { draftsById: new Map([[counter.id, counter]]), offersById }), "machine");
  // A "counter" at our own number with our terms is their yes.
  assert.equal(needFor(held(TERMS, { intent: "counter", counterAmount: OURS }))?.kind, "yes");
});

test("talk about the house that isn't an ask for the paper stays the bot's", () => {
  for (const words of [
    "Pre-inspection report is attached, roof is about 12 years old.",
    "Updates were made to the kitchen in 2019.",
    "MLS ID 4417203 if you want the photos",
    "Thanks! Northbay Realty Group LLC",
    "I'll send the inspection report over tonight",
  ]) assert.equal(needFor(held(words)), undefined, words);
});

test("a buyer's proof of funds ask stays on Deals", () => {
  const d = held("Do you need proof of funds from me before the walkthrough?", { party: "investor", intent: "proof_of_funds" });
  assert.equal(needFor(d), undefined);
  assert.equal(ownerOf(waiting(d), { draftsById: new Map([[d.id, d]]) }), "machine");
});

test("a held yes, a write-up and a proof of funds ask ping Matt, not the machine", () => {
  const offersById = new Map([[house().id, house()]]);
  const own = (d) => ownerOf(waiting(d), { draftsById: new Map([[d.id, d]]), offersById });
  assert.equal(own(held("What do you want me to write up?")), "ping");
  assert.equal(own(held("Can you send a bank letter with it?", { intent: "proof_of_funds" })), "ping");
  assert.equal(own(held("What earnest amount works?")), "ping");
  assert.equal(own(held(TERMS)), "ping");
  assert.equal(own(held("Thanks, I'll present it to the seller tonight")), "machine");
});

// Through the pipeline read, the way the runner sees it.
const CFG = normalizeConversationAi({ enabled: true });
const needsFrom = ({ offers = [], drafts = [], sentDrafts = [], recentDrafts = [], events = [] }) => {
  const read = buildPipeline({ offers, drafts, sentDrafts, recentDrafts, events, config: CFG, now: NOW });
  return needsMattByContact(read.actions, { drafts, offersById: new Map(offers.map((o) => [o.id, o])), now: NOW });
};
// One house, three rows: our pass on top, two dead copies under it.
const passedHouse = () => [
  house({ id: "o-qf1", status: "we_passed", statusAt: hoursAgo(24 * 3), passReason: { code: "quiet", at: hoursAgo(24 * 3), by: "needs-matt" } }),
  house({ id: "o-qf2", status: "no_response", statusAt: hoursAgo(24 * 9), createdAt: hoursAgo(24 * 12) }),
  house({ id: "o-qf3", status: "passed", statusAt: hoursAgo(24 * 10), createdAt: hoursAgo(24 * 13) }),
];

test("an agent who quotes our terms back and asks for our email lands in Needs Matt as a yes even when the house row says passed", () => {
  const offers = passedHouse();
  const why = `They quoted our terms back on ${STREET}: confirm and send the email`;
  // Held for him.
  const d = held(TERMS, { intent: "acceptance", createdAt: hoursAgo(5) });
  let need = needsFrom({ offers, drafts: [d] }).get("qa");
  assert.equal(need?.kind, "yes");
  // Acceptance on its own already lands; the why says what to do now.
  assert.equal(need.why, why);
  // The bot answered it ("calling you shortly") and nobody did: still his.
  const machineSent = { ...d, intent: "other", status: "sent", autoSent: true, sentAt: hoursAgo(4.9) };
  need = needsFrom({ offers, sentDrafts: [machineSent], recentDrafts: [machineSent] }).get("qa");
  assert.equal(need?.kind, "yes", "the machine's reply doesn't settle their yes");
  assert.equal(need.why, why);
  // Their next text superseded it: still his.
  const superseded = { ...d, intent: "other", status: "superseded" };
  assert.equal(needsFrom({ offers, recentDrafts: [superseded] }).get("qa")?.kind, "yes");
  // Our 72-hour pass after their yes doesn't settle it either.
  const lateMachinePass = passedHouse().map((o, i) => (i ? o : { ...o, statusAt: hoursAgo(1), passReason: { code: "quiet", at: hoursAgo(1), by: "needs-matt" } }));
  assert.equal(needsFrom({ offers: lateMachinePass, recentDrafts: [superseded] }).get("qa")?.kind, "yes");
  // Until a person acts: sent it, binned it, texted them, or marked the house.
  assert.equal(needsFrom({ offers, sentDrafts: [{ ...machineSent, autoSent: false }], recentDrafts: [{ ...machineSent, autoSent: false }] }).get("qa"), undefined, "you sent the reply");
  assert.equal(needsFrom({ offers, recentDrafts: [{ ...d, status: "dismissed", dismissedBy: "you" }] }).get("qa"), undefined, "you binned it");
  assert.equal(needsFrom({ offers, recentDrafts: [superseded], events: [{ type: "hand_reply", contactId: "qa", at: hoursAgo(2) }] }).get("qa"), undefined, "you texted them yourself");
  const yourPass = passedHouse().map((o, i) => (i ? o : { ...o, statusAt: hoursAgo(1), passReason: { code: "no_fit", at: hoursAgo(1), by: "operator" } }));
  assert.equal(needsFrom({ offers: yourPass, recentDrafts: [superseded] }).get("qa"), undefined, "you passed on it after their yes");
  // An old yes is history.
  assert.equal(needsFrom({ offers, recentDrafts: [{ ...superseded, createdAt: hoursAgo(24 * 20) }] }).get("qa"), undefined);
});

test("a seller's terms on an agreed price land in Needs Matt even when the bot promised a call", () => {
  const offers = [house({ status: "countered", statusAt: hoursAgo(40) })];
  const sent = { id: "s-call", contactId: "qa", party: "agent", status: "sent", autoSent: true, intent: "acceptance", inbound: TERMS,
    reply: "Great, calling you shortly", propertyAddress: `${STREET}, Renton, WA`, createdAt: hoursAgo(30), sentAt: hoursAgo(30) };
  const events = [{ type: "promise_made", contactId: "qa", at: hoursAgo(30), address: `${STREET}, Renton, WA`, data: { what: "call", text: "Great, calling you shortly", draftId: "s-call" } }];
  const need = needsFrom({ offers, sentDrafts: [sent], recentDrafts: [sent], events }).get("qa");
  assert.equal(need?.kind, "paper", "not a call to fit in: the terms are his to send");
  assert.equal(need.why, `They sent terms on ${STREET} and we said we'd call: call them or send the terms`);
  // A call we owe about something else stays a call.
  const chat = { ...sent, inbound: "Free after 4 if you want to talk" };
  assert.equal(needsFrom({ offers, sentDrafts: [chat], recentDrafts: [chat], events }).get("qa"), undefined);
});
