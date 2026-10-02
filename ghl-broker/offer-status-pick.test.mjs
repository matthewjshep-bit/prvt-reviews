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


// Matt, 2026-10-02: a house the agent says sold is "no longer available" —
// not our pass and not theirs. A reply can record it (it's a fact they told
// us, not a decision to walk away), on the live offer or on a house they
// passed on whose check-in they're answering. Our own pass stays ours.
test("an agent saying it sold marks the house no longer available, on the live offer or a house they passed on — never one we passed on", async () => {
  const live = await mkOffer({ contactId: "a-sold", address: "70 Fir St, Kent, WA" });
  let r = await deps.setOfferStatus({ contactId: "a-sold", addressHint: "70 Fir St", status: "unavailable", note: "they said it sold" });
  assert.equal(r.ok, true, r.reason);
  assert.equal((await store.getOffer(live.id)).status, "unavailable");
  assert.equal(r.stopped, 0, "nothing was queued about it");

  const theirs = await mkOffer({ contactId: "a-sold", address: "80 Spruce St, Kent, WA", status: "passed" });
  r = await deps.setOfferStatus({ contactId: "a-sold", addressHint: "80 Spruce St", status: "unavailable" });
  assert.equal(r.ok, true, r.reason);
  assert.equal((await store.getOffer(theirs.id)).status, "unavailable", "the answer to a check-in on a house they passed on");

  const ours = await mkOffer({ contactId: "a-sold", address: "90 Larch St, Kent, WA", status: "we_passed" });
  r = await deps.setOfferStatus({ contactId: "a-sold", addressHint: "90 Larch St", status: "unavailable" });
  assert.equal(r.ok, false);
  assert.equal((await store.getOffer(ours.id)).status, "we_passed", "our own pass stays ours");

  r = await deps.setOfferStatus({ contactId: "a-sold", addressHint: "", status: "we_passed" });
  assert.equal(r.ok, false, "a reply still never walks us away from a house");
  assert.match(r.reason, /not a status this can set/);
});
