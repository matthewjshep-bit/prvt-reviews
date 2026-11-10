// offer-raise.test.mjs — a sent offer's price goes up only when a person says so.

import test from "node:test";
import assert from "node:assert/strict";
import { wentOut, lastSentAmount, raiseCeiling, raiseNeedsConfirm, raiseLine } from "./offer-raise.js";

const went = (ts) => ({ ts, channels: ["sms"], results: { sms: { ok: true } } });
const failed = (ts) => ({ ts, channels: ["sms"], results: { sms: { ok: false, error: "blocked" } } });

test("an offer nobody was sent has no ceiling", () => {
  const o = { status: "new", cashAmount: 254000 };
  assert.equal(wentOut(o), false);
  assert.equal(lastSentAmount(o), 0);
  assert.equal(raiseNeedsConfirm({ offer: o, to: 300000 }), null);
  // A send that failed on every channel didn't reach them either.
  assert.equal(wentOut({ status: "new", cashAmount: 254000, sends: [failed("2026-11-05T18:00:00Z")] }), false);
});

test("the number they were sent is the one in effect at the newest send that went", () => {
  const o = { status: "sent", cashAmount: 240000,
    sends: [went("2026-11-05T18:00:00Z"), failed("2026-11-07T18:00:00Z")],
    revisions: [
      { ts: "2026-11-04T18:00:00Z", from: 250000, to: 254000, by: "you" },
      { ts: "2026-11-06T18:00:00Z", from: 254000, to: 240000, by: "you", live: true },
    ] };
  assert.equal(lastSentAmount(o), 254000, "the 240k came after the send and never went");
  assert.equal(raiseNeedsConfirm({ offer: o, to: 254000 }), null, "back up to what they have is no raise");
  assert.deepEqual(raiseNeedsConfirm({ offer: o, to: 300000 }), { from: 254000, to: 300000 });
});

test("marked sent by hand, or floated, the ceiling is today's number", () => {
  assert.equal(lastSentAmount({ status: "countered", cashAmount: 312500 }), 312500);
  assert.equal(lastSentAmount({ status: "new", cashAmount: 199000, floatSentAt: "2026-11-05T18:00:00Z" }), 199000);
});

test("an engine offer's walk-away is room up to it, and the line says what moves", () => {
  const o = { status: "sent", cashAmount: 254000, sends: [went("2026-11-05T18:00:00Z")], pricing: { live: true, grade: "A", walkAway: 268000 } };
  assert.equal(raiseCeiling(o), 268000);
  assert.equal(raiseNeedsConfirm({ offer: o, to: 268000 }), null);
  assert.deepEqual(raiseNeedsConfirm({ offer: o, to: 300000 }), { from: 268000, to: 300000 });
  // A shadow price (not live) is no approval.
  assert.equal(raiseCeiling({ ...o, pricing: { live: false, walkAway: 268000 } }), 254000);
  assert.equal(raiseLine({ from: 254000, to: 300000 }), "This raises a sent offer from 254k to 300k: confirm?");
  assert.equal(raiseLine({ from: 254000, to: 301750 }), "This raises a sent offer from 254k to 301,750: confirm?");
});
