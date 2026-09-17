// investor-price.test.mjs — the price one buyer was given on one deal.

import test from "node:test";
import assert from "node:assert/strict";
import { agreeInvestorPrice } from "./investor-price.js";

const NOW = Date.parse("2026-09-17T20:00:00Z");
const deal = (over = {}) => ({ id: "deal1", locationId: "LOC", address: "23706 138th Dr SE, Snohomish, WA 98296", cashAmount: 400000,
  deal: { stage: "under_contract", contractPrice: 400000, assignmentFee: 25000, investors: [{ contactId: "b1", name: "Alex", status: "evaluating" }], ...over } });
const fakeStore = (offer) => {
  const events = [];
  return { offer, events,
    async getOffer(id) { return id === offer.id ? offer : null; },
    async updateOffer(_id, doc) { Object.assign(offer, doc); return true; },
    async appendContactEvents(_l, contactId, rows) { for (const r of rows) events.push({ ...r, contactId }); return { inserted: rows.length, skipped: 0 }; },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
  };
};
const agree = (store, over = {}) => agreeInvestorPrice({ store, locationId: "LOC", contactId: "b1", offerId: "deal1", amount: 415000, draftId: "d1", now: NOW, ...over });

test("the agreed price is written on that buyer and on the deal, and nothing else about the deal moves", async () => {
  const store = fakeStore(deal());
  const r = await agree(store);
  assert.equal(r.ok, true);
  const inv = store.offer.deal.investors[0];
  assert.deepEqual(inv.agreedPrice, { amount: 415000, at: new Date(NOW).toISOString(), via: "investor_band", draftId: "d1" });
  assert.equal(inv.status, "evaluating", "committing them is still a person's press");
  assert.deepEqual(store.offer.deal.investorBand, { at: new Date(NOW).toISOString(), contactId: "b1", amount: 415000, asking: 425000 });
  assert.equal(store.offer.deal.contractPrice, 400000);
  assert.equal(store.offer.deal.assignmentFee, 25000, "the deal's own fee is the asking price's; this buyer's is on their row");
  assert.equal(store.events[0].type, "investor_price_agreed");
  assert.equal(store.events[0].data.amount, 415000);
});

test("a buyer not yet on the deal is added as evaluating, with the price", async () => {
  const store = fakeStore(deal({ investors: [] }));
  const r = await agree(store, { contactName: "Alex" });
  assert.equal(r.ok, true);
  assert.equal(store.offer.deal.investors[0].status, "evaluating");
  assert.equal(store.offer.deal.investors[0].agreedPrice.amount, 415000);
});

test("the write refuses what the band should never have sent: under the floor, a second concession, a deal that moved on, another location", async () => {
  assert.match((await agree(fakeStore(deal()), { amount: 404000 })).reason, /floor/);
  assert.match((await agree(fakeStore(deal({ investorBand: { at: "2026-09-16T00:00:00Z", contactId: "b9", amount: 418000 } })))).reason, /already came down/);
  assert.match((await agree(fakeStore(deal({ stage: "buyer_found" })))).reason, /buyer found/);
  assert.match((await agree(fakeStore(deal()), { locationId: "OTHER" })).reason, /no such deal/);
  assert.match((await agree(fakeStore(deal()), { amount: 425000 })).reason, /not under/);
});
