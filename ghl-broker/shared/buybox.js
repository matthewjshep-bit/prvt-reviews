// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// buybox.js — the investor buy box: normalize it out of GHL custom fields,
// flatten it to a profile string, and decide whether a property (or a search
// query) fits it. Pure functions, no I/O; the one import is the area reader
// (shared/dispo-regions.js). Shared by the broker (dispositions search) and
// the frontend (chips, filters, badges).
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

import { areaVerdict } from "./dispo-regions.js";

/* ---------- vocabularies ---------- */

// Mirrors INVESTOR_ENRICH_FIELDS.buybox_property_types.values. `manufactured`
// (2026-10-01) is a mobile or manufactured home — shared/asset-type.js says
// which deals are one.
export const PROPERTY_TYPES = ["sfr", "townhouse", "condo", "multi_family", "land", "manufactured"];

// What a person (or the model) writes for a kind we already have a word for.
const PROPERTY_TYPE_ALIASES = { single_family: "sfr", mobile: "manufactured", mobile_home: "manufactured", mobile_homes: "manufactured" };

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
  manufactured: "Manufactured / mobile",
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
    .map((t) => PROPERTY_TYPE_ALIASES[t] || t)
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
    // How they pay (the buyer_funding fact). Not a buy box criterion: no
    // deal is matched or ruled out on it.
    funding: BUYER_FUNDING.includes(String(c.buyer_funding || "").trim()) ? String(c.buyer_funding).trim() : null,
  };
}

/* ---------- how they pay ---------- */

// 2026-11-09: how a buyer pays was unknown in 283 of 307 buyer threads, and
// a buyer who took a contract was still lining up money days later. What
// they say is filed as the `buyer_funding` fact (shared/contact-record.js)
// and shown on the deal's buyer row. The words match the read's "How they
// pay" column (shared/investor-read.js FUNDING) plus a HELOC.
export const BUYER_FUNDING = ["cash", "hard_money", "private_money", "heloc", "conventional", "dscr", "partners"];
export const BUYER_FUNDING_LABELS = {
  cash: "cash", hard_money: "hard money", private_money: "private money", heloc: "HELOC",
  conventional: "conventional loan", dscr: "DSCR loan", partners: "partners",
};
const FUNDING_CUES = [
  ["hard_money", /\bhard[\s-]?money\b|\bhml\b/gi],
  ["private_money", /\bprivate\s+(?:money|lenders?|capital|funds?|investors?)\b/gi],
  ["heloc", /\bheloc\b|\bhome\s+equity\s+line\b/gi],
  ["dscr", /\bdscr\b/gi],
  ["conventional", /\bconventional\s+(?:loans?|financing|mortgages?|lenders?)\b|\bfha\b|\bva\s+loans?\b/gi],
  ["partners", /\b(?:my|our)\s+(?:money\s+|capital\s+|equity\s+)?partners?\s+(?:fund|funds|put\s+up|bring|brings|cover|covers|finance|finances)\b|\bfunded\s+by\s+(?:my|our)\s+(?:partners?|investors?)\b|\bpartner\s+money\b/gi],
  ["cash", /\bcash\s*(?:or|and|\/|&)\s*(?:hard|private|heloc|dscr|conventional|a\s+loan|financing)\b|\ball[\s-]cash\b|\bpay(?:ing)?\s+(?:all\s+)?cash\b|\bpaid\s+(?:all\s+)?cash\b|\b(?:buy|buying|close|closing|purchase|purchasing)\s+(?:with\s+|in\s+|all\s+)?cash\b|\bcash\s+buyers?\b|\b(?:i'?m|we'?re|i\s+am|we\s+are)\s+(?:a\s+)?cash\b|\b(?:my|our)\s+own\s+cash\b|\bcash\s+on\s+hand\b/gi],
];
// "not a cash buyer", "no hard money", "don't use a HELOC": a no, not a yes.
const NOT_BEFORE = /\b(?:not|no|don'?t|do\s+not|never|isn'?t|aren'?t|without|won'?t)\b(?:\s+\w+){0,2}\s*$/i;
// "Would the seller take hard money?" is a question, not how they pay.
const inQuestion = (t, to) => {
  const end = t.slice(to).search(/[.!?\n]/);
  return end >= 0 && t[to + end] === "?";
};

/**
 * fundingSaid(text) → one of BUYER_FUNDING, or null
 *
 * How a buyer said they pay, in their own words: the first way they named,
 * outside a question and not after a no.
 */
export function fundingSaid(text = "") {
  const t = String(text || "");
  let best = null;
  for (const [value, rx] of FUNDING_CUES) {
    for (const m of t.matchAll(rx)) {
      if (NOT_BEFORE.test(t.slice(Math.max(0, m.index - 30), m.index))) continue;
      if (inQuestion(t, m.index + m[0].length)) continue;
      if (!best || m.index < best.at) best = { value, at: m.index };
      break;
    }
  }
  return best?.value || null;
}

// The day they said it, in Pacific time wherever this runs.
const saidDay = (at) => {
  const d = at ? new Date(at) : null;
  if (!d || !Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "America/Los_Angeles" });
};

/** paysLine({ value, at }) → "pays: hard money (said 10/30)" | "pays: unknown" */
export function paysLine(fact) {
  const label = BUYER_FUNDING_LABELS[fact?.value];
  if (!label) return "pays: unknown";
  const day = saidDay(fact.at);
  return `pays: ${label}${day ? ` (said ${day})` : ""}`;
}

