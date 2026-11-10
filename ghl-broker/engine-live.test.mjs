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
const { startUnderwrite, _resetJobs, engineSendGate, gradeBPlan, gradeBLine } = await import("./auto-underwrite.js");
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

async function run({ contactId, saved = {}, fetchOpts = {}, message = "needs a roof" }) {
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
      message, address: ADDRESS, deps: { createOffer, onOfferCreated: async ({ offer }) => { floated.push(offer); } } });
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
  await store.appendContactEvents("LOC-g5", "g5", [{ type: "property_details", at: "2026-11-08T18:00:00Z", address: "4417 Somerset Ln", data: { sellerAsk: 320000 } }]);
  const { job, made } = await run({ contactId: "g5" });
  assert.equal(job.status, "done", job.brickedHeld || "");
  assert.equal(made.length, 1);
  const offer = await store.getOffer(made[0].offer.id);
  assert.equal(offer.pricing.sellerNumber, 320000, "stamped for numberApproved");
  assert.equal(offer.pricing.walkAway, 320000, "326.5k uncapped, down to their 320k");
  assert.ok(offer.cashAmount <= 320000);
  assert.equal(numberApproved({ ...offer, cashAmount: 325000 }), false, "a move past their number is nobody's approval");
});

test("a house listed under the engine's own walk-away is held, not capped and sent", async () => {
  // 326.5k uncapped against a 320k list: the cap would have sent 288k; the comps or the scope are off.
  const { job, made } = await run({ contactId: "g6", fetchOpts: { price: 320000 } });
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

/* ---------- grade B: every house the engine can price gets a number (Matt, 2026-11-10) ---------- */
//
// "Is there a way we can get a price to every agent through the app, to automate it entirely."
// Grade B opens 10% lower (pricingV2.gradeBOpenPct) and goes the way grade A goes, under every
// guard grade A has; it runs a week in the shadow first. The house here: Bricked 80% sure (an ARV
// miss, grade B), 1,480 sqft built 1962 at the $72 floor, listed at 400k. The engine opens at
// 311,500 and walks away at 326,500; grade B opens at 280,250.

const { walkawayOffer, evaluateWalkaway } = await import("./shared/walkaway.js");
const { raiseCeiling } = await import("./shared/offer-raise.js");
const { houseKey: keyOf } = await import("./shared/current-offer.js");
const UNSURE = { b: bricked({ arvConfidence: 0.8 }) };
const recordOf = async (contactId) => (await store.getHousePricing(`LOC-${contactId}`, keyOf(ADDRESS)))?.doc;
const eventsOf = (contactId, type) => store.listContactEvents(`LOC-${contactId}`, contactId, { types: [type], limit: 20 });

test("with grade B live, a grade-B house goes to the agent 10% under the engine's open, the way grade A goes", async () => {
  const { job, made, floated } = await run({ contactId: "gb1", saved: { pricingV2: { liveA: true, liveB: "live" } }, fetchOpts: UNSURE });
  assert.equal(job.status, "done", job.brickedHeld || JSON.stringify(job.held));
  assert.equal(made.length, 1);
  const rec = await recordOf("gb1");
  assert.equal(rec.v2.grade, "B");
  assert.deepEqual(rec.v2.misses, ["arv"]);
  assert.equal(rec.v2.open, 311500);
  const offer = await store.getOffer(made[0].offer.id);
  assert.equal(made[0].body.inputs.priceOverride, 280250, "311,500 less 10%, to the $250");
  assert.equal(offer.cashAmount, 280250);
  assert.equal(offer.pricing.live, true);
  assert.equal(offer.pricing.grade, "B");
  assert.equal(offer.pricing.open, 280250, "the number it went out at");
  assert.equal(offer.pricing.engineOpen, 311500, "and the engine's own open beside it");
  assert.equal(offer.pricing.walkAway, rec.v2.walkAway, "the walk-away is the engine's, never moved");
  assert.equal(offer.autoUnderwrite.basis, "engine");
  assert.equal(offer.autoUnderwrite.grade, "B");
  assert.deepEqual(offer.autoUnderwrite.gradeB, { open: 280250, engineOpen: 311500, pct: 10 });
  assert.equal(floated.length, 1, "handed to the same float-and-letter path, with its send guards");
  assert.equal(rec.v2.gradeB.mode, "live");
  assert.equal(rec.v2.gradeB.sent, true, "the house's record says it went as a B");
  assert.equal(rec.v2.gradeB.offerId, offer.id);
  assert.equal(rec.history.at(-1).bOpen, 280250);
  const [done] = await eventsOf("gb1", "underwrite_done");
  assert.equal(done.data.grade, "B");
  assert.equal(done.data.note, "Grade B: opened at $280,250, 10% under the engine's $311,500 (walk-away $326,500).");
});

test("the grade-B open is a setting: 20% opens 20% under the engine's", async () => {
  const { made } = await run({ contactId: "gb2", saved: { pricingV2: { liveA: true, liveB: "live", gradeBOpenPct: 20 } }, fetchOpts: UNSURE });
  assert.equal(made.length, 1);
  assert.equal((await store.getOffer(made[0].offer.id)).cashAmount, 249250, "311,500 × 0.8 = 249,200, to the $250");
});

test("a grade-B offer never comes up on a counter by itself, and a yes on it waits for Matt's approval", () => {
  const offer = { address: ADDRESS, status: "sent", cashAmount: 280250, arv: 640000, repairs: 106500, askingPrice: 400000,
    sends: [{ ts: "2026-11-10T18:00:00Z", results: { sms: { ok: true } } }],
    autoUnderwrite: { basis: "engine", grade: "B" }, pricing: { live: true, grade: "B", open: 280250, engineOpen: 311500, walkAway: 326500, moves: 0 } };
  assert.equal(walkawayOffer(offer), false, "the walk-away answers grade A's counters only");
  assert.equal(evaluateWalkaway({ offer, theirAmount: 300000, theirOwnWords: true }).passed, false, "their number: not ours to move");
  assert.equal(evaluateWalkaway({ offer, pushback: true }).passed, false, "'too low': no step up");
  assert.equal(numberApproved(offer), false, "the walk-away is no approval on grade B: their yes waits for you");
  assert.equal(numberApproved({ ...offer, pricing: { ...offer.pricing, grade: "A" } }), true, "as it is on grade A");
  assert.equal(raiseCeiling(offer), 280250, "a person's raise past what went out asks first");
  const band = autoAcceptCeiling({ offer, settings: { maoPctOfArv: 75 } });
  assert.ok(!band.computable || band.ceiling <= 326500, `the counter band never goes past the walk-away (${band.ceiling})`);
  assert.equal(numberConfidence({ offer }), "medium");
});

test("with grade B in the shadow, nothing extra is sent: the number it would have sent goes on the record and the timeline", async () => {
  const { job, made } = await run({ contactId: "gb3", saved: { pricingV2: { liveA: true, liveB: "shadow" } }, fetchOpts: UNSURE });
  assert.equal(made.length, 0, "nothing sent");
  assert.equal(job.status, "held");
  assert.match(job.brickedHeld, /graded it B \(not sure of: arv\)/, "held for Matt exactly as today");
  const rec = await recordOf("gb3");
  const { at, ...b } = rec.v2.gradeB || {};
  assert.deepEqual(b, { mode: "shadow", open: 280250, engineOpen: 311500, walkAway: 326500, pct: 10, wouldSend: true, sent: false, held: "" });
  assert.equal(rec.history.at(-1).bOpen, 280250, "kept per pricing, so a week of them can be read");
  const [held] = await eventsOf("gb3", "underwrite_held");
  assert.equal(held.data.note, "Engine (B): would send $280,250 (10% under its $311,500 open). In the shadow, so nothing was sent.");
  assert.deepEqual(held.data.gradeB, { mode: "shadow", open: 280250, wouldSend: true });
  assert.match(job.subjectLine, /grade B would send \$280,250/);
});

test("in the shadow, a grade-B house a guard would have held says so beside its number", async () => {
  // Listed at 900k: the 326.5k walk-away is a no fit, so live it would have been held.
  const { made } = await run({ contactId: "gb4", saved: { pricingV2: { liveA: true, liveB: "shadow" } }, fetchOpts: { ...UNSURE, price: 900000 } });
  assert.equal(made.length, 0);
  const rec = await recordOf("gb4");
  assert.equal(rec.v2.gradeB.wouldSend, false);
  assert.match(rec.v2.gradeB.held, /^no fit: the offer engine's \$326,500 walk-away is 36% of the list price/);
  const [held] = await eventsOf("gb4", "underwrite_held");
  assert.match(held.data.note, /^Engine \(B\): would open at \$280,250 \(10% under its \$311,500 open\), but it would have been held: no fit/);
});

test("with grade B live, a grade-B house any guard holds goes to Matt as today, with the lower number shown", async () => {
  // Their number is 280k: our 326.5k walk-away is 17% over it, a likely ARV error.
  await store.appendContactEvents("LOC-gb5", "gb5", [{ type: "property_details", at: "2026-11-08T18:00:00Z", address: "4417 Somerset Ln", data: { sellerAsk: 280000 } }]);
  const { job, made } = await run({ contactId: "gb5", saved: { pricingV2: { liveA: true, liveB: "live" } }, fetchOpts: UNSURE });
  assert.equal(made.length, 0);
  assert.equal(job.brickedHeld, "our walk-away is far over their number, likely an ARV error: yours to price", "the same hold grade A gets");
  const rec = await recordOf("gb5");
  assert.equal(rec.v2.gradeB.open, 252000, "the open stops at their 280k, then 10% under");
  assert.equal(rec.v2.gradeB.sent, false);
  const [held] = await eventsOf("gb5", "underwrite_held");
  assert.equal(held.data.note, "Engine (B): opens at $252,000 (10% under its $280,000 open), held for you: our walk-away is far over their number, likely an ARV error: yours to price.");
});

test("grade B goes live only beside grade A", async () => {
  const { job, made } = await run({ contactId: "gb6", saved: { brickedSendsConfident: false, pricingV2: { liveA: false, shadow: true, liveB: "live" } }, fetchOpts: UNSURE });
  assert.equal(made.length, 0);
  assert.equal(job.status, "held");
  assert.equal((await recordOf("gb6")).v2.gradeB.held, "grade-A numbers aren't live, so grade B waits too");
});

test("grade C, and grade B with the switch off, are exactly as they were", async () => {
  const c = await run({ contactId: "gb7", saved: { pricingV2: { liveA: true, liveB: "live" } }, fetchOpts: UNSURE, message: "needs a roof, and it's a short sale" });
  assert.equal(c.made.length, 0);
  assert.match(c.job.brickedHeld, /graded it C \(not sure of: arv\) — short_sale — yours to price/);
  assert.equal((await recordOf("gb7")).v2.gradeB, undefined, "no grade-B number on a C");
  assert.equal((await eventsOf("gb7", "underwrite_held"))[0].data.note, undefined);
  const off = await run({ contactId: "gb8", fetchOpts: UNSURE });
  assert.equal(off.made.length, 0);
  assert.match(off.job.brickedHeld, /graded it B \(not sure of: arv\)/);
  assert.equal((await recordOf("gb8")).v2.gradeB, undefined, "off: nothing new on the record");
  assert.equal((await eventsOf("gb8", "underwrite_held"))[0].data.note, undefined);
  assert.equal(gradeBPlan({ engine: { v2: { grade: "B", open: 300000 } }, saved: {} }), null);
  assert.equal(gradeBPlan({ engine: { v2: { grade: "A", open: 300000 } }, saved: { pricingV2: { liveB: "live", liveA: true } } }), null);
  assert.equal(gradeBLine(null), "");
});

test("the send gate lets grade B through only when it's live, and holds it on everything that holds grade A", () => {
  const v2 = { grade: "B", misses: ["arv"], killers: [], walkAway: 326500, open: 311500, triage: "long_shot", spread: 0.816 };
  assert.match(engineSendGate({ engine: { v2 } }), /graded it B/);
  assert.match(engineSendGate({ engine: { v2 }, liveB: "shadow" }), /graded it B/);
  assert.equal(engineSendGate({ engine: { v2 }, liveB: "live" }), "");
  assert.match(engineSendGate({ engine: { v2: { ...v2, overList: true } }, liveB: "live" }), /over the list price/);
  assert.match(engineSendGate({ engine: { v2: { ...v2, triage: "over_theirs" } }, liveB: "live" }), /far over their number/);
  assert.match(engineSendGate({ engine: { v2: { ...v2, triage: "turnkey" } }, liveB: "live" }), /turnkey/);
  assert.match(engineSendGate({ engine: { v2: { ...v2, triage: "unknown" } }, liveB: "live" }), /no list price or seller's number/);
  assert.match(engineSendGate({ engine: { v2: { ...v2, triage: "no_fit", spread: 0.6 } }, liveB: "live" }), /^no fit/);
  assert.match(engineSendGate({ engine: { v2: { ...v2, grade: "C", misses: ["arv", "rehab"] } }, liveB: "live" }), /graded it C/);
});
