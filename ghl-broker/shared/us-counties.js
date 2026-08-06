// us-counties.js — offline US county lookup, generated from the 2024 Census
// Gazetteer (us-counties.json: state → normalized name → [lat, lng, radiusMi,
// officialName, geoid]). radiusMi is the circle-equivalent radius of the
// county's land area padded 1.4× for irregular shapes and clamped to
// RentCast's 100-mile search maximum. Counties and parishes are also keyed
// without their suffix ("king" ≡ "king county") — but never independent
// cities, so Virginia's "Richmond city" stays distinct from "Richmond County".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DATA = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "us-counties.json"), "utf8")
);

const norm = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// findCounty("King", "WA") / ("king county", "wa") → { name, geoid, lat, lng,
// radiusMi } or null.
export function findCounty(county, state) {
  const byState = DATA[String(state || "").trim().toUpperCase()];
  if (!byState) return null;
  const n = norm(county);
  const hit = byState[n] || byState[`${n} county`] || byState[`${n} parish`];
  if (!hit) return null;
  const [lat, lng, radiusMi, name, geoid] = hit;
  return { name, geoid, lat, lng, radiusMi };
}

// Loose equality between a county's official identity and how a listing
// provider labels it ("King" vs "King County" vs FIPS "53033").
export function listingInCounty(listing, county) {
  const fips = String(listing.countyFips || "");
  if (fips && (fips === county.geoid || `${listing.stateFips || ""}${fips}` === county.geoid)) return true;
  const a = norm(listing.county).replace(/ (county|parish)$/, "");
  const b = norm(county.name).replace(/ (county|parish)$/, "");
  return Boolean(a) && a === b;
}
