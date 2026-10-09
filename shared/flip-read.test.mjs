import test from "node:test";
import assert from "node:assert/strict";
import { flipRead, qualifyStep, QUALIFY_ASKS, QUALIFY_ASK_RX, QUALIFY_PASSES } from "./flip-read.js";

// The kinds of answer to our first text that, on 2026-10-08, each started an
// underwrite (paraphrased); the vague ones should have bought one question.
test("'cosmetic fixer', 'it's a project' and 'great price!' are an agent selling, not a flip", () => {
  for (const said of [
    "Cosmetic fixer",
    "Probably a project, you could make a bit on it I think",
    "Older farmhouse, it could use a rehab",
    "Great price! Shop with a bathroom and a few wooded acres",
    "Flooring in the hall and bedrooms and bath. Kitchen is nice. Maybe new counters",
    "Dated inside, wood paneling everywhere.",
    "Have a few offers coming this weekend, seller needs to close asap",
  ]) assert.equal(flipRead(said).qualifies, false, said);
});

test("specific trouble the agent volunteers is a flip on its own", () => {
  for (const said of [
    "Post and block foundation, one corner has settled and the floors are uneven",
    "Structural issues, a few leaks, some mold",
    "Fun project, the seller is a bit of a hoarder",
    "Custom build that was never completed",
    "Mossy roof that may need replacing, kitchen needs replacing, bathroom needs repair",
    "Roof needs work and the seller is relocating out of state",
  ]) assert.equal(flipRead(said).qualifies, true, said);
});

test("their own rehab budget of 50k or more is a real scope", () => {
  assert.equal(flipRead("Maybe 50-75K in updates", { agentRehab: 62500 }).qualifies, true);
  assert.equal(flipRead("maybe 20k of updates", { agentRehab: 20000 }).qualifies, false);
});

test("trouble they rule out, or work already done, doesn't count", () => {
  assert.equal(flipRead("No foundation issues, solid roof, just needs paint").qualifies, false);
  assert.equal(flipRead("New roof, updated kitchen, needs carpet").qualifies, false);
  assert.equal(flipRead("my gut says it will go fast").qualifies, false);
});

test("one question, then a pass that asks for what else they have", () => {
  const ask = qualifyStep({ words: "Cosmetic fixer" });
  assert.equal(ask.move, "ask");
  assert.match(ask.reply, QUALIFY_ASK_RX);
  const pass = qualifyStep({ words: "Cosmetic fixer\nmostly paint and floors, seller wants list", asked: true });
  assert.equal(pass.move, "pass");
  assert.match(pass.reply, /off-market/);
  assert.equal(qualifyStep({ words: "Cosmetic fixer\nhonestly the foundation is cracked", asked: true }).move, "underwrite");
  assert.equal(qualifyStep({ words: "still nice", asked: true, passed: true }).move, "closed");
});

test("every wording of our question is one we recognise in the thread, and every text is short", () => {
  for (const q of QUALIFY_ASKS) { assert.match(q, QUALIFY_ASK_RX); assert.ok(q.length <= 160, q); }
  for (const p of QUALIFY_PASSES) { assert.doesNotMatch(p, QUALIFY_ASK_RX); assert.ok(p.length <= 180, p); assert.doesNotMatch(p, /[—$]/); }
});
