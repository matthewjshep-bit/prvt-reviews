import test from "node:test";
import assert from "node:assert/strict";
import { buildInvestorContext, buildAgentContext, investorFacingPrice, summarizeOffers, fieldLines, liveDealHold } from "./conversation-context.js";

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
  assert.match(ctx.text, /DEALS THEY ARE ALREADY ON \(sent to them, or they asked\):\n- 2010 NE 54th St.*we sent them this one, no answer yet/);
  assert.match(ctx.text, /NO LONGER AVAILABLE.*\n- 1 Gone St.*assigned to another buyer/);
  assert.equal(ctx.text.includes("Unseen St"), false, "a finished deal they never saw isn't mentioned");
  assert.equal(ctx.summary.goneDeals, 1);
});

test("what a buyer already turned down, and why, is in front of the model", () => {
  const offer = deal({ deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 25000,
    investors: [{ contactId: "c1", status: "passed", reason: { code: "price", note: "no meat on the bone at 445" } }] } });
  const ctx = buildInvestorContext({ investor: INVESTOR, deals: [{ offer }], contactId: "c1", now: NOW });
  assert.match(ctx.text, /they are passed — their reason: Price too high — "no meat on the bone at 445"/);
  // Their own words are the useful half; the label alone still beats nothing.
  const bare = deal({ deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 25000,
    investors: [{ contactId: "c1", status: "passed", reason: { code: "area" } }] } });
  assert.match(buildInvestorContext({ investor: INVESTOR, deals: [{ offer: bare }], contactId: "c1", now: NOW }).text,
    /their reason: Wrong area(?! —)/);
  // A buyer with nothing on record reads exactly as it did before.
  const clean = deal({ deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 25000, investors: [{ contactId: "c1", status: "evaluating" }] } });
  assert.equal(buildInvestorContext({ investor: INVESTOR, deals: [{ offer: clean }], contactId: "c1", now: NOW }).text.includes("their reason"), false);
});

/* ---------- a deal you're working yourself ---------- */

test("a live deal on the acquisition side puts the bot's hands in its pockets", async () => {
  const store = {
    listOffers: async () => [
      { id: "o1", address: "9 Sold St", deal: { stage: "closed" } },
      { id: "o2", address: "22018 76th Ave W", deal: { stage: "under_contract" } },
    ],
    listDeals: async () => { throw new Error("should not be reached for acquisition"); },
  };
  assert.deepEqual(await liveDealHold({ store, locationId: "LOC", contactId: "c1" }),
    { address: "22018 76th Ave W", role: "acquisition", stage: "under_contract" });
  // Signed but not closed is still a live file, and the worst time for a text.
  const assigned = { ...store, listOffers: async () => [{ id: "o3", address: "3 Elm", deal: { stage: "assigned" } }] };
  assert.equal((await liveDealHold({ store: assigned, locationId: "LOC", contactId: "c1" }))?.role, "acquisition");
  // A deal that died, or never was one, is not a reason to stay quiet.
  const done = { ...store, listOffers: async () => [{ id: "o4", address: "4 Elm", deal: { stage: "fell_through" } }, { id: "o5", address: "5 Elm" }] };
  assert.equal(await liveDealHold({ store: done, locationId: "LOC", contactId: "c1" }), null);
  assert.equal(await liveDealHold({ store, locationId: "LOC", contactId: "c1", mode: "off" }), null);
  assert.equal(await liveDealHold({ store, locationId: "LOC", contactId: "" }), null);
});

test("only the buyer signing the assignment stands the bot down", async () => {
  const store = {
    listOffers: async () => [],
    listDeals: async () => [
      { id: "d1", address: "22018 76th Ave W", deal: { stage: "under_contract", investors: [
        { contactId: "c1", status: "evaluating" },
        { contactId: "c2", status: "passed" },
        { contactId: "c3", status: "committed" },
        { contactId: "c4", status: "sent" },        // written before the status was retired
      ] } },
    ],
  };
  // The one who signs is off limits; everything before that is the job.
  assert.deepEqual(await liveDealHold({ store, locationId: "LOC", contactId: "c3" }),
    { address: "22018 76th Ave W", role: "buyer", stage: "under_contract", status: "committed" });
  assert.equal(await liveDealHold({ store, locationId: "LOC", contactId: "c1" }), null, "evaluating is a pipeline, not a handoff");
  assert.equal(await liveDealHold({ store, locationId: "LOC", contactId: "c4" }), null, "a legacy 'sent' row reads as evaluating");
  assert.equal(await liveDealHold({ store, locationId: "LOC", contactId: "c2" }), null, "they passed — send them the next one");
  assert.equal(await liveDealHold({ store, locationId: "LOC", contactId: "c9" }), null, "never linked — still the bot's to pitch");
  // "acquisition" keeps the bot talking to every buyer, the signer included.
  assert.equal(await liveDealHold({ store, locationId: "LOC", contactId: "c3", mode: "acquisition" }), null);
  assert.equal(await liveDealHold({ store, locationId: "LOC", contactId: "c3", mode: "off" }), null);
});

