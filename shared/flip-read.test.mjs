import test from "node:test";
import assert from "node:assert/strict";
import { flipRead, qualifyStep, QUALIFY_ASKS, QUALIFY_ASK_RX, QUALIFY_PASSES, broughtStep, saysCosmeticOnly, workBudgetIn, saysRealWork, asksTheirRehab } from "./flip-read.js";

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

// 2026-10-17 (Matt: "short and sweet, personable, and to the point"): the
// pass no longer lists what we buy or names a kind of seller; it thanks them
// and asks for their other fixers, the way the bot's answer to Brenda did.
test("the pass is a thanks and their other fixers, short, with no list of what we buy", () => {
  for (const p of QUALIFY_PASSES) {
    assert.ok(p.length <= 160, p);
    assert.match(p, /fixers|needs work|needs real work/, p);
    assert.match(p, /on or off-market|listed or off-market/, p);
    assert.doesNotMatch(p, /single-family|into care|move by a date/, p);
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
    // 2026-10-15: the one that answered a yes to our 261k.
    "We've actually moved on from this one for now. Anything else that needs work?",
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

/* ---------- the call ask (2026-10-15) ---------- */

import { FIXERS_CALL_ASKS, QUALIFY_ASKS_CALL, QUALIFY_PASSES_CALL, CALL_ASK_RX, FIXERS_ASK_RX, withCallAsk } from "./flip-read.js";
test("the call ask is one closing question for other fixers and a quick call, with no day or time in it", () => {
  for (const t of [...FIXERS_CALL_ASKS, ...QUALIFY_ASKS_CALL, ...QUALIFY_PASSES_CALL]) {
    assert.match(t, CALL_ASK_RX, t);
    assert.ok(t.length <= 220, t);
    assert.doesNotMatch(t, /[—$]|\b(?:monday|tuesday|wednesday|thursday|friday|tomorrow|\d{1,2}\s*(?:am|pm))\b/i, t);
  }
  for (const t of FIXERS_CALL_ASKS) { assert.match(t, FIXERS_ASK_RX); assert.equal((t.match(/\?/g) || []).length, 1, t); }
  for (const q of QUALIFY_ASKS_CALL) assert.match(q, QUALIFY_ASK_RX, "still read as our one question");
  for (const p of QUALIFY_PASSES_CALL) { assert.doesNotMatch(p, QUALIFY_ASK_RX); assert.match(p, /off-market/); }
  assert.match(qualifyStep({ words: "Cosmetic fixer", callAsk: true }).reply, CALL_ASK_RX);
  assert.match(qualifyStep({ words: "This is turnkey, move in ready.", callAsk: true }).reply, CALL_ASK_RX);
  assert.doesNotMatch(qualifyStep({ words: "Cosmetic fixer" }).reply, CALL_ASK_RX, "off, the question is as it was");
});

test("the backstop ends the reply on the call ask, taking over a closing ask for other houses", () => {
  const out = withCallAsk("Makes sense, that one's not for us then. Anything else sitting that needs work?");
  assert.equal((out.match(/\?/g) || []).length, 1, out);
  assert.match(out, /^Makes sense, that one's not for us then\. /);
  assert.match(out, CALL_ASK_RX);
  const kept = withCallAsk("Got it, thanks for the update.");
  assert.match(kept, /^Got it, thanks for the update\. If /);
  const already = "Appreciate it. Got 5 minutes for a quick call this week?";
  assert.equal(withCallAsk(already), already, "a reply that already asks for a call is left alone");
});

test("withFixersAsk ends a reply on one ask for other fixers, and leaves a reply that already asks alone", async () => {
  const { withFixersAsk, FIXERS_ASK_RX, CALL_ASK_RX } = await import("./flip-read.js");
  const t = withFixersAsk("Makes sense, that one's not for us then.", 0);
  assert.match(t, FIXERS_ASK_RX);
  assert.doesNotMatch(t, CALL_ASK_RX);
  const already = "Got it. Anything else sitting that needs work?";
  assert.equal(withFixersAsk(already, 1), already);
  const swapped = withFixersAsk("Thanks! Keep me in mind?", 2);
  assert.doesNotMatch(swapped, /keep me in mind/i, "the stay-in-touch question is taken over");
  assert.equal((swapped.match(/\?/g) || []).length <= 1, true);
});

/* ---------- houses the agent brings us (qualifyFirst.brought, 2026-10-16) ---------- */

test("a work budget in their words is read, the low end of a range, and a list price or a year is not", () => {
  assert.equal(workBudgetIn("Probably 50-75K in updates"), 50000);
  assert.equal(workBudgetIn("about 60k of work"), 60000);
  assert.equal(workBudgetIn("rehab around 80,000"), 80000);
  assert.equal(workBudgetIn("$45,000 in updates"), 45000);
  assert.equal(workBudgetIn("listed at 550k"), 0);
  assert.equal(workBudgetIn("built in 1962"), 0);
  assert.equal(workBudgetIn("2 to 3 weeks of work"), 0);
});

test("cosmetic only means light words and nothing big-ticket, nothing vague, nothing distressed", () => {
  assert.equal(saysCosmeticOnly("Mainly paint and carpet, pretty dated"), true);
  assert.equal(saysCosmeticOnly("Cosmetic fixer"), true);
  // The flips the first read would have passed (backtest on 132 brought houses).
  assert.equal(saysCosmeticOnly("Seller is 99 years old. Needs a roof, repairs on deck and cosmetic work."), false);
  assert.equal(saysCosmeticOnly("Probably a new roof Carpet doors paint appliances Windows are good"), false);
  assert.equal(saysCosmeticOnly("Rambler, needs some work and updates"), false, "vague: the question sorts it");
  assert.equal(saysCosmeticOnly("More than cosmetic, it's dated throughout"), false);
  assert.equal(saysCosmeticOnly("Cosmetic, but the foundation is settling"), false);
  assert.equal(saysCosmeticOnly(""), false);
});

// 62710 Dixon Loop (2026-10-22): "needs updating throughout for sure and
// some things weren't done right or with permits and it was added onto over
// the years" read as cosmetic. Bad or unpermitted past work is a project.
test("work that wasn't done right, or without permits, is never cosmetic", () => {
  assert.equal(saysCosmeticOnly("It needs updating throughout for sure and some things weren't done right or with permits and it was added onto over the years"), false);
  assert.equal(saysCosmeticOnly("Dated, and the addition is unpermitted"), false);
  assert.equal(saysCosmeticOnly("Some updating, the deck was built without a permit"), false);
  assert.equal(saysCosmeticOnly("Mainly paint and carpet, pretty dated"), true);
});

test("a house the agent brings: trouble drafts it, cosmetic passes, unclear asks once, and still unclear after that drafts it", () => {
  assert.equal(broughtStep({ words: "Hoarder house, needs everything" }).move, "underwrite");
  assert.equal(broughtStep({ words: "Probably 50-75K in updates" }).move, "underwrite", "their own budget");
  assert.equal(broughtStep({ words: "Just needs paint and carpet" }).move, "pass");
  assert.match(broughtStep({ words: "Just needs paint and carpet" }).reply, /on or off-market|listed or off-market/);
  assert.equal(broughtStep({ words: "It's turnkey, fully remodeled" }).move, "pass");
  assert.equal(broughtStep({ words: "Have this one for you, 4417 Somerset Ln" }).move, "ask");
  assert.equal(broughtStep({ words: "It needs some work", asked: true }).move, "underwrite", "their own house: worth Matt's look");
  assert.equal(broughtStep({ words: "Just needs paint", passed: true }).move, "closed");
});

test("an off-market cosmetic house with the seller's number is still drafted (7034 S K St became a contract)", () => {
  const s = broughtStep({ words: "7034 South K. $250,000. Off market. Cosmetic fixer", offMarket: true, sellerAsk: 250000 });
  assert.equal(s.move, "underwrite");
  assert.match(s.read.why, /off-market, with the seller's number/);
  assert.equal(broughtStep({ words: "Cosmetic fixer", offMarket: true, sellerAsk: 0 }).move, "pass", "no number: the pass");
});

// 217 N French Ave (2026-10-16): "It had 56k in work done before it was
// listed. Still needs updating." read as a 56k rehab budget, so a refresh was
// called a flip, underwritten, and floated at 611 on a 716 ask.
test("work already done is not a rehab budget, so a house with 56k of work done gets the question", async () => {
  const said = "It had 56k in work done before it was listed.  Still needs updating.  It was built in 1967.";
  assert.equal(workBudgetIn(said), 0);
  assert.equal(workBudgetIn("they put 40k into repairs last year"), 0);
  assert.equal(workBudgetIn("about 60k of work left"), 60000, "work still to do is");
  assert.equal(qualifyStep({ words: said }).move, "ask");
});

// Matt, 2026-10-16: an agent's word that the house is a flip opportunity
// puts them in Tier 1 with nothing priced (shared/ghl-stages.js
// raisedHouses). Their framing counts; a list of rooms, "not a fixer" or a
// remodel already done doesn't.
test("an agent's word that the house needs work makes it a candidate", () => {
  for (const t of ["needs a lot of work", "It needs work", "a bit of a project", "needs a fair amount of work", "needs some work", "tear down", "it's a fixer upper", "estate sale, never updated"]) {
    assert.equal(saysRealWork(t), true, t);
  }
  assert.equal(saysRealWork("roof and windows", { agentRehab: 80000 }), true, "their own 80K budget");
});

test("'not a fixer', new construction, a remodel already done, or a list of rooms is not their word that it's a flip", () => {
  for (const t of ["not a fixer", "not a fixer / turnkey", "new construction, not a fixer", "newer home", "Full remodel done in 2002 by owners",
    "kitchen and baths original", "very well kept. kitchen remodel to modernize, upstairs bath update", "fully updated. roof and siding needed in the next 2-3 years",
    "basement is unfinished with no planned floor plan, possible ADU potential", "mostly cosmetic, paint and flooring", "turnkey"]) {
    assert.equal(saysRealWork(t), false, t);
  }
});

// Rachel T., 2026-10-20: "basically completed, wouldn't need work if bought
// today" read as the agent saying the house needs work, which held her card
// in Tier 1 after we passed on it.
test("'wouldn't need work' and paint touch-ups are light work, not their word that it needs work", () => {
  const said = "basically completed, wouldn't need work if bought today. paint touch ups in certain lighting after spraying";
  assert.equal(saysRealWork(said), false);
  assert.equal(saysCosmeticOnly(said), true);
  for (const t of ["it doesn't need work", "won't need any repairs, just touch-ups", "does not need work"]) assert.equal(saysRealWork(t), false, t);
  assert.equal(saysRealWork("it needs work"), true, "the plain word still counts");
});

// Matt, 2026-10-21: "we keep asking the agents how much rehab it needs" — and
// they push back, "you're the flipper, do the analysis yourself". These went
// out to agents on 10-19 to 10-21 after they had already told us the work.
test("asking an agent what the work would run or what it's worth fixed up is caught", () => {
  for (const said of [
    "What's your read on what it's worth fixed up, and roughly what the kitchen and bath work would run?",
    "While you're checking, any rough number on what you'd budget for that work list?",
    "What do you think it's worth fixed up, and what would you budget for that work?",
    "What's your read on value fixed up and the work it'd need?",
    "I'd rather run the numbers first before touring so we don't waste your time, what's the condition and work it needs, and what's the seller's situation?",
    "Whenever you land on a number, what do you think it's worth fixed up and what you'd budget for the work?",
    "What specific work does it need, and what's your read on value fixed up versus repair budget?",
    "Got it. What do you think it's worth fixed up, and roughly what would the roof/siding/deck run?",
    "Still want your take on it though, what do you think it's worth fixed up and what would you budget for the rehab?",
    "Thanks. What's your read on what the work would run on Windy Beach?",
    "What kind of shape is it in, and what's your read on value fixed up versus what the work would run?",
    "I'm thinking 531K ARV and 98K+ of rehab on it, what's your read on the work it needs?",
    "What's the work it needs, and what's the seller's timeline looking like?",
    "What's your read on where it sells once those cosmetics are done, and roughly what they'd run?",
    "What's your read on what's left to finish and what it'll sell for once it's done?",
    "Just your gut sense, what's it worth fixed up and ballpark for roof and electrical?",
    "What's your ARV on it?",
    "Just did a quick underwrite on 12 Elm. I'm thinking 850K After Repair Value and 200K+ of rehab. What do you think?",
  ]) assert.equal(asksTheirRehab(said), true, said);
});

test("the one gut-check question, our own read, and seller questions are not asking for their rehab", () => {
  for (const said of [
    ...QUALIFY_ASKS, ...QUALIFY_ASKS_CALL,
    "Just ran a quick underwrite, I'm seeing it around 520K fixed up with 90K+ of work. What's the seller hoping to get?",
    "Thanks, I'll run the numbers on it. What's the seller hoping to get?",
    "Got it. What's the seller's timeline looking like?",
    "Any chance of a few more photos or a quick walkthrough video?",
    "Anything I won't see in the photos, like roof, foundation, water or septic?",
    "We base it on 69% of the 500k it's worth fixed up, less 50k of rehab work. If that's in the ballpark, any other offers in on it yet?",
    "If you've got other fixers on your radar, on or off-market, I'm all ears.",
    "Roof and siding, got it. I'll run the numbers and get back to you.",
    "Landing around 410 as-is. What do you think, is that in the realm for the seller?",
  ]) assert.equal(asksTheirRehab(said), false, said);
});

// 60750 Breckenridge St (2026-10-22): "It need full kitchen and bathroom
// remodel" didn't read as real work, so the card stayed on the earlier
// "cosmetic flip". A remodel still to do is a project; one already done isn't.
test("a full remodel still to do is real work; a remodel that's done isn't", () => {
  assert.equal(saysRealWork("It need full kitchen and bathroom remodel"), true);
  assert.equal(saysRealWork("complete remodel needed"), true);
  assert.equal(saysRealWork("full remodel done in 2002"), false);
  assert.equal(saysRealWork("Fully remodeled kitchen and bath"), false);
  assert.equal(saysRealWork("kitchen and baths original"), false);
});
