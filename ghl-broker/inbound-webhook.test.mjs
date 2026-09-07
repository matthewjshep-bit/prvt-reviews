// inbound-webhook.test.mjs — reading the text out of a GHL webhook body.
//
// The failure this guards against actually shipped: GHL's Inbound Message
// trigger sends `message` as an object on some triggers and a string on
// others. String(object) is "[object Object]" — non-empty, so it passed the
// "message required" guard, and every draft on the tab was the model
// politely replying to garbage ("that came through blank on my end"). It
// also poisoned auto-send: an unreadable message classifies as `other` at
// low confidence, which the gates correctly refuse, so nothing ever sent.
//
//   node --test inbound-webhook.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { pickInboundText, isStringifiedObject } from "./routes/offers.js";

test("the text is found whichever shape GHL sends", () => {
  // The shape that broke it: the Inbound Message trigger's own payload.
  assert.equal(pickInboundText({ message: { body: "still available?", type: "SMS", attachments: [] } }), "still available?");
  // The shapes that already worked, which must keep working.
  assert.equal(pickInboundText({ message: "still available?" }), "still available?");
  assert.equal(pickInboundText({ body: "still available?" }), "still available?");
  assert.equal(pickInboundText({ customData: { message: "still available?" } }), "still available?");
  assert.equal(pickInboundText({ customData: { body: "still available?" } }), "still available?");
  assert.equal(pickInboundText({ text: "still available?" }), "still available?");
  // Other names GHL has used for the same field.
  assert.equal(pickInboundText({ message: { text: "still available?" } }), "still available?");
  assert.equal(pickInboundText({ message: { content: "still available?" } }), "still available?");
});

test("an object with no text reads as empty, so the guard can refuse it", () => {
  // A bare photo: no words, only attachments. Empty here is correct — the
  // route falls through to its attachment path instead of drafting a reply
  // to "[object Object]".
  assert.equal(pickInboundText({ message: { type: "SMS", attachments: ["https://x/p.jpg"] } }), "");
  assert.equal(pickInboundText({}), "");
  assert.equal(pickInboundText({ message: null }), "");
  assert.equal(pickInboundText({ message: {} }), "");
  assert.equal(pickInboundText({ message: 12345 }), "", "a number is not a message");
  // Never the string that started all this.
  for (const b of [{ message: {} }, {}, { message: { attachments: [] } }]) {
    assert.equal(pickInboundText(b).includes("[object"), false);
  }
});

test("the first candidate that actually has words wins", () => {
  // An empty object body must not shadow a real string further down.
  assert.equal(pickInboundText({ message: {}, body: "the real text" }), "the real text");
  assert.equal(pickInboundText({ message: "   ", customData: { message: "the real text" } }), "the real text");
});

test("a stringified object is never a message, whoever produced it", () => {
  // The belt to the braces: if some other path stringifies an object again,
  // it reads as no message and the route refuses it, rather than spending a
  // model call and texting a real person "that came through blank on my end".
  assert.equal(pickInboundText({ message: "[object Object]" }), "");
  assert.equal(pickInboundText({ body: "  [object Object]  " }), "");
  assert.equal(pickInboundText({ message: { body: "[object Object]" } }), "");
  // A real field further down still wins over a poisoned one above it.
  assert.equal(pickInboundText({ message: { body: "[object Object]" }, customData: { message: "is 22018 still open?" } }), "is 22018 still open?");

  assert.equal(isStringifiedObject("[object Object]"), true);
  assert.equal(isStringifiedObject("[object Promise]"), true);
  assert.equal(isStringifiedObject(" [object Object] "), true);
  // Must not swallow a real message that happens to mention the words.
  assert.equal(isStringifiedObject("object oriented design"), false);
  assert.equal(isStringifiedObject("[object Object] is what I saw on my screen"), false);
  assert.equal(isStringifiedObject(""), false);
  assert.equal(isStringifiedObject(null), false);
});
