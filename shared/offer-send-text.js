// offer-send-text.js — the text that carries our letter of intent to the agent (2026-11-09).
//
// One set of words for the app's Send box (messaging-app/src/SendModal.jsx) and the server's own
// sends (ghl-broker/routes/offers.js sendOfferDocs, when no message is handed in). They had drifted:
// the server dropped "cash, as-is" on 10-02 because the carriers block it, and the app kept it, with
// an em dash and a dollar sign. 13 of the 67 app offer texts that said "cash, as-is" from 9-20 to
// 11-03 were blocked (Error 30007), so those agents never got our number. We fund with a hard money
// loan anyway (memory hard-money-not-cash).
//
// The rules: no "cash", no "as-is", no dash, no "$"; money as "525k" (a round thousand) or
// "451,750"; the street, not the full address with the ZIP; one ask. Both texts keep the words
// OUR_OFFER_TEXT_RX (ghl-broker/reply-agent.js) and OFFER_DOC_TEXT_RX (shared/current-offer.js)
// read our own offer texts by: "here's our letter of intent on" and "sending our written offer on".
// Text a person types in the Send box is theirs and is never rewritten.
//
// Pure.

import { parseUsAddress } from "./us-address.js";

/** moneyText(n) → "525k" for a round thousand under a million, else "451,750" / "1,250,000". */
export function moneyText(n) {
  const v = Math.round(Number(n) || 0);
  if (!(v > 0)) return "";
  return v < 1e6 && v % 1000 === 0 ? `${v / 1000}k` : v.toLocaleString("en-US");
}

/** streetOf(address) → "4417 Somerset Ln" from "4417 Somerset Ln, Tacoma, WA 98404". */
export const streetOf = (address = "") => String(address || "").split(",")[0].trim();

// The forms the agent writes it up on: OREF for an Oregon house, NWMLS otherwise.
const formsFor = ({ state = "", address = "" }) => {
  const st = String(state || parseUsAddress(String(address || "")).state || "").toUpperCase();
  return st === "OR" ? "OREF" : "NWMLS";
};

const parts = ({ first = "", street = "", address = "", amount = 0, amountK = "", state = "", math = "", askWriteUp = true } = {}) => ({
  name: String(first || "").trim().split(/\s+/)[0] || "",
  where: String(street || "").trim() || streetOf(address) || "your property",
  k: String(amountK || "").trim() || moneyText(amount),
  forms: formsFor({ state, address }),
  math: String(math || "").trim(),
  askWriteUp,
});

const ask = (p, otherwise) => (p.askWriteUp
  ? ` If the seller's open to it, could you write it up on ${p.forms} forms and represent us?`
  : ` ${otherwise}`);

/**
 * offerSendText({ first, street|address, amount|amountK, state, math, askWriteUp }) →
 *   "Hi Dana, here's our letter of intent on 4417 Somerset Ln: 525k, close on your timeline.
 *    Letter's attached. If the seller's open to it, could you write it up on NWMLS forms and
 *    represent us?"
 *
 * `math`: how we got the number, one sentence (shared/offer-breakdown.js mathSentence), or "".
 * `askWriteUp`: false when nobody approved the number (numberApproved): it asks what the seller
 * thinks instead of asking for the write-up.
 */
export function offerSendText(o = {}) {
  const p = parts(o);
  const open = p.name ? `Hi ${p.name}, here's` : "Here's";
  return `${open} our letter of intent on ${p.where}${p.k ? `: ${p.k}` : ""}, close on your timeline. Letter's attached.` +
    `${p.math ? ` ${p.math}` : ""}${ask(p, "Let me know what the seller thinks.")}`;
}

/**
 * forRecordText({ ... }) → the written offer sent so they have it on file: after a float nobody
 * answered, or with the reply to a no (template "for_record").
 */
export function forRecordText(o = {}) {
  const p = parts(o);
  const open = p.name ? `Hi ${p.name}, sending` : "Sending";
  return `${open} our written offer on ${p.where} over so you have it on file${p.k ? `: ${p.k}` : ""}, close on your timeline. Letter's attached.` +
    `${p.math ? ` ${p.math}` : ""}${ask(p, "Happy to answer any questions.")}`;
}
