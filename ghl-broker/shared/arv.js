// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// arv.js — derive an after-repair value from a set of comps. Pure functions,
// no I/O, no deps. Extracted from CompsPane so the one number the whole offer
// hangs off can actually be tested.
//
// The bug that forced the extraction: the ARV came from
//
//     average($/sqft across comps) × subject sqft
//
// which silently assumes value scales linearly with floor area. It doesn't. A
// kitchen, a bathroom, a roof, a furnace and a front door cost about the same
// in a 770 sqft cottage as in a 1,700 sqft house, so small homes carry a much
// higher $/sqft. Multiply a big comp's $/sqft by a small subject's area and you
// get a number far below what the house is worth.
//
// Observed: a 770 sqft subject with comps that sold at $540,000 (970 sqft) and
// $615,000 (~1,660 sqft) produced an ARV of $357,000 — below both comps, and
// $250k under the AVM.
//
// The fix is the standard appraiser adjustment: value the DIFFERENCE in floor
// area at about half the average $/sqft, because the marginal square foot is
// finish and framing rather than another kitchen. Then take the median of the
// adjusted comps rather than a mean, so one outlier can't set the number.
//
// That adjustment is only credible across modest size gaps — appraisal practice
// keeps comps within roughly ±25%. Beyond that this reports the comp as
// unreliable instead of pretending the arithmetic bridges it.

export const SIZE_TOLERANCE_PCT = 25;

// Renovated/updated comps are the ones that define an AFTER-repair value.
const ARV_CONDITIONS = ["renovated", "updated"];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const round1k = (n) => Math.round(n / 1000) * 1000;

// Drop $/sqft outliers once there are enough comps for a quartile to mean
// anything. Never trims below two comps — a "median" of one is just that one.
function trimOutliers(comps) {
  const withSqft = comps.filter((c) => num(c.sqft) > 0 && num(c.price) > 0);
  if (withSqft.length < 5) return { kept: comps, dropped: 0 };
  const ps = withSqft.map((c) => c.price / c.sqft).sort((a, b) => a - b);
  const q1 = ps[Math.floor(ps.length * 0.25)];
  const q3 = ps[Math.floor(ps.length * 0.75)];
  const iqr = q3 - q1;
  const inRange = (c) => {
    if (!(num(c.sqft) > 0)) return true;
    const p = c.price / c.sqft;
    return p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr;
  };
  const kept = comps.filter(inRange);
  return kept.length >= 2 ? { kept, dropped: comps.length - kept.length } : { kept: comps, dropped: 0 };
}

/**
 * deriveArv({ comps, subjectSqft, adjustments })
 *
 *   comps      [{ price, sqft?, condition? }]  condition already resolved
 *   subjectSqft number                          0 when unknown
 *   adjustments [{ key, label, pct }]           site detractors/premiums
 *
 * Returns null when there is nothing to value, else:
 *   { arv, base, ppsf, method, graded, basis, adjustments, totalPct, oversized }
 */
export function deriveArv({ comps = [], subjectSqft = 0, adjustments = [] } = {}) {
  const priced = comps.filter((c) => num(c.price) > 0);
  if (!priced.length) return null;
  const sqft = num(subjectSqft);

  // Prefer renovated/updated comps when there are enough of them — that's what
  // "after repair" means. Otherwise value off everything and say so, rather
  // than refusing to produce a number.
  const gradedPool = priced.filter((c) => ARV_CONDITIONS.includes(c.condition));
  const graded = gradedPool.length >= 2;
  const pool = graded ? gradedPool : priced;

  const withSqft = pool.filter((c) => num(c.sqft) > 0);
  let base = 0;
  let method = "median";
  let ppsf = null;
  let basis = "";
  let oversized = [];

  if (sqft > 0 && withSqft.length) {
    const avgPpsf = withSqft.reduce((t, c) => t + c.price / c.sqft, 0) / withSqft.length;
    ppsf = Math.round(avgPpsf);
    const { kept, dropped } = trimOutliers(pool);

    // The adjustment itself: marginal floor area at half the average $/sqft.
    const adjusted = kept.map((c) =>
      num(c.sqft) > 0 && avgPpsf > 0 ? c.price + (sqft - c.sqft) * 0.5 * avgPpsf : c.price
    );
    base = round1k(median(adjusted));
    method = "size-adjusted";

    // Comps too far off in size for the adjustment to carry. Reported, not
    // silently dropped — the operator can see them and decide.
    oversized = kept
      .filter((c) => num(c.sqft) > 0 && Math.abs(c.sqft - sqft) / sqft > SIZE_TOLERANCE_PCT / 100)
      .map((c) => ({
        address: c.address || "comp",
        sqft: Math.round(c.sqft),
        ratio: Math.round((c.sqft / sqft) * 100) / 100,
      }));

    basis =
      `${kept.length} comp${kept.length === 1 ? "" : "s"}${graded ? " (renovated/updated)" : ""}, ` +
      `size-adjusted to ${sqft.toLocaleString()} sqft` +
      (dropped ? `, ${dropped} outlier dropped` : "");
  } else {
    base = round1k(median(pool.map((c) => c.price)));
    basis = `median of ${pool.length} comp${pool.length === 1 ? "" : "s"}${graded ? " (renovated/updated)" : ""}`;
    if (sqft <= 0) basis += " — no subject sqft, so no size adjustment";
  }

  const applied = adjustments
    .map((a) => ({ key: a.key, label: a.label, pct: num(a.pct) }))
    .filter((a) => a.pct !== 0);
  const totalPct = applied.reduce((t, a) => t + a.pct, 0);
  const arv = applied.length ? round1k(base * (1 + totalPct / 100)) : base;
  const adjStr = applied.map((a) => `${a.label} ${a.pct > 0 ? "+" : "−"}${Math.abs(a.pct)}%`).join(", ");

  return {
    arv,
    base,
    ppsf,
    method,
    graded,
    oversized,
    adjustments: applied,
    totalPct,
    basis: applied.length ? `${basis}; ${adjStr}` : basis,
  };
}
