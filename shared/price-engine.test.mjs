// price-engine.test.mjs — the offer engine v2 prices once, honestly, and says how sure it is.

import test from "node:test";
import assert from "node:assert/strict";
import { priceHouse, triageOf, killersOf, normalizePricingV2, PRICING_V2_DEFAULTS } from "./price-engine.js";
import { rehabFloor, MIN_REHAB } from "./rehab-floor.js";
import { effectiveSettings } from "./offer-calc.js";
import { KC_FLIP_RATIOS } from "./kc-flip-ratios.js";

// A clean single-family read: Bricked sure, three renovated comps, a condition grade.
const BRICKED = { arv: 640000, arvConfidence: 0.9, asIs: 455000, condition: 3, comps: [
  { use: "arv", renovationScore: 0.86 }, { use: "arv", renovationScore: 0.8 }, { use: "arv", renovated: true }] };
const HOUSE = { list: 525000, sqft: 1500, yearBuilt: 1961, homeType: "SINGLE_FAMILY", lotSqft: 7200, zip: "98203", bricked: BRICKED };

test("every switch ships off, and a saved partial is filled, never trusted", () => {
  const d = normalizePricingV2(undefined);
  for (const k of ["shadow", "liveA", "walkaway", "reads", "autoCalibrate"]) assert.equal(d[k], false, k);
  assert.equal(d.maoPct, 70);
  assert.equal(d.minFee, 15000, "Matt, 2026-11-04: the least fee the machine may settle for");
  assert.equal(d.targetFee, 30000);
  assert.equal(normalizePricingV2({ maoPct: 99, shadow: "yes", minFee: 40000 }).maoPct, 70, "out of range reads as the default");
  assert.equal(normalizePricingV2({ shadow: "yes" }).shadow, false, "only a real true turns a switch on");
  assert.equal(normalizePricingV2({ minFee: 40000 }).minFee, 30000, "the minimum fee never tops the target");
  assert.equal(effectiveSettings({}).pricingV2.shadow, false);
  assert.equal(effectiveSettings({ pricingV2: { shadow: true } }).pricingV2.maoPct, PRICING_V2_DEFAULTS.maoPct);
});

test("a sure read prices at 70% of ARV less rehab, opens with the $30k fee and walks away at $15k", () => {
  const r = priceHouse(HOUSE);
  assert.equal(r.grade, "A", r.reasons.join(" | "));
  assert.equal(r.rehab, 82500, "1961 house: $55 a foot × 1,500");
  assert.equal(r.investorPrice, 0.7 * 640000 - 82500);
  assert.equal(r.walkAway, 350500, "investor price − $15k, to the nearest $250");
  assert.equal(r.open, 335500, "open is the walk-away less the fee room");
  assert.equal(r.walkAway - r.open, 15000);
  assert.equal(r.triage, "no_fit", "350.5k against a 525k list is 67%");
  assert.equal(r.spread, 0.668);
});

test("the walk-away never tops 90% of list", () => {
  const r = priceHouse({ ...HOUSE, list: 300000 });
  assert.equal(r.walkAway, 270000);
  assert.ok(r.open <= r.walkAway);
  assert.ok(r.reasons.some((x) => /capped at 90% of the 300k list/.test(x)));
});

test("two ARVs 12% apart are grade B, not quietly the lower", () => {
  const r = priceHouse({ ...HOUSE, comps: { arv: 571000, n: 5 } });
  assert.equal(r.grade, "B");
  assert.deepEqual(r.misses, ["arv"]);
  assert.ok(r.reasons.some((x) => /ARV reads disagree: Bricked 640k vs our comps 571k \(12% apart\)/.test(x)));
  const agree = priceHouse({ ...HOUSE, comps: { arv: 610000, n: 5 } });
  assert.equal(agree.grade, "A");
  assert.equal(agree.arv, 640000, "Bricked's ARV when they agree");
});

