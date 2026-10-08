// asset-type.test.mjs — what kind of house it is, and who wants that kind.

import test from "node:test";
import assert from "node:assert/strict";
import {
  assetFromHomeType, normalizeAsset, assetOf, assetPhrase, assetLabel, exclusionsSay, buyerTypeFit,
} from "./asset-type.js";

// 1510 Maple Lane's offer as it was on 2026-10-01: no type, Zillow's subject
// record saying MANUFACTURED.
const maple = { address: "1510 Maple Lane, Kent, Washington 98030",
  snapshot: { subjectInfo: { beds: 3, baths: 2, sqft: 1440, homeType: "MANUFACTURED", yearBuilt: 2026 } } };

test("a Zillow MANUFACTURED subject reads as a manufactured home", () => {
  assert.deepEqual(assetOf(maple), { type: "manufactured", land: "", by: "underwrite" });
  assert.equal(assetFromHomeType("SINGLE_FAMILY"), "sfr");
  assert.equal(assetFromHomeType("Multi-Family"), "multi_family");
  assert.equal(assetFromHomeType("Manufactured"), "manufactured");
  assert.equal(assetFromHomeType("CONDO"), "", "a condo is not guessed into a kind");
  assert.equal(assetOf({}), null);
});

test("what you picked on the offer beats what Zillow said", () => {
  const typed = { ...maple, asset: { type: "manufactured", land: "park", by: "you" } };
  assert.deepEqual(assetOf(typed), { type: "manufactured", land: "park", by: "you" });
  const sfr = { ...maple, asset: { type: "sfr", land: "park" } };
  assert.deepEqual(assetOf(sfr), { type: "sfr", land: "", by: "you" }, "only a mobile home has a land answer");
  assert.equal(normalizeAsset({ type: "castle" }), null);
});

test("the words a buyer reads, and a single family deal reads as nothing new", () => {
  assert.equal(assetPhrase({ type: "manufactured", land: "park" }), "mobile home in a park");
  assert.equal(assetPhrase({ type: "manufactured", land: "own_lot" }), "mobile home on its own lot");
  assert.equal(assetPhrase({ type: "manufactured" }), "mobile home");
  assert.equal(assetPhrase({ type: "multi_family" }), "multi-family");
  assert.equal(assetPhrase({ type: "sfr" }), "");
  assert.equal(assetLabel({ type: "manufactured", land: "park" }), "Manufactured / mobile · in a park");
});

test("exclusions are read clause by clause", () => {
  // The two live mobile-home buyers with exclusions, 2026-10-01.
  assert.deepEqual(exclusionsSay("no manufactured homes in parks, multi-family up to fourplex only"),
    { noMobile: false, noPark: true, mobileOnly: false });
  assert.deepEqual(exclusionsSay("manufactured homes only, under 450k, no site-built homes"),
    { noMobile: false, noPark: false, mobileOnly: true });
  assert.deepEqual(exclusionsSay("no mobile homes, no HOA"), { noMobile: true, noPark: false, mobileOnly: false });
  assert.deepEqual(exclusionsSay(""), { noMobile: false, noPark: false, mobileOnly: false });
});

test("a buyer who said no park homes is left off a park deal but not an own-lot deal", () => {
  // Mark, 2026-09-28: tagged mobile-home, buy box sfr + multi-family, "no
  // manufactured homes in parks". The tag says he wants one; the park says no.
  const mark = { markets: { types: ["mobile-home"] },
    buybox: { propertyTypes: ["sfr", "multi_family"], exclusions: "no manufactured homes in parks, multi-family up to fourplex only" } };
  const park = buyerTypeFit(mark, { type: "manufactured", land: "park" });
  assert.equal(park.refuses, true);
  assert.equal(park.reason, "said no park homes");
  const ownLot = buyerTypeFit(mark, { type: "manufactured", land: "own_lot" });
  assert.deepEqual(ownLot, { wants: true, refuses: false, reason: "buys mobile homes" });
});

test("a manufactured-homes-only buyer is left off a single family deal", () => {
  const only = { buybox: { propertyTypes: [], exclusions: "manufactured homes only, under 450k, no site-built homes" } };
  assert.equal(buyerTypeFit(only, { type: "sfr" }).refuses, true);
  assert.equal(buyerTypeFit(only, { type: "manufactured", land: "park" }).wants, true);
});

