// lead-timing.test.mjs — an agent tells us WHEN a lead will be ready.
//
// 2026-10-14: 17 agents told us when a lead would be ready and 31 named one,
// and every one got the generic "any distressed or off-market houses?" on
// the 14-day clock. These are their phrasings (paraphrased), each one a date
// the check-in should land on and the lead it should name.

import test from "node:test";
import assert from "node:assert/strict";
import { detectLeadTiming, leadCheckInPending, leadCheckInAnswered, LEAD_MAX_DAYS } from "./follow-up.js";

const DAY = 86400000;
// Wednesday 2026-10-14, 1pm Pacific.
const NOW = Date.parse("2026-10-14T20:00:00Z");
const day = (lead) => lead?.when?.slice(0, 10);

/* ---------- the fifteen they told us ---------- */

test("an agent who says the listing goes live next week gets a check-in that week, naming it", () => {
  const l = detectLeadTiming("We'll have something on the market next week", NOW);
  assert.equal(day(l), "2026-10-21");
  assert.match(l.what, /market|listing/);
  assert.equal(l.confidence, "high");
});

test("'one coming up shortly' books a check-in a couple of weeks out, at low confidence", () => {
  const l = detectLeadTiming("I will have one coming up shortly", NOW);
  assert.ok(l);
  assert.equal(day(l), "2026-10-28");
  assert.match(l.what, /coming up/);
  assert.equal(l.confidence, "low");
});

test("a short sale they'll know about by the end of the month is asked about a couple of days after", () => {
  const l = detectLeadTiming("The short sale is in bank underwriting, should know by end of this month", NOW);
  assert.equal(day(l), "2026-11-02");
  assert.match(l.what, /short sale/);
});

test("'if it doesn't sell by end of October she'll pull it until spring' asks just after October, the earlier date", () => {
  const l = detectLeadTiming("If it doesn't sell by end of October she'll pull it until spring", NOW);
  assert.equal(day(l), "2026-11-02");
});

test("springtime means a check-in in March, not every two weeks", () => {
  const l = detectLeadTiming("Taken off market, relisting in springtime", NOW);
  assert.equal(day(l), "2027-03-15");
  assert.match(l.what, /relist/);
});

test("renting it out for six months then relisting is a check-in six months out", () => {
  const l = detectLeadTiming("She's renting it out for 6 months then relisting", NOW);
  assert.equal(day(l), "2027-04-14");
  assert.match(l.what, /relist/);
});

test("a hoarder house coming closer to Nov 1 is a check-in on Nov 1 (a Sunday, so the Monday)", () => {
  const l = detectLeadTiming("Hoarder house, coming closer to Nov 1, give us time to clean out", NOW);
  assert.equal(day(l), "2026-11-02");
  assert.match(l.what, /hoarder/);
});

test("a fixer that's about a year off is a check-in in a year, and 'May have' is not the month of May", () => {
  const l = detectLeadTiming("May have a fixer but not for about a year", NOW);
  assert.equal(day(l), "2027-10-14");
  assert.match(l.what, /fixer/);
});

test("a listing that expires next week into foreclosure is asked about just after it expires", () => {
  const l = detectLeadTiming("Listing expires next week, owners letting it go to foreclosure", NOW);
  assert.equal(day(l), "2026-10-23");
  assert.match(l.what, /expir|foreclosure/);
});

test("an owner listing it in the next few weeks is a check-in three weeks out", () => {
  const l = detectLeadTiming("Owner is listing it in the next few weeks", NOW);
  assert.equal(day(l), "2026-11-04");
  assert.match(l.what, /list/);
});

test("a seller who wants it sold in the next 30 days is a check-in in 30 days", () => {
  const l = detectLeadTiming("Seller wants it sold in the next 30 days", NOW);
  assert.equal(day(l), "2026-11-13");
  assert.match(l.what, /seller/);
});

test("'I should know the condition by Tuesday' asks on Thursday", () => {
  const l = detectLeadTiming("I should know the condition by Tuesday", NOW);
  assert.equal(day(l), "2026-10-22");
});

test("free to talk after October 21st is a check-in the day after the 21st", () => {
  const l = detectLeadTiming("Free to talk after October 21st", NOW);
  assert.equal(day(l), "2026-10-22");
  assert.equal(l.what, "");
});

test("'check back in a couple months' is a check-in in two months, not fourteen days", () => {
  const l = detectLeadTiming("Check back in a couple months", NOW);
  assert.equal(day(l), "2026-12-14");
});

test("walking an unlisted house tomorrow is asked about the day after", () => {
  const l = detectLeadTiming("Walking an unlisted house tomorrow that may fit", NOW);
  assert.equal(day(l), "2026-10-16");
  assert.match(l.what, /unlisted/);
});

/* ---------- what it must not book ---------- */