test("Bricked alone is sure only at 85% with three renovated comps", () => {
  assert.equal(priceHouse({ ...HOUSE, bricked: { ...BRICKED, arvConfidence: 0.8 } }).grade, "B");
  assert.equal(priceHouse({ ...HOUSE, bricked: { ...BRICKED, comps: BRICKED.comps.slice(0, 2) } }).grade, "B");
});

test("a house nobody described and nothing graded is not sure of its rehab", () => {
  const r = priceHouse({ ...HOUSE, bricked: { ...BRICKED, condition: null } });
  assert.deepEqual(r.misses, ["rehab"]);
  assert.equal(r.grade, "B");
  const both = priceHouse({ ...HOUSE, bricked: { ...BRICKED, condition: null, arvConfidence: 0.7 } });
  assert.equal(both.grade, "C", "two misses");
});

test("a 1924 house nobody described still carries $70 a foot", () => {
  const f = rehabFloor({ sqft: 1780, yearBuilt: 1924 });
  assert.equal(f.floor, 124500);
  assert.equal(f.tier, "age");
  assert.equal(rehabFloor({ sqft: 700, yearBuilt: 2005 }).floor, MIN_REHAB, "never under the 60k ballpark");
  assert.equal(rehabFloor({ sqft: 0 }).floor, MIN_REHAB, "no size: the ballpark");
});

test("fire damage in the remarks prices the heavy tier; a teardown, the gut tier", () => {
  assert.equal(rehabFloor({ sqft: 1500, yearBuilt: 1990, remarks: "Fire damaged, sold as-is" }).tier, "heavy");
  assert.equal(rehabFloor({ sqft: 1500, yearBuilt: 1990, remarks: "Fire damaged, sold as-is" }).floor, 150000);
  assert.equal(rehabFloor({ sqft: 1500, yearBuilt: 1990, remarks: "no water damage, new roof" }).tier, "age", "a denial isn't distress");
  assert.equal(rehabFloor({ sqft: 1500, yearBuilt: 1990, condition: 4.2 }).tier, "heavy", "Bricked grades it C4");
  assert.equal(rehabFloor({ sqft: 1500, yearBuilt: 1990, countyCondition: 2 }).tier, "heavy", "the county calls it fair");
  assert.equal(rehabFloor({ sqft: 1500, said: "honestly it needs to go down to the studs" }).tier, "gut");
});

test("their repair figure above ours replaces ours; below leaves ours", () => {
  assert.equal(priceHouse({ ...HOUSE, theirRepairs: 120000 }).rehab, 120000);
  assert.equal(priceHouse({ ...HOUSE, theirRepairs: 30000 }).rehab, 82500);
  const scoped = priceHouse({ ...HOUSE, scope: { total: 96000, photos: 24 } });
  assert.equal(scoped.rehab, 96000, "a photo scope over the floor is the evidence");
  assert.equal(priceHouse({ ...HOUSE, scope: { total: 96000, photos: 5 } }).rehab, 82500, "under 8 photos is no scope");
});

test("rural acreage, a park home, a short sale or someone else bidding is never grade A", () => {
  assert.equal(priceHouse({ ...HOUSE, lotSqft: 4.9 * 43560 }).grade, "C");
  assert.ok(priceHouse({ ...HOUSE, lotSqft: 4.9 * 43560 }).killers.includes("rural"));
  assert.ok(priceHouse({ ...HOUSE, remarks: "Lot rent is $954 a month" }).killers.includes("manufactured"));
  assert.ok(priceHouse({ ...HOUSE, said: "It's a short sale, bank approval needed" }).killers.includes("short_sale"));
  assert.equal(priceHouse({ ...HOUSE, said: "It's a short sale, bank approval needed" }).grade, "C");
  assert.deepEqual(killersOf({ said: "honestly the value is in the land" }), ["teardown"]);
});

test("a turnkey house is a pass, not a number", () => {
  const r = priceHouse({ ...HOUSE, bricked: { ...BRICKED, asIs: 600000 } });
  assert.equal(r.grade, "C");
  assert.equal(r.triage, "turnkey");
  assert.equal(priceHouse({ ...HOUSE, said: "It's fully remodeled, totally turnkey" }).triage, "turnkey");
});

