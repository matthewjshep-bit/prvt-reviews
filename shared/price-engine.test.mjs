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
  // Before 2026-11-09 a scope from under 8 photos was dropped (82.5k here). It now raises the rehab
  // when it reads above the floor, but is not evidence (see the thin-scope test below).
  assert.equal(priceHouse({ ...HOUSE, scope: { total: 96000, photos: 5 } }).rehab, 96000, "under 8 photos still raises the rehab");
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

/* ---------- Matt's seller cap and what the engine can't know (audit, 2026-11-09) ---------- */

// An invented house: Bricked sure at 850k, a 1961 house of 1,500 sqft (82.5k floor), listed at 520k.
const RICH = { ...HOUSE, list: 520000, bricked: { ...BRICKED, arv: 850000 } };

test("the machine never opens above the seller's own number", () => {
  const r = priceHouse({ ...RICH, sellerNumber: 450000 });
  assert.ok(r.open <= 450000, `open ${r.open}`);
  assert.ok(r.walkAway <= 450000, `walk-away ${r.walkAway}`);
  // Under the 10% line it is only a cap: their number is the most we'd go, and the grade holds.
  const near = priceHouse({ ...RICH, sellerNumber: 460000 });
  assert.equal(near.walkAway, 460000, "497.5k uncapped, down to their 460k");
  assert.equal(near.open, 460000, "offering exactly their number leaves no room: Matt's rule");
  assert.equal(near.grade, "A", near.reasons.join(" | "));
  assert.ok(near.reasons.some((x) => /capped at their 460k/.test(x)), near.reasons.join(" | "));
  assert.equal(priceHouse({ ...RICH, sellerNumber: 461100 }).walkAway, 461000, "their number, down to the $250");
  assert.equal(priceHouse(RICH).walkAway, 468000, "no number from them: the list cap as before");
});

test("a walk-away more than 10% over the seller's number holds for Matt as a likely ARV error, not a hot house", () => {
  // Off-market, ARV 700k, seller at 300k: the uncapped walk-away is 392.5k, 31% over theirs.
  const reads = { ...HOUSE, list: 0, bricked: { ...BRICKED, arv: 700000 }, sellerNumber: 300000 };
  const r = priceHouse(reads);
  assert.equal(r.triage, "over_theirs", "never 'hot'");
  assert.equal(r.overTheirs, true);
  assert.ok(r.misses.includes("arv"));
  assert.notEqual(r.grade, "A");
  assert.ok(r.reasons.some((x) => /our walk-away is 31% over their number: the ARV is likely high/.test(x)), r.reasons.join(" | "));
  assert.equal(r.walkAway, 300000, "and it never offers past their number either");
  assert.equal(r.open, 300000);
  // 7.5% over is inside the line: capped at theirs, graded as usual.
  const close = priceHouse({ ...reads, sellerNumber: 365000 });
  assert.equal(close.triage, "hot");
  assert.equal(close.grade, "A");
  assert.equal(close.walkAway, 365000);
  // The line is a setting: 0 holds any amount over, 50 lets 31% through to the cap.
  assert.equal(priceHouse({ ...reads, sellerNumber: 365000 }, { overSellerPct: 0 }).triage, "over_theirs");
  assert.equal(priceHouse(reads, { overSellerPct: 50 }).triage, "hot");
});

test("the seller's-number line is a setting: 10% by default, 0 to 50", () => {
  assert.equal(normalizePricingV2(undefined).overSellerPct, 10);
  assert.equal(normalizePricingV2({ overSellerPct: 0 }).overSellerPct, 0, "0 = any amount over holds");
  assert.equal(normalizePricingV2({ overSellerPct: "25" }).overSellerPct, 25);
  assert.equal(normalizePricingV2({ overSellerPct: 60 }).overSellerPct, 10, "out of range reads as the default");
  assert.equal(effectiveSettings({}).pricingV2.overSellerPct, 10);
});

test("a number over the list price is not a steal, it holds", () => {
  // 70% of 640k less 82.5k less the 15k fee is 350.5k, over a 300k list: the comps or the scope are off.
  const r = priceHouse({ ...HOUSE, list: 300000 });
  assert.equal(r.overList, true);
  assert.ok(r.misses.includes("arv"));
  assert.notEqual(r.grade, "A");
  assert.ok(r.reasons.some((x) => /came out above the \$300,000 list price: the comps or the scope are off, so a person should look before it goes anywhere/.test(x)), r.reasons.join(" | "));
  assert.equal(r.walkAway, 270000, "still never past 90% of the list");
  // Between 90% and 100% of the list it is only the cap, as it was.
  const capped = priceHouse({ ...HOUSE, list: 375000 });
  assert.equal(capped.overList, false);
  assert.equal(capped.walkAway, 337500);
  assert.equal(capped.grade, "A", capped.reasons.join(" | "));
});

