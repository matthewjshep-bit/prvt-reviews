// seller-yes.test.mjs — "the seller accepted", written down as the agreed
// price. Driven through the real router's conversation deps against the JSON
// store, so the offer the push to paper reads is the one production writes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "seller-yes-test-"));
process.env.CARD_SENDS_ENABLED = "false";

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { hotCandidates } = await import("./follow-up-sweep.js");
const { priceLocked, pushesToPaper, effectiveStatus } = await import("./shared/offer-status.js");
const { evaluateAcceptance } = await import("./shared/auto-accept.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");

const LOC = "loc-seller-yes";
const client = { call: async () => ({}) };
const router = createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:0",
});
await store.init();
const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });

const sentAt = new Date(Date.now() - 5 * 86400000).toISOString();
const mkOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent-yes", contactName: "Agent",
  address: "12 Elm St, Renton, WA 98056", cashAmount: 410000,
  calc: { settings: {}, inputs: {}, offers: {} },
  status: "sent", statusAt: sentAt, statusHistory: [{ status: "sent", ts: sentAt }], sends: [{ ts: sentAt, channels: ["sms"] }],
  ...over,
});
const HOT = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { hot_push: { enabled: true } } } } } });

test("a seller's yes at our number locks the price and starts the push to paper", async () => {
  const offer = await mkOffer({ contactId: "yes-1" });
  const r = await deps.markOfferAgreed({ contactId: "yes-1", offerId: offer.id, draftId: "d-yes" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.amount, 410000);
  const after = await store.getOffer(offer.id);
  assert.equal(after.agreed.via, "acceptance");
  assert.equal(after.agreed.amount, 410000);
  assert.equal(priceLocked(after), true, "no re-quote or re-underwrite may move it now");
  assert.equal(pushesToPaper(after), true);
  const pushes = await hotCandidates({ store, locationId: LOC, config: HOT, now: Date.now() + 1.2 * 86400000 });
  assert.ok(pushes.some((c) => c.offerId === offer.id), "the push to paper picks it up");
});

test("the acceptance band says yes once per offer — the second yes waits for you", async () => {
  const offer = await mkOffer({ contactId: "yes-2" });
  const args = { draft: { intent: "acceptance", confidence: "high", counterAmount: 0 }, inboundMessage: "accepted", band: { acceptance: true, dailyCap: 5 } };
  assert.equal(evaluateAcceptance({ ...args, offer, openOffers: [offer] }).passed, true, "the first yes may go");
  await deps.markOfferAgreed({ contactId: "yes-2", offerId: offer.id, draftId: "d1" });
  const after = await store.getOffer(offer.id);
  const second = evaluateAcceptance({ ...args, offer: after, openOffers: [after] });
  assert.equal(second.passed, false);
  assert.equal(second.checks.find((c) => !c.ok).name, "once_per_offer");
});

test("a yes on an offer they passed on brings it back at our number", async () => {
  const offer = await mkOffer({ contactId: "yes-3", status: "passed", statusHistory: [{ status: "sent", ts: sentAt }, { status: "passed", ts: sentAt }] });
  const r = await deps.markOfferAgreed({ contactId: "yes-3", offerId: offer.id });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.revived, true);
  const after = await store.getOffer(offer.id);
  assert.equal(effectiveStatus(after), "sent");
  assert.equal(priceLocked(after), true);
});

test("a house we walked from is never brought back by a yes, and a second yes changes nothing", async () => {
  const walked = await mkOffer({ contactId: "yes-4", status: "we_passed" });
  const r = await deps.markOfferAgreed({ contactId: "yes-4", offerId: walked.id });
  assert.equal(r.ok, false);
  assert.match(r.reason, /we passed/);

  const offer = await mkOffer({ contactId: "yes-5" });
  await deps.markOfferAgreed({ contactId: "yes-5", offerId: offer.id, draftId: "first" });
  const again = await deps.markOfferAgreed({ contactId: "yes-5", offerId: offer.id, draftId: "second" });
  assert.equal(again.unchanged, true);
  assert.equal((await store.getOffer(offer.id)).agreed.draftId, "first");
});

test("another agent's offer is never marked from this thread", async () => {
  const theirs = await mkOffer({ contactId: "someone-else" });
  const r = await deps.markOfferAgreed({ contactId: "yes-6", offerId: theirs.id });
  assert.equal(r.ok, false);
  assert.equal((await store.getOffer(theirs.id)).agreed, undefined);
});
