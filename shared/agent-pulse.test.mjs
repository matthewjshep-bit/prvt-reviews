// agent-pulse.test.mjs — every agent on a clock, and only one clock at a time.

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAgentPulse, evaluateAgent, pickPulseAgents, agentSegment, agentStops, agentOwner,
  freshListingFor, listingDistressed, agentPulseSubject,
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
  assert.equal(normalizeAgentPulse({ dailyCap: 900 }).dailyCap, 100, "capped");
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
  // Passed 25 days ago: the check-ins (days 10, 20, 30) still own them.
  const recent = passed({ statusAt: ago(25), statusHistory: [{ status: "passed", ts: ago(25) }], followUps: [{ kind: "passed_checkin", step: 10, at: ago(15) }, { kind: "passed_checkin", step: 20, at: ago(5) }] });
  const owned = evaluateAgent(agent({ lastInboundAt: ago(60), offers: [recent], current: [recent] }), ctx());
  assert.equal(owned.status, "owned");
  assert.match(owned.reason, /check back in/);
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
