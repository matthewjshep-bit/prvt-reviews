// auto-underwrite-bricked-honest.test.mjs — the Bricked path prices the rehab
// honestly (2026-11-04 underwrite review).
//
// Read against 50 Bricked reads: 46 had no repair figure, because skeleton
// mode never told Bricked the listing's remarks; a $0 repair line passed as an
// estimate (19223 Vista Dr); a house worth 94% of its ARV as-is sent itself
// (Tapadera); the "0 of 3 comps renovated" label hid Bricked's own renovation
// scores; and a teardown in the agent's words priced at the size band.
// Nothing here sends: createOffer and onOfferCreated are stubs.
//
//   node --test auto-underwrite-bricked-honest.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-bricked-honest-test-"));
delete process.env.DATABASE_URL;
process.env.AUTO_UNDERWRITE_ENABLED = "true";

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs, brickedSendGate, brickedBasis, brickedPartial, withSizeRepairs, floorBrickedRepairs, tierRepairs, BRICKED_MIN_REPAIRS } = await import("./auto-underwrite.js");
const { normalizeBricked } = await import("./price-bricked.js");
const { gutRehab } = await import("./shared/rehab-catalog.js");
const { calculateOffers } = await import("./shared/offer-calc.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
await store.init();

const ADDRESS = "4417 Somerset Ln, Everett, WA 98203";
const REMARKS = "Original 1950s kitchen and bath, roof at the end of its life. Bring your contractor.";
const BRICKED = {
  id: "b1", arv: 640000, arvConfidence: 0.86, cmv: 455000, totalRepairCost: 85000, repairs: [{ repair: "Roof", cost: 85000 }],
  property: { address: { fullAddress: ADDRESS }, latitude: 47.95, longitude: -122.2, details: { bedrooms: 3, bathrooms: 2, squareFeet: 1500, yearBuilt: 1961, condition_rating: 3.6, renovationScore: { score: 0.31 } } },
  comps: [{ compType: "arv", selected: true, is_renovated: null, renovation_score: 0.86, details: { lastSaleAmount: 655000 } },
    { compType: "arv", selected: true, is_renovated: null, renovation_score: 0.42, details: { lastSaleAmount: 610000 } }],
  shareLink: "https://bricked.ai/share/b1",
};

function stubFetch({ bricked = BRICKED, homeType = "SINGLE_FAMILY", price = 525000, description = REMARKS } = {}) {
  _resetCompsCache();
  _resetFactsCache?.();
  const calls = { bricked: [], detail: 0, search: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (body) => ({ ok: true, status: 200, statusText: "", json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("api.bricked.ai")) { calls.bricked.push(u); return reply(bricked); }
    if (u.includes("geocoding.geo.census.gov")) {
      return reply({ result: { addressMatches: [{ coordinates: { x: -122.2, y: 47.95 }, matchedAddress: "4417 SOMERSET LN, EVERETT, WA, 98203" }] } });
    }
    if (u.includes("apify")) {
      if (String(opts.body || "").includes("searchUrls")) { calls.search++; return reply([]); }
      calls.detail++;
      return reply([{ address: { streetAddress: "4417 Somerset Ln", city: "Everett", state: "WA", zipcode: "98203" }, homeType,
        bedrooms: 3, bathrooms: 1.75, livingArea: 1480, yearBuilt: 1962, price, homeStatus: "FOR_SALE", description, listingPhotos: [] }]);
    }
    return reply({ features: [] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const client = { call: async () => ({}) };
const base = { aiApiKey: "sk-ant-x", apifyToken: "apify-x", brickedApiKey: "bk", brickedOnDrafts: true, brickedSendsConfident: true, brickedRepairsBySize: true, maoPctOfArv: 75, wholesaleFee: 30000 };

async function run({ saved = {}, contactId, mode = "skeleton", fetchOpts = {}, message = "needs a roof" }) {
  _resetJobs();
  const { calls, restore } = stubFetch(fetchOpts);
  const made = [];
  const createOffer = async ({ body, locationId }) => {
    const calc = calculateOffers(body.inputs, body.settings);
    const offer = await store.createOffer({ locationId, status: "new", contactId: body.contactId, address: body.inputs.address,
      cashAmount: body.inputs.priceOverride || calc.offers.cash.amount, calc, snapshot: body.snapshot });
    made.push({ offer, body });
    return { offer, warnings: [] };
  };
  try {
    const { job } = await startUnderwrite({ client, locationId: `LOC-${contactId}`, saved: { ...base, autoUnderwriteMode: mode, ...saved }, store,
      contactId, message, address: ADDRESS, deps: { createOffer, onOfferCreated: async () => {} } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.notEqual(job.status, "error", job.error || "");
    return { job, made, calls };
  } finally { restore(); }
}

test("a skeleton's Bricked read hears the listing remarks, not just the agent's text", async () => {
  const { calls } = await run({ contactId: "h1", saved: { brickedSendsConfident: false } });
  assert.equal(calls.bricked.length, 1);
  const work = new URL(calls.bricked[0]).searchParams.get("repairs") || "";
  assert.match(work, /What the listing agent said: needs a roof/);
  assert.match(work, /Listing remarks: Original 1950s kitchen/);
  assert.equal(calls.detail, 1, "one Zillow lookup, a few tenths of a cent, before Bricked is asked");
  assert.equal(calls.search, 0, "still no comps bought");
});

test("with Bricked off a skeleton still looks nothing up", async () => {
  const { calls } = await run({ contactId: "h2", saved: { brickedOnDrafts: false } });
  assert.equal(calls.detail + calls.search + calls.bricked.length, 0);
});

test("Bricked's zero repairs never prices a house as needing nothing", async () => {
  const zero = { ...BRICKED, totalRepairCost: 0, repairs: [{ repair: "Listing agent statement", cost: 0 }] };
  const { job, made } = await run({ contactId: "h3", fetchOpts: { bricked: zero } });
  assert.equal(job.status, "done", JSON.stringify(job.held));
  assert.equal(made[0].body.inputs.repairs, Math.max(tierRepairs(1500, "medium"), BRICKED_MIN_REPAIRS), "the size band stands in for a $0");
  const off = await run({ contactId: "h4", fetchOpts: { bricked: zero }, saved: { brickedRepairsBySize: false } });
  assert.equal(off.made.length, 0, "with no size band, a $0 is no estimate at all");
  assert.match(off.job.brickedHeld || "", /no repair estimate/);
  assert.equal(withSizeRepairs({ arv: 1, repairs: 0, subject: { sqft: 1500 } }, {}).b.repairs, null, "$0 reads as missing");
  assert.equal(brickedSendGate({ b: { arv: 640000, arvConfidence: 0.9, repairs: 0 } }), "Bricked gave no repair estimate");
});

test("the size band never prices a house under the 60k benchmark", () => {
  const small = withSizeRepairs({ arv: 400000, repairs: null, subject: { sqft: 700 } }, { brickedRepairsBySize: true });
  assert.equal(small.repairsSource, "size");
  assert.equal(small.b.repairs, Math.max(tierRepairs(700, "medium"), 60000));
  assert.ok(small.b.repairs >= 60000);
});

test("a teardown in the agent's words prices at $150 a foot, and stays Matt's to look at", async () => {
  const { job, made } = await run({ contactId: "h5", message: "Honestly it's a tear down, value is in the land" });
  assert.equal(made.length, 0, "every dead teardown was signed off a number nobody walked");
  assert.equal(job.status, "held");
  assert.match(job.brickedHeld, /gut job or teardown/);
  const draft = await store.getOffer(job.offerId);
  assert.equal(draft.autoUnderwrite.machineRepairs, gutRehab(1500));
  assert.equal(draft.autoUnderwrite.machineRepairsSource, "gut");
  const floored = floorBrickedRepairs({ b: { arv: 600000, repairs: 40000 }, repairsSource: "bricked" }, { sqft: 1000, remarks: "Down to the studs" });
  assert.equal(floored.b.repairs, gutRehab(1000));
  assert.equal(floored.repairsSource, "gut");
  const plain = floorBrickedRepairs({ b: { arv: 600000, repairs: 40000 }, repairsSource: "bricked" }, { sqft: 1000, remarks: "no foundation issues" });
  assert.equal(plain.b.repairs, 40000, "a denial isn't a gut");
});

test("Matt's calibrated rehab floor applies to a Bricked number too", () => {
  const saved = { underwriteCalibration: { rehabFloorPsf: [{ beforeYear: 1980, psf: 60 }], arvHaircutPct: 0 } };
  const r = floorBrickedRepairs({ b: { arv: 600000, repairs: 50000 }, repairsSource: "size" }, { saved, sqft: 1500, yearBuilt: 1961 });
  assert.equal(r.b.repairs, 90000);
  assert.equal(r.repairsSource, "calibrated");
});

test("a house worth nearly its ARV as-is doesn't send itself", async () => {
  const turnkey = { ...BRICKED, cmv: 600000 };
  const { job, made } = await run({ contactId: "h6", fetchOpts: { bricked: turnkey } });
  assert.equal(made.length, 0);
  assert.equal(job.status, "held");
  assert.match(job.brickedHeld, /turnkey/);
  assert.match(brickedSendGate({ b: { arv: 640000, asIs: 590000, arvConfidence: 0.9, repairs: 50000 } }), /as-is \$590,000 is 92% of its \$640,000 ARV/);
  assert.equal(brickedSendGate({ b: { arv: 640000, asIs: 455000, arvConfidence: 0.9, repairs: 50000 } }), "");
});

test("the basis counts comps Bricked scored renovated, and the draft keeps the house's own condition", async () => {
  const b = normalizeBricked(BRICKED);
  assert.equal(b.comps[0].renovated, true, "a 0.86 renovation score is a renovated comp");
  assert.equal(b.comps[1].renovated, false);
  assert.match(brickedBasis(b), /1 of 2 ARV comps renovated, 86% confidence/);
  assert.match(brickedBasis({ comps: [{ use: "arv", renovated: null, renovationScore: 0.9 }] }), /1 of 1 ARV comps renovated/, "a read saved before this still counts");
  const p = brickedPartial(b);
  assert.deepEqual(p.bricked.subject, { condition: 3.6, renovationScore: 0.31, sqft: 1500, yearBuilt: 1961 });
});

test("a held draft remembers what the machine would have priced the rehab at", async () => {
  const { job } = await run({ contactId: "h7", saved: { brickedSendsConfident: false } });
  const draft = await store.getOffer(job.offerId);
  assert.equal(draft.autoUnderwrite.machineRepairs, 85000);
  assert.equal(draft.autoUnderwrite.machineRepairsSource, "bricked");
});
