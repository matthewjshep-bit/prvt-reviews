// agent-pulse.test.mjs — every agent on a clock, and only one clock at a time.

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAgentPulse, evaluateAgent, pickPulseAgents, agentSegment, agentStops, agentOwner,
  freshListingFor, listingDistressed, agentPulseSubject, tierDrips, ourHouseFor, dealToThank,
} from "./agent-pulse.js";
import { normalizeConversationAi } from "./conversation-ai.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-01T19:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const CONFIG = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: {
  offer_nudge: { enabled: true, steps: [3, 7, 14], repeatEvery: 7 }, passed_checkin: { enabled: true, steps: [10, 20, 30] },
} } } } });
const S = normalizeAgentPulse({ enabled: true });
const ctx = (over = {}) => ({ settings: S, config: CONFIG, houses: { live: new Set(), walked: new Map() }, now: NOW, ...over });

const listing = (over = {}) => ({
  listingKey: "L1", firstSeen: ago(3), lastSeen: ago(1), distressRule: "cut-or-cheap",
  doc: { address: "123 Main St, Kent, WA 98031", city: "Kent", price: 489000, daysOnMarket: 71, propertyType: "Single Family",
    qualifies: true, score: 60, distress: { stale: true, cut: true, cheap: false } },
  ...over,
});
const agent = (over = {}) => ({ contactId: "a1", name: "Dana", tags: ["agent"], offers: [], current: [], drafts: [], events: [], ledger: [], listings: [], facts: {}, lastInboundAt: null, ...over });
const passed = (over = {}) => ({ id: "o1", contactId: "a1", address: "9 Oak St, Kent, WA 98031", cashAmount: 300000, status: "passed",
  statusAt: ago(40), createdAt: ago(60), statusHistory: [{ status: "passed", ts: ago(40) }], ...over });

test("the pulse ships off, with Matt's cadence as its defaults", () => {
  const s = normalizeAgentPulse({});
  assert.equal(s.enabled, false);
  assert.equal(s.autoSend, false);
  assert.equal(s.everyDays, 21);
  assert.equal(s.coldEveryDays, 60);
  assert.equal(s.coldMaxUnanswered, 3);
  assert.equal(normalizeAgentPulse({ dailyCap: 9000 }).dailyCap, 5000, "a typo can't ask for more than that");
});

test("an agent who ever replied is checked in on every 21 days", () => {
  const due = evaluateAgent(agent({ lastInboundAt: ago(30) }), ctx());
  assert.equal(due.status, "due");
  assert.equal(due.pulseReason, "general");
  assert.equal(due.segment, "engaged");
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(10) }), ctx()).status, "not_due", "we talked ten days ago");
  const touched = agent({ lastInboundAt: ago(60), events: [{ type: "follow_up_sent", at: ago(5) }] });
  assert.equal(evaluateAgent(touched, ctx()).status, "not_due", "we texted five days ago");
});

test("an agent another clock owns waits until that clock ends", () => {
  const open = passed({ status: "sent", statusHistory: [], sends: [{ ts: ago(2) }] });
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(60), offers: [open], current: [open] }), ctx()).status, "owned");
  // Passed 25 days ago: a passed house has no check-ins of its own any more
  // (2026-10-08), so nothing owns them — the pulse does.
  const recent = passed({ statusAt: ago(25), statusHistory: [{ status: "passed", ts: ago(25) }] });
  const owned = evaluateAgent(agent({ lastInboundAt: ago(60), offers: [recent], current: [recent] }), ctx());
  assert.notEqual(owned.status, "owned", owned.reason);
  // Passed 40 days ago, every rung sent: the pulse picks them up, about that house.
  const done = passed({ followUps: [10, 20, 30].map((d) => ({ kind: "passed_checkin", step: d, at: ago(40 - d) })) });
  const v = evaluateAgent(agent({ lastInboundAt: ago(60), offers: [done], current: [done], events: [{ type: "follow_up_sent", at: ago(22) }] }), ctx());
  assert.equal(v.status, "due", v.reason);
  assert.equal(v.pulseReason, "our_house");
  assert.equal(v.house.id, "o1");
});