test("an unfinished new build is not a flip", () => {
  assert.ok(killersOf({ yearBuilt: 2025, currentYear: 2026 }).includes("new_build"), "built in the last two years");
  assert.ok(!killersOf({ yearBuilt: 2023, currentYear: 2026 }).includes("new_build"));
  assert.ok(!killersOf({ yearBuilt: 2025 }).includes("new_build"), "no clock: the year alone can't say");
  for (const words of ["the builder walked away at about 80% complete", "it's new construction", "still under construction",
    "an unfinished new build", "framing is 70% done", "the builder went under last spring"]) {
    assert.ok(killersOf({ said: words }).includes("new_build"), words);
  }
  for (const words of ["unfinished basement", "new construction windows throughout", "100% complete remodel"]) {
    assert.ok(!killersOf({ remarks: words }).includes("new_build"), words);
  }
  const r = priceHouse({ ...HOUSE, yearBuilt: 2025, currentYear: 2026 });
  assert.equal(r.grade, "C");
  assert.ok(r.killers.includes("new_build"));
});

test("a house Zillow didn't type never sends itself", () => {
  const r = priceHouse({ ...HOUSE, homeType: "" });
  assert.ok(r.misses.includes("kind"));
  assert.notEqual(r.grade, "A");
  assert.ok(r.reasons.some((x) => /Zillow didn't say what kind of house this is/.test(x)), r.reasons.join(" | "));
});

test("an agent's repair figure at or under the floor is not rehab evidence", () => {
  const plain = { ...HOUSE, bricked: { ...BRICKED, condition: null } }; // nothing else says how rough it is
  for (const theirs of [82500, 82000, 60000]) {
    const r = priceHouse({ ...plain, theirRepairs: theirs });
    assert.ok(r.misses.includes("rehab"), `their ${theirs} against the 82.5k floor`);
    assert.equal(r.rehab, 82500);
  }
  const over = priceHouse({ ...plain, theirRepairs: 90000 });
  assert.ok(!over.misses.includes("rehab"), "a figure above the floor is evidence");
  assert.equal(over.rehab, 90000);
});

test("a scope from under 8 photos that reads above the floor raises the rehab and holds the grade", () => {
  const plain = { ...HOUSE, bricked: { ...BRICKED, condition: null } };
  const r = priceHouse({ ...plain, scope: { total: 96000, photos: 5 } });
  assert.equal(r.rehab, 96000, "the higher read is kept");
  assert.ok(r.misses.includes("rehab"), "but 5 photos are not evidence");
  assert.notEqual(r.grade, "A");
  assert.match(r.rehabWhy, /5 photos/);
  const under = priceHouse({ ...plain, scope: { total: 50000, photos: 5 } });
  assert.equal(under.rehab, 82500, "a thin scope under the floor changes nothing");
  assert.ok(under.misses.includes("rehab"));
  // An earlier, heavier read of the same house (shadowPrice keeps 14 days of them) is kept too.
  const kept = priceHouse({ ...HOUSE, priorRehab: 118500 });
  assert.equal(kept.rehab, 118500);
  assert.equal(kept.rehabOwn, 82500, "what this read alone said");
});

test("four price-guessed comps from a widened ring are not a sure ARV", () => {
  const house = { sqft: 1500, yearBuilt: 1961, homeType: "SINGLE_FAMILY", list: 600000, scope: { total: 90000, photos: 20 } };
  const comps = (over) => ({ ...house, comps: { arv: 584000, n: 4, listing: 0, radius: 0.5, acrossInArv: 0, eraGivesWay: false, gutCheck: false, ...over } });
  for (const [why, over] of [["past the first ring", { radius: 1 }], ["an across-road comp", { acrossInArv: 1 }],
    ["the era band gave way", { eraGivesWay: true }], ["a gut check", { gutCheck: true }]]) {
    const r = priceHouse(comps(over));
    assert.ok(r.misses.includes("arv"), `${why}: ${r.reasons.join(" | ")}`);
  }
  assert.ok(!priceHouse(comps({ listing: 4, radius: 1 })).misses.includes("arv"), "four whose own listings say remodeled carry it");
  assert.ok(!priceHouse(comps({})).misses.includes("arv"), "price-guessed but close, same side, no give-way: as before");
  assert.ok(!priceHouse({ ...house, comps: { arv: 584000, n: 4 } }).misses.includes("arv"), "a read that never said how far it reached: as before");
});
