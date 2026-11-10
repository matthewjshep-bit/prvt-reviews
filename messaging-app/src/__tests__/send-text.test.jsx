// The offer text the Send box starts from (2026-11-09). It still said "$412,000 cash, as-is" with an
// em dash after the server dropped those words on 10-02: carriers blocked 13 of the 67 app offer
// texts that said "cash, as-is", so those agents never saw our number. The box and the server now
// start from the same words (shared/offer-send-text.js); what you type over them is yours.
import { test, expect } from "vitest";
import { defaultSendMessage } from "../SendModal.jsx";
import { buildMessage as netSheetMessage } from "../NetSheetModal.jsx";
import { netComparison } from "@shared/offer-calc.js";
import { offerSendText } from "@shared/offer-send-text.js";

const OFFER = { id: "o1", contactName: "Dana Reeves", address: "27 Wrenfield Ct, Renton, WA 98055", cashAmount: 412000, calc: { settings: {}, inputs: {}, offers: {} } };

test("the offer text an agent gets says neither cash nor as-is, has no dash or dollar sign, and still reads as our letter of intent", () => {
  const t = defaultSendMessage(OFFER);
  expect(t).toBe("Hi Dana, here's our letter of intent on 27 Wrenfield Ct: 412k, close on your timeline. Letter's attached. If the seller's open to it, could you write it up on NWMLS forms and represent us?");
  expect(t).not.toMatch(/\bcash\b|as-is|\$|—|–/i);
  expect(t).toMatch(/here's our letter of intent on/);
});

test("the app's send box and the server fall back to the same words", () => {
  expect(defaultSendMessage(OFFER)).toBe(offerSendText({ first: "Dana", address: OFFER.address, amount: 412000 }));
  // No first name: it opens on the letter, not "Hi there".
  expect(defaultSendMessage({ ...OFFER, contactName: "" })).toMatch(/^Here's our letter of intent on 27 Wrenfield Ct: 412k/);
});

// UWM-16: the seller's net leaves out WA excise tax and closing costs; the message says so (the math is unchanged).
test("the net sheet message says the seller's net is before excise tax and closing costs", () => {
  const net = netComparison(412000, { sellerAgentPct: 3, buyerAgentPct: 3 });
  const m = netSheetMessage(OFFER, net);
  expect(m).toMatch(/the seller nets about \$[\d,]+ after the listing side's 3% and before excise tax and closing costs\./);
});

// The net sheet's message is pasted to the agent, often as a text: it opened on "$412,000, as-is"
// with an em dash, the words the carriers block. It opens the way the offer text does now.
test("the net sheet message opens like the offer text, with no as-is and no dash", () => {
  const net = netComparison(412000, { sellerAgentPct: 3, buyerAgentPct: 3 });
  const m = netSheetMessage(OFFER, net);
  expect(m.startsWith("Hi Dana, here's our letter of intent on 27 Wrenfield Ct: 412k, close on your timeline. Letter's attached.\n\n")).toBe(true);
  expect(m).not.toMatch(/\bcash\b|as-is|—|–/i);
  expect(m).toMatch(/Happy to walk through any of it\.$/);
});
