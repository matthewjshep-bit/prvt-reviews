// off-market.test.mjs — our best deals, marked, counted and asked for gently.

import test from "node:test";
import assert from "node:assert/strict";
import {
  offMarketOf, isOffMarket, offMarketCue, offMarketSignals, offMarketStats,
  OFF_MARKET_ASK_RX, offMarketAskDaysAgo, offMarketAskDue,
} from "./off-market.js";

const NOW = Date.parse("2026-09-30T20:00:00Z");
const DAY = 86400000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();

test("an agent's words say a house is off-market; ours don't", () => {
  for (const said of ["It's a pocket listing", "Not listed yet, seller wants it quiet", "coming soon, hasn't hit the MLS", "we have one off market in Kent",
    "before it goes on the market", "private sale, estate", "Off-market duplex"]) {
    assert.ok(offMarketCue(said), said);
  }
  for (const listed of ["Listed at 450, been sitting", "Price just dropped on 12 Main", "Pending since Tuesday"]) assert.equal(offMarketCue(listed), "", listed);
  const transcript = [
    "[2026-09-29 20:10] US sms: Anything off market you'd want a quick as-is buyer for?",
    "[2026-09-29 20:25] THEM sms: Yes, 7022 in Kenmore. Hasn't been listed yet",
  ].join("\n");
  assert.deepEqual(offMarketSignals({ message: "7022 in Kenmore", transcript }), { value: true, why: "they said \"hasn't been listed\"" });
  assert.equal(offMarketSignals({ message: "Anything?", transcript: "[x] US sms: anything off market?" }), null, "our own ask is not their word");
  assert.deepEqual(offMarketSignals({ message: "12 Main St", listing: { status: "COMING_SOON" } }), { value: true, why: "coming soon on Zillow" });
  assert.equal(offMarketSignals({ message: "12 Main St", listing: { status: "FOR_SALE" } }), null, "listed: not known, never guessed");
});

test("a person's mark is kept as theirs; anything malformed is not a mark", () => {
  assert.deepEqual(offMarketOf({ offMarket: { value: true, by: "you", why: "Lori's pocket listing", at: ago(1) } }), { value: true, by: "you", why: "Lori's pocket listing", at: ago(1) });
  assert.equal(offMarketOf({ offMarket: { value: "yes" } }), null);
  assert.equal(isOffMarket({ offMarket: { value: false, by: "you" } }), false);
  assert.equal(isOffMarket({}), false);
});

test("off-market and listed are counted station by station, each house once, and the agents who bring them are named", () => {
  const off = (id, over = {}) => ({ id, contactId: "lori", contactName: "Lori", status: "sent", createdAt: ago(20), sends: [{ ts: ago(19) }], offMarket: { value: true, by: "you" }, ...over });
  const listed = (id, over = {}) => ({ id, contactId: "sam", contactName: "Sam", status: "sent", createdAt: ago(20), sends: [{ ts: ago(19) }], ...over });
  const r = offMarketStats([
    off("o1", { deal: { stage: "closed" } }),
    off("o2", { status: "countered", statusHistory: [{ status: "countered", ts: ago(10) }] }),
    off("o3", { contactId: "gina", contactName: "Gina", deal: { stage: "under_contract" } }),
    listed("l1"), listed("l2"), listed("l3", { status: "passed" }), listed("l4", { supersededBy: { id: "l5" } }),
    { id: "d1", status: "draft", offMarket: { value: true } },
    listed("old", { createdAt: ago(200) }),
  ], { now: NOW, days: 90 });
  assert.deepEqual(r.offMarket, { offers: 3, sent: 3, countered: 1, agreed: 2, contract: 2, closed: 1, contractRate: 66.7 });
  assert.equal(r.listed.offers, 3);
  assert.equal(r.listed.contract, 0);
  assert.equal(r.listed.contractRate, 0);
  assert.deepEqual(r.agents.map((a) => [a.name, a.offers, a.contracts]), [["Lori", 2, 1], ["Gina", 1, 1]]);
});

test("we ask an agent for off-market houses at most once a month", () => {
  for (const ask of ["If anything comes your way off market, I'd love a first look", "anything before it hits the market?", "any pocket listings?"]) {
    assert.ok(OFF_MARKET_ASK_RX.test(ask), ask);
  }
  assert.equal(OFF_MARKET_ASK_RX.test("Anything else you've got sitting that needs work?"), false);
  assert.equal(offMarketAskDaysAgo([], NOW), null);
  assert.equal(offMarketAskDue([], NOW), true);
  const asked = [{ type: "offmarket_asked", at: ago(12) }, { type: "offmarket_asked", at: ago(40) }];
  assert.equal(offMarketAskDaysAgo(asked, NOW), 12);
  assert.equal(offMarketAskDue(asked, NOW), false);
  assert.equal(offMarketAskDue([{ type: "offmarket_asked", at: ago(31) }], NOW), true);
});
