// offer-status-pick.test.mjs — which of an agent's offers a status from the
// conversation lands on. Driven through the real router's conversation deps
// against the JSON store, so the pick is the one production makes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offer-status-pick-test-"));
process.env.CARD_SENDS_ENABLED = "false";

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-pick-test";
const client = { call: async () => ({}) };
const router = createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:4997",
});
await store.init();
const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });

let n = 0;
const mkOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent-1", contactName: "Agent",
  address: "1 Main St, Seattle, WA 98101", cashAmount: 300000,
  calc: { settings: {}, inputs: {}, offers: {} },
  // Newest first in listOffers, so a later createdAt is what "the first one" used to be.
  createdAt: new Date(Date.now() + (n++) * 1000).toISOString(),
  status: "sent", statusHistory: [], ...over,
});

test("a no with no address lands on the agent's only open offer, not a newer dead one", async () => {
  const live = await mkOffer({ contactId: "a-only", address: "10 Oak St, Kent, WA" });
  await mkOffer({ contactId: "a-only", address: "20 Pine St, Kent, WA", status: "passed" });
  const r = await deps.setOfferStatus({ contactId: "a-only", addressHint: "", status: "passed" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.address, "10 Oak St, Kent, WA");
  assert.equal((await store.getOffer(live.id)).status, "passed");
});

test("two open offers and no address named is refused, not guessed", async () => {
  await mkOffer({ contactId: "a-two", address: "30 Elm St, Kent, WA" });
  await mkOffer({ contactId: "a-two", address: "40 Ash St, Kent, WA" });
  const r = await deps.setOfferStatus({ contactId: "a-two", addressHint: "", status: "passed" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /more than one open offer/);
});

test("the named address wins among several open offers", async () => {
  await mkOffer({ contactId: "a-named", address: "50 Birch St, Kent, WA" });
  const target = await mkOffer({ contactId: "a-named", address: "60 Cedar St, Kent, WA" });
  const r = await deps.setOfferStatus({ contactId: "a-named", addressHint: "60 Cedar St", status: "countered", amount: 410000 });
  assert.equal(r.ok, true, r.reason);
  assert.equal((await store.getOffer(target.id)).status, "countered");
});

test("a counter on a house they passed on reopens it, but only by address", async () => {
  const closed = await mkOffer({ contactId: "a-back", address: "70 Fir St, Kent, WA", status: "passed" });
  const named = await deps.setOfferStatus({ contactId: "a-back", addressHint: "70 Fir St", status: "countered", amount: 350000 });
  assert.equal(named.ok, true, named.reason);
  assert.equal((await store.getOffer(closed.id)).status, "countered");

  await mkOffer({ contactId: "a-back2", address: "80 Spruce St, Kent, WA", status: "passed" });
  const guessed = await deps.setOfferStatus({ contactId: "a-back2", addressHint: "", status: "countered", amount: 350000 });
  assert.equal(guessed.ok, false, "no address, no open offer: nothing is reopened on a guess");
});
