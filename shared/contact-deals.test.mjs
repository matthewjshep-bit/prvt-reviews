import test from "node:test";
import assert from "node:assert/strict";
import { dealRolesFor, contactDealRows, isBuyerSideRole, ROLE_LABEL } from "./contact-deals.js";

const deal = (over = {}) => ({
  id: "o1", contactId: "agent1", address: "1 Elm St, Kent, WA",
  deal: { stage: "under_contract", createdAt: "2026-10-01T00:00:00Z", investors: [], ...over },
});

test("a title rep, a lender and a buyer's agent on a deal each get it with their role", () => {
  const o = deal({ parties: { title: { contactId: "t1" }, lender: { contactId: "l1" }, buyerAgent: { contactId: "b1" } } });
  assert.deepEqual(dealRolesFor(o, "t1"), ["title"]);
  assert.deepEqual(dealRolesFor(o, "l1"), ["lender"]);
  assert.deepEqual(dealRolesFor(o, "b1"), ["buyerAgent"]);
  assert.deepEqual(dealRolesFor(o, "someone-else"), []);
});

test("a buyer who answered a blast was pitched it; one who never answered wasn't", () => {
  const o = deal();
  const blast = (contactId, data = {}) => ({ type: "blast_sent", contactId, offerId: "o1", at: "2026-10-02T00:00:00Z", data });
  assert.deepEqual(dealRolesFor(o, "i1", { events: [blast("i1"), { type: "text_summary", at: "2026-10-03T00:00:00Z" }] }), ["pitched"]);
  assert.deepEqual(dealRolesFor(o, "i2", { events: [blast("i2"), { type: "text_summary", at: "2026-10-01T00:00:00Z" }] }), [], "a text before the blast isn't an answer to it");
  assert.deepEqual(dealRolesFor(o, "i3", { events: [blast("i3", { replied: true })] }), ["pitched"], "the scan saw the reply");
  assert.deepEqual(dealRolesFor(o, "i4", { events: [{ ...blast("i4"), offerId: "other" }, { type: "call_summary", at: "2026-10-05T00:00:00Z" }] }), [], "a blast for another house");
});

test("a walkthrough RSVP puts the deal on their list, and a buyer on the deal is a buyer", () => {
  const o = deal({ investors: [{ contactId: "i1", status: "committed" }], showing: { rsvps: [{ contactId: "i2", status: "coming" }] } });
  assert.deepEqual(dealRolesFor(o, "i1"), ["buyer"]);
  assert.deepEqual(dealRolesFor(o, "i2"), ["walkthrough"]);
  assert.ok(isBuyerSideRole("walkthrough") && isBuyerSideRole("pitched") && isBuyerSideRole("buyer"));
  assert.ok(!isBuyerSideRole("title") && !isBuyerSideRole("lender"));
});

test("the listing agent shows once, even when the deal also names them seller's agent", () => {
  const o = deal({ parties: { sellerAgent: { contactId: "agent1" } } });
  assert.deepEqual(dealRolesFor(o, "agent1"), ["listing"]);
  const rows = contactDealRows({ offers: [o], deals: [] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].roles, ["listing"]);
  assert.equal(ROLE_LABEL.listing, "Listing agent");
});

test("closed deals are kept, live deals sort first, newest first within each", () => {
  const closed = { ...deal({ stage: "closed", updatedAt: "2026-10-15T00:00:00Z" }), id: "c1", address: "9 Closed Ct" };
  const oldLive = { ...deal({ stage: "under_contract", createdAt: "2026-09-01T00:00:00Z" }), id: "l1", address: "2 Old Live" };
  const newLive = { ...deal({ stage: "buyer_found", createdAt: "2026-10-10T00:00:00Z" }), id: "l2", address: "3 New Live" };
  const plainOffer = { id: "p1", contactId: "agent1", address: "4 No Deal" };
  const rows = contactDealRows({
    offers: [closed, oldLive, plainOffer],
    deals: [{ offer: newLive, roles: ["buyer"], standing: { status: "committed" } }],
  });
  assert.deepEqual(rows.map((r) => r.offerId), ["l2", "l1", "c1"]);
  assert.deepEqual(rows.map((r) => r.live), [true, true, false]);
  assert.equal(rows[0].standing.status, "committed");
  assert.deepEqual(contactDealRows(null), []);
});

test("a deal on both lists of theirs is one row with both roles", () => {
  const o = deal({ investors: [{ contactId: "agent1", status: "evaluating" }] });
  const rows = contactDealRows({ offers: [o], deals: [{ offer: o, roles: ["buyer"], standing: { status: "evaluating" } }] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].roles, ["listing", "buyer"]);
});
