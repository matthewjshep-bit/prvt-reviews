import test from "node:test";
import assert from "node:assert/strict";
import { boundsAround, soldSearchUrl, filterComps } from "./comps-zillow.js";

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
