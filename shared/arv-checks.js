// arv-checks.js — the ARV a buyer would believe: the same finished house as
// the comps, in today's market. Pure, no I/O.
//
// Where buyers' ARVs parted from ours (2026-10-02 read of every buyer
// thread), it was nearly always a fact we could have checked:
//
//   Bellevue — pitched at 1,600 sqft; the county record says 1,340, and a
//     buyer did the math at $1,200/sqft on the record's number.
//   23706 138th Dr SE — the ~$800k comps "have a garage"; the subject has
//     half of one. The buyer's partner ran it "well under 700".
//   1415 2nd St — "comparable houses are listed around 650k"; we said 750.
//   Ravenna — a 76-inch basement buyers wouldn't count.
//
// So: size the house on its record, measure garage and lot against the
// comps (only when the comps' facts are known), add a bath to the scope when
// the ARV assumes one the house doesn't have, and hold the comps' base to what
// similar renovated houses are listed for today. Every adjustment is scaled by
// how many comps differ, capped in total, and carries its reason.

import { deriveArv } from "./arv.js";
import { similarity } from "./comp-match.js";
import { garageOf } from "./house-facts.js";
import { sameStreet } from "./us-address.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => Math.round(num(n)).toLocaleString();
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * sizeCheck({ sqft, record, house, lowCeilingBasement, t }) → { sqft, flag }
 *
 *   sqft    the size the offer would use (the editor's input, or Zillow's)
 *   record  { sqft } — Zillow's livingArea for the house
 *   house   normalized house facts (aboveGradeSqft, belowGradeSqft)
 *
 * A basement the listing says has low ceilings isn't sized as living space.
 * A size more than verifySizePct over the record is sized on the record.
 */
export function sizeCheck({ sqft = 0, record = {}, house = {}, lowCeilingBasement = false, t = {} } = {}) {
  const used = num(sqft);
  const above = num(house.aboveGradeSqft);
  const below = num(house.belowGradeSqft);
  if (lowCeilingBasement && above > 0 && below > 0 && (used || above + below) > above) {
    return { sqft: above, flag: { key: "low_basement", label: `low-ceiling basement not counted: sized at ${fmt(above)} sqft above grade` } };
  }
  const rec = num(record.sqft) || (above + below);
  const slack = 1 + (num(t.verifySizePct) || 10) / 100;
  if (used > 0 && rec > 0 && used > rec * slack) {
    return { sqft: rec, flag: { key: "size_over_record", label: `${fmt(used)} sqft is more than the record's ${fmt(rec)} — sized on the record` } };
  }
  return { sqft: used, flag: null };
}

/**
 * compParity({ subject, arvComps, t, minPct }) → { adjustments, cures }
 *
 *   subject   { garage (true/false/null), lotSqft, baths, beds }
 *   arvComps  the comps that carried the ARV, with garage / lotSqft / baths
 *
 * No garage among comps that have one: garagePct × the share that do.
 * A lot under smallLotRatio × the comps' median: smallLotPct × the share of
 * comps that much bigger. Fewer baths than the ARV comps (3+ beds): add one
 * to the scope — the ARV already assumes it.
 */
export function compParity({ subject = {}, arvComps = [], t = {}, minPct = 1 } = {}) {
  const adjustments = [];
  const cures = [];

  const sg = typeof subject.garage === "boolean" ? subject.garage : null;
  const cg = arvComps.map((c) => (typeof c.garage === "boolean" ? c.garage : garageOf(c.house || {}))).filter((v) => v != null);
  if (sg === false && cg.length >= 2) {
    const k = cg.filter(Boolean).length;
    const pct = round1(num(t.garagePct) * (k / cg.length));
    if (Math.abs(pct) >= minPct) {
      adjustments.push({ key: "no_garage", label: `No garage — ${k} of ${cg.length} comps have one`, pct, source: "auto", share: { with: k, of: cg.length } });
    }
  }

  const lot = num(subject.lotSqft);
  const lots = arvComps.map((c) => num(c.lotSqft)).filter((v) => v > 0);
  const ratio = num(t.smallLotRatio) || 0.6;
  if (lot > 0 && lots.length >= 2 && lot < ratio * median(lots)) {
    const k = lots.filter((v) => lot < ratio * v).length;
    const pct = round1(num(t.smallLotPct) * (k / lots.length));
    if (Math.abs(pct) >= minPct) {
      adjustments.push({ key: "small_lot", label: `Small lot — ${fmt(lot)} sqft vs ${fmt(median(lots))} for the comps`, pct, source: "auto", share: { with: k, of: lots.length } });
    }
  }

  const baths = num(subject.baths);
  const beds = num(subject.beds);
  const cb = arvComps.map((c) => num(c.baths)).filter((v) => v > 0);
  if (t.bathCure !== false && baths > 0 && beds >= 3 && cb.length >= 2) {
    const m = median(cb);
    if (m - baths >= 1) {
      cures.push({ key: "add_bath", label: `Add a bath — the ARV comps have ${m}, this has ${baths}`, cost: Math.round(num(t.addBathCost) || 25000) });
    }
  }
  return { adjustments, cures };
}

