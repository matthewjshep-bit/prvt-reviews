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

// Months between an ISO-ish date string and now. Null when unparseable.
function monthsSince(dateStr) {
  const t = Date.parse(String(dateStr || "").slice(0, 10));
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / (1000 * 60 * 60 * 24 * 30.44);
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

// Sort helper: best match first, then closest, then most recent sale. Used to
// order the comps list and to decide which ones get preselected.
export function compareByMatch(a, b) {
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
