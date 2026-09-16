// comp-match.js — how apples-to-apples is a comp, scored against the subject.
// Pure functions, no I/O, no deps. Shared by the broker (comp filtering) and
// the frontend (the match chip and the sort order in the comps list).
//
// The criteria are the ones an appraiser — and any wholesaler who has had a
// deal die at the buyer's inspection — actually checks: same beds and baths,
// same size, same era, same number of stories, same construction, same
// subdivision, close by, and sold recently.
//
// Two rules make this honest rather than decorative:
//
//   1. A criterion where EITHER side lacks the data scores `null`, not a miss,
//      and is excluded from the denominator. Providers return sparse records;
//      punishing a comp for a gap in someone's database would rank real comps
//      below worse ones that happen to be better documented. "5/6" therefore
//      means five of six KNOWABLE criteria matched.
//   2. Nothing here filters. It ranks and it annotates. The comps list still
//      shows every comp, because the person picking them can see things the
//      data can't (a photo of a backyard that backs a freeway).

export const YEAR_BUILT_TOLERANCE = 10;   // ±years — "same era"
export const SQFT_TOLERANCE_PCT = 20;     // ±% living area
export const BATHS_TOLERANCE = 0.5;       // a 2.75-bath comp matches a 3-bath subject
export const DISTANCE_MILES = 1;          // "same neighborhood" for a suburban grid
export const SOLD_MONTHS = 24;            // outer edge of a defensible sale date

const n = (v) => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

// Normalize a free-text fact (subdivision, construction material) for
// comparison: providers vary on case, punctuation and filler words.
const norm = (v) => {
  const s = String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s === "none" || s === "unknown" || s === "n a") return "";
  return s.replace(/\b(div|division|subdivision|add|addition|phase|no|number)\b/g, "").replace(/\s+/g, " ").trim();
};