test("a text waiting in the outbox, a promise, a check-in they asked for and the outreach workflow each own the agent", () => {
  const held = agent({ lastInboundAt: ago(60), drafts: [{ id: "d", status: "draft", inbound: "any update?", createdAt: ago(1) }] });
  assert.equal(evaluateAgent(held, ctx()).reason, "their text is waiting on you");
  const promised = agent({ lastInboundAt: ago(60), events: [{ type: "promise_made", at: ago(1) }] });
  assert.equal(evaluateAgent(promised, ctx()).reason, "a promise we made");
  const asked = agent({ lastInboundAt: ago(60), events: [{ type: "checkin_requested", at: ago(3), data: { dueAt: ago(-4) } }] });
  assert.equal(evaluateAgent(asked, ctx()).reason, "a check-in they asked for");
  const enrolled = agent({ events: [{ type: "outreach_enrolled", at: ago(5), data: { kind: "first" } }] });
  assert.equal(evaluateAgent(enrolled, ctx()).reason, "the outreach workflow");
  const followed = agent({ events: [{ type: "outreach_enrolled", at: ago(30), data: { kind: "first" } }, { type: "outreach_enrolled", at: ago(10), data: { kind: "followup" } }] });
  assert.equal(evaluateAgent(followed, ctx()).reason, "the outreach follow-up workflow");
  const gone = agent({ events: [{ type: "outreach_enrolled", at: ago(60), data: { kind: "first" } }, { type: "outreach_enrolled", at: ago(40), data: { kind: "followup" } }] });
  assert.notEqual(evaluateAgent(gone, ctx()).status, "owned", "the workflows are done with them");
});

test("a fresh distressed listing is raised once, before 21 days, never within a week of a touch", () => {
  const a = agent({ lastInboundAt: ago(60), events: [{ type: "follow_up_sent", at: ago(10) }], listings: [listing()] });
  const v = evaluateAgent(a, ctx());
  assert.equal(v.status, "due");
  assert.equal(v.pulseReason, "fresh_listing", "ten days in: the listing is the reason, and it won't wait");
  assert.equal(evaluateAgent({ ...a, events: [{ type: "follow_up_sent", at: ago(3) }] }, ctx()).status, "not_due", "never within a week");
  const pinged = { ...a, ledger: [{ type: "listing_pinged", at: ago(20), data: { listingKey: "L1" } }] };
  assert.notEqual(evaluateAgent(pinged, ctx()).pulseReason, "fresh_listing", "a listing is raised once");
  const voided = { ...a, ledger: [{ type: "listing_pinged", at: ago(20), data: { listingKey: "L1" } }, { type: "listing_ping_voided", at: ago(20), data: { listingKey: "L1" } }] };
  assert.equal(evaluateAgent(voided, ctx()).pulseReason, "fresh_listing", "a ping that never went gives the listing back");
});

test("a listing counts only when the pull found it distressed, still up, and new to us", () => {
  assert.equal(listingDistressed({ qualifies: true, distress: { stale: true } }, "cut-or-cheap"), false, "stale alone isn't cut-or-cheap");
  assert.equal(listingDistressed({ qualifies: true, distress: { cheap: true } }, "cut-or-cheap"), true);
  assert.equal(listingDistressed({ qualifies: false, distress: { cut: true } }, null), false);
  assert.equal(listingDistressed({ qualifies: true, yearBuilt: 2015, distress: { stale: true, cheap: true } }, "cut-or-old"), false, "a cheap finished house isn't cut-or-old");
  assert.equal(listingDistressed({ qualifies: true, yearBuilt: 1962, distress: { stale: true } }, "cut-or-old"), true, "an older house is");
  assert.equal(freshListingFor({ listings: [listing({ firstSeen: ago(30) })], settings: S, now: NOW }), null, "first seen a month ago isn't fresh");
  assert.equal(freshListingFor({ listings: [listing({ lastSeen: ago(45) })], settings: S, now: NOW }), null, "not seen on a pull lately — likely gone");
});

test("a house we walked from is never raised; its agent still hears from us", () => {
  const a = agent({ lastInboundAt: ago(60), listings: [listing()] });
  const walked = evaluateAgent(a, ctx({ houses: { live: new Set(), walked: new Map([[freshKey(listing()), ago(20)]]) } }));
  assert.equal(walked.status, "due");
  assert.equal(walked.pulseReason, "general", "not the house we walked from — the agent is still worth a text");
  const live = evaluateAgent(a, ctx({ houses: { live: new Set([freshKey(listing())]), walked: new Map() } }));
  assert.equal(live.pulseReason, "general", "a house we already have a live offer on is that offer's business");
});

