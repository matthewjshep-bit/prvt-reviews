// investor-ratio.js — what investors actually pay, read from recorded sales.
//
// Matt, 2026-10-28: the goal is a price investors will pay, and InvestorBase's
// edge is "local investor activity". In Washington that activity is public: the
// county records every sale with its price and the buyer's and seller's names.
// A flip shows up as two sales of one parcel, the buyer of the first being the
// seller of the second. The first price is what an investor paid as-is; the
// second is what the finished house sold for. Their ratio, by ZIP, turns an ARV
// into an investor price. King County, Oct 2026: 1,566 flips resold in 24
// months, investors paid a median 61% of the resale (middle half 48–70%).
//
// The same records give the answer key for testing any ARV source: a house an
// investor bought a few months ago and hasn't resold. What they paid is the
// true as-is investor price, and the resale can't leak into anyone's comps.
//
// Pure. scripts/kc-flips.mjs feeds it King County's assessor files;
// scripts/price-bakeoff.mjs reads what that writes.

export const FLIP_MAX_MONTHS = 18;
// Less than this over the purchase is a resale, not a flip.
export const FLIP_MIN_GAIN = 0.15;
// Two weeks: anything quicker is a paperwork re-deed.
export const FLIP_MIN_MONTHS = 0.5;
export const RATIO_WINDOW_MONTHS = 24;
// Fewer flips than this in a ZIP and the county ratio stands in.
export const RATIO_MIN_N = 5;

const MONTH_MS = 30.44 * 24 * 3600 * 1000;
export const monthsBetween = (a, b) => (b - a) / MONTH_MS;

// Words that make a buyer a business. Trusts are left out on purpose: most of
// them are families holding their own house.
const ENTITY = /\b(LLC|L L C|INC|CORP|CORPORATION|CO|COMPANY|LP|LLP|HOMES|PROPERTIES|PROPERTY|INVESTMENTS?|INVESTORS?|CAPITAL|HOLDINGS?|GROUP|PARTNERS|DEVELOPMENT|REAL ESTATE|VENTURES|ENTERPRISES|BUILDERS|CONSTRUCTION|REALTY|FUND|ASSETS?)\b/;
export const isEntityName = (name) => ENTITY.test(String(name || "").toUpperCase());

// One spelling per buyer. The county writes "ACME HOMES LLC", "ACME HOMES, LLC"
// and "ACME HOMES L L C" for the same company across two deeds; the legal
// suffix and the punctuation carry no identity.
const SUFFIX = new Set(["LLC", "L", "C", "INC", "CORP", "CORPORATION", "CO", "THE", "LP", "LLP", "A", "WA", "WASHINGTON"]);
export function nameKey(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w && !SUFFIX.has(w)).join(" ");
}

// A deed that conveys several parcels for one price says nothing about any one
// of them. Rows: { excise, parcel, ... }.
export function singleParcelSales(rows = []) {
  const parcels = new Map();
  for (const r of rows) {
    if (!r.excise) continue;
    (parcels.get(r.excise) || parcels.set(r.excise, new Set()).get(r.excise)).add(r.parcel);
  }
  return rows.filter((r) => !r.excise || parcels.get(r.excise).size === 1);
}

const byParcel = (rows) => {
  const m = new Map();
  for (const r of rows) (m.get(r.parcel) || m.set(r.parcel, []).get(r.parcel)).push(r);
  for (const list of m.values()) list.sort((a, b) => a.at - b.at);
  return m;
};

/**
 * flipPairs(sales) — every buy-then-resell by the same owner.
 * sales: [{ parcel, at (ms), price, buyer, seller }]
 * → [{ parcel, boughtAt, bought, soldAt, sold, months, ratio }]
 */
export function flipPairs(sales = [], { maxMonths = FLIP_MAX_MONTHS, minGain = FLIP_MIN_GAIN } = {}) {
  const out = [];
  for (const [parcel, list] of byParcel(sales)) {
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      const months = monthsBetween(a.at, b.at);
      if (months < FLIP_MIN_MONTHS || months > maxMonths) continue;
      if (!(a.price > 0) || b.price < a.price * (1 + minGain)) continue;
      const key = nameKey(a.buyer);
      if (!key || key !== nameKey(b.seller)) continue;
      out.push({ parcel, flipper: key, boughtAt: a.at, bought: a.price, soldAt: b.at, sold: b.price, months, ratio: a.price / b.price });
    }
  }
  return out;
}