// Great-circle miles between two {lat, lng} points. Null unless both are real.
//
// This exists because a comp captured from Zillow arrives with coordinates but
// no distance — the comps provider computes that field, a browser grab can't.
// Without it the distance criterion scores `null` and drops out of the
// denominator, which is exactly backwards: the captures are the comps most
// likely to have been grabbed while looking at a different deal, and distance
// is the check that would catch it.
export function milesBetween(a, b) {
  const lat1 = n(a && a.lat), lng1 = n(a && a.lng);
  const lat2 = n(b && b.lat), lng2 = n(b && b.lng);
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const R = 3958.7613; // mean Earth radius, miles
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Months between an ISO-ish date string and `now`. Null when unparseable.
export function monthsSince(dateStr, now = Date.now()) {
  const t = Date.parse(String(dateStr || "").slice(0, 10));
  if (!Number.isFinite(t)) return null;
  return (now - t) / (1000 * 60 * 60 * 24 * 30.44);
}

/**
 * Score one comp against the subject.
 *
 * subject / comp: { beds, baths, sqft, yearBuilt, stories, subdivision,
 *                   material, distance, saleDate } — every field optional.
 *
 * Returns { score, max, pct, checks: [{ key, label, ok, detail }] } where
 * `ok` is true (match), false (miss) or null (not knowable).
 */
export function scoreComp(subject = {}, comp = {}, opts = {}) {
  const {
    yearTolerance = YEAR_BUILT_TOLERANCE,
    sqftPct = SQFT_TOLERANCE_PCT,
    bathsTolerance = BATHS_TOLERANCE,
    distanceMiles = DISTANCE_MILES,
    soldMonths = SOLD_MONTHS,
  } = opts;

  const checks = [];
  const add = (key, label, ok, detail) => checks.push({ key, label, ok, detail });

  // Beds — exact. A 3/2 and a 4/2 are different buyer pools.
  const sb = n(subject.beds), cb = n(comp.beds);
  add("beds", "Beds",
    sb == null || cb == null ? null : Math.round(sb) === Math.round(cb),
    cb == null ? "comp beds unknown" : `${cb} vs ${sb ?? "?"}`);

  // Baths — ±0.5 so quarter-bath bookkeeping differences don't count as a miss.
  const sba = n(subject.baths), cba = n(comp.baths);
  add("baths", "Baths",
    sba == null || cba == null ? null : Math.abs(sba - cba) <= bathsTolerance,
    cba == null ? "comp baths unknown" : `${cba} vs ${sba ?? "?"}`);

  // Size — ±20% living area.
  const ss = n(subject.sqft), cs = n(comp.sqft);
  add("sqft", `Size ±${sqftPct}%`,
    ss == null || cs == null || ss <= 0 ? null : Math.abs(cs - ss) / ss <= sqftPct / 100,
    cs == null ? "comp sqft unknown" : `${cs.toLocaleString()} vs ${ss ? ss.toLocaleString() : "?"} sqft`);

  // Era — ±10 years.
  const sy = n(subject.yearBuilt), cy = n(comp.yearBuilt);
  add("year", `Built ±${yearTolerance} yrs`,
    sy == null || cy == null ? null : Math.abs(sy - cy) <= yearTolerance,
    cy == null ? "comp year unknown" : `${cy} vs ${sy ?? "?"}`);

  // Stories — a two-story and a rambler of the same size sell differently.
  const sst = n(subject.stories), cst = n(comp.stories);
  add("stories", "Stories",
    sst == null || cst == null ? null : Math.round(sst) === Math.round(cst),
    cst == null ? "comp stories unknown" : `${cst} vs ${sst ?? "?"}`);

  // Construction / build material.
  const smat = norm(subject.material), cmat = norm(comp.material);
  add("material", "Build material",
    !smat || !cmat ? null : smat === cmat,
    cmat ? `${comp.material} vs ${subject.material || "?"}` : "comp material unknown");

  // Subdivision — the strongest single signal when it's available, because it
  // holds schools, lot sizes, builder and HOA constant all at once.
  const ssub = norm(subject.subdivision), csub = norm(comp.subdivision);
  add("subdivision", "Same subdivision",
    !ssub || !csub ? null : ssub === csub,
    csub ? `${comp.subdivision} vs ${subject.subdivision || "?"}` : "comp subdivision unknown");

  // Distance.
  const d = n(comp.distance);
  add("distance", `Within ${distanceMiles} mi`,
    d == null ? null : d <= distanceMiles,
    d == null ? "distance unknown" : `${d} mi`);

  // Sale recency. Deliberately the LAST criterion and the widest tolerance:
  // going back in time is the concession we prefer to make.
  const ms = monthsSince(comp.saleDate);
  add("sold", `Sold ≤ ${soldMonths} mo`,
    ms == null ? null : ms <= soldMonths,
    ms == null ? "sale date unknown" : `${Math.round(ms)} mo ago`);

  const known = checks.filter((c) => c.ok !== null);
  const score = known.filter((c) => c.ok).length;
  const max = known.length;
  return { score, max, pct: max ? score / max : 0, checks };
}

/* ---------- condition without opening the photos ---------- */

// The pool has to be big enough for "the top of it" to mean anything. Calling
// the best 4 of 4 comps renovated is circular — it just says "these are the
// comps". Below this, the proxy refuses rather than pretending.
export const PRICE_PROXY_MIN_POOL = 6;

/**
 * Mark the likeliest-renovated comps by price, for an ARV that doesn't need a
 * vision model.
 *
 * Grading condition from listing photos is accurate and expensive — a scrape
 * plus a multi-image model call per comp. Inside a set already filtered to the
 * same beds and baths, ±20% floor area, and half a mile, most of what's left
 * to explain the price spread IS condition. So the top of that spread is a
 * defensible stand-in for "renovated".
 *
 * Two things make it honest rather than convenient:
 *
 *   1. It ranks by $/SQFT, not by price. Even inside a ±20% size band the
 *      biggest house usually posts the biggest number, so ranking on price
 *      would mostly re-discover square footage. Dividing it out leaves the
 *      finish premium, which is the thing we're actually after.
 *   2. The unpicked comps are left UNKNOWN, never labelled "dated". We have no
 *      evidence about them; deriveArv ignores unknowns, which is correct.
 *
 * The marked comps carry `conditionSource: "price"` so nothing downstream — a
 * PDF, a review panel, a person six weeks later — can mistake this for someone
 * having looked at the kitchen.
 *
 * Returns { comps, applied, pool, reason }.
 */
export function markRenovatedByPrice(comps = [], { take = 4, minPool = PRICE_PROXY_MIN_POOL } = {}) {
  const priced = comps.filter((c) => n(c.price) > 0);
  if (priced.length < minPool) {
    return {
      comps,
      applied: false,
      pool: priced.length,
      reason: `only ${priced.length} priced comps — the price proxy needs ${minPool} to have a top tier`,
    };
  }

  // A comp with no sqft on record is ranked against the pool's typical size
  // rather than dropped: it survived the ±20% filter, so this is the least
  // wrong assumption available.
  const sizes = priced.map((c) => n(c.sqft)).filter((x) => x > 0).sort((a, b) => a - b);
  const typical = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const ppsf = (c) => {
    const s = n(c.sqft) > 0 ? n(c.sqft) : typical;
    return s > 0 ? n(c.price) / s : n(c.price);
  };

  const ranked = [...priced].sort((a, b) => ppsf(b) - ppsf(a));
  const winners = new Set(ranked.slice(0, Math.min(take, ranked.length)).map((c) => c.id));

  return {
    comps: comps.map((c) =>
      winners.has(c.id)
        ? { ...c, condition: "renovated", conditionSource: "price", ppsf: Math.round(ppsf(c)) }
        : c
    ),
    applied: true,
    pool: priced.length,
    reason: `top ${winners.size} of ${priced.length} comps by $/sqft, taken as renovated`,
  };
}

/* ============================================================= *
 * similarity — how close, not just whether it passes
 * ============================================================= */

// The scorecard above counts votes, and on the Zillow source most of the
// votes are unknowable (no year built, stories, material or subdivision on a
// search row), so a whole ring ties at 4/5 and the pick falls to $/sqft.
// That is how the priciest house nearby became the ARV evidence: the
// post-mortem of 2026-09-10 found buyers pay ≤70% of ARV less repairs and the
// three dead deals were priced off ARVs that were too high.
//
// This is the continuous version, for RANKING: each factor is a 0–1 closeness
// with a linear taper, weighted by how much it moves value, and a factor
// nobody knows leaves the denominator (rule 1 above, kept). Distance leads —
// a comp across the street says more about a lot, a school and a street
// than any field on a listing card. The scorecard stays for the ✓/✗ lines;
// nothing here filters, either.
export const SIM_WEIGHTS = { distance: 25, sqft: 20, beds: 15, baths: 10, yearBuilt: 15, recency: 10, lot: 5 };
export const SIM_DISTANCE_FULL_MI = 0.25;  // 1.0 out to here, 0 at the ring edge
export const SIM_SQFT_FULL_PCT = 10;       // 1.0 inside ±10% …
export const SIM_SQFT_FULL_ABS = 300;      // … or ±300 sqft, whichever is wider (Matt's rule)
export const SIM_SQFT_ZERO_PCT = 30;       // 0 at ±30%
export const SIM_YEAR_FULL = 5;            // 1.0 inside ±5 years
export const SIM_YEAR_ZERO = 25;           // 0 at ±25
export const SIM_RECENCY_FULL_MO = 6;      // 1.0 inside six months
export const SIM_RECENCY_ZERO_MO = 24;     // 0 at two years
export const SIM_LOT_ZERO_PCT = 50;        // 0 at a lot half or twice the size

// 1 up to `full`, straight line down to 0 at `zero`.
const taper = (x, full, zero) => (x <= full ? 1 : x >= zero ? 0 : 1 - (x - full) / (zero - full));

/**
 * similarity(subject, comp, { radiusMiles, now }) →
 *   { score: 0–100 | null, known, factors: [{ key, label, weight, value, detail }] }
 *
 * `value` is 0–1, or null when either side lacks the fact (and the weight is
 * then left out of `known`). `score` is null when nothing was knowable.
 */
export function similarity(subject = {}, comp = {}, { radiusMiles = DISTANCE_MILES, now = Date.now() } = {}) {
  const factors = [];
  const add = (key, label, weight, value, detail) => factors.push({ key, label, weight, value, detail });

  const d = n(comp.distance);
  add("distance", "Distance", SIM_WEIGHTS.distance,
    d == null ? null : taper(d, SIM_DISTANCE_FULL_MI, Math.max(radiusMiles, SIM_DISTANCE_FULL_MI + 0.05)),
    d == null ? "distance unknown" : `${Math.round(d * 100) / 100} mi`);

  const ss = n(subject.sqft), cs = n(comp.sqft);
  if (ss == null || cs == null || ss <= 0 || cs <= 0) add("sqft", "Size", SIM_WEIGHTS.sqft, null, "sqft unknown");
  else {
    const pct = Math.abs(cs - ss) / ss * 100;
    const value = Math.abs(cs - ss) <= SIM_SQFT_FULL_ABS ? 1 : taper(pct, SIM_SQFT_FULL_PCT, SIM_SQFT_ZERO_PCT);
    add("sqft", "Size", SIM_WEIGHTS.sqft, value, `${cs.toLocaleString()} vs ${ss.toLocaleString()} sqft (${cs >= ss ? "+" : "−"}${Math.round(pct)}%)`);
  }

  const sb = n(subject.beds), cb = n(comp.beds);
  if (sb == null || cb == null) add("beds", "Beds", SIM_WEIGHTS.beds, null, "beds unknown");
  else {
    const gap = Math.abs(Math.round(sb) - Math.round(cb));
    add("beds", "Beds", SIM_WEIGHTS.beds, gap === 0 ? 1 : gap === 1 ? 0.4 : 0, `${cb} vs ${sb}`);
  }

  const sba = n(subject.baths), cba = n(comp.baths);
  if (sba == null || cba == null) add("baths", "Baths", SIM_WEIGHTS.baths, null, "baths unknown");
  else {
    const gap = Math.abs(sba - cba);
    add("baths", "Baths", SIM_WEIGHTS.baths, gap === 0 ? 1 : gap <= 0.5 ? 0.7 : gap <= 1 ? 0.3 : 0, `${cba} vs ${sba}`);
  }

  const sy = n(subject.yearBuilt), cy = n(comp.yearBuilt);
  if (sy == null || cy == null) add("yearBuilt", "Year built", SIM_WEIGHTS.yearBuilt, null, "year built unknown");
  else add("yearBuilt", "Year built", SIM_WEIGHTS.yearBuilt, taper(Math.abs(sy - cy), SIM_YEAR_FULL, SIM_YEAR_ZERO), `${cy} vs ${sy}`);

  const ms = monthsSince(comp.saleDate, now);
  add("recency", "Sold", SIM_WEIGHTS.recency,
    ms == null ? null : taper(Math.max(0, ms), SIM_RECENCY_FULL_MO, SIM_RECENCY_ZERO_MO),
    ms == null ? "sale date unknown" : `${Math.round(Math.max(0, ms))} mo ago`);

  const sl = n(subject.lotSqft), cl = n(comp.lotSqft);
  if (sl == null || cl == null || sl <= 0 || cl <= 0) add("lot", "Lot", SIM_WEIGHTS.lot, null, "lot unknown");
  else add("lot", "Lot", SIM_WEIGHTS.lot, taper(Math.abs(cl - sl) / sl * 100, 0, SIM_LOT_ZERO_PCT), `${Math.round(cl).toLocaleString()} vs ${Math.round(sl).toLocaleString()} sqft`);

  const knownFactors = factors.filter((f) => f.value != null);
  const known = knownFactors.reduce((t, f) => t + f.weight, 0);
  const sum = knownFactors.reduce((t, f) => t + f.weight * f.value, 0);
  return { score: known ? Math.round((100 * sum) / known) : null, known, factors };
}

// The chip: "84", or "—" when nothing is knowable. Coarse tones on purpose —
// a glanceable signal, not a number to optimise.
export const similarityLabel = (s) => (s && s.score != null ? String(s.score) : "—");
export function similarityTone(s) {
  if (!s || s.score == null) return "unknown";
  if (s.score >= 80) return "strong";
  if (s.score >= 60) return "fair";
  return "weak";
}

/**
 * inPool(subject, comp, { bedsTol, bathsTol, sqftPct, yearTol }) → { ok, misses }
 *
 * The LOOSE gate — what gets to be ranked at all. Matt, 2026-09-16: keep it as
 * wide as the pull bands already are (beds ±1, baths ±1, size ±25%) plus era
 * ±15 years now that year built can be known, so runs don't hold more often;
 * the accuracy comes from the ranking above, not from a tighter door. Unknown
 * facts pass, as everywhere in this file.
 */
export function inPool(subject = {}, comp = {}, { bedsTol = 1, bathsTol = 1, sqftPct = 25, yearTol = 15 } = {}) {
  const misses = [];
  const sb = n(subject.beds), cb = n(comp.beds);
  if (sb != null && cb != null && Math.abs(Math.round(sb) - Math.round(cb)) > bedsTol) misses.push("beds");
  const sba = n(subject.baths), cba = n(comp.baths);
  if (sba != null && cba != null && Math.abs(sba - cba) > bathsTol) misses.push("baths");
  const ss = n(subject.sqft), cs = n(comp.sqft);
  if (ss != null && cs != null && ss > 0 && cs > 0 && Math.abs(cs - ss) / ss > sqftPct / 100) misses.push("sqft");
  const sy = n(subject.yearBuilt), cy = n(comp.yearBuilt);
  if (sy != null && cy != null && Math.abs(sy - cy) > yearTol) misses.push("yearBuilt");
  return { ok: misses.length === 0, misses };
}

// Sort helper: most similar first when both sides carry a similarity score,
// else best scorecard match, then closest, then most recent sale. Used to
// order the comps list and to decide which ones get preselected. The
// scorecard fallback keeps every caller that hasn't attached a similarity
// yet — and every fixture that never will — ordering exactly as before.
export function compareByMatch(a, b) {
  const as = a.similarity?.score, bs = b.similarity?.score;
  if (as != null && bs != null && as !== bs) return bs - as;
  const am = a.match || { pct: 0, score: 0 };
  const bm = b.match || { pct: 0, score: 0 };
  if (bm.pct !== am.pct) return bm.pct - am.pct;
  if (bm.score !== am.score) return bm.score - am.score;
  const ad = a.distance ?? 99, bd = b.distance ?? 99;
  if (ad !== bd) return ad - bd;
  return String(b.saleDate || "").localeCompare(String(a.saleDate || ""));
}

// Which comps stay ticked after a fresh provider pull.
//
// A pull replaces the provider's own list wholesale, so it gets to re-pick its
// own preselection. What it must NOT do is touch comps that came from anywhere
// else. Zillow captures are hand-picked off the listing site — a stronger
// signal than anything the provider's ranking produces — and manual comps were
// typed in on purpose. Replacing the whole selection silently un-ticks both,
// and because the server only persists comps whose id is in the selection,
// they then vanish from the offer and the comps PDF while still sitting
// visibly on the board. That failure is invisible until you open the PDF.
//
//   keepIds — ids that survive a pull (captured + manual)
//   preIds  — the fresh provider preselection
export function mergeSelection(previous, keepIds, preIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
  const kept = [...(previous || [])].filter((id) => keep.has(id));
  return new Set([...kept, ...(preIds || [])]);
}

// A short label for the chip: "6/8", or "—" when nothing is knowable.
export const matchLabel = (m) => (m && m.max ? `${m.score}/${m.max}` : "—");

// Chip color band. Deliberately coarse — this is a glanceable signal, not a
// score to optimize.
export function matchTone(m) {
  if (!m || !m.max) return "unknown";
  if (m.pct >= 0.85) return "strong";
  if (m.pct >= 0.6) return "fair";
  return "weak";
}
