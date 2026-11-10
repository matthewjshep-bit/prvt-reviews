// standard-texts.test.mjs — the cold ladder's check-ins after day 16
// (2026-11-09).
//
// Matt: bring back the day 30, 44 and 58 texts to agents who never answered,
// in his own plain style. The old pool had three texts for four rungs, so
// day 58 sent the day-16 text word for word, and its third text ("any
// distressed or value-add properties … always happy to take a look") drew no
// replies and five opt-outs in 109 sends. A check-in now names one real
// thing (a new listing of theirs, or their town), the last one says it is the
// last, and none repeats a text we sent them lately.
//
// Every name, street and town here is invented.

import test from "node:test";
import assert from "node:assert/strict";
import { standardText, fillTemplate, plainBody } from "./standard-texts.js";
import {
  normalizeOpener, DEFAULT_CHECK_IN_TEXTS, PREVIOUS_DEFAULT_CHECK_IN_TEXTS, COLD_LISTING_CHECK_IN_TEXTS, COLD_LAST_RUNG_TEXTS,
} from "./outreach-opener.js";
import { carrierFlags } from "./carrier-words.js";

// A cold agent's check-in as the reply agent describes it (ghl-broker/
// reply-agent.js outboundDescriptor): ladder [2] every 14 days, so day 16 is
// repeat 1 and day 58 is repeat 4, the last.
const rung = (repeatN, more = {}) => ({
  kind: "outreach_nudge", mode: "template", address: "4410 Quarry Rd, Halden, WA 98011", city: "Halden",
  repeats: true, stepIndex: 0, repeatN, repeatMax: 4, checkIns: [...DEFAULT_CHECK_IN_TEXTS], ...more,
});
const textFor = (repeatN, more = {}, { name = "Wendell Okafor", contactId = "c-wendell", prior = [] } = {}) =>
  standardText({ kind: "outreach_nudge", outbound: rung(repeatN, more), name, contactId, prior });

test("a cold agent's day-58 text isn't their day-16 text", () => {
  for (let i = 0; i < 40; i++) {
    const contactId = `c-cold-${i}`;
    const day16 = textFor(1, {}, { contactId });
    const day58 = textFor(4, {}, { contactId });
    assert.ok(day16?.text && day58?.text, contactId);
    assert.notEqual(plainBody(day58.text), plainBody(day16.text), `${contactId}: ${day58.text}`);
  }
  // Matt's own three-text list too: the last rung is the goodbye, never text 1 again.
  const own = ["Hi {first}, any fixers lately?", "Hey {first}, anything that needs work?", "{first}, got any rough ones?"];
  for (let i = 0; i < 12; i++) {
    const contactId = `c-own-${i}`;
    const day16 = textFor(1, { checkIns: own }, { contactId });
    const day58 = textFor(4, { checkIns: own }, { contactId });
    assert.notEqual(plainBody(day58.text), plainBody(day16.text), `${contactId}: ${day58.text}`);
  }
});

test("the last rung says it is the last one", () => {
  const t = textFor(4);
  assert.equal(t.set, "cold_last");
  assert.match(t.text, /last one from me|leave you be/i, t.text);
  assert.ok(COLD_LAST_RUNG_TEXTS.map((x) => fillTemplate(x, { first: "Wendell", town: "Halden" })).includes(t.text));
  // A ladder with a cap of its own: its last repeat is the goodbye.
  assert.equal(textFor(2, { repeatMax: 2 }).set, "cold_last");
  assert.notEqual(textFor(1, { repeatMax: 2 }).set, "cold_last");
});

test("a cold check-in names a new listing of theirs when one came up, else their town", () => {
  const fresh = { street: "Larch Ave", address: "88 Larch Ave, Halden, WA 98011", city: "Halden" };
  for (let i = 0; i < 20; i++) {
    const contactId = `c-listing-${i}`;
    const withListing = textFor(2, { freshListing: fresh }, { contactId });
    assert.equal(withListing.set, "cold_listing", withListing.text);
    assert.match(withListing.text, /Larch Ave/, withListing.text);
    assert.doesNotMatch(withListing.text, /\b88\b|Quarry/, "the street, never the house number, and never the first-text house");
    const plain = textFor(2, {}, { contactId });
    assert.equal(plain.set, "check_in");
    assert.match(plain.text, /Halden/, `${contactId}: ${plain.text}`);
    assert.doesNotMatch(plain.text, /Quarry/, "a rung never names the house the first text was about");
  }
  // No town on record: one of the texts that doesn't need one.
  const noTown = textFor(2, { city: "", address: "" });
  assert.ok(noTown?.text, "still a text");
  assert.doesNotMatch(noTown.text, /\{|\}|around ,|near \?/, noTown.text);
  // The last rung beats the listing: it is the goodbye either way.
  assert.equal(textFor(4, { freshListing: fresh }).set, "cold_last");
});

