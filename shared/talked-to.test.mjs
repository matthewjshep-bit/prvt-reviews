// talked-to.test.mjs — who counts as someone we're building a relationship with.
//
//   node --test shared/talked-to.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { tallyMessages, relationshipOf, isTalkEvent, matchesText } from "./talked-to.js";

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
