// arv.test.mjs — the after-repair value derivation.
//
//   node --test arv.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { deriveArv, SIZE_TOLERANCE_PCT } from "./arv.js";

/* ---------------- the reported failure ---------------- */

test("the 770 sqft case: comps far larger no longer crush the value", () => {
  // Real numbers off the screenshot: two Zillow captures against a 770 sqft
  // subject. The old avg($/sqft) x sqft produced $357,000 — below BOTH comps.
  const comps = [
    { address: "12722 Phinney", price: 540000, sqft: 970 },
    { address: "11545 N Park", price: 615000, sqft: 1660 },
  ];
  const r = deriveArv({ comps, subjectSqft: 770 });

  const naive = Math.round(
    (comps.reduce((t, c) => t + c.price / c.sqft, 0) / comps.length) * 770 / 1000
  ) * 1000;
  assert.equal(naive, 357000, "sanity: this is what the old method produced");

  assert.equal(r.method, "size-adjusted");
  assert.ok(r.base > naive + 80000, `expected well above ${naive}, got ${r.base}`);
  assert.equal(r.base, 451000);
});

test("both of those comps are flagged as too big to lean on", () => {
  const r = deriveArv({
    comps: [
      { address: "12722 Phinney", price: 540000, sqft: 970 },
      { address: "11545 N Park", price: 615000, sqft: 1660 },
    ],
    subjectSqft: 770,
  });
  assert.equal(r.oversized.length, 2);
  assert.equal(r.oversized[1].ratio, 2.16);
});

/* ---------------- the size adjustment ---------------- */

test("comps at the subject's size need no adjusting", () => {
  const comps = [
    { price: 500000, sqft: 1000 },
    { price: 520000, sqft: 1000 },
    { price: 540000, sqft: 1000 },
  ];
  const r = deriveArv({ comps, subjectSqft: 1000 });
  assert.equal(r.base, 520000, "the median comes straight through");
  assert.equal(r.oversized.length, 0);
});

test("a smaller subject is adjusted down, a larger one up", () => {
  const comps = [{ price: 500000, sqft: 1000 }, { price: 500000, sqft: 1000 }];
  const smaller = deriveArv({ comps, subjectSqft: 900 });
  const larger = deriveArv({ comps, subjectSqft: 1100 });
  assert.ok(smaller.base < 500000);
  assert.ok(larger.base > 500000);
  // Symmetric: +/-100 sqft at half of $500/sqft is +/-$25,000.
  assert.equal(500000 - smaller.base, 25000);
  assert.equal(larger.base - 500000, 25000);
});

test("marginal footage is valued at half, not full, $/sqft", () => {
  // One comp, $500/sqft, subject 200 sqft smaller. Full-rate would take off
  // $100,000; the appraiser rule takes off half that.
  const r = deriveArv({ comps: [{ price: 500000, sqft: 1000 }], subjectSqft: 800 });
  assert.equal(r.base, 450000);
});

test("only comps within tolerance are left unflagged", () => {
  const r = deriveArv({
    comps: [
      { address: "ok", price: 500000, sqft: 900 },   // 12.5% off
      { address: "big", price: 700000, sqft: 1400 }, // 75% off
    ],
    subjectSqft: 800,
  });
  assert.deepEqual(r.oversized.map((o) => o.address), ["big"]);
  assert.ok(SIZE_TOLERANCE_PCT === 25);
});

/* ---------------- condition gating ---------------- */

test("renovated/updated comps drive the value when there are enough", () => {
  const comps = [
    { price: 600000, sqft: 1000, condition: "renovated" },
    { price: 620000, sqft: 1000, condition: "updated" },
    { price: 400000, sqft: 1000, condition: "distressed" },
    { price: 420000, sqft: 1000, condition: "dated" },
  ];
  const r = deriveArv({ comps, subjectSqft: 1000 });
  assert.equal(r.graded, true);
  assert.equal(r.base, 610000, "the dated and distressed sales must not drag it down");
  assert.match(r.basis, /renovated\/updated/);
});

test("one graded comp isn't enough to gate on, so everything is used", () => {
  const comps = [
    { price: 600000, sqft: 1000, condition: "renovated" },
    { price: 400000, sqft: 1000 },
  ];
  const r = deriveArv({ comps, subjectSqft: 1000 });
  assert.equal(r.graded, false);
  assert.equal(r.base, 500000);
});

/* ---------------- fallbacks ---------------- */

test("no subject sqft falls back to the median and says so", () => {
  const r = deriveArv({ comps: [{ price: 400000 }, { price: 500000 }, { price: 600000 }], subjectSqft: 0 });
  assert.equal(r.method, "median");
  assert.equal(r.base, 500000);
  assert.match(r.basis, /no subject sqft/);
});

test("comps without sqft still count toward the median", () => {
  const r = deriveArv({ comps: [{ price: 400000 }, { price: 600000 }], subjectSqft: 1000 });
  assert.equal(r.method, "median");
  assert.equal(r.base, 500000);
});

test("nothing to value returns null rather than zero", () => {
  assert.equal(deriveArv({ comps: [] }), null);
  assert.equal(deriveArv({ comps: [{ price: 0 }] }), null);
  assert.equal(deriveArv(), null);
});

/* ---------------- outliers and site adjustments ---------------- */

test("a wild $/sqft outlier is trimmed once there are enough comps", () => {
  const comps = [
    { price: 500000, sqft: 1000 }, { price: 510000, sqft: 1000 },
    { price: 520000, sqft: 1000 }, { price: 530000, sqft: 1000 },
    { price: 505000, sqft: 1000 }, { price: 2000000, sqft: 1000 },
  ];
  const r = deriveArv({ comps, subjectSqft: 1000 });
  assert.match(r.basis, /outlier dropped/);
  assert.ok(r.base < 600000, `the $2M sale must not set the ARV, got ${r.base}`);
});

test("site detractors come off the base, and are described", () => {
  const comps = [{ price: 500000, sqft: 1000 }, { price: 500000, sqft: 1000 }];
  const r = deriveArv({
    comps, subjectSqft: 1000,
    adjustments: [{ key: "busy_road", label: "Busy road", pct: -5 }, { key: "x", label: "Nothing", pct: 0 }],
  });
  assert.equal(r.base, 500000);
  assert.equal(r.arv, 475000);
  assert.equal(r.totalPct, -5);
  assert.equal(r.adjustments.length, 1, "zero-percent rows are dropped");
  assert.match(r.basis, /Busy road −5%/);
});

test("a premium raises it", () => {
  const r = deriveArv({
    comps: [{ price: 500000, sqft: 1000 }, { price: 500000, sqft: 1000 }],
    subjectSqft: 1000,
    adjustments: [{ key: "view", label: "Territorial view", pct: 8 }],
  });
  assert.equal(r.arv, 540000);
  assert.match(r.basis, /\+8%/);
});
