// underwrite-checks-routes.test.mjs — the editor's two lookups and the quiet
// backtest. The lookups stay off until the checks are switched on (the
// listings pull costs money), and a lookup that broke answers 200 with a
// status — the Comps pane must price without it.
//
//   node --test underwrite-checks-routes.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-checks-routes-"));
delete process.env.DATABASE_URL;
delete process.env.AUTO_UNDERWRITE_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { _resetSiteCache } = await import("./site-context.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetJobs } = await import("./auto-underwrite.js");

const LOC = "loc-uw-checks-routes";
const ghlWrites = [];
const resolveLocation = () => ({ locationId: LOC, client: { call: async (p, o = {}) => { if (String(o.method || "GET").toUpperCase() !== "GET") ghlWrites.push(p); return {}; } } });
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/offers", createOffersRouter({ resolveLocation, uploadDir: process.env.DATA_DIR, publicBaseUrl: "http://127.0.0.1" }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const LAT = 47.799463, LNG = -122.335745;
const WAY = { elements: [{ type: "way", tags: { highway: "tertiary", name: "76th Avenue West" },
  geometry: [{ lat: LAT - 0.002, lon: LNG + 0.0002 }, { lat: LAT + 0.002, lon: LNG + 0.0002 }] }] };

// The network, stubbed — localhost goes through to the app under test.
const realFetch = globalThis.fetch;
let mode = { overpass: "ok", apify: "ok" };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1")) return realFetch(url, opts);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const bad = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "nope" });
  if (u.includes("geocoding.geo.census.gov")) return ok({ result: { addressMatches: [{ coordinates: { x: LNG, y: LAT }, matchedAddress: "22018 76TH AVE W, EDMONDS, WA, 98026" }] } });
  if (u.includes("overpass")) return mode.overpass === "ok" ? ok(WAY) : bad(504);
  if (u.includes("apify")) {
    if (mode.apify !== "ok") return bad(502);
    const body = String(opts.body || "");
    if (body.includes("for_sale")) return ok([{ zpid: "9", address: "21900 80th Ave W, Edmonds, WA", livingArea: 960, listingStatus: "FOR_SALE",
      latLong: { latitude: LAT + 0.001, longitude: LNG - 0.002 }, hdpData: { homeInfo: { zpid: "9", price: 650000, livingArea: 960, bedrooms: 2, bathrooms: 1, homeType: "SINGLE_FAMILY" } } }]);
    if (body.includes("searchUrls")) return ok([]);
    return ok([{ address: { streetAddress: "22018 76th Ave W", city: "Edmonds", state: "WA", zipcode: "98026" }, homeType: "SINGLE_FAMILY",
      bedrooms: 2, bathrooms: 1, livingArea: 960, yearBuilt: 1941, listingPhotos: [] }]);
  }
  return ok({ features: [] });
};
test.after(() => { globalThis.fetch = realFetch; });

const req = async (method, p, body) => {
  const r = await realFetch(B + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const setChecks = (underwriteChecks) => store.saveOfferSettings(LOC, { aiApiKey: "sk-ant-x", apifyToken: "apify-x", underwriteChecks });
const SITE_BODY = { address: "22018 76th Ave W, Edmonds, WA 98026", subject: { lat: LAT, lng: LNG }, comps: [{ id: "c1", lat: LAT + 0.003, lng: LNG + 0.004, address: "21800 80th Ave W, Edmonds, WA" }] };

test("the editor's street and listings lookups stay off until the checks are switched on", async () => {
  await setChecks({ enabled: false });
  const site = await req("POST", "/api/offers/comps/site", SITE_BODY);
  assert.equal(site.status, 200);
  assert.equal(site.json.site.status, "off");
  const act = await req("GET", "/api/offers/comps/actives?address=22018%2076th%20Ave%20W%2C%20Edmonds%2C%20WA&lat=47.799463&lng=-122.335745&beds=2&baths=1&sqft=960");
  assert.equal(act.json.status, "off");
  assert.equal(act.json.listings, null);
});

test("switched on, the street comes back classified and the listings come back as listings", async () => {
  await setChecks({ enabled: true });
  _resetSiteCache(); _resetCompsCache(); mode = { overpass: "ok", apify: "ok" };
  const site = await req("POST", "/api/offers/comps/site", SITE_BODY);
  assert.equal(site.json.site.status, "ok");
  assert.equal(site.json.site.subject.flags.busy_road.how, "fronts");
  assert.deepEqual(site.json.site.comps.c1, []);
  const act = await req("GET", "/api/offers/comps/actives?lat=47.799463&lng=-122.335745&beds=2&baths=1&sqft=960&homeType=SINGLE_FAMILY");
  assert.equal(act.json.status, "ok");
  assert.deepEqual(act.json.listings.map((l) => l.id), ["a-9"]);
});

test("a lookup that broke answers 200 with a status, never a 5xx", async () => {
  await setChecks({ enabled: true });
  _resetSiteCache(); _resetCompsCache(); mode = { overpass: "down", apify: "down" };
  const site = await req("POST", "/api/offers/comps/site", SITE_BODY);
  assert.equal(site.status, 200);
  assert.equal(site.json.site.status, "unavailable");
  const act = await req("GET", "/api/offers/comps/actives?lat=47.799463&lng=-122.335745");
  assert.equal(act.status, 200);
  assert.equal(act.json.status, "unavailable");
  mode = { overpass: "ok", apify: "ok" };
});

test("the backtest wants addresses, and starts quiet runs that leave no trace", async () => {
  await setChecks({ enabled: false });
  _resetJobs(); _resetSiteCache(); _resetCompsCache(); ghlWrites.length = 0;
  assert.equal((await req("POST", "/api/offers/automations/underwrite/backtest", {})).status, 400);
  const before = (await store.listOffers(LOC)).length;
  const r = await req("POST", "/api/offers/automations/underwrite/backtest", { items: [{ address: "22018 76th Ave W, Edmonds, WA 98026" }] });
  assert.equal(r.status, 202);
  assert.equal(r.json.jobs.length, 1);
  const jobId = r.json.jobs[0].jobId;
  assert.ok(jobId);
  let job = null;
  for (let i = 0; i < 200; i++) {
    job = (await req("GET", `/api/offers/automations/underwrite?jobId=${jobId}`)).json.job;
    if (["done", "held", "error"].includes(job.status)) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.ok(["done", "held", "error"].includes(job.status), `still ${job.status}`);
  assert.equal(job.quiet, true);
  assert.equal(job.forceChecks, true, "forced on although the saved switch is off");
  assert.deepEqual(ghlWrites, [], "no tag, no note");
  assert.equal((await store.listOffers(LOC)).length, before, "no draft, no offer");
});
