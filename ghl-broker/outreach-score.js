// outreach-score.js — deterministic "likely a fixer" score for a RentCast
// sale listing. Pure function of the listing plus the pull cohort's median
// $/sqft; the UI renders the returned components verbatim, so every point
// awarded must carry a human-readable `detail` string.

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// RentCast `history` is an object keyed by ISO date ({ event, price, ... });
// tolerate arrays too. Returns price points sorted oldest → newest.
function pricePoints(history) {
  if (!history) return [];
  const entries = Array.isArray(history)
    ? history.map((h) => [h.date || h.listedDate || "", h])
    : Object.entries(history);
  return entries
    .filter(([, h]) => Number(h?.price) > 0)
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([date, h]) => ({ date, price: Number(h.price) }));
}

export function priceCuts(listing) {
  const pts = pricePoints(listing.history);
  const current = Number(listing.price) > 0 ? { date: "9999", price: Number(listing.price) } : null;
  const seq = current ? [...pts, current] : pts;
  let count = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i].price < seq[i - 1].price) count++;
  const original = seq[0]?.price || 0;
  const latest = seq[seq.length - 1]?.price || 0;
  const totalDropPct = original > latest && original > 0 ? ((original - latest) / original) * 100 : 0;
  return { count, totalDropPct };
}

// Built before this is an older house: the work a fixer wants is likely
// still to do. A finished house in a slow town is cheap, not distressed.
export const OLD_HOUSE_YEAR = 1980;

export function isOldHouse(yearBuilt) {
  const y = Number(yearBuilt) || 0;
  return y > 1800 && y < OLD_HOUSE_YEAR;
}

// Distress = ANY of: stale (DOM ≥ staleDom), a price-cut history, or priced
// ≤90% of the cohort's median $/sqft. OR semantics — the signals are
// alternatives, not requirements. `old` (year known, before OLD_HOUSE_YEAR)
// is the other half of the sweep's "cut-or-old" rule.
export function distressSignals(listing, { medianPpsf = 0, staleDom = 45 } = {}) {
  const stale = staleDom > 0 && Number(listing.daysOnMarket) >= staleDom;
  const cut = priceCuts(listing).count > 0;
  const price = Number(listing.price);
  const sqft = Number(listing.squareFootage);
  const cheap = price > 0 && sqft > 0 && medianPpsf > 0 && price / sqft <= 0.9 * medianPpsf;
  // `priced`: a signal in the price itself (a cut, or cheap for the market),
  // for pulls where every listing is already stale by query.
  const old = isOldHouse(listing.yearBuilt);
  return { stale, cut, cheap, old, any: stale || cut || cheap, priced: cut || cheap };
}

/**
 * meetsDistressRule(sig, rule) — a listing's signals read by a pull's rule:
 * "cut-or-old" (a price cut or an older house), "cut-old-or-stale" (one
 * of those, or sitting `staleDom` days — Pierce, 2026-10-26), "cut-or-cheap"
 * (a price cut or a cheap $/sqft), else "any" (stale, cut or cheap).
 */
export const DISTRESS_RULES = ["any", "cut-or-old", "cut-old-or-stale", "cut-or-cheap"];

export function meetsDistressRule(sig = {}, rule = "any") {
  if (rule === "cut-or-old") return Boolean(sig.cut || sig.old);
  if (rule === "cut-old-or-stale") return Boolean(sig.cut || sig.old || sig.stale);
  if (rule === "cut-or-cheap") return Boolean(sig.cut || sig.cheap);
  return Boolean(sig.stale || sig.cut || sig.cheap);
}

export function scoreListing(listing, { medianPpsf = 0 } = {}) {
  const components = [];
  const add = (key, label, points, max, detail, na = false) =>
    components.push({ key, label, points: Math.round(points * 10) / 10, max, detail, ...(na ? { na: true } : {}) });

  const dom = Number(listing.daysOnMarket) || 0;
  if (dom > 0) add("dom", "Days on market", (Math.min(dom, 180) / 180) * 35, 35, `${dom} days on market`);
  else add("dom", "Days on market", 0, 35, "unknown", true);

  const cuts = priceCuts(listing);
  if (cuts.count > 0)
    add("cuts", "Price cuts", Math.min(25, cuts.count * 10 + cuts.totalDropPct), 25,
      `${cuts.count} cut${cuts.count > 1 ? "s" : ""}, −${cuts.totalDropPct.toFixed(1)}% from list`);
  else add("cuts", "Price cuts", 0, 25, "no price cuts");

  const yearBuilt = Number(listing.yearBuilt) || 0;
  if (yearBuilt > 1800) add("age", "Age", clamp((2000 - yearBuilt) * 0.4, 0, 20), 20, `built ${yearBuilt}`);
  else add("age", "Age", 0, 20, "year built unknown", true);

  const price = Number(listing.price) || 0;
  const sqft = Number(listing.squareFootage) || 0;
  if (price > 0 && sqft > 0 && medianPpsf > 0) {
    const ppsf = price / sqft;
    add("ppsf", "Cheap $/sqft", clamp((1 - ppsf / medianPpsf) * 50, 0, 20), 20,
      `$${Math.round(ppsf)}/sqft vs $${Math.round(medianPpsf)} median`);
  } else add("ppsf", "Cheap $/sqft", 0, 20, "sqft or median unavailable", true);

  const score = Math.round(components.reduce((s, c) => s + c.points, 0));
  return { score: clamp(score, 0, 100), components };
}

