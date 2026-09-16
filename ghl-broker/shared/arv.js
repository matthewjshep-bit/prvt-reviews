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

import { monthsSince } from "./comp-match.js";

export const SIZE_TOLERANCE_PCT = 25;

// The time trend: $/sqft against months-since-sale across the WHOLE ring, so
// a sale from last winter is brought to today before it is compared. Capped
// hard and quick to abstain — a slope off six sales is noise wearing a
// regression, and a fast market should move a number by a little, not carry
// it. Matt, 2026-09-16: "use the data we get" — the ring's dates are data.
export const TIME_TREND_MIN_COMPS = 8;
export const TIME_TREND_MIN_SPREAD_MONTHS = 6;
export const TIME_TREND_CAP_PCT_PER_MONTH = 1;

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

// The median, with each value counting as much as its weight. The value where
// the cumulative weight crosses half; the mean of the two straddling values
// when it lands exactly between them, which is what the plain median does on
// an even count of equal weights — so weights of 1 reproduce `median`.
const weightedMedian = (pairs) => {
  const rows = pairs.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  if (!rows.length) return 0;
  const total = rows.reduce((t, [, w]) => t + w, 0);
  let acc = 0;
  for (let i = 0; i < rows.length; i++) {
    acc += rows[i][1];
    if (acc > total / 2) return rows[i][0];
    if (acc === total / 2) return (rows[i][0] + rows[Math.min(i + 1, rows.length - 1)][0]) / 2;
  }
  return rows[rows.length - 1][0];
};

// A comp's weight in the median: its similarity, floored so a weak comp that
// made the set still counts for something; one with no score counts as one.
const weightOf = (c) => (c.similarity == null ? 1 : Math.max(0.2, num(c.similarity?.score ?? c.similarity) / 100));

/**
 * timeTrend(comps, now) → { pctPerMonth, n, applied, reason }
 *
 * Least-squares slope of $/sqft on months-since-sale over the priced, dated,
 * sized comps, as a percent of the pool's median $/sqft per month. Positive
 * means a rising market (older sales are worth MORE today). Abstains under
 * TIME_TREND_MIN_COMPS or under TIME_TREND_MIN_SPREAD_MONTHS of date spread.
 */
export function timeTrend(comps = [], now = Date.now()) {
  const rows = comps
    .map((c) => ({ ppsf: num(c.sqft) > 0 && num(c.price) > 0 ? c.price / c.sqft : 0, mo: monthsSince(c.saleDate, now) }))
    .filter((r) => r.ppsf > 0 && r.mo != null && r.mo >= 0);
  const abstain = (reason) => ({ pctPerMonth: 0, n: rows.length, applied: false, reason });
  if (rows.length < TIME_TREND_MIN_COMPS) return abstain(`${rows.length} dated comps, need ${TIME_TREND_MIN_COMPS}`);
  const mos = rows.map((r) => r.mo);
  const spread = Math.max(...mos) - Math.min(...mos);
  if (spread < TIME_TREND_MIN_SPREAD_MONTHS) return abstain(`sales span ${Math.round(spread)} months, need ${TIME_TREND_MIN_SPREAD_MONTHS}`);
  const mx = mos.reduce((t, v) => t + v, 0) / rows.length;
  const my = rows.reduce((t, r) => t + r.ppsf, 0) / rows.length;
  const sxx = rows.reduce((t, r) => t + (r.mo - mx) ** 2, 0);
  if (!(sxx > 0)) return abstain("no spread in sale dates");
  const sxy = rows.reduce((t, r) => t + (r.mo - mx) * (r.ppsf - my), 0);
  const slope = sxy / sxx; // $/sqft per month of AGE — negative in a rising market
  const mid = median(rows.map((r) => r.ppsf));
  const raw = mid > 0 ? (-slope / mid) * 100 : 0;
  const cap = TIME_TREND_CAP_PCT_PER_MONTH;
  const pctPerMonth = Math.round(Math.max(-cap, Math.min(cap, raw)) * 100) / 100;
  return { pctPerMonth, n: rows.length, applied: pctPerMonth !== 0, reason: Math.abs(raw) > cap ? `capped from ${raw.toFixed(2)}%/mo` : "" };
}

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
 * deriveArv({ comps, subjectSqft, subjectYearBuilt, adjustments, trend, now })
 *
 *   comps      [{ price, sqft?, condition?, similarity?, saleDate?, distance?, yearBuilt? }]
 *              condition already resolved; `similarity` (0–100, or the object
 *              from comp-match.js) weights the median — absent means weight 1
 *   subjectSqft number                          0 when unknown
 *   subjectYearBuilt number                     0 when unknown (for the basis only)
 *   adjustments [{ key, label, pct }]           site detractors/premiums
 *   trend       timeTrend() result, or null     brings each sale to today first
 *
 * Returns null when there is nothing to value, else:
 *   { arv, base, ppsf, method, graded, basis, adjustments, totalPct, oversized, trend, spread }
 */
