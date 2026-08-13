// buybox.js — the investor buy box: normalize it out of GHL custom fields,
// flatten it to a profile string, and decide whether a property (or a search
// query) fits it. Pure functions, no I/O, no deps. Shared by the broker
// (dispositions search) and the frontend (chips, filters, badges).
//
// The field vocabulary is NOT defined here — it lives in ghl-broker/enrich.js
// (INVESTOR_ENRICH_FIELDS), which is what the AI enrichment sweep writes into
// GHL. This module mirrors the two closed vocabularies it has to reason about
// (property types, rehab appetite) and is the single place that knows what
// those values MEAN. Keep them in sync; enrich.js is the source of truth for
// what the AI may emit, this file is the source of truth for how it's read.
//
// Two rules make matching honest rather than decorative — the same logic as
// comp-match.js, for the same reason:
//
//   1. **Missing data abstains, it never fails.** A buy box with no stated
//      price band is not a buyer who refuses every price; it's a buyer nobody
//      has asked yet. Punishing them would rank thoroughly-documented mediocre
//      buyers above the guy who closed three deals last quarter.
//   2. **Bands overlap, they don't contain.** An investor who buys $200-400k
//      is a candidate for a $380-450k deal. Requiring containment throws away
//      every buyer whose stated range is narrower than the asking spread,
//      which is most of them.
//
// So a criterion only removes an investor when their buy box actively
// CONTRADICTS the query. Everything else survives to the ranking stage, where
// the model can weigh it against the conversation history.

/* ---------- vocabularies ---------- */

// Mirrors INVESTOR_ENRICH_FIELDS.buybox_property_types.values.
export const PROPERTY_TYPES = ["sfr", "townhouse", "condo", "multi_family", "land"];

// Mirrors INVESTOR_ENRICH_FIELDS.rehab_appetite.values, ORDERED — the index is
// the rank. Appetite is read as a CEILING ("the worst I'll take on"), so an
// investor at `heavy` is a candidate for a `moderate` deal but not a `full_gut`
// one. This is the one place that ordering is encoded.
export const REHAB_APPETITES = ["cosmetic_only", "moderate", "heavy", "full_gut"];

export const rehabRank = (v) => {
  const i = REHAB_APPETITES.indexOf(String(v || "").trim().toLowerCase());
  return i === -1 ? null : i;
};

export const PROPERTY_TYPE_LABELS = {
  sfr: "Single family",
  townhouse: "Townhouse",
  condo: "Condo",
  multi_family: "Multi-family",
  land: "Land",
};

export const REHAB_APPETITE_LABELS = {
  cosmetic_only: "Cosmetic only",
  moderate: "Moderate",
  heavy: "Heavy",
  full_gut: "Full gut",
};

/* ---------- parsing helpers ---------- */

// Money out of a GHL NUMERICAL field, which arrives as anything from 400000 to
// "$400,000" to "400k" depending on whether a human or the model wrote it.
export function num(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().toLowerCase().replace(/[$,\s]/g, "");
  const m = /^(-?\d*\.?\d+)([km])?$/.exec(s);
  if (!m) {
    // Salvage a number out of something noisier ("approx 400000"), but only
    // when there are actual digits — "n/a" must be null, not 0, or an
    // unanswered field turns into a $0 price floor that matches everything.
    const stripped = s.replace(/[^0-9.-]/g, "");
    if (!/\d/.test(stripped)) return null;
    const x = Number(stripped);
    return Number.isFinite(x) ? x : null;
  }
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  return m[2] === "k" ? base * 1e3 : m[2] === "m" ? base * 1e6 : base;
}

// Comparison form for a place name: lowercase alphanumerics, single-spaced.
// "S. Tacoma Wy" and "south tacoma way" do NOT collapse to the same string and
// deliberately aren't made to — over-normalizing place names starts matching
// "Kent" to "Kentwood". Substring containment (below) does the fuzzy work.
export const normPlace = (v) =>
  String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

