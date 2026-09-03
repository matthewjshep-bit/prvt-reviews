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
  bedTolerance = 0, sqftPct = 0.2, homeType = null,
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
  // Ask Zillow for the subject's type only. Purely an optimization — if these
  // keys are ever renamed the search widens and filterComps still cuts it back.
  if (homeType && HOME_TYPE_FLAGS[homeType]) {
    filterState.isAllHomes = { value: false };
    for (const [type, flag] of Object.entries(HOME_TYPE_FLAGS)) {
      filterState[flag] = { value: type === homeType };
    }
  }
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

// Zillow's homeType vocabulary. A townhouse and a house on the same block are
// different products with different buyers, and one slipping into the comp set
// is the kind of thing that dies at the buyer's inspection. Observed live in a
// 78-row pull half a mile across: 64 SINGLE_FAMILY, 6 TOWNHOUSE, 3
// MULTI_FAMILY, 2 CONDO, 1 LOT, 2 unknown.
//
// Two modes, and which one applies depends on what we know about the SUBJECT:
//
//   known  — match it exactly. A condo is comped against condos. An unknown
//            comp type is DROPPED, because "probably the same" is not a match
//            and nobody is watching an unattended run.
//   unknown — fall back to excluding the types that are wrong for a house,
//            keeping unknowns. That is a guess, but it is the guess the whole
//            product is built around, and it degrades rather than empties.
const EXCLUDED_HOME_TYPES = new Set([
  "CONDO", "TOWNHOUSE", "MULTI_FAMILY", "APARTMENT", "LOT", "MANUFACTURED",
]);

// filterState flags, by Zillow's own type names. Used to narrow the search URL
// so fewer rows come back; the JS filter below is what actually guarantees it.
const HOME_TYPE_FLAGS = {
  SINGLE_FAMILY: "isSingleFamily",
  CONDO: "isCondo",
  TOWNHOUSE: "isTownhouse",
  MULTI_FAMILY: "isMultiFamily",
  APARTMENT: "isApartment",
  MANUFACTURED: "isManufactured",
  LOT: "isLotLand",
};

// Zillow's search rows carry the same fact in two or three places depending on
// which surface served them, so read every one rather than trusting a shape.
export function normalizeRow(r) {
  // Two output shapes, and the newer one is a rename of every field this
  // touches. On 2026-09-02 the actor (build 0.0.90) moved to a curated schema:
  // `price` → `listingPrice.amount`, `latLong` → `coordinates`, `address` →
  // `listingAddress` (an object), `detailUrl` → `propertyUrl`, `imgSrc` →
  // `mainImage`. Nothing announced it; the run just started reporting rows it
  // couldn't read — 21 sold homes around an Issaquah address, not one of them
  // usable, because the price it was looking for no longer existed.
  //
  // Curated names lead, raw names stay behind them: an account pinned to an
  // older build keeps working, and so does the Zillow bookmarklet's capture.
  const home = r?.hdpData?.homeInfo || {};
  const lat = num(r.coordinates?.latitude ?? r.latLong?.latitude ?? home.latitude);
  const lng = num(r.coordinates?.longitude ?? r.latLong?.longitude ?? home.longitude);
  // On a SOLD search the sale price is the comp — listingPrice is whatever the
  // card last asked. hdpData.homeInfo.price was the only numeric price on the
  // old shape; the top-level `price` is an abbreviated label, which is why
  // parseMoney has to understand "M" and "K".
  //
  // And the money objects are not reliably filled in. The next rebuild, a day
  // later (0.0.91, 2026-09-03), ships a map-marker row as
  // `listingSoldPrice: {currency}` and `listingPrice: {currency, formatted:
  // "$345,000"}` — no `amount` on either — and 57 sold rows around a Spokane
  // address parsed to 57 zeros with the fix for the first rename deployed. So
  // a money object is read as its amount, then as its label.
  const price = parseMoney(
    money(r.listingSoldPrice) ?? money(r.listingPrice) ??
    home.price ?? r.unformattedPrice ?? r.soldPrice ?? r.price
  );
  // Two shapes in the wild: an ISO string at the top level, epoch ms inside
  // homeInfo. Plus the "Sold 08/15/25" card text as a last resort.
  const soldRaw = r.dateSold ?? home.dateSold;
  let soldMs = null;
  if (typeof soldRaw === "number") soldMs = soldRaw;
  else if (soldRaw) soldMs = Date.parse(soldRaw) || null;
  if (!soldMs) soldMs = Date.parse(String(r.variableData?.text || r.marketingTagline || "").replace(/^\D+/, "")) || null;
  const saleDate = soldMs ? new Date(soldMs).toISOString().slice(0, 10) : "";
  const url = r.propertyUrl || r.detailUrl || "";
  return {
    id: String(r.zpid || home.zpid || `${lat},${lng}`),
    address: rowAddress(r),
    price: price || 0,
    saleDate,
    sqft: num(r.livingArea ?? r.area ?? home.livingArea) || 0,
    beds: num(r.bedrooms ?? r.beds ?? home.bedrooms),
    baths: num(r.bathrooms ?? r.baths ?? home.bathrooms),
    // Absent from every row of a live 78-comp pull. The match scorecard
    // abstains on unknowns rather than penalising them, so era simply stops
    // being one of the criteria on this source.
    yearBuilt: num(r.yearBuilt ?? home.yearBuilt),
    homeType: r.homeType ?? home.homeType ?? null,
    stories: null,
    subdivision: null,
    material: null,
    lat,
    lng,
    distance: null, // computed below — a Zillow row has no distance field
    url: url ? (String(url).startsWith("http") ? url : `https://www.zillow.com${url}`) : null,
    photo: (typeof r.mainImage === "string" ? r.mainImage : r.mainImage?.url) || r.imgSrc || null,
    source: "zillow",
  };
}

