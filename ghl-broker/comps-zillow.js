// comps-zillow.js — closed sales from Zillow, via Apify's search scraper.
//
// The alternative to comps-pull.js (RealEstateAPI). Same output shape, so
// everything downstream — the match scorecard, deriveArv, the comps PDF, the
// Comps pane — cannot tell which one it got.
//
// Why this exists: RealEstateAPI returns county-record comps, which are
// authoritative about WHAT sold and vague about what it looked like. Zillow is
// the book the operator already reads by eye, and it comes with photos, a
// listing description, and a $/sqft spread that actually tracks finish level.
//
// THE IMPORTANT CAVEAT, up front: this actor takes a Zillow search URL with an
// encoded `searchQueryState`, and Zillow silently IGNORES filter keys it does
// not recognize. A renamed key would not error — it would quietly return
// unfiltered comps, which is the worst failure this feature could have. So the
// URL filters here are treated as an OPTIMIZATION (fewer pages to walk), never
// as a guarantee: every constraint that matters is re-applied in JS below,
// against the numbers on each returned row. If Zillow renames `isRecentlySold`
// tomorrow, this gets slower and still correct.
//
// Same ToS caveat as fetchZillowPhotos: unofficial scraper, acknowledged.

import { milesBetween } from "./shared/comp-match.js";

const ACTOR = "maxcopell~zillow-scraper";

// Miles per degree of latitude. Longitude shrinks with the cosine of latitude.
const MILES_PER_DEG_LAT = 69.0;

// A generous box around the subject. Deliberately larger than the radius we
// actually want: the box is a cheap pre-filter, and clipping a comp that sits
// just inside the circle but outside a tight box is a real loss. The exact
// circle is enforced by milesBetween below.
export function boundsAround({ lat, lng, radiusMiles }) {
  const pad = radiusMiles * 1.35;
  const dLat = pad / MILES_PER_DEG_LAT;
  const dLng = pad / (MILES_PER_DEG_LAT * Math.max(0.15, Math.cos((lat * Math.PI) / 180)));
  return {
    north: lat + dLat,
    south: lat - dLat,
    east: lng + dLng,
    west: lng - dLng,
  };
}

// How far back to ask Zillow for. Their windows are coarse; pick the smallest
// one that covers what we want and let the JS filter do the fine cut.
const dozFor = (months) => (months <= 1 ? "30" : months <= 3 ? "90" : months <= 6 ? "6m" : months <= 12 ? "12m" : months <= 24 ? "24m" : "36m");

/**
 * A Zillow "recently sold" search URL for the box around a subject.
 *
 * Every `filterState` entry here is best-effort (see the header). The one part
 * that is load-bearing is `mapBounds` — that is how the actor knows where to
 * look, and an unrecognized key there would return nothing rather than
 * everything, which is a failure we WOULD notice.
 */
export function soldSearchUrl({
  lat, lng, radiusMiles = 0.5, beds = 0, baths = 0, sqft = 0, monthsBack = 12,
  bedTolerance = 0, sqftPct = 0.2,
}) {
  const filterState = {
    // Sold only. The five for-sale flags are switched off explicitly because
    // Zillow's default is "everything", and a live listing is not a comp.
    isRecentlySold: { value: true },
    isForSaleByAgent: { value: false },
    isForSaleByOwner: { value: false },
    isNewConstruction: { value: false },
    isComingSoon: { value: false },
    isAuction: { value: false },
    isForSaleForeclosure: { value: false },
    isAllHomes: { value: true },
    doz: { value: dozFor(monthsBack) },
    sort: { value: "globalrelevanceex" },
  };
  // Beds exact, baths as a floor: a 3/2 subject is comparable to a 3/2.5, and
  // Zillow's bath filter is a minimum anyway. Both are re-checked in JS.
  if (beds > 0) {
    filterState.beds = {
      min: Math.max(1, Math.round(beds) - bedTolerance),
      max: Math.round(beds) + bedTolerance,
    };
  }
  if (baths > 0) filterState.baths = { min: Math.max(1, Math.floor(baths)) };
  if (sqft > 0) {
    filterState.sqft = { min: Math.round(sqft * (1 - sqftPct)), max: Math.round(sqft * (1 + sqftPct)) };
  }

  const state = {
    isMapVisible: true,
    isListVisible: true,
    mapBounds: boundsAround({ lat, lng, radiusMiles }),
    filterState,
  };
  return `https://www.zillow.com/homes/recently_sold/?searchQueryState=${encodeURIComponent(JSON.stringify(state))}`;
}

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Money, including Zillow's abbreviated card labels.
//
// This is the single most dangerous parse in the file. A search row's top-level
// `price` is a DISPLAY string — "$1.23M", "$626K" — and stripping non-digits
// off "$1.23M" yields 1.23. A comp priced at $1.23 would sail through every
// filter below (it has a price, it's nearby, it's the right size) and drag an
// ARV to nothing. So the suffix is honored, and anything left implausible for a
// house is rejected outright rather than trusted.
export function parseMoney(v) {
  if (v == null || v === "") return 0;
  // Numbers take the same plausibility floor as strings. A numeric field can
  // be garbage too, and a fast path that skips the check is how "$1.23" gets
  // in through a different door.
  if (typeof v === "number") return plausible(v) ? Math.round(v) : 0;
  const s = String(v).trim();
  const m = s.match(/(-?[\d,.]+)\s*([MmKk])?/);
  if (!m) return 0;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return 0;
  const scaled = m[2] ? base * (m[2].toLowerCase() === "m" ? 1e6 : 1e3) : base;
  return plausible(scaled) ? Math.round(scaled) : 0;
}

