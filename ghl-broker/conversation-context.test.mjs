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

test("the bot is told a mobile home is a mobile home, and a houses-only buyer is never offered one", () => {
  // 1510 Maple Lane (2026-10-01): six flippers were texted about it as a
  // "3bd 2ba" house. When one writes back, the bot has to know what it is.
  const maple = deal({ id: "mh", address: "1510 Maple Lane, Kent, Washington 98030", cashAmount: 71075,
    asset: { type: "manufactured", land: "park", by: "you" },
    deal: { stage: "under_contract", contractPrice: 71075, assignmentFee: 5000, investors: [{ contactId: "c1", status: "evaluating" }] } });
  const on = buildInvestorContext({ investor: INVESTOR, deals: [{ offer: maple }], contactId: "c1", now: NOW });
  assert.match(on.text, /- 1510 Maple Lane, Kent, Washington 98030: mobile home in a park — buyer price \$76,075/);

  const free = deal({ ...maple, deal: { ...maple.deal, investors: [] } });
  const housesOnly = { ...INVESTOR, buybox: { ...INVESTOR.buybox, areas: ["Kent"], priceMin: 50000, priceMax: 500000, propertyTypes: ["sfr"] } };
  const pitched = buildInvestorContext({ investor: housesOnly, deals: [{ offer: free }], contactId: "c2", now: NOW });
  assert.equal(pitched.text.includes("1510 Maple"), false, "their buy box says houses");
  const mhBuyer = { ...housesOnly, buybox: { ...housesOnly.buybox, propertyTypes: ["manufactured"] } };
  assert.match(buildInvestorContext({ investor: mhBuyer, deals: [{ offer: free }], contactId: "c3", now: NOW }).text, /1510 Maple Lane.*mobile home in a park/);
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
  // 400000 is the rough figure at or under 410,000 the bot may give when asked.
  assert.deepEqual([...ctx.amounts].sort((a, b) => a - b), [400000, 410000, 525000]);
  assert.deepEqual(ctx.forbiddenAmounts, []);
  assert.equal(summarizeOffers([]).count, 0);
  assert.deepEqual(fieldLines({ personal_details: " " }, ["personal_details"]), []);
});

test("an offer we passed on is marked closed on our side in the offer book", () => {
  const o = { id: "o1", address: "7836 Ne 14th St, Medina, WA 98039", cashAmount: 3131644, status: "we_passed", createdAt: "2026-09-02T19:58:08.268Z",
    statusHistory: [{ ts: "2026-09-10T00:00:00Z", status: "passed" }, { ts: "2026-09-22T17:01:20Z", status: "we_passed" }] };
  const r = summarizeOffers([o], { now: Date.parse("2026-09-22T20:00:00Z") });
  assert.match(r.text, /we passed on it \(withdrawn\)/);
  assert.match(r.text, /WE WALKED AWAY from this house/);
  assert.doesNotMatch(r.text, /WHY WE PASSED/, "no reason given, none told");
});

