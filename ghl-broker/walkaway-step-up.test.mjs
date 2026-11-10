// walkaway-step-up.test.mjs — a walk-away step-up is our number going up, not their yes.
//
// The walk-away (shared/walkaway.js) has been on since 2026-11-04. Each step-up re-issued the
// letter through reviseOfferToCounter, which stamped counterBand.acceptedAt, and priceAgreed read
// that as a yes: the offer went Hot, the price locked, the hot push could ask them to write it up
// "at" a number nobody agreed to, and our own typed pass no longer closed it. Driven through the
// real router's conversation deps against the JSON store, with cardgen stubbed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "walkaway-step-up-test-"));
delete process.env.DATABASE_URL;
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
const { priceAgreed, priceLocked, offerHeat, asksForWriteUp, pushesToPaper, toListOffer } = await import("./shared/offer-status.js");

const LOC = "loc-walkaway-step-up";
const client = { call: async () => ({}) };
const router = createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR, publicBaseUrl: "http://127.0.0.1:4993" });
await store.init();
const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });
test.after(() => cardServer.close());

// An engine grade-A offer the agent countered over: ours 300k, walk-away 315k, theirs 330k.
const mkOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent-w", contactName: "Robin Tester",
  address: "8812 Larkspur Way, Tacoma, WA 98404", cashAmount: 300000, status: "countered",
  counter: { amount: 330000, at: new Date(Date.now() - 3600000).toISOString() },
  statusHistory: [{ status: "countered", ts: new Date(Date.now() - 3600000).toISOString() }],
  sends: [{ ts: new Date(Date.now() - 86400000).toISOString(), channels: ["sms"], results: { sms: { ok: true } } }],
  calc: { settings: { underwriteMode: "mao", maoPctOfArv: 70, wholesaleFee: 15000 }, inputs: { address: "8812 Larkspur Way, Tacoma, WA 98404", arv: 600000, repairs: 80000, askingPrice: 0, priceOverride: 300000 }, offers: {} },
  autoUnderwrite: { basis: "engine", grade: "A" },
  pricing: { live: true, grade: "A", open: 300000, walkAway: 315000, moves: 0 },
  createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), ...over,
});

test("a walk-away step up isn't a yes: the offer isn't hot, the hot push doesn't ask them to write it up at it, the price isn't locked, and our typed pass still closes it", async () => {
  const o = await mkOffer();
  const r = await deps.reviseOfferToCounter({ contactId: "agent-w", addressHint: "8812 Larkspur Way", amount: 307500, by: "walkaway", move: true });
  assert.equal(r.ok, true, r.reason);
  const after = await store.getOffer(o.id);
  assert.equal(after.cashAmount, 307500, "the letter went up to the move");
  assert.equal(after.pricing.moves, 1, "the move counts against its two");
  assert.ok(after.counterBand?.movedAt, "the move is stamped as a move");
  assert.equal(after.counterBand?.acceptedAt, undefined, "a move is not their yes");
  assert.equal(after.agreed, undefined);
  assert.equal(priceAgreed(after), null, "nothing is agreed");
  assert.equal(offerHeat(after), null, "not hot");
  assert.equal(priceLocked(after), false, "the price isn't locked");
  assert.equal(pushesToPaper(after), false);
  assert.equal(asksForWriteUp(after), false, "the hot push never asks them to write it up at a move");

  // The paper still goes after the move (send_offer afterCounter reads the move's stamp).
  const sent = await deps.sendOfferDocs({ contactId: "agent-w", addressHint: "8812 Larkspur Way", afterCounter: true, transcript: "" });
  assert.equal(sent.ok, true, sent.reason);

  // Matt's own "we'll pass" typed on the thread still closes the offer.
  const passed = await router.passOnOurNo({ locationId: LOC, client, contactId: "agent-w", text: "We can't get there on Larkspur, we'll pass", via: "typed in GHL" });
  assert.equal(passed?.offerId, o.id);
  assert.equal((await store.getOffer(o.id)).status, "we_passed");
});

test("their number taken at or under the walk-away is still their yes", async () => {
  const o = await mkOffer({ contactId: "agent-y", address: "41 Quillback Ct, Tacoma, WA 98404", counter: { amount: 310000, at: new Date().toISOString() } });
  const r = await deps.reviseOfferToCounter({ contactId: "agent-y", addressHint: "41 Quillback Ct", amount: 310000, by: "walkaway" });
  assert.equal(r.ok, true, r.reason);
  const after = await store.getOffer(o.id);
  assert.ok(after.counterBand?.acceptedAt);
  assert.equal(after.agreed?.amount, 310000);
  assert.equal(priceAgreed(after)?.amount, 310000);
  assert.equal(priceLocked(after), true);
});

