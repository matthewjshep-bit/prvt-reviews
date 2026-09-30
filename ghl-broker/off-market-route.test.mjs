// off-market-route.test.mjs — marking an offer off-market by hand, and the
// mark riding on the lean rows every list and report reads.
//
//   node --test off-market-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "off-market-route-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-off-market-route";
const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }), uploadDir: process.env.DATA_DIR }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const patch = (id, body) => fetch(`${B}/api/offers/${id}/off-market`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

test("you can mark an offer off-market and back, your mark says it's yours, and the lean rows carry it", async () => {
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "lori", address: "7022 NE 181st St, Kenmore, WA 98028", cashAmount: 500000, status: "sent", statusHistory: [],
    offMarket: { value: true, by: "machine", why: "they said \"hasn't been listed\"", at: new Date().toISOString() } });
  const on = await patch(o.id, { offMarket: true, note: "Lori's pocket listing" });
  assert.equal(on.ok, true, on.error);
  assert.deepEqual({ value: on.offMarket.value, by: on.offMarket.by, why: on.offMarket.why }, { value: true, by: "you", why: "Lori's pocket listing" });
  const [row] = await store.listOffers(LOC, { limit: 5, lean: true });
  assert.equal(row.offMarket.value, true, "the lean row carries the mark");
  const off = await patch(o.id, { offMarket: false });
  assert.deepEqual({ value: off.offMarket.value, by: off.offMarket.by }, { value: false, by: "you" });
});
