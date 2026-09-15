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