/**
 * dropRebuilds(pairs, buildings) — keep flips of one existing house.
 * buildings: Map parcel → { yearBuilt, units }. A house built in or after the
 * year the investor bought is new construction: they bought the land. No
 * building on record, or more than one unit, isn't the house we price.
 */
export function dropRebuilds(pairs = [], buildings = new Map()) {
  const kept = [], dropped = [];
  for (const p of pairs) {
    const b = buildings.get(p.parcel);
    const boughtYear = new Date(p.boughtAt).getUTCFullYear();
    const reason = !b ? "no house on record" : b.units > 1 ? "more than one unit" : b.yearBuilt >= boughtYear ? "built after the buy" : null;
    (reason ? dropped : kept).push(reason ? { ...p, reason } : p);
  }
  return { kept, dropped };
}

const quantile = (sorted, q) => sorted[Math.floor(q * (sorted.length - 1))];
function spread(ratios) {
  const s = [...ratios].sort((a, b) => a - b);
  if (!s.length) return { n: 0, median: null, p25: null, p75: null };
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { n: s.length, median: r3(quantile(s, 0.5)), p25: r3(quantile(s, 0.25)), p75: r3(quantile(s, 0.75)) };
}

/**
 * ratioTable(pairs, { asOf, zipOf }) — the buy/resale ratio by ZIP and
 * county-wide, from flips resold in the window before asOf.
 */
export function ratioTable(pairs = [], { asOf = Date.now(), windowMonths = RATIO_WINDOW_MONTHS, zipOf = () => null } = {}) {
  const from = asOf - windowMonths * MONTH_MS;
  const recent = pairs.filter((p) => p.soldAt <= asOf && p.soldAt >= from);
  const zips = {};
  for (const p of recent) {
    const z = zipOf(p.parcel);
    if (z) (zips[z] ||= []).push(p.ratio);
  }
  return {
    asOf, windowMonths,
    county: spread(recent.map((p) => p.ratio)),
    zips: Object.fromEntries(Object.entries(zips).map(([z, r]) => [z, spread(r)])),
  };
}

/**
 * investorPrice({ arv, zip, table }) — what a flipper pays for the house as-is,
 * at the share of the finished price investors have paid nearby.
 * → { price, ratio, n, basis: "zip" | "county" } | null
 */
export function investorPrice({ arv, zip, table, minN = RATIO_MIN_N } = {}) {
  if (!(arv > 0) || !table) return null;
  const local = zip && table.zips?.[zip];
  const use = local && local.n >= minN ? { ...local, basis: "zip" } : table.county?.n ? { ...table.county, basis: "county" } : null;
  if (!use?.median) return null;
  return { price: Math.round((arv * use.median) / 250) * 250, ratio: use.median, n: use.n, basis: use.basis };
}

/**
 * openInvestorBuys(sales, { asOf, flippers }) — the answer key: a business bought
 * the parcel between minMonths and maxMonths before asOf and nobody has bought
 * it since. A company buying a house may be a builder after the lot, and a
 * teardown's price says nothing about a flip; given `flippers` (name keys from
 * flipPairs), only buyers who have flipped a house before count.
 * → [{ parcel, boughtAt, bought }]
 */
export function openInvestorBuys(sales = [], { asOf = Date.now(), minMonths = 2, maxMonths = 6, flippers = null } = {}) {
  const out = [];
  for (const [parcel, list] of byParcel(sales)) {
    const last = list[list.length - 1];
    const age = monthsBetween(last.at, asOf);
    if (age < minMonths || age > maxMonths || !isEntityName(last.buyer) || !(last.price > 0)) continue;
    if (flippers && !flippers.has(nameKey(last.buyer))) continue;
    out.push({ parcel, boughtAt: last.at, bought: last.price });
  }
  return out;
}
