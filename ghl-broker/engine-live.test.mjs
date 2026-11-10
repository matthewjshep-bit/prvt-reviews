// engine-live.test.mjs — grade A goes live (auto-underwrite v2 Phase 4, Matt 2026-11-04).
//
// With pricingV2.liveA on, a house the offer engine grades A goes to the agent at the engine's
// opening number, carrying its walk-away; that number counts as Matt's approval up to the
// walk-away (so their yes gets the NWMLS write-up ask), and nothing the counter band does goes
// past it. Anything below grade A stays a draft for Matt with the engine's reason.
//
//   node --test engine-live.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engine-live-test-"));
delete process.env.DATABASE_URL;
process.env.AUTO_UNDERWRITE_ENABLED = "true";

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs, engineSendGate } = await import("./auto-underwrite.js");
const { numberConfidence } = await import("./reply-agent.js");
const { numberApproved, asksForWriteUp } = await import("./shared/offer-status.js");
const { autoAcceptCeiling } = await import("./shared/auto-accept.js");
const { calculateOffers } = await import("./shared/offer-calc.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
await store.init();

const ADDRESS = "4417 Somerset Ln, Everett, WA 98203";
const bricked = (over = {}) => ({
  id: "b1", arv: 640000, arvConfidence: 0.9, cmv: 455000, totalRepairCost: 85000, repairs: [{ repair: "Roof", cost: 85000 }],
  property: { address: { fullAddress: ADDRESS }, details: { bedrooms: 3, bathrooms: 2, squareFeet: 1500, yearBuilt: 1961, condition_rating: 3.2 } },
  comps: [1, 2, 3].map((i) => ({ compType: "arv", selected: true, is_renovated: null, renovation_score: 0.85, details: { lastSaleAmount: 650000 + i } })),
  shareLink: "https://bricked.ai/share/b1", ...over,
});

function stubFetch({ b = bricked(), price = 400000 } = {}) {
  _resetCompsCache();
  _resetFactsCache?.();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (body) => ({ ok: true, status: 200, statusText: "", json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("api.bricked.ai")) return reply(b);
    if (u.includes("geocoding.geo.census.gov")) return reply({ result: { addressMatches: [{ coordinates: { x: -122.2, y: 47.95 }, matchedAddress: "4417 SOMERSET LN, EVERETT, WA, 98203" }] } });
    if (u.includes("apify")) {
      if (String(opts.body || "").includes("searchUrls")) return reply([]);
      return reply([{ address: { streetAddress: "4417 Somerset Ln", city: "Everett", state: "WA", zipcode: "98203" }, homeType: "SINGLE_FAMILY",
        bedrooms: 3, bathrooms: 1.75, livingArea: 1480, yearBuilt: 1962, lotSize: 7200, price, homeStatus: "FOR_SALE", description: "Original kitchen, roof is old", listingPhotos: [] }]);
    }
    return reply({ features: [] });
  };
  return () => { globalThis.fetch = original; };
}
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const base = { aiApiKey: "sk-ant-x", apifyToken: "apify-x", brickedApiKey: "bk", brickedOnDrafts: true, brickedSendsConfident: true, brickedRepairsBySize: true,
  maoPctOfArv: 75, wholesaleFee: 30000, autoUnderwriteMode: "skeleton", pricingV2: { liveA: true } };

async function run({ contactId, saved = {}, fetchOpts = {} }) {
  _resetJobs();
  const restore = stubFetch(fetchOpts);
  const made = [], floated = [];
  const createOffer = async ({ body, locationId }) => {
    const calc = calculateOffers(body.inputs, body.settings);
    const offer = await store.createOffer({ locationId, status: "new", contactId: body.contactId, address: body.inputs.address,
      cashAmount: body.inputs.priceOverride || calc.offers.cash.amount, calc, snapshot: body.snapshot });
    made.push({ offer, body });
    return { offer, warnings: [] };
  };
  try {
    const { job } = await startUnderwrite({ client: { call: async () => ({}) }, locationId: `LOC-${contactId}`, saved: { ...base, ...saved }, store, contactId,
      message: "needs a roof", address: ADDRESS, deps: { createOffer, onOfferCreated: async ({ offer }) => { floated.push(offer); } } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}`);
    assert.notEqual(job.status, "error", job.error || "");
    return { job, made, floated };
  } finally { restore(); }
}

test("with grade A live, a sure house goes to the agent at the engine's opening number, carrying its walk-away", async () => {
  const { job, made, floated } = await run({ contactId: "g1" });
  assert.equal(job.status, "done", job.brickedHeld || JSON.stringify(job.held));
  assert.equal(made.length, 1);
  const saved = await store.getOffer(made[0].offer.id);
  assert.equal(saved.pricing.live, true);
  assert.equal(saved.pricing.grade, "A");
  assert.equal(saved.cashAmount, saved.pricing.open, "it opens at the engine's number");
  assert.equal(saved.pricing.walkAway - saved.pricing.open, 15000, "with the $15k of room Matt chose");
  assert.equal(saved.autoUnderwrite.basis, "engine");
  assert.equal(floated.length, 1, "handed to the float-and-letter path");
  const rec = await store.getHousePricing(`LOC-g1`, saved.pricing && (await import("./shared/current-offer.js")).houseKey(ADDRESS));
  assert.equal(rec.doc.v2.grade, "A", "and its record says so");
});

test("anything below grade A stays a draft for Matt, with the engine's reason on it", async () => {
  const b = await run({ contactId: "g2", fetchOpts: { b: bricked({ arvConfidence: 0.8 }) } });
  assert.equal(b.made.length, 0);
  assert.match(b.job.brickedHeld, /graded it B \(not sure of: arv\)/);
  const nofit = await run({ contactId: "g3", fetchOpts: { price: 900000 } });
  assert.equal(nofit.made.length, 0);
  assert.match(nofit.job.brickedHeld, /^no fit: the offer engine's \$[\d,]+ walk-away is \d+% of the list price/);
  assert.equal(engineSendGate({ engine: null }), "the offer engine had nothing to price (no ARV from any read)");
  assert.match(engineSendGate({ engine: { v2: { grade: "A", walkAway: 300000, open: 285000, triage: "unknown" } } }), /no list price or seller's number/);
});

test("with grade A off, Bricked's own send is as it was", async () => {
  const { made } = await run({ contactId: "g4", saved: { pricingV2: { shadow: true } } });
  assert.equal(made.length, 1);
  assert.equal((await store.getOffer(made[0].offer.id)).pricing, undefined, "a Bricked send, not the engine's");
});

test("the engine's number is approved up to its walk-away, so their yes gets the write-up ask", () => {
  const offer = { cashAmount: 335500, autoUnderwrite: { basis: "engine" }, pricing: { live: true, grade: "A", walkAway: 350500 } };
  assert.equal(numberApproved(offer), true);
  assert.equal(numberApproved({ ...offer, cashAmount: 350500 }), true, "a move up to the walk-away is still approved");
  assert.equal(numberApproved({ ...offer, cashAmount: 351000 }), false, "never past it");
  assert.equal(numberApproved({ ...offer, pricing: { ...offer.pricing, grade: "B" } }), false);
  assert.equal(numberApproved({ ...offer, pricing: { ...offer.pricing, live: false } }), false, "a shadow answer approves nothing");
  const yes = { ...offer, status: "accepted", statusHistory: [{ status: "accepted", ts: "2026-11-10T18:00:00Z" }] };
  assert.equal(asksForWriteUp(yes), numberApproved(yes) && asksForWriteUp(yes), "the write-up ask follows the approval");
});

/* ---------- the seller's number, the list price, one house one offer (audit 2026-11-09) ---------- */

test("the engine's number over the list price, or far over their number, stays Matt's to price", () => {
  const v2 = { grade: "B", misses: ["arv"], killers: [], walkAway: 270000, open: 255000, triage: "workable", spread: 0.9 };
  assert.equal(engineSendGate({ engine: { v2: { ...v2, overList: true } } }), "the offer engine's number is over the list price: yours to price");
  assert.equal(engineSendGate({ engine: { v2: { ...v2, triage: "over_theirs", overTheirs: true } } }),
    "our walk-away is far over their number, likely an ARV error: yours to price");
});

test("a sent engine offer stops at the seller's own number and carries it", async () => {
  await store.appendContactEvents("LOC-g5", "g5", [{ type: "property_details", at: "2026-11-08T18:00:00Z", address: "4417 Somerset Ln", data: { sellerAsk: 340000 } }]);
  const { job, made } = await run({ contactId: "g5" });
  assert.equal(job.status, "done", job.brickedHeld || "");
  assert.equal(made.length, 1);
  const offer = await store.getOffer(made[0].offer.id);
  assert.equal(offer.pricing.sellerNumber, 340000, "stamped for numberApproved");
  assert.equal(offer.pricing.walkAway, 340000, "348k uncapped, down to their 340k");
  assert.ok(offer.cashAmount <= 340000);
  assert.equal(numberApproved({ ...offer, cashAmount: 345000 }), false, "a move past their number is nobody's approval");
});

test("a house listed under the engine's own walk-away is held, not capped and sent", async () => {
  // 348k uncapped against a 340k list: the cap would have sent 306k; the comps or the scope are off.
  const { job, made } = await run({ contactId: "g6", fetchOpts: { price: 340000 } });
  assert.equal(made.length, 0);
  assert.equal(job.brickedHeld, "the offer engine's number is over the list price: yours to price");
});

test("two underwrites started for one agent's house under two spellings make one offer", async () => {
  _resetJobs();
  const restore = stubFetch();
  const made = [];
  const createOffer = async ({ body, locationId }) => {
    const calc = calculateOffers(body.inputs, body.settings);
    const offer = await store.createOffer({ locationId, status: "new", contactId: body.contactId, address: body.inputs.address,
      cashAmount: body.inputs.priceOverride || calc.offers.cash.amount, calc, snapshot: body.snapshot });
    made.push(offer);
    return { offer, warnings: [] };
  };
  try {
    const go = (address, contactId = "g7") => startUnderwrite({ client: { call: async () => ({}) }, locationId: "LOC-g7", saved: base, store, contactId,
      message: "needs a roof", address, deps: { createOffer, onOfferCreated: async () => {} } });
    // The street line without its suffix is the same agent's same house (texts a few seconds apart).
    const a = await go(ADDRESS);
    const b = await go("4417 Somerset, Everett");
    assert.equal(b.deduped, true, "the second spelling waits on the first");
    assert.ok(await until(() => ["held", "done", "error"].includes(a.job.status)));
    assert.equal(made.length, 1);
    // Two towns for one house (oneAgentsHouse can't pair them), both resolving to the same parcel:
    // the second run stops once the map says it's the same house.
    const c = await go(ADDRESS, "g8");
    const d = await go("4417 Somerset Ln, Silver Firs, WA", "g8");
    assert.equal(d.deduped, undefined, "the start guard can't tell these two apart");
    assert.ok(await until(() => [c.job, d.job].every((j) => ["held", "done", "error"].includes(j.status))));
    assert.equal(made.filter((o) => o.contactId === "g8").length, 1, made.map((o) => o.address).join(" | "));
  } finally { restore(); }
});

test("nothing the counter band does goes past the engine's walk-away, and the grade sets how sure the bot sounds", () => {
  const offer = { address: ADDRESS, cashAmount: 335500, arv: 640000, repairs: 82500, askingPrice: 525000, pricing: { live: true, grade: "A", walkAway: 350500 } };
  const c = autoAcceptCeiling({ offer, settings: { maoPctOfArv: 75 } });
  assert.equal(c.ceiling, 350500);
  assert.equal(c.engineCapped, true);
  assert.match(c.basis, /walk-away/);
  assert.equal(numberConfidence({ offer: { ...offer, autoUnderwrite: { basis: "engine", passed: true } } }), "high");
  assert.equal(numberConfidence({ offer: { ...offer, autoUnderwrite: { basis: "engine", passed: true }, pricing: { ...offer.pricing, grade: "C" } } }), "low");
});
