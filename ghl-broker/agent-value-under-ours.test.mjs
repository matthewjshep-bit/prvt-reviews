// agent-value-under-ours.test.mjs — an agent's lower value prices the house.
//
// 2026-10-16, a house an agent brought us in Shoreline. He said it was worth
// 650–680K fixed up and needed 80–100K of work. Zillow had no record of the
// house at all, so the rough first pass guessed its size from the comps,
// stretched three small sales to 842K and budgeted light repairs. The bot
// texted "we're seeing comps closer to 842k fixed up", then "around 531.5k".
// He said yes. On his own numbers it is about 380K.
//
// Four things went wrong, one test group each:
//   - a house nobody has a record of was priced on a guessed size
//   - their value under ours didn't count without a list price to cap it to
//   - their repair figure never reached a rough number
//   - the reply argued the value up against theirs
//
//   node --test agent-value-under-ours.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Test-only: the run has to reach the create step to show what it makes.
// Nothing here sends; createOffer is a stub.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uw-their-value-test-"));
delete process.env.DATABASE_URL;
process.env.AUTO_UNDERWRITE_ENABLED = "true";

const { store } = await import("./store.js");
const { startUnderwrite, _resetJobs, theirNumbersBound, roughable } = await import("./auto-underwrite.js");
const { _resetCompsCache } = await import("./comps-zillow.js");
const { _resetSiteCache } = await import("./site-context.js");
const { _resetFactsCache } = await import("./rehab-scan.js");
const { calculateOffers } = await import("./shared/offer-calc.js");
const { classifyHolds } = await import("./shared/held-underwrites.js");
const { valuesWeName } = await import("./shared/current-offer.js");
const { evaluateReplyGates, agentTakeFromText } = await import("./reply-agent.js");
await store.init();

