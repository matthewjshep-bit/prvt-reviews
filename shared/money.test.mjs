// money.test.mjs — a dollar figure the way a person types it.
//
// The deal's fee and contract price were read with a parser that knew
// neither "15k" nor "740k": a fee typed as 15k saved as nothing, and buyer
// pages then priced the deal at the contract with no fee at all.

import test from "node:test";
import assert from "node:assert/strict";
import { parseMoney } from "./money.js";

test("k and m, dollar signs, commas and cents read as the number they mean", () => {
  assert.equal(parseMoney("15k"), 15000);
  assert.equal(parseMoney("15K"), 15000);
  assert.equal(parseMoney("$450K"), 450000);
  assert.equal(parseMoney("740k"), 740000);
  assert.equal(parseMoney("1.2m"), 1200000);
  assert.equal(parseMoney("4.18M"), 4180000);
  assert.equal(parseMoney("$4,180,000"), 4180000);
  assert.equal(parseMoney(" 867,280.87 "), 867280.87);
  assert.equal(parseMoney("$ 30,000"), 30000);
  assert.equal(parseMoney("15 k"), 15000);
  assert.equal(parseMoney(430000), 430000);
  assert.equal(parseMoney("0"), 0);
});

test("empty or unreadable is null, never a guess", () => {
  for (const v of ["", "   ", null, undefined, "abc", "15kk", "-5000", "450-460k", "about 450k", "4.5.6", NaN, -1, Infinity, "$", "k"]) {
    assert.equal(parseMoney(v), null, String(v));
  }
});
