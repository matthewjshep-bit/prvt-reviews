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

/* ---------- the seller's own number, and the words about this house (audit 2026-11-09) ---------- */

const { priceHouse } = await import("./shared/price-engine.js");
// A sure read of an invented house: Bricked at 640k, 1,500 sqft built 1961, single-family.
const SURE = { sqft: 1500, yearBuilt: 1961, homeType: "SINGLE_FAMILY", bricked: { arv: 640000, arvConfidence: 0.9, condition: 3, comps: [
  { use: "arv", renovated: true }, { use: "arv", renovated: true }, { use: "arv", renovated: true }] } };

test("a seller's number filed under a shorter spelling of the address still caps the engine", () => {
  const events = [
    { type: "house_mentioned", at: "2026-11-05T10:00:00Z", address: "4417 Somerset", data: { sellerAsk: 330000, note: "" } },
    { type: "house_mentioned", at: "2026-11-06T10:00:00Z", address: "4417 Somerset, Bothell", data: { sellerAsk: 999000, note: "" } },
  ];
  const r = readsFrom({ address: ADDRESS, events, listPrice: 525000 });
  assert.equal(r.sellerNumber, 330000, "their number on this house, not the namesake in another town");
  const v = priceHouse({ ...SURE, ...r, bricked: SURE.bricked, homeType: SURE.homeType, sqft: SURE.sqft, yearBuilt: SURE.yearBuilt });
  assert.ok(v.open <= 330000 && v.walkAway <= 330000, `open ${v.open}, walk-away ${v.walkAway}`);
  // The newest of their numbers on the house wins, whichever way they said it.
  const later = readsFrom({ address: ADDRESS, events: [...events,
    { type: "offer_countered", at: "2026-11-07T10:00:00Z", address: "4417 Somerset Ln", data: { amount: 318000 } }] });
  assert.equal(later.sellerNumber, 318000);
  const counter = readsFrom({ address: ADDRESS, events, offer: { address: ADDRESS, counter: { amount: 312500, at: "2026-11-08T10:00:00Z" } } });
  assert.equal(counter.sellerNumber, 312500, "a counter on the offer itself");
  const dossier = readsFrom({ address: ADDRESS, events, dossier: { have: { sellerAsk: { value: 305000, at: "2026-11-09T10:00:00Z" } } } });
  assert.equal(dossier.sellerNumber, 305000, "the dossier's sellerAsk");
});

test("a payoff the agent mentions never caps the engine", () => {
  const events = [
    { type: "house_mentioned", at: "2026-11-05T10:00:00Z", address: ADDRESS, data: { sellerAsk: 210000, note: "owes about 210k on the mortgage" } },
  ];
  const r = readsFrom({ address: ADDRESS, events, message: "they still owe around 210 on it", listPrice: 525000 });
  assert.equal(r.sellerNumber, 0, "what they owe is not what they'd take, and the list price is not their number either");
  const asked = readsFrom({ address: ADDRESS, listPrice: 525000, events: [
    { type: "house_mentioned", at: "2026-11-05T10:00:00Z", address: ADDRESS, data: { sellerAsk: 400000, note: "wants 400, owes 210" } }] });
  assert.equal(asked.sellerNumber, 400000, "a note that also says what they want is their number");
});

test("a wholesaler's house named a text before the address doesn't go out grade A", () => {
  const thread = [
    "[2026-11-04 16:00] THEM sms: The Larkspur St one is a short sale by the way",
    "[2026-11-05 17:01] THEM sms: Got one on Somerset for you, it's an assignment and my buyer walked",
    "[2026-11-05 17:02] US sms: Sounds good, what's the address?",
    "[2026-11-05 17:05] THEM sms: 4417 Somerset Ln, Everett",
  ].join("\n");
  const reads = readsFrom({ address: ADDRESS, message: "4417 Somerset Ln, Everett", thread, listPrice: 525000 });
  assert.match(reads.said, /assignment/, "their earlier words about this house are read");
  assert.doesNotMatch(reads.said, /short sale/, "another house's words are not");
  const v = priceHouse({ ...reads, bricked: SURE.bricked, homeType: SURE.homeType, sqft: SURE.sqft, yearBuilt: SURE.yearBuilt });
  assert.ok(v.killers.includes("wholesaler_paper"), v.reasons.join(" | "));
  assert.ok(!v.killers.includes("short_sale"));
  assert.equal(v.grade, "C");
  // The latest message alone (what the engine read before) had none of it.
  assert.equal(priceHouse({ ...readsFrom({ address: ADDRESS, message: "4417 Somerset Ln, Everett", listPrice: 525000 }), bricked: SURE.bricked,
    homeType: SURE.homeType, sqft: SURE.sqft, yearBuilt: SURE.yearBuilt }).grade, "A");
});

test("the engine knows what year it is, so a house built last year reads as a new build", () => {
  const reads = readsFrom({ address: ADDRESS, facts: { sqft: 1500, yearBuilt: 2025, homeType: "SINGLE_FAMILY" }, now: Date.parse("2026-11-09T18:00:00Z") });
  assert.equal(reads.currentYear, 2026);
  assert.ok(priceHouse({ ...reads, bricked: SURE.bricked }).killers.includes("new_build"));
});

test("the shadow reads their mentions and counters, and keeps the house's heaviest rehab from the last two weeks", async () => {
  const now = Date.parse("2026-11-09T18:00:00Z");
  const day = 86400000;
  let asked = null, written = null;
  const prev = { houseKey: houseKey(ADDRESS), history: [
    { at: new Date(now - 20 * day).toISOString(), rehab: 200000 },
    { at: new Date(now - 3 * day).toISOString(), rehab: 118500, rehabRead: 118500 },
  ] };
  const fake = {
    listContactEvents: async (loc, id, opts) => { asked = opts; return [
      { type: "offer_countered", at: new Date(now - day).toISOString(), address: ADDRESS, data: { amount: 340000 } }]; },
    getHousePricing: async () => ({ doc: prev }),
    upsertHousePricing: async (loc, key, doc) => { written = doc; },
  };
  const job = { contactId: "c1", message: "", warnings: [] };
  const doc = await shadowPrice({ store: fake, locationId: "L", saved: { pricingV2: { shadow: true } }, job, address: ADDRESS, b: null,
    facts: { sqft: 1500, yearBuilt: 1961, homeType: "SINGLE_FAMILY" }, comps: { arv: 640000, n: 4 }, listPrice: 525000, now });
  assert.ok(asked.types.includes("house_mentioned") && asked.types.includes("offer_countered"), JSON.stringify(asked));
  assert.equal(doc.reads.sellerNumber, 340000);
  assert.equal(doc.v2.rehab, 118500, "three days ago it read 118.5k; the 20-day-old 200k has aged out");
  assert.equal(doc.v2.rehabOwn, 82500, "this read alone");
  assert.equal(written.history.at(-1).rehabRead, 82500, "the next read compares against what each read itself said");
});

test("a failure in the shadow never reaches the run", async () => {
  const broken = { upsertHousePricing: async () => { throw new Error("db down"); }, getHousePricing: async () => null, listContactEvents: async () => [] };
  const job = { warnings: [], message: "" };
  const out = await shadowPrice({ store: broken, locationId: "L", saved: { pricingV2: { shadow: true } }, job, address: ADDRESS });
  assert.equal(out, null);
  assert.match(job.warnings[0], /shadow price: db down/);
});
