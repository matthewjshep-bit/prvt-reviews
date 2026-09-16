// underwrite-cost.test.mjs — the spend cuts of 2026-09-15, and the accuracy
// they must not cost: the comp search is bought once a day per search, and the
// photo scope is skipped only when nothing could make a number of it.

import test from "node:test";
import assert from "node:assert/strict";
import { shouldScanPhotos, UW_RADIUS_LADDER } from "./auto-underwrite.js";
import { pullZillowComps, _resetCompsCache, COMPS_CACHE_TTL_MS } from "./comps-zillow.js";

test("the photo scope is skipped only when nothing could carry a number", () => {
  assert.equal(shouldScanPhotos({ arv: 0, theirArv: 0, theirRehab: 0, describedWork: false }), false);
  assert.equal(shouldScanPhotos({ arv: 940000 }), true, "we have an ARV");
  assert.equal(shouldScanPhotos({ theirArv: 750000 }), true, "their value can rescue it");
  assert.equal(shouldScanPhotos({ theirRehab: 120000 }), true, "their repairs can rescue it");
  assert.equal(shouldScanPhotos({ describedWork: true }), true, "they described the work");
  assert.equal(shouldScanPhotos({ fill: true }), true, "the offer form always scans — a person is waiting");
});

test("the comp ladder has no middle rung — every ring re-buys the whole disc", () => {
  assert.deepEqual(UW_RADIUS_LADDER, [0.5, 1.5]);
});

// 2026-09-16: each ring reached also buys the facts (year built, lot) for its
// most similar comps — one detail run of at most UW_ENRICH_CANDIDATES
// addresses, cached a day per street. The search cache above is unchanged.
test("comp facts are bought once a day per street", async () => {
  const { fetchZillowFacts, _resetFactsCache } = await import("./rehab-scan.js");
  _resetFactsCache();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body).addresses); return { ok: true, json: async () => [], text: async () => "" }; };
  try {
    await fetchZillowFacts(["1 A St, Kent, WA"], "t");
    await fetchZillowFacts(["1 A St, Kent, WA"], "t");
    assert.equal(calls.length, 1, "the second ask is free — even for an address Zillow couldn't read");
  } finally { globalThis.fetch = original; }
});

const ROW = { zpid: "1", price: 800000, latLong: { latitude: 47.5, longitude: -122.2 }, area: 1800, beds: 3, baths: 2 };

function stubApify() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body).searchUrls[0].url);
    return { ok: true, json: async () => [ROW], text: async () => "" };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const pull = (over = {}) => pullZillowComps({
  apifyToken: "t", lat: 47.5, lng: -122.2, beds: 3, baths: 2, sqft: 1800, radiusMiles: 0.5, ...over,
});

test("the same search is bought once, and a different one is its own pull", async () => {
  _resetCompsCache();
  const { calls, restore } = stubApify();
  try {
    const first = await pull();
    const again = await pull();
    assert.equal(calls.length, 1, "the second ask came from the day's rows");
    assert.equal(again.rows, first.rows);
    assert.deepEqual(again.comps, first.comps);

    await pull({ radiusMiles: 1.5 });
    assert.equal(calls.length, 2, "a wider ring is a different search");
    await pull({ beds: 4 });
    assert.equal(calls.length, 3, "another house's bands are a different search");
  } finally { restore(); }
});

test("a cached search is dropped once it is a day old", async () => {
  _resetCompsCache();
  const { calls, restore } = stubApify();
  try {
    await pull();
    assert.equal(calls.length, 1);
    assert.ok(COMPS_CACHE_TTL_MS >= 24 * 3600 * 1000 - 1, "a day");
  } finally { restore(); }
});

/* ---------- one house, one offer, one number (Lisa Shilling, 2026-09-15) ---------- */

import { findRecent, paperAlreadyOut } from "./auto-underwrite.js";

const SENT = { id: "hand1", address: "33313 Southeast 42nd Street, Fall City, Washington 98024", status: "sent", cashAmount: 425750, createdAt: new Date().toISOString() };
const bookStore = (offers) => ({ async listOffers() { return offers; } });

test("an offer built by hand counts as already underwritten — the queued run doesn't price it again", async () => {
  const dupe = await findRecent({ store: bookStore([SENT]), locationId: "LOC", contactId: "c1", address: "33313 Se 42nd St, Fall City, WA 98024" });
  assert.equal(dupe?.id, "hand1", "the spelling differs; the house doesn't");
  const other = await findRecent({ store: bookStore([SENT]), locationId: "LOC", contactId: "c1", address: "1 Other St, Fall City, WA 98024" });
  assert.equal(other, null);
  const old = { ...SENT, createdAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() };
  assert.equal(await findRecent({ store: bookStore([old]), locationId: "LOC", contactId: "c1", address: SENT.address }), null, "yesterday's offer doesn't block today's run");
});

test("a rough number is never floated after the written offer went out", () => {
  const found = paperAlreadyOut([SENT], { address: "33313 Se 42nd St, Fall City, WA 98024", offerId: "auto2" });
  assert.equal(found?.id, "hand1");
  assert.equal(paperAlreadyOut([SENT], { address: SENT.address, offerId: "hand1" }), null, "the new offer itself doesn't count");
  assert.equal(paperAlreadyOut([{ ...SENT, status: "new" }], { address: SENT.address, offerId: "auto2" }), null, "an unsent offer is not paper");
  assert.equal(paperAlreadyOut([{ ...SENT, status: "new", sends: [{ ts: "2026-09-15T21:40:25Z" }] }], { address: SENT.address, offerId: "auto2" })?.id, "hand1", "a send ledger counts");
  assert.equal(paperAlreadyOut([SENT], { address: "", offerId: "auto2" }), null);
});
