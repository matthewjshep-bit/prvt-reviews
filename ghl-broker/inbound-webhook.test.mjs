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
import { readFile } from "node:fs/promises";
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

test("every webhook actually calls the extractor, not String() on the raw field", async () => {
  // This test exists because the fix shipped twice without working. Both the
  // underwrite and the conversation handler had the identical line
  // `String(b.message || b.body || …)`, a one-occurrence replace patched the
  // first one, and the unit tests above stayed green the whole time — they
  // proved the helper worked, not that anybody called it.
  const src = await readFile(new URL("./routes/offers.js", import.meta.url), "utf8");
  const raw = src.match(/String\(\s*b\.message\b[^)]*\)/g) || [];
  assert.deepEqual(raw, [], `read the message through pickInboundText, not String(b.message …): ${raw.join(" / ")}`);
  // Both webhooks read it the same way.
  assert.equal((src.match(/=\s*pickInboundText\(b\)|:\s*pickInboundText\(b\)/g) || []).length, 3,
    "the underwrite webhook, the conversation webhook and the try-it route all extract the text the same way");
});

test("no router-scope helper reads locationId as a free variable", async () => {
  // This shipped: findLiveDealFor was lifted out of conversationDeps, where
  // locationId was a parameter, into the router factory, where it is nothing.
  // Every call threw ReferenceError and the outbox reported it as
  // "mark investor passed failed" — a scope bug wearing a domain error's
  // clothes. locationId is a REQUEST value; a helper must take it.
  const src = await readFile(new URL("./routes/offers.js", import.meta.url), "utf8");
  const lines = src.split("\n");
  const free = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^  (?:async )?function ([A-Za-z0-9_]+)\(([^)]*)\)/.exec(lines[i]);
    if (!m) continue;
    let body = "";
    for (let j = i + 1; j < lines.length && !/^  \}/.test(lines[j]); j++) body += lines[j] + "\n";
    if (!/\blocationId\b/.test(body)) continue;
    const declared = /\blocationId\b/.test(m[2]) ||
      /(?:const|let)\s*\{[^}]*\blocationId\b[^}]*\}\s*=/.test(body) ||
      /(?:const|let)\s+locationId\b/.test(body);
    if (!declared) free.push(`${m[1]} (line ${i + 1})`);
  }
  assert.deepEqual(free, [], `these read locationId from a scope that has none: ${free.join(", ")}`);
});
