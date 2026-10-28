// price-bricked.test.mjs — Bricked.ai's read of a house, through a stubbed fetch.

import test from "node:test";
import assert from "node:assert/strict";
import { brickedProperty, brickedRequestUrl, normalizeBricked } from "./price-bricked.js";

const RAW = {
  id: "p1", arv: 640000, arvConfidence: 0.82, arvReasoning: "4 renovated sales", cmv: 455000, cmvConfidence: 0.7,
  totalRepairCost: 85000, repairs: [{ repair: "Kitchen", description: "full", cost: 45000 }, { repair: "Roof", description: "", cost: 40000 }],
  property: {
    address: { fullAddress: "123 Fern Way, Kent, WA 98030" }, latitude: 47.38, longitude: -122.23,
    details: { bedrooms: 3, bathrooms: 1.5, squareFeet: 1400, yearBuilt: 1962, lastSaleAmount: 300000, lastSaleDate: 1600000000000, condition_rating: 4.5, renovationScore: { hasScore: true, score: 0.2 } },
    mls: { amount: 499000, status: "Active" },
  },
  comps: [
    { compType: "arv", selected: true, adjusted_value: 652000, is_renovated: true, renovation_score: 0.88, renovation_confidence: 0.9, condition_rating: 2,
      address: { fullAddress: "131 Fern Way, Kent, WA 98030" }, latitude: 47.381, longitude: -122.231, details: { squareFeet: 1380, lastSaleAmount: 660000, lastSaleDate: 1750000000000 } },
    { compType: "cmv", selected: false, adjusted_value: null, is_renovated: null, address: null, details: {} },
  ],
  shareLink: "https://share", dashboardLink: "https://dash",
};

const stub = (status, body, seen = []) => async (url, init) => { seen.push({ url, init }); return { ok: status < 300, status, statusText: "x", json: async () => body }; };

test("the request carries the key in a header and the address in the query, and drops parameters Bricked doesn't take", async () => {
  const seen = [];
  await brickedProperty("123 Fern Way, Kent, WA 98030", { apiKey: "k", fetch: stub(200, RAW, seen), squareFeet: 1400, nonsense: 1 });
  const u = new URL(seen[0].url);
  assert.equal(u.searchParams.get("address"), "123 Fern Way, Kent, WA 98030");
  assert.equal(u.searchParams.get("squareFeet"), "1400");
  assert.equal(u.searchParams.has("nonsense"), false);
  assert.equal(seen[0].init.headers["x-api-key"], "k");
});

test("the answer comes back as ARV, as-is value, repairs, and comps marked renovated or not", async () => {
  const r = await brickedProperty("123 Fern Way", { apiKey: "k", fetch: stub(200, RAW) });
  assert.equal(r.arv, 640000);
  assert.equal(r.asIs, 455000);
  assert.equal(r.repairs, 85000);
  assert.deepEqual(r.repairLines.map((l) => l.cost), [45000, 40000]);
  assert.equal(r.subject.sqft, 1400);
  assert.deepEqual(r.subject.lastSale, { price: 300000, at: 1600000000000 });
  assert.equal(r.subject.listPrice, 499000);
  assert.equal(r.comps[0].renovated, true);
  assert.equal(r.comps[0].lastSale.price, 660000);
  assert.equal(r.comps[1].renovated, null);
  assert.equal(r.comps[1].address, null);
});

test("a Bricked error surfaces its status and its own message", async () => {
  await assert.rejects(
    brickedProperty("1 Nowhere", { apiKey: "k", fetch: stub(402, { error: "Subscription inactive" }) }),
    (e) => e.status === 402 && /Subscription inactive/.test(e.message),
  );
});

test("without a key or an address nothing is sent", async () => {
  const seen = [];
  await assert.rejects(brickedProperty("123 Fern Way", { fetch: stub(200, RAW, seen) }), /no API key/);
  await assert.rejects(brickedProperty("  ", { apiKey: "k", fetch: stub(200, RAW, seen) }), /no address/);
  assert.equal(seen.length, 0);
});

test("missing numbers read as unknown, not zero", () => {
  const r = normalizeBricked({ property: { details: {} }, comps: [] });
  assert.equal(r.arv, null);
  assert.equal(r.asIs, null);
  assert.equal(r.subject.lastSale, null);
  assert.ok(brickedRequestUrl("x").startsWith("https://api.bricked.ai/v1/property/create?address=x"));
});
