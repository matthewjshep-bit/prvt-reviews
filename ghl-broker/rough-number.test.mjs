// rough-number.test.mjs — a held underwrite floats a rough range instead.
//
// 2026-10-08, Matt: the bot tells an agent "I'll get you a number", the run
// holds on something only we are missing — the square footage, a thin photo
// set, thin comps — and the agent hears nothing until the nightly sweep
// retires the house. A held run now prices a ROUGH first pass off what it has
// (the comps' size, a condition-tier repair budget, the thin ARV), floats it
// as a range that says it's rough, asks for their read, and their numbers
// re-run it. What only a person can settle — no address, a guessed address,
// no ARV at all — still holds.
//
//   node --test rough-number.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Test-only: the run has to reach the create step to show what it makes.
// Nothing here sends; createOffer and onOfferCreated are stubs.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-rough-test-"));
delete process.env.DATABASE_URL;
process.env.AUTO_UNDERWRITE_ENABLED = "true";

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs, roughNumber } = await import("./auto-underwrite.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetSiteCache } = await import("./site-context.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
const { calculateOffers } = await import("./shared/offer-calc.js");
const { paperWorthy, paperAfterSilenceDue, sendsItselfOnClear } = await import("./shared/paper-follows.js");
const { machineRaise } = await import("./shared/current-offer.js");
const { resolvePromise } = await import("./shared/promise-resolver.js");
const { chooseProactiveKind, OUTBOUND_KINDS, outboundDescriptor, conversationConfig, rerunsRoughOffer } = await import("./reply-agent.js");
const { starterConfig } = await import("./shared/conversation-ai.js");
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
const subjectRow = ({ sqft, photos }) => ({
  address: { streetAddress: "4410 Alder Ln", city: "Tacoma", state: "WA", zipcode: "98408" },
  homeType: "SINGLE_FAMILY", bedrooms: 3, bathrooms: 2, ...(sqft ? { livingArea: sqft } : {}), yearBuilt: 1962,
  listingPhotos: Array.from({ length: photos }, (_, i) => ({ url: `https://photos.zillowstatic.com/fp/${i}abc-p_f.jpg` })),
  description: "Needs work throughout.", listingStatus: "FOR_SALE", price: 330000,
});
const detailRow = (c) => ({ address: { streetAddress: c.street, city: "Tacoma", state: "WA", zipcode: "98408" }, yearBuilt: 1960, livingArea: c.sqft, bedrooms: 3, bathrooms: 2, homeType: "SINGLE_FAMILY" });

function stubFetch(subject) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("geocoding.geo.census.gov")) {
      return ok({ result: { addressMatches: [{ coordinates: { x: LNG, y: LAT }, matchedAddress: "4410 ALDER LN, TACOMA, WA, 98408" }] } });
    }
    if (u.includes("overpass")) return ok({ elements: [] });
    if (u.includes("apify")) {
      const body = String(opts.body || "");
      if (body.includes("searchUrls")) return ok(body.includes("for_sale") ? [] : NEAR.map(row));
      let asked = [];
      try { asked = JSON.parse(body).addresses || []; } catch { asked = []; }
      const known = NEAR.filter((c) => asked.some((a) => String(a).startsWith(c.street)));
      return ok([subjectRow(subject), ...known.map(detailRow)]);
    }
    return ok({ features: [] });
  };
  return () => { globalThis.fetch = original; };
}

const scanPhotos = async () => ({
  summary: "Dated throughout.", items: [{ id: "paint-int", note: "scuffed walls" }],
  bathrooms: [{ tier: "mid", note: "original" }], bedrooms: [],
  areas: [{ area: "kitchen", grade: "dated", note: "" }], contents: "none", custom: [],
});
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };
const client = { call: async () => ({}) };

