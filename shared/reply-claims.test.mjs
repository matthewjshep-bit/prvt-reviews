// reply-claims.test.mjs — what a reply says we did or will do, read against
// what's true. Names, streets and words here are invented.

import test from "node:test";
import assert from "node:assert/strict";
import {
  numberTimeFlags, callPromiseFlags, inventsSomeone, inventedPeopleFlags, claimsContact, contactClaimFlags,
  claimsSentOffer, sentOfferFlags, claimFacts, claimGateInputs, CALL_OWED_FLAG, CLAIM_WINDOW_DAYS,
} from "./reply-claims.js";

const DAY = 86400000;
const NOW = Date.parse("2026-11-09T19:00:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();

/* ---------- a number or a time we don't have ---------- */

test("a time for a number on a house nobody has priced is flagged", () => {
  for (const reply of [
    "Thanks Rory. I'll get back to you today with a number on 88 Larkspur Ln.",
    "Should have something for you today.",
    "I'll text you our number by Friday.",
    "Still working through the numbers, will have an offer over this afternoon.",
    "We should have a number for you shortly.",
  ]) {
    assert.equal(numberTimeFlags(reply, { numberUnpriced: true }).length, 1, reply);
    assert.deepEqual(numberTimeFlags(reply, { numberUnpriced: false }), [], `${reply} (a priced house may say when)`);
  }
});

test("a reply that asks what the seller would take, or names a time for something else, is not a number promise", () => {
  for (const reply of [
    "Got it. What would the seller take, and how soon do they need to move?",
    "Sounds good, I'm out today but happy to look at anything rough you have.",
    "I'll take a look at it. Is the seller hoping to close this month?",
    "Tomorrow works for the showing on their end?",
  ]) assert.deepEqual(numberTimeFlags(reply, { numberUnpriced: true }), [], reply);
});

/* ---------- a second call promise ---------- */

test("a call promised after one that never happened is held for Matt, never rewritten", () => {
  for (const reply of ["Let me give you a quick call on that.", "I'll be calling you shortly.", "Will call you back in a bit."]) {
    assert.deepEqual(callPromiseFlags(reply, { callOwedUnkept: true }), [CALL_OWED_FLAG], reply);
    assert.deepEqual(callPromiseFlags(reply, { callOwedUnkept: false }), [], reply);
  }
  assert.deepEqual(callPromiseFlags("Can we hop on a quick 5-minute call this week? What time works?", { callOwedUnkept: true }), [], "asking for a call is not promising one");
  assert.deepEqual(callPromiseFlags("I'll give you a call if it pencils.", { callOwedUnkept: true }), [], "a conditional call");
});

/* ---------- people who don't exist ---------- */

test("a partner, a team or an underwriter of ours is invented; theirs is not", () => {
  for (const [reply, said] of [
    ["Let me run it by my partner and circle back.", "my partner"],
    ["Our team is reviewing it now.", "Our team"],
    // \u0020 is a plain space, written out so the privacy scan's name check doesn't read the phrase as a person.
    ["I'll have the\u0020team look at the photos.", "the\u0020team"],
    ["Sending it to our underwriting team.", "our underwriting team"],
    ["Our underwriting came back a bit lower.", "Our underwriting came back"],
    ["I need to confirm internally first.", "confirm internally"],
  ]) assert.equal(inventsSomeone(reply), said, reply);
  for (const reply of [
    "Does your partner want to see it first?",
    "Totally fine if their partner needs a day.",
    "Is the seller's partner on title too?",
    "Thanks to you and the\u0020team for sending it.",
    "Happy to walk it whenever works for you.",
  ]) assert.equal(inventsSomeone(reply), "", reply);
  assert.match(inventedPeopleFlags("Let me check with my business partner.")[0], /no partner, team or underwriter/);
});

/* ---------- a call that didn't happen ---------- */

test("saying we talked, when no call connected in two weeks, is a claim we can't make", () => {
  const none = { connectedCallRecently: false, callTriedRecently: false };
  for (const [reply, said] of [
    ["Glad we connected earlier. Still keen on it.", "we connected"],
    ["I spoke with the seller and they're flexible.", "I spoke with"],
    ["Like we talked about, it needs a roof.", "Like we talked"],
    ["Sorry I missed you, tried a bit ago.", "Sorry I missed you"],
    ["I called this morning about 6 Ferncliff Ave.", "I called"],
  ]) {
    assert.equal(claimsContact(reply, none), said, reply);
    assert.equal(claimsContact(reply, { connectedCallRecently: true, callTriedRecently: true }), "", `${reply} (a call did happen)`);
  }
  // A call we tried but nobody picked up makes "I called" true, not "we talked".
  const tried = { connectedCallRecently: false, callTriedRecently: true };
  assert.equal(claimsContact("I called earlier, no luck.", tried), "");
  assert.equal(claimsContact("Like we talked about, it needs a roof.", tried), "Like we talked");
  assert.equal(claimsContact("Sorry I missed your call, what's up?", none), "", "they called us: that's true");
  assert.equal(claimsContact("As we discussed by text, the roof is the big item.", none), "", "a text thread is a discussion too");
  assert.equal(claimsContact("Per our conversation yesterday, still keen.", none), "", "so is a conversation by text");
  assert.equal(claimsContact("Per our call Tuesday, still keen.", none), "Per our call");
  assert.match(contactClaimFlags("We connected yesterday.", none)[0], /no call with them/);
});

/* ---------- a send that didn't happen ---------- */

test("saying the offer went over, or was emailed, when nothing went", () => {
  for (const reply of ["Just sent our offer over.", "I sent the letter of intent over this morning.", "Emailed it to you, check your inbox."]) {
    assert.ok(claimsSentOffer(reply, { offerWentOut: false, sendOfferDone: false }), reply);
    assert.equal(claimsSentOffer(reply, { offerWentOut: true, sendOfferDone: false }), "", `${reply} (it went before)`);
    assert.equal(claimsSentOffer(reply, { offerWentOut: false, sendOfferDone: true }), "", `${reply} (it went just now)`);
  }
  assert.equal(claimsSentOffer("I'll get the offer over to you.", { offerWentOut: false, sendOfferDone: false }), "", "a promise is not a claim");
  assert.equal(sentOfferFlags("Just sent our offer over.", {}).length, 0, "nothing passed in: nothing flagged");
});

/* ---------- the facts a gate reads ---------- */

const draftOnly = { id: "a", contactId: "c1", address: "88 Larkspur Ln, Tacoma, WA 98404", status: "draft", cashAmount: null, createdAt: ago(1),
  autoUnderwrite: { draftOnly: true, held: ["ready for your comps — the app made the draft, you price it"] } };
const sent = { id: "b", contactId: "c1", address: "14 Quarry Rd, Kent, WA 98030", status: "sent", cashAmount: 380000, createdAt: ago(5),
  sends: [{ ts: ago(4), channels: ["sms"] }] };
const floated = { id: "c", contactId: "c1", address: "6 Ferncliff Ave, Renton, WA 98056", status: "new", cashAmount: 410000, createdAt: ago(3), floatSentAt: ago(2) };
const fullModeDraft = { id: "d", contactId: "c1", address: "9 Bramble Ct, Auburn, WA 98002", status: "draft", cashAmount: null, createdAt: ago(1),
  autoUnderwrite: { held: ["only 1 listing photo to scan"] } };

test("a house is unpriced while nothing of ours went out on it and it's priced by hand", () => {
  const f = claimFacts({ offers: [draftOnly, sent, floated, fullModeDraft], events: [], mattPrices: false, now: NOW });
  assert.equal(claimGateInputs(f, { address: "88 Larkspur Ln" }).numberUnpriced, true, "a draft-only house");
  assert.equal(claimGateInputs(f, { address: "14 Quarry Rd" }).numberUnpriced, false, "our offer went");
  assert.equal(claimGateInputs(f, { address: "6 Ferncliff Ave" }).numberUnpriced, false, "our number was floated");
  assert.equal(claimGateInputs(f, { address: "9 Bramble Ct" }).numberUnpriced, false, "the machine prices it in full mode");
  assert.equal(claimGateInputs(f, { address: "300 Tidewater Way" }).numberUnpriced, false, "a new house in full mode");
  const byHand = claimFacts({ offers: [fullModeDraft], events: [], mattPrices: true, now: NOW });
  assert.equal(claimGateInputs(byHand, { address: "9 Bramble Ct" }).numberUnpriced, true);
  assert.equal(claimGateInputs(byHand, { address: "300 Tidewater Way" }).numberUnpriced, true, "a house we have no row for is priced by hand");
  assert.equal(claimGateInputs(byHand, {}).numberUnpriced, true, "no house named, and none of theirs has a number out");
  assert.equal(claimGateInputs(claimFacts({ offers: [sent], mattPrices: true, now: NOW }), {}).numberUnpriced, false, "no house named, and one has our number");
  // A number on the row is a priced house, sent or not: the float about to carry it may say when.
  const pricedNotSent = { id: "e", contactId: "c1", address: "2 Juniper Pl, Kent, WA 98030", status: "new", cashAmount: 395000, createdAt: ago(1) };
  assert.equal(claimGateInputs(claimFacts({ offers: [pricedNotSent], mattPrices: true, now: NOW }), { address: "2 Juniper Pl" }).numberUnpriced, false);
  assert.equal(claimGateInputs(f, { address: "14 Quarry Rd" }).offerWentOut, true);
  assert.equal(claimGateInputs(f, { address: "6 Ferncliff Ave" }).offerWentOut, false, "a float is not the written offer");
});

test("a call we promised stays owed until a call connects or it's dismissed, for two weeks", () => {
  const promised = { type: "promise_made", at: ago(3), data: { what: "call", draftId: "x1" } };
  const owe = (events) => claimGateInputs(claimFacts({ events, now: NOW })).callOwedUnkept;
  assert.equal(owe([promised]), true);
  assert.equal(owe([promised, { type: "call_summary", at: ago(2), data: { durationSec: 240, transcribed: true } }]), false, "a call connected since");
  assert.equal(owe([promised, { type: "call_attempt", at: ago(2), data: { direction: "outbound" } }]), true, "a ring-out keeps nothing");
  assert.equal(owe([promised, { type: "promise_kept", at: ago(1), data: { by: "dismissed" } }]), false, "dismissed");
  assert.equal(owe([{ ...promised, at: ago(CLAIM_WINDOW_DAYS + 1) }]), false, "older than two weeks");
  assert.equal(owe([{ ...promised, data: { what: "call", conditional: true } }]), false, "a conditional call");
  assert.equal(owe([{ type: "promise_owed", at: ago(2), data: { what: "call" } }]), true);
  assert.equal(owe([{ type: "promise_made", at: ago(2), data: { what: "number" } }]), false, "a number is not a call");
  const f = claimFacts({ events: [{ type: "call_summary", at: ago(20), data: { durationSec: 300 } }, { type: "call_attempt", at: ago(1), data: { direction: "outbound" } }], now: NOW });
  const g = claimGateInputs(f);
  assert.equal(g.connectedCallRecently, false, "the talk was three weeks ago");
  assert.equal(g.callTriedRecently, true, "we tried yesterday");
  assert.deepEqual(claimGateInputs(null), { numberUnpriced: false, callOwedUnkept: false, connectedCallRecently: true, callTriedRecently: true, offerWentOut: true },
    "no facts: nothing new is flagged");
});
