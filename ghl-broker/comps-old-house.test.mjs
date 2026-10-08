// comps-old-house.test.mjs — an old house (or one Zillow dates 1900) still
// gets comps from the sales right around it.
//
// 2026-10-08, Matt on 3037 Massey Rd, Everson (3/2, 1,548 sqft, Zillow "built
// 1900"): the agent got "comps are coming back pretty thin" while the board
// showed 3/2s around $570–585K a short drive away. The run found 44 sales in
// the box and kept 0: every one was outside 1900 ±15 years, and the same-side
// fallback that lets the age band give way was thrown out because four sales
// only make a gut check. Matt: "loosen comps built in year and skew towards
// one right near to the subject". This is that house, run end to end as a fill
// run with Zillow and OpenStreetMap stubbed.
//
//   node --test comps-old-house.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-old-house-test-"));
delete process.env.DATABASE_URL;
delete process.env.AUTO_UNDERWRITE_ENABLED;

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs } = await import("./auto-underwrite.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetSiteCache } = await import("./site-context.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
await store.init();

const ADDRESS = "3037 Massey Rd, Everson, WA 98247";
const LAT = 48.9201, LNG = -122.3291;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const DAY = 86400000;
const at = (north, east) => ({ lat: LAT + north * M_LAT, lng: LNG + east * M_LNG });

// Four 3/2s 250–700 m out, built 1965–1995 — a few rural sales, not a
// subdivision: enough for a gut check, short of the six a full proxy needs.
const NEAR = [
  { street: "7420 Emerson Rd", n: 250, e: -200, sqft: 1500, ppsf: 380, year: 1978 },
  { street: "204 W 4th St", n: 600, e: -350, sqft: 1600, ppsf: 365, year: 1965 },
  { street: "1200 Haystack Ln", n: -400, e: -500, sqft: 1520, ppsf: 330, year: 1995 },
  { street: "7534 Emerson Rd", n: 300, e: 450, sqft: 1650, ppsf: 340, year: 1988 },
];
const row = (c, i) => {
  const { lat, lng } = at(c.n, c.e);
  return {
    zpid: `z${i}`, address: `${c.street}, Everson, WA 98247`, livingArea: c.sqft, latLong: { latitude: lat, longitude: lng },
    hdpData: { homeInfo: { zpid: `z${i}`, price: c.sqft * c.ppsf, dateSold: Date.now() - (30 + i * 20) * DAY,
      livingArea: c.sqft, bedrooms: 3, bathrooms: 2, homeType: "SINGLE_FAMILY", latitude: lat, longitude: lng } },
  };
};
const subjectRow = (yearBuilt) => ({
  address: { streetAddress: "3037 Massey Rd", city: "Everson", state: "WA", zipcode: "98247" },
  homeType: "SINGLE_FAMILY", bedrooms: 3, bathrooms: 2, livingArea: 1548, yearBuilt,
  listingPhotos: Array.from({ length: 10 }, (_, i) => ({ url: `https://photos.zillowstatic.com/fp/${i}abc-p_f.jpg` })),
  description: "Needs work throughout.", listingStatus: "FOR_SALE", price: 450000,
});
const detailRow = (c) => ({ address: { streetAddress: c.street, city: "Everson", state: "WA", zipcode: "98247" }, yearBuilt: c.year, livingArea: c.sqft, bedrooms: 3, bathrooms: 2, homeType: "SINGLE_FAMILY" });

function stubFetch(yearBuilt) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("geocoding.geo.census.gov")) {
      return ok({ result: { addressMatches: [{ coordinates: { x: LNG, y: LAT }, matchedAddress: "3037 MASSEY RD, EVERSON, WA, 98247" }] } });
    }
    if (u.includes("overpass")) return ok({ elements: [] });
    if (u.includes("apify")) {
      const body = String(opts.body || "");
      if (body.includes("searchUrls")) return ok(body.includes("for_sale") ? [] : NEAR.map(row));
      let asked = [];
      try { asked = JSON.parse(body).addresses || []; } catch { asked = []; }
      const known = NEAR.filter((c) => asked.some((a) => String(a).startsWith(c.street)));
      return ok([subjectRow(yearBuilt), ...known.map(detailRow)]);
    }
    return ok({ features: [] });
  };
  return () => { globalThis.fetch = original; };
}

const scanPhotos = async () => ({
  summary: "Dated throughout.", items: [{ id: "paint-int", note: "scuffed walls" }],
  bathrooms: [{ tier: "mid", note: "original" }], bedrooms: [],
  areas: [{ area: "kitchen", grade: "dated", note: "" }], contents: "none", custom: [],
});
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const client = { call: async () => ({}) };
const saved = { aiApiKey: "sk-ant-x", apifyToken: "apify-x" };

async function run(yearBuilt) {
  _resetJobs(); _resetCompsCache(); _resetSiteCache(); _resetFactsCache();
  const restore = stubFetch(yearBuilt);
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-old-house", saved, store, contactId: "agent-1", address: ADDRESS, fill: true,
      deps: { scanPhotos, createOffer: async () => { throw new Error("a fill run makes no offer"); } } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.notEqual(job.status, "error", job.error || "");
    return job;
  } finally { restore(); }
}

const says = (job) => [...(job.held || []), ...(job.warnings || [])].join(" | ");

test("a house Zillow dates 1900 still gets comps from the sales around it", async () => {
  const job = await run(1900);
  assert.ok(job.compsUsed.length >= 2, says(job));
  assert.ok(job.arv > 0, says(job));
  assert.ok(!(job.held || []).some((h) => /priced comps|no ARV/.test(h)), says(job));
});

test("a real 1925 house with only newer houses around it still gets an ARV from them", async () => {
  const job = await run(1925);
  assert.ok(job.compsUsed.length >= 2, says(job));
  assert.ok(job.arv > 0, says(job));
  assert.ok(!(job.held || []).some((h) => /priced comps|no ARV/.test(h)), says(job));
});

test("the closest sale is in the ARV set", async () => {
  const job = await run(1900);
  assert.ok(job.compsUsed.some((c) => /7420 Emerson/.test(c.address)), job.compsUsed.map((c) => c.address).join("; "));
});
