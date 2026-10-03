// in-play.test.mjs — every agent with something live, one row each: the
// view that replaces walking GHL's Tier 1 stage and the Offers tab.

import test from "node:test";
import assert from "node:assert/strict";
import { buildInPlay, inPlayCounts, stageOf } from "./in-play.js";

const NOW = Date.parse("2026-10-02T20:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const offer = (over = {}) => ({ id: "o1", contactId: "c1", contactName: "Dana R", address: "9311 12th Pl SE, Lake Stevens, WA", cashAmount: 197500,
  status: "sent", statusAt: ago(5), createdAt: ago(6), sends: [{ ts: ago(5) }], nextFollowUp: { kind: "offer_nudge", label: "Nudge", who: "machine", at: ago(-2) }, ...over });

test("one row per agent, led by their best house, ours against theirs on each", () => {
  const rows = buildInPlay([
    offer(),
    offer({ id: "o2", address: "1 Elm St, Kent, WA", status: "countered", cashAmount: 300000, counter: { amount: 320000 } }),
    offer({ id: "o3", contactId: "c2", contactName: "Kel B", address: "5 Ash St", status: "sent" }),
  ], { now: NOW });
  assert.equal(rows.length, 2);
  const dana = rows.find((r) => r.contactId === "c1");
  assert.equal(dana.stage, "countered", "the best house leads");
  assert.deepEqual(dana.houses.map((h) => [h.stage, h.ours, h.theirs]), [["countered", 300000, 320000], ["sent", 197500, 0]]);
  assert.equal(dana.lead.id, "o2");
});

test("an open offer with nothing scheduled is a leak and sorts first; waiting on you is shown apart", () => {
  const rows = buildInPlay([
    offer({ id: "a", contactId: "fine", contactName: "Fine" }),
    offer({ id: "b", contactId: "leak", contactName: "Leak", nextFollowUp: { kind: "none", label: "None scheduled" } }),
    offer({ id: "c", contactId: "you", contactName: "You", nextFollowUp: { kind: "reply_owed", label: "Their text is waiting on you", who: "you" } }),
  ], { now: NOW });
  assert.deepEqual(rows.map((r) => r.contactId), ["leak", "you", "fine"]);
  assert.equal(rows[0].leakLabel, "nothing scheduled");
  const c = inPlayCounts(rows);
  assert.equal(c.leaks, 1);
  assert.equal(c.yours, 1);
});

test("only the current offer on a house counts, a house passed long ago isn't in play, and a closed deal is history", () => {
  const rows = buildInPlay([
    offer({ id: "old", cashAmount: 416500, createdAt: ago(60), sends: [{ ts: ago(60) }] }),
    offer({ id: "new", cashAmount: 400000, createdAt: ago(3), sends: [{ ts: ago(3) }] }),
    offer({ id: "p", contactId: "gone", status: "passed", statusAt: ago(90) }),
    offer({ id: "d", contactId: "closed", status: "accepted", deal: { stage: "closed" } }),
  ], { now: NOW });
  assert.deepEqual(rows.map((r) => r.contactId), ["c1"]);
  assert.deepEqual(rows[0].houses.map((h) => h.offerId), ["new"]);
  assert.equal(stageOf(offer({ status: "passed", statusAt: ago(2) })), "recent");
  assert.equal(stageOf(offer({ status: "draft", autoUnderwrite: { jobId: "j", held: ["only 1 priced comps"] } })), "held");
  assert.equal(stageOf(offer({ deal: { stage: "under_contract" } })), "deal");
  assert.equal(stageOf(offer({ status: "sent", realm: { answer: "yes", ts: ago(1) } })), "hot");
});