/**
 * buyerMoneyLine(fact, { committed, proofOnFile }) → the deal's buyer row line
 *
 * How they pay, and for the buyer who committed, "no proof of funds on file"
 * until the checklist's proof of funds item (shared/deal-checklist.js
 * assignee_funds) is ticked.
 */
export function buyerMoneyLine(fact, { committed = false, proofOnFile = false } = {}) {
  const pays = paysLine(fact);
  return committed && !proofOnFile ? `${pays} · no proof of funds on file` : pays;
}

/* ---------- what their own words refuse ---------- */

// 2026-11-09: a builder whose buy box said "land only, no rehabs" was sent
// three fixers, and buyers whose box said "not buying right now" got every
// deal. These are their own words in the must-haves / dealbreakers field
// (buybox_exclusions), the same field the street and island rules read
// (shared/buyer-score.js buyerDealbreakers). Each only ever narrows.
//
// "no rehabs over 100k" is a limit, not a no; "not buying condos" is a kind
// of house, not a pause; "not in the market for land" is a kind too.
const NO_REHAB_RX = /\b(?:no|not|no\s+more|not\s+doing|not\s+interested\s+in|(?:don'?t|doesn'?t|won'?t|do\s+not)\s+(?:do|want))\s+(?:any\s+)?(?:rehabs?|flips?|fix[\s-]?ups?|fix[\s-]?and[\s-]?flips?|fixers?|remodels?|renovations?)\b(?!\s+(?:over|above|under|below|more|less|bigger|larger|in|on|with|that|where|unless|past|beyond)\b)/i;
const GROUND_UP_RX = /\b(?:ground[\s-]?up|new[\s-]construction|infill|land|lots?|build(?:s|ing)?|new\s+builds?)\s+only\b|\bonly\s+(?:do\s+|does\s+|doing\s+|want\s+)?(?:ground[\s-]?up|new[\s-]construction|infill|land|lots?|new\s+builds?)\b/i;
const NOT_BUYING_RX = [
  /\bnot\s+(?:currently\s+)?buying(?:\s+(?:right\s+now|now|at\s+the\s+moment|currently|this\s+(?:year|month|quarter)|for\s+(?:a|the)\s+while|anything|anymore|any\s+more|until\b[^.;,!]*))?\s*(?:[.;,!)]|$)/im,
  /\b(?:buying\s+(?:is\s+)?)?on\s+hold\b/i,
  /\bpaus(?:ed|ing)\b/i,
  /\btaking\s+a\s+break\b/i,
  /\b(?:not|out\s+of)\s+(?:in\s+)?the\s+market\b(?!\s+for\b)/i,
];

/**
 * ownWords(text) → { noRehabs, groundUpOnly, notBuying }
 *
 * What a buyer's saved dealbreakers say no to beyond the street: any rehab,
 * anything but ground-up, or any deal at all right now.
 */
export function ownWords(text = "") {
  const t = String(Array.isArray(text) ? text.join("; ") : text || "");
  return {
    noRehabs: NO_REHAB_RX.test(t),
    groundUpOnly: GROUND_UP_RX.test(t),
    notBuying: NOT_BUYING_RX.some((rx) => rx.test(t)),
  };
}

/**
 * ownWordsRefuse(words, { rehabDeal }) → why, or null
 *
 * `rehabDeal` is true when the deal is a house to fix (shared/buyer-score.js
 * dealTarget), false for land, null when nothing says which: an unknown
 * deal abstains.
 */
export function ownWordsRefuse(words = {}, { rehabDeal = null } = {}) {
  if (words.notBuying) return "they're not buying right now";
  if (rehabDeal === true && words.groundUpOnly) return "they only build ground-up";
  if (rehabDeal === true && words.noRehabs) return "they said no rehabs";
  return null;
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
export function matchBuybox(buybox = {}, query = {}, { strict = false, fallbackAreas = [], deal = null } = {}) {
  // No areas on file, but we know where they have actually bought (a borrower
  // list): answer the areas question from that rather than abstaining.
  const fallback = !buybox?.areas?.length && fallbackAreas?.length > 0;
  const b = fallback ? { ...buybox, areas: fallbackAreas, areasRaw: "" } : (buybox || {});
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

  // Against a deal (Find buyers, 2026-11-09), areas are read the way the
  // deal sends read them (shared/dispo-regions.js areaVerdict): "Eastside"
  // holds Bellevue, "West Seattle" doesn't hold Green Lake, "not Bellevue"
  // rules it out. A phrase it can't place falls back to the text match.
  const said = deal && q.areas?.length && b.areas?.length ? areaVerdict(String(b.areasRaw || "").trim() || b.areas, deal) : null;
  if (said?.refused || said?.elsewhere) missed.push("areas");
  else if (said?.fit) matched.push("areas");
  else verdict("areas", q.areas?.length > 0, b.areas?.length > 0, areasOverlap(b.areas || [], q.areas || []));
  // Their own words against the deal: not buying, or no rehabs on a fixer.
  if (deal && ownWordsRefuse(ownWords(b.exclusions), { rehabDeal: deal.rehabDeal ?? null })) missed.push("their words");

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
export function applyBuyboxFilters(investors = [], query = {}, { strict = false, deal = null } = {}) {
  const q = normalizeQuery(query);
  const out = [];
  for (const inv of investors) {
    const match = matchBuybox(inv.buybox, q, { strict, fallbackAreas: inv.fallbackAreas || [], deal });
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
