// agent-pulse.test.mjs — every agent on a clock, and only one clock at a time.

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAgentPulse, evaluateAgent, pickPulseAgents, agentSegment, agentStops, agentOwner,
  freshListingFor, listingDistressed, agentPulseSubject, tierDrips, ourHouseFor, dealToThank, openOfferIdle, tierCard,
  firstCheckInAt, classifyReplierThread, checkInHook, mentionedHouseFor, recentCloses, pickMattsFifteen,
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

const leadIn = (dueInDays, at = ago(60)) => ({ type: "checkin_requested", at,
  data: { kind: "lead", dueAt: ago(-dueInDays), phrase: "for about a year", lead: { what: "the fixer", said: "May have a fixer but not for about a year" } } });

test("an agent whose fixer is a year out still gets the regular check-in in the meantime", () => {
  const a = agent({ lastInboundAt: ago(60), events: [leadIn(300), { type: "text_summary", at: ago(60) }] });
  const v = evaluateAgent(a, ctx());
  assert.equal(v.status, "due", v.reason);
  // And it stays generic: nothing about the far-off fixer rides on it.
  assert.equal(v.pulseReason, "general");
  assert.doesNotMatch(JSON.stringify(agentPulseSubject({ agent: a, verdict: v, now: NOW })), /about a year|the fixer/);
});

