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

test("an agent who says it's turnkey gets the open door, not a second question about the same listing", () => {
  // Both agents who did this offered their next house a minute later.
  for (const said of ["This one's turnkey, the sellers redid it before listing.", "This is turnkey, move in ready.", "54th is updated. Check out another one in Tacoma"]) {
    const step = qualifyStep({ words: said, variant: 0 });
    assert.equal(step.move, "pass", said);
    assert.match(step.reply, /off-market|off market/i, "the pass asks for what else they've got");
  }
  for (const vague of ["The kitchen was remodeled but the rest needs work", "it needs to be updated", "Updated kitchen, original baths", "not turnkey, needs a roof"]) {
    assert.equal(qualifyStep({ words: vague }).move, "ask", vague);
  }
});

test("a seller going through a life event is a real lead on its own — POA, executor, a spouse who died, assisted living", () => {
  for (const said of ["Her brother is the POA, she's in assisted living now", "Son is the executor", "His wife died last year and he wants it gone", "power of attorney is handling it"]) {
    assert.deepEqual(flipRead(said).strong, ["life event"], said);
    assert.equal(qualifyStep({ words: said }).move, "underwrite", said);
  }
  assert.deepEqual(flipRead("seller is elderly").strong, [], "age alone is a reason to sell, not a flip");
});

test("the pass says what we buy and names one seller that becomes a deal, so agents stop bringing park homes and acreage", async () => {
  const { OUR_BOX_WORDS } = await import("./asset-type.js");
  assert.match(OUR_BOX_WORDS, /^single-family/);
  for (const p of QUALIFY_PASSES) {
    assert.ok(p.includes(OUR_BOX_WORDS), p);
    assert.match(p, /estate|into care|move by a date/, p);
  }
});

test("\"it is not a project, it's a great home\" is a turnkey answer", () => {
  assert.equal(qualifyStep({ words: "It is not a project. Its a great home. Large sq ft and a dock." }).move, "pass");
  assert.equal(qualifyStep({ words: "Big project, it's a lot of house" }).move, "ask");
});

// Matt, 2026-10-14: our own reply turned the house down while its intent
// said "has a deal", and the intent ran Tier 1 and an underwrite. These are
// the live replies (2026-10-06 → 10-14), and the ones that still chase.
import { ourReplyPasses } from "./flip-read.js";
test("our reply passing on the house reads as a pass; a reply still chasing one doesn't", () => {
  for (const said of [
    "Sounds mostly cosmetic, probably not enough meat for us on that one. Got anything more distressed sitting right now?",
    "Sounds like mostly cosmetic stuff, not the heavy lift we're after. Anything else on your radar that's more distressed or stale?",
    "Sounds like mostly cosmetic stuff, not quite the heavy lift I'm usually after. Appreciate the details though.",
    "Bathrooms alone sounds pretty light for us, we're usually after bigger stuff. Got anything else sitting?",
    "Sounds like a light one for us then, we focus on bigger rehab plays.",
    "That Milton one sounds nice but fully remodeled isn't really our lane, we're after stuff needing work.",
    "Appreciate the update. Mostly after places needing real work, so I'll keep watching for that one.",
    "Ah, cosmetic usually means it's not quite distressed enough for us. Anything else on your desk?",
    "Appreciate the numbers. Turns out Fox Rd's outside the box for us size-wise, so we've moved on from that one for now.",
    "We'd already moved on from that one for now, Brent. Got anything else sitting that needs work?",
    // The qualify step stamps its own pass; these two read as one anyway.
    ...QUALIFY_PASSES.slice(0, 2),
  ]) assert.equal(ourReplyPasses(said), true, said);
  for (const said of [
    "Good to know. What do you think it'd be worth fixed up, and what would you budget for the work?",
    "Appreciate the rundown, think we'll pass on 184th given the subdivide angle. Keep me posted on that Mount Vernon one though, sounds like a good fit for us.",
    "Got both. Gutted one in Seattle sounds like our lane. What's the seller's situation and timeline on that?",
    "That's lighter than what we modeled for rehab. What do you think it'd actually sell for once it's fixed up?",
    "Good to know. I'll run the numbers with underwriting today and get back to you.",
    ...QUALIFY_ASKS,
    "",
  ]) assert.equal(ourReplyPasses(said), false, said);
});