test("a cold agent hears only about a new listing, 60 days apart, and never after three unanswered", () => {
  const cold = agent({ events: [{ type: "outreach_enrolled", at: ago(90), data: { kind: "first" } }, { type: "outreach_enrolled", at: ago(70), data: { kind: "followup" } }] });
  assert.equal(evaluateAgent(cold, ctx()).status, "not_due", "no listing, no reason");
  const withListing = { ...cold, listings: [listing()] };
  const v = evaluateAgent(withListing, ctx());
  assert.equal(v.status, "due");
  assert.equal(v.segment, "cold");
  assert.equal(v.pulseReason, "fresh_listing");
  const recentPing = { ...withListing, ledger: [{ type: "agent_pulse_texted", at: ago(30) }] };
  assert.equal(evaluateAgent(recentPing, ctx()).status, "not_due", "sixty days between cold pings");
  const three = { ...withListing, ledger: [ago(200), ago(130), ago(65)].map((at) => ({ type: "agent_pulse_texted", at })) };
  assert.equal(evaluateAgent(three, ctx()).status, "cold_dropped");
});

test("an engaged agent long into silence falls back to listings only", () => {
  const quiet = agent({ lastInboundAt: ago(300), ledger: [120, 99, 78, 57, 36, 22].map((d) => ({ type: "agent_pulse_texted", at: ago(d) })) });
  const v = evaluateAgent(quiet, ctx());
  assert.equal(v.status, "not_due");
  assert.match(v.segment, /gone quiet/);
  assert.equal(evaluateAgent(quiet, ctx({ settings: normalizeAgentPulse({ enabled: true, engagedMaxUnanswered: 0 }) })).status, "due", "0 turns the fallback off");
});

test("opted out, stopped, annoyed or tagged off: the pulse stays away", () => {
  assert.equal(agentStops({ events: [{ type: "unsubscribed", at: ago(3) }] }), "they opted out");
  assert.equal(agentStops({ tags: ["agent", "stop bot"], botOffTags: ["stop bot"] }), 'tagged "stop bot"');
  assert.equal(agentStops({ tags: ["DNC"] }), 'tagged "DNC"');
  assert.equal(agentStops({ events: [{ type: "drive_stopped", at: ago(2) }] }), "you stopped the thread");
  assert.equal(agentStops({ events: [{ type: "drive_stopped", at: ago(2), offerId: "o9" }] }), null, "a stop on one house is that house's");
  const pause = { type: "drive_stopped", at: ago(2), data: { until: new Date(NOW + 5 * DAY).toISOString() } };
  assert.equal(agentStops({ events: [pause], now: NOW }), "you paused the thread", "a paused agent gets no check-in");
  assert.equal(agentStops({ events: [pause], now: NOW + 6 * DAY }), null, "until the pause ends");
  assert.equal(agentStops({ events: [{ type: "text_summary", at: ago(9), data: { inbound: "please stop texting me" } }] }), "they sound annoyed");
  assert.equal(agentStops({ events: [{ type: "text_summary", at: ago(9), data: { inbound: "that one sold, sorry" } }] }), null, "a house that sold is not the agent");
});

test("partners come first, then engaged agents, then cold listings — and the day's seats bind", () => {
  const partnerOffer = passed({ id: "p1", contactId: "p", deal: { stage: "closed" } });
  const agents = [
    agent({ contactId: "cold1", events: [{ type: "outreach_enrolled", at: ago(90), data: { kind: "first" } }, { type: "outreach_enrolled", at: ago(70), data: { kind: "followup" } }], listings: [listing({ listingKey: "C" })] }),
    agent({ contactId: "eng1", lastInboundAt: ago(40) }),
    agent({ contactId: "eng2", lastInboundAt: ago(90) }),
    agent({ contactId: "p", lastInboundAt: ago(50), offers: [partnerOffer], current: [partnerOffer] }),
    agent({ contactId: "eng3", lastInboundAt: ago(60), listings: [listing({ listingKey: "E" })], events: [{ type: "follow_up_sent", at: ago(12) }] }),
  ];
  const { picks, counts } = pickPulseAgents({ agents, settings: S, config: CONFIG, houses: { live: new Set(), walked: new Map() }, seats: 4, now: NOW });
  assert.deepEqual(picks.map((p) => p.contactId), ["eng3", "p", "eng2", "eng1"]);
  assert.equal(counts.dueNoSeat, 1, "the cold listing waits for a seat");
  assert.equal(counts.bySegment.partner, 1);
  assert.equal(picks.find((p) => p.contactId === "p").subject.house.how, "closed");
});

