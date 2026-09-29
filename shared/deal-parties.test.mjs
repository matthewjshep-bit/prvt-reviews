import test from "node:test";
import assert from "node:assert/strict";
import { resolveParties, mergeParties, normalizeParties, partyName } from "./deal-parties.js";

const OFFER = {
  contactId: "agent-1", contactName: "Mick Walls",
  deal: { investors: [{ contactId: "b1", name: "Rick R", status: "evaluating" }, { contactId: "b2", name: "Taj S", status: "committed" }] },
};

test("who's on the deal comes off what the app already knows, and says where from", () => {
  const p = resolveParties(OFFER, { psa: { titleCompany: "Ticor Title", titleOfficer: "Jane Doe", titlePhone: "206-555-0100" } });
  assert.deepEqual([p.sellerAgent.name, p.sellerAgent.source], ["Mick Walls", "offer"]);
  assert.deepEqual([p.assignee.name, p.assignee.contactId, p.assignee.source], ["Taj S", "b2", "committed buyer"]);
  assert.deepEqual([p.title.company, p.title.name, p.title.source], ["Ticor Title", "Jane Doe", "PSA settings"]);
  assert.equal(p.lender, null, "our PSA lender is not the assignee's lender");
  assert.equal(p.buyerAgent, null);
  assert.equal(partyName(p.title), "Jane Doe (Ticor Title)");
});

test("a party set on the deal wins over the default, and clearing it brings the default back", () => {
  const parties = mergeParties(null, { title: { company: "First American", name: "Sam Escrow" }, sellerAgent: { name: "Mick W", phone: "425" } });
  const p = resolveParties({ ...OFFER, deal: { ...OFFER.deal, parties } }, { psa: { titleCompany: "Ticor Title" } });
  assert.equal(p.title.company, "First American");
  assert.equal(p.title.source, "deal");
  assert.equal(p.sellerAgent.name, "Mick W");
  const cleared = mergeParties(parties, { title: null });
  assert.equal("title" in cleared, false);
  assert.equal("sellerAgent" in cleared, true, "an edit only touches the roles it names");
  assert.deepEqual(normalizeParties({ lender: { name: "   " }, bogus: { name: "x" } }), {});
});