/**
 * sameBathComps(arvComps, baths) → the ARV comps re-picked when a person
 * removes the add-a-bath cure: comps within half a bath of the subject, or
 * the original set when fewer than two qualify.
 */
export function sameBathComps(arvComps = [], baths = 0) {
  const b = num(baths);
  if (!(b > 0)) return arvComps;
  const near = arvComps.filter((c) => num(c.baths) > 0 && num(c.baths) <= b + 0.5);
  return near.length >= 2 ? near : arvComps;
}

/**
 * activeCeiling({ actives, subject, subjectAddress, t, now }) →
 *   { status: "ok", amount, n, of, label, items } | { status: "thin", n, reason }
 *
 * What similar renovated houses are listed for today. The `candidates` most
 * similar for-sale/pending houses in the ring; the top half by $/sqft stands
 * for "renovated" (a flip lists at the top of the spread); size-adjusted to
 * the subject the same way the sold comps are. Asking prices run above sale
 * prices, so this errs lenient — a cap should bind only when our ARV is
 * clearly above the market buyers can see. The subject's own listing is never
 * its own ceiling.
 */
export function activeCeiling({ actives = [], subject = {}, subjectAddress = "", t = {}, now = Date.now() } = {}) {
  const min = num(t.minActives) || 3;
  const pool = actives.filter((a) => num(a.price) > 0 && !a.saleDate && !(subjectAddress && a.address && sameStreet(a.address, subjectAddress)));
  if (pool.length < min) {
    return { status: "thin", n: pool.length, reason: `${pool.length} similar listing${pool.length === 1 ? "" : "s"} within ${num(t.radiusMiles) || 1} mi, need ${min}` };
  }
  const ranked = pool
    .map((a) => ({ ...a, similarity: similarity(subject, a, { radiusMiles: num(t.radiusMiles) || 1, now }) }))
    .sort((x, y) => (num(y.similarity?.score) - num(x.similarity?.score)))
    .slice(0, num(t.candidates) || 10);
  const sized = ranked.filter((a) => num(a.sqft) > 0);
  if (sized.length < min) return { status: "thin", n: sized.length, reason: `${sized.length} similar listings with a size, need ${min}` };
  const top = [...sized].sort((a, b) => b.price / b.sqft - a.price / a.sqft).slice(0, Math.max(2, Math.ceil(sized.length / 2)));
  const d = deriveArv({ comps: top.map((a) => ({ ...a, condition: "renovated" })), subjectSqft: num(subject.sqft), now });
  if (!d?.base) return { status: "thin", n: top.length, reason: "the listings couldn't be valued" };
  return {
    status: "ok", amount: d.base, n: top.length, of: ranked.length,
    label: `what ${top.length} similar houses within ${num(t.radiusMiles) || 1} mi are listed for now`,
    items: top.slice(0, 8).map((a) => ({ id: a.id, address: a.address, price: a.price, sqft: a.sqft, beds: a.beds, baths: a.baths, status: a.status || null, distance: a.distance, url: a.url || null })),
  };
}

/**
 * limitAuto(adjustments, { maxCutPct, maxCreditPct }) → the auto adjustments,
 * scaled down together when they'd move the ARV past the limits. A person's
 * own adjustments are theirs and never scaled.
 */
export function limitAuto(adjustments = [], { maxCutPct = 15, maxCreditPct = 3 } = {}) {
  const auto = adjustments.filter((a) => a.source === "auto");
  const cut = -auto.filter((a) => a.pct < 0).reduce((t, a) => t + a.pct, 0);
  const credit = auto.filter((a) => a.pct > 0).reduce((t, a) => t + a.pct, 0);
  const sc = cut > maxCutPct ? maxCutPct / cut : 1;
  const sr = credit > maxCreditPct ? maxCreditPct / credit : 1;
  return adjustments.map((a) => {
    if (a.source !== "auto") return a;
    const s = a.pct < 0 ? sc : sr;
    return s < 1 ? { ...a, pct: round1(a.pct * s), limited: true } : a;
  });
}

/**
 * arvBridge({ base, capped, adjustments, arv }) → [{ label, amount, pct? }]
 *
 * Comps → listings cap → each adjustment → the ARV, as dollar steps, so the
 * note, the PDF and the panes all show the same arithmetic.
 */
export function arvBridge({ base = 0, capped = null, adjustments = [], arv = 0 } = {}) {
  const rows = [{ label: "Comps", amount: num(base) }];
  const from = capped ? num(capped.to) : num(base);
  if (capped) rows.push({ label: "Held to today's listings", amount: num(capped.to) - num(base) });
  let running = from;
  for (const a of adjustments) {
    const step = Math.round(from * num(a.pct) / 100);
    rows.push({ label: a.label, amount: step, pct: num(a.pct) });
    running += step;
  }
  rows.push({ label: "ARV", amount: num(arv) || Math.round(running / 1000) * 1000 });
  return rows;
}
