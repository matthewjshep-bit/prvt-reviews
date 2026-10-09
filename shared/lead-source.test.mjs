// lead-source.test.mjs — how a house came to us: the listing we opened with,
// or a house the agent brought.

import test from "node:test";
import assert from "node:assert/strict";
import { leadSourceOf, leadSourcesFor, sourceAgents, CHECKIN_WINDOW_DAYS } from "./lead-source.js";

const T0 = Date.parse("2026-08-05T18:00:00Z");
const DAY = 86400000;
const at = (d) => new Date(T0 + d * DAY).toISOString();

test("a house the agent brings that we never texted about is agent_brought, not listed", () => {
  // Opened on a nice listing; four weeks later the agent's friend's house.
  const hooks = [{ address: "100 Pine St, Seattle, WA 98122", importedAt: at(0) }];
  const offer = { contactId: "a1", address: "200 Lake Dr SE, Snohomish, WA 98296", createdAt: at(29) };
  const lead = leadSourceOf({ offer, hooks, events: [] });
  assert.equal(lead.source, "agent_brought");
  assert.equal(lead.daysToHouse, 29);
  assert.equal(lead.hook, "100 Pine St, Seattle, WA 98122");
  assert.equal(lead.checkin, false, "no check-in on record");
});

test("the listing we opened with stays the hook, however its address is spelled", () => {
  const hooks = [{ address: "7518 211th St E, Spanaway, WA 98387", importedAt: at(0) }];
  const offer = { contactId: "a1", address: "7518 211th Street East, Spanaway, Washington 98387", createdAt: at(3) };
  assert.equal(leadSourceOf({ offer, hooks }).source, "hook");
});

test("a later listing of theirs we pinged them about is ours, not theirs", () => {
  const hooks = [{ address: "100 Pine St, Seattle, WA", importedAt: at(0) }];
  const events = [{ type: "agent_pulse_texted", at: at(20), address: "55 Elm St, Kent, WA" }];
  const offer = { contactId: "a1", address: "55 Elm St, Kent, WA 98030", createdAt: at(21) };
  assert.equal(leadSourceOf({ offer, hooks, events }).source, "hook");
});

test("a house that comes right after a check-in is marked as the check-in's", () => {
  const hooks = [{ address: "100 Pine St, Seattle, WA", importedAt: at(0) }];
  const offer = { contactId: "a1", address: "9 Oak Ave, Tacoma, WA", createdAt: at(30) };
  const soon = [{ type: "agent_pulse_texted", at: at(29) }];
  assert.equal(leadSourceOf({ offer, hooks, events: soon }).checkin, true);
  const followup = [{ type: "outreach_enrolled", at: at(28), data: { kind: "followup" } }];
  assert.equal(leadSourceOf({ offer, hooks, events: followup }).checkin, true, "the circling-back follow-up counts");
  const opener = [{ type: "outreach_enrolled", at: at(28), address: "100 Pine St, Seattle, WA" }];
  assert.equal(leadSourceOf({ offer, hooks, events: opener }).checkin, false, "the opener itself is not a check-in");
  const old = [{ type: "agent_pulse_texted", at: at(30 - CHECKIN_WINDOW_DAYS - 1) }];
  assert.equal(leadSourceOf({ offer, hooks, events: old }).checkin, false);
  const after = [{ type: "agent_pulse_texted", at: at(31) }];
  assert.equal(leadSourceOf({ offer, hooks, events: after }).checkin, false, "a text after the house can't have brought it");
});

test("an agent we never reached out to is a house we went after ourselves", () => {
  const offer = { contactId: "a9", address: "1 Vashon Hwy SW, Vashon, WA", createdAt: at(0) };
  assert.equal(leadSourceOf({ offer, hooks: [], events: [] }).source, "direct");
  assert.equal(leadSourceOf({ offer: { address: "x" } }).source, "unknown");
});

test("the whole book: grouped by contact, and the agents who bring houses ranked by committed buyers", () => {
  const hooks = [
    { contactId: "lee", address: "1 Turnkey Way, Snoqualmie, WA", importedAt: at(0) },
    { contactId: "sam", address: "2 Updated St, Spanaway, WA", importedAt: at(0) },
  ];
  const offers = [
    { id: "o1", contactId: "lee", contactName: "B", address: "3 Studs Up Rd, Issaquah, WA", createdAt: at(0.01), deal: { stage: "buyer_found" } },
    { id: "o2", contactId: "sam", contactName: "J", address: "4 South K St, Tacoma, WA", createdAt: at(29), deal: { stage: "buyer_found" } },
    { id: "o3", contactId: "sam", contactName: "J", address: "5 Yakima Ave, Tacoma, WA", createdAt: at(43), deal: { stage: "fell_through" } },
    { id: "o4", contactId: "sam", contactName: "J", address: "2 Updated St, Spanaway, WA", createdAt: at(1) },
  ];
  const leads = leadSourcesFor({ offers, hooks, events: [] });
  assert.deepEqual([...leads.values()].map((l) => l.source), ["agent_brought", "agent_brought", "agent_brought", "hook"]);
  const annotated = offers.map((o) => ({ ...o, leadSource: leads.get(o.id) }));
  const agents = sourceAgents(annotated);
  assert.deepEqual(agents.map((a) => [a.name, a.houses, a.contracts, a.buyers, a.firstHouseDays]), [["J", 2, 2, 1, 29], ["B", 1, 1, 1, 0]]);
});

test("their number works when it leaves our fee under what a buyer pays; it never decides anything", async () => {
  const { theirNumberCheck } = await import("./lead-source.js");
  assert.deepEqual(theirNumberCheck({ seller: 250000, ceiling: 329250 }), { seller: 250000, ceiling: 329250, room: 79250, fits: true });
  assert.equal(theirNumberCheck({ seller: 525000, ceiling: 525125 }).fits, false, "at the ceiling leaves no fee");
  assert.equal(theirNumberCheck({ seller: 0, ceiling: 500000 }), null, "no number from them, nothing to say");
  assert.equal(theirNumberCheck({ seller: 300000, ceiling: 0 }), null, "no ARV, no ceiling");
});

test("an agent who asks about finder fees, owns rentals or offers to represent us reads as investor-minded; small talk doesn't", async () => {
  const { investorMindedCue, ASSIGNMENT_RX } = await import("./lead-source.js");
  for (const said of ["Do you work with wholesalers or pay a finder's fee on homes?", "I can lower my list fee, I have a couple rentals myself", "Happy to represent you on it",
    "Do you assign contracts?", "I also flip houses on the side", "Would love to partner on a flip"]) assert.ok(investorMindedCue(said), said);
  for (const said of ["The seller is flexible", "It's a rental right now, tenant until November", "Thanks for the offer"]) assert.equal(investorMindedCue(said), "", said);
  assert.ok(ASSIGNMENT_RX.test("They got it at 200 and are selling the assignment at 215"));
  assert.ok(!ASSIGNMENT_RX.test("Seller is an estate, son is executor"));
});
