import test from "node:test";
import assert from "node:assert/strict";
import { underwriteDailyCap, UW_DEFAULT_DAILY_CAP } from "./auto-underwrite.js";

test("the underwrite daily cap: 0 is no cap, blank is the default, a number is that number", () => {
  assert.equal(underwriteDailyCap({ autoUnderwriteDailyCap: 0 }), Infinity);
  assert.equal(underwriteDailyCap({ autoUnderwriteDailyCap: "0" }), Infinity);
  assert.equal(underwriteDailyCap({ autoUnderwriteDailyCap: "" }), UW_DEFAULT_DAILY_CAP);
  assert.equal(underwriteDailyCap({}), UW_DEFAULT_DAILY_CAP);
  assert.equal(underwriteDailyCap({ autoUnderwriteDailyCap: "60" }), 60);
});
