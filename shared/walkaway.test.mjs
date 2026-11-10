// walkaway.test.mjs — the machine negotiates up to the offer engine's walk-away, and no further.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWalkaway, walkawayOffer, walkawayReply, pushesOnPrice, WALKAWAY_MAX_MOVES } from "./walkaway.js";

// An engine grade-A offer: opened at 335.5k, walk-away 350.5k.
const offer = (over = {}) => ({ cashAmount: 335500, autoUnderwrite: { basis: "engine" }, pricing: { live: true, grade: "A", walkAway: 350500, moves: 0 }, ...over });
const said = { theirOwnWords: true };

test("a counter at or under the walk-away is taken at their number", () => {
  const v = evaluateWalkaway({ offer: offer(), theirAmount: 345000, ...said });
  assert.equal(v.passed, true);
  assert.equal(v.releaseAmount, 345000);
  assert.equal(v.counterBack, false);
  assert.equal(walkawayReply({ amount: 345000, street: "4417 Somerset Ln", theirs: true }), "345k works for us on 4417 Somerset Ln. Sending the updated offer over now.");
});

test("a 5% counter on a grade-A house moves halfway, never past the walk-away", () => {
  const v = evaluateWalkaway({ offer: offer(), theirAmount: 355000, ...said }); // just over the walk-away
  assert.equal(v.passed, true);
  assert.equal(v.counterBack, true);
  assert.equal(v.releaseAmount, 345250, "halfway from our 335.5k to their 355k");
  assert.equal(v.final, false);
  assert.match(walkawayReply({ amount: 345250, street: "4417 Somerset Ln" }), /^We can come up to 345,250 on 4417 Somerset Ln\./);
  const far = evaluateWalkaway({ offer: offer(), theirAmount: 368000, ...said }); // 5% over: halfway would pass it
  assert.equal(far.releaseAmount, 350500, "never past the walk-away");
  assert.equal(far.final, true);
  const second = evaluateWalkaway({ offer: offer({ cashAmount: 345000, pricing: { live: true, grade: "A", walkAway: 350500, moves: 1 } }), theirAmount: 362000, ...said });
  assert.equal(second.releaseAmount, 350500, "the second move is the walk-away itself");
  assert.equal(second.final, true);
  assert.match(walkawayReply({ amount: 350500, street: "4417 Somerset Ln", final: true }), /^Best we can do on 4417 Somerset Ln is 350,500 as-is\./);
  assert.doesNotMatch(walkawayReply({ amount: 350500, final: true }), /cash/, "we fund with a hard money loan");
});

test("the third counter gets no move: both are spent, and it's a call for Matt", () => {
  const v = evaluateWalkaway({ offer: offer({ cashAmount: 350500, pricing: { live: true, grade: "A", walkAway: 350500, moves: WALKAWAY_MAX_MOVES } }), theirAmount: 360000, ...said });
  assert.equal(v.passed, false);
  assert.match(v.reason, /both moves made/);
});

test("a counter more than 10% over the walk-away spends no move", () => {
  const v = evaluateWalkaway({ offer: offer(), theirAmount: 400000, ...said });
  assert.equal(v.passed, false);
  assert.match(v.reason, /more than 10% over the 350500 walk-away/);
});

