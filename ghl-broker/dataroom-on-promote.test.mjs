// dataroom-on-promote.test.mjs — the buyer package is there before the first wave.
//
// What went wrong: a deal's package was a button someone had to press. The
// blast on promote went out regardless, so the first wave's "want the
// details?" had nothing behind it until somebody noticed. With
// dispoAutopilot.dataroomOnPromote on, promoting builds the package first.
//
//   node --test dataroom-on-promote.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dataroom-on-promote-test-"));
delete process.env.CARD_SENDS_ENABLED;
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-dataroom-on-promote";
const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }),
  uploadDir: process.env.DATA_DIR,
}));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const settle = () => new Promise((r) => setTimeout(r, 60));
const mkOffer = () => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent-1", address: "123 Main St, Kent, WA 98031",
  cashAmount: 300000, arv: 480000, repairs: 60000, status: "sent", statusHistory: [], sends: [{ ts: new Date().toISOString(), channels: ["sms"] }],
});
const promote = (id) => fetch(`${B}/api/offers/${id}/deal`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json());

test("promoting builds the buyer package when the switch is on, once, and never when it's off", async () => {
  await store.saveOfferSettings(LOC, { dispoAutopilot: {} });
  const off = await mkOffer();
  assert.equal((await promote(off.id)).ok, true);
  await settle();
  assert.equal((await store.listDatarooms(LOC, { offerId: off.id })).length, 0, "off by default: nothing built");

  await store.saveOfferSettings(LOC, { dispoAutopilot: { dataroomOnPromote: true } });
  const on = await mkOffer();
  const r = await promote(on.id);
  assert.equal(r.ok, true, r.error);
  await settle();
  const rooms = await store.listDatarooms(LOC, { offerId: on.id });
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].status, "active");
  assert.ok(rooms[0].snapshot, "the package is a frozen snapshot of the deal");
});