test.after(() => { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const ADDRESS = "2210 Quarry Ave N, Shoreline, WA 98133";
const LAT = 47.7409, LNG = -122.3426;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
const DAY = 86400000;
const at = (north, east) => ({ lat: LAT + north * M_LAT, lng: LNG + east * M_LNG });

// Eight 3/2s inside half a mile, a spread of $/sqft so the price proxy has a
// renovated tier to find (~$500K fixed up at 1,500 sqft).
const NEAR = [
  { street: "2202 Quarry Ave N", n: 120, e: 60, sqft: 1480, ppsf: 330 },
  { street: "2220 Basalt St", n: -150, e: 90, sqft: 1520, ppsf: 325 },
  { street: "2301 Cobble Ave N", n: 200, e: -140, sqft: 1450, ppsf: 340 },
  { street: "2118 Dolomite Ct", n: -220, e: -180, sqft: 1550, ppsf: 335 },
  { street: "2409 Ember St", n: 300, e: 250, sqft: 1500, ppsf: 250 },
  { street: "2511 Flint St", n: -320, e: 260, sqft: 1490, ppsf: 240 },
  { street: "2020 Granite Pl", n: 380, e: -300, sqft: 1530, ppsf: 255 },
  { street: "1933 Hornfels Dr", n: -400, e: -320, sqft: 1470, ppsf: 245 },
];
const row = (c, i) => {
  const { lat, lng } = at(c.n, c.e);
  return {
    zpid: `z${i}`, address: `${c.street}, Shoreline, WA 98133`, livingArea: c.sqft, latLong: { latitude: lat, longitude: lng },
    hdpData: { homeInfo: { zpid: `z${i}`, price: c.sqft * c.ppsf, dateSold: Date.now() - (20 + i * 10) * DAY,
      livingArea: c.sqft, bedrooms: 3, bathrooms: 2, homeType: "SINGLE_FAMILY", latitude: lat, longitude: lng } },
  };
};
// An agent-brought house: no listing, no list price.
const subjectRow = ({ sqft, photos }) => ({
  address: { streetAddress: "2210 Quarry Ave N", city: "Shoreline", state: "WA", zipcode: "98133" },
  homeType: "SINGLE_FAMILY", bedrooms: 3, bathrooms: 2, ...(sqft ? { livingArea: sqft } : {}), yearBuilt: 1955,
  listingPhotos: Array.from({ length: photos }, (_, i) => ({ url: `https://photos.zillowstatic.com/fp/${i}abc-p_f.jpg` })),
  description: "", listingStatus: "OFF_MARKET",
});
const detailRow = (c) => ({ address: { streetAddress: c.street, city: "Shoreline", state: "WA", zipcode: "98133" }, yearBuilt: 1955, livingArea: c.sqft, bedrooms: 3, bathrooms: 2, homeType: "SINGLE_FAMILY" });

// `subject: null` is the house Zillow has never heard of: the map places the
// address, the sold search runs around it, and the detail lookup for the
// house itself comes back with nothing.
function stubFetch(subject, near = NEAR) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("geocoding.geo.census.gov")) {
      return ok({ result: { addressMatches: [{ coordinates: { x: LNG, y: LAT }, matchedAddress: "2210 QUARRY AVE N, SHORELINE, WA, 98133" }] } });
    }
    if (u.includes("overpass")) return ok({ elements: [] });
    if (u.includes("apify")) {
      const body = String(opts.body || "");
      if (body.includes("searchUrls")) return ok(body.includes("for_sale") ? [] : near.map(row));
      let asked = [];
      try { asked = JSON.parse(body).addresses || []; } catch { asked = []; }
      const known = near.filter((c) => asked.some((a) => String(a).startsWith(c.street)));
      return ok([...(subject ? [subjectRow(subject)] : []), ...known.map(detailRow)]);
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
async function run({ subject = { sqft: 1500, photos: 12 }, near = NEAR, take = null } = {}) {
  _resetJobs(); _resetCompsCache(); _resetSiteCache(); _resetFactsCache();
  const restore = stubFetch(subject, near);
  const locationId = `LOC-their-value-${++n}`;
  const contactId = `agent-${n}`;
  const made = [];
  const saved = { aiApiKey: "sk-ant-x", apifyToken: "apify-x" };
  // What the agent told us, the way the reply agent files it (4c).
  if (take) {
    await store.appendContactEvents(locationId, contactId, [{
      type: "agent_estimate", party: "agent", at: new Date(Date.now() - 60000).toISOString(), address: ADDRESS,
      source: "conversation", data: { arv: take.arv || 0, rehab: take.rehab || 0, note: "" },
    }]);
  }
  try {
    const createOffer = async ({ body }) => {
      const calc = calculateOffers(body.inputs, body.settings);
      const cash = body.inputs.priceOverride || calc.offers.cash.amount;
      const offer = await store.createOffer({ locationId, status: "new", contactId: body.contactId, address: body.inputs.address,
        cashAmount: cash, calc, snapshot: body.snapshot });
      made.push(offer);
      return { offer, warnings: [] };
    };
    const { job } = await startUnderwrite({ client, locationId, saved, store, contactId, address: ADDRESS,
      deps: { scanPhotos, createOffer, onOfferCreated: async () => {} } });
    assert.ok(await until(() => ["held", "done", "error"].includes(job.status)), `still ${job.status}/${job.phase}`);
    assert.notEqual(job.status, "error", job.error || "");
    return { job, made };
  } finally { restore(); }
}
const says = (job) => [...(job.held || []), ...(job.warnings || [])].join(" | ");
const arvOf = (o) => o.calc.inputs.arv;
const repairsOf = (o) => o.calc.inputs.repairs;

/* ---------- a house nobody has a record of ---------- */

test("a house the map placed but nobody has a record of is held to check the address, not priced on a guessed size", async () => {
  const { job, made } = await run({ subject: null });
  assert.equal(job.status, "held", says(job));
  assert.equal(made.length, 0, "no number on a house we know nothing about");
  assert.ok(job.held.some((h) => /didn't resolve to a property record/.test(h) && /house number/.test(h)), says(job));
  assert.ok(!job.held.some((h) => /square footage is unknown/.test(h)), "not the size hold — the agent can't fix that one with a number");
});

test("that hold is never priced past and asks for the address, not for comps", () => {
  const reason = "that address didn't resolve to a property record — the map placed it, but there's no size, beds, baths or year built for a house there; check the house number with the agent";
  assert.equal(roughable(reason), false);
  const c = classifyHolds([reason]);
  assert.equal(c.address, true);
  assert.equal(c.rescuable, false);
});

test("a house with its beds, baths and year known but no size still gets a rough number", async () => {
  const { job, made } = await run({ subject: { sqft: null, photos: 0 } });
  assert.equal(job.status, "done", says(job));
  assert.equal(made[0].autoUnderwrite.basis, "rough");
});

/* ---------- their value under ours ---------- */

test("an agent's value under our comps prices the house on theirs, with no list price to cap it to", async () => {
  const { job: ours, made: plain } = await run({ subject: { sqft: 1500, photos: 12 } });
  assert.equal(ours.status, "done", says(ours));
  const ourArv = arvOf(plain[0]);
  assert.ok(ourArv > 450000, `our comps read about 500K, got ${ourArv}`);

  const { job, made } = await run({ subject: { sqft: 1500, photos: 12 }, take: { arv: 420000 } });
  assert.equal(job.status, "done", says(job));
  assert.equal(arvOf(made[0]), 420000, "their value, not ours");
  assert.ok(made[0].cashAmount < plain[0].cashAmount, "a lower number than our comps alone gave");
  assert.deepEqual(made[0].autoUnderwrite.agentValue, { theirs: 420000, ours: ourArv });
  assert.ok(job.warnings.some((w) => /their 420k value/.test(w) && /our comps read/.test(w)), says(job));
});

test("an agent's value under ours lowers a rough number too", async () => {
  const { job, made } = await run({ subject: { sqft: null, photos: 0 }, take: { arv: 420000 } });
  assert.equal(job.status, "done", says(job));
  assert.equal(made[0].autoUnderwrite.basis, "rough");
  assert.equal(arvOf(made[0]), 420000);
});

test("an agent's value over ours leaves ours alone", async () => {
  const { made: plain } = await run({ subject: { sqft: 1500, photos: 12 } });
  const { job, made } = await run({ subject: { sqft: 1500, photos: 12 }, take: { arv: 700000 } });
  assert.equal(job.status, "done", says(job));
  assert.equal(arvOf(made[0]), arvOf(plain[0]));
  assert.equal(made[0].autoUnderwrite.agentValue, undefined);
});

/* ---------- their repairs ---------- */

// The Shoreline shape: no photos, no size, and the renovated sales far off
// the size the comps lend it, so the agent-numbers rescue (which wants a
// list price for a value hold) stands down and the rough pass budgets the
// work from a condition tier.
const SPREAD = NEAR.map((c, i) => (i < 4 ? { ...c, sqft: [1080, 1100, 1960, 2000][i] } : c));
const OFF_SIZE = { subject: { sqft: null, photos: 0 }, near: SPREAD };

test("a rough number never budgets less work than the agent told us", async () => {
  const { job: first, made: plain } = await run(OFF_SIZE);
  assert.equal(first.status, "done", says(first));
  assert.equal(plain[0].autoUnderwrite.basis, "rough", "the rough pass, not the rescue");
  assert.ok(plain[0].autoUnderwrite.rough.some((r) => /off the subject's size/.test(r)), plain[0].autoUnderwrite.rough.join(" | "));
  const tier = repairsOf(plain[0]);
  const theirs = tier + 40000;
  const { job, made } = await run({ ...OFF_SIZE, take: { rehab: theirs } });
  assert.equal(job.status, "done", says(job));
  assert.equal(repairsOf(made[0]), theirs, `their ${theirs}, not the tier's ${tier}`);
});

test("their repairs under a scanned scope leave ours alone", async () => {
  const { made: plain } = await run({ subject: { sqft: 1500, photos: 12 } });
  const { made } = await run({ subject: { sqft: 1500, photos: 12 }, take: { rehab: 5000 } });
  assert.equal(repairsOf(made[0]), repairsOf(plain[0]));
});

test("their numbers only ever lower ours", () => {
  assert.deepEqual(theirNumbersBound({ arv: 842000, repairs: 70000, theirArv: 665000, theirRehab: 90000 }),
    { arv: 665000, repairs: 90000, arvLowered: true, repairsRaised: true });
  assert.deepEqual(theirNumbersBound({ arv: 842000, repairs: 70000, theirArv: 900000, theirRehab: 40000 }),
    { arv: 842000, repairs: 70000, arvLowered: false, repairsRaised: false });
  assert.deepEqual(theirNumbersBound({ arv: 842000, repairs: 70000 }),
    { arv: 842000, repairs: 70000, arvLowered: false, repairsRaised: false });
});

/* ---------- the reply never argues the value up ---------- */

const OUR_REPLY = "Good detail, thanks. We're actually seeing comps closer to 842k fixed up on that one. What's your read on a repair budget for the work you listed?";
// Made up, in the shape his text had: the work, then two figures for the value.
const THEIR_TEXT = "Mostly cosmetic, kitchen, flooring and paint.\n\nValue fixed up could be $650,000 $680,000 once done.";
const draftOf = (reply) => ({ intent: "deal_available", reply, confidence: "high", needsHuman: false });
const gate = (reply, extra = {}) => evaluateReplyGates({
  draft: draftOf(reply), party: "agent", allowedAmounts: [842000, 511500, 90000], inboundMessage: THEIR_TEXT, ourAmount: 511500, ...extra,
});

test("an agent who says it's worth 650 to 680 fixed up is never told our comps say 842", () => {
  const g = gate(OUR_REPLY, { theirValue: 665000, ourValue: 842000 });
  assert.equal(g.ok, false);
  assert.ok(g.flags.some((f) => /842/.test(f) && /they said/.test(f)), g.flags.join(" | "));
});

test("our value said back without a value word is still our value", () => {
  const g = gate("We're seeing 842k on that one. What would you budget for the work?", { theirValue: 665000, ourValue: 842000 });
  assert.ok(g.flags.some((f) => /842/.test(f) && /they said/.test(f)), g.flags.join(" | "));
});

test("before they've given a value, floating ours to get theirs is still fine", () => {
  const g = gate(OUR_REPLY, { theirValue: 0, ourValue: 842000 });
  assert.ok(!g.flags.some((f) => /they said/.test(f)), g.flags.join(" | "));
});

test("agreeing with their own value is fine", () => {
  const g = gate("650 to 680 fixed up sounds about right. What's your read on a repair budget?", { theirValue: 665000, ourValue: 842000 });
  assert.ok(!g.flags.some((f) => /they said/.test(f)), g.flags.join(" | "));
});

test("our price is not a value", () => {
  assert.deepEqual(valuesWeName("We'd likely land around 380k as-is, quick close.", 665000), []);
  assert.deepEqual(valuesWeName("We're seeing comps closer to 842k fixed up on that one.", 665000), [842000]);
  assert.deepEqual(valuesWeName("ARV around 842k by our comps", 665000), [842000]);
});

test("their value is read when they write 'value fixed up could be' and two figures", () => {
  const take = agentTakeFromText(THEIR_TEXT);
  assert.equal(take?.arv, 665000);
});