// Matt, 2026-10-05: 307 agents were due a check-in and 40 seats a day held
// them back — "there should be no caps".
test("with the day's cap at 0 there is no cap: every agent due a check-in gets one today", () => {
  assert.equal(normalizeAgentPulse({ dailyCap: 0 }).dailyCap, 0, "0 is kept, not bumped to 1");
  const agents = [
    agent({ contactId: "cold1", events: [{ type: "outreach_enrolled", at: ago(90), data: { kind: "first" } }, { type: "outreach_enrolled", at: ago(70), data: { kind: "followup" } }], listings: [listing({ listingKey: "C" })] }),
    agent({ contactId: "eng1", lastInboundAt: ago(40) }),
    agent({ contactId: "eng2", lastInboundAt: ago(90) }),
    agent({ contactId: "eng3", lastInboundAt: ago(60), listings: [listing({ listingKey: "E" })], events: [{ type: "follow_up_sent", at: ago(12) }] }),
  ];
  const open = normalizeAgentPulse({ enabled: true, dailyCap: 0 });
  const houses = { live: new Set(), walked: new Map() };
  const r = pickPulseAgents({ agents, settings: open, config: CONFIG, houses, now: NOW });
  assert.equal(r.picks.length, 4);
  assert.equal(r.counts.dueNoSeat, 0);
  assert.deepEqual(r.spares, []);
  // The runner hands in unlimited seats the same way.
  assert.equal(pickPulseAgents({ agents, settings: open, config: CONFIG, houses, seats: Infinity, now: NOW }).picks.length, 4);
});

test("the text's material never carries a price", () => {
  const v = evaluateAgent(agent({ lastInboundAt: ago(60), listings: [listing()] }), ctx());
  const subj = agentPulseSubject({ agent: agent({ facts: { last_convo_summary: [{ value: "talked about a Kent fixer", at: ago(60) }] } }), verdict: v });
  assert.equal(subj.listing.street, "123 Main St");
  assert.equal(subj.listing.cut, true);
  assert.doesNotMatch(JSON.stringify(subj), /489/, "no list price anywhere");
  assert.equal(subj.lastSummary, "talked about a Kent fixer");
});

test("segments: a deal or a yes is a partner, a reply is engaged, silence is cold", () => {
  assert.equal(agentSegment({ offers: [{ realm: { answer: "yes" } }] }), "partner");
  assert.equal(agentSegment({ offers: [], lastInboundAt: ago(3) }), "engaged");
  assert.equal(agentSegment({}), "cold");
  assert.equal(agentOwner({ offers: [{ id: "x", status: "draft", createdAt: ago(3) }], now: NOW }), "a held underwrite");
});

import { addressKey as freshAddressKey } from "./us-address.js";
function freshKey(l) { return freshAddressKey(l.doc.address); }

/* ---------- the check-in replaces the TIER 2/3 drips (2026-09-30) ---------- */

// The live playbook's tier rules, as Matt pasted them: a "no" and the catch-all
// go to TIER 3, "open to investors" to TIER 2, a deal to TIER 1.
const TIER_CAI = normalizeConversationAi({ enabled: true, parties: { agent: {
  intentRules: {
    deal_available: { mode: "auto", actions: [{ type: "add_to_workflow", workflowId: "wf-t1", workflowName: "TIER 1" }, { type: "remove_from_workflow", workflowId: "wf-t2", workflowName: "TIER 2" }] },
    investor_open: { mode: "auto", actions: [{ type: "add_tags", tags: ["tier-2"] }, { type: "add_to_workflow", workflowId: "wf-t2", workflowName: "TIER 2" }] },
    rejection: { mode: "auto", actions: [{ type: "add_tags", tags: ["tier-3"] }, { type: "add_to_workflow", workflowId: "wf-t3", workflowName: "TIER 3" }] },
  },
  fallback: { mode: "auto", actions: [{ type: "add_to_workflow", workflowId: "wf-t3", workflowName: "TIER 3" }] },
} } });