test("a flipper nobody asked about mobile homes neither wants nor refuses one; a documented house-only list refuses", () => {
  const flipper = { markets: { types: ["flip"] }, buybox: {} };
  assert.deepEqual(buyerTypeFit(flipper, { type: "manufactured", land: "park" }), { wants: false, refuses: false, reason: "" });
  const housesOnly = { markets: { types: ["flip"] }, buybox: { propertyTypes: ["sfr"] } };
  assert.equal(buyerTypeFit(housesOnly, { type: "manufactured" }).refuses, true);
  // On a house deal a list that leaves the kind out stays the buy box's -20,
  // not a refusal.
  assert.equal(buyerTypeFit({ buybox: { propertyTypes: ["condo"] } }, { type: "sfr" }).refuses, false);
  assert.deepEqual(buyerTypeFit(flipper, null), { wants: false, refuses: false, reason: "" });
});

test("a buy box that says manufactured wants one", () => {
  assert.equal(buyerTypeFit({ buybox: { propertyTypes: ["manufactured"] } }, { type: "manufactured" }).wants, true);
});

test("only single-family houses are underwritten on their own; everything else is held, and an untyped house goes ahead", async () => {
  const { kindHold, normalizeFocusKinds, KIND_HOLD } = await import("./asset-type.js");
  assert.equal(kindHold("SINGLE_FAMILY"), "");
  assert.equal(kindHold("MANUFACTURED"), "not our kind of house — a mobile home (single-family only right now)");
  assert.equal(kindHold("TOWNHOUSE"), "not our kind of house — a townhouse (single-family only right now)");
  assert.equal(kindHold("MULTI_FAMILY"), "not our kind of house — a multi-family (single-family only right now)");
  assert.equal(kindHold("CONDO"), "not our kind of house — a condo (single-family only right now)");
  assert.equal(kindHold(null), "", "Zillow didn't say");
  assert.ok(KIND_HOLD.test(kindHold("LOT")));
  // Multi-family is a kind an offer can carry; underwriting it is a setting away.
  assert.equal(kindHold("MULTI_FAMILY", ["sfr", "multi_family"]), "");
  assert.deepEqual(normalizeFocusKinds(undefined), ["sfr"]);
  assert.deepEqual(normalizeFocusKinds([]), ["sfr"]);
});

test("the agent bot is told we buy single-family houses only, and what to say about the rest", async () => {
  const { agentFocusRule } = await import("./asset-type.js");
  const r = agentFocusRule();
  assert.match(r, /single-family houses only/);
  assert.match(r, /condos, townhouses, mobile or manufactured homes, multi-family, land/);
  assert.match(agentFocusRule(["sfr", "multi_family"]), /single-family houses and multi-family \(2-4 units\) only/);
});

test("a house we chose to price anyway is named, so the bot talks numbers on it instead of saying single-family only", async () => {
  const { agentFocusRule } = await import("./asset-type.js");
  const r = agentFocusRule(["sfr"], { pricedAnyway: ["13348 32nd Ave S, Tukwila, WA 98168"] });
  assert.match(r, /single-family houses only/, "the rule still stands for every other house");
  assert.match(r, /13348 32nd Ave S/);
  assert.match(r, /talk numbers on it like any other house/);
  assert.equal(agentFocusRule(["sfr"], { pricedAnyway: [] }), agentFocusRule(["sfr"]), "nothing priced anyway, nothing added");
});

// Matt, 2026-10-08: rural is harder to comp and our buyers don't want it.
test("a house on two acres or more is rural; under two acres, or no lot on record, is not", async () => {
  const { isRuralLot, ruralHold, RURAL_HOLD } = await import("./asset-type.js");
  assert.equal(isRuralLot(2 * 43560), true, "two acres exactly is rural");
  assert.equal(isRuralLot(5 * 43560), true);
  assert.equal(isRuralLot(1.9 * 43560), false);
  assert.equal(isRuralLot(null), false, "no lot on record goes ahead");
  assert.equal(isRuralLot(""), false);
  assert.equal(ruralHold(7200), "");
  const why = ruralHold(226512);
  assert.ok(RURAL_HOLD.test(why), why);
  assert.match(why, /sits on 5\.2 acres \(we buy houses on under 2 acres\)/);
});

test("the agent bot is told we can't do rural houses on two acres or more", async () => {
  const { agentFocusRule } = await import("./asset-type.js");
  const rule = agentFocusRule(["sfr"]);
  assert.match(rule, /we don't buy rural houses — anything on 2 acres or more/);
  assert.match(rule, /say kindly that we can't do rural properties/);
});