test("a number the agent didn't type never moves us", () => {
  const v = evaluateWalkaway({ offer: offer(), theirAmount: 345000, theirOwnWords: false });
  assert.equal(v.passed, false);
  assert.match(v.reason, /isn't in their own message/);
});

test("a counter on a number Matt typed still waits for him", () => {
  assert.equal(walkawayOffer(offer({ approved: { by: "revise", amount: 335500 } })), false);
  assert.equal(walkawayOffer(offer({ revisions: [{ by: "you", ts: "2026-11-10T00:00:00Z" }] })), false);
  assert.equal(walkawayOffer(offer({ pin: { at: "2026-11-10T00:00:00Z" } })), false);
  assert.equal(walkawayOffer(offer({ pricing: { live: true, grade: "B", walkAway: 350500 } })), false, "grade B keeps today's rule");
  assert.equal(walkawayOffer(offer({ pricing: { live: false, grade: "A", walkAway: 350500 } })), false, "a shadow answer is not an offer");
  assert.equal(walkawayOffer(offer()), true);
  const v = evaluateWalkaway({ offer: offer({ approved: { by: "revise" } }), theirAmount: 345000, ...said });
  assert.equal(v.passed, false);
});

test("a lower number we texted after the offer moved stops the walk-away", () => {
  const v = evaluateWalkaway({ offer: offer(), theirAmount: 345000, ...said, comeDown: { amount: 320000 } });
  assert.equal(v.passed, false);
  assert.match(v.reason, /different number/);
});

// Matt, 2026-11-04: "if they push back on us on price, can we proactively offer a higher counter,
// ratcheting up to our own walkaway?" No number of theirs needed: halfway to the walk-away, then the
// walk-away itself, then it's his.
test("pushback with no number moves us halfway to the walk-away, then to the walk-away, then it's yours", () => {
  const first = evaluateWalkaway({ offer: offer(), pushback: true });
  assert.equal(first.passed, true, first.reason);
  assert.equal(first.counterBack, true);
  assert.equal(first.releaseAmount, 343000, "halfway from our 335.5k to the 350.5k walk-away");
  assert.equal(first.final, false);
  assert.equal(first.pushback, true);

  const second = evaluateWalkaway({ offer: offer({ cashAmount: 343000, pricing: { live: true, grade: "A", walkAway: 350500, moves: 1 } }), pushback: true });
  assert.equal(second.passed, true, second.reason);
  assert.equal(second.releaseAmount, 350500);
  assert.equal(second.final, true);
  assert.match(walkawayReply({ amount: 350500, street: "4417 Somerset Ln", final: true }), /^Best we can do on 4417 Somerset Ln is 350,500 as-is\./);

  const third = evaluateWalkaway({ offer: offer({ cashAmount: 350500, pricing: { live: true, grade: "A", walkAway: 350500, moves: 2 } }), pushback: true });
  assert.equal(third.passed, false);
  assert.match(third.reason, /both moves made/);
});

test("a pushback with no number never moves an offer a person priced, and a plain no isn't a pushback", () => {
  assert.equal(evaluateWalkaway({ offer: offer({ approved: { by: "revise", amount: 335500 } }), pushback: true }).passed, false);
  const none = evaluateWalkaway({ offer: offer() });
  assert.equal(none.passed, false, "no number and no pushback: nothing to answer");
  assert.match(none.reason, /no number read/);
});

test("too low, come up, not enough is a push on price; sold, pending or another offer is not", () => {
  for (const m of ["That's way too low", "Seller needs more than that", "can you come up at all?", "not enough for them unfortunately",
    "They won't take that", "Is there any wiggle room?", "lowball, seller laughed", "not even close to what they want"]) {
    assert.equal(pushesOnPrice(m), true, m);
  }
  for (const m of ["Seller went with another offer", "It's pending now", "too low, and they accepted another offer anyway",
    "not interested", "They're under contract", "Seller decided not to sell", "We have multiple offers, best and final by 5", ""]) {
    assert.equal(pushesOnPrice(m), false, m);
  }
});

// OFF-08 (2026-11-09): a no that isn't about price stepped our number up. "They won't do that, the
// seller's going to rent it out" and "it needs more work than the photos show" read as pushes.
test("a seller who is going to rent it instead doesn't get a higher number", () => {
  for (const m of ["They can't do that, the seller is going to rent it out instead", "Seller's going to rent it for now",
    "They'd rather rent it out than take that", "won't do that, they want to hold off until spring", "Seller wants to wait on it",
    "They're waiting until the spring market", "not ready to sell at that number yet", "Seller isn't ready to let it go"]) {
    assert.equal(pushesOnPrice(m), false, m);
  }
});

test("'it needs more work' isn't a push on price", () => {
  for (const m of ["it needs more work than the photos show", "honestly it needs more repairs than that", "seller needs more time to move out",
    "needs more work before anyone could live there", "Not enough time for an inspection before the holidays"]) {
    assert.equal(pushesOnPrice(m), false, m);
  }
  for (const m of ["Seller needs more than that", "they need more money to make it work", "needs more for the seller to say yes",
    "That's not enough", "not enough for them unfortunately"]) {
    assert.equal(pushesOnPrice(m), true, m);
  }
});