test("the regular check-in steps aside the week the lead comes due", () => {
  const v = evaluateAgent(agent({ lastInboundAt: ago(60), events: [leadIn(5), { type: "text_summary", at: ago(60) }] }), ctx());
  assert.equal(v.status, "owned");
  assert.equal(v.reason, "a lead they told us about");
  // Asked about on its day: the regular check-in has them again.
  const lead = leadIn(-2);
  const asked = agent({ lastInboundAt: ago(60), events: [lead, { type: "checkin_sent", at: ago(2), data: { requestAt: lead.at, kind: "lead" } }] });
  assert.notEqual(evaluateAgent(asked, ctx()).reason, "a lead they told us about");
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

// 2026-10-21: an agent who'd answered a check-in got another on 10/14, then
// on 10/21 "saw your listing on … Is it a bit of a project?" because a
// listing of theirs showed up, and opted out. Matt: "we just
// need to check in with her and not flag that specific address", and never
// two check-ins close together.
test("an agent we checked in with a week ago isn't texted again because a listing of theirs showed up", () => {
  const checkedIn = (d) => [{ type: "agent_pulse_sent", at: ago(d), dedupeKey: `k${d}` }, { type: "agent_pulse_texted", at: ago(d) }];
  const a = agent({ lastInboundAt: ago(23), ledger: checkedIn(7), listings: [listing()] });
  const v = evaluateAgent(a, ctx());
  assert.equal(v.status, "not_due", "a week after the last check-in");
  assert.match(v.reason, /within 21 days/);
  const later = evaluateAgent({ ...a, ledger: checkedIn(22) }, ctx());
  assert.equal(later.status, "due", "three weeks on, the regular check-in");
  assert.equal(later.pulseReason, "fresh_listing", "and it names the listing in passing");
  assert.equal(later.listing.listingKey, "L1");
  const pinged = { ...a, ledger: [...checkedIn(22), { type: "listing_pinged", at: ago(22), data: { listingKey: "L1" } }] };
  assert.equal(evaluateAgent(pinged, ctx()).pulseReason, "general", "a listing is named once");
  const voided = { ...a, ledger: [...checkedIn(22), { type: "listing_pinged", at: ago(22), data: { listingKey: "L1" } }, { type: "listing_ping_voided", at: ago(22), data: { listingKey: "L1" } }] };
  assert.equal(evaluateAgent(voided, ctx()).pulseReason, "fresh_listing", "a ping that never went gives the listing back");
});

test("a cold agent's new listing waits two weeks after any text of ours", () => {
  const cold = (d) => agent({ events: [{ type: "outreach_sent", at: ago(d), address: "9 Oak St, Kent, WA 98031" }], listings: [listing()] });
  const soon = evaluateAgent(cold(10), ctx());
  assert.equal(soon.status, "not_due", "ten days after our first text");
  assert.match(soon.reason, /touched within 14 days/);
  const v = evaluateAgent(cold(15), ctx());
  assert.equal(v.status, "due");
  assert.equal(v.pulseReason, "fresh_listing");
});

test("a listing counts only when the pull found it distressed, still up, and new to us", () => {
  assert.equal(listingDistressed({ qualifies: true, distress: { stale: true } }, "cut-or-cheap"), false, "stale alone isn't cut-or-cheap");
  assert.equal(listingDistressed({ qualifies: true, distress: { cheap: true } }, "cut-or-cheap"), true);
  assert.equal(listingDistressed({ qualifies: true, yearBuilt: 1995, distress: { stale: true } }, "cut-old-or-stale"), true, "Pierce: sitting counts");
  assert.equal(listingDistressed({ qualifies: true, yearBuilt: 1962, distress: {} }, "cut-old-or-stale"), true);
  assert.equal(listingDistressed({ qualifies: true, yearBuilt: 1995, distress: { stale: true } }, "cut-or-old"), false);
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

test("a cold agent can hear about a new listing of theirs every 21 days when Matt sets it", () => {
  const s21 = normalizeAgentPulse({ enabled: true, coldEveryDays: 21 });
  assert.equal(s21.coldEveryDays, 21);
  assert.equal(normalizeAgentPulse({ coldEveryDays: 3 }).coldEveryDays, 14, "never closer than the two-week check-in gap");
  const cold = agent({ events: [{ type: "outreach_enrolled", at: ago(90), data: { kind: "first" } }], listings: [listing()] });
  assert.equal(evaluateAgent({ ...cold, ledger: [{ type: "agent_pulse_texted", at: ago(22) }] }, ctx({ settings: s21 })).status, "due", "22 days after the last ping");
  assert.equal(evaluateAgent({ ...cold, ledger: [{ type: "agent_pulse_texted", at: ago(18) }] }, ctx({ settings: s21 })).status, "not_due", "18 days is too soon");
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
    agent({ contactId: "eng3", lastInboundAt: ago(60), listings: [listing({ listingKey: "E" })], events: [{ type: "follow_up_sent", at: ago(25) }] }),
  ];
  const { picks, counts } = pickPulseAgents({ agents, settings: S, config: CONFIG, houses: { live: new Set(), walked: new Map() }, seats: 4, now: NOW });
  assert.deepEqual(picks.map((p) => p.contactId), ["p", "eng2", "eng1", "eng3"], "a listing doesn't jump the line: most overdue first");
  assert.equal(picks.find((p) => p.contactId === "eng3").reason, "fresh_listing");
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
    agent({ contactId: "eng3", lastInboundAt: ago(60), listings: [listing({ listingKey: "E" })], events: [{ type: "follow_up_sent", at: ago(25) }] }),
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

test("once the check-in replaces the drips, an agent in one is the check-in's, not the drip's", () => {
  const inDrip = agent({ lastInboundAt: ago(60), events: [{ type: "workflow_enrolled", at: ago(5), data: { workflowId: "wf-n", workflowName: "Tier 2+3 nurture" } }] });
  assert.equal(evaluateAgent(inDrip, ctx()).reason, "a GHL workflow (Tier 2+3 nurture)", "a drip nobody replaced still has them");
  const replacing = normalizeAgentPulse({ enabled: true, replacesWorkflowIds: ["wf-n"] });
  assert.equal(evaluateAgent(inDrip, ctx({ settings: replacing })).status, "due");
});

test("an agent the bot put in TIER 1, 2 or 3 still gets the check-in, because those workflows only move the card", () => {
  for (const name of ["TIER 1", "TIER 2", "TIER 3", "tier 2"]) {
    const inTier = agent({ lastInboundAt: ago(60), events: [{ type: "workflow_enrolled", at: ago(5), data: { workflowId: `wf-${name}`, workflowName: name } }] });
    const v = evaluateAgent(inTier, ctx());
    assert.equal(v.status, "due", `${name}: ${v.reason}`);
  }
});

test("an agent who said no to an open offer and never gave a number gets the check-in instead of silence", () => {
  // The first no keeps the offer open and asks what the seller would take.
  // They never answered; the nudges stand down on a no. Before 2026-10-09
  // "an open offer" held the agent for good with nothing coming.
  const floated = { id: "o-no", contactId: "a1", address: "2553 Mackenzie Rd, Bellingham, WA 98226", cashAmount: 338000, status: "new",
    createdAt: ago(25), statusHistory: [], floatSentAt: ago(25), proactive: { realmCheckAt: ago(25) }, declinedOnce: { at: ago(24) } };
  const drafts = [
    { id: "d-float", status: "sent", outbound: { kind: "realm_check", offerId: "o-no" }, reply: "float", createdAt: ago(25), sentAt: ago(25) },
    { id: "d-no", status: "sent", inbound: "Seller won't go that low, thanks", intent: "rejection", reply: "What would they take?", createdAt: ago(24), sentAt: ago(24) },
  ];
  const v = evaluateAgent(agent({ lastInboundAt: ago(24), offers: [floated], current: [floated], drafts }), ctx());
  assert.notEqual(v.status, "owned", v.reason);
  assert.equal(v.status, "due", v.reason);
  assert.match(openOfferIdle({ offer: floated, drafts, config: CONFIG, now: NOW }) || "", /stands down/);
  // A live nudge on it still keeps the agent with the offer.
  const sent = { ...floated, id: "o-live", status: "sent", declinedOnce: null, sends: [{ ts: ago(2) }] };
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(60), offers: [sent], current: [sent] }), ctx()).reason, "an open offer");
});

// Matt, 2026-10-16: an agent texted our 377K in a plain reply said "that
// won't work", never gave a number, and heard nothing for two weeks — the
// offer still read "new", its clock said a nudge was coming, and "an open
// offer" held him from the check-in. Whatever the clock says, an open offer
// with no word either way for two weeks lets the agent go.
test("an agent with an open offer and no word either way for two weeks gets the check-in, whatever the offer's clock says", () => {
  const texted = { id: "o-quiet", contactId: "a1", address: "88 Quarry Rd, Granite Falls, WA 98252", cashAmount: 377000, status: "new",
    createdAt: ago(16), statusHistory: [], floatSentAt: ago(15) };
  const drafts = [
    { id: "d-num", status: "sent", inbound: "He would", intent: "question", reply: "We can likely do around 377Kish, in the realm?", createdAt: ago(15), sentAt: ago(15) },
    { id: "d-no", status: "sent", inbound: "That won't work", intent: "rejection", reply: "Any number he'd actually take?", createdAt: ago(15), sentAt: ago(15) },
  ];
  const v = evaluateAgent(agent({ lastInboundAt: ago(15), offers: [texted], current: [texted], drafts }), ctx());
  assert.notEqual(v.status, "owned", v.reason);
  assert.match(openOfferIdle({ offer: texted, drafts, config: CONFIG, lastInboundAt: ago(15), now: NOW }) || "", /hasn.t gone in 14 days|stands down/);
  // Ten days in, the offer still has them.
  const recent = drafts.map((d) => ({ ...d, createdAt: ago(10), sentAt: ago(10) }));
  const tenDays = { ...texted, createdAt: ago(11), floatSentAt: ago(10) };
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(10), offers: [tenDays], current: [tenDays], drafts: recent }), ctx()).reason, "an open offer");
});

test("an agent whose priced offer we never sent gets the check-in once the number has sat a week", () => {
  const unsent = { id: "o-unsent", contactId: "a1", address: "2227 Sidney Ave, Port Orchard, WA 98366", cashAmount: 300600, status: "new", createdAt: ago(50), statusHistory: [] };
  const v = evaluateAgent(agent({ lastInboundAt: ago(60), offers: [unsent], current: [unsent] }), ctx());
  assert.equal(v.status, "due", v.reason);
  const fresh = { ...unsent, createdAt: ago(3) };
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(60), offers: [fresh], current: [fresh] }), ctx()).reason, "an open offer", "this week it's still yours to send");
});

