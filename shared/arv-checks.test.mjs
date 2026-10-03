// arv-checks.test.mjs — the ARV a buyer would believe. Fixtures from the
// 2026-10-02 deals: Yakima (415k ARV, buyers 350–375), Bellevue (pitched
// 1,600 sqft, record 1,340), 23706 138th Dr SE (half a garage among garage
// comps, 4 bed / 1 bath), Ravenna (low-ceiling basement).

import test from "node:test";
import assert from "node:assert/strict";
import { deriveArv, arvPool } from "./arv.js";
import { sizeCheck, compParity, sameBathComps, activeCeiling, limitAuto, arvBridge } from "./arv-checks.js";
import { UNDERWRITE_CHECKS_DEFAULTS } from "./underwrite-checks.js";

const L = UNDERWRITE_CHECKS_DEFAULTS.layout;
const A = UNDERWRITE_CHECKS_DEFAULTS.actives;
const comp = (o) => ({ condition: "renovated", similarity: 80, ...o });

test("ARV above what similar houses are listed for is capped, and says so", () => {
  const comps = [comp({ price: 410000, sqft: 1300 }), comp({ price: 420000, sqft: 1300 }), comp({ price: 415000, sqft: 1300 })];
  const r = deriveArv({ comps, subjectSqft: 1300, cap: { amount: 380000, label: "what 4 similar houses within 1 mi are listed for now" } });
  assert.equal(r.base, 415000);
  assert.equal(r.arv, 380000);
  assert.deepEqual(r.capped, { from: 415000, to: 380000, limited: false, label: "what 4 similar houses within 1 mi are listed for now" });
  assert.match(r.basis, /capped at \$380,000 — what 4 similar houses/);
});

test("a cap above the ARV changes nothing", () => {
  const comps = [comp({ price: 410000 }), comp({ price: 420000 })];
  const r = deriveArv({ comps, cap: { amount: 500000 } });
  assert.equal(r.arv, 415000);
  assert.equal(r.capped, null);
});

test("the street cut applies to the capped value, and a credit never lifts the ARV over the cap", () => {
  const comps = [comp({ price: 400000 }), comp({ price: 400000 })];
  const cut = deriveArv({ comps, adjustments: [{ key: "busy_road", label: "Busy road", pct: -5 }], cap: { amount: 380000 } });
  assert.equal(cut.arv, 361000, "380k × 0.95");
  const credit = deriveArv({ comps, adjustments: [{ key: "busy_road_credit", label: "Quieter", pct: 3 }], cap: { amount: 390000 } });
  assert.equal(credit.arv, 390000, "400k → held to 390k; +3% can't climb back over it");
});

test("a cap that would cut more than 20% is held to 20% and flagged", () => {
  const comps = [comp({ price: 500000 }), comp({ price: 500000 })];
  const r = deriveArv({ comps, cap: { amount: 300000, maxCutPct: 20 } });
  assert.equal(r.arv, 400000);
  assert.equal(r.capped.limited, true);
  assert.match(r.basis, /cut held to 20%/);
});

test("the listings ceiling is the renovated-looking half of the most similar listings, sized to the subject", () => {
  const actives = [
    { id: "a1", address: "5301 S Alder St, Tacoma, WA", price: 399000, sqft: 1250, beds: 3, baths: 1, distance: 0.3 },
    { id: "a2", address: "5110 S Puget Sound Ave, Tacoma, WA", price: 389000, sqft: 1300, beds: 3, baths: 1.5, distance: 0.4 },
    { id: "a3", address: "4920 S Junett St, Tacoma, WA", price: 299000, sqft: 1300, beds: 3, baths: 1, distance: 0.5 },
    { id: "a4", address: "5502 S Cedar St, Tacoma, WA", price: 310000, sqft: 1280, beds: 3, baths: 1, distance: 0.6 },
  ];
  const r = activeCeiling({ actives, subject: { sqft: 1300, beds: 3, baths: 1 }, subjectAddress: "5232 S Yakima Ave, Tacoma, WA", t: A });
  assert.equal(r.status, "ok");
  assert.equal(r.n, 2, "the top half by $/sqft — the two that list like flips");
  // Between the two flip-like listings, leaning on the closer one.
  assert.ok(r.amount >= 389000 && r.amount <= 407000, `ceiling ${r.amount}`);
  assert.match(r.label, /what 2 similar houses within 1 mi are listed for now/);
});

test("two similar listings is too few — the ARV is left alone and says why", () => {
  const r = activeCeiling({ actives: [{ id: "a", price: 400000, sqft: 1300 }, { id: "b", price: 410000, sqft: 1300 }], subject: { sqft: 1300 }, t: A });
  assert.equal(r.status, "thin");
  assert.match(r.reason, /2 similar listings within 1 mi, need 3/);
});

