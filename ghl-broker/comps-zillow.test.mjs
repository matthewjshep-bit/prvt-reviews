import test from "node:test";
import assert from "node:assert/strict";
import { boundsAround, soldSearchUrl, filterComps, normalizeRow, pullZillowComps } from "./comps-zillow.js";

const SUBJECT = { lat: 47.49, lng: -122.19 };
const state = (url) => JSON.parse(decodeURIComponent(new URL(url).search.replace("?searchQueryState=", "")));

/* ---------- the map box ---------- */

test("the box contains the circle it is meant to contain", () => {
  const b = boundsAround({ ...SUBJECT, radiusMiles: 0.5 });
  // 0.5 mi is ~0.00725 deg of latitude; the box is padded past that on purpose.
  assert.ok(b.north - SUBJECT.lat > 0.00724, "north edge clears the radius");
  assert.ok(SUBJECT.lat - b.south > 0.00724, "south edge clears the radius");
  assert.ok(b.north > b.south && b.east > b.west);
});

test("longitude widens with latitude, because degrees of longitude shrink", () => {
  const equator = boundsAround({ lat: 0, lng: 0, radiusMiles: 0.5 });
  const seattle = boundsAround({ lat: 47.6, lng: 0, radiusMiles: 0.5 });
  const width = (b) => b.east - b.west;
  assert.ok(width(seattle) > width(equator) * 1.4);
  // Latitude does not.
  assert.ok(Math.abs((seattle.north - seattle.south) - (equator.north - equator.south)) < 1e-9);
});

test("the cosine term is clamped so a polar latitude can't produce an infinite box", () => {
  const b = boundsAround({ lat: 89.999, lng: 0, radiusMiles: 0.5 });
  assert.ok(Number.isFinite(b.east) && Number.isFinite(b.west));
  assert.ok(b.east - b.west < 1);
});

/* ---------- the search URL ---------- */

test("the URL asks Zillow for sold homes and switches every for-sale flag off", () => {
  const f = state(soldSearchUrl({ ...SUBJECT })).filterState;
  assert.equal(f.isRecentlySold.value, true);
  for (const k of ["isForSaleByAgent", "isForSaleByOwner", "isNewConstruction", "isComingSoon", "isAuction", "isForSaleForeclosure"]) {
    assert.equal(f[k].value, false, k);
  }
});

test("map bounds are always present — the one filter that fails loudly", () => {
  // An unrecognized filterState key returns everything (silent, dangerous).
  // A broken mapBounds returns nothing (obvious). Bounds must always be sent.
  const s = state(soldSearchUrl({ ...SUBJECT }));
  for (const k of ["north", "south", "east", "west"]) assert.equal(typeof s.mapBounds[k], "number", k);
});

test("bed, bath and size filters appear only when we know the subject's facts", () => {
  const bare = state(soldSearchUrl({ ...SUBJECT })).filterState;
  assert.equal(bare.beds, undefined);
  assert.equal(bare.baths, undefined);
  assert.equal(bare.sqft, undefined);

  const full = state(soldSearchUrl({ ...SUBJECT, beds: 3, baths: 2.5, sqft: 1400 })).filterState;
  assert.deepEqual(full.beds, { min: 3, max: 3 });
  assert.deepEqual(full.baths, { min: 2 });            // a floor: 3/2.5 comps a 3/2
  assert.deepEqual(full.sqft, { min: 1120, max: 1680 }); // ±20%
});

test("the sold window maps onto Zillow's coarse buckets", () => {
  const doz = (m) => state(soldSearchUrl({ ...SUBJECT, monthsBack: m })).filterState.doz.value;
  assert.equal(doz(1), "30");
  assert.equal(doz(3), "90");
  assert.equal(doz(6), "6m");
  assert.equal(doz(12), "12m");
  assert.equal(doz(24), "24m");
  assert.equal(doz(36), "36m");
});

test("the URL survives a round trip through encodeURIComponent", () => {
  const url = soldSearchUrl({ ...SUBJECT, beds: 3, sqft: 1400 });
  assert.ok(url.startsWith("https://www.zillow.com/homes/recently_sold/?searchQueryState="));
  assert.doesNotThrow(() => state(url));
});

