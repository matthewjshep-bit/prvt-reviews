// price-v2.test.mjs — the offer engine prices every named house in the shadow, and changes nothing.
//
//   node --test price-v2.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "price-v2-test-"));
delete process.env.DATABASE_URL;
process.env.AUTO_UNDERWRITE_ENABLED = "true";

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs } = await import("./auto-underwrite.js");
const { readsFrom, nextRecord, shadowPrice, ENGINE_VERSION } = await import("./price-v2.js");
const { houseKey } = await import("./shared/current-offer.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
await store.init();

const ADDRESS = "4417 Somerset Ln, Everett, WA 98203";
const BRICKED = {
  id: "b1", arv: 640000, arvConfidence: 0.9, cmv: 455000, totalRepairCost: 85000, repairs: [{ repair: "Roof", cost: 85000 }],
  property: { address: { fullAddress: ADDRESS }, details: { bedrooms: 3, bathrooms: 2, squareFeet: 1500, yearBuilt: 1961, condition_rating: 3.2 } },
  comps: [1, 2, 3].map((i) => ({ compType: "arv", selected: true, is_renovated: null, renovation_score: 0.85, details: { lastSaleAmount: 650000 + i } })),
  shareLink: "https://bricked.ai/share/b1",
};

function stubFetch() {
  _resetCompsCache();
  _resetFactsCache?.();
  const calls = { bricked: 0, detail: 0, search: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (body) => ({ ok: true, status: 200, statusText: "", json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("api.bricked.ai")) { calls.bricked++; return reply(BRICKED); }
    if (u.includes("geocoding.geo.census.gov")) return reply({ result: { addressMatches: [{ coordinates: { x: -122.2, y: 47.95 }, matchedAddress: "4417 SOMERSET LN, EVERETT, WA, 98203" }] } });
    if (u.includes("apify")) {
      if (String(opts.body || "").includes("searchUrls")) { calls.search++; return reply([]); }
      calls.detail++;
      return reply([{ address: { streetAddress: "4417 Somerset Ln", city: "Everett", state: "WA", zipcode: "98203" }, homeType: "SINGLE_FAMILY",
        bedrooms: 3, bathrooms: 1.75, livingArea: 1480, yearBuilt: 1962, lotSize: 7200, price: 525000, homeStatus: "FOR_SALE", description: "Original kitchen, roof at the end of its life", listingPhotos: [] }]);
    }
    return reply({ features: [] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const client = { call: async () => ({}) };
const base = { aiApiKey: "sk-ant-x", apifyToken: "apify-x", brickedApiKey: "bk", brickedOnDrafts: true, maoPctOfArv: 75, wholesaleFee: 30000, autoUnderwriteMode: "skeleton" };

async function run({ contactId, saved = {} }) {
  _resetJobs();
  const { calls, restore } = stubFetch();
  try {
    const { job } = await startUnderwrite({ client, locationId: "LOC-v2", saved: { ...base, ...saved }, store, contactId, message: "needs a roof", address: ADDRESS,
      deps: { createOffer: async () => { throw new Error("nothing should be created"); }, onOfferCreated: async () => {} } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}`);
    return { job, calls, draft: await store.getOffer(job.offerId) };
  } finally { restore(); }
}

test("a shadow price changes nothing on the draft or the thread, and buys nothing", async () => {
  const off = await run({ contactId: "v2-off" });
  assert.equal(await store.getHousePricing("LOC-v2", houseKey(ADDRESS)), null, "switch off: nothing recorded");
  const on = await run({ contactId: "v2-on", saved: { pricingV2: { shadow: true } } });
  assert.equal(on.job.status, off.job.status);
  assert.deepEqual({ ...on.calls }, { ...off.calls }, "no extra lookups");
  const strip = (d) => ({ status: d.status, cash: d.cashAmount, inputs: d.draft?.inputs, held: d.autoUnderwrite?.held, brickedHeld: d.autoUnderwrite?.brickedHeld });
  assert.deepEqual(strip(on.draft), strip(off.draft), "the draft is the same with the shadow on");
  const rec = await store.getHousePricing("LOC-v2", houseKey(ADDRESS));
  assert.ok(rec, "the house has a record");
  assert.equal(rec.doc.v2.version, ENGINE_VERSION);
  assert.equal(rec.doc.v2.arv, 640000);
  assert.equal(rec.doc.reads.list, 525000, "the list price from the listing the run already read");
  assert.match(rec.doc.reads.remarks, /roof at the end of its life/);
  assert.ok(["A", "B", "C"].includes(rec.doc.v2.grade));
  assert.ok(rec.doc.v2.walkAway > 0 && rec.doc.v2.open <= rec.doc.v2.walkAway);
});

test("another agent naming the same house adds to its history and keeps its outcome", async () => {
  const key = houseKey(ADDRESS);
  const prev = await store.getHousePricing("LOC-v2", key);
  await store.upsertHousePricing("LOC-v2", key, { ...prev.doc, outcome: { mattNumber: 300000 } });
  // (the same agent again inside 24 hours is the run's own duplicate check, before any pricing)
  await run({ contactId: "v2-on-2", saved: { pricingV2: { shadow: true } } });
  const rec = await store.getHousePricing("LOC-v2", key);
  assert.equal(rec.doc.history.length, 2);
  assert.deepEqual(rec.doc.outcome, { mattNumber: 300000 });
});

test("the seller's number and their repair figure come from the contact's events on this house only", () => {
  const events = [
    { type: "property_details", at: "2026-11-01T10:00:00Z", address: "4417 Somerset Lane, Everett WA", data: { sellerAsk: 480000 } },
    { type: "property_details", at: "2026-11-02T10:00:00Z", address: "99 Other St, Everett, WA", data: { sellerAsk: 900000 } },
    { type: "agent_estimate", at: "2026-11-01T11:00:00Z", address: ADDRESS, data: { arv: 700000, rehab: 110000 } },
  ];
  const r = readsFrom({ address: ADDRESS, events, listPrice: 525000 });
  assert.equal(r.sellerNumber, 480000);
  assert.equal(r.theirRepairs, 110000);
  assert.equal(r.zip, "98203");
  assert.equal(r.bricked, null);
});

test("a record keeps at most ten answers, newest last", () => {
  let doc = null;
  for (let i = 0; i < 12; i++) doc = nextRecord(doc, { address: ADDRESS, reads: {}, v2: { grade: "B", walkAway: 1000 * i }, at: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z` });
  assert.equal(doc.history.length, 10);
  assert.equal(doc.history.at(-1).walkAway, 11000);
  assert.equal(doc.firstAt, "2026-11-01T00:00:00Z");
});

test("a failure in the shadow never reaches the run", async () => {
  const broken = { upsertHousePricing: async () => { throw new Error("db down"); }, getHousePricing: async () => null, listContactEvents: async () => [] };
  const job = { warnings: [], message: "" };
  const out = await shadowPrice({ store: broken, locationId: "L", saved: { pricingV2: { shadow: true } }, job, address: ADDRESS });
  assert.equal(out, null);
  assert.match(job.warnings[0], /shadow price: db down/);
});
