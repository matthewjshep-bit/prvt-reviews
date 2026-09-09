// counter-amount.test.mjs — the number the other side came back with, as a
// number. It used to survive only inside a sentence ("countered at $310,000"),
// which meant the spread between what we offer and what they ask could not be
// computed without regexing notes.
//
// The parity test at the bottom is the important one: the amount must NOT
// change offer_countered's dedupe key, or a backfill duplicates every counter
// ever recorded.

import test from "node:test";
import assert from "node:assert/strict";
import { offerEvents, eventDedupeKey } from "./shared/contact-record.js";
import { toListOffer } from "./shared/offer-status.js";

// The one mutator, lifted out of routes/offers.js so it can be exercised
// without an Express app. Kept byte-identical to the original.
function recordStatus(offer, status, note = "", ts = new Date().toISOString(), extra = {}) {
  const amount = Math.max(0, Math.round(Number(extra.amount) || 0));
  offer.status = status;
  offer.statusAt = ts;
  offer.statusNote = note;
  offer.statusHistory = [...(offer.statusHistory || []), { status, ts, ...(note ? { note } : {}), ...(amount ? { amount } : {}) }];
  if (status === "countered" && amount) offer.counter = { amount, at: ts, source: extra.source || "operator" };
  return offer;
}

const T1 = "2026-09-05T18:00:00.000Z";
const T2 = "2026-09-07T18:00:00.000Z";
const anOffer = () => ({ id: "o1", contactId: "c1", address: "412 Elm St, Tacoma, WA", cashAmount: 265000, createdAt: T1 });

test("recording a counter keeps the number on the offer and on the ledger row", () => {
  const o = recordStatus(anOffer(), "countered", "countered at $310,000", T1, { amount: 310000, source: "conversation" });
  assert.deepEqual(o.counter, { amount: 310000, at: T1, source: "conversation" });
  assert.equal(o.statusHistory.at(-1).amount, 310000);
});

test("recording a counter with no number leaves no counter object behind", () => {
  const o = recordStatus(anOffer(), "countered", "they want more", T1);
  assert.equal(o.counter, undefined);
  assert.equal(o.statusHistory.at(-1).amount, undefined);
});

test("a second counter replaces the hoisted number and appends to the ledger", () => {
  const o = anOffer();
  recordStatus(o, "countered", "", T1, { amount: 310000 });
  recordStatus(o, "countered", "", T2, { amount: 298000 });
  assert.equal(o.counter.amount, 298000, "the hoisted number is the newest one");
  assert.equal(o.statusHistory.length, 2, "the ledger keeps both");
  assert.deepEqual(o.statusHistory.map((h) => h.amount), [310000, 298000]);
});

test("a pass carries no amount even when one is handed in", () => {
  // Only a counter has a number that means anything. A pass with a dollar
  // figure attached would read as a counter to every downstream consumer.
  const o = recordStatus(anOffer(), "passed", "", T1, { amount: 310000 });
  assert.equal(o.counter, undefined);
});

test("a negative or nonsense amount is dropped rather than stored", () => {
  for (const bad of [-5000, "abc", null, NaN, undefined]) {
    const o = recordStatus(anOffer(), "countered", "", T1, { amount: bad });
    assert.equal(o.counter, undefined, `${bad} should not become a counter`);
  }
});

test("the counter rides on a lean offer row so the band can read it without the full doc", () => {
  const o = recordStatus(anOffer(), "countered", "", T1, { amount: 310000 });
  assert.equal(toListOffer(o).counter.amount, 310000);
});

/* ---------- backfill parity ---------- */

test("an offer event derived from a countered offer carries the number", () => {
  const o = recordStatus(anOffer(), "countered", "no meat at that price", T1, { amount: 310000 });
  const ev = offerEvents(o).find((e) => e.type === "offer_countered");
  assert.equal(ev.data.amount, 310000);
  assert.equal(ev.data.amountText, "$310,000");
  assert.equal(ev.data.note, "no meat at that price");
});

test("the dedupe key for a countered offer is unchanged by the number", () => {
  // THE guard. offer_countered's key comes from its phrase, and the phrase is
  // a constant. If this ever fails, a backfill will duplicate every counter in
  // the book instead of landing on the rows the live writes made.
  const withAmount = offerEvents(recordStatus(anOffer(), "countered", "", T1, { amount: 310000 }))
    .find((e) => e.type === "offer_countered");
  const without = offerEvents(recordStatus(anOffer(), "countered", "", T1))
    .find((e) => e.type === "offer_countered");
  assert.equal(eventDedupeKey(withAmount), eventDedupeKey(without));
  assert.equal(eventDedupeKey(withAmount), "ev:2026-09-05:412 elm st tacoma wa:agent countered");
});