export function medianPricePerSqft(listings) {
  const vals = listings
    .map((l) => (Number(l.price) > 0 && Number(l.squareFootage) > 0 ? Number(l.price) / Number(l.squareFootage) : 0))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (!vals.length) return 0;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

const median = (vals) => {
  const v = vals.slice().sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/**
 * medianIndex(listings, { min, countyOf }) → (listing) → $/sqft median
 *
 * For a read that spans many markets (the statewide sweep): what each
 * listing's $/sqft is measured against. Its ZIP's median when the ZIP has at
 * least `min` priced listings, else its county's — never the whole read's,
 * where a Spokane house is cheap against Seattle and a Rainier Valley one
 * against Bellevue. 0 when neither is known.
 */
export function medianIndex(listings, { min = 15, countyOf = (l) => l.county } = {}) {
  const byZip = new Map();
  const byCounty = new Map();
  for (const l of listings) {
    const v = Number(l.price) > 0 && Number(l.squareFootage) > 0 ? Number(l.price) / Number(l.squareFootage) : 0;
    if (!v) continue;
    const z = String(l.zipCode || "");
    const c = String(countyOf(l) || "");
    if (z) byZip.set(z, [...(byZip.get(z) || []), v]);
    if (c) byCounty.set(c, [...(byCounty.get(c) || []), v]);
  }
  const zipMedian = new Map([...byZip].filter(([, v]) => v.length >= min).map(([k, v]) => [k, median(v)]));
  const countyMedian = new Map([...byCounty].map(([k, v]) => [k, median(v)]));
  return (l) => zipMedian.get(String(l.zipCode || "")) ?? countyMedian.get(String(countyOf(l) || "")) ?? 0;
}

/* ---------- listings that came off the market (2026-10-15) ---------- */

// How recently a listing must have come off the market to be worth a text.
export const OFF_MARKET_WITHIN_DAYS = 30;
// Zillow statuses that mean it isn't a seller still hoping to sell: it sold,
// it's under contract, or it's back up for sale.
const NOT_OFF_MARKET_STATUS = /sold|pending|contingent|for_sale|for sale|under_contract/i;

/**
 * soldInHistory(listing) → true when RentCast's history on the listing shows a
 * sale (a "Sold" event, a sold date or a sale price). RentCast's sale-listing
 * history usually doesn't carry one; when it does, it counts.
 */
export function soldInHistory(listing = {}) {
  const h = listing?.history;
  const rows = Array.isArray(h) ? h : h && typeof h === "object" ? Object.values(h) : [];
  return rows.some((x) => /\bsold\b/i.test(String(x?.event || "")) || x?.soldDate || Number(x?.salePrice) > 0)
    || Boolean(listing?.soldDate || listing?.lastSaleDate) || /sold/i.test(String(listing?.status || ""));
}

/**
 * offMarketListings(listings, { now, withinDays, zillowStatus }) → { kept, dropped }
 *
 * The RentCast "Inactive" listings (which include the sold ones) that came off
 * the market in the last `withinDays` and, as far as we can tell, didn't sell:
 * by Zillow's status when we have one for the street (`zillowStatus`, a
 * Map(streetKey → status) with `keyOf`), else by RentCast's own history.
 * Each kept one is flagged `offMarket` with its `removedDate`.
 */
export function offMarketListings(listings = [], { now = Date.now(), withinDays = OFF_MARKET_WITHIN_DAYS, zillowStatus = null, keyOf = null } = {}) {
  const kept = [];
  const dropped = { notRecent: 0, sold: 0, zillow: 0 };
  for (const l of listings || []) {
    const t = Date.parse(l?.removedDate || "");
    if (!Number.isFinite(t) || t > now || now - t > withinDays * 86400000 || String(l?.status || "Inactive").toLowerCase() === "active") { dropped.notRecent++; continue; }
    const z = zillowStatus && keyOf ? zillowStatus.get(keyOf(l)) : undefined;
    if (z && NOT_OFF_MARKET_STATUS.test(String(z))) { dropped.zillow++; continue; }
    if (!z && soldInHistory(l)) { dropped.sold++; continue; }
    kept.push({ ...l, offMarket: true });
  }
  return { kept, dropped };
}
