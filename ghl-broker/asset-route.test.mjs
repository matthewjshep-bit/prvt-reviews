// asset-route.test.mjs — the kind of house on an offer and its deal: picked by
// hand, read off Zillow when nobody picked, and carried on the rows the
// Offers and Deals tables read.
//
// 1510 Maple Lane, Kent (2026-10-01) was a mobile home in a park with no kind
// on it anywhere, so the blast went to Kent flippers.
//
//   node --test asset-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "asset-route-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-asset-route";
const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }), uploadDir: process.env.DATA_DIR }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const patch = (id, body) => fetch(`${B}/api/offers/${id}/asset`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

test("a deal with no kind reads as what Zillow said, a pick by hand is yours, and the rows carry it", async () => {
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "kim", address: "1510 Maple Lane, Kent, Washington 98030", cashAmount: 71075,
    status: "accepted", statusHistory: [],
    snapshot: { subjectInfo: { homeType: "MANUFACTURED", beds: 3, baths: 2, sqft: 1440 } },
    deal: { stage: "under_contract", contractPrice: 71075, assignmentFee: 30000, investors: [], stageHistory: [] } });

  const deals = await (await fetch(`${B}/api/offers/deals`)).json();
  const d = deals.deals.find((x) => x.id === o.id);
  assert.deepEqual(d.asset, { type: "manufactured", land: "", by: "underwrite" }, "read off Zillow for a deal older than the field");
  assert.equal(d.snapshot, undefined, "the Deals rows still leave the snapshot out");

  const park = await patch(o.id, { type: "manufactured", land: "park" });
  assert.equal(park.ok, true, park.error);
  assert.deepEqual({ type: park.asset.type, land: park.asset.land, by: park.asset.by }, { type: "manufactured", land: "park", by: "you" });
  const [row] = await store.listOffers(LOC, { limit: 5, lean: true });
  assert.equal(row.asset.land, "park", "the lean row carries it");

  const bad = await fetch(`${B}/api/offers/${o.id}/asset`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "castle" }) });
  assert.equal(bad.status, 400);

  const back = await patch(o.id, { type: "" });
  assert.deepEqual(back.asset, { type: "manufactured", land: "", by: "underwrite" }, "clearing it hands it back to Zillow");
});
