// tiers.test.mjs — Tier 1 / Tier 2 from the app's own record, never stored.

import test from "node:test";
import assert from "node:assert/strict";
import { agentTier, buyerTier } from "./tiers.js";

const NOW = Date.parse("2026-10-02T20:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const offer = (over = {}) => ({ id: "o1", contactId: "c1", address: "12 Elm St, Kent, WA 98031", cashAmount: 300000, status: "sent", createdAt: ago(5), sends: [{ ts: ago(5) }], ...over });

test("Tier 1 is a property in hand: a deal, an offer out, a counter, a hot offer, a priced house, a held underwrite", () => {
  assert.deepEqual(agentTier({ offers: [offer({ deal: { stage: "under_contract" }, status: "accepted" })], now: NOW }), { tier: "t1", why: "under contract on 12 Elm St", address: "12 Elm St, Kent, WA 98031" });
  assert.match(agentTier({ offers: [offer()], now: NOW }).why, /offer out on 12 Elm St/);
  assert.match(agentTier({ offers: [offer({ status: "countered" })], now: NOW }).why, /countered/);
  assert.match(agentTier({ offers: [offer({ realm: { answer: "yes", ts: ago(1) } })], now: NOW }).why, /hot/);
  assert.match(agentTier({ offers: [offer({ status: "new", sends: [] })], now: NOW }).why, /not sent yet/);
  assert.match(agentTier({ offers: [offer({ status: "draft", autoUnderwrite: { jobId: "j", held: ["only 1 priced comps"] }, createdAt: ago(2) })], now: NOW }).why, /underwriting/);
});

test("a house they named in the last three weeks, not priced yet, is Tier 1; an old one isn't", () => {
  const named = { type: "subject_property_set", at: ago(2), address: "210 4th Ave N, Kent, WA 98032" };
  assert.deepEqual(agentTier({ events: [named], lastInboundAt: ago(2), now: NOW }).tier, "t1");
  assert.equal(agentTier({ events: [{ ...named, at: ago(40) }], lastInboundAt: ago(40), now: NOW }).tier, "t2");
  assert.equal(agentTier({ events: [named], offers: [offer({ address: "210 4th Ave N, Kent, WA 98032", status: "passed" })], lastInboundAt: ago(2), now: NOW }).tier, "t2", "priced and passed: not in hand");
  assert.match(agentTier({ events: [{ type: "address_pending", at: ago(1) }], lastInboundAt: ago(1), now: NOW }).why, /waiting on the address/);
  assert.equal(agentTier({ events: [{ type: "address_pending", at: ago(3) }, { type: "address_pending_closed", at: ago(1) }], lastInboundAt: ago(1), now: NOW }).tier, "t2");
});

test("Tier 2 has written back with nothing in hand; cold never has; an opt-out is neither", () => {
  assert.deepEqual(agentTier({ offers: [offer({ status: "passed" })], lastInboundAt: ago(30), now: NOW }), { tier: "t2", why: "nothing in hand (passed on 12 Elm St)" });
  assert.equal(agentTier({ lastInboundAt: ago(200), now: NOW }).tier, "t2");
  assert.equal(agentTier({ now: NOW }).tier, "cold");
  // A partner from before the timeline: a closed deal is them having answered.
  assert.equal(agentTier({ offers: [offer({ status: "accepted", deal: { stage: "closed" } })], now: NOW }).tier, "t2");
  assert.equal(agentTier({ offers: [offer({ status: "no_response" })], now: NOW }).tier, "cold", "an offer that met silence is not an answer");
  assert.equal(agentTier({ offers: [offer()], events: [{ type: "unsubscribed", at: ago(1) }], now: NOW }).tier, "opted_out");
});

test("buyers: on a live deal is Tier 1, talking or replied is Tier 2, the rest cold", () => {
  assert.equal(buyerTier({ onLiveDeal: true, talk: { replies: 3 } }), "t1");
  assert.equal(buyerTier({ talk: { replies: 2 } }), "t2");
  assert.equal(buyerTier({ lastRepliedAt: ago(10) }), "t2");
  assert.equal(buyerTier({ lastMessageAt: ago(10) }), "cold");
  assert.equal(buyerTier({}), "cold");
  assert.equal(buyerTier({ onLiveDeal: true, tags: ["dnc"] }), "opted_out");
});
