// geocode.js — free-form US address → coordinates.
//
// Photon (the free Komoot/OSM instance) used to be the whole of this, and OSM
// is missing a great many ordinary American houses. "14808 Larch Way,
// Lynnwood, WA 98087" is a real, listed, unremarkable property and Photon
// returns *zero* features for it — which failed the entire auto-underwrite
// with "couldn't locate 14808 Larch Way, Lynnwood, WA 98087 on the map"
// before a single comp had been pulled.
//
// So the lookup is a ladder now, ordered by how much the answer can be
// trusted:
//
//   1. Census (TIGER) — the US government's own address ranges. Free, no key,
//      ~400ms, and forgiving about format: spelled-out streets, a missing ZIP,
//      a missing city, a unit number and a trailing "USA" all still resolve.
//   2. Photon — for what TIGER hasn't got: new-construction streets, and the
//      buildings and landmarks people name instead of an address.
//   3. A ZIP, then a city, centroid — a deliberate and clearly LABELLED
//      downgrade, so that "we couldn't pin the house" stops being the same
//      thing as "we have no idea where this is".
//
// Every hit carries a `precision`, because the callers differ: centring a map
// on a ZIP centroid is fine, and searching comps in a half-mile circle around
// one is not. Callers that can't defend a coarse answer ask for a floor via
// `minPrecision` (or read `geo.precision` and hold the run for review).
//
// Photon answers are validated against the typed address before they're
// believed — its first result for a half-matched US query has been a road in
// Brazil and a river in Tanzania.

import {
  addressQueryVariants, normalizeUsAddress, parseUsAddress, splitUnit, stateAbbr,
} from "./shared/us-address.js";

/* ---------- how good is this fix ---------- */

// address — a parcel, or an interpolation inside the right house-number range
//           on the right block. Safe to search comps around.
// street  — right street, unknown number. Fine for a map; usable for comps
//           only because the search radius dwarfs the error.
// zip/city — a centroid, which in a spread-out suburb is a mile from the
//           house. Named honestly so callers can refuse it.
export const PRECISION = { address: 3, street: 2, zip: 1, city: 0 };

export const precisionRank = (p) => (p in PRECISION ? PRECISION[p] : -1);

// Does this fix clear the bar the caller set?
export const atLeast = (geo, level) => !!geo && precisionRank(geo.precision) >= precisionRank(level);

const CENSUS_TIMEOUT = 6000;
const PHOTON_TIMEOUT = 4000;

// Successful lookups only: an address doesn't move, but a failure is usually
// the network having a bad minute and shouldn't be remembered for a day.
const cache = new Map();
const CACHE_TTL = 24 * 3600 * 1000;

/**
 * geocodeAddress(raw, { minPrecision })
 *
 * → { lat, lng, precision, source, matched } | null
 *
 * `minPrecision` is a floor, not a hint: a coarser fix returns null rather
 * than being quietly handed back.
 */
export async function geocodeAddress(raw, { minPrecision = "city" } = {}) {
  const q = String(raw || "").trim();
  if (q.length < 4) return null;

  const key = q.toLowerCase().replace(/\s+/g, " ");
  const hit = cache.get(key);
  let found = hit && Date.now() - hit.ts < CACHE_TTL ? hit.geo : null;
  if (!found) {
    found = await lookup(q);
    if (found) cache.set(key, { ts: Date.now(), geo: found });
  }
  return atLeast(found, minPrecision) ? found : null;
}

async function lookup(q) {
  const want = parseUsAddress(q);
  const variants = queryLadder(q);

  // Each variant is checked against ITSELF, not against the raw text: the
  // ladder rewrites "Sixth Street South" to "6th St S" on purpose, and an
  // answer matching the rewrite is a match, not a mismatch.
  //
  // Census first, and only when there's a house number to match — its one-line
  // matcher wants a street address, not a place name.
  if (want.houseNo) {
    for (const v of variants) {
      const geo = await censusGeocode(v, parseUsAddress(v));
      if (geo) return geo;
    }
  }

  for (const v of variants) {
    const geo = await photonGeocode(v, parseUsAddress(v));
    if (geo) return geo;
  }

  return coarseCenter(want);
}