export function deriveArv({ comps = [], subjectSqft = 0, subjectYearBuilt = 0, adjustments = [], trend = null, now = Date.now() } = {}) {
  const raw = comps.filter((c) => num(c.price) > 0);
  if (!raw.length) return null;
  const sqft = num(subjectSqft);

  // Bring each sale to today first. Only a trend that actually applied moves
  // anything; an undated comp is left at its price.
  const rate = trend?.applied ? num(trend.pctPerMonth) / 100 : 0;
  const priced = raw.map((c) => {
    const mo = rate ? monthsSince(c.saleDate, now) : null;
    return mo != null && mo > 0 ? { ...c, price: c.price * (1 + rate * mo), priceAtSale: c.price } : c;
  });

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
    base = round1k(weightedMedian(adjusted.map((v, i) => [v, weightOf(kept[i])])));
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
    base = round1k(weightedMedian(pool.map((c) => [c.price, weightOf(c)])));
    basis = `median of ${pool.length} comp${pool.length === 1 ? "" : "s"}${graded ? " (renovated/updated)" : ""}`;
    if (sqft <= 0) basis += " — no subject sqft, so no size adjustment";
  }

  const applied = adjustments
    .map((a) => ({ key: a.key, label: a.label, pct: num(a.pct) }))
    .filter((a) => a.pct !== 0);
  const totalPct = applied.reduce((t, a) => t + a.pct, 0);
  const arv = applied.length ? round1k(base * (1 + totalPct / 100)) : base;
  const adjStr = applied.map((a) => `${a.label} ${a.pct > 0 ? "+" : "−"}${Math.abs(a.pct)}%`).join(", ");
  if (rate) basis += `, time ${rate > 0 ? "+" : "−"}${Math.abs(trend.pctPerMonth)}%/mo`;

  // How far the comps had to reach. This LEADS the basis: the offer document
  // cuts it at 80 characters, and "match 84 · within 0.4 mi" is what a reader
  // needs before "size-adjusted to 1,890 sqft".
  const spread = spreadOf(pool, sqft, num(subjectYearBuilt));
  const lead = spreadLine(pool.length, spread);

  return {
    arv,
    base,
    ppsf,
    method,
    graded,
    oversized,
    adjustments: applied,
    totalPct,
    trend: rate ? { pctPerMonth: trend.pctPerMonth, n: trend.n } : null,
    spread,
    basis: `${lead ? `${lead}; ` : ""}${basis}${applied.length ? `; ${adjStr}` : ""}`,
  };
}

// The reach of the comps that carried the number. Each figure only when the
// comps could say it.
function spreadOf(pool, subjectSqft, subjectYearBuilt) {
  const sims = pool.map((c) => (c.similarity == null ? null : num(c.similarity?.score ?? c.similarity))).filter((v) => v != null);
  const dists = pool.map((c) => num(c.distance)).filter((d) => d > 0);
  const sizes = subjectSqft > 0 ? pool.map((c) => num(c.sqft)).filter((v) => v > 0).map((v) => Math.abs(v - subjectSqft) / subjectSqft * 100) : [];
  const years = pool.map((c) => num(c.yearBuilt)).filter((v) => v > 0);
  const gap = subjectYearBuilt > 0 ? subjectYearBuilt : 0;
  return {
    avgSimilarity: sims.length ? Math.round(sims.reduce((t, v) => t + v, 0) / sims.length) : null,
    maxDistance: dists.length ? Math.round(Math.max(...dists) * 10) / 10 : null,
    maxSizePct: sizes.length ? Math.round(Math.max(...sizes)) : null,
    maxYearGap: years.length && gap ? Math.max(...years.map((y) => Math.abs(y - gap))) : null,
  };
}

function spreadLine(count, s) {
  const parts = [
    s.avgSimilarity != null ? `match ${s.avgSimilarity}` : "",
    s.maxDistance != null ? `within ${s.maxDistance} mi` : "",
    s.maxSizePct != null ? `size ±${s.maxSizePct}%` : "",
    s.maxYearGap != null ? `built ±${s.maxYearGap} yrs` : "",
  ].filter(Boolean);
  return parts.length ? `${count} comp${count === 1 ? "" : "s"} · ${parts.join(" · ")}` : "";
}