/* ---------- the filters that actually guarantee correctness ---------- */
// Zillow silently ignores filterState keys it doesn't recognize, so these run
// against what came BACK. If the URL stopped filtering entirely, these are what
// keep the comps honest.

const comp = (over) => ({ id: "c", price: 600000, sqft: 1400, beds: 3, baths: 2, distance: 0.2, saleDate: "2026-06-01", ...over });
const keep = (c, opts = {}) => filterComps([c], { beds: 3, baths: 2, sqft: 1400, monthsBack: 12, radiusMiles: 0.5, ...opts }).length === 1;

test("distance is enforced absolutely — an unknown distance is dropped", () => {
  assert.equal(keep(comp({ distance: 0.5 })), true);
  assert.equal(keep(comp({ distance: 0.51 })), false);
  // Everywhere else an unknown datum is forgiving, because a human is reading
  // the list. "Within half a mile" is the premise here and nobody is watching.
  assert.equal(keep(comp({ distance: null })), false);
});

test("beds must match exactly; a missing bed count is kept", () => {
  assert.equal(keep(comp({ beds: 3 })), true);
  assert.equal(keep(comp({ beds: 4 })), false);
  assert.equal(keep(comp({ beds: null })), true);
});

test("baths allow a half, so a 2.5 comps a 2", () => {
  assert.equal(keep(comp({ baths: 2.5 })), true);
  assert.equal(keep(comp({ baths: 3 })), false);
  assert.equal(keep(comp({ baths: null })), true);
});

test("size stays inside ±20%", () => {
  assert.equal(keep(comp({ sqft: 1120 })), true);
  assert.equal(keep(comp({ sqft: 1680 })), true);
  assert.equal(keep(comp({ sqft: 1119 })), false);
  assert.equal(keep(comp({ sqft: 1681 })), false);
  assert.equal(keep(comp({ sqft: 0 })), true);          // unknown size is kept
});

test("a sale older than the window is dropped, an undated one is kept", () => {
  const old = new Date(Date.now() - 20 * 30.44 * 86400000).toISOString().slice(0, 10);
  assert.equal(keep(comp({ saleDate: old })), false);
  assert.equal(keep(comp({ saleDate: old }), { monthsBack: 24 }), true);
  assert.equal(keep(comp({ saleDate: "" })), true);
});

test("survivors come back nearest first", () => {
  const out = filterComps(
    [comp({ id: "far", distance: 0.4 }), comp({ id: "near", distance: 0.1 }), comp({ id: "mid", distance: 0.25 })],
    { beds: 3, baths: 2, sqft: 1400, monthsBack: 12, radiusMiles: 0.5 }
  );
  assert.deepEqual(out.map((c) => c.id), ["near", "mid", "far"]);
});

test("with no subject facts known, only distance and recency constrain", () => {
  const out = filterComps([comp({ beds: 7, baths: 6, sqft: 9000 })], { monthsBack: 12, radiusMiles: 0.5 });
  assert.equal(out.length, 1);
});

/* ---------- money: the parse that could quietly zero an ARV ---------- */
// A live pull returns top-level `price` as an abbreviated LABEL ("$1.23M"), and
// `unformattedPrice` — which the actor's docs advertise — is absent. Stripping
// non-digits off "$1.23M" yields 1.23, and a $1.23 comp passes every other
// filter in this file. These pin the guard.

import { parseMoney } from "./comps-zillow.js";

test("abbreviated price labels are expanded, not truncated", () => {
  assert.equal(parseMoney("$1.23M"), 1230000);
  assert.equal(parseMoney("$626K"), 626000);
  assert.equal(parseMoney("$1.2m"), 1200000);
  assert.equal(parseMoney("$975k"), 975000);
});

test("plain numbers and full strings pass through", () => {
  assert.equal(parseMoney(1225000), 1225000);
  assert.equal(parseMoney("$1,185,000"), 1185000);
  assert.equal(parseMoney("1185000"), 1185000);
});

test("anything implausible for a house is rejected rather than trusted", () => {
  assert.equal(parseMoney("$1.23"), 0);       // an un-expanded label
  assert.equal(parseMoney(1.23), 0);
  assert.equal(parseMoney("$999"), 0);
  assert.equal(parseMoney(2e9), 0);
  assert.equal(parseMoney(null), 0);
  assert.equal(parseMoney(""), 0);
  assert.equal(parseMoney({ amount: null }), 0);
});