let n = 0;
async function run({ sqft = 1500, photos = 12, saved: extra = {} } = {}) {
  _resetJobs(); _resetCompsCache(); _resetSiteCache(); _resetFactsCache();
  const restore = stubFetch({ sqft, photos });
  const locationId = `LOC-rough-${++n}`;
  const made = [];
  const floated = [];
  const saved = { aiApiKey: "sk-ant-x", apifyToken: "apify-x", ...extra };
  try {
    const createOffer = async ({ body }) => {
      const calc = calculateOffers(body.inputs, body.settings);
      const cash = body.inputs.priceOverride || calc.offers.cash.amount;
      const offer = await store.createOffer({ locationId, status: "new", contactId: body.contactId, address: body.inputs.address,
        cashAmount: cash, calc, snapshot: body.snapshot });
      made.push(offer);
      return { offer, warnings: [] };
    };
    const { job } = await startUnderwrite({ client, locationId, saved, store, contactId: `agent-${n}`, address: ADDRESS,
      deps: { scanPhotos, createOffer, onOfferCreated: async ({ offer, job: j }) => { floated.push({ offer, job: j }); } } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.notEqual(job.status, "error", job.error || "");
    return { job, made, floated };
  } finally { restore(); }
}
const says = (job) => [...(job.held || []), ...(job.warnings || [])].join(" | ");

/* ---------- the run ---------- */

test("a promised number on a house with no square footage still goes out as a rough range", async () => {
  const { job, made, floated } = await run({ sqft: null });
  assert.equal(job.status, "done", says(job));
  assert.equal(made.length, 1);
  const o = made[0];
  assert.ok(o.cashAmount > 0, "it has a number");
  assert.equal(o.autoUnderwrite.basis, "rough");
  assert.equal(o.autoUnderwrite.passed, false);
  assert.equal(o.autoUnderwrite.numberConfidence, "low");
  assert.equal(o.autoUnderwrite.sqftSource, "comps");
  assert.ok(o.autoUnderwrite.rough.some((r) => /square footage/.test(r)), o.autoUnderwrite.rough.join(" | "));
  assert.ok(!(o.autoUnderwrite.held || []).length, "a priced offer, not a held draft");
  assert.equal(floated.length, 1, "the float hook ran");

  // It floats as a rough range with their read asked for — even with the
  // take check switched on, which would otherwise go first.
  const cfg = starterConfig();
  cfg.parties.agent.takeCheck = { enabled: true };
  cfg.parties.agent.realmCheck = { ...cfg.parties.agent.realmCheck, enabled: true, range: { enabled: false, pct: 5 }, setupQuestion: { enabled: false, ask: ["other_offers"] } };
  const saved = { conversationAi: cfg };
  const config = conversationConfig(saved);
  assert.equal(chooseProactiveKind({ events: [], address: o.address, leadWithNumber: false, rough: true }), "realm_check");
  assert.equal(OUTBOUND_KINDS.realm_check.ready({ offer: o, config, dossier: null }), true);
  const d = outboundDescriptor({ kind: "realm_check", offer: o, saved, dossier: null });
  assert.equal(d.confident, false, "the ROUGH wording, not the confident one");
  assert.ok(d.range && d.range.high <= o.cashAmount, "a range topped by our number");
  assert.equal(d.question?.key, "their_read");
  assert.ok(!d.math, "no math on a rough number");
});

test("a house with three listing photos still gets a number", async () => {
  const { job, made } = await run({ sqft: 1500, photos: 3 });
  assert.equal(job.status, "done", says(job));
  const o = made[0];
  assert.equal(o.autoUnderwrite.basis, "rough");
  assert.equal(o.autoUnderwrite.repairsSource, "tier");
  assert.ok(o.autoUnderwrite.rough.some((r) => /listing photo/.test(r)), o.autoUnderwrite.rough.join(" | "));
  assert.ok(job.repairs >= 50000, `a tier budget for 1,500 sqft, got ${job.repairs}`);
});

test("a clean run is not marked rough", async () => {
  const { job, made } = await run({ sqft: 1500, photos: 12 });
  assert.equal(job.status, "done", says(job));
  assert.notEqual(made[0].autoUnderwrite.basis, "rough");
  assert.equal(made[0].autoUnderwrite.passed, true);
});

test("with rough numbers switched off, the house holds as it always did", async () => {
  const { job, made } = await run({ sqft: null, saved: { roughNumbers: { enabled: false } } });
  assert.equal(job.status, "held");
  assert.equal(made.length, 0);
  assert.ok(job.held.some((h) => /square footage is unknown/.test(h)), says(job));
});

test("a rough number still never goes past our share of the list price", async () => {
  const { job, made } = await run({ sqft: null, saved: { maxOfferPctOfList: 50 } });
  assert.equal(job.status, "done", says(job));
  assert.ok(job.listCapped, "the cap fired");
  assert.ok(made[0].cashAmount <= 165000, `capped at 50% of 330k, got ${made[0].cashAmount}`);
});

/* ---------- what still holds ---------- */

test("no address is still held", () => {
  assert.equal(roughNumber({ held: ["no property address in the message"], arv: 400000, sqft: 1500, repairs: 60000 }), null);
});

test("an address placed only at its ZIP code is still held", () => {
  assert.equal(roughNumber({ held: ['"1 Main St" could only be placed at the centre of its ZIP code — the comp search is centred on a guess'], arv: 400000, sqft: 1500, repairs: 60000 }), null);
});

test("no ARV at all is still held", () => {
  assert.equal(roughNumber({ held: ["only 0 renovated/updated comps within 1 mi — 3 required", "no ARV could be derived from the comps"], arv: 0, sqft: 1500, repairs: 0 }), null);
});

test("thin comps, a scope past the band and a foundation flag are priced anyway, on the scope as scanned", () => {
  const r = roughNumber({ held: [
    "only 2 renovated/updated comps within 1 mi — 3 required",
    "the scope totals $190,000, past the heavy band for 1,500–2,000 sqft ($110,000)",
    "the photo scan flagged a possible foundation or structural problem",
  ], arv: 450000, sqft: 1700, repairs: 190000 });
  assert.ok(r);
  assert.equal(r.fix, 190000, "the scanned scope, uncapped");
});

/* ---------- after it lands ---------- */

const ROUGH = { id: "r1", contactId: "c1", address: "4410 Alder Ln, Tacoma, WA 98408", cashAmount: 312000, status: "new",
  createdAt: "2026-10-08T18:00:00Z", autoUnderwrite: { basis: "rough", passed: false, rough: ["only 3 listing photos to scan — 8 required for a scope of work"] } };

test("a rough number never goes higher than what we already texted", () => {
  const thread = "[2026-10-08 17:00] US sms: On 4410 Alder Ln we'd likely land around 295k as-is with a quick close. Is that in the realm for the seller?";
  const q = machineRaise(ROUGH, thread);
  assert.ok(q, "a raise over the 295k we texted");
  assert.equal(q.amount, 295000);
});

test("a rough number is not sent as a written offer on silence", () => {
  assert.equal(paperWorthy(ROUGH), false);
  // Even marked passed, the basis alone keeps it off paper.
  assert.equal(paperWorthy({ ...ROUGH, autoUnderwrite: { ...ROUGH.autoUnderwrite, passed: true } }), false);
  const drafts = [{ status: "sent", outbound: { kind: "realm_check", offerId: "r1" }, sentAt: "2026-10-05T18:00:00Z", createdAt: "2026-10-05T18:00:00Z" }];
  const v = paperAfterSilenceDue({ offer: ROUGH, drafts, events: [], now: Date.parse("2026-10-08T18:00:00Z") });
  assert.equal(v.due, false);
  assert.equal(v.reason, "not a number we put in writing unasked");
});

test("a rough number doesn't send the written offer the moment it lands", () => {
  assert.equal(sendsItselfOnClear(ROUGH), false);
  assert.equal(sendsItselfOnClear({ ...ROUGH, autoUnderwrite: { passed: true } }), true);
});

test("a promised number is kept by the rough offer", () => {
  const v = resolvePromise({ promise: { contactId: "c1", address: "4410 Alder Ln", what: "number", since: "2026-10-08T17:00:00Z", text: "I'll get you a number" },
    offers: [ROUGH], drafts: [], jobs: [] });
  assert.equal(v.move, "send_number");
  assert.equal(v.offerId, "r1");
});

test("their numbers after a rough offer re-run it", () => {
  const told = [{ type: "agent_estimate", address: ROUGH.address, at: "2026-10-08T20:00:00Z", data: { arv: 450000, rehab: 80000 } }];
  assert.equal(rerunsRoughOffer({ known: ROUGH, book: [ROUGH], events: told }), true);
  assert.equal(rerunsRoughOffer({ known: ROUGH, book: [ROUGH], events: [] }), false, "nothing new from them");
  const clean = { ...ROUGH, autoUnderwrite: { passed: true } };
  assert.equal(rerunsRoughOffer({ known: clean, book: [clean], events: told }), false, "a clean offer is not re-run");
  const newer = { ...ROUGH, id: "r2", createdAt: "2026-10-08T21:00:00Z", autoUnderwrite: { passed: true } };
  assert.equal(rerunsRoughOffer({ known: ROUGH, book: [ROUGH, newer], events: told }), false, "already re-run: a newer offer is current");
  const papered = { ...ROUGH, sends: [{ ts: "2026-10-08T19:00:00Z" }] };
  assert.equal(rerunsRoughOffer({ known: papered, book: [papered], events: told }), false, "paper went out — a person's to re-price");
});
