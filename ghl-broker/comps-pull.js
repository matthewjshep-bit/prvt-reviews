// comps-pull.js — closed-sale comparables from RealEstateAPI v3.
//
// Extracted from the GET /api/offers/comps route so the auto-underwrite
// pipeline can pull comps without going back out over HTTP to its own server.
// The route is now a thin wrapper; behavior for the app is unchanged.
//
// TRUE closed sales: arms-length transactions within N months, same beds +
// baths + county, sqft within ±20% and year built within ±10 of the subject.
// Cached 24h per query to conserve API credits.
//
// Apples-to-apples beats recent: when the tight search comes up short we reach
// BACK IN TIME first (18 → 24 months) and only widen the radius as a last
// resort. A same-subdivision sale from 20 months ago is a better comp than a
// 5-mile-away sale from last month, and the caller is told which relaxation
// actually fired so the number stays defensible.
//
// `widen: false` turns that ladder off entirely. The auto-underwrite uses it:
// an unattended run that quietly reached five miles out for its comps would
// produce an ARV nobody chose to accept.

import { addressQueryVariants } from "./shared/us-address.js";
import { geocodeAddress } from "./geocode.js";
import { YEAR_BUILT_TOLERANCE } from "./shared/comp-match.js";

const compsCache = new Map();
const CACHE_TTL = 24 * 3600 * 1000;

/**
 * pullComps({ apiKey, address, months, sqft, beds, baths, widen })
 *
 * Returns the same payload the /comps route has always returned:
 *   { enabled, widened?, bedBathRelaxed?, yearRelaxed?, subject, estimate, comps[] }
 * Throws { http } on a provider failure.
 */
