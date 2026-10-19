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