// A house is not $1.23 and not $9 billion. Either means we parsed a label
// rather than a price, and a zero is caught by the caller's `price > 0` check
// while a 1.23 would sail through every filter and gut the ARV.
const plausible = (n) => Number.isFinite(n) && n >= 1000 && n < 1e9;

// Zillow's homeType vocabulary. We only ever compare houses to houses: a
// townhouse or a condo in the same block is a different product with a
// different buyer, and one slipping into the comp set is exactly the kind of
// thing that dies at the buyer's inspection. Observed live in a 78-row pull:
// 64 SINGLE_FAMILY, 6 TOWNHOUSE, 3 MULTI_FAMILY, 2 CONDO, 1 LOT.
//
// An exclude-list rather than an allow-list, so a type name we've never seen is
// kept (consistent with how every other unknown is treated here) while the ones
// we know are wrong are dropped.
const EXCLUDED_HOME_TYPES = new Set([
  "CONDO", "TOWNHOUSE", "MULTI_FAMILY", "APARTMENT", "LOT", "MANUFACTURED",
]);

// Zillow's search rows carry the same fact in two or three places depending on
// which surface served them, so read every one rather than trusting a shape.
function normalizeRow(r) {
  const home = r?.hdpData?.homeInfo || {};
  const lat = num(r.latLong?.latitude ?? home.latitude ?? r.coordinates?.latitude);
  const lng = num(r.latLong?.longitude ?? home.longitude ?? r.coordinates?.longitude);
  // hdpData.homeInfo.price is the only NUMERIC price on a search row, so it
  // leads. `unformattedPrice` is documented but absent in practice; the
  // top-level `price` is the abbreviated label and is the last resort, which is
  // why parseMoney has to understand "M" and "K".
  const price = parseMoney(home.price ?? r.unformattedPrice ?? r.listingSoldPrice?.amount ?? r.price);
  // Two shapes in the wild: an ISO string at the top level, epoch ms inside
  // homeInfo. Plus the "Sold 08/15/25" card text as a last resort.
  const soldRaw = r.dateSold ?? home.dateSold;
  let soldMs = null;
  if (typeof soldRaw === "number") soldMs = soldRaw;
  else if (soldRaw) soldMs = Date.parse(soldRaw) || null;
  if (!soldMs) soldMs = Date.parse(String(r.variableData?.text || "").replace(/^\D+/, "")) || null;
  const saleDate = soldMs ? new Date(soldMs).toISOString().slice(0, 10) : "";
  return {
    id: String(r.zpid || home.zpid || `${lat},${lng}`),
    address: r.address || [r.addressStreet, r.addressCity, r.addressState].filter(Boolean).join(", "),
    price: price || 0,
    saleDate,
    sqft: num(r.area ?? r.livingArea ?? home.livingArea) || 0,
    beds: num(r.beds ?? r.bedrooms ?? home.bedrooms),
    baths: num(r.baths ?? r.bathrooms ?? home.bathrooms),
    // Absent from every row of a live 78-comp pull. The match scorecard
    // abstains on unknowns rather than penalising them, so era simply stops
    // being one of the criteria on this source.
    yearBuilt: num(home.yearBuilt),
    homeType: r.homeType ?? home.homeType ?? null,
    stories: null,
    subdivision: null,
    material: null,
    lat,
    lng,
    distance: null, // computed below — a Zillow row has no distance field
    url: r.detailUrl ? (String(r.detailUrl).startsWith("http") ? r.detailUrl : `https://www.zillow.com${r.detailUrl}`) : null,
    photo: r.imgSrc || null,
    source: "zillow",
  };
}

