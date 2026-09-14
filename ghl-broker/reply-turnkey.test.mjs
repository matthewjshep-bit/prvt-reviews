// reply-turnkey.test.mjs — a turnkey house is not a deal, so it never moves an
// agent to Tier 1 or starts an underwrite.

import test from "node:test";
import assert from "node:assert/strict";
import { isTurnkeyReply } from "./reply-agent.js";

test("the two replies that were filed Tier 1 on 2026-09-14 read as turnkey", () => {
  assert.equal(isTurnkeyReply("This one is pretty turnkey with tenants in place."), true, "Karamveer Tiwana");
  assert.equal(isTurnkeyReply("This one is definitely turnkey. Was completely renovated"), true, "Angie Bomar");
});

test("other ways agents say it needs nothing", () => {
  assert.equal(isTurnkeyReply("It's move-in ready"), true);
  assert.equal(isTurnkeyReply("Fully remodeled last year"), true);
  assert.equal(isTurnkeyReply("doesn't need any work"), true);
  assert.equal(isTurnkeyReply("it was flipped in 2022"), true);
});

test("a house that needs work is never turnkey, even with a renovated room", () => {
  assert.equal(isTurnkeyReply("This listing is one that another broker in my office has. It could use some fix ups and is priced low."), false, "Angie's second house");
  assert.equal(isTurnkeyReply("Just needs minor repairs around, new kitchen and outside paint. Throw an offer in!!"), false, "Thomas Rinow");
  assert.equal(isTurnkeyReply("Kitchen was renovated but the rest is dated, sold as-is"), false);
  assert.equal(isTurnkeyReply("3611 I St NE #235 Auburn"), false);
  assert.equal(isTurnkeyReply(""), false);
});