test("the subject's own listing is never its own ceiling, and a sold row is not a listing", () => {
  const actives = [
    { id: "self", address: "5232 South Yakima Avenue, Tacoma, WA 98408", price: 260000, sqft: 1300 },
    { id: "sold", address: "1 A St", price: 300000, sqft: 1300, saleDate: "2026-07-01" },
    { id: "a", address: "2 B St", price: 400000, sqft: 1300 }, { id: "b", address: "3 C St", price: 410000, sqft: 1300 },
  ];
  const r = activeCeiling({ actives, subject: { sqft: 1300 }, subjectAddress: "5232 S Yakima Ave, Tacoma, WA", t: A });
  assert.equal(r.status, "thin");
});

test("pitched sqft larger than the record is sized on the record (Bellevue)", () => {
  const r = sizeCheck({ sqft: 1600, record: { sqft: 1340 }, t: L });
  assert.equal(r.sqft, 1340);
  assert.match(r.flag.label, /1,600 sqft is more than the record's 1,340/);
  assert.equal(sizeCheck({ sqft: 1400, record: { sqft: 1340 }, t: L }).flag, null, "within 10% is the same house");
});

test("a low-ceiling basement isn't sized as living space (Ravenna)", () => {
  const r = sizeCheck({ sqft: 1940, record: { sqft: 1940 }, house: { aboveGradeSqft: 1400, belowGradeSqft: 540 }, lowCeilingBasement: true, t: L });
  assert.equal(r.sqft, 1400);
  assert.equal(r.flag.key, "low_basement");
});

test("a house with no garage among garage comps loses its share; unknown garages say nothing", () => {
  const r = compParity({ subject: { garage: false }, arvComps: [{ garage: true }, { garage: true }, { garage: true }, { garage: false }], t: L });
  assert.deepEqual(r.adjustments.map((a) => [a.key, a.pct]), [["no_garage", -2.2]]);
  assert.match(r.adjustments[0].label, /3 of 4 comps have one/);
  assert.deepEqual(compParity({ subject: { garage: null }, arvComps: [{ garage: true }, { garage: true }], t: L }).adjustments, []);
  assert.deepEqual(compParity({ subject: { garage: false }, arvComps: [{ garage: true }], t: L }).adjustments, [], "one comp is not a pattern");
});

test("a lot well under the comps' is a small cut; a normal lot is none", () => {
  const r = compParity({ subject: { lotSqft: 2750 }, arvComps: [{ lotSqft: 5000 }, { lotSqft: 6000 }, { lotSqft: 5500 }], t: L });
  assert.deepEqual(r.adjustments.map((a) => [a.key, a.pct]), [["small_lot", -2]]);
  assert.deepEqual(compParity({ subject: { lotSqft: 5000 }, arvComps: [{ lotSqft: 5000 }, { lotSqft: 6000 }], t: L }).adjustments, []);
});

test("a 1-bath 4-bed comped against 2-bath sales gets a bath in the scope (23706 138th Dr SE)", () => {
  const r = compParity({ subject: { beds: 4, baths: 1 }, arvComps: [{ baths: 2 }, { baths: 2 }, { baths: 2.5 }], t: L });
  assert.deepEqual(r.cures, [{ key: "add_bath", label: "Add a bath — the ARV comps have 2, this has 1", cost: 25000 }]);
  assert.deepEqual(compParity({ subject: { beds: 2, baths: 1 }, arvComps: [{ baths: 2 }, { baths: 2 }], t: L }).cures, [], "a 2-bed doesn't need a second bath");
  const same = sameBathComps([{ id: 1, baths: 2 }, { id: 2, baths: 1 }, { id: 3, baths: 1.5 }], 1);
  assert.deepEqual(same.map((c) => c.id), [2, 3], "removing the cure re-picks same-bath comps");
});

test("auto adjustments past the limits are scaled down together; a person's own never are", () => {
  const out = limitAuto([
    { key: "busy_road", pct: -10, source: "auto" }, { key: "backs_commercial", pct: -8, source: "auto" }, { key: "flood_zone", pct: -7 },
  ], { maxCutPct: 15, maxCreditPct: 3 });
  assert.deepEqual(out.map((a) => a.pct), [-8.3, -6.7, -7]);
  assert.equal(out[0].limited, true);
});

test("base, cap and cuts add up the same on every surface", () => {
  const rows = arvBridge({ base: 415000, capped: { to: 380000 }, adjustments: [{ label: "Busy road", pct: -5 }], arv: 361000 });
  assert.deepEqual(rows.map((r) => r.amount), [415000, -35000, -19000, 361000]);
});

test("the ARV pool is the renovated comps when there are two, otherwise all of them", () => {
  assert.equal(arvPool([comp({ price: 1 * 1e5 }), comp({ price: 2e5 }), { price: 3e5, condition: "dated" }]).length, 2);
  assert.equal(arvPool([comp({ price: 1e5 }), { price: 3e5, condition: "dated" }]).length, 2);
});
