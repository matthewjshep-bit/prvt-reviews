// same-side.js — is a comp on the subject's side of the main roads?
// Pure, no I/O: the broker fetches the map (ghl-broker/site-context.js
// fetchBarriers), this reads it.
//
// Matt, 2026-10-06, on 2325 48th Ave SW, Tumwater: "it's picking stuff that is
// ON THE OTHER SIDE of a main road, we need to skew towards stuff that is in
// the same neighborhood, vicinity, same side of a main road, all of these
// details affect value." All four comps carrying that ARV were new builds
// across Trosper Rd SW at $860K–1.23M, while seven sales inside 0.4 mi on the
// house's own side ($485–694K) carried nothing.
//
// The test is the straight line from the house to the comp: if it crosses a
// main road, a railway or a river, the comp is across. "Main road" is
// OpenStreetMap tertiary and up — Trosper Rd is tagged tertiary right there,
// so secondary-and-up would have missed the very case that asked for this.
// Creeks are not barriers: they run through culverts under whole subdivisions.
// A crossing within a few metres of either end is the house's own frontage
// (or a geocode sitting on the centre line), not a road between them.

const BARRIER_ROADS = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);
export const SIDE_ENDPOINT_SLACK_M = 30;

const okPoint = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng);

/**
 * barrierLines(context) → [{ name, kind, geometry }]
 *
 * `context` is normalizeOverpass's shape ({ roads, rail, water }). Ramps
 * (`_link`) are left out: the road they serve is the barrier.
 */
export function barrierLines(context) {
  if (!context) return [];
  const out = [];
  for (const r of context.roads || []) {
    if (!BARRIER_ROADS.has(r.cls) || r.link) continue;
    out.push({ name: r.name || (r.names || [])[0] || "", kind: r.cls, geometry: r.geometry || [] });
  }
  for (const r of context.rail || []) out.push({ name: r.name || "", kind: "rail", geometry: r.geometry || [] });
  for (const w of context.water || []) out.push({ name: w.name || "", kind: "river", geometry: w.geometry || [] });
  return out.filter((b) => b.geometry.length >= 2);
}

// Metres on a flat projection centred on `origin` — plenty inside a few miles.
function projector(origin) {
  const ky = 111320;
  const kx = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return (p) => [(p.lng ?? p.lon) * kx, p.lat * ky];
}

// Where segment ab meets segment cd, as the fraction t along ab, or null.
function meetAt(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (den === 0) return null;
  const q = [c[0] - a[0], c[1] - a[1]];
  const t = (q[0] * s[1] - q[1] * s[0]) / den;
  const u = (q[0] * r[1] - q[1] * r[0]) / den;
  return t > 0 && t < 1 && u >= 0 && u <= 1 ? t : null;
}

/**
 * acrossBetween(from, to, lines) → [{ name, kind }]
 *
 * The barriers the straight line from `from` to `to` crosses, each once,
 * named roads before unnamed ones. Empty when it crosses none.
 */
export function acrossBetween(from, to, lines = []) {
  if (!okPoint(from) || !okPoint(to)) return [];
  const xy = projector(from);
  const a = xy(from);
  const b = xy(to);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(len > 0)) return [];
  const slack = SIDE_ENDPOINT_SLACK_M / len;
  const seen = new Map();
  for (const line of lines) {
    const pts = line.geometry.map(xy);
    for (let i = 1; i < pts.length; i++) {
      const t = meetAt(a, b, pts[i - 1], pts[i]);
      if (t == null || t < slack || t > 1 - slack) continue;
      const key = `${line.kind}:${line.name || "?"}`;
      if (!seen.has(key)) seen.set(key, { name: line.name, kind: line.kind });
      break;
    }
  }
  return [...seen.values()].sort((x, y) => Number(!x.name) - Number(!y.name));
}

/**
 * markSides({ subject, comps, context }) → comps, each with
 *   `side: { across: [{ name, kind }] }`
 *
 * No map (the lookup failed or was skipped) → the comps come back untouched,
 * with no `side`, so every reader treats the side as unknown rather than as
 * "same side".
 */
export function markSides({ subject, comps = [], context = null } = {}) {
  if (!context || !okPoint(subject)) return comps;
  const lines = barrierLines(context);
  return comps.map((c) => (okPoint(c) ? { ...c, side: { across: acrossBetween(subject, c, lines) } } : c));
}

/** isAcross(comp) → true only when the map says a main road is between them. */
export const isAcross = (c) => Boolean(c?.side?.across?.length);

const SHORT = [
  [/\bSouthwest\b/g, "SW"], [/\bSoutheast\b/g, "SE"], [/\bNorthwest\b/g, "NW"], [/\bNortheast\b/g, "NE"],
  [/\bAvenue\b/g, "Ave"], [/\bStreet\b/g, "St"], [/\bRoad\b/g, "Rd"], [/\bBoulevard\b/g, "Blvd"],
  [/\bDrive\b/g, "Dr"], [/\bHighway\b/g, "Hwy"], [/\bParkway\b/g, "Pkwy"], [/\bLane\b/g, "Ln"], [/\bWay\b/g, "Way"],
];
const KIND_WORD = { rail: "the railway", river: "the river", motorway: "the freeway", trunk: "the highway" };

/** barrierName({ name, kind }) → "Trosper Rd SW", "the freeway", "a main road". */
export function barrierName(b) {
  const n = String(b?.name || "").trim();
  if (n) return SHORT.reduce((s, [rx, to]) => s.replace(rx, to), n);
  return KIND_WORD[b?.kind] || "a main road";
}

/** acrossLabel(comp) → "across Trosper Rd SW" / "across Trosper Rd SW + 1 more" / "". */
export function acrossLabel(c) {
  const a = c?.side?.across || [];
  if (!a.length) return "";
  return `across ${barrierName(a[0])}${a.length > 1 ? ` + ${a.length - 1} more` : ""}`;
}

/**
 * sameSideFirst(comps, { min }) → { picked, acrossUsed, sameSide }
 *
 * `comps` arrive best first. The comps on the house's side come first, in
 * their order; comps across a main road are added, best first, only until
 * there are `min` — the same side carries the number whenever it has the
 * evidence. Unknown sides count as same side (the map couldn't say).
 */
export function sameSideFirst(comps = [], { min = 0 } = {}) {
  const same = comps.filter((c) => !isAcross(c));
  const across = comps.filter(isAcross);
  const topUp = across.slice(0, Math.max(0, min - same.length));
  return { picked: [...same, ...topUp], acrossUsed: topUp.length, sameSide: same.length };
}