// A curated money object, or whatever else sits in the field: `amount` when
// the actor filled it in, the display label when it didn't, and null for an
// empty shell so the next candidate gets a look. parseMoney reads the label.
const money = (m) => (m && typeof m === "object" ? (m.amount ?? m.formatted ?? null) : m);

// `address` used to be a string and is now an object under a different name.
// Both, plus the loose addressStreet/City/State trio, land here.
function rowAddress(r) {
  const a = r.listingAddress || (r.address && typeof r.address === "object" ? r.address : null);
  if (a) {
    return a.full ||
      [[a.street, a.unit].filter(Boolean).join(" "), a.city, [a.state, a.zipCode].filter(Boolean).join(" ")]
        .filter(Boolean).join(", ");
  }
  if (typeof r.address === "string" && r.address) return r.address;
  return [r.addressStreet, r.addressCity, r.addressState].filter(Boolean).join(", ");
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
  bedTolerance = 0, bathTolerance = 0.5, sqftPct = 0.2, homeType = null,
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
    sqft, sqftPct, homeType,
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
      beds, baths, sqft, monthsBack, radiusMiles, bedTolerance, bathTolerance, sqftPct, homeType,
    }),
    // What the box actually held before our own filters ran — the difference
    // between "this neighbourhood is quiet" and "our bands are too tight" is
    // otherwise invisible from the outside.
    pulled: comps.length,
    // And what the scrape returned before we tried to READ any of it. A run
    // that reports zero comps has three unrelated causes and they need
    // different people to fix them: an empty box (quiet street), rows we
    // couldn't parse (Zillow changed shape, or the actor is handing back
    // markers with no price), and rows we filtered out (bands too tight).
    // Without this count the first two are indistinguishable, and the note
    // blames the neighbourhood for a scrape that never worked.
    rows: rows.length,
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
  homeType = null,
}) {
  const cutoff = Date.now() - monthsBack * 30.44 * 86400000;
  // Exact match when the subject's type is known — including dropping comps
  // whose own type Zillow didn't report, since an unconfirmed match is not one.
  const typeOk = homeType
    ? (c) => c.homeType === homeType
    : (c) => !houseTypesOnly || !c.homeType || !EXCLUDED_HOME_TYPES.has(c.homeType);
  return comps
    .filter((c) => c.distance != null && c.distance <= radiusMiles)
    .filter(typeOk)
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