// Matt, 2026-10-17: he marks why we passed, and the bot can say it.
test("the reason Matt gave for passing reaches the offer book in words the bot can say", () => {
  const o = { id: "o1", address: "88 Hilltop Rd, Enumclaw, WA 98022", cashAmount: 410000, status: "we_passed", createdAt: "2026-10-01T19:58:08Z",
    passReason: { code: "rural", at: "2026-10-16T17:00:00Z", by: "operator" }, statusHistory: [{ ts: "2026-10-16T17:00:00Z", status: "we_passed", reason: "rural" }] };
  const r = summarizeOffers([o], { now: Date.parse("2026-10-17T20:00:00Z") });
  assert.match(r.text, /WHY WE PASSED \(rural\): it's too rural for our buyers/);
  // A reason left on an offer that's no longer passed is not told.
  assert.doesNotMatch(summarizeOffers([{ ...o, status: "sent", sends: [{ ts: "2026-10-17T00:00:00Z" }] }], { now: Date.parse("2026-10-17T20:00:00Z") }).text, /WHY WE PASSED/);
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
  assert.match(ctx.text, /STILL MISSING \(ask for ONE of these, the most useful next\): the seller's timeline\n/, "only the core gap is asked for");
  assert.match(ctx.text, /DON'T ASK, BUT FILE IF THEY SAY IT: what work it needs; whether it's vacant or occupied/);
  assert.ok(ctx.amounts.includes(480000), "the seller's number may be echoed");
  // A subject with nothing on it yet lists the whole checklist; no subject, no block.
  assert.match(buildAgentContext({ offers: [], custom: { subject_property: "1 Elm St" }, now: NOW, events: [], facts: null }).text, /WHAT WE HAVE ON 1 Elm St: nothing yet\.\nSTILL MISSING/);
  assert.doesNotMatch(buildAgentContext({ offers: [], custom: {}, now: NOW, events, facts: null }).text, /WHAT WE HAVE ON/);
});


// Matt, 2026-10-21: "we keep asking the agents how much rehab it needs" —
// they push back, "you're the flipper, do the analysis yourself". The
// checklist asked "what it's worth fixed up AND what they'd budget for the
// work" on nearly every reply, and handed the bot our ARV and rehab to float
// to draw theirs out.
test("the bot is never told to ask the agent for their rehab or what it's worth fixed up, and asks about the seller instead", () => {
  const A = "12703 Vernon Ave SW, Lakewood, WA 98498";
  const offers = [{ id: "o1", address: "12703 Vernon Avenue SW, Lakewood, WA 98498", cashAmount: 520000, arv: 850000, repairs: 200000, status: "draft", createdAt: "2026-09-07T00:00:00Z" }];
  const ctx = buildAgentContext({ offers, custom: { subject_property: A }, now: NOW, events: [], facts: null });
  assert.doesNotMatch(ctx.text, /OUR UNDERWRITE ON IT|What do you think\?/);
  assert.ok(!ctx.amounts.includes(200000), "our rehab figure isn't handed over to float");
  assert.match(ctx.text, /STILL MISSING \(ask for ONE of these, the most useful next\): what the seller is hoping to get; the seller's timeline\n/);
  assert.match(ctx.text, /DON'T ASK, BUT FILE IF THEY SAY IT: the overall condition; what work it needs; what they think it's worth fixed up; what they'd budget for the work/);
  assert.match(ctx.text, /NEVER ASK THEM what it's worth fixed up, what the work would run, or what work it needs/);
  // What they volunteer is still kept.
  const told = buildAgentContext({ offers, custom: { subject_property: A }, now: NOW, facts: null,
    events: [{ type: "agent_estimate", at: "2026-09-08T00:00:00Z", address: A, data: { arv: 800000, rehab: 60000 } }] });
  assert.match(told.text, /- Their ARV: \$800,000\n- Their rehab: \$60,000/);
});

test("a deal committed to another buyer is never pitched, and to a buyer who knows it, it's spoken for with no numbers", () => {
  const committed = { stage: "buyer_found", contractPrice: 420000, assignmentFee: 25000, investors: [{ contactId: "other", status: "committed" }] };
  const fresh = buildInvestorContext({ investor: INVESTOR, deals: [{ offer: deal({ deal: committed }) }], contactId: "c1", now: NOW });
  assert.equal(fresh.text.includes("2010 NE 54th"), false, "not a candidate, not named at all");
  assert.equal(fresh.summary.matchingDeals, 0);
  assert.equal(fresh.amounts.includes(445000), false);

  const onIt = { ...committed, stage: "under_contract", investors: [...committed.investors, { contactId: "c1", status: "evaluating" }] };
  const linked = buildInvestorContext({ investor: INVESTOR, deals: [{ offer: deal({ deal: onIt }) }], contactId: "c1", now: NOW });
  assert.match(linked.text, /NO LONGER AVAILABLE[^]*2010 NE 54th St.*committed to another buyer/);
  assert.equal(linked.summary.linkedDeals, 0);

  const buyer = { ...committed, investors: [{ contactId: "c1", status: "committed" }] };
  const theirs = buildInvestorContext({ investor: INVESTOR, deals: [{ offer: deal({ deal: buyer }) }], contactId: "c1", now: NOW });
  assert.equal(theirs.summary.linkedDeals, 1, "the committed buyer still has their deal");
});

/* ---------- a price agreed with one buyer (the investor band, 2026-09-17) ---------- */

test("the next message from that buyer quotes the agreed price, and another buyer still sees the asking price", () => {
  const offer = deal({ deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 25000,
    investors: [{ contactId: "c1", status: "evaluating", agreedPrice: { amount: 435000, at: "2026-09-03T17:00:00Z", via: "investor_band" } }, { contactId: "c2", status: "evaluating" }],
    investorBand: { at: "2026-09-03T17:00:00Z", contactId: "c1", amount: 435000, asking: 445000 } } });
  const theirs = buildInvestorContext({ investor: INVESTOR, deals: [{ offer }], contactId: "c1", now: NOW });
  assert.match(theirs.text, /buyer price \$435,000/);
  assert.match(theirs.text, /agreed with them/i);
  assert.equal(theirs.text.includes("$445,000"), false, "the old asking price is not theirs any more");
  assert.ok(theirs.amounts.includes(435000));
  assert.equal(theirs.amounts.includes(445000), false);
  // What they must never hear: the contract price, the deal's fee, the fee they are actually paying, and how far we came down.
  for (const n of [420000, 25000, 15000, 10000]) assert.ok(theirs.forbiddenAmounts.includes(n), `${n} is forbidden`);
  const others = buildInvestorContext({ investor: INVESTOR, deals: [{ offer }], contactId: "c2", now: NOW });
  assert.match(others.text, /buyer price \$445,000/);
  assert.equal(others.text.includes("435,000"), false, "one buyer's price is nobody else's business");
  assert.equal(others.amounts.includes(435000), false);
});

/* ---------- the number we came down to (Kimberly Pettie, 1510 Maple Lane, 2026-09-18) ---------- */

// The book said 71,075 (a re-quote). Matt then texted "Can we do $65k
// actually". Three days later the bot answered "still good?" with 71k.
const MAPLE = {
  id: "m1", address: "1510 Maple Lane, Kent, Washington 98030", cashAmount: 71075, status: "countered",
  createdAt: "2026-09-10T22:59:36Z",
  statusHistory: [{ ts: "2026-09-10T23:00:11Z", status: "sent" }, { ts: "2026-09-15T17:00:47Z", status: "countered", amount: 70000 }],
  sends: [{ ts: "2026-09-10T23:00:11Z", channels: ["sms"] }],
  requotes: [{ ts: "2026-09-15T17:00:56Z", from: 60552, to: 71075 }],
};
const MAPLE_THREAD = [
  "[2026-09-15 17:04] US sms: Re-ran Maple Lane using your 200k comps and the vandalism repairs. We land right around 71k as-is, quick close. Does that work for the seller?",
  "[2026-09-15 17:04] THEM sms: Yes much better",
  "[2026-09-15 17:06] US sms: Can we do $65k actually the $200k comp is the higher end",
  "[2026-09-15 17:07] THEM sms: Let me ask her.",
].join("\n");

test("a lower number we floated after the offer becomes the book's number, and the old one is stale", () => {
  const b = summarizeOffers([MAPLE], { now: Date.parse("2026-09-18T00:16:00Z"), transcript: MAPLE_THREAD });
  assert.match(b.text, /we came down to \$65,000/i);
  assert.match(b.text, /\$65,000 is our number/);
  assert.match(b.text, /never say \$71,075/i);
  assert.ok(b.amounts.includes(65000), "65k is allowed");
  assert.ok(b.stale.includes(71075), "71,075 is stale");
  assert.ok(!b.amounts.includes(71075), "71,075 is no longer allowed");
});

test("our own number said again, a higher number, or one said before the re-quote is not a come-down", () => {
  const same = "[2026-09-15 17:06] US sms: We're at 71k as-is, does that work?";
  assert.equal(summarizeOffers([MAPLE], { transcript: same }).stale.length, 0);
  const higher = "[2026-09-15 17:06] US sms: Could you do 80k?";
  assert.equal(summarizeOffers([MAPLE], { transcript: higher }).stale.length, 0);
  const before = "[2026-09-12 17:06] US sms: Can we do $65k?";
  assert.equal(summarizeOffers([MAPLE], { transcript: before }).stale.length, 0);
  const theirs = "[2026-09-15 17:06] THEM sms: Can we do $65k?";
  assert.equal(summarizeOffers([MAPLE], { transcript: theirs }).stale.length, 0);
});

test("the agent context carries the come-down through to the gate's stale list", () => {
  const ctx = buildAgentContext({ offers: [MAPLE], transcript: MAPLE_THREAD, now: Date.parse("2026-09-18T00:16:00Z") });
  assert.ok(ctx.staleAmounts.includes(71075));
  assert.ok(ctx.amounts.includes(65000));
});

test("a deal soft-committed to another buyer is not brought up to someone new", () => {
  const soft = deal({ deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 25000, investors: [{ contactId: "other", name: "Other Buyer", status: "soft_commit" }] } });
  const ctx = buildInvestorContext({ investor: INVESTOR, deals: [{ offer: soft }], contactId: "c1", now: NOW });
  assert.equal(ctx.text.includes("2010 NE 54th St"), false, "not a candidate, and its numbers are nowhere in what the bot reads");
  assert.match(ctx.text, /LIVE DEALS THAT FIT THEIR BUY BOX: none right now/);
  assert.equal(ctx.amounts.includes(445000), false, "so the money guard would hold a draft that quoted it anyway");
  assert.equal(ctx.summary.matchingDeals, 0);
});

test("the soft-commit buyer themselves, and a buyer it was already sent to, still have the deal to talk about", () => {
  const mine = deal({ deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 25000, investors: [{ contactId: "c1", status: "soft_commit" }] } });
  assert.match(buildInvestorContext({ investor: INVESTOR, deals: [{ offer: mine }], contactId: "c1", now: NOW }).text, /DEALS THEY ARE ALREADY ON[^]*2010 NE 54th St/);
  const theirs = deal({ deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 25000, investors: [{ contactId: "other", status: "soft_commit" }, { contactId: "c1", status: "evaluating" }] } });
  assert.match(buildInvestorContext({ investor: INVESTOR, deals: [{ offer: theirs }], contactId: "c1", now: NOW }).text, /DEALS THEY ARE ALREADY ON[^]*2010 NE 54th St/, "a soft commit is a maybe — nobody already looking is told it's gone");
});

// 13041 SE 208th St, Kent (2026-09-25): the book listed all five rows on the
// house, each with its own number, and every one of them was allowed.
test("the offer book quotes one number per house and holds a superseded one", () => {
  const A = "13041 Southeast 208th Street, Kent, Washington 98031";
  const offers = [
    { id: "july", contactId: "c", address: A, cashAmount: 416500, status: "countered", createdAt: "2026-07-27T22:35:00Z", sends: [{ ts: "2026-07-27T22:44:00Z" }] },
    { id: "aug", contactId: "c", address: A, cashAmount: 421556, status: "passed", createdAt: "2026-08-05T16:31:00Z", sends: [{ ts: "2026-08-05T16:31:42Z" }] },
    { id: "d", contactId: "c", address: A, cashAmount: 402687, status: "draft", createdAt: "2026-08-21T16:28:00Z" },
  ];
  const book = summarizeOffers(offers, { now: Date.parse("2026-09-22T00:00:00Z") });
  assert.equal(book.count, 1, "one house, one line");
  assert.match(book.text, /\$421,556/);
  assert.doesNotMatch(book.text, /416,500/);
  assert.match(book.text, /1 older offer on this house superseded/);
  assert.ok(book.stale.includes(416500), "the July number is stale — a draft that says it is held");
  assert.ok(!book.amounts.includes(416500));
});

test("the agent context says when we last asked about off-market houses, and names one they brought us", () => {
  const NOW2 = Date.parse("2026-09-30T20:00:00Z");
  const fresh = buildAgentContext({ offers: [], custom: {}, now: NOW2, events: [] });
  assert.match(fresh.text, /OFF-MARKET ASK: not asked in the last 30 days — you may ask once, lightly, at a natural close/);
  const asked = buildAgentContext({ offers: [], custom: {}, now: NOW2, events: [{ type: "offmarket_asked", at: "2026-09-20T20:00:00Z" }] });
  assert.match(asked.text, /OFF-MARKET ASK: we asked 10 days ago — don't ask again yet/);
  const source = buildAgentContext({ offers: [{ id: "o1", address: "7022 NE 181st St, Kenmore, WA", status: "sent", cashAmount: 500000, createdAt: "2026-09-01T00:00:00Z", offMarket: { value: true, by: "you" } }], custom: {}, now: NOW2, events: [] });
  assert.match(source.text, /They have brought us an off-market house before \(7022 NE 181st St\)/);
});

test("a duplex we priced anyway counts as chosen; a passed one, a held draft and a single-family house don't", async () => {
  const { pricedOutsideFocus } = await import("./conversation-context.js");
  const at = "2026-10-02T17:00:00Z";
  const row = (address, homeType, over = {}) => ({ id: address, contactId: "c1", address, createdAt: at, status: "new", cashAmount: 300000,
    snapshot: { subjectInfo: { homeType } }, ...over });
  const offers = [
    row("13348 32nd Ave S, Tukwila, WA 98168", "MULTI_FAMILY"),
    row("1 Elm St, Kent, WA 98030", "SINGLE_FAMILY"),
    row("2 Oak St, Kent, WA 98030", "CONDO", { status: "we_passed" }),
    row("3 Pine St, Kent, WA 98030", "TOWNHOUSE", { status: "draft", cashAmount: null, snapshot: null, draft: { subjectInfo: { homeType: "TOWNHOUSE" } } }),
    // A lean row carries the kind as subjectHomeType.
    { id: "lean", contactId: "c1", address: "4 Ash St, Kent, WA 98030", createdAt: at, status: "sent", cashAmount: 90000, subjectHomeType: "MANUFACTURED" },
  ];
  assert.deepEqual(pricedOutsideFocus(offers, ["sfr"]).sort(), ["13348 32nd Ave S, Tukwila, WA 98168", "4 Ash St, Kent, WA 98030"]);
  assert.deepEqual(pricedOutsideFocus(offers, ["sfr", "multi_family"]), ["4 Ash St, Kent, WA 98030"], "a mobile home we priced is named, whatever the focus (2026-10-13)");
});

test("a buyer asking whether it's septic finds the answer in the deal line, from the record", async () => {
  const { buildInvestorContext } = await import("./conversation-context.js");
  const deal = {
    id: "d-septic", address: "21904 Vashon Hwy SW, Vashon, WA 98070", status: "accepted", cashAmount: 371000,
    calc: { inputs: { arv: 900000, repairs: 214000 } },
    snapshot: { subjectInfo: { beds: 3, baths: 2, sqft: 2190, house: { sewer: "septic", garageSpaces: 0 } } },
    deal: { stage: "under_contract", contractPrice: 371000, assignmentFee: 16000, investors: [{ contactId: "inv-septic", status: "evaluating" }] },
  };
  const ctx = buildInvestorContext({ investor: { contactId: "inv-septic" }, deals: [{ offer: deal }], contactId: "inv-septic" });
  assert.match(ctx.text, /21904 Vashon Hwy SW.*about the house: septic, no garage/);
});

// 3418 Wetmore Ave (2026-10-03): the book said "agent said the number is in
// the realm" beside our 226k, when the realm yes was to ~290k. The bot then
// asked her to write it up "at the 226k" as if it were agreed.
test("a realm yes to a higher number is not read as a yes to the number we're at now", () => {
  const at = "2026-10-02T01:52:28.418Z";
  const o = { id: "o1", address: "3418 Wetmore Ave, Everett, WA 98201", cashAmount: 226000, status: "sent", createdAt: "2026-10-02T01:45:08Z",
    sends: [{ ts: "2026-10-02T01:52:31Z" }], agreed: { at, via: "realm_yes", amount: 289750 }, realm: { answer: "yes", ts: at } };
  const r = summarizeOffers([o], { now: Date.parse("2026-10-03T17:00:00Z") });
  assert.doesNotMatch(r.text, /agent said the number is in the realm/);
  assert.match(r.text, /said \$289,750 was in the realm.*NOT agreed to \$226,000/);
});

import { leanOfferDoc, toListOffer } from "./shared/offer-status.js";
import { calculateOffers } from "./shared/offer-calc.js";

test("on the Postgres book the bot still sees the ARV behind our number", () => {
  const calc = calculateOffers({ address: "12 Elm St, Renton, WA", arv: 500000, repairs: 50000 }, { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000 });
  const full = { id: "o1", address: "12 Elm St, Renton, WA", cashAmount: calc.offers.cash.amount, status: "sent", createdAt: "2026-09-20T00:00:00Z", calc };
  // Exactly what loadAgentContext gets back from store.listOffers({ lean: true }) on prod.
  const ctx = buildAgentContext({ offers: [toListOffer(leanOfferDoc(full))], now: NOW, showMath: true });
  assert.match(ctx.text, /\[our math:/);
  assert.ok(ctx.amounts.includes(500000), "the ARV may be said when we show our work");
  assert.ok(ctx.amounts.includes(50000), "and so may the rehab");
});

test("a range we floated is in the book: our number is its top, and a letter after it makes it history", () => {
  const offer = { id: "o1", address: "12 Elm St, Renton, WA", cashAmount: 295000, status: "new", createdAt: "2026-09-01T00:00:00Z",
    proactive: { realmCheckAt: "2026-09-02T00:00:00Z", range: { low: 280000, high: 295000, step: 10000, at: "2026-09-02T00:00:00Z" } } };
  const ctx = buildAgentContext({ offers: [offer], now: NOW });
  assert.match(ctx.text, /we floated "the 280s to 295" by text .*our number is \$295,000, the top of it; the bottom was never an offer on its own/);
  assert.deepEqual(ctx.ranges, [{ low: 280000, high: 295000 }]);
  assert.ok(ctx.amounts.includes(280000), "the bottom may be said again, as the bottom of the range");
  const lettered = { ...offer, status: "sent", sends: [{ ts: "2026-09-03T00:00:00Z", channels: ["sms"] }] };
  const after = buildAgentContext({ offers: [lettered], now: NOW });
  assert.doesNotMatch(after.text, /we floated/);
  assert.deepEqual(after.ranges, []);
});

test("a rural house we priced anyway counts as chosen, so the bot talks numbers on it", async () => {
  const { pricedOutsideFocus } = await import("./conversation-context.js");
  const at = "2026-10-08T17:00:00Z";
  const offers = [
    { id: "r", contactId: "c1", address: "21800 Farm Rd SE, Maple Valley, WA 98038", createdAt: at, status: "new", cashAmount: 400000,
      snapshot: { subjectInfo: { homeType: "SINGLE_FAMILY", lotSqft: 5 * 43560 } } },
    { id: "t", contactId: "c1", address: "1 Elm St, Kent, WA 98030", createdAt: at, status: "new", cashAmount: 300000,
      snapshot: { subjectInfo: { homeType: "SINGLE_FAMILY", lotSqft: 7200 } } },
    // A lean row carries the lot as subjectLotSqft.
    { id: "lean", contactId: "c1", address: "4 Ash St, Kent, WA 98030", createdAt: at, status: "sent", cashAmount: 250000, subjectHomeType: "SINGLE_FAMILY", subjectLotSqft: 3 * 43560 },
  ];
  assert.deepEqual(pricedOutsideFocus(offers, ["sfr"]).sort(), ["21800 Farm Rd SE, Maple Valley, WA 98038", "4 Ash St, Kent, WA 98030"]);
});

// 1425 33rd St SE (2026-10-11): the sweep passed on it before we priced it,
// on a misread "turnkey". The book told the bot we walked away, so it told
// the agent twice we'd moved on while he was giving us his numbers.
test("a house the sweep passed on before we priced it is open to the agent's numbers, not a walk-away", () => {
  const swept = { id: "p1", address: "1425 33rd St SE, Auburn, WA 98002", cashAmount: null, status: "we_passed", createdAt: "2026-10-10T19:05:28Z",
    retired: { at: "2026-10-11T02:08:29Z", by: "held-sweep", reason: 'turnkey per the agent ("mostly cosmetic")' } };
  const r = summarizeOffers([swept], { now: Date.parse("2026-10-11T18:00:00Z") });
  assert.doesNotMatch(r.text, /WE WALKED AWAY/);
  assert.match(r.text, /OPEN TO THEIR NUMBERS/);
  const condo = { ...swept, id: "p2", address: "1740 NE 86th St, Seattle, WA 98115",
    retired: { ...swept.retired, reason: "not our kind of house — an apartment (single-family only right now)" } };
  assert.match(summarizeOffers([condo]).text, /WE WALKED AWAY/, "a condo stays walked away from");
});

// 2026-10-13: an agent named two houses by street only. The next reply has
// to know they're still waiting on an address, or "it's 1412" lands nowhere.
test("houses they named without a number are listed for the next reply until the number comes", () => {
  const at = new Date(Date.now() - 3600000).toISOString();
  const events = [
    { type: "house_mentioned", at, address: "Pine St, Shelton", data: { sellerAsk: 410000, note: "1920s rambler" } },
    { type: "house_mentioned", at, address: "Alder Street", data: { sellerAsk: 0, note: "triplex, seller would carry the note" } },
  ];
  const ctx = buildAgentContext({ offers: [], events });
  assert.match(ctx.text, /HOUSES THEY NAMED THAT WE DON'T HAVE AN ADDRESS FOR YET/);
  assert.match(ctx.text, /- Pine St, Shelton, asking \$410,000 — 1920s rambler/);
  assert.match(ctx.text, /- Alder Street — triplex, seller would carry the note/);
  assert.ok(ctx.amounts.includes(410000), "their ask may be said back");
  const later = buildAgentContext({ offers: [{ id: "o1", address: "88 Alder St, Shelton, WA", status: "draft" }],
    events: [...events, { type: "house_mentioned", at: new Date().toISOString(), address: "1412 Pine St, Shelton", data: {} }] });
  assert.doesNotMatch(later.text, /DON'T HAVE AN ADDRESS/);
});

// 2026-10-14: "some Stanwood houses", no street at all. The next reply
// still has to know we're waiting on where they are.
test("houses they named only by town are listed for the next reply by what they called them", () => {
  const at = new Date(Date.now() - 3600000).toISOString();
  const events = [{ type: "house_mentioned", at, address: "", data: { label: "the Stanwood houses", area: "Stanwood", town: "Stanwood", note: "need a lot of work" } }];
  const ctx = buildAgentContext({ offers: [], events });
  assert.match(ctx.text, /- the Stanwood houses \(no street yet\) — need a lot of work/);
});

// 2026-10-15: an agreed number Matt hasn't approved isn't written up yet.
test("an agreed price at a number we haven't approved tells the bot not to ask for the write-up yet", () => {
  const o = { id: "o1", address: "12 Elm St, Renton, WA 98056", cashAmount: 410000, status: "countered", statusAt: "2026-10-14T18:00:00Z", createdAt: "2026-10-13T18:00:00Z",
    autoUnderwrite: { passed: true }, realm: { answer: "yes", ts: "2026-10-14T18:00:00Z" }, hot: { at: "2026-10-14T18:00:00Z", by: "conversation", signal: "writing_up" } };
  const r = summarizeOffers([o], { now: Date.parse("2026-10-15T18:00:00Z") });
  assert.match(r.text, /AGREED \(.*\) at \$410,000, but the number is NOT APPROVED on our side yet — don't ask them to write it up/);
  assert.doesNotMatch(r.text, /the next step is asking them to write it up/);
  assert.equal(r.numbers[0].approved, false);
  const ok = summarizeOffers([{ ...o, approved: { amount: 410000, at: "2026-10-15T17:00:00Z", by: "today" } }], { now: Date.parse("2026-10-15T18:00:00Z") });
  assert.match(ok.text, /HOT \(.*\) — the price conversation is done; the next step is asking them to write it up on NWMLS forms/);
  assert.equal(ok.numbers[0].approved, true);
});

test("a house drafted for Matt to price tells the bot he's pricing it himself, with no figure and no time", () => {
  // Draft only (2026-10-16): 71 "I'll have your number today" promises went unkept.
  const drafted = { id: "d1", contactId: "c", address: "4417 Somerset Ln, Everett, WA 98203", cashAmount: null, status: "draft",
    createdAt: "2026-10-16T20:00:00Z",
    autoUnderwrite: { draftOnly: true, held: ["ready for your comps — the app made the draft, you price it"] } };
  const book = summarizeOffers([drafted], { now: Date.parse("2026-10-16T21:00:00Z") });
  assert.match(book.text, /MATT IS PRICING THIS ONE HIMSELF \(no number yet\)/);
  assert.match(book.text, /never a figure, a range or a time/);
  assert.doesNotMatch(book.text, /our team's review/);
  const heldRun = { ...drafted, id: "d2", autoUnderwrite: { held: ["only 1 listing photo to scan"] } };
  assert.match(summarizeOffers([heldRun]).text, /numbers held for our team's review/, "a held run reads as before");
});

test("a commercial building or land Matt priced is one the bot talks numbers on", async () => {
  const { pricedOutsideFocus } = await import("./conversation-context.js");
  const offers = [
    { id: "a", address: "900 Main St, Kent, WA 98030", status: "new", cashAmount: 780000, asset: { type: "commercial", by: "you" }, underwriteModel: "income", createdAt: "2026-10-18T00:00:00Z" },
    { id: "b", address: "0 Ridge Rd, Enumclaw, WA 98022", status: "new", cashAmount: 120000, asset: { type: "land", by: "you" }, underwriteModel: "land", createdAt: "2026-10-18T00:00:00Z" },
  ];
  assert.deepEqual(pricedOutsideFocus(offers, ["sfr"]).sort(), ["0 Ridge Rd, Enumclaw, WA 98022", "900 Main St, Kent, WA 98030"]);
});

test("a house we passed on stops being asked about: the bot is told to say we passed, not what it's worth fixed up", () => {
  // 1921 Lopez Way, 2026-10-20: Matt marked it "We passed: rural", and the
  // next two replies asked the agent what it's worth fixed up and what the
  // work would run — the subject's checklist and the next step planned
  // before the pass were still in the prompt, and they won.
  const A = "1921 Lopez Way, Point Roberts, WA 98281";
  const passed = { id: "o1", address: A, status: "we_passed", createdAt: "2026-10-19T22:28:47Z", statusAt: "2026-10-20T19:13:23Z",
    passReason: { code: "rural", at: "2026-10-20T19:13:23Z", by: "operator" } };
  const events = [{ type: "property_details", at: "2026-10-20T02:53:49Z", address: A, data: { condition: "dated, rustic, decent shape" } }];
  const custom = { subject_property: A, suggested_next_action: "get agent's read on arv and rehab budget for 1921 lopez way" };
  const ctx = buildAgentContext({ offers: [passed], custom, now: Date.parse("2026-10-20T23:35:00Z"), events, facts: null });
  assert.doesNotMatch(ctx.text, /STILL MISSING/, "nothing about a passed house is ours to ask");
  assert.doesNotMatch(ctx.text, /the next step we had planned/, "the step planned before the pass is stale");
  assert.match(ctx.text, /WE PASSED ON 1921 Lopez Way, Point Roberts, WA 98281/);
  assert.match(ctx.text, /it's too rural for our buyers/, "the reason Matt picked is the one to give");
  assert.match(ctx.text, /haven't told them/i, "the reply tells them, if the thread hasn't yet");

  // A house the nightly sweep passed on unpriced is open to their numbers
  // (2026-10-11): asking for their read on it is still right.
  const reopened = { ...passed, passReason: null, retired: { by: "held-sweep", reason: "held 9 days and nothing since" } };
  const open = buildAgentContext({ offers: [reopened], custom, now: Date.parse("2026-10-20T23:35:00Z"), events, facts: null });
  assert.match(open.text, /STILL MISSING/);
  assert.doesNotMatch(open.text, /WE PASSED ON 1921/);
});

// 2026-10-22 audit: the first reply to a house an agent names was written
// before its draft existed, so "Matt is pricing this one himself" never
// reached it, and it promised "I'll text you where we'd land" — 27 of 100
// such promises went unkept. With Matt pricing every house, every reply says so.
test("the bot doesn't promise a number on a house Matt prices", async () => {
  const { MATT_PRICES_LINE } = await import("./conversation-context.js");
  const on = buildAgentContext({ offers: [], custom: {}, now: NOW, mattPrices: true });
  assert.ok(on.text.includes(MATT_PRICES_LINE));
  assert.match(MATT_PRICES_LINE, /never say you'll run the numbers or text them where we'd land/);
  const off = buildAgentContext({ offers: [], custom: {}, now: NOW });
  assert.ok(!off.text.includes("PRICING A NEW HOUSE"));
});
