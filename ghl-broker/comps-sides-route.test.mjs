// comps-sides-route.test.mjs — the Comps pane's pull says which comps are
// across a main road (shared/same-side.js), and a map that won't load is a
// line on the board, never a failed pull.
//
//   node --test comps-sides-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "comps-sides-route-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetSiteCache } = await import("./site-context.js");
const { _resetFactsCache } = await import("./rehab-scan.js");

const LOC = "loc-comps-sides";
const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }), uploadDir: process.env.DATA_DIR }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
await store.saveOfferSettings(LOC, { apifyToken: "apify-x" });
test.after(() => server.close());

const LAT = 47.004526, LNG = -122.930211;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const at = (north, east) => ({ lat: LAT + north * M_LAT, lng: LNG + east * M_LNG });
const row = (id, street, p) => ({
  zpid: id, address: `${street}, Tumwater, WA 98512`, livingArea: 3000, latLong: { latitude: p.lat, longitude: p.lng },
  hdpData: { homeInfo: { zpid: id, price: 650000, dateSold: Date.now() - 60 * 86400000, livingArea: 3000, bedrooms: 4, bathrooms: 3,
    homeType: "SINGLE_FAMILY", latitude: p.lat, longitude: p.lng } },
});
const SOLD = [row("near", "4401 Blackstone Dr SW", at(400, 200)), row("lot25", "2404 56th Ave SW", at(-700, -300))];
const MAP = { elements: [{ type: "way", tags: { highway: "tertiary", name: "Trosper Road Southwest" },
  geometry: [at(-300, -3000), at(-300, 3000)].map((p) => ({ lat: p.lat, lon: p.lng })) }] };

function stub({ map = "ok" } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(B)) return original(url, opts);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("geocoding.geo.census.gov")) return ok({ result: { addressMatches: [{ coordinates: { x: LNG, y: LAT }, matchedAddress: "2325 48TH AVE SW, TUMWATER, WA, 98512" }] } });
    if (u.includes("overpass")) return map === "down" ? { ok: false, status: 429, text: async () => "slow down" } : ok(MAP);
    if (u.includes("apify")) return ok(String(opts.body || "").includes("searchUrls") ? SOLD : []);
    return ok({ features: [] });
  };
  return () => { globalThis.fetch = original; };
}

const pull = () => fetch(`${B}/api/offers/comps?address=${encodeURIComponent("2325 48th Ave SW, Tumwater, WA 98512")}&beds=4&baths=3&sqft=3174&radius=1`).then((r) => r.json());

test("the pane's pull marks the sale across Trosper Rd and leaves the one on the house's side alone", async () => {
  _resetCompsCache(); _resetSiteCache(); _resetFactsCache();
  const restore = stub();
  try {
    const r = await pull();
    assert.deepEqual(r.sides, { status: "ok" });
    const byId = Object.fromEntries((r.comps || []).map((c) => [c.id ?? c.zpid, c]));
    const lot = Object.values(byId).find((c) => /56th Ave/.test(c.address));
    const near = Object.values(byId).find((c) => /Blackstone/.test(c.address));
    assert.deepEqual(lot.side.across.map((b) => b.name), ["Trosper Road Southwest"]);
    assert.deepEqual(near.side.across, []);
  } finally { restore(); }
});

test("the map down still returns the comps, with no side and a status saying so", async () => {
  _resetCompsCache(); _resetSiteCache(); _resetFactsCache();
  const restore = stub({ map: "down" });
  try {
    const r = await pull();
    assert.equal(r.sides.status, "unavailable");
    assert.equal(r.comps.length, 2);
    assert.ok(r.comps.every((c) => c.side === undefined));
  } finally { restore(); }
});
