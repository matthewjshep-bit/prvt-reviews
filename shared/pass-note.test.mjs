// pass-note.test.mjs — the bot tells the agent we're passing on a house you
// marked (Matt, 2026-10-19).
//
// What would go wrong without these:
//   - a pass on an offer they already have would get a second "we're out" text
//   - three houses marked in a row would be three texts
//   - a house you priced after marking it would still be passed on by text

import test from "node:test";
import assert from "node:assert/strict";
import { wantsPassNote, passNoteHouses, passNoteNotBefore, passNoteStale } from "./pass-note.js";

const NOW = Date.parse("2026-10-19T20:00:00Z");
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const passed = (id, address, code, markedMin, over = {}) => ({ id, address, status: "we_passed", statusAt: ago(markedMin),
  passReason: { code, at: ago(markedMin), by: "operator" }, passNote: { status: "due", markedAt: ago(markedMin) }, ...over });

test("a draft or an unsent row you mark we passed with a reason is due a pass note; an offer they have, or no reason, isn't", () => {
  assert.equal(wantsPassNote({ before: { status: "draft" }, status: "we_passed", reason: "turnkey" }), true);
  assert.equal(wantsPassNote({ before: { status: "new", sends: [] }, status: "we_passed", reason: "rural" }), true);
  assert.equal(wantsPassNote({ before: { status: "new", sends: [{ ts: ago(60) }] }, status: "we_passed", reason: "rural" }), false, "sent");
  assert.equal(wantsPassNote({ before: { status: "new", floatSentAt: ago(60) }, status: "we_passed", reason: "rural" }), false, "floated");
  assert.equal(wantsPassNote({ before: { status: "sent" }, status: "we_passed", reason: "turnkey" }), false);
  assert.equal(wantsPassNote({ before: { status: "draft" }, status: "we_passed", reason: null }), false);
  assert.equal(wantsPassNote({ before: { status: "draft" }, status: "passed", reason: "turnkey" }), false);
  assert.equal(wantsPassNote({ before: { status: "draft" }, status: "we_passed", reason: "nonsense" }), false);
});

test("every house of theirs you marked and the note hasn't gone on is in one note, oldest first; one sent, re-priced or a day old isn't", () => {
  const offers = [
    passed("b", "88 Alder St", "rural", 2),
    passed("a", "1412 Pine St", "turnkey", 5),
    passed("sent", "9 Oak St", "turnkey", 3, { passNote: { status: "sent", markedAt: ago(3) } }),
    passed("priced", "10 Elm St", "turnkey", 3, { status: "new" }),
    passed("old", "11 Fir St", "turnkey", 25 * 60),
    { id: "none", address: "12 Ash St", status: "draft" },
  ];
  const h = passNoteHouses(offers, { now: NOW });
  assert.deepEqual(h.map((x) => [x.address, x.code]), [["1412 Pine St", "turnkey"], ["88 Alder St", "rural"]]);
  assert.match(h[0].words, /too good a shape/);
  // It goes ten minutes after the LAST mark.
  assert.equal(passNoteNotBefore(h), new Date(NOW - 2 * 60000 + 10 * 60000).toISOString());
});

test("at send, a house you priced, un-passed or marked again since stops the note", () => {
  const h = passNoteHouses([passed("a", "1412 Pine St", "turnkey", 5)], { now: NOW });
  const by = (o) => new Map([[o.id, o]]);
  assert.equal(passNoteStale(h, by(passed("a", "1412 Pine St", "turnkey", 5))), "");
  assert.match(passNoteStale(h, by(passed("a", "1412 Pine St", "turnkey", 5, { status: "new" }))), /isn't marked "we passed"/);
  assert.match(passNoteStale(h, by(passed("a", "1412 Pine St", "rural", 1))), /marked again/);
  assert.match(passNoteStale(h, new Map()), /gone/);
});

// The 2026-11-09 audit: 45 pass notes said "we couldn't get it to a number"
// on houses nobody ever priced (the Needs Matt clock passes drafts that
// waited three days with no price).
test("a clock pass with no number of ours never says we couldn't get it to a number", async () => {
  const { passWordsFor } = await import("./offer-status.js");
  const quiet = (over = {}) => passed("q", "77 Birch Ln", "quiet", 3, { cashAmount: null, ...over });
  const [unpriced] = passNoteHouses([quiet()], { now: NOW });
  assert.doesNotMatch(unpriced.words, /couldn't get it to a number/);
  assert.equal(unpriced.words, "we're going to pass on this one for now");
  assert.equal(passWordsFor(quiet()), "we're going to pass on this one for now");
  // An underwrite that produced a number: the offer's cash, the engine's walk-away, or the house record's.
  assert.match(passNoteHouses([quiet({ cashAmount: 241000 })], { now: NOW })[0].words, /couldn't get it to a number/);
  assert.match(passWordsFor(quiet({ pricing: { walkAway: 250000 } })), /couldn't get it to a number/);
  assert.match(passNoteHouses([quiet()], { now: NOW, walkAways: new Map([["q", 230000]]) })[0].words, /couldn't get it to a number/);
  // Every other reason says what it always said.
  assert.match(passWordsFor(passed("t", "1412 Pine St", "turnkey", 5)), /too good a shape/);
  assert.equal(passWordsFor({ status: "we_passed" }), "", "no reason, no words");
});

test("a house our own text named is ours; one they sent is theirs", async () => {
  const { broughtBy } = await import("./pass-note.js");
  const at = (min) => ago(min);
  const ours = [{ type: "outreach_sent", at: at(9000), address: "77 Birch Ln, Kent, WA 98031" }];
  assert.equal(broughtBy({ address: "77 Birch Ln, Kent, WA 98031", events: ours }), "us");
  assert.equal(broughtBy({ address: "77 Birch Ln", events: ours }), "us", "the same street, however it's spelled");
  assert.equal(broughtBy({ address: "88 Alder St, Kent, WA 98031", events: ours }), "them");
  // The conversation moving onto the house our text named (the `ours` stamp).
  assert.equal(broughtBy({ address: "90 Cedar Ct", events: [{ type: "subject_property_set", at: at(60), address: "90 Cedar Ct", data: { ours: true } }] }), "us");
  assert.equal(broughtBy({ address: "90 Cedar Ct", events: [{ type: "subject_property_set", at: at(60), address: "90 Cedar Ct", data: {} }] }), "them");
  // A check-in about it after they'd sent it doesn't make it ours.
  assert.equal(broughtBy({ address: "77 Birch Ln", events: [{ type: "agent_pulse_texted", at: at(10), address: "77 Birch Ln" }], before: at(600) }), "them");
  assert.equal(broughtBy({ address: "", events: ours }), "them");
});
