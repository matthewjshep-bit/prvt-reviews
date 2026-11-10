// The offer text the Send box starts from (2026-11-09). It still said "$412,000 cash, as-is" with an
// em dash after the server dropped those words on 10-02: carriers blocked 13 of the 67 app offer
// texts that said "cash, as-is", so those agents never saw our number. The box and the server now
// start from the same words (shared/offer-send-text.js); what you type over them is yours.
import { test, expect } from "vitest";
import { defaultSendMessage } from "../SendModal.jsx";
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
