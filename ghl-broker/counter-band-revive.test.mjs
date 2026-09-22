// counter-band-revive.test.mjs — the band re-issues an offer that was dead on
// THEIR side. Pink Skulls Realtor, 2414 E Longfellow (2026-09-22): "they
// passed" on 9/10, the check-in asked if the seller had moved, she came back at
// 144k inside the ceiling, and the re-issue said "no open offer". Driven
// through the real router's conversation deps against the JSON store, with
// cardgen stubbed (the re-issue renders the letter).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "counter-band-revive-test-"));
process.env.CARD_SENDS_ENABLED = "false";

const { default: express } = await import("express");
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);
const cardgen = express();
cardgen.use(express.json({ limit: "30mb" }));
cardgen.post("/render", (_req, res) => res.type("image/jpeg").send(JPEG));
const cardServer = cardgen.listen(0);
process.env.CARD_SERVICE_URL = `http://127.0.0.1:${cardServer.address().port}`;

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-band-revive";
const client = { call: async () => ({}) };
const router = createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR, publicBaseUrl: "http://127.0.0.1:4994" });
await store.init();
const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });

const mkOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent-1", contactName: "Agent",
  address: "2414 E Longfellow Ave, Spokane, WA 99207", cashAmount: 128341,
  calc: { settings: { underwriteMode: "mao", maoPctOfArv: 70, wholesaleFee: 30000 }, inputs: { arv: 325000, repairs: 80000, askingPrice: 0 }, offers: {} },
  createdAt: new Date().toISOString(), status: "sent", statusHistory: [], ...over,
});

test("the band re-issuing a passed offer at their number reopens it as countered, so the paper can go", async () => {
  const dead = await mkOffer({ contactId: "a-revive", status: "passed", statusHistory: [{ status: "passed", ts: new Date().toISOString() }] });
  const r = await deps.reviseOfferToCounter({ contactId: "a-revive", addressHint: "2414 E Longfellow Ave", amount: 144000 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.revived, true);
  const after = await store.getOffer(dead.id);
  assert.equal(after.status, "countered");
  assert.equal(after.statusHistory.at(-1).note, "revived by their counter");
  assert.equal(after.counterBand.amount, 144000);
  assert.equal(after.agreed.amount, 144000);
});

test("an open offer re-issued by the band is not marked revived", async () => {
  await mkOffer({ contactId: "a-open", address: "1 Oak St, Spokane, WA", status: "sent" });
  const r = await deps.reviseOfferToCounter({ contactId: "a-open", addressHint: "1 Oak St", amount: 144000 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.revived, false);
});

test("an offer we passed on is never re-issued by the band", async () => {
  await mkOffer({ contactId: "a-ours", address: "9 Walk St, Spokane, WA", status: "we_passed" });
  const r = await deps.reviseOfferToCounter({ contactId: "a-ours", addressHint: "9 Walk St", amount: 144000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no open offer/);
});

test.after(() => cardServer.close());
