// over-our-number.test.mjs — the bot said yes to a number above ours.
//
// Jesse, 39811 226th Ave SE, Enumclaw (2026-09-25). Our offer was 550K
// (already over the most we'd pay). The passed check-in asked if the sellers
// had moved; he came back "$650 is their bottom bottom … $650k plus my fees".
// The bot asked for his value and repairs, he sent a scope, and the bot
// auto-sent "That scope is workable for us at 650. Can you write it up on
// NWMLS forms". "at 650" has no k, so the money guard never saw a number.
// Then "Yes I can do that" went out under the acceptance band as "they took
// our number" — the band compared against the book's 550, not the 650 we
// had just texted. Three days of "waiting on my partner" followed.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReplyGates, releaseForAudit, decideAutoSend, summarizeOffers, evaluateBandFor, ourNumberFor } from "./reply-agent.js";
import { shorthandPrices, pricesWeName, ourMoveUp, paperCheck } from "./shared/current-offer.js";
import { evaluateAcceptance } from "./shared/auto-accept.js";

const BOOK = [550000]; // roughAmounts of our 550K offer, near enough
const draft = (over = {}) => ({
  intent: "deal_available", confidence: "high", needsHuman: false, humanReason: "",
  reply: "Good news that the roof and AC are handled. That scope is workable for us at 650. Can you write it up on NWMLS forms and send it over for signature?",
  summary: "", propertyAddress: "39811 226th Ave SE, Enumclaw, WA 98022", counterAmount: 0, ...over,
});
const gate = (over = {}, ctx = {}) => evaluateReplyGates({
  draft: draft(over), party: "agent", allowedAmounts: BOOK, ourAmount: 550000,
  inboundMessage: "The only thing I would want you to cost out is new kitchen cabinets, and refrigerator, bathrooms, need new vanities, and flooring.",
  ...ctx,
});

/* ---------- reading "at 650" as a price ---------- */

test("'at 650' with no k is a price of 650K when our offer is 550K", () => {
  assert.deepEqual(shorthandPrices("That scope is workable for us at 650. Can you write it up?", 550000), [650000]);
  assert.deepEqual(shorthandPrices("we can do 650", 550000), [650000]);
  assert.deepEqual(shorthandPrices("650 works for us", 550000), [650000]);
});

test("days, weeks, street numbers and the house number are not a shorthand price", () => {
  assert.deepEqual(shorthandPrices("14 day inspection, close in 21 days", 550000), []);
  assert.deepEqual(shorthandPrices("the place at 4430 Sunnyside Blvd", 550000), []);
  assert.deepEqual(shorthandPrices("on 226th Ave SE", 550000), []);
  assert.deepEqual(shorthandPrices("give me 2 weeks at most", 550000), []);
  assert.deepEqual(shorthandPrices("The LOI's with you at 1,304,955 cash, as-is.", 0), []);
  assert.deepEqual(shorthandPrices("14 day inspection, 683,750 as-is.", 0), []);
});

// The first app-written texts (2026-10-05) were held as "the draft names
// $512,000, which is not in the offer book" for "your listing at 512 112th
// Ave NE". A house number before a numbered street is an address.
test("a first text naming 'your listing at 512 112th Ave NE' is not a price of 512K", () => {
  assert.deepEqual(shorthandPrices("Hi, came across your listing at 512 112th Ave NE. Is it a project?", 0), []);
  assert.deepEqual(shorthandPrices("noticed your listing at 3604 61st St W", 0), []);
  assert.deepEqual(shorthandPrices("saw your listing at 118 72nd Ave E", 0), []);
  assert.deepEqual(shorthandPrices("your listing at 1302 228th Pl SE", 0), []);
  assert.deepEqual(shorthandPrices("the house at 905 ne 3rd St", 0), []);
  assert.deepEqual(pricesWeName("Still around at 512 112th Ave NE?", 450000), []);
  // A price beside a street is still a price.
  assert.deepEqual(shorthandPrices("we can be at 650 on the 194th Pl house", 550000), [650000]);
});

