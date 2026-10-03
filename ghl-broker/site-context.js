// site-context.js — OpenStreetMap around a house, for the street check.
// The I/O half of shared/site-check.js: one Overpass query per house covering
// the subject and every comp, and nothing else.
//
// Measured 2026-10-02 on the Edmonds deal: every major road, commercial
// parcel and rail line inside a mile came back as ~300 KB in 2.3 s, free and
// keyless. The public endpoint also answered one request in five with an XML
// rate-limit page instead of JSON — so a mirror, a retry, a day's cache, a
// hard time budget, and above all: FAIL OPEN. A street check that couldn't
// run returns null and the run says "street not checked"; it never holds a
// run and never reads as a quiet street.

import { normalizeOverpass, siteReport } from "./shared/site-check.js";

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const USER_AGENT = "ShepFlips-underwrite/1.0 (+https://offers.shepflips.com)";
export const SITE_CACHE_TTL_MS = 24 * 3600 * 1000;
const SITE_CACHE_MAX = 60;
const cache = new Map();
export function _resetSiteCache() { cache.clear(); }

const MAJOR = "motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";

export function overpassQuery({ lat, lng, radiusMeters }) {
  const around = `around:${Math.round(radiusMeters)},${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
  return `[out:json][timeout:25];(way(${around})[highway~"^(${MAJOR})$"];way(${around})[landuse~"^(commercial|retail|industrial)$"];way(${around})[railway=rail];);out tags geom;`;
}

// Metres between two points (haversine).
function meters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * siteRadiusMeters({ center, points }) — one query must reach the farthest
 * comp plus the distance any rule looks out from it: a mile at least, the
 * farthest point + 300 m, held to 600–2,500 m and rounded up to 250 m so
 * nearby houses share a cache entry.
 */
export function siteRadiusMeters({ center, points = [] }) {
  let far = 1609;
  for (const p of points) if (Number.isFinite(p?.lat) && Number.isFinite(p?.lng)) far = Math.max(far, meters(center, p));
  const r = Math.min(2500, Math.max(600, far + 300));
  return Math.ceil(r / 250) * 250;
}

/**
 * fetchSiteContext({ lat, lng, radiusMeters, fetchImpl, now }) → { context, error }
 *
 * `context` is normalizeOverpass's shape, or null. Never throws.
 */
export async function fetchSiteContext({
  lat, lng, radiusMeters = 1750, fetchImpl = globalThis.fetch, endpoints = OVERPASS_ENDPOINTS,
  now = Date.now(), timeoutMs = 10000, budgetMs = 25000, pauseMs = 1500,
}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { context: null, error: "no coordinates" };
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}|${radiusMeters}`;
  const hit = cache.get(key);
  if (hit && now - hit.at <= SITE_CACHE_TTL_MS) return { context: hit.context, cached: true };

  const body = `data=${encodeURIComponent(overpassQuery({ lat, lng, radiusMeters }))}`;
  const started = Date.now();
  let error = "";
  for (let round = 0; round < 2; round++) {
    if (round) await new Promise((r) => setTimeout(r, pauseMs));
    for (const url of endpoints) {
      const left = budgetMs - (Date.now() - started);
      if (left <= 500) return { context: null, error: error || "out of time" };
      try {
        const r = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT, Accept: "application/json" },
          body,
          signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
        });
        const text = await r.text();
        if (!r.ok) { error = `${new URL(url).host} ${r.status}`; continue; }
        if (/^\s*</.test(text)) { error = `${new URL(url).host} answered with a page, not data`; continue; }
        const context = normalizeOverpass(JSON.parse(text));
        if (!context) { error = `${new URL(url).host} returned no usable data`; continue; }
        if (cache.size >= SITE_CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, { at: now, context });
        return { context };
      } catch (e) {
        error = `${new URL(url).host}: ${e?.name === "TimeoutError" ? "timed out" : (e?.message || "failed")}`;
      }
    }
  }
  return { context: null, error };
}

/**
 * checkSite({ subject, comps, t, fetchImpl }) → siteReport(...) plus `error`
 *
 *   subject  { lat, lng, address, precision }
 *   comps    rows with id, lat, lng, address (comps and listings alike)
 *
 * One query sized to reach every point, then the pure classifier.
 */
export async function checkSite({ subject, comps = [], t, fetchImpl = globalThis.fetch, now = Date.now() }) {
  if (!subject || !Number.isFinite(subject.lat) || !Number.isFinite(subject.lng)) {
    return { status: "skipped", subject: { flags: {}, nearest: null }, comps: {}, error: "no subject coordinates" };
  }
  const radiusMeters = siteRadiusMeters({ center: subject, points: comps });
  const { context, error } = await fetchSiteContext({ lat: subject.lat, lng: subject.lng, radiusMeters, fetchImpl, now });
  const report = siteReport({ subject, comps, context, t });
  return error ? { ...report, error } : report;
}
