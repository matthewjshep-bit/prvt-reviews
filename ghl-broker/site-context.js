// site-context.js — OpenStreetMap around a house, for the street check.
// The I/O half of shared/site-check.js: one Overpass query per house covering
// the subject and the comps that can carry its ARV, and nothing else.
//
// What the first live runs taught (2026-10-02, the evening it shipped): the
// public endpoint's speed swings with its load — the same small query took
// 1.5 s and then 15 s a minute later, a disc a mile across around a Tacoma
// house took 13.5 s, and the first mirror tried (kumi) never answered at all.
// A 10-second limit and a mile-wide disc meant every live run read "street not
// checked". So: one small box around the subject and the ~dozen comps the ARV
// can come from (padded by the farthest any rule looks), a patient limit per
// try, a mirror that does answer, the main endpoint twice — and above all
// FAIL OPEN. A street check that couldn't run returns null and the run says
// "street not checked"; it never holds a run and never reads as a quiet street.
// It runs under the comps grading and the photo scan, so the patience is free.

import { normalizeOverpass, siteReport } from "./shared/site-check.js";

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const USER_AGENT = "ShepFlips-underwrite/1.0 (+https://offers.shepflips.com)";
export const SITE_CACHE_TTL_MS = 24 * 3600 * 1000;
const SITE_CACHE_MAX = 60;
const cache = new Map();
export function _resetSiteCache() { cache.clear(); }

// The comps that can carry an ARV come from the most similar handful (the
// price proxy judges the ten most similar), so a dozen is enough to measure
// the street against — and a dozen keeps the box small.
export const SITE_MAX_COMPS = 12;
// A box wider than this means a far-flung comp; drop the farthest until it fits.
const MAX_BOX_METERS = 4000;

const MAJOR = "motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";

const M_PER_DEG = 111320;
const okPoint = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng);

/**
 * siteBox({ points, padMeters }) → { s, w, n, e } | null
 *
 * The box around every point, padded on each side by the farthest any rule
 * looks (a motorway 250 m out), so a road just past a comp still counts.
 */
export function siteBox({ points = [], padMeters = 275 } = {}) {
  const ps = points.filter(okPoint);
  if (!ps.length) return null;
  const lat0 = ps[0].lat;
  const dLat = padMeters / M_PER_DEG;
  const dLng = padMeters / (M_PER_DEG * Math.max(0.15, Math.cos((lat0 * Math.PI) / 180)));
  return {
    s: Math.min(...ps.map((p) => p.lat)) - dLat,
    n: Math.max(...ps.map((p) => p.lat)) + dLat,
    w: Math.min(...ps.map((p) => p.lng)) - dLng,
    e: Math.max(...ps.map((p) => p.lng)) + dLng,
  };
}

const boxSide = (b) => Math.max((b.n - b.s) * M_PER_DEG, (b.e - b.w) * M_PER_DEG * Math.cos((((b.n + b.s) / 2) * Math.PI) / 180));

export function overpassQuery({ box }) {
  const f = (v) => Number(v).toFixed(5);
  return `[out:json][timeout:25][bbox:${f(box.s)},${f(box.w)},${f(box.n)},${f(box.e)}];` +
    `(way[highway~"^(${MAJOR})$"];way[landuse~"^(commercial|retail|industrial)$"];way[railway=rail];);out tags geom;`;
}

/**
 * fetchSiteContext({ box, fetchImpl, now }) → { context, error }
 *
 * `context` is normalizeOverpass's shape, or null. Never throws. Tries the
 * main endpoint, the mirror, then the main endpoint again.
 */
export async function fetchSiteContext({
  box, fetchImpl = globalThis.fetch, endpoints = OVERPASS_ENDPOINTS,
  now = Date.now(), timeoutMs = 25000, budgetMs = 70000, pauseMs = 1500,
}) {
  if (!box) return { context: null, error: "no coordinates" };
  const key = [box.s, box.w, box.n, box.e].map((v) => Number(v).toFixed(4)).join(",");
  const hit = cache.get(key);
  if (hit && now - hit.at <= SITE_CACHE_TTL_MS) return { context: hit.context, cached: true };

  const body = `data=${encodeURIComponent(overpassQuery({ box }))}`;
  const attempts = endpoints.length > 1 ? [endpoints[0], endpoints[1], endpoints[0]] : [endpoints[0], endpoints[0]];
  const started = Date.now();
  const errors = [];
  for (const [i, url] of attempts.entries()) {
    if (i) await new Promise((r) => setTimeout(r, pauseMs));
    const left = budgetMs - (Date.now() - started);
    if (left <= 500) { errors.push("out of time"); break; }
    const host = new URL(url).host;
    try {
      const r = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT, Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
      });
      const text = await r.text();
      if (!r.ok) { errors.push(`${host} ${r.status}`); continue; }
      if (/^\s*</.test(text)) { errors.push(`${host} answered with a page, not data`); continue; }
      const context = normalizeOverpass(JSON.parse(text));
      if (!context) { errors.push(`${host} returned no usable data`); continue; }
      if (cache.size >= SITE_CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now, context });
      return { context };
    } catch (e) {
      errors.push(`${host}: ${e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out" : (e?.message || "failed")}`);
    }
  }
  return { context: null, error: errors.join("; ") };
}

/**
 * checkSite({ subject, comps, t, fetchImpl }) → siteReport(...) plus `error`
 *
 *   subject  { lat, lng, address, precision }
 *   comps    rows with id, lat, lng, address, MOST RELEVANT FIRST — the first
 *            SITE_MAX_COMPS are measured (the ones the ARV can come from)
 *
 * One query over the box around them, then the pure classifier.
 */
export async function checkSite({ subject, comps = [], t, fetchImpl = globalThis.fetch, now = Date.now(), maxComps = SITE_MAX_COMPS, ...opts }) {
  if (!subject || !okPoint(subject)) {
    return { status: "skipped", subject: { flags: {}, nearest: null }, comps: {}, error: "no subject coordinates" };
  }
  const pad = Math.max(Number(t?.nearMotorwayMeters) || 0, Number(t?.nearPrimaryMeters) || 0, Number(t?.railMeters) || 0, Number(t?.frontageMeters) || 0, Number(t?.commercialMeters) || 0, 50) + 25;
  let pick = comps.filter(okPoint).slice(0, maxComps);
  let box = siteBox({ points: [subject, ...pick], padMeters: pad });
  // A comp a long way off would balloon the box; the nearest ones carry the ARV.
  while (pick.length && boxSide(box) > MAX_BOX_METERS) {
    const far = pick.reduce((a, c) => (Math.hypot(c.lat - subject.lat, c.lng - subject.lng) > Math.hypot(a.lat - subject.lat, a.lng - subject.lng) ? c : a));
    pick = pick.filter((c) => c !== far);
    box = siteBox({ points: [subject, ...pick], padMeters: pad });
  }
  const { context, error } = await fetchSiteContext({ box, fetchImpl, now, ...opts });
  const report = siteReport({ subject, comps: pick, context, t });
  return error ? { ...report, error } : report;
}