// The formats to try. Three rewrites of the address — as typed, without its
// unit number, with spelled-out ordinals turned into numbers — each in the
// three spellings addressQueryVariants produces (RealEstateAPI is not the only
// matcher that's picky about "Ave" vs "Avenue").
//
// Each rewrite is then offered twice, with its ZIP and without. That second
// pass is not padding — TIGER matches an address MORE strictly once a ZIP is
// present, and a street missing its type is exactly what that strictness
// throws out:
//
//   "2614 S 54th, Tacoma, WA 98409"  → no match
//   "2614 S 54th, Tacoma, WA"        → 2614 S 54TH ST, TACOMA, WA 98409
//
// Agents text street names without the "St" all day, and before this the run
// fell back to the ZIP centroid — half a mile away, by the rail yard — and
// searched for comps around that. Dropping the ZIP spends one disambiguator
// and keeps the city and the state; the house number and the street on the
// answer are still checked (see censusAgrees), and the ZIP-bearing form is
// always tried first.
//
// Breadth-first: every rewrite is offered in its USPS form before any of them
// is offered spelled out, because the USPS form is what address files hold.
// Capped, because each rung is a round trip. Eight rather than six since the
// missing-comma rewrite joined: an address needing that one usually needs no
// other, and the cap is only ever reached by an address nothing can resolve.
const MAX_VARIANTS = 8;

function queryLadder(raw) {
  const parts = String(raw).split(",");
  const { street, unit } = splitUnit(parts[0] || "");
  const withoutUnit = unit ? [street, ...parts.slice(1)].join(",") : "";
  const forms = [
    raw, withoutUnit,
    numberedStreet(raw), numberedStreet(withoutUnit),
    ...commaBeforeCity(raw), ...commaBeforeCity(withoutUnit),
  ]
    .filter(Boolean)
    // Each rewrite keeps its ZIP-less twin next to it, so the cap trims whole
    // rewrites off the end rather than every fallback at once.
    .flatMap((f) => [f, withoutZip(f)])
    .filter(Boolean)
    .map((f) => addressQueryVariants(f));

  const out = [];
  for (let i = 0; i < 3; i++) {
    for (const spellings of forms) if (spellings[i]) out.push(spellings[i]);
  }
  return [...new Set(out)].slice(0, MAX_VARIANTS);
}

// Address files hold "6th St S"; people write "Sixth Street South". Offered as
// an EXTRA rung rather than a rewrite, so a street genuinely named for a word
// ("Second Chance Ln") still gets tried as typed first.
const SPELLED_ORDINALS = {
  first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th",
  sixth: "6th", seventh: "7th", eighth: "8th", ninth: "9th", tenth: "10th",
  eleventh: "11th", twelfth: "12th", thirteenth: "13th", fourteenth: "14th",
  fifteenth: "15th", sixteenth: "16th", seventeenth: "17th", eighteenth: "18th",
  nineteenth: "19th", twentieth: "20th",
};

function numberedStreet(addr) {
  const parts = String(addr).split(",");
  const street = (parts[0] || "").replace(/[A-Za-z]+/g, (w) => SPELLED_ORDINALS[w.toLowerCase()] || w);
  return street === parts[0] ? "" : [street, ...parts.slice(1)].join(",");
}

// The comma nobody typed before the city.
//
// "17118 Riverview Way E Enumclaw, WA 98022" is how an address arrives from a
// text message or a hand-filled CRM field, and it parses with the CITY stuck to
// the end of the street: street "Riverview Way E Enumclaw". Both providers
// answer it correctly — TIGER returns "17118 RIVERVIEW WAY E, ENUMCLAW, WA,
// 98022" — and then censusAgrees compares "Riverview Way E Enumclaw" against
// "Riverview Way E", calls it a different street, and throws the right answer
// away. The ladder fell through to the ZIP centroid: downtown Enumclaw, twenty
// miles from a house up the river, which is where the auto-underwrite then
// searched for comps and found none.
//
// So the split is offered as an extra RUNG rather than by loosening the street
// check — the check is what keeps TIGER from answering with a neighbouring
// street, and a wrong rewrite here costs one round trip instead of a confident
// wrong address.
//
// It only fires where it can be defended: a street-type word, an optional
// directional after it, and at least one word still left over. A well-formed
// "1234 Park Avenue South, Seattle, WA" has nothing left over and is left
// alone, which is why this never fights with an address that was typed right.
//
// The last two street-type words are both offered, because plenty of cities
// are named after one: "1234 Main St Federal Way, WA" cuts after "Way" to
// nothing, and after "St" to the city it actually is. Best guess first.
const STREET_TYPES = new Set([
  "aly", "alley", "ave", "avenue", "blvd", "boulevard", "cir", "circle", "ct", "court",
  "cv", "cove", "dr", "drive", "expy", "expressway", "hwy", "highway", "ln", "lane",
  "loop", "pkwy", "parkway", "pl", "place", "plz", "plaza", "rd", "road", "row", "run",
  "sq", "square", "st", "street", "ter", "terrace", "trl", "trail", "walk", "way",
  "xing", "crossing",
]);