test("a store that cannot answer fails open — a hold is a nicety, a dropped reply is not", async () => {
  const store = { listOffers: async () => { throw new Error("db down"); }, listDeals: async () => [] };
  assert.equal(await liveDealHold({ store, locationId: "LOC", contactId: "c1" }), null);
});

/* ---------- the record in the prompt ---------- */

test("an empty record reads exactly as the GHL fields did — byte for byte", () => {
  const custom = { personal_details: "two kids", agent_market_area: "Kent, Auburn", subject_property: "1 Old St, Kent, WA",
    agent_deal_history: "2026-07-01 | 1 Old St, Kent, WA | we offered $300,000\n2026-07-05 | 1 Old St, Kent, WA | agent countered — wants 320", hook_address: "1 Old St, Kent, WA", hook_price: "350000" };
  const before = buildAgentContext({ offers: [], custom, now: NOW });
  const after = buildAgentContext({ offers: [], custom, now: NOW, facts: {}, events: [] });
  assert.equal(after.text, before.text);
  assert.deepEqual(after.amounts, before.amounts);
  const invBefore = buildInvestorContext({ investor: INVESTOR, deals: [], custom: { personal_details: "likes fishing" }, contactId: "c1", now: NOW });
  const invAfter = buildInvestorContext({ investor: INVESTOR, deals: [], custom: { personal_details: "likes fishing" }, contactId: "c1", now: NOW, facts: null, events: [] });
  assert.equal(invAfter.text, invBefore.text);
});

test("a record with facts outranks the GHL fields, and GHL still fills the gaps", () => {
  const custom = { personal_details: "two kids", agent_market_area: "Kent", subject_property: "1 Old St, Kent, WA" };
  const facts = {
    agent_market_area: [{ value: "Kent", source: "import" }, { value: "Renton", source: "conversation" }],
    subject_property: [{ value: "1 Old St, Kent, WA", source: "import" }, { value: "9 New Ave, Renton, WA", source: "conversation" }],
  };
  const ctx = buildAgentContext({ offers: [], custom, now: NOW, facts, events: [] });
  assert.match(ctx.text, /9 New Ave, Renton, WA/, "the record's newest subject wins");
  assert.doesNotMatch(ctx.text, /1 Old St, Kent, WA/);
  assert.match(ctx.text, /Kent, Renton/, "the list is the record's union");
  assert.match(ctx.text, /two kids/, "a field the record has nothing for still shows");
  // An investor's buy box comes from the record when it has one, even when the dispo cache carries an older one.
  const inv = buildInvestorContext({
    investor: { ...INVESTOR, buybox: { areas: ["Seattle"], priceMin: 300000, priceMax: 500000, propertyTypes: [], rehabAppetite: null, lotMin: null, exclusions: "" } },
    deals: [], custom: {}, contactId: "c1", now: NOW,
    facts: { buybox_areas: [{ value: "Tacoma", source: "conversation" }], buybox_price_max: [{ value: "650000", source: "conversation" }] },
  });
  assert.match(inv.text, /Tacoma/);
  assert.ok(inv.amounts.includes(650000), "the record's band is what they'll echo");
});

test("the ledger in the prompt is the record's newest twelve events, oldest first", () => {
  const events = Array.from({ length: 20 }, (_, i) => ({
    type: "offer_sent", party: "agent", at: `2026-0${1 + Math.floor(i / 9)}-${String((i % 9) + 1).padStart(2, "0")}T12:00:00Z`,
    address: `${i} Elm St, Kent, WA`, data: { amountText: `$${i}` },
  }));
  const ctx = buildAgentContext({ offers: [], custom: { agent_deal_history: "2020-01-01 | 0 Ancient Rd | passed on our offer" }, now: NOW, events, facts: null });
  const lines = ctx.text.split("\n").filter((l) => /^- \d{4}-/.test(l));
  assert.equal(lines.length, 12);
  assert.match(lines[0], /8 Elm St/, "the oldest of the newest twelve");
  assert.match(lines[11], /19 Elm St/);
  assert.doesNotMatch(ctx.text, /Ancient Rd/, "the GHL tail is the fallback, not a supplement");
  // Non-ledger events never reach the ledger block.
  const tagsOnly = buildAgentContext({ offers: [], custom: { agent_deal_history: "2020-01-01 | 0 Ancient Rd | passed on our offer" }, now: NOW,
    events: [{ type: "tag_added", at: "2026-01-01T00:00:00Z", data: { tag: "tier-1" } }], facts: null });
  assert.match(tagsOnly.text, /Ancient Rd/, "with no ledger events the GHL tail still shows");
  assert.doesNotMatch(tagsOnly.text, /tier-1/);
});

