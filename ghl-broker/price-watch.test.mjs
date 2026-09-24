// price-watch.test.mjs — a list price that moved after we priced it.

import test from "node:test";
import assert from "node:assert/strict";
import { runPriceWatch, maybeRunPriceWatch, evaluateDrop, stillForSale, CURSOR_NAME } from "./price-watch.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { streetKey } from "./comps-zillow.js";

const DAY = 86400000;
// 2026-09-15 17:00 UTC = 10am Pacific.
const NOW = Date.parse("2026-09-15T17:00:00Z");
const SAVED = { aiApiKey: "k", apifyToken: "tok", conversationAi: normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true } } } }) };

const lisa = (over = {}) => ({
  id: "o1", contactId: "c1", address: "10511 Moller Dr, Gig Harbor, WA", cashAmount: 571621, status: "passed",
  statusAt: new Date(NOW - 20 * DAY).toISOString(), createdAt: new Date(NOW - 30 * DAY).toISOString(), ...over,
});

const fakeStore = (offers) => {
  const map = new Map(offers.map((o) => [o.id, o]));
  const events = [];
  const cursors = new Map();
  return {
    map, events,
    async listOffersForFollowUp() { return [...map.values()]; },
    async getOffer(id) { return map.get(id) || null; },
    async updateOffer(id, doc) { map.set(id, doc); return true; },
    async appendContactEvents(_loc, contactId, rows) {
      let inserted = 0;
      for (const r of rows) {
        if (r.dedupeKey && events.some((e) => e.dedupeKey === r.dedupeKey)) continue;
        events.push({ ...r, contactId }); inserted++;
      }
      return { inserted, skipped: rows.length - inserted };
    },
    async getContactProfile() { return null; },
    async upsertContactProfile() { return {}; },
    async getJobCursor(loc, name) { return cursors.get(`${loc}|${name}`) || null; },
    async setJobCursor(loc, name, v) { cursors.set(`${loc}|${name}`, v); return v; },
  };
};

const listings = (entries) => async () => new Map(entries.map(([address, v]) => [streetKey(address), v]));
const starter = () => {
  const calls = [];
  return { calls, startProactive: async (args) => { calls.push(args); return { job: { id: `j${calls.length}` } }; } };
};

test("a drop is real at $5k and 2%, not a rounding change", () => {
  assert.equal(evaluateDrop({ from: 715000, to: 675000 }).dropped, true);
  assert.equal(evaluateDrop({ from: 715000, to: 712000 }).dropped, false, "$3k is noise");
  assert.equal(evaluateDrop({ from: 0, to: 675000 }).dropped, false, "no baseline, no drop");
  assert.equal(stillForSale("FOR_SALE"), true);
  assert.equal(stillForSale("PENDING"), false);
  assert.equal(stillForSale("SOLD"), false);
});

test("the first look is a baseline: remembered on the offer, no text", async () => {
  const store = fakeStore([lisa()]);
  const s = starter();
  const r = await runPriceWatch({ locationId: "LOC", saved: SAVED, store, now: NOW,
    deps: { ...s, fetchListings: listings([["10511 Moller Dr, Gig Harbor, WA", { listPrice: 715000, status: "FOR_SALE" }]]) } });
  assert.equal(r.checked, 1);
  assert.equal(store.map.get("o1").priceWatch.listPrice, 715000);
  assert.equal(s.calls.length, 0);
});

test("a price cut on a house they passed on starts a price_drop text that carries both prices", async () => {
  const store = fakeStore([lisa({ priceWatch: { listPrice: 715000, status: "FOR_SALE", checkedAt: new Date(NOW - DAY).toISOString() } })]);
  const s = starter();
  const r = await runPriceWatch({ locationId: "LOC", saved: SAVED, store, now: NOW,
    deps: { ...s, fetchListings: listings([["10511 Moller Dr, Gig Harbor, WA", { listPrice: 675000, status: "FOR_SALE" }]]) } });
  assert.equal(r.dropped, 1);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].kind, "price_drop");
  assert.deepEqual([s.calls[0].subject.from, s.calls[0].subject.to], [715000, 675000]);
  assert.ok(store.events.some((e) => e.type === "price_dropped"));
  // Same price tomorrow: already claimed, no second text.
  const again = await runPriceWatch({ locationId: "LOC", saved: SAVED, store, now: NOW + DAY,
    deps: { ...s, fetchListings: listings([["10511 Moller Dr, Gig Harbor, WA", { listPrice: 675000, status: "FOR_SALE" }]]) } });
  assert.equal(again.dropped, 0);
  assert.equal(s.calls.length, 1);
});

test("a listing that went pending is noted once and never texted", async () => {
  const store = fakeStore([lisa({ priceWatch: { listPrice: 715000, status: "FOR_SALE" } })]);
  const s = starter();
  const r = await runPriceWatch({ locationId: "LOC", saved: SAVED, store, now: NOW,
    deps: { ...s, fetchListings: listings([["10511 Moller Dr, Gig Harbor, WA", { listPrice: 675000, status: "PENDING" }]]) } });
  assert.equal(r.offMarket, 1);
  assert.equal(s.calls.length, 0);
  assert.ok(store.events.some((e) => e.type === "listing_off_market"));
});

