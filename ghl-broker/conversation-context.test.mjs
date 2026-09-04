import test from "node:test";
import assert from "node:assert/strict";
import { buildInvestorContext, buildAgentContext, investorFacingPrice, summarizeOffers, fieldLines } from "./conversation-context.js";

const NOW = Date.parse("2026-09-04T17:00:00Z");
const deal = (over = {}) => ({
  id: "o1", address: "2010 NE 54th St, Seattle, WA 98105", cashAmount: 420000,
  calc: { inputs: { arv: 600000, repairs: 40000, address: "2010 NE 54th St, Seattle, WA 98105" } },
  deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 25000, investors: [] },
  ...over,
});
const INVESTOR = { name: "Sam Lee", tags: ["investor-active"], buybox: { areas: ["Seattle", "98105"], priceMin: 300000, priceMax: 500000, propertyTypes: [], lotMin: null, rehabAppetite: null, exclusions: "" } };

test("the investor price is contract plus fee, and both halves are forbidden", () => {
  const n = investorFacingPrice({ offer: deal() });
  assert.equal(n.price, 445000);
  assert.equal(n.arv, 600000);
  assert.equal(n.repairs, 40000);
  assert.ok(n.forbidden.includes(420000) && n.forbidden.includes(25000));
});

test("a dataroom's own headline wins over the deal's arithmetic", () => {
  const room = { id: "r1", snapshot: { numbers: { investorPrice: 450000, arv: 610000, repairs: 40000, contractPrice: 420000, assignmentFee: 30000 } } };
  const n = investorFacingPrice({ offer: deal(), room });
  assert.equal(n.price, 450000);
  assert.equal(n.arv, 610000);
  assert.ok(n.forbidden.includes(30000));
});

test("the investor's book quotes the buyer price and never the fee or the contract price", () => {
  const ctx = buildInvestorContext({ investor: INVESTOR, deals: [{ offer: deal() }], contactId: "c1", now: NOW });
  assert.match(ctx.text, /LIVE DEALS THAT FIT THEIR BUY BOX/);
  assert.match(ctx.text, /2010 NE 54th St.*buyer price \$445,000.*ARV \$600,000.*est\. repairs \$40,000/);
  assert.equal(ctx.text.includes("$25,000"), false, "the fee");
  assert.equal(ctx.text.includes("$420,000"), false, "the contract price");
  assert.ok(ctx.amounts.includes(445000) && ctx.amounts.includes(600000) && ctx.amounts.includes(40000));
  assert.ok(ctx.amounts.includes(300000) && ctx.amounts.includes(500000), "their own band, which they will echo");
  assert.deepEqual([...ctx.forbiddenAmounts].sort((a, b) => a - b), [25000, 420000]);
  assert.match(ctx.text, /INVESTOR PROFILE/);
  assert.match(ctx.text, /Areas: Seattle, 98105/);
});

test("a deal they're already on is listed with their status and the dataroom trail, not as a candidate", () => {
  const room = { id: "r1", status: "active", snapshot: { numbers: { investorPrice: 445000 } } };
  const offer = deal({ deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 25000, investors: [{ contactId: "c1", status: "evaluating" }] } });
  const invites = [{ dataroomId: "r1", contactId: "c1", sentAt: "2026-08-20T00:00:00Z", viewCount: 3, lastViewedAt: "2026-08-22T00:00:00Z" }];
  const ctx = buildInvestorContext({ investor: INVESTOR, deals: [{ offer, room }], invites, contactId: "c1", now: NOW });
  assert.match(ctx.text, /DEALS THEY ARE ALREADY ON \(sent to them, or they asked\):\n- 2010 NE 54th St.*they are evaluating.*dataroom link sent Aug 20, opened 3× \(last Aug 22\)/);
  assert.match(ctx.text, /LIVE DEALS THAT FIT THEIR BUY BOX: none right now/);
  assert.equal(ctx.summary.linkedDeals, 1);
  assert.equal(ctx.summary.matchingDeals, 0);
});

test("only live deals are candidates, only if they fit, and never more than five", () => {
  const deals = [
    { offer: deal({ id: "a", address: "1 Fit St, Seattle, WA 98105" }) },
    { offer: deal({ id: "b", address: "2 Closed St, Seattle, WA 98105", deal: { stage: "closed", contractPrice: 1, assignmentFee: 1, investors: [] } }) },
    { offer: deal({ id: "c", address: "3 Far St, Spokane, WA 99201" }) },   // outside their areas
    { offer: deal({ id: "d", address: "4 Pricey St, Seattle, WA 98105", cashAmount: 900000, deal: { stage: "buyer_found", contractPrice: 900000, assignmentFee: 20000, investors: [] } }) },
    ...Array.from({ length: 7 }, (_, i) => ({ offer: deal({ id: `m${i}`, address: `${10 + i} More St, Seattle, WA 98105` }) })),
  ];
  const ctx = buildInvestorContext({ investor: INVESTOR, deals, contactId: "c1", now: NOW });
  assert.equal(ctx.text.includes("Closed St"), false);
  assert.equal(ctx.text.includes("Far St"), false);
  assert.equal(ctx.text.includes("Pricey St"), false, "outside their price band");
  assert.equal(ctx.summary.matchingDeals, 5);
});