const DIRECTIONAL_WORDS = new Set([
  "n", "s", "e", "w", "ne", "nw", "se", "sw",
  "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest",
]);

const word = (w) => String(w).toLowerCase().replace(/\.$/, "");

// "…, Tacoma, WA 98409" → "…, Tacoma, WA". Empty when there was no ZIP to
// drop, so the rung never duplicates the form it came from.
function withoutZip(addr) {
  const cut = String(addr || "").replace(/(?:^|[\s,])\d{5}(?:-\d{4})?\s*$/, "").trim().replace(/,$/, "");
  return cut && cut !== String(addr || "").trim() ? cut : "";
}

function commaBeforeCity(addr) {
  const parts = String(addr || "").split(",");
  const { street, unit } = splitUnit(parts[0] || "");
  if (unit) return []; // dropping the unit is its own rung; don't compound them

  const words = street.trim().split(/\s+/).filter(Boolean);
  const types = [];
  for (let i = words.length - 1; i >= 0 && types.length < 2; i--) {
    if (STREET_TYPES.has(word(words[i]))) types.push(i);
  }

  const out = [];
  for (let cut of types) {
    if (cut + 1 < words.length && DIRECTIONAL_WORDS.has(word(words[cut + 1]))) cut += 1;
    const city = words.slice(cut + 1).join(" ");
    if (!city) continue; // the street ended where it should have — no run-on
    out.push([words.slice(0, cut + 1).join(" "), city, ...parts.slice(1)].join(", "));
  }
  return out;
}

/* ---------- providers ---------- */

async function getJson(url, timeoutMs) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null; // every provider here is best-effort; the ladder continues
  }
}

// US Census Geocoder — public, unauthenticated, TIGER address ranges.
// Public_AR_Current is the benchmark that tracks the latest vintage.
async function censusGeocode(q, want) {
  const j = await getJson(
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
      `?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`,
    CENSUS_TIMEOUT
  );
  for (const m of j?.result?.addressMatches || []) {
    const lat = Number(m?.coordinates?.y);
    const lng = Number(m?.coordinates?.x);
    if (!inUnitedStates(lat, lng)) continue;
    if (!censusAgrees(want, m.matchedAddress)) continue;
    return { lat, lng, precision: "address", source: "census", matched: censusLabel(m.matchedAddress) };
  }
  return null;
}

// TIGER will reach for a neighbouring street when the one you asked for has no
// range covering that number: "1234 NE 8th Street, Renton, WA" comes back as
// "1234 N 8TH ST, RENTON, WA 98057", a different street in a different ZIP.
// Left alone that is a confident answer to a question nobody asked, so the
// match has to still be the address that was typed.
function censusAgrees(want, matchedAddress) {
  if (!matchedAddress) return true;
  const got = parseUsAddress(matchedAddress);
  if (want.houseNo && got.houseNo && !sameText(want.houseNo, got.houseNo)) return false;
  if (want.state && got.state && want.state !== got.state) return false;
  if (trustworthyStreet(want) && want.street && got.street) {
    if (!sameStreet(want.street, got.street)) return false;
    if (!streetIsExact(want.street, got.street) && !relaxedMatchIsLocal(want, got)) return false;
  }
  return true;
}

