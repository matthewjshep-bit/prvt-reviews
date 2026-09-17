// thread-health.test.mjs — when the machine stops pushing.

import test from "node:test";
import assert from "node:assert/strict";
import { threadHealth, unansweredMachineTexts, STOP_REASONS } from "./thread-health.js";

const NOW = Date.parse("2026-09-17T20:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const offer = (over = {}) => ({ id: "o1", contactId: "c1", address: "12 Elm St, Renton, WA", status: "sent", cashAmount: 300000, ...over });
const theirs = (text, d, over = {}) => ({ id: `in${d}`, contactId: "c1", status: "sent", party: "agent", intent: "question", inbound: text, reply: "ok", createdAt: ago(d), sentAt: ago(d), ...over });
const nudge = (d, kind = "offer_nudge", over = {}) => ({ id: `n${d}`, contactId: "c1", status: "sent", party: "agent", intent: kind, outbound: { kind }, inbound: "", reply: "Checking in on Elm.", createdAt: ago(d), sentAt: ago(d), autoSent: true, ...over });
const health = (o = {}) => threadHealth({ offer: offer(), now: NOW, ...o });

test("a live thread with nothing wrong is driven", () => {
  const h = health({ drafts: [theirs("what's your timeline?", 1)] });
  assert.equal(h.drive, true);
  assert.equal(h.reason, "");
});

test("two nudges with nothing back stops the machine", () => {
  const drafts = [theirs("let me ask the seller", 9), nudge(5), nudge(2)];
  assert.equal(unansweredMachineTexts(drafts, []), 2);
  const h = health({ drafts });
  assert.equal(h.drive, false);
  assert.equal(h.reason, "two_unanswered");
  assert.match(h.detail, /2 texts from us since they last wrote/);
});

test("one nudge is not two, and a reply resets the count", () => {
  assert.equal(health({ drafts: [theirs("hm", 9), nudge(5)] }).drive, true);
  assert.equal(health({ drafts: [nudge(9), nudge(7), theirs("sorry, been slammed", 3), nudge(1)] }).drive, true);
});

test("a reply we wrote to something they said is not a nudge", () => {
  assert.equal(unansweredMachineTexts([theirs("q1", 3), theirs("q2", 2)], []), 0);
});

test("a rejection stops it, and so does a dead offer", () => {
  assert.equal(health({ drafts: [theirs("seller won't go that low, we're going to pass", 1, { intent: "rejection" })] }).reason, "rejected");
  assert.equal(health({ offer: offer({ status: "passed" }) }).reason, "rejected");
  assert.equal(health({ offer: offer({ status: "we_passed" }) }).reason, "rejected");
});

test("pending or sold stops it, but 'sold as is' and 'a few went pending nearby' do not", () => {
  assert.equal(health({ drafts: [theirs("it's pending now, sorry", 1)] }).reason, "pending_or_sold");
  assert.equal(health({ drafts: [theirs("it is being sold as is", 1)] }).drive, true);
  assert.equal(health({ drafts: [theirs("a few went pending in the area last month", 1)] }).drive, true);
});

test("an irritated agent stops it", () => {
  for (const t of ["Please stop texting me about this", "I already told you the price is firm", "how many times do I have to say no", "is this a bot?", "leave me alone"]) {
    const h = health({ drafts: [theirs(t, 1)] });
    assert.equal(h.drive, false, t);
    assert.equal(h.reason, "irritated", t);
  }
  assert.equal(health({ drafts: [theirs("can you stop by the house Thursday?", 1)] }).drive, true, "'stop by' is not 'stop'");
});

test("irritation is read from their newest messages, not one from last month we have since got past", () => {
  const drafts = [theirs("I already told you, no", 30), theirs("ok send it over", 20), theirs("got it thanks", 10), theirs("any word from your partner?", 1)];
  assert.equal(health({ drafts }).drive, true);
});

test("somebody who unsubscribed or opted out is never driven", () => {
  assert.equal(health({ events: [{ type: "unsubscribed", contactId: "c1", at: ago(1) }] }).reason, "opted_out");
  assert.equal(health({ drafts: [theirs("STOP", 1, { intent: "opt_out" })] }).reason, "opted_out");
});

test("Stop on Today holds until Resume", () => {
  const stop = { type: "drive_stopped", contactId: "c1", at: ago(2), data: { reason: "calling her myself" } };
  const h = health({ events: [stop] });
  assert.equal(h.reason, "stopped_by_you");
  assert.match(h.detail, /calling her myself/);
  assert.equal(health({ events: [stop, { type: "drive_resumed", contactId: "c1", at: ago(1) }] }).drive, true);
});

test("a stop on one house does not stop another house with the same agent", () => {
  const stop = { type: "drive_stopped", contactId: "c1", at: ago(2), offerId: "other", data: {} };
  assert.equal(health({ events: [stop] }).drive, true);
  assert.equal(health({ events: [{ ...stop, offerId: "o1" }] }).drive, false);
  assert.equal(health({ events: [{ ...stop, offerId: null }] }).drive, false, "a stop with no house is the whole thread");
});

test("a person who answered has it", () => {
  const h = health({ drafts: [theirs("call me", 0.1, { status: "dismissed", answeredBy: "you", reply: "" })] });
  assert.equal(h.reason, "person_has_it");
  assert.equal(health({ drafts: [theirs("call me", 5, { status: "dismissed", answeredBy: "you" })] }).drive, true, "three days on, it is the machine's again");
});

test("a deal is past driving", () => {
  assert.equal(health({ offer: offer({ status: "accepted", deal: { stage: "under_contract" } }) }).reason, "live_deal");
});

test("the first reason found is the strongest one", () => {
  const h = health({ events: [{ type: "unsubscribed", contactId: "c1", at: ago(1) }], drafts: [nudge(5), nudge(2)] });
  assert.equal(h.reason, "opted_out");
  assert.ok(STOP_REASONS.indexOf("opted_out") < STOP_REASONS.indexOf("two_unanswered"));
});

test("no offer at all: the thread alone is judged", () => {
  assert.equal(threadHealth({ drafts: [theirs("hi", 1)], now: NOW }).drive, true);
  assert.equal(threadHealth({ drafts: [nudge(5, "outreach_nudge"), nudge(2, "outreach_nudge")], now: NOW }).reason, "two_unanswered");
});
