import test from "node:test";
import assert from "node:assert/strict";
import { carrierFlags, coldBuyerFlags } from "./carrier-words.js";

// The texts carriers blocked (Error 30007), 2026-09-29 → 10-02.
test("a we-buy-houses pitch is caught: cash, as-is, investor, buy houses, no repairs, quick close, wholesale, a link", () => {
  assert.deepEqual(
    carrierFlags("Jeff, noticed your listing at 1515 Lombard Ave has been sitting a while. I'm a local investor buying houses as-is, no repairs needed. Would the seller consider a cash offer?"),
    ["cash", "as-is", "investor", "buy houses", "no repairs"]);
  assert.deepEqual(carrierFlags("I'm a local investor who buys houses needing work, quick close."), ["investor", "buy houses", "quick close"]);
  assert.deepEqual(carrierFlags("a Seattle investor who wholesales the deals I'm too busy to do"), ["investor", "wholesale"]);
  assert.deepEqual(carrierFlags("Photos and numbers: https://deals.shepflips.com/d/abc"), ["a link"]);
  assert.deepEqual(carrierFlags("we close fast on homes in any condition"), ["no repairs", "quick close"]);
});

test("ordinary words pass", () => {
  assert.deepEqual(carrierFlags("Hey Jeff, saw 1515 Lombard Ave is still on the market. Is it a bit of a project? Might be one I'd take a look at."), []);
  assert.deepEqual(carrierFlags("Still looking for fixers if anything ugly crosses your desk."), []);
  assert.deepEqual(carrierFlags("Are you buying right now, and what's your buy box these days?"), []);
  assert.deepEqual(carrierFlags(""), []);
});

// 2026-10-16: a deal text that opened by telling a buyer we'd seen their
// purchases in the county records was blocked on every number it went to,
// and the same text without that opener went through. A buyer who has
// written back to us is a different matter (it delivers to people who know
// us), so this rule is only for buyers who never answered.
test("an opener about what a cold buyer bought is flagged, in the ways it gets written", () => {
  for (const t of [
    "Hey Dana, saw in the county records you've bought houses around Kent.",
    "Hey Dana, saw you bought a rental near Elm Park last spring.",
    "Hey Dana, I saw you recently purchased on Birch St.",
    "Hey Dana, saw you've built two near here.",
    "Saw your flip on Cedar Ct, nice work.",
    "Hey Dana, saw your build over on 9th.",
    "Hey Dana, saw that you flipped one off Alder Way.",
  ]) assert.ok(coldBuyerFlags(t).length, t);
});

test("a plain deal text to a cold buyer is not flagged", () => {
  for (const t of [
    "Hey Dana, Matt here. I've got a house at 41 Alder Way in Kent. Buyer price 383k, ARV around 520k, rehab about 60k. Any interest in it for your next project?",
    "Hey Dana, I've got a lot at 12 Birch St in Kent. Buyer price 410k. Any interest in it for your next project?",
    "Did you see the numbers I sent over?",
    "Saw the photos, thanks.",
  ]) assert.deepEqual(coldBuyerFlags(t), [], t);
});

test("the cold rule stays out of the words every machine text is checked for", () => {
  // A check-in to an agent or a buyer we know may name what they bought;
  // only the send-time check on a cold buyer's deal text reads this rule.
  assert.deepEqual(carrierFlags("Saw your flip on Cedar Ct, nice work."), []);
  assert.deepEqual(carrierFlags("saw in the county records you've bought houses around Kent"), []);
});