test("an agent whose offer shows their answer is not cold, even with no text of theirs on the timeline", () => {
  assert.equal(agentSegment({ offers: [passed()] }), "engaged");
  assert.equal(agentSegment({ offers: [passed({ status: "countered", counter: { amount: 350000 } })] }), "engaged");
  assert.equal(agentSegment({ offers: [passed({ status: "we_passed" })] }), "cold", "our own pass isn't their answer");
  const v = evaluateAgent(agent({ offers: [passed()], current: [passed()] }), ctx());
  assert.equal(v.status, "due", v.reason);
  assert.equal(v.segment, "engaged");
});

test("an agent we made an offer to who never wrote back is still checked in on, until three check-ins go unanswered", () => {
  const ours = passed({ status: "we_passed", statusHistory: [{ status: "we_passed", ts: ago(40) }] });
  const quiet = agent({ offers: [ours], current: [ours], events: [{ type: "follow_up_sent", at: ago(30) }] });
  const v = evaluateAgent(quiet, ctx());
  assert.equal(v.status, "due", v.reason);
  assert.equal(v.pulseReason, "general");
  assert.equal(v.segment, "cold", "the text still introduces us in a clause");
  assert.equal(evaluateAgent({ ...quiet, ledger: [{ type: "agent_pulse_sent", at: ago(10) }, { type: "agent_pulse_texted", at: ago(10) }] }, ctx()).status, "not_due", "every 21 days, not every day");
  const drafted = { id: "o-d", contactId: "a1", address: "9 Oak St, Kent, WA 98031", status: "draft", createdAt: ago(30) };
  assert.equal(evaluateAgent(agent({ offers: [drafted], current: [drafted], events: [{ type: "follow_up_sent", at: ago(30) }] }), ctx()).status, "due", "a drafted offer counts too");
  const three = { ...quiet, ledger: [ago(70), ago(49), ago(28)].map((at) => ({ type: "agent_pulse_texted", at })) };
  assert.equal(evaluateAgent(three, ctx()).status, "cold_dropped", "three unanswered check-ins and they rest");
  assert.equal(evaluateAgent(agent({ events: [{ type: "follow_up_sent", at: ago(30) }] }), ctx()).status, "not_due", "no offer, never wrote: listings only, as before");
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

// 2026-10-15, the funnel review: Matt's own specific texts got 70% replies,
// the generic check-ins 35%. One real thing, never a house we priced.
const mention = (address, d = 10, data = {}) => ({ type: "house_mentioned", at: ago(d), address, data });
const closedDeal = (address, d = 20) => ({ id: `c-${address}`, contactId: "other", address, status: "accepted",
  deal: { stage: "closed", stageHistory: [{ stage: "under_contract", ts: ago(d + 30) }, { stage: "closed", ts: ago(d) }] } });

test("a check-in names a house they mentioned that we never priced, and the gate stops holding that one", () => {
  const a = agent({ lastInboundAt: ago(30), events: [mention("Pine St, Shelton, WA", 12), { type: "subject_property_set", at: ago(12), address: "Pine St, Shelton, WA" }],
    offers: [passed({ address: "9 Oak St, Kent, WA 98031" })] });
  const subj = agentPulseSubject({ agent: a, verdict: { pulseReason: "general", segment: "engaged" }, now: NOW });
  assert.deepEqual({ kind: subj.hook.kind, street: subj.hook.street, daysAgo: subj.hook.daysAgo }, { kind: "mentioned", street: "Pine St", daysAgo: 12 });
  assert.ok(!subj.pastHouses.includes("Pine St, Shelton, WA"), "the hook's own house may be named");
  assert.ok(subj.pastHouses.includes("9 Oak St, Kent, WA 98031"), "a house we priced stays behind the gate");
  assert.equal(subj.address, "", "no house of record, so the reply isn't gated as a first-text house");
});

test("a house we priced, passed on, or texted them about first is never the check-in's house — nor one named two months back", () => {
  const priced = mentionedHouseFor({ events: [mention("1412 Pine St, Shelton, WA")], offers: [passed({ address: "1412 Pine St, Shelton, WA 98584" })], now: NOW });
  assert.equal(priced, null, "an offer on it, sent or drafted");
  const noNumber = mentionedHouseFor({ events: [mention("Pine St, Shelton, WA")], offers: [passed({ address: "1412 Pine St, Shelton, WA 98584" })], now: NOW });
  assert.equal(noNumber, null, "the street they named is the house we priced");
  assert.equal(mentionedHouseFor({ events: [mention("5 Ash Ave, Kent, WA"), { type: "tier1_passed", at: ago(5), address: "5 Ash Ave, Kent, WA" }], now: NOW }), null);
  assert.equal(mentionedHouseFor({ events: [mention("5 Ash Ave, Kent, WA"), { type: "outreach_sent", at: ago(20), address: "5 Ash Ave, Kent, WA" }], now: NOW }), null, "the listing from our first text");
  assert.equal(mentionedHouseFor({ events: [mention("5 Ash Ave, Kent, WA", 61)], now: NOW }), null);
  assert.equal(mentionedHouseFor({ events: [mention("5 Ash Ave, Kent, WA", 30), mention("7 Fir Ln, Kent, WA", 5)], now: NOW }).street, "7 Fir Ln", "the newest");
});

test("with no house to name, a check-in may say we just closed one in a town they work — by the town only", () => {
  const closes = recentCloses([closedDeal("88 Quill Ave S, Kent, WA 98032"), closedDeal("1 Far Rd, Yakima, WA 98901", 70),
    { ...closedDeal("2 Mid St, Kent, WA 98032"), deal: { stage: "assigned", stageHistory: [{ stage: "assigned", ts: ago(3) }] } }], NOW);
  assert.deepEqual(closes.map((c) => c.town), ["Kent"], "closed in the last 60 days; an assignment isn't a close");
  const works = agent({ lastInboundAt: ago(30), listings: [listing({ firstSeen: ago(40) })] });
  assert.deepEqual(checkInHook({ agent: works, verdict: { pulseReason: "general" }, houses: { closes }, now: NOW }), { kind: "closed_nearby", town: "Kent" });
  const elsewhere = agent({ lastInboundAt: ago(30), offers: [passed({ address: "3 Bay St, Everett, WA 98201" })] });
  assert.deepEqual(checkInHook({ agent: elsewhere, verdict: { pulseReason: "general" }, houses: { closes }, now: NOW }), { kind: "situation" });
  assert.doesNotMatch(JSON.stringify(agentPulseSubject({ agent: works, verdict: { pulseReason: "general" }, houses: { closes }, now: NOW }).hook), /88 Quill|Quill Ave/);
  assert.equal(checkInHook({ agent: works, verdict: { pulseReason: "deal_thanks" }, houses: { closes }, now: NOW }), null, "the thank-you is about that deal");
  assert.deepEqual(checkInHook({ agent: works, verdict: { pulseReason: "fresh_listing", listing: listing() }, houses: { closes }, now: NOW }), { kind: "listing" });
});

test("the plan hands each pick its hook, from our closes", () => {
  const a = agent({ lastInboundAt: ago(30), listings: [listing({ firstSeen: ago(40) })] });
  const { picks } = pickPulseAgents({ agents: [a], settings: S, config: CONFIG, houses: { live: new Set(), walked: new Map(), closes: [{ town: "Kent", at: ago(10) }] }, now: NOW });
  assert.deepEqual(picks[0].subject.hook, { kind: "closed_nearby", town: "Kent" });
});

// Matt's 15 (2026-10-15): his own specific texts got 70% replies. Once a
// week his best agents' check-ins are drafted for him to send.
test("Matt's 15 ships off: Monday, fifteen, before his day starts", () => {
  assert.deepEqual(normalizeAgentPulse({}).mattsFifteen, { enabled: false, size: 15, weekday: 1, hour: 8 });
  assert.deepEqual(normalizeAgentPulse({ mattsFifteen: { enabled: true, size: 99, weekday: 9, hour: "7" } }).mattsFifteen, { enabled: true, size: 40, weekday: 6, hour: 7 });
});

test("Matt's 15 are partners first, then agents who brought us houses, then the ones who write back, newest word first — never one already talking or cold", () => {
  const people = [
    agent({ contactId: "eng-old", lastInboundAt: ago(90), offers: [passed({ id: "x1" }), passed({ id: "x2", address: "2 Elm St, Kent, WA 98031" })] }),
    agent({ contactId: "eng-new", lastInboundAt: ago(20) }),
    agent({ contactId: "source", lastInboundAt: ago(50), events: [{ type: "investor_minded", at: ago(50) }] }),
    agent({ contactId: "partner", lastInboundAt: ago(60), offers: [passed({ realm: { answer: "yes", at: ago(100) }, statusAt: ago(100) })] }),
    agent({ contactId: "talking", lastInboundAt: ago(3) }),
    agent({ contactId: "texted", lastInboundAt: ago(40), events: [{ type: "follow_up_sent", at: ago(2) }] }),
    agent({ contactId: "cold" }),
    agent({ contactId: "stopped", lastInboundAt: ago(30), events: [{ type: "unsubscribed", at: ago(20) }] }),
  ];
  const settings = { ...S, mattsFifteen: { enabled: true, size: 3 } };
  const picks = pickMattsFifteen({ agents: people, settings, config: CONFIG, houses: { live: new Set(), walked: new Map() }, now: NOW });
  assert.deepEqual(picks.map((p) => p.contactId), ["partner", "source", "eng-new"]);
  assert.ok(picks.every((p) => p.subject.forMatt === true), "each is his to send");
  assert.ok(picks.every((p) => p.subject.hook), "and names one real thing");
  const all = pickMattsFifteen({ agents: people, settings: { ...S, mattsFifteen: { enabled: true, size: 15 } }, config: CONFIG, houses: { live: new Set(), walked: new Map() }, now: NOW });
  assert.deepEqual(all.map((p) => p.contactId), ["partner", "source", "eng-new", "eng-old"]);
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

test("an agent who talks like an investor is a source before they've sent a house", () => {
  const a = agent({ lastInboundAt: ago(30), events: [{ type: "investor_minded", at: ago(30), data: { cue: "finder's fee" } }] });
  const v = evaluateAgent(a, ctx());
  assert.equal(v.segment, "source");
  assert.equal(v.priority[0], 2, "ranked with partners");
});

test("an agent on a Tier 2 or Tier 3 card gets the app's check-in 14 days after the card moved there, now if that day has passed", () => {
  const S14 = normalizeAgentPulse({ enabled: true, everyDays: 14 });
  const at = (d) => ({ tier: "t3", movedAt: ago(d) });
  // Never wrote back, moved to Tier 3 five days ago: not yet, and the plan says when.
  const early = evaluateAgent(agent({ ghlTier: at(5) }), ctx({ settings: S14 }));
  assert.equal(early.status, "not_due", early.reason);
  assert.match(early.reason, /moved to Tier 3 within 14 days/);
  assert.equal(early.dueAt, ago(-9), "fourteen days from the move");
  // Moved twenty days ago and nothing since: it goes on the next run.
  const late = evaluateAgent(agent({ ghlTier: at(20) }), ctx({ settings: S14 }));
  assert.equal(late.status, "due", late.reason);
  assert.equal(late.pulseReason, "general");
  // We talked after the move: fourteen days from that instead.
  const talked = evaluateAgent(agent({ ghlTier: { tier: "t2", movedAt: ago(20) }, lastInboundAt: ago(4) }), ctx({ settings: S14 }));
  assert.equal(talked.dueAt, ago(-10));
  // Off any card and never wrote back: listings only, as before.
  assert.equal(evaluateAgent(agent({ ghlTier: { tier: "t1", movedAt: ago(20) } }), ctx({ settings: S14 })).status, "not_due");
  assert.equal(tierCard(agent({ ghlTier: { tier: "t1" } })), null);
  // Three of ours unanswered and a never-replied card agent rests.
  const three = agent({ ghlTier: at(90), ledger: [ago(60), ago(45), ago(30)].map((t) => ({ type: "agent_pulse_texted", at: t })) });
  assert.equal(evaluateAgent(three, ctx({ settings: S14 })).status, "cold_dropped");
});

test("the plan lists every agent with what the check-in will do and when, and counts the Tier 2 and 3 cards", () => {
  const S14 = normalizeAgentPulse({ enabled: true, everyDays: 14 });
  const { verdicts, counts } = pickPulseAgents({ agents: [
    agent({ contactId: "t2-due", ghlTier: { tier: "t2", movedAt: ago(30) } }),
    agent({ contactId: "t3-wait", ghlTier: { tier: "t3", movedAt: ago(2) } }),
  ], settings: S14, config: CONFIG, now: NOW });
  assert.deepEqual(counts.ghlTier, { t2: 1, t3: 1, due: 1 });
  const by = Object.fromEntries(verdicts.map((v) => [v.contactId, v]));
  assert.equal(by["t2-due"].status, "due");
  assert.equal(by["t3-wait"].dueAt, ago(-12));
  assert.equal(by["t3-wait"].tier, "t3");
  assert.ok(verdicts.every((v) => !("name" in v)), "no names in the list");
});

// 2026-10-13, 5413 Welfare Ave NE: the check-in carried the street alone, so
// the reply's underwrite couldn't find it on a map and the agent was asked
// for a city RentCast had given us. The text still names it by street.
test("a check-in house carries its city and ZIP, and the text still names it by street", () => {
  const v = evaluateAgent(agent({ lastInboundAt: ago(60), listings: [listing()] }), ctx());
  const subj = agentPulseSubject({ agent: agent(), verdict: v });
  assert.equal(subj.address, "123 Main St, Kent, WA 98031");
  assert.equal(subj.listing.street, "123 Main St");
  assert.equal(subj.listing.city, "Kent");
});

// Offers stuck open (2026-10-14): the Line listed offers still "new" where the
// machine stood down 8–13 days back, and others where the agent replied and
// nothing answered it. "An open offer" held each agent from the check-in for
// good. A stood-down offer with no text either way for a week lets them go.
const stuck = (over = {}) => ({ id: "o-stuck", contactId: "a1", address: "41 Alder Ln, Shelton, WA 98584", cashAmount: 210000, status: "sent",
  createdAt: ago(45), statusAt: ago(45), statusHistory: [], sends: [{ ts: ago(45) }], ...over });
// They wrote back; nobody answered it, and the bot's held reply was set aside.
const unanswered = (days) => ({ id: `in-${days}`, status: "superseded", inbound: "Let me run it by the seller", intent: "other", createdAt: ago(days), updatedAt: ago(days) });
const OFF = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: false } } } });

