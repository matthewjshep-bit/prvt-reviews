import test from "node:test";
import assert from "node:assert/strict";
import { listingDistress } from "./listing-distress.js";

// Matt, 2026-10-29: a short sale or bank-owned listing is out of the buy box,
// however much work its remarks say it needs.
test("a short sale or bank-owned listing is never texted about, even as a fixer", () => {
  const short = listingDistress({ status: "FOR_SALE", description: "Fixer! Needs a full rehab. Short sale, subject to lender approval." });
  assert.equal(short.ok, false);
  assert.match(short.why, /short sale/);
  const reo = listingDistress({ status: "FOR_SALE", description: "Bank-owned handyman special, sold as-is." });
  assert.equal(reo.ok, false);
  assert.match(reo.why, /bank-owned/);
  assert.equal(listingDistress({ status: "FOR_SALE", description: "Fixer, not a short sale. Bring your contractor." }).ok, true);
});

// 2026-11-09 audit: on 11/9 the sweep picked 108 agents and the listing check
// kept 1. Plain "needs work" wording was read as "nothing in the remarks says
// it needs work". The remarks below are made up.
test("a listing that says needs new flooring and paint is kept", () => {
  for (const description of [
    "Needs new flooring and paint. Big yard.",
    "Needs a new roof and some updating.",
    "Needs cosmetic updates throughout.",
    "This one needs a little kitchen work.",
    "Home needs to be updated.",
  ]) {
    const r = listingDistress({ status: "FOR_SALE", description });
    assert.equal(r.ok, true, description);
    assert.ok(r.signals.includes("needs work"), description);
  }
});

test("a listing that says could use some updating is kept", () => {
  for (const description of [
    "Solid rambler that could use some updating.",
    "Could use a little love.",
    "Ready for your renovation ideas.",
    "Great bones and ready for your updates.",
    "Light cosmetic work will make it shine.",
  ]) assert.equal(listingDistress({ status: "FOR_SALE", description }).ok, true, description);
  // Softer words: kept only when nothing says the house is finished.
  for (const description of ["Value-add opportunity on a big lot.", "Original owner, first time on the market.", "Seller will make no repairs."]) {
    assert.equal(listingDistress({ status: "FOR_SALE", description }).ok, true, description);
  }
});

test("a listing that says move-in ready with no repairs is dropped", () => {
  for (const description of [
    "Move-in ready with no repairs.",
    "Original owner kept it immaculate, move-in ready.",
    "Recent cosmetic updates throughout. Turnkey.",
    "No repairs necessary.",
    "Move-in ready and ready for your personal touch.",
  ]) assert.equal(listingDistress({ status: "FOR_SALE", description }).ok, false, description);
});

test("a listing that says doesn't need any work is dropped", () => {
  for (const description of [
    "Doesn't need any work, just bring your furniture.",
    "This home does not need repairs.",
    "No need for updates here.",
    "Nothing needs updating.",
    // What a buyer needs isn't what the house needs.
    "Room for all your needs with an updated kitchen.",
    "Space for every need and a remodeled bath.",
  ]) assert.equal(listingDistress({ status: "FOR_SALE", description }).ok, false, description);
});
