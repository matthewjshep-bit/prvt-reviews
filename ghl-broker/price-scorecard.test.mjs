// price-scorecard.test.mjs — the offer engine's evening run: outcomes, sold prices, one Slack line.
//
//   node --test price-scorecard.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "price-scorecard-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { maybeRunPriceScorecard, soldForUnpriced, buildScorecard, CURSOR_NAME } = await import("./price-scorecard.js");
const { houseKey } = await import("./shared/current-offer.js");
const { streetKey } = await import("./comps-zillow.js");
await store.init();

const LOC = "LOC-sc";
const EVENING = Date.parse("2026-11-20T03:30:00Z"); // 7:30pm Pacific
const ADDRESS = "4417 Somerset Ln, Everett, WA 98203";
const SLACK = { enabled: true, channels: { underwrites: "C0123456789" }, streams: { underwrites: true } };
const shadowOn = { pricingV2: { shadow: true }, slackBotToken: "xoxb-test", slack: SLACK };

const record = (address, over = {}) => ({ houseKey: houseKey(address), address, firstAt: "2026-11-10T18:00:00Z",
  reads: {}, v2: { arv: 600000, rehab: 90000, walkAway: 315000, open: 300000, grade: "A", triage: "workable", at: "2026-11-10T18:00:00Z" }, history: [], outcome: null, evidence: [], ...over });

test("the scorecard waits for the shadow switch", async () => {
  assert.equal(await maybeRunPriceScorecard({ store, locationId: LOC, saved: {}, now: EVENING }), null);
});

test("the evening run fills in each house's outcome from its offers and posts one line to Slack", async () => {
  await store.upsertHousePricing(LOC, houseKey(ADDRESS), record(ADDRESS));
  await store.createOffer({ locationId: LOC, contactId: "c1", address: ADDRESS, cashAmount: 335000, status: "countered",
    approved: { by: "publish", at: "2026-11-11T18:00:00Z" }, autoUnderwrite: { skeleton: true, leadSource: "agent_brought" },
    calc: { inputs: { arv: 600000, repairs: 90000 } }, statusHistory: [{ status: "countered", amount: 352000, ts: "2026-11-12T18:00:00Z" }] });
  const posts = [];
  const r = await maybeRunPriceScorecard({ store, locationId: LOC, saved: shadowOn, now: EVENING,
    deps: { slackApi: async (_t, method, body) => { posts.push({ method, body }); return { ok: true }; }, fetchListings: async () => new Map() } });
  assert.ok(r, "it ran");
  assert.equal(r.updated, 1);
  assert.equal(r.posted, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.channel, "C0123456789", "the Underwrites channel");
  assert.match(posts[0].body.text, /^Offer engine \(shadow\): 1 houses priced, 1 with your own number/);
  const rec = await store.getHousePricing(LOC, houseKey(ADDRESS));
  assert.equal(rec.doc.outcome.mattNumber, 335000);
  assert.equal(rec.doc.outcome.sellerLowest, 352000);
  assert.equal(rec.doc.leadSource, "agent_brought");
  const cursor = await store.getJobCursor(LOC, CURSOR_NAME);
  assert.equal(cursor.doc.last.posted, true);
  // Once a day.
  assert.equal(await maybeRunPriceScorecard({ store, locationId: LOC, saved: shadowOn, now: EVENING + 3600000, deps: { slackApi: async () => ({}) } }), null);
});

test("the scorecard read changes nothing", async () => {
  const before = JSON.stringify(await store.listHousePricing(LOC));
  const { card } = await buildScorecard({ store, locationId: LOC, saved: shadowOn, now: EVENING, persist: false });
  assert.equal(card.total.n, 1);
  assert.equal(JSON.stringify(await store.listHousePricing(LOC)), before);
});

test("a house we never priced gets its sale looked up once a week, and only a sale after we priced it counts", async () => {
  const sold = "10511 Moller Dr, Gig Harbor, WA 98332", older = "22 Pine St, Tacoma, WA 98402";
  await store.upsertHousePricing(LOC, houseKey(sold), record(sold));
  await store.upsertHousePricing(LOC, houseKey(older), record(older));
  let asked = [];
  const fetchListings = async (addresses) => {
    asked = addresses;
    return new Map([[streetKey(sold), { lastSoldPrice: 371000, lastSoldDate: "2026-11-15" }], [streetKey(older), { lastSoldPrice: 250000, lastSoldDate: "2019-03-01" }]]);
  };
  const r = await soldForUnpriced({ store, locationId: LOC, saved: { apifyToken: "t" }, now: EVENING, deps: { fetchListings } });
  assert.equal(r.checked, 2, "the house with an offer row is the price watch's, not this");
  assert.equal(r.sold, 1);
  assert.deepEqual((await store.getHousePricing(LOC, houseKey(sold))).doc.outcome.sold, { price: 371000, at: "2026-11-15" });
  assert.equal((await store.getHousePricing(LOC, houseKey(older))).doc.outcome, null, "the seller's own purchase in 2019 isn't the market's answer");
  asked = [];
  const again = await soldForUnpriced({ store, locationId: LOC, saved: { apifyToken: "t" }, now: EVENING + 86400000, deps: { fetchListings } });
  assert.equal(again.checked, 0, "not again for a week");
  assert.equal(asked.length, 0);
});

test("the evening's card is kept for Lessons to read, and it knows the seller's stated number", async () => {
  const LOC2 = "LOC-sc-2";
  const addr = "318 Larkspur Ct, Kent, WA 98030";
  await store.upsertHousePricing(LOC2, houseKey(addr), record(addr, { contactId: "c9" }));
  await store.appendContactEvents(LOC2, "c9", [{ type: "property_details", at: "2026-11-12T18:00:00Z", address: addr, data: { sellerAsk: 300000 }, dedupeKey: "pd:c9:1" }]);
  const { storedScorecard } = await import("./price-scorecard.js");
  assert.equal(await storedScorecard({ store, locationId: LOC2 }), null, "nothing until the evening run");
  const r = await maybeRunPriceScorecard({ store, locationId: LOC2, saved: { pricingV2: { shadow: true } }, now: EVENING, deps: { fetchListings: async () => new Map() } });
  assert.ok(r);
  const kept = await storedScorecard({ store, locationId: LOC2 });
  assert.equal(kept.card.total.n, 1);
  assert.equal(kept.card.total.overTheir, 1, "315k walk-away over the seller's 300k");
  assert.ok(kept.card.ready.A.missing.some((x) => /above their stated number/.test(x)));
  assert.equal((await store.getHousePricing(LOC2, houseKey(addr))).doc.outcome.theirNumber, 300000);
});
