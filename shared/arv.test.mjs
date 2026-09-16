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

/* ---------- similarity-weighted, time-adjusted (2026-09-16) ---------- */

import { timeTrend, TIME_TREND_MIN_COMPS, TIME_TREND_CAP_PCT_PER_MONTH } from "./arv.js";

const NOW = Date.parse("2026-09-16T00:00:00Z");

test("the closest twin outweighs a loose comp in the median", () => {
  // Two near-twins at 700k and one loose 900k. Unweighted, the median of three
  // is the middle value — 700k either way here — so use four: unweighted the
  // median of [700, 700, 900, 900] is 800k; weighted by similarity it stays
  // with the twins.
  const comps = [
    { price: 700000, similarity: 92 }, { price: 700000, similarity: 90 },
    { price: 900000, similarity: 30 }, { price: 900000, similarity: 25 },
  ];
  assert.equal(deriveArv({ comps }).base, 700000);
  const plain = comps.map(({ price }) => ({ price }));
  assert.equal(deriveArv({ comps: plain }).base, 800000, "without scores it is the old median");
});

test("comps without a similarity weigh the same as before", () => {
  const comps = [{ price: 500000, sqft: 1000 }, { price: 540000, sqft: 970 }, { price: 615000, sqft: 1660 }];
  const before = deriveArv({ comps, subjectSqft: 770 });
  const scored = deriveArv({ comps: comps.map((c) => ({ ...c, similarity: 100 })), subjectSqft: 770 });
  assert.equal(scored.base, before.base);
  assert.equal(scored.spread.avgSimilarity, 100);
  assert.equal(before.spread.avgSimilarity, null);
});

test("a rising market lifts an old sale to today, and the basis says how much", () => {
  const trend = { pctPerMonth: 0.5, n: 12, applied: true };
  const twelveMonthsAgo = "2025-09-16";
  const r = deriveArv({ comps: [{ price: 600000, saleDate: twelveMonthsAgo }, { price: 600000, saleDate: twelveMonthsAgo }], trend, now: NOW });
  assert.equal(r.base, 636000, "12 months at +0.5%/mo is +6%");
  assert.match(r.basis, /time \+0\.5%\/mo/);
  assert.deepEqual(r.trend, { pctPerMonth: 0.5, n: 12 });
  const none = deriveArv({ comps: [{ price: 600000, saleDate: twelveMonthsAgo }], trend: { pctPerMonth: 0.5, applied: false }, now: NOW });
  assert.equal(none.base, 600000, "a trend that abstained moves nothing");
  assert.equal(none.trend, null);
});

const dated = (n, { ppsfAt = () => 400, sqft = 1500, spanMonths = 12 } = {}) =>
  Array.from({ length: n }, (_, i) => {
    const mo = (i / Math.max(1, n - 1)) * spanMonths;
    const d = new Date(NOW - mo * 30.44 * 86400000).toISOString().slice(0, 10);
    return { price: ppsfAt(mo) * sqft, sqft, saleDate: d };
  });

test("the time trend abstains under eight dated comps and under six months of spread", () => {
  assert.equal(timeTrend(dated(TIME_TREND_MIN_COMPS - 1), NOW).applied, false);
  assert.equal(timeTrend(dated(10, { spanMonths: 3 }), NOW).applied, false);
  assert.match(timeTrend(dated(10, { spanMonths: 3 }), NOW).reason, /span 3 months/);
});

test("a market that gains a little a month reads as a positive trend, to the day", () => {
  // $/sqft that was 2% lower each month back: older sales are worth more today.
  const t = timeTrend(dated(12, { ppsfAt: (mo) => 400 * (1 - 0.002 * mo) }), NOW);
  assert.equal(t.applied, true);
  assert.ok(t.pctPerMonth > 0.15 && t.pctPerMonth < 0.25, `read ${t.pctPerMonth}%/mo for a 0.2%/mo market`);
  const flat = timeTrend(dated(12), NOW);
  assert.equal(flat.applied, false, "a flat market is no adjustment at all");
});

test("the trend is capped at one percent a month whatever the regression says", () => {
  const t = timeTrend(dated(12, { ppsfAt: (mo) => 400 * (1 - 0.05 * mo) }), NOW);
  assert.equal(t.pctPerMonth, TIME_TREND_CAP_PCT_PER_MONTH);
  assert.match(t.reason, /capped/);
});

test("the basis leads with the spread so an 80-character cut still reads", () => {
  const comps = [
    { price: 700000, sqft: 1800, distance: 0.2, yearBuilt: 1965, similarity: 88, condition: "renovated" },
    { price: 720000, sqft: 1900, distance: 0.4, yearBuilt: 1972, similarity: 81, condition: "renovated" },
    { price: 690000, sqft: 1750, distance: 0.3, yearBuilt: 1968, similarity: 84, condition: "updated" },
  ];
  const r = deriveArv({ comps, subjectSqft: 1800, subjectYearBuilt: 1968 });
  assert.equal(r.basis.split(";")[0], "3 comps · match 84 · within 0.4 mi · size ±6% · built ±4 yrs");
  assert.match(r.basis, /size-adjusted to 1,800 sqft/, "the old phrase is still in there, after the lead");
  assert.match(r.basis.slice(0, 80), /match 84 .* within 0\.4 mi/);
  assert.deepEqual(r.spread, { avgSimilarity: 84, maxDistance: 0.4, maxSizePct: 6, maxYearGap: 4 });
});