test("an agent whose offer the machine stood down on two weeks ago is on the regular check-in clock, not held by the offer", () => {
  const drafts = [unanswered(14)];
  const v = evaluateAgent(agent({ lastInboundAt: ago(14), offers: [stuck()], current: [stuck()], drafts }), ctx());
  assert.notEqual(v.status, "owned", v.reason);
  assert.equal(v.status, "not_due", "they wrote 14 days ago: the check-in comes at 21");
  assert.match(openOfferIdle({ offer: stuck(), drafts, config: CONFIG, lastInboundAt: ago(14), now: NOW }) || "", /nothing has answered it/);
  // Three weeks on, the check-in is due.
  const later = evaluateAgent(agent({ lastInboundAt: ago(22), offers: [stuck()], current: [stuck()], drafts: [unanswered(22)] }), ctx());
  assert.equal(later.status, "due", later.reason);
});

test("an agent whose offer the machine stood down on for any reason gets the regular check-in once nobody has texted for a week", () => {
  // Follow-ups switched off: nothing will ever move the offer.
  const off = evaluateAgent(agent({ lastInboundAt: ago(30), offers: [stuck()], current: [stuck()] }), ctx({ config: OFF }));
  assert.equal(off.status, "due", off.reason);
  // You stopped the bot on that house (not the whole thread).
  const stopped = [{ type: "drive_stopped", offerId: "o-stuck", at: ago(20), data: { reason: "" } }];
  const v = evaluateAgent(agent({ lastInboundAt: ago(30), offers: [stuck()], current: [stuck()], events: stopped }), ctx());
  assert.equal(v.status, "due", v.reason);
  // A pause has a date: the offer keeps them until it.
  const paused = [{ type: "drive_stopped", offerId: "o-stuck", at: ago(20), data: { until: ago(-5) } }];
  const p = evaluateAgent(agent({ lastInboundAt: ago(30), offers: [stuck()], current: [stuck()], events: paused }), ctx());
  assert.equal(p.reason, "an open offer", "paused until next week");
});

