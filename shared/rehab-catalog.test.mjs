// rehab-catalog.test.mjs — line-item costing and the cheat-sheet bands.
//
// The bug that motivated this: every flat cost in the catalog was priced for a
// ~1,500 sqft house and applied unchanged at any size, so a 770 sqft cottage
// was billed $6,000 to paint its exterior and $12,000 to reroof a footprint a
// third that size. A near-gut scope came back at $91,000 against an operator
// cheat sheet whose heavy band for that size tops out around $70,000.
//
//   node --test rehab-catalog.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_REHAB_ITEMS, REHAB_BASELINE_SQFT, bandMidpoint, lineCost, rehabBand, sizeFactor,
} from "./rehab-catalog.js";

const byId = Object.fromEntries(ALL_REHAB_ITEMS.map((i) => [i.id, i]));

/* ---------------- size factor ---------------- */

test("a house at the baseline pays exactly the catalog price", () => {
  assert.equal(sizeFactor(REHAB_BASELINE_SQFT), 1);
  assert.equal(lineCost(byId["paint-ext"], {}, REHAB_BASELINE_SQFT), 6000);
});

test("half the cost is fixed, so half the house is not half the price", () => {
  // 750 sqft is half the baseline; the factor must land at 0.75, not 0.5 —
  // mobilization, a minimum crew day and the permit don't halve.
  assert.equal(sizeFactor(750), 0.75);
});

test("the factor is clamped at both ends", () => {
  assert.equal(sizeFactor(100), 0.6, "a shed still costs something to show up to");
  assert.equal(sizeFactor(99999), 1.5, "a mansion isn't linear either");
});

test("unknown size falls back to the catalog price rather than guessing", () => {
  assert.equal(sizeFactor(0), 1);
  assert.equal(lineCost(byId["paint-ext"], {}, 0), 6000);
});

/* ---------------- what scales and what doesn't ---------------- */

test("size-dependent work scales; fixed units do not", () => {
  const S = 770; // the cottage from the report
  // Exterior paint tracks wall area.
  assert.equal(Math.round(lineCost(byId["paint-ext"], {}, S)), 4540);
  // A water heater is one water heater at any size.
  assert.equal(lineCost(byId["wh"], {}, S), 1800);
  // So is an electrical panel and an appliance package.
  assert.equal(lineCost(byId["elec"], {}, S), 4000);
  assert.equal(lineCost(byId["kit-appl"], {}, S), 4500);
  // A deck belongs to the lot, not the house.
  assert.equal(lineCost(byId["deck"], {}, S), 3500);
});

test("per-sqft and per-unit items are untouched by the factor", () => {
  // Already proportional — scaling them would double-count.
  assert.equal(lineCost(byId["lvp"], {}, 770), 6 * 770);
  assert.equal(lineCost(byId["paint-int"], {}, 770), 3 * 770);
  assert.equal(lineCost(byId["windows"], { qty: 8 }, 770), 650 * 8);
});

test("an edited unit price is respected, then scaled", () => {
  assert.equal(Math.round(lineCost(byId["paint-ext"], { unit: 8000 }, 750)), 6000);
});

test("a big house pays more than the catalog price", () => {
  assert.ok(lineCost(byId["roof"], {}, 2400) > 12000);
});

/* ---------------- the reported case ---------------- */

test("the 770 sqft near-gut lands materially below where it did", () => {
  const S = 770;
  const scope = [
    "kit-reface", "kit-counter", "kit-appl", "kit-sink", "kit-floor",
    "paint-int", "lvp", "living", "drywall", "doors", "fixtures", "blinds",
    "wh", "elec", "plumb", "insul",
    "paint-ext", "siding", "gutters", "landscape", "deck",
    "junk", "pest", "permits",
  ];
  const before = scope.reduce((t, id) => {
    const i = byId[id];
    return t + (i.mode === "sqft" ? i.unit * S : i.unit);
  }, 0);
  const after = scope.reduce((t, id) => t + lineCost(byId[id], {}, S), 0);
  assert.ok(after < before, "scaling must reduce a small house's scope");
  // ~11% off the itemized total; the rooms and custom lines don't scale.
  assert.ok(before - after > 9000, `expected a meaningful drop, got ${Math.round(before - after)}`);
});

/* ---------------- cheat-sheet bands ---------------- */

test("bands pick up the right row for a size", () => {
  assert.equal(rehabBand(770).label, "under 1,000 sqft");
  assert.equal(rehabBand(1000).label, "under 1,000 sqft", "boundaries are inclusive");
  assert.equal(rehabBand(1001).label, "1,000–1,500 sqft");
  assert.equal(rehabBand(2400).label, "2,000–2,500 sqft");
  assert.equal(rehabBand(9000).label, "over 2,500 sqft");
});

test("an unknown size has no band rather than a made-up one", () => {
  assert.equal(rehabBand(0), null);
  assert.equal(bandMidpoint(0, "heavy"), 0);
});

test("bucket midpoints match the cheat sheet", () => {
  assert.equal(bandMidpoint(770, "light"), 25000);   // 20–30k
  assert.equal(bandMidpoint(770, "medium"), 40000);  // 30–50k
  assert.equal(bandMidpoint(770, "heavy"), 60000);   // 50–70k
  assert.equal(bandMidpoint(1800, "medium"), 80000); // 70–90k
});

test("every band rises with size and level", () => {
  for (const level of ["light", "medium", "heavy"]) {
    const mids = [770, 1200, 1800, 2200, 3000].map((s) => bandMidpoint(s, level));
    for (let i = 1; i < mids.length; i++) {
      assert.ok(mids[i] >= mids[i - 1], `${level} must not fall as size grows`);
    }
  }
  for (const sqft of [770, 1200, 1800, 2200, 3000]) {
    assert.ok(bandMidpoint(sqft, "light") < bandMidpoint(sqft, "medium"));
    assert.ok(bandMidpoint(sqft, "medium") < bandMidpoint(sqft, "heavy"));
  }
});