// Split a comma/semicolon/newline-separated field into normalized tokens.
export function splitList(v) {
  return String(v == null ? "" : v)
    .split(/[,;\n|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const lowerSet = (list) =>
  [...new Set((list || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];

/* ---------- the buy box ---------- */

// Build a normalized buy box from a contact's flattened GHL custom-field
// record ({ buybox_areas: "Tacoma, 98444", buybox_price_max: "400000", ... }).
// Every field is optional; absent ones come back null/[] and abstain later.
export function normalizeBuybox(custom = {}) {
  const c = custom || {};
  const areasRaw = String(c.buybox_areas || "").trim();
  const typesRaw = String(c.buybox_property_types || "").trim();
  const types = lowerSet(splitList(typesRaw).map((t) => t.replace(/[\s-]+/g, "_")))
    .filter((t) => PROPERTY_TYPES.includes(t));
  const appetite = String(c.rehab_appetite || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return {
    areas: splitList(areasRaw),
    areasRaw,
    priceMin: num(c.buybox_price_min),
    priceMax: num(c.buybox_price_max),
    propertyTypes: types,
    lotMin: num(c.buybox_lot_min),
    rehabAppetite: REHAB_APPETITES.includes(appetite) ? appetite : null,
    exclusions: String(c.buybox_exclusions || "").trim(),
  };
}

// True when the buy box has nothing to match on — the UI flags these as
// "needs a buy box" rather than silently returning them for every search.
export const buyboxIsEmpty = (b) =>
  !b ||
  (!b.areas?.length && b.priceMin == null && b.priceMax == null &&
    !b.propertyTypes?.length && b.lotMin == null && !b.rehabAppetite && !b.exclusions);

/* ---------- profile text ---------- */

const money = (n) =>
  n == null ? null : `$${Math.round(n).toLocaleString("en-US")}`;

const priceBandText = (b) => {
  const lo = money(b.priceMin);
  const hi = money(b.priceMax);
  if (lo && hi) return `${lo}–${hi}`;
  if (hi) return `up to ${hi}`;
  if (lo) return `${lo}+`;
  return null;
};

export { priceBandText, money as formatMoney };

// One compact paragraph per investor: everything the ranker is allowed to
// reason about, and nothing else. This is what gets stored in
// `investors.buybox_text` and what goes into the model prompt, so its size is
// the per-candidate token cost of every search — keep it tight.
export function buildBuyboxProfile(investor = {}, { maxChars = 900 } = {}) {
  const b = investor.buybox || {};
  const lines = [];
  const tags = (investor.tags || []).filter(Boolean).slice(0, 6);
  lines.push(`${investor.name || "Unnamed investor"}${tags.length ? ` [${tags.join(", ")}]` : ""}`);
  if (b.areas?.length) lines.push(`Areas: ${b.areas.join(", ")}`);
  const band = priceBandText(b);
  if (band) lines.push(`Price: ${band}`);
  if (b.propertyTypes?.length) {
    lines.push(`Types: ${b.propertyTypes.map((t) => PROPERTY_TYPE_LABELS[t] || t).join(", ")}`);
  }
  if (b.lotMin != null) lines.push(`Min lot: ${Math.round(b.lotMin).toLocaleString("en-US")} sqft`);
  if (b.rehabAppetite) {
    lines.push(`Rehab appetite (max they'll take): ${REHAB_APPETITE_LABELS[b.rehabAppetite] || b.rehabAppetite}`);
  }
  if (b.exclusions) lines.push(`Must-haves / dealbreakers: ${b.exclusions}`);
  if (investor.lastConvoSummary) {
    const when = investor.lastConvoDate ? ` (${String(investor.lastConvoDate).slice(0, 10)})` : "";
    lines.push(`Last conversation${when}: ${investor.lastConvoSummary}`);
  }
  // Newest history lines only — mergeHistory keeps them chronological, so the
  // tail is the recent activity that actually predicts behavior.
  const history = String(investor.dealHistory || "").split(/\r?\n/).filter(Boolean).slice(-4);
  if (history.length) lines.push(`Recent properties:\n${history.join("\n")}`);
  const out = lines.join("\n");
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}

/* ---------- query ---------- */

// The normalized search target. Every field is optional; an absent field means
// "the query didn't say", which abstains rather than filtering.
export const EMPTY_QUERY = {
  areas: [],
  priceMin: null,
  priceMax: null,
  propertyTypes: [],
  lotMin: null,
  rehabAppetite: null,
  keywords: [],
};

// Coerce anything (a model's JSON, a UI filter form) into a valid query.
// Unknown enum values are dropped rather than trusted.
export function normalizeQuery(q = {}) {
  const types = lowerSet((q.propertyTypes || []).map((t) => String(t).replace(/[\s-]+/g, "_")))
    .filter((t) => PROPERTY_TYPES.includes(t));
  const appetite = String(q.rehabAppetite || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  let priceMin = num(q.priceMin);
  let priceMax = num(q.priceMax);
  // A model asked for "$300k-$200k" once. Swap rather than return nothing.
  if (priceMin != null && priceMax != null && priceMin > priceMax) {
    [priceMin, priceMax] = [priceMax, priceMin];
  }
  return {
    areas: splitList((q.areas || []).join(", ")),
    priceMin,
    priceMax,
    propertyTypes: types,
    lotMin: num(q.lotMin),
    rehabAppetite: REHAB_APPETITES.includes(appetite) ? appetite : null,
    keywords: (q.keywords || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 12),
  };
}

export const queryIsEmpty = (q) =>
  !q ||
  (!q.areas?.length && q.priceMin == null && q.priceMax == null &&
    !q.propertyTypes?.length && q.lotMin == null && !q.rehabAppetite);

/* ---------- matching ---------- */

// Does any query place overlap any buy-box place? Containment in EITHER
// direction, because "98444" is inside "Spanaway 98444" and "Tacoma" is inside
// "South Tacoma" — and a wholesaler typing either one means the same thing.
function areasOverlap(boxAreas, queryAreas) {
  const box = boxAreas.map(normPlace).filter(Boolean);
  const want = queryAreas.map(normPlace).filter(Boolean);
  for (const w of want) {
    for (const b of box) {
      if (b === w || b.includes(w) || w.includes(b)) return true;
    }
  }
  return false;
}

// Closed-interval overlap where null means unbounded on that side.
const bandsOverlap = (aLo, aHi, bLo, bHi) =>
  (aLo == null || bHi == null || aLo <= bHi) && (bLo == null || aHi == null || bLo <= aHi);

// Score one buy box against one query.
//
// Returns { matched, missed, abstained, pass, score }; the three arrays
// partition the five criteria (areas, price, propertyTypes, rehab, lot) and
// `pass` is `missed.length === 0` (loose) — see the header: only an active
// contradiction removes an investor. In `strict` mode a criterion the query
// stated but the buy box is silent on counts as a miss, which is how you go
// from "everyone plausible" to "only documented fits".
//
// `score` is a deterministic 0-100 used to order results when the model isn't
// involved (no API key, a ranking failure, or plain browsing with filters).
export function matchBuybox(buybox = {}, query = {}, { strict = false } = {}) {
  const b = buybox || {};
  const q = query || {};
  const matched = [];
  const missed = [];
  const abstained = [];

  // A criterion the query didn't state is never scored. One it did state but
  // the buy box can't answer abstains — unless strict, where an undocumented
  // buy box is treated as a non-fit.
  const verdict = (name, asked, knowable, ok) => {
    if (!asked) abstained.push(name);
    else if (!knowable) (strict ? missed : abstained).push(name);
    else if (ok) matched.push(name);
    else missed.push(name);
  };

  verdict("areas", q.areas?.length > 0, b.areas?.length > 0, areasOverlap(b.areas || [], q.areas || []));

  verdict(
    "price",
    q.priceMin != null || q.priceMax != null,
    b.priceMin != null || b.priceMax != null,
    bandsOverlap(q.priceMin, q.priceMax, b.priceMin, b.priceMax)
  );

  verdict(
    "propertyTypes",
    q.propertyTypes?.length > 0,
    b.propertyTypes?.length > 0,
    (q.propertyTypes || []).some((t) => (b.propertyTypes || []).includes(t))
  );

  // Appetite is a ceiling: the investor must tolerate AT LEAST what the deal needs.
  const wantRank = rehabRank(q.rehabAppetite);
  const hasRank = rehabRank(b.rehabAppetite);
  verdict("rehab", wantRank != null, hasRank != null, hasRank >= wantRank);

  // The deal's lot must clear the investor's stated minimum.
  verdict("lot", q.lotMin != null, b.lotMin != null, q.lotMin >= b.lotMin);

  // Matches of KNOWABLE criteria, on the comp-match principle that a gap in
  // someone's CRM shouldn't read as a worse fit than a documented near-miss.
  const denom = matched.length + missed.length;
  const score = denom === 0 ? 0 : Math.round((matched.length / denom) * 100);

  return { matched, missed, abstained, pass: missed.length === 0, score };
}

// Filter + pre-score a list of investors. Each investor needs `.buybox`;
// everything else is carried through untouched. Returns the survivors, already
// ordered best-first, each annotated with `.match`.
export function applyBuyboxFilters(investors = [], query = {}, { strict = false } = {}) {
  const q = normalizeQuery(query);
  const out = [];
  for (const inv of investors) {
    const match = matchBuybox(inv.buybox, q, { strict });
    if (match.pass) out.push({ ...inv, match });
  }
  // Score first, then more matched criteria (a 100 from one criterion is a
  // weaker signal than a 100 from four), then name for a stable order.
  out.sort(
    (a, b) =>
      b.match.score - a.match.score ||
      b.match.matched.length - a.match.matched.length ||
      String(a.name || "").localeCompare(String(b.name || ""))
  );
  return out;
}

/* ---------- chips ---------- */

// Human-readable summary of a query, for the "here's what I understood" chip
// row under the search box. Each chip carries the query field it came from so
// the UI can drop it and re-run.
export function queryChips(query = {}) {
  const q = normalizeQuery(query);
  const chips = [];
  for (const a of q.areas) chips.push({ field: "areas", value: a, label: a });
  const band = priceBandText(q);
  if (band) chips.push({ field: "price", value: null, label: band });
  for (const t of q.propertyTypes) {
    chips.push({ field: "propertyTypes", value: t, label: PROPERTY_TYPE_LABELS[t] || t });
  }
  if (q.rehabAppetite) {
    chips.push({
      field: "rehabAppetite",
      value: q.rehabAppetite,
      label: `${REHAB_APPETITE_LABELS[q.rehabAppetite] || q.rehabAppetite} rehab`,
    });
  }
  if (q.lotMin != null) {
    chips.push({ field: "lotMin", value: q.lotMin, label: `${Math.round(q.lotMin).toLocaleString("en-US")} sqft lot` });
  }
  for (const k of q.keywords) chips.push({ field: "keywords", value: k, label: k });
  return chips;
}

// Remove one chip from a query (the UI's "×" on a parsed chip).
export function removeChip(query, { field, value }) {
  const q = normalizeQuery(query);
  if (field === "price") return { ...q, priceMin: null, priceMax: null };
  if (field === "areas") return { ...q, areas: q.areas.filter((a) => a !== value) };
  if (field === "propertyTypes") return { ...q, propertyTypes: q.propertyTypes.filter((t) => t !== value) };
  if (field === "keywords") return { ...q, keywords: q.keywords.filter((k) => k !== value) };
  if (field === "rehabAppetite") return { ...q, rehabAppetite: null };
  if (field === "lotMin") return { ...q, lotMin: null };
  return q;
}