export async function pullComps({
  apiKey, address, months = 12, sqft = 0, beds = 0, baths = 0, widen = true,
}) {
  const monthsBack = Math.min(24, Math.max(1, parseInt(months, 10) || 12));
  const subjectSqft = parseInt(sqft, 10) || 0;
  const wantBeds = Math.max(0, parseInt(beds, 10) || 0);
  const wantBaths = Math.max(0, parseFloat(baths) || 0);

  // `widen` belongs in the key: a narrowed pull legitimately returns a smaller
  // set for the same address, and sharing a cache slot between the two would
  // hand the automation the app's widened comps (or vice versa).
  const cacheKey = `${String(address).toLowerCase()}|${monthsBack}|${subjectSqft}|${wantBeds}|${wantBaths}|${widen ? "w" : "n"}`;
  const hit = compsCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  // When the user corrects beds/baths we do NOT pass bedrooms/bathrooms
  // filters to the API — RealEstateAPI applies them to the subject lookup
  // too, so a corrected count that disagrees with their record makes the
  // whole property "not exist". Instead: drop same_beds/same_baths, pull a
  // wider pool, and filter the comps ourselves below.
  const hasBedBathOverride = wantBeds > 0 || wantBaths > 0;
  const makeBody = ({ radiusMiles, daysBack, matchBedBath }) => ({
    max_days_back: daysBack,
    max_radius_miles: radiusMiles,
    max_results: hasBedBathOverride ? 30 : 15,
    ...(matchBedBath && !hasBedBathOverride ? { same_beds: true, same_baths: true } : {}),
    same_county: true,
    arms_length: true,
    ...(subjectSqft > 0
      ? { living_square_feet_min: Math.round(subjectSqft * 0.8), living_square_feet_max: Math.round(subjectSqft * 1.2) }
      : {}),
  });
  const queryComps = async (subject, params) => {
    const r = await fetch("https://api.realestateapi.com/v3/PropertyComps", {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...makeBody(params), ...subject }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      throw Object.assign(new Error(`RealEstateAPI ${r.status}`), { http: 502, detail });
    }
    return r.json();
  };
  // IMPORTANT provider quirk: when fewer than 3 comps match the filters,
  // PropertyComps suppresses the ENTIRE response — empty subject included,
  // with only a `reason` string. So "no property record" can really mean
  // "not enough sales matched"; the relaxation ladder below distinguishes
  // the two.
  const noRecord = (x) => !x?.subject?.propertyInfo?.latitude && !(x?.comps || []).length;
  const asRequested = { radiusMiles: 1, daysBack: monthsBack * 30, matchBedBath: true };
  let j = null;
  let lastErr = null;
  // Phase A — resolve by address: the provider's address matcher is
  // inconsistent about formats ("166th Ave NE" one day, "166th Avenue NE"
  // the next) while GHL/autocomplete produce the spelled-out form. Walk
  // the variant ladder until one resolves.
  for (const variant of addressQueryVariants(address)) {
    try {
      const attempt = await queryComps({ address: variant }, asRequested);
      if (!noRecord(attempt)) { j = attempt; break; }
      if (!j) j = attempt; // remember the first empty result as a fallback
    } catch (e) { lastErr = e; }
  }
  // Phase B — resolve by coordinates: county records keyed under another
  // postal city or grid-address quirks make some parcels unfindable by
  // address entirely. Geocode the typed address and find the parcel via
  // PropertySearch, then query comps against the property id.
  let subjectRef = null;
  if (!j || noRecord(j)) {
    try {
      // A parcel lookup inside a 0.05-mile circle is only meaningful around a
      // real street address — a ZIP centroid would confidently return whatever
      // house happens to sit near the middle of the ZIP.
      const geo = await geocodeAddress(address, { minPrecision: "street" });
      if (geo) {
        const sr = await fetch("https://api.realestateapi.com/v2/PropertySearch", {
          method: "POST",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ latitude: geo.lat, longitude: geo.lng, radius: 0.05, size: 10 }),
          signal: AbortSignal.timeout(15000),
        });
        if (sr.ok) {
          const list = ((await sr.json()).data || []).filter((p) => p?.id);
          const houseNo = (String(address).match(/^\s*(\d+)/) || [])[1];
          const label = (p) => String(p.address?.address || p.address?.label || "");
          const pick = (houseNo && list.find((p) => label(p).startsWith(houseNo))) || list[0];
          if (pick) {
            subjectRef = { id: pick.id };
            const byId = await queryComps(subjectRef, asRequested);
            if (!noRecord(byId)) j = byId;
          }
        }
      }
    } catch { /* keep whatever the ladder produced */ }
  }
  // Phase C — widen the search: still nothing means "fewer than 3 sales
  // matched", not "no such property" (rural areas rarely have 3 same-bed
  // sales within a mile). Expand stepwise and tell the caller we did.
  //
  // Order matters: TIME first, then distance. Going back another six
  // months keeps the comps in the same subdivision and price stratum;
  // going out another four miles doesn't. The radius only moves once the
  // 24-month window has already failed.
  let widened = null;
  if (widen && (!j || noRecord(j))) {
    const ref = subjectRef || { address: addressQueryVariants(address)[0] };
    const days = (m) => Math.max(monthsBack * 30, m * 30);
    const steps = [
      { params: { radiusMiles: 1, daysBack: days(18), matchBedBath: true }, label: "18 months" },
      { params: { radiusMiles: 1, daysBack: days(24), matchBedBath: true }, label: "24 months" },
      { params: { radiusMiles: 2, daysBack: days(24), matchBedBath: true }, label: "2 mi / 24 mo" },
      { params: { radiusMiles: 5, daysBack: days(24), matchBedBath: true }, label: "5 mi / 24 mo" },
      { params: { radiusMiles: 5, daysBack: days(24), matchBedBath: false }, label: "5 mi / 24 mo / any beds-baths" },
    ];
    for (const step of steps) {
      try {
        const attempt = await queryComps(ref, step.params);
        if (!noRecord(attempt)) { j = attempt; widened = step.label; break; }
      } catch (e) { lastErr = e; }
    }
  }
  if (!j) throw lastErr || Object.assign(new Error("comps lookup failed"), { http: 502 });
  const subjInfo = j.subject?.propertyInfo || {};
  const num = (v) => (v == null || v === "" ? null : Number(v) || null);
  // Stories / construction / subdivision aren't in a documented, stable
  // place in the v3 payload and vary by plan tier, so probe the plausible
  // paths rather than assuming one. Everything downstream treats a null as
  // "unknown" (the match scorecard skips unknown criteria), so a provider
  // that returns none of these degrades quietly instead of scoring badly.
  const firstOf = (...vals) => {
    for (const v of vals) {
      const s = v == null ? "" : String(v).trim();
      if (s && s.toLowerCase() !== "null") return s;
    }
    return null;
  };
  const storiesOf = (o = {}) =>
    num(o.stories ?? o.storiesCount ?? o.numberOfStories ?? o.propertyInfo?.stories);
  const subdivisionOf = (o = {}) =>
    firstOf(o.subdivision, o.lotInfo?.subdivision, o.address?.subdivision, o.propertyInfo?.subdivision);
  const materialOf = (o = {}) =>
    firstOf(o.construction, o.constructionType, o.exteriorWalls, o.propertyInfo?.construction, o.propertyInfo?.exteriorWalls);
  const data = {
    enabled: true,
    ...(widened ? { widened } : {}),
    subject: {
      lat: num(subjInfo.latitude),
      lng: num(subjInfo.longitude),
      beds: num(subjInfo.bedrooms),
      baths: num(subjInfo.bathrooms),
      sqft: num(subjInfo.livingSquareFeet),
      yearBuilt: num(subjInfo.yearBuilt),
      stories: storiesOf(subjInfo),
      subdivision: subdivisionOf({ ...j.subject, propertyInfo: subjInfo }),
      material: materialOf(subjInfo),
      lastSalePrice: num(j.subject?.lastSalePrice),
      lastSaleDate: j.subject?.lastSaleDate || null,
    },
    estimate: j.reapiAvm
      ? { price: Math.round(Number(j.reapiAvm)), low: Math.round(Number(j.reapiAvmLow || 0)), high: Math.round(Number(j.reapiAvmHigh || 0)) }
      : null,
    comps: (j.comps || [])
      .map((c) => {
        const price = c.mlsSoldPrice || c.lastSaleAmount || 0;
        const saleDate = c.mlsLastSaleDate || c.lastSaleDate || "";
        return {
          id: String(c.id || `${c.latitude},${c.longitude}`),
          address: c.address?.address || [c.address?.city, c.address?.state].filter(Boolean).join(", "),
          price: Math.round(price),
          saleDate: String(saleDate).slice(0, 10),
          sqft: Number(c.squareFeet) || 0,
          beds: c.bedrooms ?? null,
          baths: c.bathrooms ?? null,
          yearBuilt: num(c.yearBuilt),
          stories: storiesOf(c),
          subdivision: subdivisionOf(c),
          material: materialOf(c),
          distance: c.distance != null ? Math.round(c.distance * 100) / 100 : null,
          lat: c.latitude,
          lng: c.longitude,
        };
      })
      .filter((c) => c.lat && c.lng && c.price > 0),
  };
  // Enforce "similar sqft" even when the caller didn't pass sqft (the
  // provider's own record supplies it): keep comps within ±20%.
  const effSqft = subjectSqft > 0 ? subjectSqft : data.subject.sqft || 0;
  if (effSqft > 0) {
    data.comps = data.comps.filter((c) => !c.sqft || (c.sqft >= effSqft * 0.8 && c.sqft <= effSqft * 1.2));
  }
  // User-corrected beds/baths: match server-side (comps missing the datum
  // are kept, mirroring the sqft rule). Baths allow ±0.5 so a 2.75-bath
  // comp still matches a "3 baths" subject. When the exact match filters
  // EVERYTHING out (a 6-bed in an area of 3-beds), fall back to the
  // unfiltered similar-size pool and flag it — hand-picking from nearby
  // sales beats a dead end.
  if (wantBeds > 0 || wantBaths > 0) {
    const pool = data.comps;
    let filtered = pool;
    if (wantBeds > 0) filtered = filtered.filter((c) => c.beds == null || Math.round(Number(c.beds)) === wantBeds);
    if (wantBaths > 0) filtered = filtered.filter((c) => c.baths == null || Math.abs(Number(c.baths) - wantBaths) <= 0.5);
    if (filtered.length) {
      data.comps = filtered;
    } else if (pool.length) {
      data.comps = pool;
      data.bedBathRelaxed = true;
    }
  }
  // Era match: a 1962 rambler and a 2015 build are not the same product
  // even at identical size. ±10 years, same defensive shape as the two
  // filters above — comps with no year on record are kept, and if the
  // filter would empty the pool we keep the pool and flag it rather than
  // returning nothing.
  const effYear = data.subject.yearBuilt || 0;
  if (effYear > 0) {
    const pool = data.comps;
    const filtered = pool.filter((c) => !c.yearBuilt || Math.abs(c.yearBuilt - effYear) <= YEAR_BUILT_TOLERANCE);
    if (filtered.length) data.comps = filtered;
    else if (pool.length) data.yearRelaxed = true;
  }
  data.comps = data.comps.slice(0, 15);
  // Cache hits only — caching an empty result would pin a transient
  // provider blip as "no record" for 24h.
  if (data.subject.lat || data.comps.length) {
    if (compsCache.size > 100) compsCache.clear();
    compsCache.set(cacheKey, { ts: Date.now(), data });
  }
  return data;
}