/* ---------- home type ---------- */
// Observed in one live 78-row pull: 64 SINGLE_FAMILY, 6 TOWNHOUSE,
// 3 MULTI_FAMILY, 2 CONDO, 1 LOT. A townhouse in the comp set is a different
// product with a different buyer, and it reached the ARV before this existed.

const typed = (homeType, opts = {}) =>
  filterComps([comp({ homeType })], { radiusMiles: 0.5, monthsBack: 12, ...opts }).length === 1;

test("condos, townhouses, multi-family and land are not comps for a house", () => {
  assert.equal(typed("SINGLE_FAMILY"), true);
  for (const t of ["CONDO", "TOWNHOUSE", "MULTI_FAMILY", "APARTMENT", "LOT", "MANUFACTURED"]) {
    assert.equal(typed(t), false, t);
  }
});

test("an unfamiliar or missing type is kept — exclude-list, not allow-list", () => {
  // Zillow adding a new name shouldn't silently empty the board.
  assert.equal(typed("SOMETHING_NEW"), true);
  assert.equal(typed(null), true);
  assert.equal(typed(undefined), true);
});

test("the type filter can be switched off", () => {
  const out = filterComps([comp({ homeType: "CONDO" })], { radiusMiles: 0.5, monthsBack: 12, houseTypesOnly: false });
  assert.equal(out.length, 1);
});

/* ---------- configurable bands ---------- */
// The automation ranks a WIDER pool than it draws the ARV from. Measured: on a
// live pull the tight bands left 4 comps, below the price proxy's minimum of 6,
// so every run on an ordinary address would have held for review.

test("bed, bath and size tolerances widen the pool when asked", () => {
  const wide = { radiusMiles: 0.5, monthsBack: 12, beds: 3, baths: 2, sqft: 1610,
    bedTolerance: 1, bathTolerance: 1, sqftPct: 0.3 };
  const tight = { radiusMiles: 0.5, monthsBack: 12, beds: 3, baths: 2, sqft: 1610 };
  const four = comp({ beds: 4, baths: 3, sqft: 2050 });
  assert.equal(filterComps([four], tight).length, 0);
  assert.equal(filterComps([four], wide).length, 1);
});

test("widening never lets a different product or a distant sale through", () => {
  const wide = { radiusMiles: 0.5, monthsBack: 12, beds: 3, baths: 2, sqft: 1610,
    bedTolerance: 1, bathTolerance: 1, sqftPct: 0.3 };
  assert.equal(filterComps([comp({ beds: 4, homeType: "TOWNHOUSE" })], wide).length, 0);
  assert.equal(filterComps([comp({ beds: 4, distance: 0.9 })], wide).length, 0);
});

/* ---------- sold dates arrive in two shapes ---------- */

test("an ISO sold date and an epoch sold date both parse", () => {
  // Top-level dateSold is ISO; hdpData.homeInfo.dateSold is epoch ms.
  const iso = "2026-08-25T07:00:00.000Z";
  assert.equal(new Date(Date.parse(iso)).toISOString().slice(0, 10), "2026-08-25");
  assert.equal(new Date(1756108800000).toISOString().slice(0, 10), "2025-08-25");
});

/* ---------- property type is matched, not assumed ---------- */
// The old rule excluded the types that are wrong for a HOUSE, which quietly
// assumed every subject was one. A condo comped against houses is not a comp.

test("a known subject type is matched exactly, in both directions", () => {
  assert.equal(typed("CONDO", { homeType: "CONDO" }), true);
  assert.equal(typed("SINGLE_FAMILY", { homeType: "CONDO" }), false);
  assert.equal(typed("TOWNHOUSE", { homeType: "TOWNHOUSE" }), true);
  assert.equal(typed("CONDO", { homeType: "TOWNHOUSE" }), false);
  assert.equal(typed("SINGLE_FAMILY", { homeType: "SINGLE_FAMILY" }), true);
});