test("the agent's own take is in front of the model, newest per property, and their figures are allowed", () => {
  const events = [
    { type: "agent_estimate", at: "2026-09-01T00:00:00Z", address: "12703 Vernon Ave SW", data: { arv: 700000, rehab: 60000 } },
    { type: "agent_estimate", at: "2026-09-05T00:00:00Z", address: "12703 Vernon Ave SW", data: { arv: 715000, rehab: 40000, note: "comps support 715" } },
    { type: "agent_estimate", at: "2026-09-03T00:00:00Z", address: "9 Other St", data: { rehab: 25000 } },
  ];
  const ctx = buildAgentContext({ offers: [], custom: {}, now: NOW, events, facts: null });
  assert.match(ctx.text, /THE AGENT'S OWN TAKE \(their numbers, not ours/);
  assert.match(ctx.text, /12703 Vernon Ave SW: worth \$715,000 done, about \$40,000 of work — "comps support 715"/);
  assert.doesNotMatch(ctx.text, /\$700,000/, "the older take on the same property is superseded");
  assert.match(ctx.text, /9 Other St: about \$25,000 of work/);
  assert.ok(ctx.amounts.includes(715000) && ctx.amounts.includes(40000), "echoing their number back is not inventing one");
  assert.doesNotMatch(buildAgentContext({ offers: [], custom: {}, now: NOW, events: [], facts: null }).text, /OWN TAKE/);
});

test("the prompt carries the subject property's dossier and the next thing to ask", () => {
  const A = "12703 Vernon Ave SW, Lakewood, WA 98498";
  const events = [
    { type: "property_details", at: "2026-09-05T00:00:00Z", address: A, data: { condition: "dated, solid bones", sellerAsk: 480000 } },
    { type: "agent_estimate", at: "2026-09-05T00:00:00Z", address: A, data: { arv: 715000, rehab: 40000 } },
  ];
  const ctx = buildAgentContext({ offers: [], custom: { subject_property: A }, now: NOW, events, facts: null });
  assert.match(ctx.text, /WHAT WE HAVE ON 12703 Vernon Ave SW, Lakewood, WA 98498:\n- Condition: dated, solid bones\n- Their ARV: \$715,000\n- Their rehab: \$40,000\n- Seller wants: \$480,000/);
  assert.match(ctx.text, /STILL MISSING \(ask for ONE of these, the most useful next\): what work it needs\n/, "only the core gap is asked for");
  assert.doesNotMatch(ctx.text, /OUR UNDERWRITE ON IT/, "we already have their take — nothing to draw out");
  assert.match(ctx.text, /DON'T ASK, BUT FILE IF THEY SAY IT: the seller's timeline; whether it's vacant or occupied/);
  assert.ok(ctx.amounts.includes(480000), "the seller's number may be echoed");
  // A subject with nothing on it yet lists the whole checklist; no subject, no block.
  assert.match(buildAgentContext({ offers: [], custom: { subject_property: "1 Elm St" }, now: NOW, events: [], facts: null }).text, /WHAT WE HAVE ON 1 Elm St: nothing yet\.\nSTILL MISSING/);
  assert.doesNotMatch(buildAgentContext({ offers: [], custom: {}, now: NOW, events, facts: null }).text, /WHAT WE HAVE ON/);
});


test("with our underwrite in the book and no take from them, the bot leads with ours to get theirs", () => {
  const A = "12703 Vernon Ave SW, Lakewood, WA 98498";
  const offers = [{ id: "o1", address: "12703 Vernon Avenue SW, Lakewood, WA 98498", cashAmount: 520000, arv: 850000, repairs: 200000, status: "draft", createdAt: "2026-09-07T00:00:00Z" }];
  const ctx = buildAgentContext({ offers, custom: { subject_property: A }, now: NOW, events: [], facts: null });
  assert.match(ctx.text, /OUR UNDERWRITE ON IT: ARV \$850,000, rehab about \$200,000\./);
  assert.match(ctx.text, /"I'm thinking \$850K After Repair Value and \$200K\+ of rehab\. What do you think\?"/);
  assert.match(ctx.text, /not an offer/);
  assert.ok(ctx.amounts.includes(850000) && ctx.amounts.includes(200000), "the two figures may be said, for this");
  // The take is ONE ask, not two: the checklist names it once.
  assert.equal((ctx.text.match(/their take — what it's worth fixed up AND what they'd budget/g) || []).length, 1);
  // Once they've given either half, it isn't asked again.
  const half = buildAgentContext({ offers, custom: { subject_property: A }, now: NOW, facts: null,
    events: [{ type: "agent_estimate", at: "2026-09-08T00:00:00Z", address: A, data: { arv: 800000 } }] });
  assert.doesNotMatch(half.text, /their take — what it's worth/);
  assert.doesNotMatch(half.text, /OUR UNDERWRITE ON IT/);
});
