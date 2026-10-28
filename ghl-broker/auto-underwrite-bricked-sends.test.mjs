// auto-underwrite-bricked-sends.test.mjs — a confident Bricked read becomes the offer by itself.
//
// Matt, 2026-10-28: "can we also automatically send them an offer too when
// they surface an address" → only when Bricked is at least 80% sure of its
// ARV, priced the repairs from a description, and the number is under the
// list cap; at 70% of ARV, not his 75%. Everything else stays the draft it
// was, with the reason on it. Nothing here sends: createOffer and
// onOfferCreated are stubs.
//
//   node --test auto-underwrite-bricked-sends.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-bricked-sends-test-"));
delete process.env.DATABASE_URL;
process.env.AUTO_UNDERWRITE_ENABLED = "true";

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs, brickedSendGate, brickedSendPct, brickedSendMinConfidence } = await import("./auto-underwrite.js");
const { isDraftOnly } = await import("./shared/offer-status.js");
const { calculateOffers } = await import("./shared/offer-calc.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
await store.init();

const ADDRESS = "4417 Somerset Ln, Everett, WA 98203";
const BRICKED = {
  id: "b1", arv: 640000, arvConfidence: 0.86, cmv: 455000, totalRepairCost: 85000, repairs: [{ repair: "Roof", cost: 85000 }],
  property: { address: { fullAddress: ADDRESS }, latitude: 47.95, longitude: -122.2, details: { bedrooms: 3, bathrooms: 2, squareFeet: 1500, yearBuilt: 1961 } },
  comps: [{ compType: "arv", selected: true, is_renovated: true, details: { lastSaleAmount: 655000 } }],
  shareLink: "https://bricked.ai/share/b1",
};

function stubFetch({ bricked = BRICKED, homeType = "SINGLE_FAMILY", price = 525000 } = {}) {
  _resetCompsCache();
  _resetFactsCache?.();
  const calls = { bricked: 0, detail: 0, search: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (body) => ({ ok: true, status: 200, statusText: "", json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("api.bricked.ai")) { calls.bricked++; return reply(bricked); }
    if (u.includes("geocoding.geo.census.gov")) {
      return reply({ result: { addressMatches: [{ coordinates: { x: -122.2, y: 47.95 }, matchedAddress: "4417 SOMERSET LN, EVERETT, WA, 98203" }] } });
    }
    if (u.includes("apify")) {
      if (String(opts.body || "").includes("searchUrls")) { calls.search++; return reply([]); }
      calls.detail++;
      return reply([{ address: { streetAddress: "4417 Somerset Ln", city: "Everett", state: "WA", zipcode: "98203" }, homeType,
        bedrooms: 3, bathrooms: 1.75, livingArea: 1480, yearBuilt: 1962, price, homeStatus: "FOR_SALE", listingPhotos: [] }]);
    }
    return reply({ features: [] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const client = { call: async () => ({}) };
const base = { aiApiKey: "sk-ant-x", apifyToken: "apify-x", brickedApiKey: "bk", brickedOnDrafts: true, brickedSendsConfident: true, maoPctOfArv: 75, wholesaleFee: 30000 };

async function run({ saved, contactId, mode = "skeleton", fetchOpts = {}, message = "needs a roof" }) {
  _resetJobs();
  const { calls, restore } = stubFetch(fetchOpts);
  const made = [], floated = [];
  const createOffer = async ({ body, locationId }) => {
    const calc = calculateOffers(body.inputs, body.settings);
    const offer = await store.createOffer({ locationId, status: "new", contactId: body.contactId, address: body.inputs.address,
      cashAmount: body.inputs.priceOverride || calc.offers.cash.amount, calc, snapshot: body.snapshot });
    made.push({ offer, body });
    return { offer, warnings: [] };
  };
  try {
    const { job } = await startUnderwrite({ client, locationId: `LOC-${contactId}`, saved: { ...base, autoUnderwriteMode: mode, ...saved }, store,
      contactId, message, address: ADDRESS, deps: { createOffer, onOfferCreated: async ({ offer }) => { floated.push(offer); } } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.notEqual(job.status, "error", job.error || "");
    return { job, made, floated, calls };
  } finally { restore(); }
}

test("the gate sends only a sure ARV with priced repairs under the list cap", () => {
  const b = { arv: 640000, arvConfidence: 0.86, repairs: 85000 };
  assert.equal(brickedSendGate({ b }), "", "Bricked's read alone clears");
  assert.match(brickedSendGate({ b: { ...b, arvConfidence: 0.79 } }), /79% sure of its ARV — it sends itself at 80%/);
  assert.match(brickedSendGate({ b: { ...b, repairs: null } }), /no repair estimate/);
  assert.match(brickedSendGate({ b, listPrice: 0, cash: 300000, cap: 0 }), /no list or asking price/);
  assert.match(brickedSendGate({ b, listPrice: 300000, cash: 333000, cap: 270000 }), /over \$270,000/);
  assert.equal(brickedSendGate({ b, listPrice: 525000, cash: 333000, cap: 472500 }), "");
  assert.equal(brickedSendPct({}), 70);
  assert.equal(brickedSendPct({ brickedSendPct: 95 }), 70, "out of range reads as the default");
  assert.equal(brickedSendMinConfidence({ brickedSendMinConfidence: 90 }), 90);
});

test("a skeleton with a confident Bricked read becomes an offer at 70% of ARV and goes to the send path", async () => {
  const { job, made, floated, calls } = await run({ contactId: "s1" });
  assert.equal(job.status, "done");
  assert.equal(calls.bricked, 1);
  assert.equal(calls.detail, 1, "one Zillow check: kind of house and list price");
  assert.equal(calls.search, 0, "no comp search");
  assert.equal(made.length, 1);
  const { offer, body } = made[0];
  assert.equal(body.settings.maoPctOfArv, 70, "machine-sent at 70%, not his 75%");
  const at70 = calculateOffers({ arv: 640000, repairs: 85000, askingPrice: 525000 }, { ...base, underwriteMode: "mao", maoPctOfArv: 70 }).offers.cash.amount;
  const at75 = calculateOffers({ arv: 640000, repairs: 85000, askingPrice: 525000 }, { ...base, underwriteMode: "mao", maoPctOfArv: 75 }).offers.cash.amount;
  assert.equal(offer.cashAmount, at70);
  assert.ok(at70 < at75);
  assert.equal(body.inputs.askingPrice, 525000, "the list price came from Zillow");
  assert.equal(floated.length, 1, "handed to onOfferCreated — the send guards decide from here");
  const saved = await store.getOffer(offer.id);
  assert.equal(saved.autoUnderwrite.basis, "bricked");
  assert.equal(saved.autoUnderwrite.sentPct, 70);
  assert.equal(isDraftOnly(saved), false, "a real offer, not a draft waiting on Matt");
  assert.equal(saved.autoUnderwrite.skeleton, undefined);
  assert.equal(saved.autoUnderwrite.brickedArv, 640000);
});

test("in draft mode a confident read sends too, with the listing's own facts", async () => {
  const { job, made, calls } = await run({ contactId: "d1", mode: "draft" });
  assert.equal(job.status, "done");
  assert.equal(calls.detail, 1, "the draft's usual listing lookup, nothing more");
  assert.equal(made.length, 1);
  assert.equal(made[0].offer.snapshot.subjectInfo.sqft, 1480);
});

test("a read Bricked isn't sure of stays a draft, says why, and pays for no Zillow check", async () => {
  const { job, made, floated, calls } = await run({ contactId: "s2", fetchOpts: { bricked: { ...BRICKED, arvConfidence: 0.7 } } });
  assert.equal(job.status, "held");
  assert.equal(made.length + floated.length, 0);
  assert.equal(calls.detail, 0);
  const draft = await store.getOffer(job.offerId);
  assert.ok(isDraftOnly(draft));
  assert.match(draft.autoUnderwrite.brickedHeld, /70% sure of its ARV/);
  assert.equal(draft.draft.inputs.arv, 640000, "still a draft priced by Bricked for Matt");
});

test("with no repair estimate it stays a draft", async () => {
  const { job, made } = await run({ contactId: "s3", message: "", fetchOpts: { bricked: { ...BRICKED, totalRepairCost: null, repairs: [] } } });
  assert.equal(job.status, "held");
  assert.equal(made.length, 0);
  assert.match((await store.getOffer(job.offerId)).autoUnderwrite.brickedHeld, /no repair estimate/);
});

test("a number over the list cap stays a draft rather than going out capped", async () => {
  const { job, made } = await run({ contactId: "s4", fetchOpts: { price: 300000 } });
  assert.equal(job.status, "held");
  assert.equal(made.length, 0);
  assert.match((await store.getOffer(job.offerId)).autoUnderwrite.brickedHeld, /over \$270,000, the share of the \$300,000 list/);
});

test("a mobile home on Zillow stays a draft, whatever Bricked says", async () => {
  const { job, made } = await run({ contactId: "s5", fetchOpts: { homeType: "MANUFACTURED" } });
  assert.equal(job.status, "held");
  assert.equal(made.length, 0);
  assert.ok((await store.getOffer(job.offerId)).autoUnderwrite.brickedHeld);
});

test("with the send switch off, a confident read is a draft as before", async () => {
  const { job, made, calls } = await run({ contactId: "s6", saved: { brickedSendsConfident: false } });
  assert.equal(job.status, "held");
  assert.equal(made.length, 0);
  assert.equal(calls.detail, 0);
  assert.equal((await store.getOffer(job.offerId)).autoUnderwrite.brickedHeld, undefined);
});
