// brush-offs.test.mjs — how often they want to hear from us, a no to the
// address chase, and a machine's text that isn't them (2026-10-14).

import test from "node:test";
import assert from "node:assert/strict";
import { cadenceRequest, cadenceDays, refusesAddress, notAHouse, isAutoReply, autoReplyNumber, requestStands } from "./brush-offs.js";
import { evaluateAgent, normalizeAgentPulse, agentOwner } from "./agent-pulse.js";
import { addFact, FACT_KEYS, factsFromCustom } from "./contact-record.js";
import { buildPipeline } from "./pipeline.js";
import { urgentReasons } from "./desk.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-14T19:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const S = normalizeAgentPulse({ enabled: true });
const ctx = { settings: S, config: {}, houses: { live: new Set(), walked: new Map() }, now: NOW };
const agent = (over = {}) => ({ contactId: "a1", name: "Pat Agent", tags: ["agent"], offers: [], current: [], drafts: [], events: [], ledger: [], listings: [], facts: {}, lastInboundAt: null, ...over });
const withCadence = (days, at = ago(0)) => addFact({}, "checkinEvery", { value: String(days), source: "conversation", at }).facts;

/* ---------- how often ---------- */

test("an agent who says check in every two or three months isn't texted for about ten weeks", () => {
  const c = cadenceRequest("Nothing right now. You are on my list. Would you check in no more than every 2-3 months. I get too many of these texts. Thx");
  assert.equal(c.days, 75);
  assert.equal(c.checkBack, false);
  // They said it 30 days ago; the 21-day check-in would be due. It isn't.
  const a = agent({ lastInboundAt: ago(30), facts: withCadence(75, ago(30)) });
  const v = evaluateAgent(a, ctx);
  assert.equal(v.status, "not_due", v.reason);
  assert.match(v.reason, /every 75 days/);
  assert.equal(v.dueAt.slice(0, 10), new Date(NOW + 45 * DAY).toISOString().slice(0, 10));
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(76), facts: withCadence(75, ago(76)) }), ctx).status, "due");
  // Without the fact, the same agent is due today.
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(30) }), ctx).status, "due");
});

test("'you're on my email list' quiets the check-in for three months", () => {
  const c = cadenceRequest("I just sent you my two newest last week. You are on my email list so you don't need to check in, I push them out as they go live");
  assert.equal(c.days, 90);
  assert.equal(cadenceRequest("Don't need to check back. There is always the one on Moller.").days, 90);
  assert.equal(cadenceRequest("Nothing right now, you're on my list").days, 90);
  const v = evaluateAgent(agent({ lastInboundAt: ago(60), facts: withCadence(90, ago(60)) }), ctx);
  assert.equal(v.status, "not_due");
});

test("'enough wholesalers', 'too far apart to stay in contact' and 'pocket listings are illegal' wait four months", () => {
  for (const t of [
    "I have enough wholesalers in my database",
    "We're way too apart on pricing to remain in contact",
    "That is called a pocket listing and it is illegal no thank you",
    "Not interested in working with wholesalers",
  ]) assert.equal(cadenceRequest(t)?.days, 120, t);
});

test("'check back in a couple months' is sixty days and a dated check-in; a few months is ninety; monthly is thirty", () => {
  const c = cadenceRequest("Feel free to check back in a couple months 👍");
  assert.deepEqual([c.days, c.checkBack, c.phrase], [60, true, "a couple months"]);
  assert.equal(cadenceRequest("Reach out in a few months, nothing now").days, 90);
  assert.equal(cadenceRequest("Just check in once a month, that's plenty").days, 30);
  assert.equal(cadenceRequest("text me every other month or so").days, 60);
});

test("a time about the house, our own words in a tapback, or a month on its own is not a cadence", () => {
  for (const t of [
    "Liked “No worries. I'll check back in a couple months in case something rough comes across.”",
    "Might be a couple of months though. I'll keep you in mind!",
    "Rents go for 2600-3k/month.",
    "It's been on the market for 6 months",
    "I will have one listed next month, circle back then and I'll send you the listing.",
    "About 99.9% of my properties go on the MLS so I push out the listing to everyone on my investor list as soon as they go live.",
    "happy to add you to my investor list though",
    "Are you a cash buyer or wholesaler?",
  ]) assert.equal(cadenceRequest(t), null, t);
});

test("the cadence fact is the agent's, newest wins, and never goes to GHL", () => {
  assert.equal(FACT_KEYS.checkinEvery.party, "agent");
  let f = withCadence(75, ago(10));
  f = addFact(f, "checkinEvery", { value: "120", at: ago(1) }).facts;
  assert.equal(cadenceDays(f), 120);
  assert.equal(addFact({}, "checkinEvery", { value: "two months" }).added, false, "days, as a number");
  assert.deepEqual(factsFromCustom({ checkinEvery: "90" }, "agent"), [], "no GHL field reads back into it");
});

test("a fresh listing of theirs waits for their cadence too", () => {
  const listing = { listingKey: "L1", firstSeen: ago(3), lastSeen: ago(1), distressRule: "cut-or-cheap",
    doc: { address: "123 Main St, Kent, WA 98031", city: "Kent", qualifies: true, score: 60, distress: { cut: true } } };
  const v = evaluateAgent(agent({ lastInboundAt: ago(20), facts: withCadence(90, ago(20)), listings: [listing] }), ctx);
  assert.equal(v.status, "not_due", v.reason);
  assert.equal(evaluateAgent(agent({ lastInboundAt: ago(20), listings: [listing] }), ctx).pulseReason, "fresh_listing", "without one it goes");
});

