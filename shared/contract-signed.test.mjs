// contract-signed.test.mjs — the agent says it's signed; the app notices.

import test from "node:test";
import assert from "node:assert/strict";
import { signedContractIn, closingDateIn, themLines } from "./contract-signed.js";

const NOW = Date.parse("2026-10-02T20:00:00Z");
const yes = (t) => assert.equal(signedContractIn(t, { now: NOW }).signed, true, t);
const no = (t) => assert.equal(signedContractIn(t, { now: NOW }).signed, false, t);

test("it's signed: mutual, fully executed, seller signed, DocuSign done, under contract", () => {
  yes("We're mutual!");
  yes("Seller signed, fully executed copy attached");
  yes("Great news, it's mutual");
  yes("DocuSign is complete, I'll send it over");
  yes("Everyone has signed. Congrats");
  yes("The PSA is signed and back");
  yes("We are officially under contract");
  yes("Counter-signed and sent back to you");
});

test("not yet: the future, the negative, a question", () => {
  no("Once it's signed I'll send it over");
  no("Seller hasn't signed yet");
  no("Seller will sign tonight");
  no("Is it fully executed?");
  no("We're waiting on the seller to sign");
  no("Going to send the PSA for signatures");
  no("Need to get it under contract first");
  no("Sounds good, thanks");
});

test("a closing date said in the same breath rides along", () => {
  assert.deepEqual(signedContractIn("Seller signed! Closing 10/24.", { now: NOW }), { signed: true, ours: false, closingDate: "2026-10-24" });
  assert.equal(signedContractIn("Seller signed your offer!", { now: NOW }).ours, true, "said about ours");
  assert.equal(closingDateIn("close on Nov 3rd", NOW), "2026-11-03");
  assert.equal(closingDateIn("closing date of January 9", NOW), "2027-01-09", "a date past this year is next year's");
  assert.equal(closingDateIn("no date yet", NOW), null);
});

test("on a call, only their words count", () => {
  const t = "US: so once it's mutual send it over\nTHEM: yep the seller signed this morning, we're mutual";
  assert.equal(themLines(t), "yep the seller signed this morning, we're mutual");
  assert.equal(signedContractIn(themLines(t), { now: NOW }).signed, true);
  assert.equal(signedContractIn(themLines("US: we're mutual right?\nTHEM: not yet"), { now: NOW }).signed, false);
});

// Review, 2026-10-02: each of these read as signed, and would have put
// "Promote to deal" on Today for a house someone else got.
test("someone else's contract, a counter, the listing paperwork: not ours signed", () => {
  no("Sorry, the seller signed another offer.");
  no("We're under contract with someone else");
  no("Offer was signed by another buyer");
  no("We have mutual acceptance on another offer.");
  no("Contract is signed on my other listing");
  no("Seller signed the listing agreement");
  no("Seller signed the disclosures");
  no("Seller signed the counter, sending it back");
  no("We went with a backup offer, it's mutual");
  yes("Seller signed your offer, we're mutual");
});

test("a closing date has to be a real day, not one that's passed", () => {
  assert.equal(closingDateIn("close on 2/30", NOW), null);
  assert.equal(closingDateIn("closing 12/31/25", NOW), null, "already past");
  assert.equal(closingDateIn("closing costs split 50/50, close 10/24", NOW), "2026-10-24", "the date, not the costs");
});

// 9311 12th Pl SE (2026-10-04): "We are signed around - Authentisign should
// have sent you the fully executed contract." The paper on its way is not a
// signature still to come.
test("'we are signed — the fully executed contract should have reached you' is signed", async () => {
  const { signedContractIn } = await import("./contract-signed.js");
  assert.equal(signedContractIn("We are signed around - Authentisign should have sent you the fully executed contract. I'll forward it now for your file.").signed, true);
  assert.equal(signedContractIn("Once it's signed I'll send it over").signed, false);
  assert.equal(signedContractIn("The seller should sign it tonight").signed, false);
});
