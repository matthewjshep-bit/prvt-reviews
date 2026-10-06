// auto-underwrite-checks.test.mjs — the buyer-view checks inside a real run.
//
// A Yakima-like house (5232 S Yakima Ave, Tacoma: a 1952 3/1 on a secondary
// street, renovated comps around 416k, listings asking less, sold as-is) run
// end to end as a fill run, with Zillow, OpenStreetMap and the photo scan
// stubbed. The checks ship switched off; on, they cut for the street, hold
// the ARV to today's listings and add what the scope left out — and never
// hold a run, and a quiet backtest run leaves no trace.
//
//   node --test auto-underwrite-checks.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-checks-test-"));
delete process.env.DATABASE_URL;
delete process.env.AUTO_UNDERWRITE_ENABLED;

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs, agentNumbersRescue } = await import("./auto-underwrite.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetSiteCache } = await import("./site-context.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
await store.init();

const ADDRESS = "5232 S Yakima Ave, Tacoma, WA 98408";
const LAT = 47.20969, LNG = -122.443276;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
const DAY = 86400000;

// Eight sold comps: four at renovated money, four tired. All on quiet streets
// ~230 m west of the subject's arterial.
const soldRows = () => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
  const renovated = i < 4;
  const sqft = 1300;
  const lat = LAT + (i - 4) * 60 * M_LAT, lng = LNG - 230 * M_LNG;
  return {
    zpid: `z${i}`, address: `${5100 + i * 4} S Ainsworth Ave, Tacoma, WA 98408`, livingArea: sqft,
    latLong: { latitude: lat, longitude: lng },
    hdpData: { homeInfo: { zpid: `z${i}`, price: renovated ? 412000 + i * 2000 : 299000 + i * 1000, dateSold: Date.now() - (40 + i * 10) * DAY,
      livingArea: sqft, bedrooms: 3, bathrooms: 1, homeType: "SINGLE_FAMILY", latitude: lat, longitude: lng } },
  };
});
// Listings: two that list like flips (~389k), two tired.
const activeRows = () => [389000, 385000, 300000, 305000].map((price, i) => {
  const lat = LAT + (i - 2) * 80 * M_LAT, lng = LNG + 400 * M_LNG;
  return {
    zpid: `a${i}`, address: `${5300 + i * 4} S Cedar St, Tacoma, WA 98408`, livingArea: 1300, listingStatus: "FOR_SALE",
    latLong: { latitude: lat, longitude: lng },
    hdpData: { homeInfo: { zpid: `a${i}`, price, livingArea: 1300, bedrooms: 3, bathrooms: 1, homeType: "SINGLE_FAMILY", latitude: lat, longitude: lng } },
  };
});
const SUBJECT = {
  address: { streetAddress: "5232 S Yakima Ave", city: "Tacoma", state: "WA", zipcode: "98408" },
  homeType: "SINGLE_FAMILY", bedrooms: 3, bathrooms: 1, livingArea: 1300, yearBuilt: 1952,
  listingPhotos: Array.from({ length: 10 }, (_, i) => ({ url: `https://photos.zillowstatic.com/fp/${i}abc-p_f.jpg` })),
  description: "Sold strictly as-is. Needs work throughout.", listingStatus: "FOR_SALE", price: 260000,
  latitude: LAT, longitude: LNG,
};
// S Yakima Ave: a secondary, 12 m east of the house.
const OVERPASS = { elements: [{ type: "way", tags: { highway: "secondary", name: "South Yakima Avenue", maxspeed: "30 mph" },
  geometry: [{ lat: LAT - 400 * M_LAT, lon: LNG + 12 * M_LNG }, { lat: LAT + 400 * M_LAT, lon: LNG + 12 * M_LNG }] }] };