/**
 * pullZillowComps({ apifyToken, lat, lng, beds, baths, sqft, radiusMiles, monthsBack, limit })
 *
 * Returns the same payload shape as pullComps in comps-pull.js:
 *   { enabled, source, subject, estimate, comps[] }
 * `subject` carries whatever facts the caller passed in — Zillow search has no
 * concept of a subject property, so the caller owns that record.
 */
export async function pullZillowComps({
  apifyToken, lat, lng, beds = 0, baths = 0, sqft = 0,
  radiusMiles = 0.5, monthsBack = 12, limit = 200, subject = null,
  bedTolerance = 0, bathTolerance = 0.5, sqftPct = 0.2,
}) {
  if (!(Number.isFinite(lat) && Number.isFinite(lng))) {
    throw Object.assign(new Error("comps need the subject's coordinates"), { http: 400 });
  }
  const url = soldSearchUrl({
    lat, lng, radiusMiles, monthsBack,
    // Widen what we ASK for by the same tolerances we'll accept, or Zillow
    // trims rows the JS pass below would have kept and we never see them.
    beds, bedTolerance,
    baths: baths ? Math.max(0, baths - bathTolerance) : 0,
    sqft, sqftPct,
  });

  const r = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}&timeout=180`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchUrls: [{ url }],
        // MAP_MARKERS reads the map layer directly. It is the right mode for a
        // box this small: pagination would walk a result list we've already
        // constrained geographically, and zoom-in exists for boxes far bigger
        // than half a mile.
        extractionMethod: "MAP_MARKERS",
        resultsLimit: limit,
      }),
      signal: AbortSignal.timeout(200000),
    }
  );
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    throw Object.assign(new Error(`Zillow comps lookup failed (Apify ${r.status})`), {
      http: r.status === 401 || r.status === 403 ? 400 : 502,
      detail,
    });
  }
  const items = await r.json();
  const rows = Array.isArray(items) ? items : [];

  const origin = { lat, lng };
  const comps = rows
    .map(normalizeRow)
    .filter((c) => c.price > 0 && c.lat != null && c.lng != null)
    .map((c) => {
      const miles = milesBetween(origin, c);
      return { ...c, distance: miles == null ? null : Math.round(miles * 100) / 100 };
    });

  return {
    enabled: true,
    source: "zillow",
    searchUrl: url,
    subject: subject || { lat, lng, beds: beds || null, baths: baths || null, sqft: sqft || null, yearBuilt: null },
    estimate: null, // no AVM on a Zillow search row
    comps: filterComps(comps, {
      beds, baths, sqft, monthsBack, radiusMiles, bedTolerance, bathTolerance, sqftPct,
    }),
    // What the box actually held before our own filters ran — the difference
    // between "this neighbourhood is quiet" and "our bands are too tight" is
    // otherwise invisible from the outside.
    pulled: comps.length,
  };
}

/**
 * The filters that actually matter, re-applied to what came back.
 *
 * This is not belt-and-braces, it is the belt. Zillow ignores filter keys it
 * doesn't recognize, so the URL cannot be trusted to have constrained
 * anything. The rules mirror comps-pull.js's, with one deliberate difference:
 *
 *   there, a comp missing a datum is KEPT (a human is looking at the list and
 *   can judge). Here distance is enforced absolutely, because "within half a
 *   mile" is the whole premise and an unattended run has nobody to catch it.
 */
export function filterComps(comps, {
  beds = 0, baths = 0, sqft = 0, monthsBack = 12, radiusMiles = 0.5,
  bedTolerance = 0, bathTolerance = 0.5, sqftPct = 0.2, houseTypesOnly = true,
}) {
  const cutoff = Date.now() - monthsBack * 30.44 * 86400000;
  return comps
    .filter((c) => c.distance != null && c.distance <= radiusMiles)
    .filter((c) => !houseTypesOnly || !c.homeType || !EXCLUDED_HOME_TYPES.has(c.homeType))
    .filter((c) => !beds || c.beds == null || Math.abs(Math.round(c.beds) - Math.round(beds)) <= bedTolerance)
    .filter((c) => !baths || c.baths == null || Math.abs(c.baths - baths) <= bathTolerance)
    .filter((c) => !sqft || !c.sqft || (c.sqft >= sqft * (1 - sqftPct) && c.sqft <= sqft * (1 + sqftPct)))
    .filter((c) => {
      if (!c.saleDate) return true; // unknown sale date: keep, the scorecard abstains
      const t = Date.parse(c.saleDate);
      return !Number.isFinite(t) || t >= cutoff;
    })
    .sort((a, b) => a.distance - b.distance);
}