// Is the street we were answered with the street we asked about?
//
// A street name is three separable things, and a matcher can only disagree
// with us about the ones we actually wrote down:
//
//   core   the name itself — "54th", "Moller", "Larch"
//   type   St, Ave, Dr, Way…
//   dirs   N, NE, SW…
//
// The core has to match, always. A type or a direction has to match only if we
// NAMED one: "Moller Dr" is not a different street from "Moller Dr NW", and
// "2614 S 54th" is not a different street from "2614 S 54th St" — the agent
// just didn't write the rest, which they mostly don't. Leaving a part out is
// not disagreement; writing a different one is, which is what keeps TIGER from
// answering "NE 8th Street" with "N 8th St" and being believed.
//
// The caller pairs this with a town check (see relaxedMatchIsLocal): letting an
// answer supply the half we left off is only safe if it's the same place.
export function sameStreet(want, got) {
  const w = streetParts(want);
  const g = streetParts(got);
  if (w.core !== g.core) return false;
  if (w.type && w.type !== g.type) return false;
  if (w.dirs && w.dirs !== g.dirs) return false;
  return true;
}

export const streetIsExact = (want, got) => streetKey(want) === streetKey(got);

// Normalized first, so "Drive"/"Dr" and "Northwest"/"NW" are one token each.
function streetParts(s) {
  const core = [];
  const type = [];
  const dirs = [];
  for (const w of normalizeUsAddress(String(s || "")).split(/\s+/).filter(Boolean)) {
    const k = word(w).replace(/[^a-z0-9]/g, "");
    if (!k) continue;
    if (STREET_TYPES.has(k)) type.push(k);
    else if (DIRECTIONAL_WORDS.has(k)) dirs.push(k);
    else core.push(k);
  }
  return { core: core.join(" "), type: type.join(" "), dirs: dirs.join(" ") };
}

// A relaxed street match — one where the answer supplied a type or a direction
// we never typed — has to land in the town we named. Without this, "Moller Dr"
// could be answered with a Moller Drive in the next county.
function relaxedMatchIsLocal(want, got) {
  if (want.city && got.city && sameText(want.city, got.city)) return true;
  if (want.zip && got.zip && String(want.zip) === String(got.zip)) return true;
  return false;
}

// Segment 0 is reliably the street line only when some LATER segment carried a
// city, state or ZIP. "14808 larch way lynnwood wa" has no commas at all, so
// its "street" is the whole run of words and checking it would reject the
// right answer.
const trustworthyStreet = (want) => !!(want.city || want.state || want.zip);

async function photonGeocode(q, want) {
  const j = await getJson(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`,
    PHOTON_TIMEOUT
  );
  let best = null;
  for (const f of j?.features || []) {
    const scored = scoreFeature(f, want);
    if (scored && (!best || scored.score > best.score)) best = scored;
  }
  if (!best) return null;

  // With no state and no ZIP in the typed address there is nothing regional to
  // check an answer against, so the answer has to match on its own terms: the
  // right number on the right street, or nothing.
  const floor = want.state || want.zip ? 3 : 7;
  return best.score >= floor ? best.geo : null;
}

// Only the last resort, and it says so in `precision`.
async function coarseCenter(want) {
  if (want.zip) {
    const geo = await photonPlace(`${want.zip}, ${want.state || "US"}`, (p) =>
      p.postcode === want.zip || p.name === want.zip
    );
    if (geo) return { ...geo, precision: "zip", matched: want.zip };
  }
  if (want.city && want.state) {
    const geo = await photonPlace(`${want.city}, ${want.state}`, (p) =>
      sameText(p.city, want.city) || sameText(p.name, want.city)
    );
    if (geo) return { ...geo, precision: "city", matched: `${want.city}, ${want.state}` };
  }
  return null;
}

async function photonPlace(q, accept) {
  const j = await getJson(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lang=en`,
    PHOTON_TIMEOUT
  );
  for (const f of j?.features || []) {
    const p = f.properties || {};
    if (!isUs(p)) continue;
    if (!accept(p)) continue;
    const [lng, lat] = f.geometry?.coordinates || [];
    if (!inUnitedStates(lat, lng)) continue;
    return { lat, lng, source: "photon" };
  }
  return null;
}

/* ---------- validating a Photon feature ---------- */

