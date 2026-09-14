// reply-take-shorthand.test.mjs — an agent's own numbers, read out of the way
// agents actually write them, so a re-quote has something to run on.

import test from "node:test";
import assert from "node:assert/strict";
import { agentTakeFromText } from "./reply-agent.js";

test("Thomas Rinow, 2026-09-14: 'even at 60 in repairs' is a $60,000 rehab take", () => {
  const t = agentTakeFromText("No even close. Even at 60 in repairs were well over  your price. On a half acre with 2389 sq fr with Rv lot  the home is worth much more. Sorry");
  assert.equal(t.rehab, 60000);
  assert.equal(t.arv, 0, "'worth much more' is not a number");
});

test("explicit units and dollar figures stand as written", () => {
  assert.equal(agentTakeFromText("probably 45k of work").rehab, 45000);
  assert.equal(agentTakeFromText("rehab is $38,500").rehab, 38500);
  assert.equal(agentTakeFromText("worth 850k fixed up").arv, 850000);
});

test("a value range with decimals is millions, at its midpoint", () => {
  const t = agentTakeFromText("Closer to 1.6-1.8 value. Depends if you tore the garage down");
  assert.equal(t.arv, 1700000);
});

test("'715 done, maybe 40k of work' reads both halves", () => {
  const t = agentTakeFromText("I'd say 715 done, maybe 40k of work, mostly cosmetic");
  assert.equal(t.arv, 715000);
  assert.equal(t.rehab, 40000);
});

test("a price they want is a counter, never a take", () => {
  assert.equal(agentTakeFromText("Their lowest at this time is $700k."), null);
  assert.equal(agentTakeFromText("You need to be at $610-620"), null);
  assert.equal(agentTakeFromText("Closed."), null);
  assert.equal(agentTakeFromText("Not right now...I'll let you know"), null);
});

test("nonsense sizes are dropped rather than trusted", () => {
  assert.equal(agentTakeFromText("It could use around $3M in cosmetics and HVAC."), null, "$3M of work is a misread for a take");
});