test("a first text with the house number in it goes out instead of being held", () => {
  const g = evaluateReplyGates({
    draft: draft({ intent: "outreach_open", reply: "Hi Sam, came across your listing at 512 112th Ave NE. I'm in Seattle looking for my next flip anywhere in King County. Is this one a bit of a project, or pretty turnkey?",
      propertyAddress: "512 112th Ave NE, Bellevue, WA 98004" }),
    party: "agent", allowedAmounts: [], inboundMessage: "",
  });
  assert.equal(g.ok, true, g.flags.join(" | "));
});

test("their list price, the ARV and the rehab said in shorthand are not a price we'd pay", () => {
  assert.deepEqual(pricesWeName("Is the seller in a hurry to close, or just testing the market at 625?", 550000), []);
  assert.deepEqual(pricesWeName("Re-ran it on your comps, so about 714 fixed up.", 550000), []);
  assert.deepEqual(pricesWeName("We're at 550 as-is, and it's listed at 700k.", 550000), [550000]);
  assert.deepEqual(pricesWeName("Saw Cheyenne came down to 600k. Any chance the seller would look at our 522k now?", 522000), [522000]);
  assert.deepEqual(pricesWeName("Our 456,250 is still there. Without buyer commission it reads as $470K.", 456250), [456250]);
  assert.deepEqual(pricesWeName("10 day inspection, $2500K EMD, and/or assigns.", 456250), []);
  assert.deepEqual(pricesWeName("300k is way past where we can be, so we're out.", 173250), []);
});

/* ---------- the money guard ---------- */

test("the bot said 'workable for us at 650' on a 550K offer and it went out — it holds now", () => {
  const g = gate();
  assert.equal(g.ok, false);
  assert.ok(g.flags.some((f) => /650,000/.test(f) && /above our/.test(f)), g.flags.join(" | "));
  const auto = decideAutoSend({ gate: g, party: "agent", intent: "deal_available", channel: "sms",
    config: { enabled: true, parties: { agent: { autoSend: { enabled: true, intents: ["deal_available"] } } }, autoSend: { channels: ["sms"] } }, sendsEnabled: true });
  assert.equal(auto.send, false);
  assert.equal(auto.code, "gates");
});

test("a number above our offer holds even when the agent typed it first", () => {
  const g = gate({ intent: "question", reply: "650k works for us on 39811 226th Ave SE. Can you write it up?" },
    { inboundMessage: "$650k plus my fees and we can take it off market for you." });
  assert.equal(g.ok, false);
  assert.ok(g.flags.some((f) => /above our/.test(f)), g.flags.join(" | "));
});

test("saying our own number, or our ARV and rehab as an opinion, still goes", () => {
  assert.equal(gate({ reply: "We're at 550k as-is, cash. Could the sellers live with that?" }).ok, true);
  const g = gate({ reply: "I'm thinking 778K After Repair Value and 54K+ of rehab. What do you think?" },
    { allowedAmounts: [...BOOK, 778000, 54000] });
  assert.equal(g.ok, true, g.flags.join(" | "));
});

test("with no offer on the book the old rules stand — the shorthand is a made-up number", () => {
  const g = evaluateReplyGates({ draft: draft(), party: "agent", allowedAmounts: [], inboundMessage: "" });
  assert.equal(g.ok, false);
  assert.ok(g.flags.some((f) => /650,000/.test(f)), g.flags.join(" | "));
});

test("a counter that names their number stays clean for the band, and the nightly audit never releases it", () => {
  const g = gate({ intent: "counter", reply: "650 works for us. Sending the updated offer over now.", counterAmount: 650000 },
    { inboundMessage: "$650 is their bottom bottom." });
  assert.equal(g.clean, true, g.flags.join(" | "));
  assert.deepEqual(g.overOffer, [650000]);
  const held = { send: false, code: "never_auto", reason: "a counter is a person's call" };
  const out = releaseForAudit({ auto: held, gate: g, draft: draft({ intent: "counter" }), deps: { releaseHeld: true } });
  assert.equal(out.send, false);
});

/* ---------- the acceptance band ---------- */