test("with the subject's type known, a comp of unknown type is dropped", () => {
  // Everywhere else an unknown datum is forgiving because a human is reading
  // the list. Here nobody is, and "probably the same product" is not a match.
  assert.equal(typed(null, { homeType: "SINGLE_FAMILY" }), false);
  assert.equal(typed(undefined, { homeType: "CONDO" }), false);
});

test("with the subject's type unknown, the old house-shaped guess still applies", () => {
  // Degrades rather than empties: this is the assumption the product is built
  // around, and a listing that didn't report its type shouldn't stop a run.
  assert.equal(typed("SINGLE_FAMILY"), true);
  assert.equal(typed(null), true);
  assert.equal(typed("CONDO"), false);
  assert.equal(typed("LOT"), false);
});

test("the search URL asks Zillow for the subject's type only", () => {
  // Verified live: 77 rows unfiltered -> 63, all SINGLE_FAMILY.
  const f = state(soldSearchUrl({ ...SUBJECT, homeType: "SINGLE_FAMILY" })).filterState;
  assert.equal(f.isSingleFamily.value, true);
  assert.equal(f.isCondo.value, false);
  assert.equal(f.isTownhouse.value, false);
  assert.equal(f.isMultiFamily.value, false);
  assert.equal(f.isLotLand.value, false);
  assert.equal(f.isAllHomes.value, false, "all-homes must be off or the flags do nothing");
});

test("a condo subject asks for condos", () => {
  const f = state(soldSearchUrl({ ...SUBJECT, homeType: "CONDO" })).filterState;
  assert.equal(f.isCondo.value, true);
  assert.equal(f.isSingleFamily.value, false);
});

test("no known type leaves the URL unnarrowed rather than guessing", () => {
  const f = state(soldSearchUrl({ ...SUBJECT })).filterState;
  assert.equal(f.isSingleFamily, undefined);
  assert.equal(f.isAllHomes.value, true);
});

test("an unrecognized type name narrows nothing, and the JS filter still holds", () => {
  const f = state(soldSearchUrl({ ...SUBJECT, homeType: "SOMETHING_NEW" })).filterState;
  assert.equal(f.isAllHomes.value, true, "URL stays wide");
  // But the exact match still refuses anything that isn't that type.
  assert.equal(typed("SOMETHING_NEW", { homeType: "SOMETHING_NEW" }), true);
  assert.equal(typed("SINGLE_FAMILY", { homeType: "SOMETHING_NEW" }), false);
});

/* ---------- reading a row, whichever shape the actor is in ---------- */

// On 2026-09-02 the actor renamed every field this reads (build 0.0.90): money
// became an object under a new key, coordinates moved, the address became an
// object. Nothing announced it — runs simply started reporting "N sold rows
// and not one carried a usable price", 21 of them around one Issaquah address.
// Shapes below are the vendor's own schema examples.

const NEW_SHAPE = {
  zpid: "2064142765",
  listingAddress: {
    street: "130 Example St", unit: null, city: "New York", state: "NY",
    zipCode: "10005", full: "130 Example St, New York, NY 10005",
  },
  coordinates: { latitude: 40.7057, longitude: -74.0073 },
  listingStatus: "sold",
  homeType: "SINGLE_FAMILY",
  listingPrice: { amount: 995000, currency: "USD", formatted: "$995,000" },
  listingSoldPrice: { amount: 840000, currency: "USD", formatted: "$840,000" },
  bedrooms: 3, bathrooms: 2, livingArea: 1175,
  dateSold: "2026-05-06T07:00:00.000Z",
  propertyUrl: "https://www.zillow.com/homedetails/130-Example-St/2064142765_zpid/",
  mainImage: "https://photos.zillowstatic.com/fp/example-p_e.jpg",
};

const OLD_SHAPE = {
  zpid: 2064142765,
  address: "130 Example St, New York, NY 10005",
  latLong: { latitude: 40.7057, longitude: -74.0073 },
  hdpData: { homeInfo: { price: 840000, bedrooms: 3, bathrooms: 2, livingArea: 1175, homeType: "SINGLE_FAMILY" } },
  dateSold: "2026-05-06T07:00:00.000Z",
  detailUrl: "/homedetails/130-Example-St/2064142765_zpid/",
  imgSrc: "https://photos.zillowstatic.com/fp/example-p_e.jpg",
};

