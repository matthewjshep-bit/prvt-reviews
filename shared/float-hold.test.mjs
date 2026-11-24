// float-hold.test.mjs — no machine price on a house the agent called done,
// and none in the same burst as our own condition question (2026-11-23
// audit, neg-5). Every street and word here is invented.

import test from "node:test";
import assert from "node:assert/strict";
import { floatHold, asksCondition, CONDITION_WAIT_HOURS } from "./float-hold.js";

const NOW = Date.parse("2026-11-20T19:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const HOUSE = "51 Larch St, Puyallup, WA 98371";
const theirs = (text, h, address = HOUSE) => ({ id: `in-${h}`, status: "sent", party: "agent", inbound: text, propertyAddress: address, createdAt: hoursAgo(h), sentAt: hoursAgo(h - 0.01), reply: "Thanks." });
const ours = (text, h, address = HOUSE) => ({ id: `out-${h}`, status: "sent", party: "agent", inbound: "", outbound: { kind: "agent_pulse" }, propertyAddress: address, createdAt: hoursAgo(h), sentAt: hoursAgo(h), reply: text });

test("an agent who called the house remodeled or not a flip gets no machine number on it", () => {
  for (const text of ["It was fully remodeled last year.", "Not a flip, it's turnkey.", "House is in excellent condition.", "Move-in ready, nothing to do."]) {
    const h = floatHold({ drafts: [theirs(text, 30)], address: HOUSE, now: NOW });
    assert.equal(h?.kind, "turnkey", text);
    assert.match(h.why, /51 Larch St/);
  }
});

test("an agent who said turnkey and then named the work gets the number again", () => {
  const drafts = [theirs("It's turnkey.", 40), theirs("Actually the roof is shot and the furnace is out.", 20)];
  assert.equal(floatHold({ drafts, address: HOUSE, now: NOW }), null);
});

test("another house they called turnkey doesn't stop the number on this one", () => {
  assert.equal(floatHold({ drafts: [theirs("That one's turnkey.", 30, "9 Oak Ave, Kent, WA 98031")], address: HOUSE, now: NOW }), null);
});

test("no number in the same burst as our own condition question", () => {
  const q = ours("Is it big-ticket stuff like roof, foundation or systems, or more paint and flooring? And what's got the seller selling?", 0.05);
  const h = floatHold({ drafts: [theirs("Got a fixer on Larch St, seller wants out.", 1), q], address: HOUSE, now: NOW });
  assert.equal(h?.kind, "asked_condition");
  assert.match(h.why, /haven't answered/);
});

test("once they answer our condition question, or 12 hours pass, the number may go", () => {
  const q = ours("What kind of work does it need?", 3);
  assert.equal(floatHold({ drafts: [q, theirs("Needs a new roof and the kitchen is original.", 2)], address: HOUSE, now: NOW }), null);
  assert.equal(floatHold({ drafts: [{ ...q, sentAt: hoursAgo(CONDITION_WAIT_HOURS + 1), createdAt: hoursAgo(CONDITION_WAIT_HOURS + 1) }], address: HOUSE, now: NOW }), null);
});

test("a question about timing is not a condition question", () => {
  assert.equal(asksCondition("When is the seller hoping to close?"), false);
  assert.equal(asksCondition("What shape is it in?"), true);
  assert.equal(asksCondition("Does it need much work?"), true);
});
