// opt-out.test.mjs — one read of "did they opt out", for every machine send
// (Matt, 2026-11-09: an opt-out on any channel stops every machine text and
// email, for good; his own texts still go).

import test from "node:test";
import assert from "node:assert/strict";
import { optedOut, dndOn, BLOCK_TAG_RX, OPT_OUT_EVENT, promisesToStop, optOutTagsOf, optedOutLine } from "./opt-out.js";
import { BLOCK_TAG_RX as PULSE_BLOCK_TAG_RX } from "./agent-pulse.js";
import { isBlockedBuyer } from "./buyer-pulse.js";

test("a STOP in GHL (SMS DND) and an email unsubscribe (Email DND) each count, on either channel", () => {
  const sms = { dndSettings: { SMS: { status: "permanent" } } };
  const email = { dndSettings: { Email: { status: "active" } } };
  assert.equal(dndOn(sms, "sms"), true);
  assert.equal(dndOn(sms, "email"), false, "the channel read itself stays honest");
  assert.equal(dndOn(email, "email"), true);
  assert.equal(dndOn({ dnd: true }, "email"), true, "the old top-level flag is both");
  assert.equal(dndOn({ dndSettings: { SMS: { status: "inactive" } } }, "sms"), false);
  assert.equal(dndOn(null, "sms"), false);
  assert.deepEqual(optedOut({ contact: sms }), { via: "sms_dnd", at: null });
  assert.deepEqual(optedOut({ contact: email }), { via: "email_dnd", at: null });
});

test("a do-not-text tag, however it's spelled, and the page's own opt-out tags count", () => {
  for (const t of ["dnc", "DND", "do-not-text", "do not contact", "opted-out", "unsubscribed", "wrong number", "phone-dead"]) {
    assert.equal(BLOCK_TAG_RX.test(t), true, t);
    assert.equal(optedOut({ contact: { tags: ["agent", t] } })?.via, "tag", t);
  }
  assert.equal(optedOut({ contact: { tags: ["agent", "tier-2"] } }), null);
  assert.equal(optedOut({ contact: { tags: ["no-texts-please"] }, optOutTags: ["no-texts-please"] })?.via, "tag");
  assert.equal(PULSE_BLOCK_TAG_RX, BLOCK_TAG_RX, "the agent check-in reads the same tags");
  assert.equal(isBlockedBuyer({ tags: ["phone-dead"] }), true, "a dead number is out of the deal texts too");
});

test("an unsubscribed event or a handled opt-out draft counts, and a waiting maybe holds while it waits", () => {
  assert.deepEqual(optedOut({ events: [{ type: OPT_OUT_EVENT, at: "2026-11-02T18:00:00Z" }] }), { via: "event", at: "2026-11-02T18:00:00Z" });
  assert.deepEqual(optedOut({ drafts: [{ intent: "opt_out", status: "handled", createdAt: "2026-10-30T17:00:00Z" }] }), { via: "draft", at: "2026-10-30T17:00:00Z" });
  assert.equal(optedOut({ drafts: [{ intent: "opt_out", status: "dismissed" }] }), null, "a row you threw away says nothing");
  assert.equal(optedOut({ drafts: [{ intent: "question", status: "sent" }] }), null);
  assert.equal(optedOut({ drafts: [{ intent: "rejection", status: "draft", optOutMaybe: true, createdAt: "2026-11-08T17:00:00Z" }] })?.via, "maybe");
  assert.equal(optedOut({ drafts: [{ intent: "rejection", status: "dismissed", optOutMaybe: true }] }), null, "you dismissed the maybe: not an opt-out");
  assert.equal(optedOut({ events: [{ type: "text_summary", at: "2026-11-02T18:00:00Z" }] }), null);
  assert.equal(optedOut({}), null);
});

test("a bot-off tag is not an opt-out tag: the stop-bot tag still holds, it doesn't bin", () => {
  const config = { optOut: { tags: ["stop bot", "dnc"] }, routing: { botOffTags: ["stop bot", "bot-off"] } };
  assert.deepEqual(optOutTagsOf(config), ["dnc"]);
  assert.deepEqual(optOutTagsOf({ optOut: { tags: ["quiet-*"] }, routing: { botOffTags: ["quiet-*"] } }), []);
  assert.deepEqual(optOutTagsOf(null), []);
});

test("our own reply that promises to stop is read as their opt-out", () => {
  for (const t of ["Understood, I won't text you again.", "Got it, I'll take you off my list.", "No problem, I'll remove you.", "Sorry about that, we won't contact you anymore."]) {
    assert.equal(promisesToStop(t), true, t);
  }
  for (const t of ["I won't text you again until it's back on the market.", "Thanks, talk soon.", "I'll take you up on that.", "We won't text you again about this one, just the next fixer."]) {
    assert.equal(promisesToStop(t), false, t);
  }
});

test("the reason line says how they opted out and that your own texts still go", () => {
  assert.match(optedOutLine({ via: "sms_dnd" }), /they opted out \(texted STOP\): the machine starts nothing; your own texts still go/);
  assert.match(optedOutLine({ via: "email_dnd" }), /unsubscribed from email/);
  assert.match(optedOutLine({ via: "tag", tag: "dnc" }), /tagged dnc/);
  assert.match(optedOutLine({ via: "maybe" }), /may have opted out/);
});

test("our reply that takes a buyer off one area's list, or off one house, isn't their opt-out", () => {
  // Read as a promise to stop, the buyer would never get another deal text.
  for (const t of ["Got it, I'll take you off the Tacoma list and keep you on King.", "Sure, I'll take you off for that one.",
    "I'll remove you from the Pierce list.", "I'll take you off my list for duplexes, still sending flips."]) {
    assert.equal(promisesToStop(t), false, t);
  }
  for (const t of ["I'll take you off.", "Understood, I'll take you off our list, sorry for the bother.", "I'll remove you from our texting list right away.",
    "No problem, I'll remove you", "Done, I took you off the list."]) {
    assert.equal(promisesToStop(t), true, t);
  }
});