// Matt's screenshot, 2026-09-30: the check-in texts come from a separate GHL
// workflow, "Tier 2+3 nurture", which GHL starts when an agent's card moves to
// Tier 2 or Tier 3. TIER 2/3 themselves (the ones the bot enrolls agents in)
// move the card, and must keep running.
const WORKFLOWS = [
  { id: "wf-t2", name: "TIER 2", status: "published" }, { id: "wf-t3", name: "TIER 3", status: "published" },
  { id: "wf-n", name: "Tier 2+3 nurture", status: "published" }, { id: "wf-nn", name: "Not Now Nurture", status: "published" },
  { id: "wf-d", name: "Tier 2 Disposition", status: "published" }, { id: "wf-old", name: "Old tier nurture", status: "draft" },
];

test("the check-in replaces the tier nurture drip, never the TIER workflows that move the card; a list set by hand wins", () => {
  assert.deepEqual(tierDrips({ pulse: {}, conversationAi: TIER_CAI, workflows: WORKFLOWS }), [{ id: "wf-n", name: "Tier 2+3 nurture" }]);
  assert.deepEqual(tierDrips({ pulse: { replacesWorkflowIds: "wf-nn, wf-n" }, workflows: WORKFLOWS }),
    [{ id: "wf-nn", name: "Not Now Nurture" }, { id: "wf-n", name: "Tier 2+3 nurture" }]);
  assert.deepEqual(tierDrips({ pulse: { replacesWorkflowIds: ["wf-x"] } }), [{ id: "wf-x", name: "" }]);
  assert.deepEqual(tierDrips({ pulse: {}, conversationAi: TIER_CAI }), [], "without GHL's workflow list it guesses nothing");
});

test("once the check-in replaces the drips, an agent the bot put in TIER 3 is the check-in's, not the drip's", () => {
  const inTier = agent({ lastInboundAt: ago(60), events: [{ type: "workflow_enrolled", at: ago(5), data: { workflowId: "wf-t3", workflowName: "TIER 3" } }] });
  assert.equal(evaluateAgent(inTier, ctx()).reason, "a GHL workflow (TIER 3)", "a drip nobody replaced still has them");
  const replacing = normalizeAgentPulse({ enabled: true, replacesWorkflowIds: ["wf-t3"] });
  assert.equal(evaluateAgent(inTier, ctx({ settings: replacing })).status, "due");
});

test("the check-in carries what it can mention: the last house, the areas they work, and what they've told us, each dated", () => {
  const a = agent({
    lastInboundAt: ago(30),
    offers: [passed({ address: "9 Oak St, Kent, WA 98031", statusAt: ago(35) }), passed({ id: "o0", address: "4 Elm St, Kent, WA 98031", statusAt: ago(90), createdAt: ago(100) })],
    facts: {
      personal_details: [{ value: "back from Maui", at: ago(200) }, { value: "daughter just started at UW", at: ago(40) }],
      agent_market_area: [{ value: "South King", at: ago(90) }],
      last_convo_summary: [{ value: "said a Burien fixer might list after the holidays", at: ago(30) }],
    },
  });
  const subj = agentPulseSubject({ agent: a, verdict: { pulseReason: "general", segment: "engaged" }, now: NOW });
  assert.deepEqual(subj.lastHouse, { street: "9 Oak St", how: "passed", daysAgo: 35 });
  assert.deepEqual(subj.aboutThem, [{ what: "daughter just started at UW", daysAgo: 40 }, { what: "back from Maui", daysAgo: 200 }]);
  assert.deepEqual(subj.areas, ["South King"]);
  assert.equal(subj.lastSummary, "said a Burien fixer might list after the holidays");
  assert.doesNotMatch(JSON.stringify(subj), /300000|300k/i, "never a price");
});

test("Matt's notes on how the check-in should sound are kept, trimmed and capped", () => {
  assert.equal(normalizeAgentPulse({}).voice, "");
  assert.equal(normalizeAgentPulse({ voice: "  Keep it short. Sign off -Matt.  " }).voice, "Keep it short. Sign off -Matt.");
  assert.equal(normalizeAgentPulse({ voice: "x".repeat(900) }).voice.length, 600);
  assert.deepEqual(normalizeAgentPulse({ replacesWorkflowIds: "a, b\nc" }).replacesWorkflowIds, ["a", "b", "c"]);
});

