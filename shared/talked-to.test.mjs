// talked-to.test.mjs — who counts as someone we're building a relationship with.
//
//   node --test shared/talked-to.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { tallyMessages, relationshipOf, isTalkEvent, matchesText, voicemailGreeting, callEventConnected, realCall, REAL_CALL_SECONDS } from "./talked-to.js";

const sms = (direction) => ({ messageType: "TYPE_SMS", direction });

test("one 'who is this?' after a blast is a reply, not a relationship", () => {
  const talk = tallyMessages([sms("outbound"), sms("inbound")]);
  assert.deepEqual(talk, { replies: 1, calls: 0 });
  assert.equal(relationshipOf({ talk, lastRepliedAt: "2026-09-01", lastMessageAt: "2026-09-01" }), "replied");
});

test("writing back twice is a conversation", () => {
  const talk = tallyMessages([sms("outbound"), sms("inbound"), sms("outbound"), sms("inbound")]);
  assert.equal(relationshipOf({ talk, lastRepliedAt: "2026-09-01" }), "talking");
});

test("a call that connected counts; a missed call or a voicemail drop does not", () => {
  assert.equal(tallyMessages([{ messageType: "TYPE_CALL", direction: "outbound", meta: { call: { duration: 240, status: "completed" } } }]).calls, 1);
  assert.equal(tallyMessages([{ messageType: "TYPE_CALL", direction: "outbound", meta: { call: { duration: 0, status: "no-answer" } } }]).calls, 0);
  assert.equal(tallyMessages([{ messageType: "TYPE_CALL", direction: "inbound", meta: { call: { status: "completed" } } }]).calls, 1, "no duration: trust the status");
  assert.deepEqual(tallyMessages([{ messageType: "TYPE_VOICEMAIL", direction: "inbound" }]), { replies: 0, calls: 0 });
});

test("a buy box the bot learned from them, or a logged call, makes them someone we talk to", () => {
  assert.equal(isTalkEvent({ type: "fact_learned", source: "conversation" }), true);
  assert.equal(isTalkEvent({ type: "call_summary", source: "call" }), true);
  assert.equal(isTalkEvent({ type: "fact_learned", source: "operator" }), false, "copied from a GHL field isn't a conversation");
  assert.equal(relationshipOf({ engagement: { talks: 1 }, lastRepliedAt: "2026-09-01" }), "talking");
  assert.equal(relationshipOf({ engagement: { passed: 1 } }), "talking", "a reasoned no is still a conversation");
});

test("an opted-out contact is never counted as talking, however long the thread", () => {
  assert.equal(relationshipOf({ tags: ["investor", "unsubscribed"], talk: { replies: 9, calls: 2 } }), "opted_out");
  assert.equal(relationshipOf({ tags: ["DNC"], talk: { replies: 3 } }), "opted_out");
});

test("messaged and never answered, or never messaged at all", () => {
  assert.equal(relationshipOf({ lastMessageAt: "2026-09-01" }), "no_reply");
  assert.equal(relationshipOf({}), "never");
});

test("plain search finds a buyer by any part of name, email, phone, city or type", () => {
  const i = {
    name: "Megan Wilaby", email: "megan@example.com", phone: "+12065550100",
    markets: { cities: ["lake-stevens"], regions: ["snohomish"], types: ["mobile-home"] },
    buybox: { areasRaw: "Everett, Marysville" }, tags: ["investor"],
  };
  assert.equal(matchesText(i, ""), true);
  assert.equal(matchesText(i, "megan"), true);
  assert.equal(matchesText(i, "wilaby everett"), true, "every word has to match somewhere");
  assert.equal(matchesText(i, "megan tacoma"), false);
  assert.equal(matchesText(i, "lake stevens"), true);
  assert.equal(matchesText(i, "mobile home"), true);
  assert.equal(matchesText(i, "(206) 555-0100"), true, "phone however it's typed");
  assert.equal(matchesText(i, "5550100"), true);
  assert.equal(matchesText(i, "example.com"), true);
});

