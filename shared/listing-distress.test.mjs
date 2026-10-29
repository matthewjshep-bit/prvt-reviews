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