// 2026-09-30, the first samples: Brenton's "new listing" was 719 S Sprague
// Ave — the listing our outreach workflow's first text had asked him about
// nine days before. A listing the opener already raised isn't news.
test("a listing the outreach opener already asked them about isn't raised again as new", () => {
  // They answered the opener (so the app took them out of its workflow) and
  // went quiet: the check-in has them, but not about the same listing.
  const replied = (address, type = "outreach_enrolled") => [
    { type, at: ago(30), address, ...(type === "outreach_enrolled" ? { data: { kind: "first" } } : {}) },
    { type: "outreach_left", at: ago(29) },
  ];
  const opened = agent({ lastInboundAt: ago(29), listings: [listing()], events: replied("123 Main St, Kent, WA 98031") });
  const v = evaluateAgent(opened, ctx());
  assert.equal(v.status, "due", JSON.stringify(v));
  assert.notEqual(v.pulseReason, "fresh_listing");
  const byApp = agent({ lastInboundAt: ago(29), listings: [listing()], events: replied("123 Main Street, Kent, WA", "outreach_sent") });
  assert.notEqual(evaluateAgent(byApp, ctx()).pulseReason, "fresh_listing", "the app's own opener counts too, however it spelled the street");
  const other = agent({ lastInboundAt: ago(29), listings: [listing()], events: replied("9 Oak St, Kent, WA 98031") });
  assert.equal(evaluateAgent(other, ctx()).pulseReason, "fresh_listing", "a different listing is still news");
});

// 2026-09-30, the second samples: one of three picks was unsubscribed in GHL.
// The runner finds that out only when it reads the contact, before the claim;
// the next agents in line wait as spares so the day's seat isn't wasted.
test("the next agents due wait as spares beyond the day's seats", () => {
  const due = ["ag-a", "ag-b", "ag-c"].map((id) => agent({ contactId: id, lastInboundAt: ago(60) }));
  const r = pickPulseAgents({ agents: due, settings: S, config: CONFIG, houses: { live: new Set(), walked: new Map() }, seats: 1, now: NOW });
  assert.deepEqual(r.picks.map((p) => p.contactId), ["ag-a"]);
  assert.deepEqual(r.spares.map((p) => p.contactId), ["ag-b", "ag-c"]);
  assert.equal(r.spares[0].subject.reason, "general");
});

test("checking in less doubles the three weeks; checking in more halves it but never goes inside the quiet days", () => {
  const pace = (p) => ({ type: "cadence_set", at: ago(40), data: { pace: p } });
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(30) }), ctx()).status, "due", "normal: 21 days");
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(30), events: [pace("less")] }), ctx()).status, "not_due", "less: 42 days");
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(43), events: [pace("less")] }), ctx()).status, "due");
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(12), events: [pace("more")] }), ctx()).status, "due", "more: 11 days");
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(12) }), ctx()).status, "not_due");
  // A listing of theirs is a reason after the quiet days — which "more" never shortens.
  const fresh = agent({ lastInboundAt: ago(5), listings: [listing()], events: [pace("more")] });
  assert.notEqual(evaluateAgent(fresh, ctx()).pulseReason, "fresh_listing", "five days is inside the seven quiet days");
});

// 5232 S Yakima (2026-10-03): no check-in leans on a deal that fell through.
test("a pulse never checks in about a house whose deal fell through; a closed one still counts", () => {
  const fell = { id: "o1", address: "5232 South Yakima Avenue, Tacoma, WA", status: "accepted", statusAt: new Date(NOW - 2 * DAY).toISOString(), deal: { stage: "fell_through" } };
  const closed = { id: "o2", address: "12 Elm St, Renton, WA", status: "accepted", statusAt: new Date(NOW - 30 * DAY).toISOString(), deal: { stage: "closed" } };
  assert.equal(ourHouseFor({ offers: [fell], now: NOW }), null);
  assert.equal(ourHouseFor({ offers: [fell, closed], now: NOW })?.id, "o2");
});