const THREAD = [
  "[2026-09-14 18:30] US sms: Hi Jesse, here's our written cash offer on 39811 226th Ave SE, Enumclaw, WA 98022 — $550,000, as-is, close on your timeline (attached). Happy to answer any questions.",
  "[2026-09-25 16:57] THEM sms: $650k plus my fees and we can take it off market for you.",
  "[2026-09-25 17:06] US sms: Good news that the roof and AC are handled. That scope is workable for us at 650. Can you write it up on NWMLS forms and send it over for signature?",
  "[2026-09-25 17:07] THEM sms: Yes I can do that. Thanks. Give me an hour.",
].join("\n");
const OFFER = {
  id: "o-enumclaw", address: "39811 226th Ave SE, Enumclaw, WA 98022", cashAmount: 550000, status: "countered",
  statusHistory: [{ ts: "2026-09-14T18:30:48.967Z", status: "countered", amount: 550000, note: "countered at $550,000" },
    { ts: "2026-09-25T16:57:57.962Z", status: "countered", amount: 650000, note: "countered at $650,000" }],
  revisions: [{ to: 550000, ts: "2026-09-14T18:30:50.958Z", from: 514609 }],
  sends: [{ ts: "2026-09-14T18:30:58.825Z", channels: ["sms"] }],
  statusNote: "countered at $650,000", hot: { at: "2026-09-25T17:04:19.354Z", by: "conversation", signal: "writing_up" }, createdAt: "2026-09-14T18:22:15.078Z",
};

test("the number we texted after the offer, above it, is found in the thread", () => {
  const up = ourMoveUp(OFFER, THREAD);
  assert.equal(up?.amount, 650000);
});

test("'Yes I can do that' after we texted 650 on a 550 offer is not them taking our number", () => {
  const v = evaluateAcceptance({
    offer: OFFER, draft: { intent: "acceptance", confidence: "high", needsHuman: false },
    inboundMessage: "Yes I can do that. Thanks. Give me an hour.", band: { acceptance: true, dailyCap: 2 },
    openOffers: [OFFER], comeDown: ourMoveUp(OFFER, THREAD),
  });
  assert.equal(v.passed, false);
  assert.match(v.reason, /650/);
});

test("the live band reads the thread: the acceptance after our 650 text is held for a person", async () => {
  const store = {
    listOffers: async () => [OFFER], getOffer: async () => OFFER, listReplyDrafts: async () => [],
  };
  const config = { parties: { agent: { counterBand: { enabled: true, acceptance: true, dailyCap: 2 } } } };
  const v = await evaluateBandFor({
    store, locationId: "loc", party: "agent", config, saved: {}, transcript: THREAD, now: Date.parse("2026-09-25T17:08:00Z"),
    draft: { intent: "acceptance", confidence: "high", needsHuman: false, propertyAddress: OFFER.address },
    job: { contactId: "c-jesse", message: "Yes I can do that. Thanks. Give me an hour." },
  });
  assert.equal(v.kind, "acceptance_band");
  assert.equal(v.passed, false);
  assert.match(v.reason, /650/);
});

test("our number is the named house's, and the highest of ours when none is named", () => {
  const numbers = [{ address: OFFER.address, amount: 550000 }, { address: "12 Elm St, Kent, WA", amount: 610000 }];
  assert.equal(ourNumberFor(numbers, "39811 226th Ave SE"), 550000);
  assert.equal(ourNumberFor(numbers, ""), 610000);
  // A house with no offer on the book has no number of ours to measure by.
  assert.equal(ourNumberFor(numbers, "4207 S Bateman St, Seattle, WA"), 0);
  assert.equal(ourNumberFor([], "39811 226th Ave SE"), 0);
});

test("no paper goes out at 550 after we texted 650 — a person settles the number", () => {
  const c = paperCheck({ offer: OFFER, transcript: THREAD });
  assert.equal(c.ok, false);
  assert.match(c.reason, /650K/);
  assert.equal(c.comeDown, undefined, "no Re-quote-at-650 button");
});

/* ---------- what the model is told ---------- */

test("the offer book says the 650 counter was theirs, and the 650 we texted is not our number", () => {
  const book = summarizeOffers([OFFER], { transcript: THREAD, now: Date.parse("2026-09-25T17:10:00Z") });
  assert.match(book.text, /they countered at \$650,000/i);
  assert.doesNotMatch(book.text, /note: countered at/i);
  assert.match(book.text, /never revised to it/);
  assert.doesNotMatch(book.text, /HOT/);
  assert.ok(!book.amounts.includes(650000));
});