test("a deal with no fee doesn't forbid the one number the model may quote", () => {
  const offer = deal({ deal: { stage: "under_contract", contractPrice: 445000, assignmentFee: 0, investors: [] }, cashAmount: 445000 });
  const ctx = buildInvestorContext({ investor: INVESTOR, deals: [{ offer }], contactId: "c1", now: NOW });
  assert.ok(ctx.amounts.includes(445000));
  assert.equal(ctx.forbiddenAmounts.includes(445000), false);
});

test("an investor with no row falls back to the live fields, and the profile still reads", () => {
  const ctx = buildInvestorContext({
    investor: { name: "New Buyer" }, deals: [], contactId: "c9", now: NOW,
    custom: { buybox_areas: "Tacoma", buybox_price_max: "400000", personal_details: "two kids", last_convo_summary: "wants duplexes" },
  });
  assert.match(ctx.text, /Areas: Tacoma/);
  assert.match(ctx.text, /Price: up to \$400,000/);
  assert.match(ctx.text, /WHAT WE KNOW ABOUT THEM:\n- personal details they've shared: two kids\n- our last conversation, summarised: wants duplexes/);
  assert.ok(ctx.amounts.includes(400000));
});

test("the agent's book carries the asking price from the lean row, and the fields we hold on them", () => {
  const ctx = buildAgentContext({
    offers: [{ address: "12 Elm St", cashAmount: 410000, askingPrice: 525000, status: "sent", createdAt: "2026-08-20T00:00:00Z" }],
    custom: { subject_property: "12 Elm St, Renton, WA", agent_market_area: "Renton, Kent" }, now: NOW,
  });
  assert.match(ctx.text, /our cash offer \$410,000 \(asking \$525,000\)/);
  assert.match(ctx.text, /the property they're currently discussing with us: 12 Elm St, Renton, WA/);
  assert.deepEqual([...ctx.amounts].sort((a, b) => a - b), [410000, 525000]);
  assert.deepEqual(ctx.forbiddenAmounts, []);
  assert.equal(summarizeOffers([]).count, 0);
  assert.deepEqual(fieldLines({ personal_details: " " }, ["personal_details"]), []);
});

import { blastTagged } from "./conversation-context.js";

test("the agent's book carries the outreach hook and the properties they've sent before", () => {
  const ctx = buildAgentContext({
    offers: [], now: NOW,
    custom: { hook_address: "17118 Riverview Way E, Enumclaw, WA", hook_price: "700000", hook_dom: "63",
      agent_deal_history: "2026-07-01 | 1 Old St | passed\n2026-08-10 | 5 Tacoma Ave, Tacoma | sent us the listing — vacant\n2026-08-12 | 9 Tacoma Ave, Tacoma | sent us the listing" },
  });
  assert.match(ctx.text, /THE LISTING WE FIRST REACHED OUT ABOUT: 17118 Riverview Way E.*listed at \$700,000, 63 days on market/);
  assert.match(ctx.text, /PROPERTIES THEY'VE SENT OR DISCUSSED WITH US BEFORE/);
  assert.match(ctx.text, /5 Tacoma Ave/);
  assert.ok(ctx.amounts.includes(700000), "the list price may be quoted");
  assert.equal(ctx.summary.history, 3);
});

test("a dispo blast tag is recognised as 'sent to them', and a finished deal is listed as gone", () => {
  assert.equal(blastTagged(["dispo-2010-ne-54th-st"], "2010 NE 54th St, Seattle, WA 98105"), true);
  assert.equal(blastTagged(["dispo-2010-ne-54th-st-seattle-wa-98105"], "2010 NE 54th St, Seattle, WA 98105"), true);
  assert.equal(blastTagged(["dispo-blast", "dispo-pierce"], "2010 NE 54th St, Seattle, WA 98105"), false);
  assert.equal(blastTagged(["disposition-2010-ne-54th-st"], "2010 NE 54th St", "disposition"), true);
  const ctx = buildInvestorContext({
    investor: INVESTOR, contactId: "c1", now: NOW, tags: ["investor", "dispo-2010-ne-54th-st", "dispo-1-gone-st"],
    deals: [
      { offer: deal() },
      { offer: deal({ id: "g", address: "1 Gone St, Seattle, WA 98105", deal: { stage: "assigned", contractPrice: 1, assignmentFee: 1, investors: [], updatedAt: "2026-09-01T00:00:00Z" } }) },
      { offer: deal({ id: "u", address: "2 Unseen St, Seattle, WA 98105", deal: { stage: "closed", contractPrice: 1, assignmentFee: 1, investors: [] } }) },
    ],
  });
  assert.match(ctx.text, /DEALS THEY ARE ALREADY ON \(sent to them, or they asked\):\n- 2010 NE 54th St.*they are sent it, no answer yet/);
  assert.match(ctx.text, /NO LONGER AVAILABLE.*\n- 1 Gone St.*assigned to another buyer/);
  assert.equal(ctx.text.includes("Unseen St"), false, "a finished deal they never saw isn't mentioned");
  assert.equal(ctx.summary.goneDeals, 1);
});
