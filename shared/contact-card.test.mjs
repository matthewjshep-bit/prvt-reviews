import test from "node:test";
import assert from "node:assert/strict";
import {
  asksForContact, passMoment, cardMoment, normalizeContactCard, cardReady, cardFileName, isVcard, CONTACT_CARD_DEFAULTS,
} from "./contact-card.js";

const VCARD = "BEGIN:VCARD\nVERSION:3.0\nFN:Pat Example\nTEL:+15550000000\nEND:VCARD";
const TOKEN = "0123456789abcdef01234567";
const card = (over = {}) => normalizeContactCard({ enabled: true, vcard: VCARD, token: TOKEN, ...over });
const NOW = Date.parse("2026-10-09T18:00:00Z");

test("an agent who asks who we are or how to reach us gets the card", () => {
  for (const t of [
    "What's your email?", "whats your email address", "Who is this?", "who's this", "Whos this",
    "can I get your contact info", "send me your info", "What company are you with?",
    "Do you have a website?", "what's the best number to reach you", "How can I reach you?",
    "Could I have your cell number", "what’s your name again?",
  ]) assert.equal(asksForContact(t), true, t);
});

test("our number, a mention of our email, and plain talk about the house are not an ask for the card", () => {
  for (const t of [
    "What's your number on it?", "I got your email, will present tonight", "Thanks for the info",
    "Seller wants 450", "can you send me your offer", "Is this still available?", "", null,
  ]) assert.equal(asksForContact(t), false, String(t));
});

test("a house that didn't work is a pass moment for agents only", () => {
  assert.equal(passMoment({ party: "agent", intent: "rejection" }), "they passed");
  assert.equal(passMoment({ party: "agent", intent: "question", outbound: { kind: "kind_pass" } }), "we passed");
  assert.equal(passMoment({ party: "agent", intent: "investor_open", notOurKind: true }), "not our kind of house");
  assert.equal(passMoment({ party: "agent", intent: "investor_open", qualify: { stage: "pass" } }), "we passed");
  assert.equal(passMoment({ party: "agent", intent: "deal_available", qualify: { stage: "ask" } }), "");
  assert.equal(passMoment({ party: "investor", intent: "passing" }), "");
  assert.equal(passMoment({ party: "agent", intent: "question" }), "");
});

test("the card follows an ask, and the save-me line follows a pass once ever", () => {
  const ask = cardMoment({ card: card(), draft: { party: "agent", intent: "question", inbound: "who is this?" }, body: "Matt with Shep Flips", now: NOW });
  assert.deepEqual(ask, { send: true, why: "they asked", text: CONTACT_CARD_DEFAULTS.askText });

  const pass = cardMoment({ card: card(), draft: { party: "agent", intent: "rejection", inbound: "seller won't go that low" }, body: "Understood, thanks", now: NOW });
  assert.deepEqual(pass, { send: true, why: "they passed", text: CONTACT_CARD_DEFAULTS.passText });

  const again = cardMoment({ card: card(), draft: { party: "agent", intent: "rejection" }, body: "ok", sentCards: [{ at: "2026-01-01T00:00:00Z" }], now: NOW });
  assert.equal(again.send, false);
  assert.equal(again.why, "they already have the card");
});

test("a second ask inside the week gets no second card; after the week it does", () => {
  const draft = { party: "investor", intent: "question", inbound: "what's your email" };
  assert.equal(cardMoment({ card: card(), draft, body: "x", sentCards: [{ at: new Date(NOW - 2 * 86400000).toISOString() }], now: NOW }).send, false);
  assert.equal(cardMoment({ card: card(), draft, body: "x", sentCards: [{ at: new Date(NOW - 8 * 86400000).toISOString() }], now: NOW }).send, true);
});

test("no card when it's off, on a cold first text, on an email, or when nothing went", () => {
  const draft = { party: "agent", intent: "rejection" };
  assert.equal(cardMoment({ card: card({ enabled: false }), draft, body: "x", now: NOW }).why, "off");
  assert.equal(cardMoment({ card: card({ vcard: "" }), draft, body: "x", now: NOW }).why, "off");
  assert.equal(cardMoment({ card: card({ token: "" }), draft, body: "x", now: NOW }).why, "off");
  assert.equal(cardMoment({ card: card(), draft: { ...draft, outbound: { kind: "outreach_open" } }, body: "x", now: NOW }).send, false);
  assert.equal(cardMoment({ card: card(), draft: { ...draft, channel: "email" }, body: "x", now: NOW }).send, false);
  assert.equal(cardMoment({ card: card(), draft, body: "  ", now: NOW }).send, false);
  assert.equal(cardMoment({ card: card({ onPass: false }), draft, body: "x", now: NOW }).send, false);
  assert.equal(cardMoment({ card: card({ onAsk: false }), draft: { party: "agent", inbound: "who is this" }, body: "x", now: NOW }).send, false);
});

test("the card ships off, keeps only a real vCard and a well-formed token, and names its file", () => {
  const d = normalizeContactCard();
  assert.equal(d.enabled, false);
  assert.equal(cardReady(d), false);
  assert.equal(normalizeContactCard({ vcard: "hello" }).vcard, "");
  assert.equal(normalizeContactCard({ vcard: `\r\n${VCARD}\r\n` }).vcard, VCARD);
  assert.equal(normalizeContactCard({ token: "short" }).token, "");
  assert.equal(normalizeContactCard({ token: TOKEN }).token, TOKEN);
  assert.equal(cardFileName("Matt Shepherd"), "Matt Shepherd.vcf");
  assert.equal(cardFileName("../x\"y.vcf"), "x y.vcf");
  assert.equal(cardFileName(""), "contact.vcf");
  assert.ok(isVcard(VCARD));
  const n = normalizeContactCard({ enabled: true, vcard: VCARD, token: TOKEN, askRepeatDays: 500 });
  assert.deepEqual(normalizeContactCard(n), n);
  assert.equal(n.askRepeatDays, 90);
});
