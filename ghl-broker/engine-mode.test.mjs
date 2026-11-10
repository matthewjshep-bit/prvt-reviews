// engine-mode.test.mjs — our own underwrite on every named house, Bricked only when it's unsure (2026-11-04).
//
// Matt: Bricked has ~300 credits left and is expensive — "can we use our auto underwrite instead,
// or dial it in so it's a lot more accurate?" Engine mode runs our own comps and photo scope on
// every house the conversation names, prices it with the offer engine, and asks Bricked only when
// our comps can't carry the ARV, at most pricingV2.brickedPerDay a day.
//
//   node --test engine-mode.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-engine-mode-test-"));
delete process.env.DATABASE_URL;
process.env.AUTO_UNDERWRITE_ENABLED = "true";

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs, takeBrickedCredit } = await import("./auto-underwrite.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetSiteCache } = await import("./site-context.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
const { calculateOffers } = await import("./shared/offer-calc.js");
const { ENGINE_HOLD, isDraftOnly } = await import("./shared/offer-status.js");
const { houseKey } = await import("./shared/current-offer.js");
await store.init();
test.after(() => { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const ADDRESS = "2210 Quarry Ave N, Shoreline, WA 98133";
const LAT = 47.7409, LNG = -122.3426;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const DAY = 86400000;
const at = (north, east) => ({ lat: LAT + north * M_LAT, lng: LNG + east * M_LNG });
const REMODELED = "Fully remodeled with a new kitchen and quartz counters. Move-in ready.";
const FIXER = "Investor special, bring your contractor. Sold as-is.";
// Eight 3/2s within half a mile. Four say remodeled in their own listings; the priciest one is a
// fixer its listing calls a lot buy — the $/sqft guess would have put it in the ARV.
const NEAR = [
  { street: "2202 Quarry Ave N", n: 120, e: 60, sqft: 1480, ppsf: 330, desc: REMODELED },
  { street: "2220 Basalt St", n: -150, e: 90, sqft: 1520, ppsf: 325, desc: REMODELED },
  { street: "2301 Cobble Ave N", n: 200, e: -140, sqft: 1450, ppsf: 335, desc: REMODELED },
  { street: "2118 Dolomite Ct", n: -220, e: -180, sqft: 1550, ppsf: 328, desc: REMODELED },
  { street: "2409 Ember St", n: 300, e: 250, sqft: 1500, ppsf: 420, desc: FIXER },
  { street: "2511 Flint St", n: -320, e: 260, sqft: 1490, ppsf: 240, desc: "" },
  { street: "2020 Granite Pl", n: 380, e: -300, sqft: 1530, ppsf: 255, desc: "" },
  { street: "1933 Hornfels Dr", n: -400, e: -320, sqft: 1470, ppsf: 245, desc: "" },
];
const row = (c, i) => {
  const { lat, lng } = at(c.n, c.e);
  return { zpid: `z${i}`, address: `${c.street}, Shoreline, WA 98133`, livingArea: c.sqft, latLong: { latitude: lat, longitude: lng },
    hdpData: { homeInfo: { zpid: `z${i}`, price: c.sqft * c.ppsf, dateSold: Date.now() - (20 + i * 10) * DAY,
      livingArea: c.sqft, bedrooms: 3, bathrooms: 2, homeType: "SINGLE_FAMILY", latitude: lat, longitude: lng } } };
};
const subjectRow = ({ price, status = "FOR_SALE", sqft = 1500 }) => ({
  address: { streetAddress: "2210 Quarry Ave N", city: "Shoreline", state: "WA", zipcode: "98133" },
  homeType: "SINGLE_FAMILY", bedrooms: 3, bathrooms: 2, ...(sqft ? { livingArea: sqft } : {}), yearBuilt: 1955, lotSize: 7200, price, homeStatus: status,
  listingPhotos: Array.from({ length: 12 }, (_, i) => ({ url: `https://photos.zillowstatic.com/fp/${i}abc-p_f.jpg` })),
  description: "Original kitchen, roof near the end of its life.",
});
const detailRow = (c) => ({ address: { streetAddress: c.street, city: "Shoreline", state: "WA", zipcode: "98133" }, yearBuilt: 1955,
  livingArea: c.sqft, bedrooms: 3, bathrooms: 2, homeType: "SINGLE_FAMILY", description: c.desc });
const BRICKED = { id: "b1", arv: 495000, arvConfidence: 0.92, cmv: 330000, totalRepairCost: null, repairs: [],
  property: { address: { fullAddress: ADDRESS }, details: { bedrooms: 3, bathrooms: 2, squareFeet: 1500, yearBuilt: 1955, condition_rating: 3.4 } },
  comps: [1, 2, 3].map((i) => ({ compType: "arv", selected: true, is_renovated: null, renovation_score: 0.85, details: { lastSaleAmount: 490000 + i } })) };

function stubFetch({ near = NEAR, price = 420000, status, sqft } = {}) {
  const calls = { bricked: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("api.bricked.ai")) { calls.bricked++; return ok(BRICKED); }
    if (u.includes("geocoding.geo.census.gov")) return ok({ result: { addressMatches: [{ coordinates: { x: LNG, y: LAT }, matchedAddress: "2210 QUARRY AVE N, SHORELINE, WA, 98133" }] } });
    if (u.includes("overpass")) return ok({ elements: [] });
    if (u.includes("apify")) {
      const body = String(opts.body || "");
      if (body.includes("searchUrls")) return ok(body.includes("for_sale") ? [] : near.map(row));
      let asked = [];
      try { asked = JSON.parse(body).addresses || []; } catch { asked = []; }
      const known = near.filter((c) => asked.some((a) => String(a).startsWith(c.street)));
      const subj = asked.some((a) => String(a).startsWith("2210 Quarry")) ? [subjectRow({ price, status, sqft })] : [];
      return ok([...subj, ...known.map(detailRow)]);
    }
    return ok({ features: [] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const scanPhotos = async () => ({ summary: "Dated throughout.", items: [{ id: "paint-int", note: "scuffed walls" }],
  bathrooms: [{ tier: "mid", note: "original" }], bedrooms: [], areas: [{ area: "kitchen", grade: "dated", note: "" }], contents: "none", custom: [] });
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };

let n = 0;
async function run({ saved = {}, near, price, status, sqft, scan = scanPhotos, locationId = `LOC-engine-${++n}`, contactId = `agent-${n}` } = {}) {
  _resetJobs(); _resetCompsCache(); _resetSiteCache(); _resetFactsCache();
  const { calls, restore } = stubFetch({ near, price, status, sqft });
  const made = [];
  try {
    const createOffer = async ({ body }) => {
      const calc = calculateOffers(body.inputs, body.settings);
      const offer = await store.createOffer({ locationId, status: "new", contactId: body.contactId, address: body.inputs.address,
        cashAmount: body.inputs.priceOverride || calc.offers.cash.amount, calc, snapshot: body.snapshot });
      made.push(offer);
      return { offer, warnings: [] };
    };
    const { job } = await startUnderwrite({ client: { call: async () => ({}) }, locationId, store, contactId, address: ADDRESS, message: "needs a roof",
      saved: { aiApiKey: "sk-ant-x", apifyToken: "apify-x", brickedApiKey: "bk", brickedOnDrafts: true, autoUnderwriteMode: "engine", ...saved },
      deps: { scanPhotos: scan, createOffer, onOfferCreated: async () => {} } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.notEqual(job.status, "error", job.error || "");
    return { job, made, calls, locationId };
  } finally { restore(); }
}

test("engine mode prices on our own comps and photo scope, gives Matt a draft with them on it, and asks Bricked nothing", async () => {
  const { job, made, calls, locationId } = await run();
  assert.equal(made.length, 0, "the old machine makes no offer of its own, and grade A isn't live");
  assert.equal(calls.bricked, 0, "our comps carried the ARV: no Bricked credit spent");
  assert.equal(job.status, "held");
  const draft = await store.getOffer(job.offerId);
  assert.equal(draft.autoUnderwrite.held[0], ENGINE_HOLD);
  assert.equal(isDraftOnly(draft), true, "a Price it row for Matt");
  assert.match(draft.autoUnderwrite.subjectLine, /our comps ARV \$[\d,]+ · rehab \$[\d,]+ from 12 photos/);
  const rec = await store.getHousePricing(locationId, houseKey(ADDRESS));
  assert.ok(rec, "the engine's answer is on the house's record");
  assert.equal(rec.doc.reads.comps.n, 4, "the four comps whose listings say remodeled");
  assert.ok(rec.doc.v2.arv < 420 * 1500, "the fixer at $420/sqft never set the ARV");
  assert.equal(rec.doc.reads.bricked, null);
});

test("when our comps can't carry it, Bricked is asked, at most the day's allowance", async () => {
  const thin = NEAR.slice(5); // three plain sales, none says remodeled: a gut check at best
  const first = await run({ near: thin, saved: { pricingV2: { brickedPerDay: 1 } }, locationId: "LOC-engine-thin", contactId: "t1" });
  assert.equal(first.calls.bricked, 1, "unsure: one Bricked call");
  const rec = await store.getHousePricing("LOC-engine-thin", houseKey(ADDRESS));
  assert.equal(rec.doc.reads.bricked.arv, 495000);
  assert.ok(first.job.warnings.some((w) => /Bricked\.ai asked: our own comps couldn't carry the ARV/.test(w)));
  const second = await run({ near: thin, saved: { pricingV2: { brickedPerDay: 1 } }, locationId: "LOC-engine-thin", contactId: "t2" });
  assert.equal(second.calls.bricked, 0, "the day's one is spent");
  assert.equal(await takeBrickedCredit({ store, locationId: "LOC-x", saved: { brickedOnDrafts: true, brickedApiKey: "bk", pricingV2: { brickedPerDay: 0 } } }), false, "0 is never");
  assert.equal(await takeBrickedCredit({ store, locationId: "LOC-x", saved: { brickedOnDrafts: false, brickedApiKey: "bk" } }), false, "Bricked switched off is off");
});

test("with grade A live, engine mode sends the engine's number on our own read", async () => {
  const { job, made, calls } = await run({ saved: { pricingV2: { liveA: true } }, price: 270000 });
  assert.equal(job.status, "done", job.brickedHeld || "");
  assert.equal(calls.bricked, 0);
  assert.equal(made.length, 1);
  const offer = await store.getOffer(made[0].id);
  assert.equal(offer.pricing.grade, "A");
  assert.equal(offer.cashAmount, offer.pricing.open);
  assert.equal(offer.autoUnderwrite.basis, "engine");
});

test("with grade A live, a house listed far over our walk-away is held as no fit, not sent", async () => {
  const { job, made } = await run({ saved: { pricingV2: { liveA: true } }, price: 420000 });
  assert.equal(job.status, "held");
  assert.equal(made.length, 0);
  assert.match(job.brickedHeld || "", /no fit: the offer engine's \$[\d,]+ walk-away is \d+% of the list price/);
});

test("with grade A live, a house the photo scan flags for its structure stays Matt's, however sure the engine is", async () => {
  const cracked = async () => ({ ...(await scanPhotos()), areas: [{ area: "foundation_structure", grade: "poor", note: "settling crack" }] });
  const { job, made } = await run({ saved: { pricingV2: { liveA: true } }, price: 270000, scan: cracked });
  assert.equal(made.length, 0, "the same house sends when the scan is clean (above)");
  assert.equal(job.status, "held");
  assert.match(job.brickedHeld || "", /the underwrite's own checks held it: the photo scan flagged a possible foundation or structural problem/);
});

// The 2026-11-04 backtest: Zillow showed a Des Moines rental at "$2,900" (the month's rent). The
// engine capped its walk-away at 90% of that "list price" and would have offered $2,500.
test("a house Zillow shows for rent at $2,900 a month is never offered $2,500", async () => {
  const { job, made } = await run({ saved: { pricingV2: { liveA: true } }, price: 2900, status: "FOR_RENT" });
  assert.equal(made.length, 0, "no offer measured against a month's rent");
  assert.doesNotMatch(job.brickedHeld || "", /\$2,[0-9]{3} walk-away/);
  assert.match(job.brickedHeld || "", /no list price or seller's number/);
});

/* ---------- what Matt sees, and what the engine can't know (audit 2026-11-09) ---------- */

// The Price-it draft used to open on the bare photo scope (about 0.88x Matt's rehab) with nothing
// of the engine's on it, so Matt priced from a lighter number than the engine had.
test("an engine draft carries the engine's rehab and walk-away for Matt", async () => {
  const { job, locationId } = await run();
  const draft = await store.getOffer(job.offerId);
  const e = draft.draft.engine;
  assert.ok(e, "the engine's answer is on the draft");
  for (const k of ["grade", "arv", "rehab", "rehabWhy", "open", "walkAway", "triage", "reasons"]) assert.ok(k in e, k);
  const scoped = Number(String(draft.autoUnderwrite.subjectLine.match(/rehab \$([\d,]+) from 12 photos/)?.[1] || "0").replace(/,/g, ""));
  assert.ok(scoped > 0 && scoped < e.rehab, `the photos read ${scoped}, the engine ${e.rehab} (the 1955 house's age floor)`);
  const row = (draft.draft.rehab?.allowance || []).find((r) => r.key === "age_floor");
  assert.ok(row, "an allowance row carries the difference");
  assert.ok(Math.abs(draft.draft.inputs.repairs - e.rehab) <= 1000, `the draft opens on ${draft.draft.inputs.repairs}, the engine said ${e.rehab}`);
  assert.match(draft.autoUnderwrite.subjectLine, /engine open \$[\d,]+ \/ walk-away \$[\d,]+/);
  // How far the comps reached is on the house's record.
  const rec = await store.getHousePricing(locationId, houseKey(ADDRESS));
  assert.deepEqual({ listing: rec.doc.reads.comps.listing, radius: rec.doc.reads.comps.radius, acrossInArv: rec.doc.reads.comps.acrossInArv,
    eraGivesWay: rec.doc.reads.comps.eraGivesWay, gutCheck: rec.doc.reads.comps.gutCheck }, { listing: 4, radius: 0.5, acrossInArv: 0, eraGivesWay: false, gutCheck: false });
});

test("a size borrowed from the comps keeps the house a draft", async () => {
  // Zillow has the beds, baths and year but no size: the run takes the comps' middle size.
  const { job, made } = await run({ saved: { pricingV2: { liveA: true } }, price: 270000, sqft: 0 });
  assert.equal(made.length, 0, "the same house with its own size sends (above)");
  assert.equal(job.status, "held");
  assert.match(job.brickedHeld || "", /the house's own size isn't on record: [\d,]+ sqft was borrowed from the comps/);
});

/* ---------- one house, one offer, in the full machine too (audit 2026-11-09) ---------- */

// Two runs of one house a few seconds apart both passed the offer checks at the top of the run
// and both made an offer. The check runs again right before the offer is made.
test("a full run whose house got an offer from another run while it worked makes nothing", async () => {
  const locationId = "LOC-engine-sibling", contactId = "sib-1";
  const scan = async (...args) => {
    // Another run of the same agent's house, under a shorter spelling, finishes while this one scans.
    await store.createOffer({ locationId, status: "new", contactId, address: "2210 Quarry Ave N, Shoreline, WA", cashAmount: 301000 });
    return scanPhotos(...args);
  };
  const { job, made } = await run({ saved: { autoUnderwriteMode: "full" }, price: 520000, scan, locationId, contactId });
  assert.equal(made.length, 0, "no second offer");
  assert.equal(job.status, "done");
  assert.ok(job.duplicateOf, "pointed at the other run's offer");
  // Without the other run, the same full run makes its offer.
  const alone = await run({ saved: { autoUnderwriteMode: "full" }, price: 520000, locationId: "LOC-engine-alone", contactId: "sib-2" });
  assert.equal(alone.made.length, 1);
});

/* ---------- grade B (Matt, 2026-11-10) ---------- */

// Three plain sales and no Bricked today: our comps can't vouch for the ARV (a gut check), the
// photo scope is evidence, so the engine grades it B. Opens at 116,750; grade B at 105,000.
const B_HOUSE = { near: NEAR.slice(5), price: 150000 };

test("with grade B in the shadow, the Price-it draft shows the number it would have sent", async () => {
  const { job, made, locationId } = await run({ ...B_HOUSE, saved: { pricingV2: { brickedPerDay: 0, liveA: true, liveB: "shadow" } } });
  assert.equal(made.length, 0, "nothing extra is sent");
  const draft = await store.getOffer(job.offerId);
  assert.equal(draft.draft.engine.grade, "B");
  assert.equal(draft.draft.engine.open, 116750);
  assert.deepEqual({ mode: draft.draft.engine.gradeB.mode, open: draft.draft.engine.gradeB.open, wouldSend: draft.draft.engine.gradeB.wouldSend },
    { mode: "shadow", open: 105000, wouldSend: true });
  assert.match(draft.autoUnderwrite.subjectLine, /engine open \$116,750 \/ walk-away \$131,750 · grade B would send \$105,000$/);
  const rec = await store.getHousePricing(locationId, houseKey(ADDRESS));
  assert.equal(rec.doc.v2.gradeB.open, 105000);
});

test("with grade B live, engine mode sends a grade-B house at the lower open", async () => {
  const { job, made } = await run({ ...B_HOUSE, saved: { pricingV2: { brickedPerDay: 0, liveA: true, liveB: "live" } } });
  assert.equal(job.status, "done", job.brickedHeld || "");
  assert.equal(made.length, 1);
  const offer = await store.getOffer(made[0].id);
  assert.equal(offer.cashAmount, 105000);
  assert.equal(offer.pricing.grade, "B");
  assert.equal(offer.pricing.engineOpen, 116750);
});

test("with grade B live, a grade-B house held by the seller's number stays Matt's, with the lower number on the draft", async () => {
  // Their number is 100k: our 131,750 walk-away is 32% over it, a likely ARV error, held as grade A would be.
  await store.appendContactEvents("LOC-engine-b-held", "b-held", [{ type: "property_details", at: "2026-11-08T18:00:00Z", address: "2210 Quarry Ave N", data: { sellerAsk: 100000 } }]);
  const { job, made } = await run({ ...B_HOUSE, locationId: "LOC-engine-b-held", contactId: "b-held", saved: { pricingV2: { brickedPerDay: 0, liveA: true, liveB: "live" } } });
  assert.equal(made.length, 0);
  assert.equal(job.brickedHeld, "our walk-away is far over their number, likely an ARV error: yours to price");
  const draft = await store.getOffer(job.offerId);
  assert.deepEqual({ mode: draft.draft.engine.gradeB.mode, open: draft.draft.engine.gradeB.open, sent: draft.draft.engine.gradeB.sent },
    { mode: "live", open: 90000, sent: false }, "their 100k caps the open, then 10% under");
  assert.equal(draft.draft.engine.gradeB.held, job.brickedHeld);
  assert.match(draft.autoUnderwrite.subjectLine, /grade B opens at \$90,000$/);
});
