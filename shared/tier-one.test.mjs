import { test } from "node:test";
import assert from "node:assert/strict";
import { passedOnHouse, isTierOneAction, pickHouse, screenTierOne, cardMove, normalizeTierOne, autoKickPlan } from "./tier-one.js";
import { stageKeys } from "./ghl-stages.js";

const NOW = Date.parse("2026-10-07T18:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const A = "4430 Sunnyside Blvd, Marysville, WA 98270";

test("a house is passed when its newest offer says we passed or it's gone, not when a newer one is open", () => {
  assert.equal(passedOnHouse({ offers: [{ address: A, status: "we_passed", updatedAt: ago(2) }], address: "4430 Sunnyside Blvd" })?.why, "we passed on this house");
  assert.equal(passedOnHouse({ offers: [{ address: A, status: "unavailable", updatedAt: ago(2) }], address: A })?.why, "no longer available");
  assert.equal(passedOnHouse({ offers: [{ address: A, status: "we_passed", updatedAt: ago(9) }, { address: A, status: "sent", updatedAt: ago(1) }], address: A }), null);
  assert.equal(passedOnHouse({ offers: [{ address: A, status: "passed", updatedAt: ago(2) }], address: A }), null, "they passed is not us passing");
  assert.equal(passedOnHouse({ offers: [{ address: "12 Elm St, Kent, WA", status: "we_passed" }], address: A }), null, "another house");
});

test("a pass from the Tier 1 list counts with no offer row, until the house is added back", () => {
  const passed = { type: "tier1_passed", address: A, at: ago(3) };
  assert.ok(passedOnHouse({ events: [passed], address: A }));
  assert.ok(passedOnHouse({ events: [{ ...passed, type: "tier1_kicked" }], address: A }));
  assert.equal(passedOnHouse({ events: [passed, { type: "tier1_added", address: A, at: ago(1) }], address: A }), null);
  assert.equal(passedOnHouse({ events: [passed], address: "" }), null);
});

test("the tier-1 rule's actions are the tag, the TIER 1 workflow and the lower tiers it leaves", () => {
  assert.equal(isTierOneAction({ type: "add_tags", tags: ["tier-1"] }), true);
  assert.equal(isTierOneAction({ type: "remove_tags", tags: ["tier-2", "tier-3"] }), true);
  assert.equal(isTierOneAction({ type: "add_to_workflow", workflowName: "TIER 1" }), true);
  assert.equal(isTierOneAction({ type: "remove_from_workflow", workflowName: "Tier 2 nurture" }), true);
  assert.equal(isTierOneAction({ type: "add_tags", tags: ["tier-2"] }), false);
  assert.equal(isTierOneAction({ type: "start_underwrite" }), false);
  assert.equal(isTierOneAction({ type: "remove_tags", tags: ["tier-1"] }), false);
});

/* ---------- the Tier 1 screen ---------- */

const H = "13814 214th St E, Graham, WA 98338";
const house = (offer = {}) => ({ address: H, offer: { id: "o1", address: H, status: "sent", createdAt: ago(2), ...offer }, source: "offer" });
const keysOf = (flags) => flags.map((f) => f.key);

test("a clean house that needs work passes the screen", () => {
  const r = screenTierOne({ house: house(), assetType: "sfr", lastInboundAt: ago(1), now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.flags, []);
});

test("a house that went pending on Zillow, or left the market, is flagged gone", () => {
  assert.deepEqual(keysOf(screenTierOne({ house: house({ priceWatch: { status: "PENDING" } }), lastInboundAt: ago(1), now: NOW }).flags), ["gone"]);
  assert.deepEqual(keysOf(screenTierOne({ house: house({ priceWatch: { offMarketAt: ago(3) } }), lastInboundAt: ago(1), now: NOW }).flags), ["gone"]);
  assert.deepEqual(keysOf(screenTierOne({ house: house({ priceWatch: { offMarketAt: ago(3), backOnMarketAt: ago(1) } }), lastInboundAt: ago(1), now: NOW }).flags), [], "back on the market");
  const ev = [{ type: "listing_off_market", address: H, at: ago(2) }];
  assert.equal(screenTierOne({ house: house(), events: ev, lastInboundAt: ago(1), now: NOW }).flags[0].sure, true);
  const said = screenTierOne({ house: house(), saysGone: true, lastInboundAt: ago(1), now: NOW });
  assert.deepEqual(keysOf(said.flags), ["gone"]);
  assert.equal(said.flags[0].sure, false, "their words alone aren't sure");
});

test("a house they said isn't a flip is flagged; the text alone is a soft flag", () => {
  const named = [{ type: "subject_property_set", address: H, at: ago(1), data: { notOurKind: true } }];
  const sure = screenTierOne({ house: house(), events: named, lastInboundAt: ago(1), now: NOW });
  assert.deepEqual(keysOf(sure.flags), ["turnkey"]);
  assert.equal(sure.flags[0].sure, true);
  assert.equal(screenTierOne({ house: house(), saysTurnkey: true, lastInboundAt: ago(1), now: NOW }).flags[0].sure, false);
});

test("a townhouse, or a kind the underwrite held, is flagged not single-family", () => {
  assert.deepEqual(keysOf(screenTierOne({ house: house(), assetType: "multi_family", lastInboundAt: ago(1), now: NOW }).flags), ["not_sfr"]);
  assert.deepEqual(keysOf(screenTierOne({ house: house({ autoUnderwrite: { held: ["not our kind of house: TOWNHOUSE"] } }), lastInboundAt: ago(1), now: NOW }).flags), ["not_sfr"]);
});

test("a card with no street address is flagged no house", () => {
  assert.deepEqual(keysOf(screenTierOne({ house: null, now: NOW }).flags), ["no_house"]);
  assert.deepEqual(keysOf(screenTierOne({ house: { address: "Elm St", offer: null }, now: NOW }).flags), ["no_house"]);
});

test("a house we already passed on is flagged passed", () => {
  const r = screenTierOne({ house: house({ status: "we_passed" }), offers: [{ address: H, status: "we_passed", updatedAt: ago(1) }], lastInboundAt: ago(1), now: NOW });
  assert.ok(keysOf(r.flags).includes("passed"));
  assert.equal(r.ok, false);
});

test("three quiet weeks is stale but not a fail", () => {
  const r = screenTierOne({ house: house({ createdAt: ago(40) }), lastInboundAt: ago(30), now: NOW });
  assert.deepEqual(keysOf(r.flags), ["stale"]);
  assert.equal(r.ok, true);
});

test("the house is their open offer, or a newer house they named, or the card's own address", () => {
  const offers = [{ id: "a", address: H, status: "sent", createdAt: ago(5) }, { id: "b", address: "1 Old Rd, Kent, WA", status: "passed", createdAt: ago(9) }];
  assert.equal(pickHouse({ offers, now: NOW }).offer.id, "a");
  const named = [{ type: "subject_property_set", address: "88 Elm St, Tacoma, WA 98405", at: ago(1) }];
  const p = pickHouse({ offers, events: named, now: NOW });
  assert.equal(p.address, "88 Elm St, Tacoma, WA 98405");
  assert.equal(p.source, "named");
  assert.equal(pickHouse({ offers: [], cardName: "4430 Sunnyside Blvd", now: NOW }).source, "card");
  assert.equal(pickHouse({ offers: [], cardName: "Sam Lee", now: NOW }), null);
});

// Matt, 2026-10-16 (Toril S.): she named a Graham farmhouse after the
// turnkey house we'd turned down, and its underwrite held (no priced comps).
// The house's row was that held draft, which the pick never looked at, so a
// Pass from Tier 1 couldn't close it; and once Matt passed the turnkey house
// by hand, the card showed the turnkey house again: the pass made the old row
// look newer than the house in play.
test("the house in play is the one they named last, held draft and all; passing an older house doesn't make it newer", () => {
  const turnkey = { id: "t", address: "16910 132nd Ave E, Puyallup, WA 98374", status: "we_passed", createdAt: ago(10), statusAt: ago(0) };
  const held = { id: "g", address: "29308 158th Ave E, Graham, WA 98338", status: "draft", createdAt: ago(9) };
  const events = [{ type: "subject_property_set", address: "29308 158th Ave E, Graham, WA 98338", at: ago(7) }];
  const p = pickHouse({ offers: [turnkey, held], events, now: NOW });
  assert.equal(p.address, held.address);
  assert.equal(p.offer?.id, "g", "the held draft is the house's row, so Pass closes it");
  assert.equal(p.source, "held");
  // An open offer on the older house is still being worked: it stays the house.
  assert.equal(pickHouse({ offers: [{ ...turnkey, status: "countered" }, held], events, now: NOW }).offer.id, "t");
});

/* ---------- moving the card ---------- */

const ACQ = { id: "acq", stages: [
  { id: "s-new", name: "New Lead" }, { id: "s-t1", name: "Tier 1 - Hot/Actionable" }, { id: "s-t2", name: "Tier 2 - Warm" },
  { id: "s-t3", name: "Tier 3- Cold/Keep Warm" }, { id: "s-out", name: "Offer Out" }, { id: "s-neg", name: "Negotiations" },
  { id: "s-cs", name: "Contract Signed" }, { id: "s-pass", name: "Passed on Offer" }, { id: "s-bad", name: "Not a Good Deal" }, { id: "s-lost", name: "Lost" },
] };
const KEYS = stageKeys(ACQ);
const card = (stage, extra = {}) => ({ id: "op1", pipelineId: "acq", pipelineStageId: stage, status: "open", ...extra });

test("Pass moves a Tier 1 card to Passed on Offer, and never a contract or a contact with two open cards", () => {
  assert.deepEqual(cardMove({ cards: [card("s-t1")], acq: ACQ, keys: KEYS, to: "passed" }), { opportunityId: "op1", stageId: "s-pass", from: "Tier 1 - Hot/Actionable", to: "Passed on Offer" });
  assert.match(cardMove({ cards: [card("s-cs")], acq: ACQ, keys: KEYS, to: "passed" }).skip, /contract/);
  assert.match(cardMove({ cards: [card("s-t1"), card("s-t2", { id: "op2" })], acq: ACQ, keys: KEYS, to: "passed" }).skip, /two open cards/);
  assert.match(cardMove({ cards: [], acq: ACQ, keys: KEYS, to: "passed" }).skip, /no open card/);
});

test("Add reopens a passed or lost card to Tier 1 but leaves Offer Out alone", () => {
  assert.equal(cardMove({ cards: [card("s-pass")], acq: ACQ, keys: KEYS, to: "tier1" }).stageId, "s-t1");
  assert.deepEqual(cardMove({ cards: [card("s-lost", { status: "lost" })], acq: ACQ, keys: KEYS, to: "tier1" }).status, "open");
  assert.match(cardMove({ cards: [card("s-out")], acq: ACQ, keys: KEYS, to: "tier1" }).skip, /Offer Out/);
  assert.equal(cardMove({ cards: [], acq: ACQ, keys: KEYS, to: "tier1" }).create, true);
});

test("a sent offer moves a tier card to Offer Out, never Negotiations back", () => {
  assert.equal(cardMove({ cards: [card("s-t1")], acq: ACQ, keys: KEYS, to: "offerOut" }).stageId, "s-out");
  assert.match(cardMove({ cards: [card("s-neg")], acq: ACQ, keys: KEYS, to: "offerOut" }).skip, /Negotiations/);
  assert.match(cardMove({ cards: [card("s-out")], acq: ACQ, keys: KEYS, to: "offerOut" }).skip, /already/);
});

test("the switches ship off", () => {
  assert.deepEqual(normalizeTierOne(undefined), { autoKick: false, autoKickMax: 10, followMachineSends: false, autoUnderwrite: false, underwriteMax: 10 });
  assert.deepEqual(normalizeTierOne({ autoKick: "yes", autoKickMax: 500 }), { autoKick: false, autoKickMax: 50, followMachineSends: false, autoUnderwrite: false, underwriteMax: 10 });
});

test("only a sure miss is cleared on its own; a missing address waits a week, and a card you added is left a week", () => {
  const row = (flags, extra = {}) => ({ contactId: extra.contactId || "c", opportunityId: "op", ok: false, inStageSince: ago(2), flags, house: { address: H }, ...extra });
  const sure = (key) => ({ key, sure: true });
  const soft = (key) => ({ key, sure: false });
  const plan = autoKickPlan({ now: NOW, rows: [
    row([sure("gone")], { contactId: "gone" }),
    row([soft("gone")], { contactId: "words-only" }),
    row([soft("stale")], { contactId: "quiet", ok: true }),
    row([sure("no_house")], { contactId: "no-house-new" }),
    row([sure("no_house")], { contactId: "no-house-old", inStageSince: ago(9) }),
    row([sure("no_house")], { contactId: "no-house-chasing", inStageSince: ago(9), chasing: true }),
    row([sure("turnkey")], { contactId: "added", addedAt: ago(3) }),
    row([sure("not_sfr")], { contactId: "townhouse" }),
    // 2026-10-15: they said yes to our number — never cleared by the machine.
    row([sure("passed")], { contactId: "said-yes", saidYes: true }),
  ] });
  assert.deepEqual(plan.map((k) => [k.contactId, k.reason]), [["gone", "gone"], ["no-house-old", "no_house"], ["townhouse", "not_sfr"]]);
});

test("a house on two acres or more is flagged rural, sure enough to take off Tier 1", () => {
  const held = screenTierOne({ house: house({ autoUnderwrite: { held: ["rural — it sits on 5.2 acres (we buy houses on under 2 acres)"] } }), lastInboundAt: ago(1), now: NOW });
  assert.deepEqual(keysOf(held.flags), ["rural"]);
  assert.equal(held.flags[0].sure, true);
  assert.match(held.flags[0].why, /sits on 5\.2 acres/);
  const lot = screenTierOne({ house: house({ snapshot: { subjectInfo: { lotSqft: 3 * 43560 } } }), lastInboundAt: ago(1), now: NOW });
  assert.deepEqual(keysOf(lot.flags), ["rural"]);
  assert.deepEqual(keysOf(screenTierOne({ house: house({ snapshot: { subjectInfo: { lotSqft: 8000 } } }), lastInboundAt: ago(1), now: NOW }).flags), []);
});

/* ---------- Tier 1 → Draft (2026-10-13) ---------- */

const { autoUnderwritePlan } = await import("./tier-one.js");

test("a clean Tier 1 card with an address and nothing priced is underwritten by itself; one with a number, a held draft, no address or a flag waits", () => {
  const row = (contactId, over = {}) => ({ contactId, ok: true, offer: null, openCards: 1, house: { address: "12 Elm St, Tacoma, WA", source: "named" }, ...over });
  const plan = autoUnderwritePlan({ max: 5, rows: [
    row("go"),
    row("card", { house: { address: "88 Oak Ave", source: "card" } }),
    row("priced", { offer: { id: "o1", cashAmount: 300000 } }),
    row("held", { offer: { id: "o2", status: "draft" }, house: { address: "1 Pine St", source: "held" } }),
    row("nohouse", { house: null }),
    row("vague", { house: { address: "the one on Elm", source: "named" } }),
    row("flagged", { ok: false }),
    row("twocards", { openCards: 2 }),
  ] });
  assert.deepEqual(plan.map((p) => p.contactId), ["go", "card"]);
  assert.equal(autoUnderwritePlan({ max: 1, rows: [row("a"), row("b")] }).length, 1, "at most max");
  assert.equal(normalizeTierOne({ autoUnderwrite: true }).autoUnderwrite, true);
});