test("offers that became deals, or went quiet over 90 days ago, aren't watched", async () => {
  const store = fakeStore([
    lisa({ id: "deal", deal: { stage: "under_contract" } }),
    lisa({ id: "old", address: "1 Old Rd, Tacoma, WA", statusAt: new Date(NOW - 120 * DAY).toISOString() }),
  ]);
  const r = await runPriceWatch({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: { ...starter(), fetchListings: listings([]) } });
  assert.equal(r.watched, 0);
});

test("the watch runs once a day, in the morning, and not without an Apify token", async () => {
  const store = fakeStore([lisa()]);
  const deps = { ...starter(), fetchListings: listings([]) };
  assert.equal(await maybeRunPriceWatch({ locationId: "LOC", saved: SAVED, store, now: Date.parse("2026-09-15T12:00:00Z"), deps }), null, "5am Pacific");
  assert.ok(await maybeRunPriceWatch({ locationId: "LOC", saved: SAVED, store, now: NOW, deps }));
  assert.equal(await maybeRunPriceWatch({ locationId: "LOC", saved: SAVED, store, now: NOW + 3600000, deps }), null, "already ran today");
  assert.ok(store.map && (await store.getJobCursor("LOC", CURSOR_NAME)));
  const noKey = await runPriceWatch({ locationId: "LOC", saved: { ...SAVED, apifyToken: "" }, store, now: NOW, deps });
  assert.equal(noKey.skipped, "no Apify token");
});

// 521 Avenue C, 2026-09-24. We sent 571k in August; a re-underwrite in
// September priced it at 522k and never went out. The seller's agent had
// turned down 571 three times and, the day before, asked us for 580. The
// list came down to 599,950 and the bot asked about "our 522k".
const HOUSE = "521 Avenue C, Snohomish, WA 98290";
const erinBook = (over = {}) => [
  lisa({ id: "sent571", contactId: "c9", address: HOUSE, cashAmount: 571061, status: "passed",
    statusAt: new Date(NOW - 30 * DAY).toISOString(), createdAt: new Date(NOW - 36 * DAY).toISOString(),
    sends: [{ ts: new Date(NOW - 36 * DAY).toISOString(), channels: ["sms", "email"], results: { sms: { ok: true } } }],
    priceWatch: { listPrice: 624975, status: "forSale", checkedAt: new Date(NOW - DAY).toISOString() } }),
  lisa({ id: "requote522", contactId: "c9", address: HOUSE, cashAmount: 522401, status: "passed", askingPrice: 649000,
    statusAt: new Date(NOW - DAY / 2).toISOString(), createdAt: new Date(NOW - 10 * DAY).toISOString(),
    statusHistory: over.history || [{ ts: new Date(NOW - DAY / 2).toISOString(), status: "passed" }] }),
];
const withContactList = (store) => ({ ...store,
  async listOffers(_loc, { contactId } = {}) { return [...store.map.values()].filter((o) => !contactId || o.contactId === contactId); } });

test("a price drop quotes the offer we sent them, not a newer number that never went out", async () => {
  const store = withContactList(fakeStore(erinBook()));
  const s = starter();
  const r = await runPriceWatch({ locationId: "LOC", saved: SAVED, store, now: NOW,
    deps: { ...s, fetchListings: listings([[HOUSE, { listPrice: 599950, status: "FOR_SALE" }]]) } });
  assert.equal(r.dropped, 1);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].subject.ours, 571061, "they have 571 in writing; 522 was never sent");
  assert.equal(s.calls[0].subject.from, 624975, "the last price we saw on the house, whichever offer saw it");
});

test("a price drop that still sits above what their agent asked us for isn't news, so no text goes", async () => {
  const history = [
    { ts: new Date(NOW - DAY).toISOString(), status: "countered", amount: 580000, note: "countered at $580,000" },
    { ts: new Date(NOW - DAY / 2).toISOString(), status: "passed" },
  ];
  const store = withContactList(fakeStore(erinBook({ history })));
  const s = starter();
  const r = await runPriceWatch({ locationId: "LOC", saved: SAVED, store, now: NOW,
    deps: { ...s, fetchListings: listings([[HOUSE, { listPrice: 599950, status: "FOR_SALE" }]]) } });
  assert.equal(r.dropped, 1);
  assert.equal(s.calls.length, 0, "she asked 580 yesterday; the seller at 599,950 hasn't moved toward us");
  const ev = store.events.find((e) => e.type === "price_dropped");
  assert.ok(ev, "the drop is still on the record");
  assert.equal(ev.data.theirAsk, 580000);
  assert.match(r.results[0].reason, /asked/);
});

test("a price drop below what their agent asked is worth a text", async () => {
  const history = [{ ts: new Date(NOW - 5 * DAY).toISOString(), status: "countered", amount: 615000 }];
  const store = withContactList(fakeStore(erinBook({ history })));
  const s = starter();
  await runPriceWatch({ locationId: "LOC", saved: SAVED, store, now: NOW,
    deps: { ...s, fetchListings: listings([[HOUSE, { listPrice: 599950, status: "FOR_SALE" }]]) } });
  assert.equal(s.calls.length, 1);
});
