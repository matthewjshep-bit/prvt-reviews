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

/* ---------- a call, a time to walk it, the earnest money (2026-10-15) ---------- */

import { owedPersonPromises } from "./promise-owed.js";
const NOW2 = Date.parse("2026-10-15T20:00:00Z");
const hrs = (h) => new Date(NOW2 - h * 3600000).toISOString();
const made = (what, h, text, over = {}) => ({ type: "promise_made", contactId: "c1", at: hrs(h), address: "12 Elm St, Renton, WA", data: { what, text, draftId: `d${h}` }, ...over });

test("a call we promised is owed until a call is made or tried; a dismissal clears it, a price doesn't", () => {
  const call = made("call", 30, "I'll give you a call tomorrow.");
  const owed = owedPersonPromises({ events: [call], now: NOW2 });
  assert.equal(owed.length, 1);
  assert.equal(owed[0].what, "call");
  assert.equal(owedPersonPromises({ events: [made("call", 5, "I'll call you later")], now: NOW2 }).length, 0, "not a day old yet");
  const talked = { type: "call_summary", contactId: "c1", at: hrs(20), data: { transcribed: true, durationSec: 240 } };
  assert.equal(owedPersonPromises({ events: [call, talked], now: NOW2 }).length, 0, "a connected call keeps it");
  const tried = { type: "call_attempt", contactId: "c1", at: hrs(20), data: { outcome: "no_answer", direction: "outbound" } };
  assert.equal(owedPersonPromises({ events: [call, tried], now: NOW2 }).length, 0, "a call we tried keeps it");
  const theyRang = { type: "call_attempt", contactId: "c1", at: hrs(20), data: { outcome: "no_answer", direction: "inbound" } };
  assert.equal(owedPersonPromises({ events: [call, theyRang], now: NOW2 }).length, 1, "their missed call doesn't");
  assert.equal(owedPersonPromises({ events: [call, { type: "promise_kept", contactId: "c1", at: hrs(10), data: { by: "our_number" } }], now: NOW2 }).length, 1);
  assert.equal(owedPersonPromises({ events: [call, { type: "promise_kept", contactId: "c1", at: hrs(10), data: { by: "dismissed" } }], now: NOW2 }).length, 0);
});

test("a walk-through time is kept by a booking or a text of ours with a time; the earnest money by the checklist", () => {
  const tour = made("tour", 30, "I'll get you a time to walk it this week.");
  assert.equal(owedPersonPromises({ events: [tour], now: NOW2 })[0].what, "tour");
  const sent = [{ contactId: "c1", status: "sent", sentAt: hrs(20), reply: "Could we walk it Thursday at 2?" }];
  assert.equal(owedPersonPromises({ events: [tour], sentDrafts: sent, now: NOW2 }).length, 0);
  assert.equal(owedPersonPromises({ events: [tour, { type: "call_booked", contactId: "c1", at: hrs(2) }], now: NOW2 }).length, 0);
  const emd = made("emd", 50, "We'll get the earnest money over to title Monday.");
  assert.equal(owedPersonPromises({ events: [emd], now: NOW2 })[0].what, "emd");
  const deal = { contactId: "c1", address: "12 Elm St, Renton, WA", deal: { stage: "under_contract", checklist: { items: [{ id: "earnest_money", done: true }] } } };
  assert.equal(owedPersonPromises({ events: [emd], offers: [deal], now: NOW2 }).length, 0);
});