// Scores what actually agrees with the typed address, and subtracts for what
// contradicts it. Returns null for anything disqualifying — a feature outside
// the US, or in a state the address didn't name.
function scoreFeature(f, want) {
  const p = f.properties || {};
  if (!isUs(p)) return null;

  const [lng, lat] = f.geometry?.coordinates || [];
  if (!inUnitedStates(lat, lng)) return null;

  const state = stateAbbr(p.state || "");
  if (want.state && state && state !== want.state) return null;

  // The wrong street disqualifies outright, however well the rest lines up.
  // Photon offered "1234 8th Avenue South, Edmonds" for "1234 NE 8th Street,
  // Renton" — same house number, same state, twenty miles away.
  //
  // Same one-way tolerance as the Census check, and for the same reason: OSM
  // holds "10511 Moller Drive Northwest, Gig Harbor" and the agent typed
  // "10511 Moller Dr", and refusing that answer left the run on a city
  // centroid twenty miles from the house.
  const streetKnown = trustworthyStreet(want) && want.street;
  const streetMatches = streetKnown && p.street && sameStreet(want.street, p.street)
    && (streetIsExact(want.street, p.street)
        || relaxedMatchIsLocal(want, { city: p.city, zip: String(p.postcode || "").slice(0, 5) }));
  if (streetKnown && p.street && !streetMatches) return null;

  let score = 0;
  let precision = "city";

  if (want.zip && p.postcode) score += String(p.postcode).slice(0, 5) === want.zip ? 2 : -2;
  if (want.city && p.city && sameText(p.city, want.city)) score += 2;
  if (want.state && state === want.state) score += 1;

  // streetMatches, not an exact-string test: a street the agent typed without
  // its "NW" still scores as the street it is, or the house below never gets
  // to count as an address.
  if (streetMatches) {
    score += 3;
    precision = "street";
  }
  if (want.houseNo && p.housenumber) {
    if (sameText(p.housenumber, want.houseNo)) {
      score += 4;
      // A house number is only an address when it sits on a street we
      // recognised; on its own it's a number that happens to agree.
      if (precision === "street" || !want.street) precision = "address";
    } else {
      score -= 1;
    }
  }
  if (precision === "city" && want.zip && String(p.postcode || "").slice(0, 5) === want.zip) {
    precision = "zip";
  }

  return { score, geo: { lat, lng, precision, source: "photon", matched: photonLabel(p) } };
}

// TIGER shouts: "14808 LARCH WAY, LYNNWOOD, WA, 98087". This is shown to
// people — in the review note, in the comps pane, as an autocomplete
// suggestion — so give it back the shape an address is written in.
export function censusLabel(matchedAddress) {
  const segs = String(matchedAddress || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!segs.length) return null;
  const zip = /^\d{5}(-\d{4})?$/.test(segs[segs.length - 1]) ? segs.pop() : "";
  const state = segs.length > 1 && stateAbbr(segs[segs.length - 1]) ? segs.pop().toUpperCase() : "";
  const head = segs.map(titleCase).join(", ");
  return [head, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

const titleCase = (s) =>
  String(s).toLowerCase().replace(/[A-Za-z0-9']+/g, (w) => {
    if (/^[nsew]$|^[ns][ew]$/.test(w)) return w.toUpperCase();   // directionals
    if (/^\d+(st|nd|rd|th)$/.test(w)) return w;                  // 128th, not 128Th
    return w.charAt(0).toUpperCase() + w.slice(1);
  });

const isUs = (p) => String(p.countrycode || "").toUpperCase() === "US";

// A sanity box around the 50 states — it exists to catch a provider handing
// back a point in another hemisphere, not to police borders.
const inUnitedStates = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat > 15 && lat < 72 && lng < -64 && lng > -172;

const sameText = (a, b) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase() && !!String(a || "").trim();

// "166th Avenue Northeast" and "166th Ave NE" are the same street; the shared
// USPS normalizer already knows that, so compare through it.
const streetKey = (s) => normalizeUsAddress(String(s || "")).toLowerCase().replace(/[^a-z0-9]/g, "");

const photonLabel = (p) =>
  [
    [p.housenumber, p.street].filter(Boolean).join(" ") || p.name,
    p.city || p.district || p.county,
    [stateAbbr(p.state || "") || p.state, p.postcode].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");

/* ---------- test seam ---------- */

export function _resetGeocodeCache() {
  cache.clear();
}