test("an agent mid-negotiation this week is still owned by the offer", () => {
  const talked = [{ type: "text_summary", at: ago(3), data: { inbound: "Seller might do 230" } }];
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(3), offers: [stuck()], current: [stuck()], events: talked }), ctx({ config: OFF })).reason, "an open offer");
  // Our own text five days ago counts too.
  const ours = [{ type: "follow_up_sent", at: ago(5) }];
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(30), offers: [stuck()], current: [stuck()], events: ours }), ctx({ config: OFF })).reason, "an open offer");
  // A person picked it up two days ago: theirs, whatever the clock says.
  const byHand = [{ type: "hand_reply", at: ago(2) }];
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(30), offers: [stuck()], current: [stuck()], events: byHand }), ctx({ config: OFF })).reason, "an open offer");
  // An offer made this week is fresh business, even with nothing said on it.
  const fresh = stuck({ createdAt: ago(4), statusAt: ago(4), sends: [{ ts: ago(4) }] });
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(30), offers: [fresh], current: [fresh] }), ctx({ config: OFF })).reason, "an open offer");
  // A nudge clock that is firing keeps them with the offer, however quiet
  // they are (a nudge went three days ago, the next one is coming).
  const nudging = stuck({ followUps: [{ kind: "offer_nudge", step: 3, at: ago(3) }] });
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(60), offers: [nudging], current: [nudging] }), ctx()).reason, "an open offer");
  // One that has never fired since the number went out 45 days ago isn't running (2026-10-16).
  assert.notEqual(evaluateAgent(agent({ lastInboundAt: ago(60), offers: [stuck()], current: [stuck()] }), ctx()).status, "owned");
});