test("a step-up recorded before this fix (stamped as accepted at the move) reads as a move, and the next move clears it", async () => {
  const at = new Date(Date.now() - 600000).toISOString();
  const o = await mkOffer({ contactId: "agent-z", address: "77 Fernhollow Rd, Tacoma, WA 98404", cashAmount: 307500,
    counterBand: { at, acceptedAt: at, amount: 307500, draftId: null },
    // The letter at the first move went five minutes ago.
    sends: [{ ts: new Date(Date.now() - 86400000).toISOString(), channels: ["sms"], results: { sms: { ok: true } } },
      { ts: new Date(Date.now() - 300000).toISOString(), channels: ["sms"], results: { sms: { ok: true } } }],
    // The move went through the revision ledger as the walk-away's, a moment before its stamp.
    revisions: [{ ts: new Date(Date.now() - 601000).toISOString(), from: 300000, to: 307500, by: "walkaway" }],
    pricing: { live: true, grade: "A", open: 300000, walkAway: 315000, moves: 1, lastMoveAt: at, lastMove: 307500 } });
  const before = await store.getOffer(o.id);
  assert.equal(priceAgreed(before), null, "a band record stamped at the last move, with nothing agreed, is a move");
  assert.equal(offerHeat(before), null);
  assert.equal(priceLocked(before), false);

  const r = await deps.reviseOfferToCounter({ contactId: "agent-z", addressHint: "77 Fernhollow Rd", amount: 315000, by: "walkaway", move: true });
  assert.equal(r.ok, true, r.reason);
  const after = await store.getOffer(o.id);
  assert.equal(after.counterBand.acceptedAt, undefined, "the old move's 'accepted' stamp goes with the next move");
  assert.equal(after.counterBand.at, at, "the band's once-per-offer mark stays");
  assert.equal(priceAgreed(after), null);
  assert.equal(after.pricing.moves, 2);
  // The letter after the second move still goes: its stamp is the newer one.
  const sent = await deps.sendOfferDocs({ contactId: "agent-z", addressHint: "77 Fernhollow Rd", afterCounter: true, transcript: "" });
  assert.equal(sent.ok, true, sent.reason);
  assert.notEqual(sent.unchanged, true, "a send after the first move isn't the send after this one");
});

// The hot push, the Hot lane and the follow-up sweep read lean rows (shared/offer-status.js
// OFFER_LIST_FIELDS), which carry no `pricing`, so an old step-up's lastMoveAt can't be seen there.
// The walk-away's own revision at the band's amount, with nothing agreed, says it was a move.
test("a step-up from before this fix isn't read as their yes on the rows the hot push reads", async () => {
  const at = new Date(Date.now() - 600000).toISOString();
  const o = await mkOffer({ contactId: "agent-l", address: "19 Corvid Ln, Tacoma, WA 98404", cashAmount: 307500,
    counterBand: { at, acceptedAt: at, amount: 307500, draftId: null },
    revisions: [{ ts: new Date(Date.now() - 601000).toISOString(), from: 300000, to: 307500, by: "walkaway" }],
    pricing: { live: true, grade: "A", open: 300000, walkAway: 315000, moves: 1, lastMoveAt: at, lastMove: 307500 } });
  const lean = toListOffer(await store.getOffer(o.id));
  assert.equal(lean.pricing, undefined, "a lean row has no pricing");
  assert.equal(priceAgreed(lean), null, "the old move reads as a move on the lean row too");
  assert.equal(offerHeat(lean), null, "not hot");
  assert.equal(asksForWriteUp(lean), false, "the hot push never asks them to write it up at it");

  // Their number taken at or under the walk-away is still their yes on a lean row.
  const y = await mkOffer({ contactId: "agent-m", address: "23 Corvid Ln, Tacoma, WA 98404", counter: { amount: 310000, at: new Date().toISOString() } });
  const r = await deps.reviseOfferToCounter({ contactId: "agent-m", addressHint: "23 Corvid Ln", amount: 310000, by: "walkaway" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(priceAgreed(toListOffer(await store.getOffer(y.id)))?.amount, 310000);
});
