// offer-send-text.test.mjs — the text that carries our letter of intent.

import test from "node:test";
import assert from "node:assert/strict";
import { offerSendText, forRecordText, moneyText, streetOf } from "./offer-send-text.js";
import { carrierFlags } from "./carrier-words.js";
import { OFFER_DOC_TEXT_RX, pricesWeName } from "./current-offer.js";

// reply-agent.js OUR_OFFER_TEXT_RX, copied: the broker's own test pins the real one.
const OUR_OFFER_TEXT_RX = /\b(?:here's our (?:written cash offer|letter of intent)|sending our written offer|please find our (?:letter of intent|written (?:cash )?offer)) on\b/i;

test("the offer text an agent gets says neither cash nor as-is, has no dash or dollar sign, and still reads as our letter of intent", () => {
  const t = offerSendText({ first: "Dana Quill", address: "4417 Somerset Ln, Tacoma, WA 98404", amount: 525000 });
  assert.equal(t, "Hi Dana, here's our letter of intent on 4417 Somerset Ln: 525k, close on your timeline. Letter's attached. If the seller's open to it, could you write it up on NWMLS forms and represent us?");
  for (const text of [t, forRecordText({ first: "Dana", address: "4417 Somerset Ln, Tacoma, WA 98404", amount: 451750, askWriteUp: false })]) {
    assert.doesNotMatch(text, /\bcash\b/i);
    assert.doesNotMatch(text, /as-is/i);
    assert.doesNotMatch(text, /[—–]| - /, "no dash");
    assert.doesNotMatch(text, /\$/);
    assert.doesNotMatch(text, /98404|Tacoma/, "the street, not the full address");
    assert.deepEqual(carrierFlags(text), [], text);
    assert.match(text, OUR_OFFER_TEXT_RX);
    assert.match(text, OFFER_DOC_TEXT_RX);
    assert.equal((text.match(/\?/g) || []).length <= 1, true, "one ask");
  }
  // Our own number reads back off it (the thread's last quote on the house).
  assert.deepEqual(pricesWeName(t, 525000), [525000]);
  assert.deepEqual(pricesWeName(offerSendText({ first: "Dana", street: "12 Elm St", amount: 451750 }), 451750), [451750]);
});

test("no first name opens on the letter, an Oregon house is written on OREF forms, and the math rides along", () => {
  assert.match(offerSendText({ address: "88 Alder Ct, Bend, OR 97701", amount: 310000 }), /^Here's our letter of intent on 88 Alder Ct: 310k, .* write it up on OREF forms and represent us\?$/);
  const math = "We base it on about 70% of the 500k it's worth fixed up, less the 66k of work; the rest covers our profit and risk.";
  const t = offerSendText({ first: "Dana", street: "12 Elm St", amount: 254000, math });
  assert.ok(t.includes(`Letter's attached. ${math} If the seller's open to it`), t);
  // A number nobody approved never asks for the write-up.
  assert.match(offerSendText({ first: "Dana", street: "12 Elm St", amount: 254000, askWriteUp: false }), /Letter's attached\. Let me know what the seller thinks\.$/);
});

test("the written offer for their records keeps the words the readers know", () => {
  const t = forRecordText({ first: "Dana", address: "12 Elm St, Renton, WA 98056", amount: 300000 });
  assert.equal(t, "Hi Dana, sending our written offer on 12 Elm St over so you have it on file: 300k, close on your timeline. Letter's attached. If the seller's open to it, could you write it up on NWMLS forms and represent us?");
  assert.match(forRecordText({ street: "12 Elm St", amount: 300000, askWriteUp: false }), /^Sending our written offer on 12 Elm St over .* Happy to answer any questions\.$/);
});

test("money reads the way we text it", () => {
  assert.equal(moneyText(525000), "525k");
  assert.equal(moneyText(451750), "451,750");
  assert.equal(moneyText(1250000), "1,250,000", "a million or more stays exact: '1.25M' doesn't read back as our number");
  assert.equal(moneyText(0), "");
  assert.equal(streetOf("4417 Somerset Ln, Tacoma, WA 98404"), "4417 Somerset Ln");
});