test("no cold check-in says circling back, checking in, desk or radar, and every one passes the carrier check with and without a first name", () => {
  const values = { street: "Larch Ave", town: "Halden", address: "4410 Quarry Rd" };
  for (const t of [...DEFAULT_CHECK_IN_TEXTS, ...COLD_LISTING_CHECK_IN_TEXTS, ...COLD_LAST_RUNG_TEXTS]) {
    for (const first of ["Wendell", ""]) {
      const text = fillTemplate(t, { ...values, first });
      assert.ok(text, t);
      assert.doesNotMatch(text, /circling back|checking in|check in|\bdesk\b|\bradar\b|value[- ]add|always happy|just checking|touch base|reach out/i, text);
      assert.doesNotMatch(text, /[—–!]/, `no dashes or exclamation marks: ${text}`);
      assert.deepEqual(carrierFlags(text), [], text);
      assert.ok(text.length <= 160, `${text.length}: ${text}`);
      assert.match(text, /^[A-Z]/, `starts like a sentence: ${text}`);
      assert.doesNotMatch(text, /^,|,\s*[.?]|\s[,.?]|\{|\}/, `reads cleanly: ${text}`);
      assert.equal((text.match(/\?/g) || []).length, 1, `one ask: ${text}`);
    }
  }
});

test("a stored copy of the old check-in texts upgrades to the new ones, and Matt's own edited list is kept", () => {
  assert.equal(PREVIOUS_DEFAULT_CHECK_IN_TEXTS.length, 3);
  assert.deepEqual(normalizeOpener({ checkIns: PREVIOUS_DEFAULT_CHECK_IN_TEXTS }).checkIns, DEFAULT_CHECK_IN_TEXTS);
  assert.deepEqual(normalizeOpener({}).checkIns, DEFAULT_CHECK_IN_TEXTS);
  const mine = ["Hi {first}, anything rough near {town} lately?", ...PREVIOUS_DEFAULT_CHECK_IN_TEXTS.slice(1)];
  assert.deepEqual(normalizeOpener({ checkIns: mine }).checkIns, mine, "one line changed is his list");
  // The follow-ups and first texts are untouched.
  assert.deepEqual(normalizeOpener({ checkIns: PREVIOUS_DEFAULT_CHECK_IN_TEXTS }).followUps, normalizeOpener({}).followUps);
});

test("a cold check-in never repeats one of our last texts to them, however it was greeted or punctuated", () => {
  const first = textFor(2);
  assert.ok(first?.text);
  // The same words, sent to them before with another greeting and no question mark.
  const echoed = first.text.replace(/^(Hi|Hey) Wendell, /, "hey wendell ").replace(/\?$/, "");
  const next = textFor(2, {}, { prior: ["Thanks, talk soon", echoed] });
  assert.ok(next?.text);
  assert.notEqual(plainBody(next.text, "Wendell"), plainBody(first.text, "Wendell"), next.text);
  assert.equal(plainBody(echoed, "Wendell"), plainBody(first.text, "Wendell"));
  // Every check-in text already sent: the next pool along, never a repeat.
  const all = DEFAULT_CHECK_IN_TEXTS.map((t) => fillTemplate(t, { first: "Wendell", town: "Halden" }));
  const last = textFor(2, {}, { prior: all });
  assert.ok(!last || !all.map((t) => plainBody(t, "Wendell")).includes(plainBody(last.text, "Wendell")), last?.text);
});

test("the first follow-up and every other kind read as before", () => {
  const day2 = standardText({ kind: "outreach_nudge", outbound: { mode: "template", address: "4410 Quarry Rd, Halden, WA 98011", step: 2, stepIndex: 1, stepCount: 1, repeats: true,
    followUps: normalizeOpener({}).followUps, checkIns: DEFAULT_CHECK_IN_TEXTS }, name: "Wendell", contactId: "c-wendell" });
  assert.equal(day2.set, "follow_up");
  assert.match(day2.text, /4410 Quarry Rd/, "day 2 is still the text about their listing");
  // No first name: "Hi," as before.
  assert.equal(fillTemplate("Hi {first}, anything new?", { first: "" }), "Hi, anything new?");
});
