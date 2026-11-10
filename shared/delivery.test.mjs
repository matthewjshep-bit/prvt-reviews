// delivery.test.mjs — reading a send's delivery back (shared/delivery.js).
//
// 2026-11-09 audit: 22 of our answers to someone who had just written never
// arrived since 10-01 and nothing noticed; 160 machine texts went to numbers
// that had already come back dead. Names, streets and words below are made up.

import test from "node:test";
import assert from "node:assert/strict";
import {
  carrierCode, deliveryVerdict, classifyFailure, numberDead, stripLinks, undeliveredAnswers, undeliveredWhy, deliveryRunGate, deliveryFailed,
  SEND_FAILED, DELIVERY_MAX_DAILY_TRIES, DELIVERY_EVERY_MS, DELIVERY_STALE_RUN_MS,
} from "./delivery.js";
import { normalizeConversationAi } from "./conversation-ai.js";

test("the delivery check ships off, and switching it on survives a save", () => {
  assert.deepEqual(normalizeConversationAi({}).deliveryWatch, { enabled: false });
  assert.deepEqual(normalizeConversationAi(null).deliveryWatch, { enabled: false });
  assert.deepEqual(normalizeConversationAi({ deliveryWatch: { enabled: true } }).deliveryWatch, { enabled: true });
  const saved = normalizeConversationAi({ deliveryWatch: { enabled: true } });
  assert.equal(normalizeConversationAi(JSON.parse(JSON.stringify(saved))).deliveryWatch.enabled, true, "a second save keeps it");
});

const NOW = Date.parse("2026-11-09T20:00:00Z"); // Monday, noon Pacific
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const failed = (contactId, at, data = {}, over = {}) => ({ id: `e-${contactId}-${at}`, contactId, type: SEND_FAILED, at, party: "agent", address: "", data: { channel: "sms", ...data }, ...over });

test("a reply GHL marked 30007 reads as a carrier block, and a code is never read out of what we said", () => {
  assert.equal(carrierCode({ status: "undelivered", error: "Error 30007: Message blocked due to carrier policies" }), "30007");
  assert.equal(carrierCode({ status: "failed", meta: { error: { code: 30006 } } }), "30006");
  assert.equal(carrierCode({ status: "failed", error: { message: "Unreachable destination handset (30003)" } }), "30003");
  assert.equal(carrierCode({ status: "delivered", body: "Is 30007 Birch Rd still open to offers?" }), null, "a house number in the text is not an error");
  assert.equal(carrierCode(null), null);

  const v = deliveryVerdict({ status: "undelivered", error: "Error 30007" });
  assert.deepEqual(v, { status: "undelivered", code: "30007", failed: true, pending: false });
  assert.equal(deliveryVerdict({ status: "delivered" }).failed, false);
  assert.equal(deliveryVerdict({ status: "pending" }).pending, true, "the carrier hasn't answered yet: look again later");
  assert.equal(deliveryVerdict({ status: "", code: "30005" }).failed, true, "a code with no status is a failure");

  assert.equal(classifyFailure("30007"), "carrier_block");
  assert.equal(classifyFailure(30005), "dead_number");
  assert.equal(classifyFailure("30006"), "dead_number");
  assert.equal(classifyFailure("30003"), "unreachable");
  assert.equal(classifyFailure("30022"), "limit");
  assert.equal(classifyFailure("30023"), "limit");
  assert.equal(classifyFailure("30008"), "other");
  assert.equal(classifyFailure(null), "other");
  assert.equal(classifyFailure("30007", "email"), "email_policy");

  // What the nightly audit asks of a sent draft once the check has read it.
  assert.equal(deliveryFailed({ status: "sent", delivery: { status: "undelivered", code: "30007" } }), true);
  assert.equal(deliveryFailed({ status: "sent", delivery: { status: "delivered", code: null } }), false);
  assert.equal(deliveryFailed({ status: "sent" }), false, "no verdict yet is not a failure");
});

test("a number that came back as a landline is dead after one text, an unreachable one only after two", () => {
  assert.equal(numberDead([failed("c1", minsAgo(300), { code: "30006", class: "dead_number" })]), true);
  assert.equal(numberDead([failed("c1", minsAgo(300), { code: "30005" })]), true, "read from the code when the class is missing");
  const once = [failed("c1", minsAgo(300), { code: "30003", class: "unreachable" })];
  assert.equal(numberDead(once), false, "30003 is sometimes temporary");
  assert.equal(numberDead([...once, failed("c1", minsAgo(200), { code: "30003", class: "unreachable" })]), true);
  assert.equal(numberDead([failed("c1", minsAgo(300), { code: "30007", class: "carrier_block" })]), false, "a blocked text says nothing about the phone");
  assert.equal(numberDead([failed("c1", minsAgo(300), { channel: "email", class: "email_policy" })]), false, "an email is not their phone");
  assert.equal(numberDead([]), false);
  assert.equal(deliveryVerdict({ status: "bounced" }).failed, true, "a bounced email is a failure");
});

test("a dead number texted again by a person, or given a new phone, is alive once a text arrives", () => {
  const dead = [failed("c1", minsAgo(600), { code: "30006", class: "dead_number" })];
  assert.equal(numberDead(dead), true);
  const ok = { contactId: "c1", type: "phone_ok", at: minsAgo(300), data: {} };
  assert.equal(numberDead([...dead, ok]), false, "the strike before it no longer counts");
  assert.equal(numberDead([...dead, ok, failed("c1", minsAgo(100), { code: "30005", class: "dead_number" })]), true, "a new one after it does");
});