test("triage measures the walk-away against their number, else the list", () => {
  assert.equal(triageOf({ walkAway: 475000, sellerNumber: 490000, list: 600000 }).triage, "hot");
  assert.equal(triageOf({ walkAway: 430000, sellerNumber: 490000 }).triage, "workable");
  assert.equal(triageOf({ walkAway: 360000, sellerNumber: 490000 }).triage, "long_shot");
  assert.equal(triageOf({ walkAway: 300000, sellerNumber: 490000 }).triage, "no_fit");
  assert.equal(triageOf({ walkAway: 300000, list: 400000 }).against, "the list price");
  assert.equal(triageOf({ walkAway: 300000 }).triage, "unknown");
});

test("a price over what flippers paid in a busy ZIP drops the grade; a quiet ZIP doesn't bind", () => {
  const ratios = { zips: { 98001: { n: 22, median: 0.6, p25: 0.55, p75: 0.62 }, 98010: { n: 4, median: 0.5, p25: 0.5, p75: 0.5 } } };
  const busy = priceHouse({ ...HOUSE, zip: "98001", list: 800000, bricked: { ...BRICKED, asIs: 400000 } }, {}, { ratios });
  assert.ok(!busy.misses.includes("zip"), "70% less 82.5k is 57% of ARV — under the ZIP's 62%, fine");
  // Lower the rehab so the price runs past what flippers paid there.
  const rich = priceHouse({ ...HOUSE, zip: "98001", list: 800000, sqft: 600 }, { maoPct: 75, minRehab: 20000 }, { ratios });
  assert.ok(rich.misses.includes("zip"), rich.reasons.join(" | "));
  const quiet = priceHouse({ ...HOUSE, zip: "98010", list: 800000, sqft: 600 }, { maoPct: 75, minRehab: 20000 }, { ratios });
  assert.ok(!quiet.misses.includes("zip"), "4 flips is not enough to bind");
  assert.ok(KC_FLIP_RATIOS.county.n > 500, "the committed King County table is there");
});

// The two deals with numbers to check against (2026-11-04 back-test).
test("a deal that closed prices within 5% under its contract", () => {
  // 23706 138th Dr SE, Snohomish: ARV 825k, 1,056 sqft, built 1971; contract 515k, closed.
  const r = priceHouse({ list: 0, sqft: 1056, yearBuilt: 1971, homeType: "SINGLE_FAMILY", bricked: { arv: 825000, arvConfidence: 0.9, condition: 3, comps: BRICKED.comps } });
  const miss = (r.walkAway - 515000) / 515000;
  assert.ok(miss <= 0 && miss >= -0.05, `walk-away ${r.walkAway} vs contract 515k (${Math.round(miss * 100)}%)`);
});

test("a gut job that died prices well under what we signed", () => {
  // 3831 Bagley Ave N: ARV 1.161M, 1,780 sqft, built 1924, "all lath and plaster"; signed at 740k, dead day 7.
  const r = priceHouse({ list: 0, sqft: 1780, yearBuilt: 1924, homeType: "SINGLE_FAMILY", said: "perhaps a tear down, it's all lath and plaster",
    bricked: { arv: 1161000, arvConfidence: 0.9, comps: BRICKED.comps } });
  assert.equal(r.rehabTier, "gut");
  assert.ok(r.walkAway <= 740000 * 0.9, `walk-away ${r.walkAway}`);
  assert.equal(r.grade, "C", "a teardown is never the machine's to send");
});

test("a rent read as the list price never caps the walk-away at a few thousand dollars", () => {
  const v = priceHouse({ list: 2900, sqft: 1220, yearBuilt: 1967, comps: { arv: 542000, n: 4 }, scope: { total: 67000, photos: 30 } }, {});
  assert.ok(v.walkAway > 200000, `walk-away ${v.walkAway}`);
  assert.equal(v.triage, "unknown", "nothing real to measure against");
  assert.ok(v.reasons.some((r) => /2,900 isn't a sale price/.test(r)), v.reasons.join(" | "));
});
