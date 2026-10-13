import test from "node:test";
import assert from "node:assert/strict";
import {
  ourNumberInText, ourPassInText, normalizeSettle, settlesFrom, settledWithoutAddress, settledContextText, asksAboutSettled,
  settleHoldsUnderwrite, settleStopsMachineText, SETTLED_EVENT,
} from "./settled-by-you.js";

const NOW = Date.parse("2026-10-10T20:25:00Z");
const settle = (over = {}) => ({ type: SETTLED_EVENT, at: "2026-10-05T20:35:08Z", address: "", data: { by: "text", verdict: "priced", amount: 1170000, house: "Bellevue flip", ...over } });

test("the number Matt texted after the call is our number on the house", () => {
  assert.equal(ourNumberInText("$1.17M is what im seeing on my end"), 1170000);
  assert.equal(ourNumberInText("Ah yes $1.17 my mistake on the address, let me know if the seller budges"), 1170000);
  assert.equal(ourNumberInText("I can do 450k on it"), 450000);
  assert.equal(ourNumberInText("best I can do is $452,500"), 452500);
});

test("their price, the rehab, a question or two numbers are not our number", () => {
  assert.equal(ourNumberInText("They're listed at 550k right"), 0);
  assert.equal(ourNumberInText("are they at 550k?"), 0);
  assert.equal(ourNumberInText("rehab looks like 90k"), 0);
  assert.equal(ourNumberInText("somewhere between 400k and 425k"), 0);
  assert.equal(ourNumberInText("talk tomorrow at 10"), 0);
  assert.equal(ourNumberInText("let me know if the seller budges"), 0);
});

test("a person saying it isn't a fit is a pass", () => {
  assert.equal(ourPassInText("Thanks for walking me through it, not a fit for us").toLowerCase(), "not a fit");
  assert.equal(Boolean(ourPassInText("We'll pass on this one")), true);
  assert.equal(ourPassInText("Let me know what the seller says"), "");
});

test("the call reader's verdict is checked before it's written", () => {
  assert.deepEqual(normalizeSettle({ verdict: "priced", amount: 1175000, house: "Bridal Trails" }), { verdict: "priced", amount: 1175000, house: "Bridal Trails" });
  assert.deepEqual(normalizeSettle({ verdict: "priced", amount: 82, house: "" }), { verdict: "priced", amount: 0, house: "" });
  assert.equal(normalizeSettle({ verdict: "", amount: 0, house: "" }), null);
  assert.equal(normalizeSettle(null), null);
});

test("the newest settle per house stands for sixty days", () => {
  const list = settlesFrom([
    settle({ amount: 1150000 }),
    { ...settle(), at: "2026-10-08T16:03:24Z" },
    { ...settle({ house: "old one" }), at: "2026-07-01T00:00:00Z" },
    { type: "hand_reply", at: "2026-10-08T16:03:24Z" },
  ], { now: NOW });
  assert.equal(list.length, 1);
  assert.equal(list[0].amount, 1170000);
  assert.equal(settledWithoutAddress(list, { now: NOW }).house, "Bellevue flip");
});

test("the bot is told the house is settled and not to ask for its address or comps", () => {
  const text = settledContextText(settlesFrom([settle()], { now: NOW }));
  assert.match(text, /HOUSES MATT SETTLED HIMSELF/);
  assert.match(text, /Bellevue flip \(no address on file, and none needed\): Matt gave them \$1,170,000 by text on Oct 5\. That IS our number on it\./);
  assert.match(text, /never ask for its address/);
  assert.equal(settledContextText([]), "");
});

test("the 10/10 text that asked for the address to run comps and confirm it is caught", () => {
  assert.ok(asksAboutSettled("Right, 1.17 was our read off what you gave me on the call, but I still need the actual address to run comps and confirm it. Can you send it over?"));
  assert.ok(asksAboutSettled("Still happy to run comps once I've got the address."));
  assert.ok(asksAboutSettled("Can you send over the address so we can start running comps on our end?"));
  assert.ok(asksAboutSettled("What's the Bellevue address when you get a sec?"));
  assert.equal(asksAboutSettled("Sounds good, 1.17 stands. Let me know if the seller budges."), "");
});

test("no underwrite starts by itself on a house you settled", () => {
  const settles = settlesFrom([settle()], { now: NOW });
  assert.match(settleHoldsUnderwrite({ settles, propertyAddress: "", now: NOW }), /you settled Bellevue flip/);
  assert.equal(settleHoldsUnderwrite({ settles, propertyAddress: "123 Main St, Renton, WA", now: NOW }), "");
  const priced = settlesFrom([settle({}), { ...settle(), address: "123 Main St, Renton, WA 98055" }], { now: NOW });
  assert.match(settleHoldsUnderwrite({ settles: priced, propertyAddress: "123 Main Street, Renton, WA 98055", now: NOW }), /123 Main St/);
  // Two weeks on, a house with no address is a new one.
  assert.equal(settleHoldsUnderwrite({ settles, propertyAddress: "", now: NOW + 20 * 86400000 }), "");
});

test("the address chase, the promise text and the promise check-in stop on a settled house", () => {
  const settles = settlesFrom([settle()], { now: NOW });
  assert.ok(settleStopsMachineText({ kind: "address_chase", subject: { address: "" }, settles, now: NOW }));
  assert.ok(settleStopsMachineText({ kind: "promise_due", subject: { address: "" }, settles, now: NOW }));
  assert.ok(settleStopsMachineText({ kind: "checkin_due", subject: { address: "", sourceKind: "promise" }, settles, now: NOW }));
  // The check-in that asks for their next house still goes.
  assert.equal(settleStopsMachineText({ kind: "agent_pulse", subject: { address: "" }, settles, now: NOW }), "");
  assert.equal(settleStopsMachineText({ kind: "checkin_due", subject: { address: "", sourceKind: "source" }, settles, now: NOW }), "");
  // A promise about a house with an address is that house's business.
  assert.equal(settleStopsMachineText({ kind: "promise_due", subject: { address: "9 Elm St, Kent, WA" }, settles, now: NOW }), "");
});

test("a house you passed on by phone gets no more machine texts", () => {
  const settles = settlesFrom([{ ...settle({ verdict: "passed", amount: 0 }), address: "9 Elm St, Kent, WA 98030" }], { now: NOW });
  assert.match(settleStopsMachineText({ kind: "offer_nudge", address: "9 Elm Street, Kent, WA 98030", settles, now: NOW }), /you passed on 9 Elm St/);
  assert.equal(settleStopsMachineText({ kind: "offer_nudge", address: "11 Oak St, Kent, WA 98030", settles, now: NOW }), "");
});