function stubFetch({ overpass = "ok" } = {}) {
  // `overpass` is the street check; `sides` the same-side map every run
  // reads (site-context.js fetchBarriers), told apart by the rivers it asks for.
  const calls = { overpass: 0, sides: 0, forSale: 0, sold: 0, detail: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("geocoding.geo.census.gov")) {
      return ok({ result: { addressMatches: [{ coordinates: { x: LNG, y: LAT }, matchedAddress: "5232 S YAKIMA AVE, TACOMA, WA, 98408" }] } });
    }
    if (u.includes("overpass")) {
      if (String(opts.body || "").includes("waterway")) calls.sides++;
      else calls.overpass++;
      if (overpass === "down") return { ok: true, status: 200, text: async () => "<?xml version='1.0'?><osm><remark>rate limited</remark></osm>" };
      return ok(OVERPASS);
    }
    if (u.includes("apify")) {
      const body = String(opts.body || "");
      if (body.includes("searchUrls")) {
        if (body.includes("for_sale")) { calls.forSale++; return ok(activeRows()); }
        calls.sold++;
        return ok(soldRows());
      }
      calls.detail++;
      return ok([SUBJECT]);
    }
    return ok({ features: [] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// The photo scan, stubbed: a dated house, the rooms and floors called out,
// nothing said about the wiring or the pipes.
const scanPhotos = async () => ({
  summary: "Dated throughout.",
  items: [{ id: "paint-int", note: "scuffed walls" }, { id: "lvp", note: "worn carpet" }],
  bathrooms: [{ tier: "mid", note: "original" }], bedrooms: [],
  areas: [{ area: "kitchen", grade: "dated", note: "" }, { area: "electrical", grade: "not_visible", note: "" }],
  contents: "none", custom: [],
});

const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const writes = [];
const client = { call: async (p, o = {}) => { if (String(o.method || "GET").toUpperCase() !== "GET") writes.push(`${o.method} ${p}`); return {}; } };
const base = { aiApiKey: "sk-ant-x", apifyToken: "apify-x" };
const reset = () => { _resetJobs(); _resetCompsCache(); _resetSiteCache(); _resetFactsCache(); writes.length = 0; };

async function run({ saved, quiet = false, forceChecks = false, overpass = "ok", locationId = "LOC-checks" }) {
  reset();
  const { calls, restore } = stubFetch({ overpass });
  try {
    const { job } = await startUnderwrite({ client, locationId, saved, store, contactId: "agent-1", address: ADDRESS, fill: true,
      quiet, forceChecks, deps: { scanPhotos, createOffer: async () => { throw new Error("a fill run makes no offer"); } } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.notEqual(job.status, "error", job.error || "");
    return { job, calls };
  } finally { restore(); }
}

test("checks switched off price exactly as before and call nothing new", async () => {
  const { job, calls } = await run({ saved: base });
  assert.equal(calls.overpass, 0, "no street lookup");
  assert.equal(calls.forSale, 0, "no listings pull");
  assert.equal(job.checks, null);
  assert.equal(job.snapshot.checks, null);
  assert.deepEqual(job.snapshot.comps.adjustments, []);
  assert.equal(job.arv, 416000, "the comps' own number (415k before distance weighed 30, 2026-10-06)");
});

test("the Yakima house is cut for the street, held to its listings and given what the scope left out", async () => {
  const off = await run({ saved: base });
  const { job, calls } = await run({ saved: { ...base, underwriteChecks: { enabled: true } } });
  assert.equal(calls.overpass, 1);
  assert.equal(calls.forSale, 1);
  const s = job.checks;
  assert.ok(s, "the checks ran");
  assert.deepEqual(s.arv.adjustments.map((a) => [a.key, a.pct]), [["busy_road", -5]], "no comp shares the arterial");
  assert.ok(s.arv.capped, "held to what similar houses list for");
  assert.ok(job.arv < 380000, `ARV ${job.arv} — buyers said 350–375`);
  assert.ok(job.repairs > off.job.repairs, `repairs ${job.repairs} vs ${off.job.repairs}`);
  assert.ok(s.rehab.rows.some((r) => r.key === "systems_electrical"), "a 1952 house's wiring wasn't priced");
  assert.equal(job.checksBefore.arv, off.job.arv, "the number before the checks is the run without them");
  // The editor opens on exactly what the run did.
  assert.ok(job.snapshot.comps.adjustments.some((a) => a.key === "busy_road" && a.source === "auto"));
  assert.ok(job.snapshot.rehab.allowance.length > 0);
  assert.equal(job.snapshot.inputs.arv, job.arv);
  assert.equal(job.snapshot.inputs.repairs, job.repairs);
  assert.deepEqual(job.snapshot.checks, s);
});

test("no check ever adds a hold", async () => {
  const off = await run({ saved: base });
  const on = await run({ saved: { ...base, underwriteChecks: { enabled: true } } });
  assert.deepEqual(on.job.held, off.job.held);
});

test("Overpass down leaves the ARV alone on the street, and says so", async () => {
  const { job, calls } = await run({ saved: { ...base, underwriteChecks: { enabled: true } }, overpass: "down" });
  assert.ok(calls.overpass >= 2, "tried the mirror too");
  assert.equal(job.checks.status.site, "unavailable");
  assert.ok(!job.checks.arv.adjustments.some((a) => a.key === "busy_road"));
  assert.ok(job.warnings.some((w) => /^street not checked/.test(w)), job.warnings.join(" | "));
});

test("a backtest forces the checks on without the saved switch, and a quiet run writes no tag, note, draft or row", async () => {
  const before = (await store.listOffers?.("LOC-quiet") || []).length;
  const { job } = await run({ saved: base, quiet: true, forceChecks: true, locationId: "LOC-quiet" });
  assert.ok(job.checks, "forced on for this run");
  assert.deepEqual(writes, [], "nothing written to GHL");
  const after = (await store.listOffers?.("LOC-quiet") || []).length;
  assert.equal(after, before, "nothing written to the store");
  assert.equal(job.fill, true, "a quiet run is a fill run");
});

test("an agent's value is still held to today's listings and still takes the street cut", () => {
  // List 400k: their 450k is inside 125% of list, so today's listings (389k)
  // are what hold it, and the street takes 5% off that.
  const r = agentNumbersRescue({
    held: ["only 1 renovated/updated comps within 1 mi — need 3"], theirArv: 450000, listPrice: 400000,
    ceiling: 389000, cutPct: -5,
  });
  assert.equal(r.value, 370000, "450k → held to 389k listings → less 5% for the street");
  assert.match(r.basis, /held to today's listings.*less the street/);
  const plain = agentNumbersRescue({ held: ["only 1 renovated/updated comps within 1 mi — need 3"], theirArv: 300000, listPrice: 400000 });
  assert.equal(plain.value, 300000, "without the checks, unchanged");
});
