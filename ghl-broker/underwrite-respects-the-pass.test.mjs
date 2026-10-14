// underwrite-respects-the-pass.test.mjs — an underwrite never prices a house
// the thread passed on, or one our own number puts above its list price.
//
// 31 N Colony Surf Dr, 2026-10-13. Our first text asked whether the listing
// needed work; the agent said it did, and the GHL workflow started an
// underwrite on that text. The bot asked its one qualify question, the answer
// was cosmetic only, and the bot passed. The pass was decided at 12:07 and
// sent at 12:11, and the underwrite landed its offer at 12:08 in between. The
// next morning the machine floated a range and sent a written offer at
// $229,500 on the house we'd said wasn't for us.
//
// The number was off too: our own math came to $375,750 on a $255,000
// listing (147% of list), off a 3-comp gut check that included a $1M sale
// across US 101. The 90%-of-list cap quietly turned that into $229,500, and
// the "how we got our number" text told the agent the house was worth 619
// fixed up. A number over the list price means the comps or the scope are
// wrong, not that the house is a steal: it holds for a person.
//
//   node --test underwrite-respects-the-pass.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Test-only: the run has to reach the create step to show what it makes.
// Nothing here sends; createOffer and onOfferCreated are stubs.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-pass-test-"));
delete process.env.DATABASE_URL;
process.env.AUTO_UNDERWRITE_ENABLED = "true";

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs } = await import("./auto-underwrite.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetSiteCache } = await import("./site-context.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
const { calculateOffers } = await import("./shared/offer-calc.js");
const { classifyHolds } = await import("./shared/held-underwrites.js");
await store.init();
test.after(() => { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const ADDRESS = "4410 Alder Ln, Tacoma, WA 98408";
const LAT = 47.2010, LNG = -122.4400;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const DAY = 86400000;
const at = (north, east) => ({ lat: LAT + north * M_LAT, lng: LNG + east * M_LNG });

// Eight 3/2s inside half a mile, a spread of $/sqft so the price proxy has a
// renovated tier to find.
const NEAR = [
  { street: "4402 Alder Ln", n: 120, e: 60, sqft: 1480, ppsf: 330 },
  { street: "4420 Birch St", n: -150, e: 90, sqft: 1520, ppsf: 325 },
  { street: "4501 Cedar Ave", n: 200, e: -140, sqft: 1450, ppsf: 340 },
  { street: "4318 Dogwood Ct", n: -220, e: -180, sqft: 1550, ppsf: 335 },
  { street: "4609 Elm St", n: 300, e: 250, sqft: 1500, ppsf: 250 },
  { street: "4711 Fir St", n: -320, e: 260, sqft: 1490, ppsf: 240 },
  { street: "4120 Grove Pl", n: 380, e: -300, sqft: 1530, ppsf: 255 },
  { street: "4033 Hemlock Dr", n: -400, e: -320, sqft: 1470, ppsf: 245 },
];
const row = (c, i) => {
  const { lat, lng } = at(c.n, c.e);
  return {
    zpid: `z${i}`, address: `${c.street}, Tacoma, WA 98408`, livingArea: c.sqft, latLong: { latitude: lat, longitude: lng },
    hdpData: { homeInfo: { zpid: `z${i}`, price: c.sqft * c.ppsf, dateSold: Date.now() - (20 + i * 10) * DAY,
      livingArea: c.sqft, bedrooms: 3, bathrooms: 2, homeType: "SINGLE_FAMILY", latitude: lat, longitude: lng } },
  };
};
const subjectRow = (price) => ({
  address: { streetAddress: "4410 Alder Ln", city: "Tacoma", state: "WA", zipcode: "98408" },
  homeType: "SINGLE_FAMILY", bedrooms: 3, bathrooms: 2, livingArea: 1500, yearBuilt: 1962,
  listingPhotos: Array.from({ length: 12 }, (_, i) => ({ url: `https://photos.zillowstatic.com/fp/${i}abc-p_f.jpg` })),
  description: "Needs work throughout.", listingStatus: "FOR_SALE", price,
});
const detailRow = (c) => ({ address: { streetAddress: c.street, city: "Tacoma", state: "WA", zipcode: "98408" }, yearBuilt: 1960, livingArea: c.sqft, bedrooms: 3, bathrooms: 2, homeType: "SINGLE_FAMILY" });

function stubFetch(listPrice) {
  const original = globalThis.fetch;
  const calls = { search: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("geocoding.geo.census.gov")) {
      return ok({ result: { addressMatches: [{ coordinates: { x: LNG, y: LAT }, matchedAddress: "4410 ALDER LN, TACOMA, WA, 98408" }] } });
    }
    if (u.includes("overpass")) return ok({ elements: [] });
    if (u.includes("apify")) {
      const body = String(opts.body || "");
      if (body.includes("searchUrls")) { calls.search++; return ok(body.includes("for_sale") ? [] : NEAR.map(row)); }
      let asked = [];
      try { asked = JSON.parse(body).addresses || []; } catch { asked = []; }
      const known = NEAR.filter((c) => asked.some((a) => String(a).startsWith(c.street)));
      return ok([subjectRow(listPrice), ...known.map(detailRow)]);
    }
    return ok({ features: [] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const client = { call: async () => ({}) };
let n = 0;

// The bot's reply about the house, as the reply agent files it: the qualify
// stage rides on the draft from the moment it is decided, before it sends.
const qualifyDraft = (locationId, contactId, stage, { status = "scheduled", address = ADDRESS } = {}) => store.createReplyDraft({
  locationId, contactId, party: "agent", status, intent: stage === "ask" ? "deal_available" : "investor_open",
  reply: "test", qualify: { stage, address, why: "test" },
});

async function run({ listPrice = 330000, before = null, during = null, origin, fill = false } = {}) {
  _resetJobs(); _resetCompsCache(); _resetSiteCache(); _resetFactsCache();
  const { calls, restore } = stubFetch(listPrice);
  const locationId = `LOC-pass-${++n}`;
  const contactId = `agent-${n}`;
  const made = [];
  const floated = [];
  const saved = { aiApiKey: "sk-ant-x", apifyToken: "apify-x" };
  try {
    if (before) await before({ locationId, contactId });
    // The photo scan is the slow middle of a real run: where the bot's pass
    // lands while the underwrite is still going.
    const scanPhotos = async () => {
      if (during) await during({ locationId, contactId });
      return {
        summary: "Dated throughout.", items: [{ id: "paint-int", note: "scuffed walls" }],
        bathrooms: [{ tier: "mid", note: "original" }], bedrooms: [],
        areas: [{ area: "kitchen", grade: "dated", note: "" }], contents: "none", custom: [],
      };
    };
    const createOffer = async ({ body }) => {
      const calc = calculateOffers(body.inputs, body.settings);
      const cash = body.inputs.priceOverride || calc.offers.cash.amount;
      const offer = await store.createOffer({ locationId, status: "new", contactId: body.contactId, address: body.inputs.address,
        cashAmount: cash, calc, snapshot: body.snapshot });
      made.push(offer);
      return { offer, warnings: [] };
    };
    const { job } = await startUnderwrite({ client, locationId, saved, store, contactId, address: ADDRESS, fill,
      ...(origin ? { origin } : {}),
      deps: { scanPhotos, createOffer, onOfferCreated: async ({ offer }) => { floated.push(offer); } } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.notEqual(job.status, "error", job.error || "");
    return { job, made, floated, calls };
  } finally { restore(); }
}
const says = (job) => [...(job.held || []), ...(job.warnings || [])].join(" | ");

/* ---------- the thread passed ---------- */

test("the bot passing on the house while the underwrite runs means no offer and nothing floated", async () => {
  const { job, made, floated } = await run({ during: ({ locationId, contactId }) => qualifyDraft(locationId, contactId, "pass") });
  assert.equal(made.length, 0, "no offer was made");
  assert.equal(floated.length, 0, "nothing floated");
  assert.equal(job.status, "done", says(job));
  assert.ok(job.passedInThread, "the run says why it stopped");
});

test("a house the bot already passed on, or is still asking about, is not underwritten and no comps are bought", async () => {
  for (const stage of ["pass", "closed", "ask"]) {
    const { job, made, calls } = await run({ before: ({ locationId, contactId }) => qualifyDraft(locationId, contactId, stage) });
    assert.equal(made.length, 0, `${stage}: no offer`);
    assert.equal(calls.search, 0, `${stage}: no comp search was bought`);
    assert.ok(job.passedInThread, `${stage}: ${says(job)}`);
  }
});

test("a later reply that found the house a flip lets it run", async () => {
  const { job, made } = await run({ before: async ({ locationId, contactId }) => {
    await qualifyDraft(locationId, contactId, "pass", { status: "sent" });
    await new Promise((r) => setTimeout(r, 5));
    await qualifyDraft(locationId, contactId, "qualified", { status: "sent" });
  } });
  assert.equal(job.status, "done", says(job));
  assert.equal(made.length, 1);
  assert.ok(!job.passedInThread);
});

test("a pass you dismissed, or one about another house, doesn't stop it", async () => {
  const { made: a } = await run({ before: ({ locationId, contactId }) => qualifyDraft(locationId, contactId, "pass", { status: "dismissed" }) });
  assert.equal(a.length, 1, "a dismissed pass isn't the bot's word to the agent");
  const { made: b } = await run({ before: ({ locationId, contactId }) => qualifyDraft(locationId, contactId, "pass", { address: "9 Other St, Tacoma, WA 98408" }) });
  assert.equal(b.length, 1, "a pass on another house");
});

test("you pressing underwrite, or the offer form, prices it whatever the bot said", async () => {
  const { made: a } = await run({ origin: "operator", before: ({ locationId, contactId }) => qualifyDraft(locationId, contactId, "pass") });
  assert.equal(a.length, 1, "Underwrite from the app");
  const { job } = await run({ fill: true, before: ({ locationId, contactId }) => qualifyDraft(locationId, contactId, "pass") });
  assert.ok(!job.passedInThread, "a form fill");
});

/* ---------- our number above the list price ---------- */

test("our number coming out above the list price holds for you instead of being capped to 90% of list", async () => {
  const { job, made, floated } = await run({ listPrice: 150000 });
  assert.equal(made.length, 0, `no offer at a capped number (${says(job)})`);
  assert.equal(floated.length, 0);
  assert.equal(job.status, "held");
  const reason = job.held.find((h) => /above the .* list price/.test(h));
  assert.ok(reason, says(job));
  assert.match(reason, /\$150,000/);
  // A person's call, never a text asking the agent for their numbers.
  const c = classifyHolds(job.held);
  assert.equal(c.other, true);
  assert.equal(c.rescuable, false);
});

test("between 90% of list and the list price it still caps, as before", async () => {
  // Find a list price our number lands between 90% and 100% of.
  const probe = await run({ listPrice: 5000000 });
  const ours = probe.made[0].cashAmount;
  const { job, made } = await run({ listPrice: Math.round(ours / 0.95) });
  assert.equal(job.status, "done", says(job));
  assert.equal(made.length, 1);
  assert.ok(job.listCapped, "the 90% cap fired");
});
