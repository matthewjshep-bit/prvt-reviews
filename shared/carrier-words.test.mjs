import test from "node:test";
import assert from "node:assert/strict";
import { carrierFlags } from "./carrier-words.js";

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