test("a blocked deal text comes back without its link and still ends on a question", () => {
  assert.equal(
    stripLinks("Hey Robin, got 88 Quill Ct in Kent under contract. Buyer price 261k. Photos and numbers: https://deals.example.com/r/ab12"),
    "Hey Robin, got 88 Quill Ct in Kent under contract. Buyer price 261k. Want the details?");
  assert.equal(
    stripLinks("Hey Robin, new one in Kent: 88 Quill Ct. Buyer price 261k. Interested? Full package: deals.example.com/r/ab12"),
    "Hey Robin, new one in Kent: 88 Quill Ct. Buyer price 261k. Interested?");
  assert.equal(
    stripLinks("Hey Robin, 88 Quill Ct just went under contract. Walkthrough is Sat 10am. Can you make it? Everything's here: https://deals.example.com/r/ab12"),
    "Hey Robin, 88 Quill Ct just went under contract. Walkthrough is Sat 10am. Can you make it?");
  const plain = "Hey Robin, got 88 Quill Ct in Kent. Want the details?";
  assert.equal(stripLinks(plain), plain, "a text with no link is left as it is");
});

test("a question whose answer the carrier blocked stays on the list until something reaches them", () => {
  const answer = failed("ann", minsAgo(180), { code: "30007", class: "carrier_block", answer: true, draftId: "d-ann", messageId: "m-ann" }, { address: "12 Alder Ln, Kent, WA" });
  const rows = undeliveredAnswers([answer], { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "undelivered");
  assert.equal(rows[0].id, "undelivered:m-ann");
  assert.equal(rows[0].title, "Your answer on 12 Alder Ln didn't reach them (the carrier blocked it): call or email");
  assert.equal(undeliveredWhy({ cls: "dead_number" }), "Your answer didn't reach them (the number is dead or a landline): call or email");

  // The summary the failed draft wrote, or the nightly sweep's, is not them.
  const own = { contactId: "ann", type: "text_summary", at: minsAgo(170), source: "conversation", ref: "d-ann" };
  const sweep = { contactId: "ann", type: "text_summary", at: minsAgo(60), source: "sweep", ref: "s1" };
  assert.equal(undeliveredAnswers([answer, own, sweep], { now: NOW }).length, 1);
  // Matt texted, called or emailed, or they wrote again: off the list.
  for (const type of ["hand_reply", "call_summary", "email_sent"]) {
    assert.equal(undeliveredAnswers([answer, { contactId: "ann", type, at: minsAgo(30), source: "operator" }], { now: NOW }).length, 0, type);
  }
  assert.equal(undeliveredAnswers([answer, { contactId: "ann", type: "text_summary", at: minsAgo(30), source: "conversation", ref: "d-new", data: { inbound: "You there?" } }], { now: NOW }).length, 0);
  // A call nobody picked up reached nobody.
  assert.equal(undeliveredAnswers([answer, { contactId: "ann", type: "call_summary", at: minsAgo(30), source: "call", data: { missed: true } }], { now: NOW }).length, 1);
  // A check-in of ours writes a summary too, with no words of theirs: still on the list.
  assert.equal(undeliveredAnswers([answer, { contactId: "ann", type: "text_summary", at: minsAgo(30), source: "conversation", ref: "d-pulse", data: { inbound: "" } }], { now: NOW }).length, 1);
  // A machine text that failed is not an answer; a buyer's goes to Slack, not here; a week on, it's gone.
  assert.equal(undeliveredAnswers([failed("bo", minsAgo(180), { code: "30007", answer: false })], { now: NOW }).length, 0);
  assert.equal(undeliveredAnswers([failed("cy", minsAgo(180), { code: "30007", answer: true }, { party: "investor" })], { now: NOW }).length, 0);
  assert.equal(undeliveredAnswers([failed("di", minsAgo(8 * 24 * 60), { code: "30007", answer: true })], { now: NOW }).length, 0);
});

test("the delivery check is due every two hours, retries a stale run and stops after its daily tries", () => {
  const first = deliveryRunGate({}, NOW);
  assert.equal(first.go, true);
  assert.equal(first.tries, 1);
  const ran = { day: first.day, tries: 1, lastRun: new Date(NOW).toISOString(), run: null };
  assert.equal(deliveryRunGate(ran, NOW + 15 * 60000).go, false, "the next tick: not due");
  assert.equal(deliveryRunGate(ran, NOW + DELIVERY_EVERY_MS).go, true, "two hours on: due");

  const going = { ...ran, run: { startedAt: new Date(NOW).toISOString() } };
  assert.equal(deliveryRunGate(going, NOW + 10 * 60000).why, "a run is going");
  const retried = deliveryRunGate(going, NOW + DELIVERY_STALE_RUN_MS + 60000);
  assert.equal(retried.go, true, "a run a deploy killed is retried once it's stale");
  assert.equal(retried.stale, true);
  assert.equal(retried.tries, 2);

  assert.equal(deliveryRunGate({ ...ran, failed: true }, NOW + 25 * 60000).go, true, "a failed run is retried before the two hours");
  assert.equal(deliveryRunGate({ ...ran, failed: true }, NOW + 5 * 60000).go, false, "but not straight away");

  const spent = { day: first.day, tries: DELIVERY_MAX_DAILY_TRIES, lastRun: new Date(NOW - DELIVERY_EVERY_MS).toISOString() };
  assert.equal(deliveryRunGate(spent, NOW).go, false);
  assert.match(deliveryRunGate(spent, NOW).why, /tries today/);
  assert.equal(deliveryRunGate(spent, NOW + 24 * 3600000).go, true, "a new day starts the count again");
});