// 2026-10-04: three outbound calls that rang through to voicemail became
// texts waiting on Matt — the dialer transcribes the greeting like anyone
// talking. The shapes below are those calls, names changed.
test("a call that reaches their voicemail greeting is a try, not somebody talking", () => {
  assert.deepEqual(voicemailGreeting("THEM: Hi.\nTHEM: This is Sam.\nTHEM: I'm sorry I missed your call.\nTHEM: Please leave me your name and your number.\nTHEM: I will call"), { leftMessage: false });
  assert.deepEqual(voicemailGreeting("THEM: Please leave your message for 2069"), { leftMessage: false });
  assert.deepEqual(voicemailGreeting("THEM: 20 6 5550100 is not available.\nTHEM: I'm sorry.\nTHEM: I think I'm"), { leftMessage: false });
  assert.deepEqual(voicemailGreeting("THEM: Hi. You've reached Sam Rivers at Acme Realty. Please leave your name, number, and a brief message, and I'll get back to you as soon as I can. Thank you very much.\nTHEM: We didn't get your message either because you were not speaking or because of a bad connection. To disconnect"), { leftMessage: false });
  // Matt left a message after the beep (single-channel: his words read as THEM).
  assert.deepEqual(voicemailGreeting("THEM: You've reached Pat Lee, founding adviser with The Lee Group.\nTHEM: I'm unavailable at this time, but please leave me a detailed message.\nTHEM: Thank you.\nTHEM: Hey, Pat.\nTHEM: This is Matt.\nTHEM: I'm calling you about 831 Northwest 52nd. Let me know when you get a sec."), { leftMessage: true });
});

test("a real conversation is never read as a greeting, however it opens", () => {
  assert.equal(voicemailGreeting("THEM: Hello.\nTHEM: This is Dana.\nDana, this is Matt.\nWe've been going back and forth about a few properties here."), null);
  assert.equal(voicemailGreeting("THEM: Who's Matt? Hey. What's up, man? We at the house right now. There's a couple people in front of the house."), null);
  // Opens like a greeting, but runs long: a conversation.
  const long = "THEM: Sorry, I was unavailable earlier.\nTHEM: It's Matt.\n" + "THEM: yeah the seller wants to close fast and the roof is shot. ".repeat(12);
  assert.equal(voicemailGreeting(long), null);
  assert.equal(voicemailGreeting("THEM: Sorry I was unavailable. US: It's Matt, calling about Maple.", { durationSec: 340 }), null, "a five-minute call talked");
  assert.equal(voicemailGreeting(""), null);
  // A short real call that opens with "unavailable" is still a call.
  assert.equal(voicemailGreeting("THEM: Hey, sorry I was unavailable earlier.\nTHEM: It's Matt, calling about Maple. THEM: Yeah the seller is around."), null);
});

// 2026-10-15: a voicemail they left is transcribed, but nobody talked.
test("a voicemail they left is not a conversation", () => {
  assert.equal(callEventConnected({ type: "call_summary", data: { transcribed: true, missed: true, durationSec: 0 } }), false);
  assert.equal(callEventConnected({ type: "call_summary", data: { transcribed: true, durationSec: 240 } }), true);
});

/* ---------- a real call (2026-10-15) ---------- */

// The Flow's Talked station: a phone call is the step that best predicts a
// contract, and a 10-second "can I call you back" isn't one.
test("a real call is 45 seconds or more, one you logged by hand, or a full summary when GHL gave no length", () => {
  const ev = (data, over = {}) => ({ type: "call_summary", source: "call", ref: "m1", data, ...over });
  assert.equal(REAL_CALL_SECONDS, 45);
  assert.equal(realCall(ev({ transcribed: true, durationSec: 45, summary: "x" })), true);
  assert.equal(realCall(ev({ transcribed: true, durationSec: 44, summary: "x" })), false);
  assert.equal(realCall(ev({ transcribed: true, durationSec: 0, summary: "y".repeat(200) })), true, "no length, a summary with something in it");
  assert.equal(realCall(ev({ transcribed: true, summary: "short" })), false);
  assert.equal(realCall(ev({ summary: "called her from my phone" }, { ref: null })), true, "logged by hand");
  assert.equal(realCall(ev({ summary: "They called us (read from GHL by the replier backfill)", backfill: true }, { ref: null, source: "backfill" })), false);
  assert.equal(realCall(ev({ transcribed: true, durationSec: 300, tooShort: true })), false, "a call intake marked too short");
  assert.equal(realCall(ev({ transcribed: false, durationSec: 20, summary: "(call, no transcript available)" })), false);
  assert.equal(realCall(ev({ transcribed: false, durationSec: 90, summary: "(call, no transcript available)" })), true);
  assert.equal(realCall({ type: "text_summary", data: { durationSec: 300 } }), false);
  assert.equal(realCall(ev({ transcribed: true, durationSec: 30 }), { minSec: 30 }), true);
  assert.equal(realCall(ev({ transcribed: true, missed: true, durationSec: 300, summary: "z".repeat(300) })), false, "a voicemail they left is not a call");
});
