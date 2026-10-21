// deal-reply-match.test.mjs — which deal a buyer's reply is about, when
// they were sent more than one (2026-10-21).
//
//   node --test deal-reply-match.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { sentDeal, pickDealForReply, buyerAmounts } from "./deal-reply-match.js";

const bagley = { id: "bagley", address: "3831 Bagley Ave N, Seattle, WA 98103", calc: { inputs: { arv: 1161000, repairs: 102000 } },
  deal: { stage: "under_contract", contractPrice: 740000, assignmentFee: 8000, investors: [], blasts: [{ contactIds: ["b1"] }] } };
const ballard = { id: "ballard", address: "1538 Nw 61st St, Seattle, WA 98107", asset: { type: "land" }, calc: { inputs: { arv: 925000, repairs: 0 } },
  deal: { stage: "under_contract", contractPrice: 890000, assignmentFee: 21000, investors: [{ contactId: "b2" }], blasts: [] } };
const both = [bagley, ballard];

test("a buyer was sent a deal when a wave reached them or they're on it", () => {
  assert.equal(sentDeal(bagley, "b1"), true);
  assert.equal(sentDeal(ballard, "b2"), true);
  assert.equal(sentDeal(ballard, "b1"), false);
});

test("buyers' figures read the way they write them", () => {
  assert.deepEqual(buyerAmounts("that's 400k not 110k"), [400000, 110000]);
  assert.deepEqual(buyerAmounts("$911. Arv $925?"), [911000, 925000]);
  assert.deepEqual(buyerAmounts("show me comps that support 1.15"), [1150000]);
  assert.deepEqual(buyerAmounts("I'd pay $550K for that. 9 month close"), [550000]);
});

test("the street they name, then their numbers, then what kind of property, then the model's read", () => {
  assert.equal(pickDealForReply(both, { said: "Is Bagley still available?" }).offer.id, "bagley");
  assert.equal(pickDealForReply(both, { said: "what's the zoning on 1538?" }).offer.id, "ballard");
  assert.equal(pickDealForReply(both, { hint: "1538 NW 61st St", said: "It's all lath and plaster, that's 400k not 110k" }).offer.id, "bagley");
  assert.equal(pickDealForReply(both, { said: "Price is $911k, and ARV is $925k?" }).offer.id, "ballard");
  assert.equal(pickDealForReply(both, { said: "I'm not a land guy" }).offer.id, "ballard");
  assert.equal(pickDealForReply(both, { hint: "3831 Bagley Ave N", said: "Not right now" }).offer.id, "bagley");
  assert.deepEqual(pickDealForReply(both, { said: "Not right now" }), { offer: null, why: "unclear" });
  assert.equal(pickDealForReply([bagley], { said: "Not right now" }).offer.id, "bagley");
});
