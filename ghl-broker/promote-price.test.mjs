// promote-price.test.mjs — a deal made from Today's Promote is priced off the
// paper or the book, never an "agreed" on record above them.
//
// Review, 2026-10-02: live data had a realm "yes" at 289,750 on an offer since
// re-priced to 226,000. Promote would have made the deal at 289,750, and the
// buyer blasts would have priced off it.
//
//   node --test promote-price.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "promote-price-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-promote-price";
const client = { call: async () => ({}) };
const router = createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR });
await store.init();

test("Promote makes the deal at the offer's number and the closing date they named, not a stale agreement above it", async () => {
  await store.saveOfferSettings(LOC, { wholesaleFee: 15000 });
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent1", contactName: "Anne T", address: "3418 Wetmore Ave, Everett, WA 98201",
    status: "sent", cashAmount: 226000, statusHistory: [], createdAt: "2026-09-20T00:00:00Z", sends: [{ ts: "2026-09-21T00:00:00Z" }],
    agreed: { amount: 289750, at: "2026-10-02T01:52:28Z", via: "realm_yes" }, realm: { answer: "yes", ts: "2026-10-02T01:52:28Z" } });
  const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });
  const r = await deps.promoteToDeal({ contactId: "agent1", addressHint: "3418 Wetmore Ave", closingDate: "2026-10-24" });
  assert.equal(r.ok, true, r.reason);
  const after = await store.getOffer(o.id);
  assert.equal(after.deal.contractPrice, 226000, "the book's number");
  assert.equal(after.deal.closingDate, "2026-10-24");
});