// Matt, 2026-10-07: a pass from Tier 1 starts the nurture — "any other
// distressed off-market deals?" — and never brings the passed house back up.
test("the check-in's notes never name a house we passed on, and say which to avoid", () => {
  const a = agent({
    lastInboundAt: ago(30),
    offers: [passed({ id: "o2", address: "12 Pine St, Kent, WA 98031", status: "we_passed", statusAt: ago(5) }), passed({ address: "9 Oak St, Kent, WA 98031", statusAt: ago(35) })],
    events: [{ type: "tier1_passed", address: "88 Elm St, Tacoma, WA 98405", at: ago(3) }],
  });
  const subj = agentPulseSubject({ agent: a, verdict: { pulseReason: "general", segment: "engaged" }, now: NOW });
  assert.equal(subj.lastHouse.street, "9 Oak St", "the newest house we didn't pass on");
  assert.deepEqual(subj.avoid.sort(), ["12 Pine St", "88 Elm St"]);
});

test("an agent who brought us a house we never texted about is a source: checked in on first, and never dropped for going quiet", () => {
  const brought = { id: "o1", contactId: "a1", address: "9 Oak Ave, Tacoma, WA", status: "we_passed", leadSource: { source: "agent_brought" } };
  assert.equal(agentSegment({ offers: [brought] }), "source");
  assert.equal(agentSegment({ offers: [{ ...brought, leadSource: null, autoUnderwrite: { leadSource: "agent_brought" } }] }), "source", "stamped at underwrite counts too");
  assert.equal(agentSegment({ offers: [{ ...brought, leadSource: { source: "hook" } }], lastInboundAt: "2026-09-01T00:00:00Z" }), "engaged", "the listing we opened with is not theirs");
  assert.equal(agentSegment({ offers: [{ ...brought, deal: { stage: "closed" } }] }), "partner", "a deal still makes a partner");
});

test("a source agent who goes quiet is still checked in on, first in line", () => {
  const brought = passed({ leadSource: { source: "agent_brought" } });
  const quiet = agent({ lastInboundAt: ago(300), offers: [brought], current: [brought], ledger: [120, 99, 78, 57, 36, 22].map((d) => ({ type: "agent_pulse_texted", at: ago(d) })) });
  const v = evaluateAgent(quiet, ctx());
  assert.equal(v.segment, "source");
  assert.equal(v.status, "due");
  assert.equal(v.priority[0], 2, "ranked with partners (2 + tier 0)");
});

test("an agent whose deal just closed is thanked and asked for the next one — unless someone already texted them since the close", () => {
  const closed = passed({ id: "v1", address: "21904 Vashon Hwy SW, Vashon, WA 98070", status: "accepted",
    deal: { stage: "closed", stageHistory: [{ stage: "under_contract", ts: ago(30) }, { stage: "closed", ts: ago(5) }] } });
  const a = agent({ lastInboundAt: ago(5), offers: [closed], current: [closed] });
  const v = evaluateAgent(a, ctx());
  assert.equal(v.status, "due");
  assert.equal(v.pulseReason, "deal_thanks");
  assert.equal(v.house.id, "v1");
  assert.equal(v.priority[0], -1, "ahead of everything else today");

  const byHand = { ...a, events: [{ type: "hand_reply", at: ago(4) }] };
  assert.equal(dealToThank({ offers: [closed], events: byHand.events, now: NOW }), null, "your own thank-you is the thank-you");
  const already = [{ type: "agent_pulse_sent", at: ago(3), address: closed.address, data: { reason: "deal_thanks" } }];
  assert.equal(dealToThank({ offers: [closed], ledger: already, now: NOW }), null, "once per deal");
  assert.equal(dealToThank({ offers: [{ ...closed, deal: { stage: "closed", stageHistory: [{ stage: "closed", ts: ago(1) }] } }], now: NOW }), null, "a day for the close to settle");
  assert.equal(dealToThank({ offers: [{ ...closed, deal: { stage: "closed", stageHistory: [{ stage: "closed", ts: ago(45) }] } }], now: NOW }), null, "a month on, it's an ordinary check-in");
  assert.equal(dealToThank({ offers: [{ ...closed, deal: { stage: "fell_through", stageHistory: [{ stage: "fell_through", ts: ago(5) }] } }], now: NOW }), null);
  assert.equal(normalizeAgentPulse({ autoSend: true }).thanksAutoSend, false, "the thank-you stays a draft unless you say so");
});