test("the curated shape reads — this is the row the runs were dropping", () => {
  const c = normalizeRow(NEW_SHAPE);
  assert.equal(c.price, 840000, "the SOLD price, not the last list price");
  assert.equal(c.lat, 40.7057);
  assert.equal(c.lng, -74.0073);
  assert.equal(c.saleDate, "2026-05-06");
  assert.equal(c.beds, 3);
  assert.equal(c.baths, 2);
  assert.equal(c.sqft, 1175);
  assert.equal(c.homeType, "SINGLE_FAMILY");
  assert.equal(c.address, "130 Example St, New York, NY 10005");
  assert.match(c.url, /^https:\/\/www\.zillow\.com\/homedetails/);
  // The three the pull filters on. All of them failed, so every row went.
  assert.ok(c.price > 0 && c.lat != null && c.lng != null);
});

test("the old shape still reads — an account on a pinned build keeps working", () => {
  const c = normalizeRow(OLD_SHAPE);
  assert.equal(c.price, 840000);
  assert.equal(c.lat, 40.7057);
  assert.equal(c.sqft, 1175);
  assert.equal(c.address, "130 Example St, New York, NY 10005");
  assert.match(c.url, /^https:\/\/www\.zillow\.com\/homedetails/);
});

test("both shapes describe the same comp", () => {
  const a = normalizeRow(NEW_SHAPE);
  const b = normalizeRow(OLD_SHAPE);
  for (const k of ["price", "lat", "lng", "saleDate", "beds", "baths", "sqft", "homeType", "address", "url", "photo"]) {
    assert.deepEqual(a[k], b[k], k);
  }
});

test("an address object with no `full` is still assembled", () => {
  const c = normalizeRow({
    ...NEW_SHAPE,
    listingAddress: { street: "130 Example St", unit: "APT 12D", city: "New York", state: "NY", zipCode: "10005" },
  });
  assert.equal(c.address, "130 Example St APT 12D, New York, NY 10005");
});

test("a card with no sold price falls back to what it is asking", () => {
  const { listingSoldPrice, ...noSold } = NEW_SHAPE;
  assert.equal(normalizeRow(noSold).price, 995000);
});

test("a money object that arrives empty is a zero, not a crash", () => {
  const c = normalizeRow({ ...NEW_SHAPE, listingSoldPrice: {}, listingPrice: { amount: null } });
  assert.equal(c.price, 0);
});

/* ---------- the whole pull, on the shape that broke it ---------- */

test("a boxful of curated rows comes back as comps, not as zero", async () => {
  // The exact failure, end to end: rows arrive, and every one of them used to
  // be dropped between the dataset and the board.
  const near = (i) => ({
    ...NEW_SHAPE,
    zpid: `z${i}`,
    coordinates: { latitude: 47.49 + i * 0.001, longitude: -122.19 + i * 0.001 },
    listingSoldPrice: { amount: 600000 + i * 1000, currency: "USD", formatted: "$600,000" },
    livingArea: 1400,
    bedrooms: 3,
    bathrooms: 2,
    dateSold: new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  const rows = [near(0), near(1), near(2)];

  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => rows });
  try {
    const out = await pullZillowComps({
      apifyToken: "t", lat: 47.49, lng: -122.19,
      beds: 3, baths: 2, sqft: 1400, radiusMiles: 0.5, monthsBack: 12,
    });
    assert.equal(out.rows, 3, "what the scrape returned");
    assert.equal(out.pulled, 3, "what survived being read — this was 0");
    assert.equal(out.comps.length, 3, "what survived the bands");
    assert.equal(out.comps[0].price, 600000);
    assert.ok(out.comps.every((c) => c.distance != null));
  } finally { globalThis.fetch = real; }
});

test("rows that really are unreadable still report as such", () => {
  // The diagnosis has to keep working — `rows` above `pulled` is what told us
  // this was a scrape problem and not a quiet neighbourhood.
  const junk = normalizeRow({ zpid: "z9", listingPrice: { amount: null } });
  assert.equal(junk.price, 0);
  assert.equal(junk.lat, null);
});

/* ---------- the shape that arrived the day after the fix above ---------- */

