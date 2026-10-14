// promise-owed.test.mjs — what keeps a number we promised, read off our own
// texts. The cases are the 2026-10-14 replay's, reworded.

import test from "node:test";
import assert from "node:assert/strict";
import { keepsOurWord, namesAPrice, owedOnHouse } from "./promise-owed.js";
import { isConditionalPromise } from "./follow-up.js";

test("a number we float the way we say it keeps the promise", () => {
  assert.equal(keepsOurWord("Ran the numbers on 12 Elm St, we can likely do around 449kish as-is, quick close."), "number");
  assert.equal(keepsOurWord("We'd be at $410,000 cash, 14-day close."), "number");
  assert.equal(keepsOurWord("Could probably do closer to 1.2M."), "number");
});

test("earnest money, a repair figure or a street number is not our number", () => {
  assert.equal(namesAPrice("We normally write 1k earnest, 2,500 if they want more."), false);
  assert.equal(namesAPrice("Thanks for 14520 Cold Creek Rd, we close in 10 to 14 days."), false);
  assert.equal(keepsOurWord("Comps came back thin, want to get it right before I quote anything."), null);
});

test("our pass keeps it, in the words we actually use", () => {
  assert.equal(keepsOurWord("Sorry, this one didn't work out for us, we're too far apart on the number."), "pass");
  assert.equal(keepsOurWord("I dont think we're going to get there on this one after running the numbers."), "pass");
  assert.equal(keepsOurWord("This one is a bit too rural for us but let me know about the next!"), "pass");
  assert.equal(keepsOurWord("Talked to my partner and not doing condos at the moment."), "pass");
});

test("their number said back while we promise again keeps nothing; a price beside a promise of the paper does", () => {
  assert.equal(keepsOurWord("Got it, 480k. Let me run that by underwriting and get back to you with a number tomorrow."), null);
  assert.equal(keepsOurWord("We'd be at 598k as-is. Let me know if it's in the realm and I'll get the formal offer over."), "number");
});

test("a look we promised on a condition is not a number we owe", () => {
  assert.equal(isConditionalPromise("I'll run this by my underwriting team today and circle back if it pencils out."), true);
  assert.equal(isConditionalPromise("I'll run it by my team today and see if we can get back to you with an offer."), true);
  assert.equal(isConditionalPromise("If they come back with a number, send it over and I'll run it by my partner."), true);
  assert.equal(isConditionalPromise("I'll run it by underwriting today and get back to you with a number."), false);
});

test("a house with nothing promised and nothing of theirs waiting owes nothing", () => {
  assert.equal(owedOnHouse({ address: "12 Elm St, Renton, WA", events: [], drafts: [] }), null);
  assert.equal(owedOnHouse({ address: "", events: [{ type: "promise_made", contactId: "c1", at: "2026-10-01T18:00:00Z", data: { what: "number" } }] }), null);
});