test("a 'check back in a couple months' request still owns the agent at day 50, and lets go two weeks after it was due", () => {
  const req = { type: "checkin_requested", at: ago(50), data: { kind: "date", phrase: "a couple months", dueAt: new Date(NOW + 10 * DAY).toISOString() } };
  assert.equal(requestStands(req, NOW), true);
  assert.equal(agentOwner({ events: [req], now: NOW }), "a check-in they asked for");
  assert.equal(requestStands(req, NOW + 25 * DAY), false);
  // An ordinary one still ends at 45 days.
  assert.equal(requestStands({ at: ago(46), data: { dueAt: ago(40) } }, NOW), false);
});

/* ---------- the address chase ---------- */

test("the address chase stops after 'please don't keep asking'", () => {
  for (const t of [
    "Please don't keep asking me. I will definitely let you know when we are ready.",
    "No, you can see them when they're on the market.",
    "I cannot give the address until it lists. We are not allowed to do pocket listings per WA State.",
    "Can't share that sorry",
    "No he's out of the country I'll tell you when he does",
    "Not yet",
    "No",
  ]) assert.ok(refusesAddress(t), t);
});

test("a no that goes on with a lead, or a question, is not a refusal", () => {
  for (const t of [
    "Not yet. I do have a Federal Way duplex coming up that will need a ton of work.",
    "Not yet. Can you check back in two weeks?",
    "I can't tell if it has hardwood floors or lvp",
    "I'll let you know once I hear back from the lender",
    "16211 Hackamore Way E 98022 my phone can't send you photos",
  ]) assert.equal(refusesAddress(t), null, t);
});

test("a vacant lot is land, not a house to chase an address for", () => {
  assert.equal(notAHouse("Unfortunately nothing in my hand. I still have a vacant lot if you have someone interested. They can build a home with a daylight basement."), true);
  assert.equal(notAHouse("I have a vacant land listing coming up in Puyallup"), true);
  assert.equal(notAHouse("I have an older home in Tacoma and two vacant lots next door"), false);
  assert.equal(notAHouse("I will likely have one in Spanaway soon"), false);
});

/* ---------- auto-replies ---------- */

test("a Redfin auto-reply isn't a text waiting on Matt", () => {
  const redfin = "You've reached Redfin, but we actually use a different number for texting - (206) 555-0100. We'll send you a message from that number!";
  assert.equal(isAutoReply(redfin), true);
  assert.equal(autoReplyNumber(redfin), "(206) 555-0100");
  for (const t of [
    "Hello, and thank you for contacting the eXpert Care Desk at eXp Realty. Press 1 for eXp Realty US or Canada. Press 2 for eXp Commercial or Referral",
    "Thank you for messaging eXp Realty. We're excited to connect with you and will be with you in just a moment.",
    "Thank you for your message, we will get back to you shortly. Thank you.",
    "This number does not accept text messages. Please text 555-0100.",
    "This is an automated message: I am out of the office until Monday.",
    "I'm currently out of the office until Oct 20 with limited access to email.",
    "Brokerage: Thank you for opting in to receiving sms messages from us. Message and Data Rates may apply. Reply STOP to stop receiving messages.",
    "I'm driving with Do Not Disturb While Driving turned on. I'll see your message when I get where I'm going.",
  ]) assert.equal(isAutoReply(t), true, t);
  assert.equal(autoReplyNumber("Thank you for your message, we will get back to you shortly."), null, "no number named");
});

test("a person's text that mentions the office, a number or thanks is not an auto-reply", () => {
  for (const t of [
    "Hey, Matt! Sorry for the delay. Was out of the office yesterday. It's in good shape.",
    "Hi, I just heard from the lender. She was out of office. She is reviewing your offer now.",
    "Thank you for reaching out. I don't have anything at the moment but I'll keep you in mind.",
    "So I have this number in my phone as connected to Matt, that's you correct?",
    "Liked “Appreciate it. If anything off-market crosses your desk too, keep us in mind.”",
    "Thanks, Matt. I will share this with my clients and get back to you as soon as we can.",
  ]) assert.equal(isAutoReply(t), false, t);
});

test("their texts going to another number is a row for you, until they write back", () => {
  const ev = { contactId: "a1", type: "texts_elsewhere", at: ago(1), data: { otherNumber: "(206) 555-0100" } };
  const { actions } = buildPipeline({ events: [ev], contactNames: { a1: "Pat Agent" }, now: NOW });
  const row = actions.find((a) => a.kind === "texts_elsewhere");
  assert.ok(row, JSON.stringify(actions));
  assert.match(row.title, /their texts go to another number/);
  assert.match(row.detail, /555-0100/);
  assert.equal(urgentReasons([row]).length, 1, "on Today");
  const answered = buildPipeline({ events: [ev, { contactId: "a1", type: "text_summary", at: ago(0), data: { inbound: "Got it" } }], now: NOW });
  assert.equal(answered.actions.filter((a) => a.kind === "texts_elsewhere").length, 0);
  const old = buildPipeline({ events: [{ ...ev, at: ago(31) }], now: NOW });
  assert.equal(old.actions.filter((a) => a.kind === "texts_elsewhere").length, 0, "a month on, it goes");
});
