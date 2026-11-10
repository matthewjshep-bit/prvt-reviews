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

/* ---------- a booked call nobody made (2026-11-09) ---------- */

// The audit: a call booked for 8am was never made, and the next text from us
// asked the agent for fixers. Nothing read the booking's time.
const NOW3 = Date.parse("2026-11-04T19:00:00Z");   // Wednesday 11am Pacific
const at3 = (h) => new Date(NOW3 - h * 3600000).toISOString();
const booked = (startHoursAgo, over = {}) => ({ type: "call_booked", contactId: "c9", at: at3(startHoursAgo + 20), party: "agent", address: "88 Quill Ln, Kent, WA",
  data: { startTime: at3(startHoursAgo), durationMin: 15, label: "Wed 8:00am" }, ...over });

test("a booked call with no call near its time is a call we owe", async () => {
  const { bookedCallsMissed } = await import("./promise-owed.js");
  const missed = bookedCallsMissed([booked(3)], NOW3);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].contactId, "c9");
  assert.equal(missed[0].startTime, at3(3));
  assert.equal(missed[0].address, "88 Quill Ln, Kent, WA");
  assert.equal(bookedCallsMissed([booked(1)], NOW3).length, 0, "an hour past its time: not missed yet");
  assert.equal(bookedCallsMissed([booked(-20)], NOW3).length, 0, "tomorrow's booking isn't missed");
  const rang = { type: "call_attempt", contactId: "c9", at: at3(3.25), data: { outcome: "no_answer", direction: "outbound" } };
  assert.equal(bookedCallsMissed([booked(3), rang], NOW3).length, 0, "we rang a few minutes early");
  const talked = { type: "call_summary", contactId: "c9", at: at3(2.5), data: { direction: "inbound", durationSec: 240, transcribed: true } };
  assert.equal(bookedCallsMissed([booked(3), talked], NOW3).length, 0, "they called and we talked");
  const late = { type: "call_attempt", contactId: "c9", at: at3(0.5), data: { outcome: "voicemail", direction: "outbound" } };
  assert.equal(bookedCallsMissed([booked(3), late], NOW3).length, 0, "a late call still pays it");
  const theyRang = { type: "call_attempt", contactId: "c9", at: at3(2.9), data: { outcome: "voicemail", direction: "inbound" } };
  assert.equal(bookedCallsMissed([booked(3), theyRang], NOW3).length, 1, "their missed call to us doesn't");
  const early = { type: "call_attempt", contactId: "c9", at: at3(4), data: { outcome: "no_answer", direction: "outbound" } };
  assert.equal(bookedCallsMissed([booked(3), early], NOW3).length, 1, "a call an hour before the time isn't the booked call");
  const rebooked = booked(-26, { at: at3(1) });
  assert.equal(bookedCallsMissed([booked(3), rebooked], NOW3).length, 0, "booked again for tomorrow: that one is the call");
  assert.equal(bookedCallsMissed([booked(24 * 70)], NOW3).length, 0, "two months on it is history");
  assert.equal(bookedCallsMissed([{ ...booked(3), data: {} }], NOW3).length, 0, "no time on the booking: nothing to miss");
});

test("a call we owe holds the check-ins three days, and a call made since ends the wait", async () => {
  const { callOwedWait, CALL_OWED_WAIT_DAYS } = await import("./promise-owed.js");
  assert.equal(CALL_OWED_WAIT_DAYS, 3);
  const w = callOwedWait({ events: [booked(3)], now: NOW3 });
  assert.match(w.reason, /we missed the call booked with them/);
  assert.equal(w.until, new Date(Date.parse(at3(3)) + 3 * 86400000).toISOString());
  assert.equal(callOwedWait({ events: [booked(24 * 3 + 1)], now: NOW3 }), null, "three days on the check-ins go again");
  assert.match(callOwedWait({ events: [booked(-20)], now: NOW3 }).reason, /a call is booked with them/);
  const promised = { type: "promise_made", contactId: "c9", at: at3(30), data: { what: "call", text: "I'll give you a call tomorrow morning." } };
  assert.match(callOwedWait({ events: [promised], now: NOW3 }).reason, /we said we'd call them/);
  const rang = { type: "call_attempt", contactId: "c9", at: at3(2), data: { outcome: "no_answer", direction: "outbound" } };
  assert.equal(callOwedWait({ events: [promised, rang], now: NOW3 }), null, "we tried: the promise is kept");
  assert.equal(callOwedWait({ events: [{ ...promised, data: { what: "call", text: "I'll give you a call if it pencils." } }], now: NOW3 }), null, "a call if it makes sense promises nothing");
  assert.equal(callOwedWait({ events: [promised, { type: "promise_kept", contactId: "c9", at: at3(1), data: { by: "dismissed" } }], now: NOW3 }), null, "dismissed");
  assert.equal(callOwedWait({ events: [{ ...promised, data: { what: "number", text: "I'll get you a number tomorrow." } }], now: NOW3 }), null, "a number isn't a call");
});
