// comps-same-side.test.mjs — the ARV comes from the house's own side of the
// main roads, and the era band gives way before the search goes wider.
//
// 2026-10-06, Matt on 2325 48th Ave SW, Tumwater (a 1989 4-bed, 3,174 sqft):
// "it's picking stuff that is ON THE OTHER SIDE of a main road". All four
// ARV comps were new builds across Trosper Rd SW at ~$900K; six sales within
// 0.4 mi on the house's own side sat unused, because they were built 2005–2014
// — outside the ±15-year band — so the half-mile ring held too few and the
// run went a mile out. This is that street, run end to end as a fill run with
// Zillow and OpenStreetMap stubbed.
//
//   node --test comps-same-side.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-same-side-test-"));
delete process.env.DATABASE_URL;
delete process.env.AUTO_UNDERWRITE_ENABLED;

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs } = await import("./auto-underwrite.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetSiteCache } = await import("./site-context.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
await store.init();

const ADDRESS = "2325 48th Ave SW, Tumwater, WA 98512";
const LAT = 47.004526, LNG = -122.930211;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const DAY = 86400000;
const at = (north, east) => ({ lat: LAT + north * M_LAT, lng: LNG + east * M_LNG });

// The house's side: six sales 300–600 m out, built 2005–2014, three at
// renovated money (~$225/sqft) and three tired. Across Trosper Rd (300 m
// south): six new builds at ~$280/sqft, 650–950 m out, year not on record.
const SAME = [
  { street: "4401 Blackstone Dr SW", n: 450, e: 250, sqft: 3197, ppsf: 228, year: 2006 },
  { street: "2092 Blackstone Ct SW", n: 600, e: 150, sqft: 3150, ppsf: 225, year: 2005 },
  { street: "4739 Joppa St SW", n: 150, e: -450, sqft: 2900, ppsf: 222, year: 2014 },
  { street: "4804 Lambskin St SW", n: 100, e: -320, sqft: 2700, ppsf: 182, year: 2012 },
  { street: "2480 Charter Ln SW", n: 120, e: -400, sqft: 2800, ppsf: 180, year: 2010 },
  { street: "4344 Blackstone Dr SW", n: 550, e: 300, sqft: 2750, ppsf: 178, year: 2006 },
];
const ACROSS = [0, 1, 2, 3, 4, 5].map((i) => ({ street: `${5611 + i * 4} Mimi St SW`, n: -650 - i * 60, e: -200 + i * 40, sqft: 3213, ppsf: 280, year: null }));
const row = (c, i) => {
  const { lat, lng } = at(c.n, c.e);
  return {
    zpid: `z${i}`, address: `${c.street}, Tumwater, WA 98512`, livingArea: c.sqft, latLong: { latitude: lat, longitude: lng },
    hdpData: { homeInfo: { zpid: `z${i}`, price: c.sqft * c.ppsf, dateSold: Date.now() - (30 + i * 9) * DAY,
      livingArea: c.sqft, bedrooms: 4, bathrooms: 3, homeType: "SINGLE_FAMILY", latitude: lat, longitude: lng } },
  };
};
const soldRows = () => [...SAME, ...ACROSS].map(row);
const SUBJECT = {
  address: { streetAddress: "2325 48th Ave SW", city: "Tumwater", state: "WA", zipcode: "98512" },
  homeType: "SINGLE_FAMILY", bedrooms: 4, bathrooms: 3, livingArea: 3174, yearBuilt: 1989,
  listingPhotos: Array.from({ length: 10 }, (_, i) => ({ url: `https://photos.zillowstatic.com/fp/${i}abc-p_f.jpg` })),
  description: "Needs updating throughout.", listingStatus: "FOR_SALE", price: 560000,
};
const detailRow = (c) => ({ address: { streetAddress: c.street, city: "Tumwater", state: "WA", zipcode: "98512" }, yearBuilt: c.year, livingArea: c.sqft, bedrooms: 4, bathrooms: 3, homeType: "SINGLE_FAMILY" });
const way = (tags, pts) => ({ type: "way", tags, geometry: pts.map((p) => ({ lat: p.lat, lon: p.lng })) });
const MAP = { elements: [way({ highway: "tertiary", name: "Trosper Road Southwest" }, [at(-300, -3000), at(-300, 3000)])] };

function stubFetch({ map = "ok" } = {}) {
  const calls = { sides: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("geocoding.geo.census.gov")) {
      return ok({ result: { addressMatches: [{ coordinates: { x: LNG, y: LAT }, matchedAddress: "2325 48TH AVE SW, TUMWATER, WA, 98512" }] } });
    }
    if (u.includes("overpass")) {
      calls.sides++;
      if (map === "down") return { ok: true, status: 200, text: async () => "<?xml version='1.0'?><osm><remark>rate limited</remark></osm>" };
      return ok(MAP);
    }
    if (u.includes("apify")) {
      const body = String(opts.body || "");
      if (body.includes("searchUrls")) return ok(body.includes("for_sale") ? [] : soldRows());
      let asked = [];
      try { asked = JSON.parse(body).addresses || []; } catch { asked = []; }
      const known = [...SAME, ...ACROSS].filter((c) => c.year && asked.some((a) => String(a).startsWith(c.street)));
      return ok([SUBJECT, ...known.map(detailRow)]);
    }
    return ok({ features: [] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const scanPhotos = async () => ({
  summary: "Dated throughout.", items: [{ id: "paint-int", note: "scuffed walls" }],
  bathrooms: [{ tier: "mid", note: "original" }], bedrooms: [],
  areas: [{ area: "kitchen", grade: "dated", note: "" }], contents: "none", custom: [],
});
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const client = { call: async () => ({}) };
const saved = { aiApiKey: "sk-ant-x", apifyToken: "apify-x" };

async function run({ map = "ok" } = {}) {
  _resetJobs(); _resetCompsCache(); _resetSiteCache(); _resetFactsCache();
  const { calls, restore } = stubFetch({ map });
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-same-side", saved, store, contactId: "agent-1", address: ADDRESS, fill: true,
      deps: { scanPhotos, createOffer: async () => { throw new Error("a fill run makes no offer"); } } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.notEqual(job.status, "error", job.error || "");
    return { job, calls };
  } finally { restore(); }
}

const isMimi = (c) => /Mimi St/.test(c.address);

test("the ARV comes from the house's own side of Trosper Rd, not the new builds across it", async () => {
  const { job, calls } = await run();
  assert.equal(calls.sides, 1, "one map lookup for the run");
  assert.ok(job.compsUsed.length >= 3, job.warnings.join(" | "));
  assert.deepEqual(job.compsUsed.filter(isMimi), [], `ARV comps: ${job.compsUsed.map((c) => c.address).join("; ")}`);
  assert.ok(job.arv < 760000, `ARV ${job.arv} — the house's side sells around $225/sqft, not the $280 across the road`);
  const snap = job.snapshot.comps.result.comps;
  assert.ok(snap.filter(isMimi).every((c) => c.side?.across?.[0]?.name === "Trosper Road Southwest"), "the board says which road");
});

// The 2005–2014 sales sat outside the old ±15-year band; since 2026-10-08 the
// band is ±30 and they are in the pool outright, so no give-way is needed.
test("the age band never sends the search a mile out", async () => {
  const { job } = await run();
  assert.equal(job.compsRadiusMiles, 0.5, job.warnings.join(" | "));
  assert.ok(!job.warnings.some((w) => /widened the search/.test(w)));
});

test("with the map down the run still prices, and says the side wasn't checked", async () => {
  const { job } = await run({ map: "down" });
  assert.ok(job.arv > 0);
  assert.ok(job.warnings.some((w) => /side of the main roads not checked/.test(w)), job.warnings.join(" | "));
  assert.ok(job.snapshot.comps.result.comps.every((c) => c.side === undefined), "no side is ever guessed");
});