test("a held draft from a month ago doesn't silence the agent", () => {
  const old = { id: "d-old", status: "draft", inbound: "any update?", createdAt: ago(30), updatedAt: ago(30) };
  const v = evaluateAgent(agent({ lastInboundAt: ago(30), drafts: [old] }), ctx());
  assert.equal(v.status, "due", v.reason);
  // On an open offer too: the held reply was the only thing keeping it "owed".
  const onOffer = evaluateAgent(agent({ lastInboundAt: ago(30), offers: [stuck()], current: [stuck()], drafts: [old] }), ctx());
  assert.equal(onOffer.status, "due", onOffer.reason);
  // This week's held reply still owns them.
  const fresh = { ...old, createdAt: ago(2), updatedAt: ago(2) };
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(2), drafts: [fresh] }), ctx()).reason, "their text is waiting on you");
  // A text queued for next week is coming, however long ago it was written.
  const queued = { id: "d-q", status: "scheduled", inbound: "", outbound: { kind: "checkin_due" }, createdAt: ago(20), sendAt: ago(-3) };
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(30), drafts: [queued] }), ctx()).reason, "a text is waiting in the outbox");
});

test("an agent let go from a stuck offer gets the general check-in, which never names that house", () => {
  const a = agent({ lastInboundAt: ago(30), offers: [stuck()], current: [stuck()] });
  const v = evaluateAgent(a, ctx({ config: OFF }));
  assert.equal(v.status, "due", v.reason);
  assert.equal(v.pulseReason, "general");
  assert.equal(v.house || null, null, "an open offer is never the check-in's house");
  const subject = agentPulseSubject({ agent: a, verdict: v, now: NOW });
  assert.equal(subject.house, null);
  assert.ok(subject.pastHouses.includes(stuck().address), "the gate holds a check-in that names it");
});

// 2026-10-14: 104 agents who wrote back sat outside the check-in pool, and
// nothing would ever text them again. They join it all at once, weeks after
// their last word — so every one of them would be due the same morning.
test("fifty repliers added at once are spread over two weeks, not due the same day", () => {
  const S14 = normalizeAgentPulse({ enabled: true, everyDays: 14 });
  const joinedAt = ago(0);
  const repliers = Array.from({ length: 50 }, (_, i) => agent({ contactId: `rp-${i}x${i * 7}`, lastInboundAt: ago(60 + i), joinedAt }));
  const onDay = (d) => repliers.map((a) => evaluateAgent(a, ctx({ settings: S14, now: NOW + d * DAY + 3600000 }))).filter((v) => v.status === "due").length;
  assert.ok(onDay(0) <= 10, `${onDay(0)} due on the day they joined`);
  const firsts = new Set(repliers.map((a) => evaluateAgent(a, ctx({ settings: S14 })).dueAt || "now"));
  assert.ok(firsts.size >= 8, `first check-ins land on ${firsts.size} different days`);
  assert.equal(onDay(14), 50, "and every one is due within the two weeks");
  // Waiting, each one says when — and says it the same way every day.
  const waiting = evaluateAgent(repliers.find((a) => Date.parse(firstCheckInAt({ contactId: a.contactId, joinedAt, everyDays: 14 })) > NOW + 3 * DAY), ctx({ settings: S14 }));
  assert.equal(waiting.status, "not_due");
  assert.equal(waiting.segment, "engaged");
  assert.equal(evaluateAgent(repliers[3], ctx({ settings: S14, now: NOW + 2 * 3600000 })).dueAt, evaluateAgent(repliers[3], ctx({ settings: S14 })).dueAt);
});

test("the spread only holds back a replier's first check-in, never one who has talked since or been checked in on", () => {
  const S14 = normalizeAgentPulse({ enabled: true, everyDays: 14 });
  const joinedAt = ago(1);
  const id = Array.from({ length: 40 }, (_, i) => `slot-${i}`).find((x) => Date.parse(firstCheckInAt({ contactId: x, joinedAt, everyDays: 14 })) > NOW + 2 * DAY);
  assert.ok(Date.parse(firstCheckInAt({ contactId: id, joinedAt, everyDays: 14 })) > NOW);
  assert.equal(evaluateAgent(agent({ contactId: id, lastInboundAt: ago(60), joinedAt }), ctx({ settings: S14 })).status, "not_due");
  const checked = agent({ contactId: id, lastInboundAt: ago(60), joinedAt, ledger: [{ type: "agent_pulse_sent", at: ago(20), dedupeKey: "k" }] });
  assert.equal(evaluateAgent(checked, ctx({ settings: S14 })).status, "due", "already on the clock: the clock decides");
  assert.equal(evaluateAgent(agent({ contactId: id, lastInboundAt: ago(60) }), ctx({ settings: S14 })).status, "due", "no join date: nothing to spread");
  assert.equal(evaluateAgent(agent({ contactId: id, lastInboundAt: ago(60), joinedAt, listings: [listing()] }), ctx({ settings: S14 })).status, "not_due", "a fresh listing of theirs waits for their day too");
});

test("a cold agent's old listing ping doesn't make a found replier due the morning they join", () => {
  const S14 = normalizeAgentPulse({ enabled: true, everyDays: 14 });
  const joinedAt = ago(1);
  const id = Array.from({ length: 40 }, (_, i) => `slot-${i}`).find((x) => Date.parse(firstCheckInAt({ contactId: x, joinedAt, everyDays: 14 })) > NOW + 2 * DAY);
  const ping = (segment) => [
    { type: "agent_pulse_sent", at: ago(40), dedupeKey: "k", data: { segment, reason: "fresh_listing" } },
    { type: "agent_pulse_texted", at: ago(40), data: { segment, reason: "fresh_listing" } },
  ];
  assert.equal(evaluateAgent(agent({ contactId: id, lastInboundAt: ago(60), joinedAt, ledger: ping("cold") }), ctx({ settings: S14 })).status, "not_due");
  assert.equal(evaluateAgent(agent({ contactId: id, lastInboundAt: ago(60), joinedAt, ledger: ping("engaged") }), ctx({ settings: S14 })).status, "due",
    "a check-in on the regular clock: the clock decides");
});

