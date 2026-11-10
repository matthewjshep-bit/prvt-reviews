// Matt, 2026-11-10: the bot never books, asks for or promises a call, and
// never names a time to talk. Every phrase here is made up.
import test from "node:test";
import assert from "node:assert/strict";
import {
  promisesACall, callWordsFlags, CALL_WORDS_FLAG_RX, CALL_INVITE, NO_CALL_RULE, asksForACall, namedTime, callWanted,
  BOOKING_RETIRED, CALL_ASK_RETIRED,
} from "./call-words.js";

test("a draft that promises a call, asks for one or sets a time to talk is caught", () => {
  for (const said of [
    "I'll call you this afternoon.",
    "Let me give you a quick call on that.",
    "Let me give you a call on the terms.",
    "I'll give you a ring tomorrow.",
    "I'll call you back.",
    "Will call you back in a bit.",
    "I'll be calling you shortly.",
    "I can call you tomorrow.",
    "Sounds good, talk at 3.",
    "Great, talk then.",
    "Does Thursday at 2 work?",
    "Would tomorrow morning work for you?",
    "How about 3pm?",
    "What time works for a call?",
    "Let's hop on a call.",
    "Happy to jump on a quick call if that's easier.",
    "Can we chat tomorrow?",
    "Worth a quick call?",
    "Do you have time for a quick call?",
    "Let's go over the terms on a quick call.",
    "Easier to walk you through it on a quick call.",
    "I'll run the numbers and give you a call if it makes sense.",
    "If you've got other fixers coming up, a quick 5-minute call this week would be great, what time works?",
    "Give me a call tomorrow at 10.",
    "When's a good time to call?",
    "Are you free tomorrow afternoon?",
  ]) {
    assert.notEqual(promisesACall(said), "", said);
    const [flag] = callWordsFlags(said);
    assert.match(flag, CALL_WORDS_FLAG_RX, said);
    assert.ok(flag.includes(CALL_INVITE), "the flag tells the redraft what to say instead");
    assert.ok(flag.length <= 200, `${flag.length} characters survives the redraft's clip`);
  }
});

test("'call me whenever' is not a promise", () => {
  for (const said of [
    "Call me whenever, or text here.",
    CALL_INVITE,
    "Call me whenever if it's easier.",
    "Feel free to call.",
    "Call or text anytime.",
    "You can call me anytime.",
    "Give me a call whenever.",
    "Talk soon.",
    "Good talking today.",
    "Sorry I missed your call.",
    "Let me run the numbers on this one and text you where we'd land.",
    "What's the seller hoping to get?",
    "Does the seller need to close by Friday?",
    "Is the seller open to a quick close?",
    "Any other fixers coming up, on or off-market?",
  ]) assert.equal(promisesACall(said), "", said);
  assert.deepEqual(callWordsFlags("Call me whenever, or text here."), []);
});

test("their words quoted back are theirs, not a promise of ours", () => {
  assert.equal(promisesACall("You said \"call me Thursday at 2\", and texting works too."), "");
  assert.equal(promisesACall("You said “I'll call you tomorrow”, so I'll watch for it."), "");
  assert.notEqual(promisesACall("You said text, but I'll call you tomorrow."), "");
});

// A buyer may be invited to a deal's walkthrough window (Matt, 2026-09-29);
// beside a call the same words hold.
test("a buyer may be offered the walkthrough window, never a time to talk", () => {
  assert.equal(promisesACall("Does Saturday at 11 work to walk it?", { party: "investor" }), "");
  assert.equal(promisesACall("What day works to get out there?", { party: "investor" }), "");
  assert.notEqual(promisesACall("Does Saturday at 11 work for a quick call?", { party: "investor" }), "");
  assert.notEqual(promisesACall("I'll call you after the walkthrough.", { party: "investor" }), "");
  assert.notEqual(promisesACall("Does Saturday at 11 work to walk it?"), "", "an agent is never offered a time");
});

test("what they asked: a call or a time, and only the time words come back", () => {
  assert.equal(asksForACall("Can you call me Thursday at 2?"), true);
  assert.equal(asksForACall("give me a ring when you can"), true);
  assert.equal(asksForACall("Let's talk tomorrow morning"), true);
  assert.equal(asksForACall("Do you have a few minutes for a quick call?"), true);
  assert.equal(asksForACall("Is it still available?"), false);
  assert.equal(asksForACall("Please don't call me, text only"), false);
  assert.equal(namedTime("Can you call me Thursday at 2?"), "Thursday at 2");
  assert.equal(namedTime("call me after 3pm tomorrow, the seller signs tonight"), "after 3pm tomorrow");
  assert.equal(namedTime("Nice place, 3 beds 2 baths on a corner"), "");
  assert.equal(namedTime("is it still available?"), "");
});

test("an agent or buyer who wants a call or a walkthrough is one Matt hears about; anyone else isn't", () => {
  assert.deepEqual(callWanted({ party: "agent", intent: "wants_call", message: "call me Thursday at 2" }), { intent: "wants_call", wants: "call", when: "Thursday at 2" });
  assert.deepEqual(callWanted({ party: "agent", intent: "scheduling", message: "I'm free tomorrow morning" }), { intent: "scheduling", wants: "call", when: "tomorrow morning" });
  assert.deepEqual(callWanted({ party: "investor", intent: "wants_walkthrough", message: "can I see it saturday" }), { intent: "wants_walkthrough", wants: "walkthrough", when: "saturday" });
  // Their words ask for a call even when the reply read it as a question.
  assert.deepEqual(callWanted({ party: "agent", intent: "question", message: "what's the number? easier if you call me at 4pm" }), { intent: "wants_call", wants: "call", when: "at 4pm" });
  assert.equal(callWanted({ party: "agent", intent: "question", message: "what's the number?" }), null);
  assert.equal(callWanted({ party: "agent", intent: "question", message: "don't call me, text is better" }), null);
  assert.equal(callWanted({ party: "unknown", intent: "wants_call", message: "call me" }), null);
});

test("booking and the call ask are retired, and the rule says call me whenever", () => {
  assert.equal(BOOKING_RETIRED, true);
  assert.equal(CALL_ASK_RETIRED, true);
  assert.ok(NO_CALL_RULE.includes(CALL_INVITE));
  assert.match(NO_CALL_RULE, /never promise a call, ask for one, book one or name a time to talk/);
});