// Build 0.0.91, 2026-09-03. Same field names as NEW_SHAPE, but the money
// objects came through as shells: `listingSoldPrice: {currency}` and
// `listingPrice: {currency, formatted: "$345,000"}`, with no `amount` on
// either. This is a real row — 3427 E Jackson Ave, one of 57 around a Spokane
// subject — and every one of the 57 parsed to price 0 with the rename fix
// already deployed. The map-marker mode carries the display label only.
const LIVE_SHAPE_0_0_91 = {
  zpid: "23518413",
  zestimate: 344600,
  listingPrice: { currency: "USD", formatted: "$345,000" },
  listingAddress: { state: "WA", country: "USA", full: "3427 E Jackson Ave, Spokane, WA 99217" },
  coordinates: { latitude: 47.68077, longitude: -117.35935 },
  listingStatus: "sold",
  propertyUrl: "https://www.zillow.com/homedetails/3427-E-Jackson-Ave-Spokane-WA-99217/23518413_zpid/",
  listingSoldPrice: { currency: "USD" },
  cardType: "home",
  homeType: "SINGLE_FAMILY",
  bedrooms: 4, bathrooms: 2, livingArea: 1776, livingAreaUnit: "sqft",
  mainImage: "https://photos.zillowstatic.com/fp/ea19bd670c0b1420f0f4e97782aec883-p_e.jpg",
  listingPhotos: [], photoCount: 0,
  marketingTagline: "Sold 08/26/26",
  dateSold: "2026-08-26T07:00:00.000Z",
  isValid: true,
};

test("a money object with only a label still prices the comp", () => {
  const c = normalizeRow(LIVE_SHAPE_0_0_91);
  assert.equal(c.price, 345000, "read from listingPrice.formatted");
  assert.equal(c.lat, 47.68077);
  assert.equal(c.lng, -117.35935);
  assert.equal(c.saleDate, "2026-08-26");
  assert.equal(c.sqft, 1776);
  assert.equal(c.beds, 4);
  assert.equal(c.baths, 2);
  assert.equal(c.address, "3427 E Jackson Ave, Spokane, WA 99217");
  assert.ok(c.price > 0 && c.lat != null && c.lng != null, "the three the pull filters on");
});

test("inside a money object the amount leads the label, and the sold price leads the list price", () => {
  const priced = (sold, list) => normalizeRow({ ...LIVE_SHAPE_0_0_91, listingSoldPrice: sold, listingPrice: list }).price;
  assert.equal(priced({ amount: 300000, formatted: "$999,999" }, { formatted: "$345,000" }), 300000);
  assert.equal(priced({ formatted: "$310,000" }, { amount: 345000 }), 310000);
  assert.equal(priced({ currency: "USD" }, { amount: 345000, formatted: "$1" }), 345000);
  assert.equal(priced({ currency: "USD" }, { currency: "USD", formatted: "$1.2M" }), 1200000);
  assert.equal(priced(null, null), 0);
});

test("the sale date falls back to the card's tagline when dateSold is missing", () => {
  const { dateSold, ...noDate } = LIVE_SHAPE_0_0_91;
  assert.equal(normalizeRow(noDate).saleDate, "2026-08-26");
});

test("a boxful of 0.0.91 rows comes back as comps — the second time this was zero", async () => {
  const near = (i) => ({
    ...LIVE_SHAPE_0_0_91,
    zpid: `z${i}`,
    coordinates: { latitude: 47.49 + i * 0.001, longitude: -122.19 + i * 0.001 },
    listingPrice: { currency: "USD", formatted: `$${(600 + i).toLocaleString()},000` },
    livingArea: 1400, bedrooms: 3, bathrooms: 2,
    dateSold: new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  const rows = [near(0), near(1), near(2)];
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => rows });
  try {
    const out = await pullZillowComps({
      apifyToken: "t", lat: 47.49, lng: -122.19,
      beds: 3, baths: 2, sqft: 1400, radiusMiles: 0.5, monthsBack: 12,
    });
    assert.equal(out.rows, 3);
    assert.equal(out.pulled, 3, "what survived being read — this was 0 again");
    assert.equal(out.comps.length, 3);
    assert.equal(out.comps[0].price, 600000);
  } finally { globalThis.fetch = real; }
});