test("a replier who said stop, or sounds annoyed, is not checked in on when they join", () => {
  const S14 = normalizeAgentPulse({ enabled: true, everyDays: 14 });
  const stopped = agent({ lastInboundAt: ago(60), joinedAt: ago(30), events: [{ type: "unsubscribed", at: ago(30) }] });
  assert.equal(evaluateAgent(stopped, ctx({ settings: S14 })).status, "stopped");
  const annoyed = agent({ lastInboundAt: ago(60), joinedAt: ago(30), events: [{ type: "text_summary", at: ago(60), data: { inbound: "how many times do I have to say no" } }] });
  assert.equal(evaluateAgent(annoyed, ctx({ settings: S14 })).status, "stopped");
});

const msg = (direction, body, daysAgo, messageType = "TYPE_SMS") => ({ direction, body, messageType, dateAdded: ago(daysAgo) });
test("the replier backfill reads a GHL thread: their text is a reply, a stop or DND is an opt-out, an auto-reply is not a person", () => {
  const ours = msg("outbound", "Hi Pat, is 1 Elm St a project or pretty turnkey?", 50);
  const none = classifyReplierThread({ messages: [ours, msg("inbound", "", 49, "TYPE_ACTIVITY_OPPORTUNITY")] });
  assert.equal(none.kind, "none");
  const replied = classifyReplierThread({ messages: [ours, msg("inbound", "Pretty turnkey, sorry. Will keep you in mind", 49)] });
  assert.equal(replied.kind, "engaged");
  assert.equal(replied.lastInboundAt, ago(49));
  assert.equal(replied.channel, "sms");
  assert.match(replied.lastText, /keep you in mind/);
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "", 40, "TYPE_CALL")] }).kind, "engaged", "a call from them counts");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "STOP", 49)] }).kind, "opted_out");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "Wrong number", 49)] }).kind, "opted_out");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "Not right now", 49), msg("inbound", "please take me off your list", 45)] }).kind, "opted_out");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "Stop by the open house Saturday!", 49)] }).kind, "engaged", "a word in a sentence is not a stop");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "That's not my listing pls stop", 49)] }).kind, "opted_out", "a stop at the end of a short text");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "No need to message me looking for houses. Bye", 49)] }).kind, "opted_out");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "You've reached Big Brokerage, but we use a different number for texting.", 49)] }).kind, "auto_reply");
  const dnd = classifyReplierThread({ messages: [ours, msg("inbound", "sure", 49)], contact: { dndSettings: { SMS: { status: "active" } } } });
  assert.deepEqual([dnd.kind, dnd.why], ["opted_out", "dnd"]);
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "sure", 49)], contact: { tags: ["DNC"] } }).kind, "opted_out");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "I'm driving with Do Not Disturb While Driving turned on. I'll see your message when I get where I'm going.", 49)] }).kind, "auto_reply");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "This number does not accept text messages.", 49)] }).kind, "auto_reply");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "I'm driving with Do Not Disturb While Driving turned on.", 49), msg("inbound", "ok what's your number", 48)] }).kind, "engaged", "a real text after the auto-reply");
  assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", "how many times do I have to tell you no", 49)] }).kind, "annoyed");
  assert.equal(JSON.stringify(classifyReplierThread({ messages: [ours, msg("inbound", "STOP", 49)] })).includes("STOP"), false, "an opt-out carries no words of theirs");
});

// The replier backfill and the reply agent read auto-replies the same way
// (shared/brush-offs.js isAutoReply): a brokerage desk that answered for
// them is not an agent who wrote back.
test("the replier backfill knows a brokerage desk's auto-reply the reply agent already drops", () => {
  const ours = msg("outbound", "Hi Pat, is 1 Elm St a project or pretty turnkey?", 50);
  for (const t of [
    "Thank you for your message, we will get back to you shortly. Thank you.",
    "Thank you for messaging Big Brokerage. We're excited to connect with you and will be with you in just a moment.",
  ]) assert.equal(classifyReplierThread({ messages: [ours, msg("inbound", t, 49)] }).kind, "auto_reply", t);
});

// The run is weekdays only: a Saturday or Sunday slot would just pile onto
// Monday's run.
test("no first check-in lands on a weekend", () => {
  // Joined on a Friday, a Saturday and a Monday (noon Pacific).
  for (const joinedAt of ["2026-10-16T19:00:00Z", "2026-10-17T19:00:00Z", "2026-10-19T19:00:00Z"]) {
    const days = new Map();
    for (let i = 0; i < 300; i++) {
      const at = firstCheckInAt({ contactId: `wk-${i}-${i * 13}`, joinedAt, everyDays: 14 });
      const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(new Date(at));
      assert.ok(wd !== "Sat" && wd !== "Sun", `${joinedAt}: a first check-in on ${wd}`);
      assert.ok(Date.parse(at) - Date.parse(joinedAt) < 14 * DAY, "within the two weeks");
      days.set(at.slice(0, 10), (days.get(at.slice(0, 10)) || 0) + 1);
    }
    assert.equal(days.size, 10, "all ten weekdays of the two weeks are used");
    assert.ok(Math.max(...days.values()) < 60, "and none takes a pile");
  }
});

test("a replier who joined by their reply and isn't written down yet is spread from today, every day the same way once the run writes it", () => {
  const S14 = normalizeAgentPulse({ enabled: true, everyDays: 14 });
  const ids = Array.from({ length: 40 }, (_, i) => `jr-${i}`);
  const fresh = ids.map((id) => evaluateAgent(agent({ contactId: id, lastInboundAt: ago(90), joinedByReply: true }), ctx({ settings: S14 })));
  assert.ok(fresh.filter((v) => v.status === "due").length <= 10, "not all due today");
  for (const v of fresh.filter((v) => v.status === "not_due")) assert.ok(Date.parse(v.dueAt) < NOW + 14 * DAY, "each within two weeks of today");
  // Written down today: a week later the same agents keep their days.
  const later = ids.map((id) => evaluateAgent(agent({ contactId: id, lastInboundAt: ago(90), joinedByReply: true, joinedAt: ago(0) }), ctx({ settings: S14, now: NOW + 7 * DAY })));
  assert.deepEqual(later.map((v) => v.dueAt || null).filter(Boolean), fresh.map((v) => v.dueAt || null).filter((d) => d && Date.parse(d) > NOW + 7 * DAY));
});