test("a tapback quoting our own 'I'll check back next week' is not theirs", () => {
  assert.equal(detectLeadTiming("Liked “Sounds good, I'll check back in next month.”", NOW), null);
  assert.equal(detectLeadTiming("👍 to “ No problem, I'll check in next week.”", NOW), null);
});

test("what they think we could do with it is not their lead", () => {
  assert.equal(detectLeadTiming("If you fixed it all up and then relisted it next spring you'd do well", NOW), null);
});

test("a deal closing is not a lead, and a listing they went back on last Friday is not ahead of us", () => {
  assert.equal(detectLeadTiming("Short sale already under contract and closing soon", NOW), null);
  assert.equal(detectLeadTiming("That listing is going to close tomorrow.", NOW), null);
  assert.equal(detectLeadTiming("We just went back on market after our buyers financing failed on friday", NOW), null);
  assert.equal(detectLeadTiming("I originally listed it back in beginning of October of last year", NOW), null);
  assert.equal(detectLeadTiming("I may take off tomorrow for a trip", NOW), null);
  assert.equal(detectLeadTiming("The last tenant moved out about a year or so ago", NOW), null);
});

test("chit-chat about next week with no house in it books nothing", () => {
  assert.equal(detectLeadTiming("Heading to Cabo next week, can't wait!", NOW), null);
  assert.equal(detectLeadTiming("I'm in the office next week if you want to call", NOW), null);
  assert.equal(detectLeadTiming("Thanks Matt, talk soon", NOW), null);
  assert.equal(detectLeadTiming("Sounds good, the house needs a roof and paint", NOW), null);
});

test("something that already happened books nothing", () => {
  assert.equal(detectLeadTiming("It came on the market a few weeks ago", NOW), null);
  assert.equal(detectLeadTiming("We relisted it last month", NOW), null);
  assert.equal(detectLeadTiming("The house was listed in September", NOW), null);
  assert.equal(detectLeadTiming("Been on the market since March", NOW), null);
  assert.equal(detectLeadTiming("Last spring we listed a fixer", NOW), null);
});

test("our offer expiring is not their lead, and a 3/2 is not a date", () => {
  assert.equal(detectLeadTiming("Does your offer expire Friday?", NOW), null);
  const l = detectLeadTiming("3/2 rambler, owner is listing it next week", NOW);
  assert.equal(day(l), "2026-10-21");
});

test("a check-back phrase only counts when the caller allows it (an unlabelled call transcript has our words in it too)", () => {
  assert.ok(detectLeadTiming("I'll circle back in a couple months", NOW));
  assert.equal(detectLeadTiming("I'll circle back in a couple months", NOW, { checkBack: false }), null);
  assert.ok(detectLeadTiming("Relisting in the spring", NOW, { checkBack: false }));
});

test("a lead is never booked more than thirteen months out", () => {
  const l = detectLeadTiming("Owner might list it in 2 years", NOW);
  assert.ok(!l || Date.parse(l.when) <= NOW + LEAD_MAX_DAYS * DAY);
});

/* ---------- which lead is still waiting ---------- */

const req = (at, dueAt, more = {}) => ({ contactId: "c1", type: "checkin_requested", at, data: { kind: "lead", dueAt, lead: { what: "relisting it", when: dueAt }, phrase: "spring", ...more } });

test("a lead booked months ago is still waiting until its day, and a newer unanswered clock doesn't replace it", () => {
  const lead = req("2026-10-14T20:00:00.000Z", "2027-03-15T17:00:00.000Z");
  const events = [lead,
    { contactId: "c1", type: "text_summary", at: "2026-11-20T18:00:00.000Z" },
    { contactId: "c1", type: "checkin_requested", at: "2026-11-20T18:01:00.000Z", data: { kind: "unanswered", dueAt: "2026-11-22T17:00:00.000Z" } }];
  assert.equal(leadCheckInPending(events, Date.parse("2027-01-10T00:00:00Z"))?.at, lead.at, "a November text about something else doesn't settle a March lead");
  assert.equal(leadCheckInAnswered(lead, events), false);
  const sent = [...events, { contactId: "c1", type: "checkin_sent", at: "2027-03-15T18:00:00.000Z", data: { requestAt: lead.at } }];
  assert.equal(leadCheckInPending(sent, Date.parse("2027-03-16T00:00:00Z")), null);
});

test("they brought the lead up themselves in the run-up to its day: the conversation has it, not the clock", () => {
  const lead = req("2026-10-14T20:00:00.000Z", "2026-11-02T17:00:00.000Z");
  const events = [lead, { contactId: "c1", type: "text_summary", at: "2026-10-28T18:00:00.000Z" }];
  assert.equal(leadCheckInAnswered(lead, events), true);
  assert.equal(leadCheckInPending(events, Date.parse("2026-11-02T18:00:00Z")), null);
});
