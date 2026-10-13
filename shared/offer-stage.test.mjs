// offer-stage.test.mjs — Draft · Sent · Responded, derived from the stored status.
//
// What would go wrong without these:
//   - a number we texted would sit in Draft, so the card never reached Offer Out
//   - a hot offer would read as plain Sent or Countered and drop off Responded
//   - an offer nobody answered would sit in Sent forever (Matt: no reply = passed)
//   - a deal that fell through would read as Accepted
//
//   node --test offer-stage.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { offerStage, offerStageAt, stageCounts, OFFER_STAGES, RESPONDED_SUBS } from "./offer-stage.js";

const st = (o) => { const s = offerStage(o); return s.sub ? `${s.stage}/${s.sub}` : s.stage; };

test("a held draft and a priced offer nobody has seen are drafts", () => {
  assert.equal(st({ status: "draft" }), "draft");
  assert.equal(st({ status: "new", cashAmount: 300000 }), "draft");
  assert.equal(st({ cashAmount: 300000 }), "draft");
});

test("a number we texted counts as sent, before any paper goes", () => {
  assert.equal(st({ status: "new", floatSentAt: "2026-10-10T18:00:00Z" }), "sent");
  assert.equal(st({ status: "new", floatedAt: "2026-10-10T18:00:00Z" }), "sent");
  assert.equal(offerStage({ status: "new", floatSentAt: "2026-10-10T18:00:00Z" }).why, "our number went by text");
});

test("a float that was only drafted is not sent", () => {
  assert.equal(st({ status: "new", proactive: { realmCheckAt: "2026-10-10T18:00:00Z" } }), "draft");
});

test("the written offer going out is sent", () => {
  assert.equal(st({ status: "sent" }), "sent");
  assert.equal(st({ sends: [{ ts: "2026-10-10T18:00:00Z" }] }), "sent");
});

test("their counter is responded / countered", () => {
  assert.equal(st({ status: "countered", counter: { amount: 320000 } }), "responded/countered");
});

test("a hot offer is responded / hot, whether it was sent or countered underneath", () => {
  assert.equal(st({ status: "sent", hot: { at: "2026-10-11T00:00:00Z", by: "operator" } }), "responded/hot");
  assert.equal(st({ status: "countered", realm: { answer: "yes", ts: "2026-10-11T00:00:00Z" } }), "responded/hot");
  assert.equal(st({ status: "new", floatSentAt: "2026-10-10T00:00:00Z", realm: { answer: "yes", ts: "2026-10-11T00:00:00Z" } }), "responded/hot");
});

test("a cooled offer goes back to its stage", () => {
  assert.equal(st({ status: "sent", hot: { off: true, at: "2026-10-11T00:00:00Z" }, realm: { answer: "yes", ts: "2026-10-10T00:00:00Z" } }), "sent");
});

test("every way it ends without a deal is passed, and says which", () => {
  for (const [status, why] of [["passed", "they passed"], ["we_passed", "we passed"], ["unavailable", "no longer available"], ["no_response", "no reply"]]) {
    const s = offerStage({ status, hot: { at: "2026-10-11T00:00:00Z", by: "operator" } });
    assert.deepEqual([s.stage, s.sub, s.why], ["responded", "passed", why], status);
  }
});

test("accepted and a live deal are responded / accepted; a fell-through deal is passed", () => {
  assert.equal(st({ status: "accepted" }), "responded/accepted");
  assert.equal(st({ status: "accepted", deal: { stage: "under_contract" } }), "responded/accepted");
  assert.equal(st({ status: "accepted", deal: { stage: "closed" } }), "responded/accepted");
  assert.equal(st({ status: "accepted", deal: { stage: "fell_through" } }), "responded/passed");
});

test("offerStageAt is the newest of status, send, float, heat and deal stage", () => {
  const at = offerStageAt({
    createdAt: "2026-10-01T00:00:00Z", statusAt: "2026-10-03T00:00:00Z",
    sends: [{ ts: "2026-10-05T00:00:00Z" }], floatSentAt: "2026-10-04T00:00:00Z",
    hot: { at: "2026-10-06T00:00:00Z" }, deal: { createdAt: "2026-10-07T00:00:00Z", stageHistory: [{ stage: "buyer_found", ts: "2026-10-08T00:00:00Z" }] },
  });
  assert.equal(at, Date.parse("2026-10-08T00:00:00Z"));
  assert.equal(offerStageAt({}), null);
});

test("stageCounts counts each row once by stage and once by sub", () => {
  const c = stageCounts([{ status: "draft" }, { status: "sent" }, { status: "countered" }, { status: "passed" }, { status: "accepted" }]);
  assert.deepEqual(c, { draft: 1, sent: 1, responded: 3, hot: 0, countered: 1, accepted: 1, passed: 1 });
  assert.deepEqual(OFFER_STAGES.map((s) => s.key), ["draft", "sent", "responded"]);
  assert.deepEqual(RESPONDED_SUBS.map((s) => s.key).sort(), ["accepted", "countered", "hot", "passed"]);
});