// 2026-10-22: a pass note (or a kind pass) about a house of theirs went, and
// nothing told the check-in, so "anything else on your desk?" could land the
// next morning on top of "thanks, we're passing on it".
test("a check-in doesn't follow a pass note within the wait", () => {
  const justPassed = agent({ lastInboundAt: ago(30), events: [{ type: "pass_texted", at: ago(1) }] });
  assert.equal(evaluateAgent(justPassed, ctx()).status, "not_due");
  const longAgo = agent({ lastInboundAt: ago(40), events: [{ type: "pass_texted", at: ago(30) }] });
  assert.equal(evaluateAgent(longAgo, ctx()).status, "due");
});

// 2026-10-22 audit: 782 agents read "moved to Tier 2 within 14 days" — the
// board moved under them (the 10/13 migration, the replier sweep, a pass
// moving Offer Out to Tier 2) and each move pushed their check-in out two
// more weeks. 21 offer agents had gone three weeks and more with no text.
test("a card moved to Tier 2 doesn't push back an agent we haven't texted in three weeks", () => {
  const S14 = normalizeAgentPulse({ enabled: true, everyDays: 14 });
  const a = agent({ lastInboundAt: ago(30), events: [{ type: "follow_up_sent", at: ago(22) }], ghlTier: { tier: "t2", movedAt: ago(2) } });
  const v = evaluateAgent(a, ctx({ settings: S14 }));
  assert.equal(v.status, "due", v.reason);
  // We did text five days ago: that's the clock, not the move.
  const recent = agent({ lastInboundAt: ago(30), events: [{ type: "follow_up_sent", at: ago(5) }], ghlTier: { tier: "t2", movedAt: ago(1) } });
  const w = evaluateAgent(recent, ctx({ settings: S14 }));
  assert.equal(w.status, "not_due");
  assert.equal(w.dueAt, ago(-9));
  assert.match(w.reason, /talked within 14 days/);
});

/* ---------- a focus county (2026-10-26, Matt: more outreach in Pierce) ---------- */

const FOCUS = normalizeAgentPulse({ enabled: true, focusListings: { enabled: true, counties: ["Pierce, WA"], maxAgeDays: 120 } });
const pierceListing = (over = {}) => listing({ firstSeen: ago(40), distressRule: "cut-old-or-stale",
  doc: { ...listing().doc, address: "4521 18th Ave Ct NW, Tacoma, WA 98406", city: "Tacoma", county: "Pierce", state: "WA", yearBuilt: 1962 }, ...over });
const coldAgent = (over = {}) => agent({ events: [{ type: "outreach_enrolled", at: ago(90), data: { kind: "first" } }], ...over });

test("a cold Pierce agent's listing that has been up a month is a reason to text when Pierce is a focus county", () => {
  const v = evaluateAgent(coldAgent({ listings: [pierceListing()] }), ctx({ settings: FOCUS }));
  assert.equal(v.status, "due");
  assert.equal(v.pulseReason, "fresh_listing");
  assert.equal(v.focus, true, "marked for the Zillow read and the first-text words");
  assert.equal(evaluateAgent(coldAgent({ listings: [pierceListing()] }), ctx()).status, "not_due", "with the switch off, a month-old listing isn't news");
  assert.equal(evaluateAgent(coldAgent({ listings: [pierceListing({ firstSeen: ago(150) })] }), ctx({ settings: FOCUS })).status, "not_due", "past maxAgeDays");
  const fresh = evaluateAgent(coldAgent({ listings: [pierceListing({ firstSeen: ago(3) })] }), ctx({ settings: FOCUS }));
  assert.equal(fresh.status, "due");
  assert.equal(fresh.focus, undefined, "a fresh listing is the ordinary ping");
  const plan = pickPulseAgents({ agents: [coldAgent({ listings: [pierceListing()] })], settings: FOCUS, config: CONFIG, now: NOW });
  assert.equal(plan.picks[0].focus, true);
  assert.equal(plan.picks[0].subject.listing.focus, true);
  assert.equal(plan.picks[0].subject.listing.county, "Pierce");
  assert.equal(plan.counts.fresh.focus, 1);
});

test("the same month-old listing in King is not", () => {
  const king = pierceListing({ doc: { ...pierceListing().doc, address: "9 Oak St, Kent, WA 98031", city: "Kent", county: "King" } });
  assert.equal(evaluateAgent(coldAgent({ listings: [king] }), ctx({ settings: FOCUS })).status, "not_due");
});

test("an engaged Pierce agent's month-old listing doesn't change their check-in", () => {
  const v = evaluateAgent(agent({ lastInboundAt: ago(60), listings: [pierceListing()] }), ctx({ settings: FOCUS }));
  assert.equal(v.pulseReason, "general", "the wider window is for cold agents only");
});

test("a listing that was their August hook is never pinged, however they were texted about it", () => {
  const hooked = coldAgent({ listings: [pierceListing()], hooks: [{ address: "4521 18th Ave Ct NW, Tacoma, WA 98406", importedAt: ago(70) }] });
  assert.equal(evaluateAgent(hooked, ctx({ settings: FOCUS })).status, "not_due");
  const fresh = coldAgent({ listings: [pierceListing({ firstSeen: ago(3) })], hooks: [{ address: "4521 18th Ave Ct NW, Tacoma, WA 98406" }] });
  assert.equal(evaluateAgent(fresh, ctx()).status, "not_due", "nor as a fresh listing");
});

test("focus counties are written 'Pierce, WA' and a stray 'County' is dropped", () => {
  const f = normalizeAgentPulse({ focusListings: { enabled: true, counties: ["Pierce County, WA", "pierce county,wa", "Kitsap"], maxAgeDays: 999 } }).focusListings;
  assert.deepEqual(f.counties, ["Pierce, WA", "pierce, wa", "Kitsap"]);
  assert.equal(f.maxAgeDays, 180);
  assert.equal(normalizeAgentPulse({}).focusListings.enabled, false, "ships off");
});
