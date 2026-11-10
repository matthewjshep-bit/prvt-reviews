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

/* ---------- the real write paths (2026-11-09) ---------- */

// The tests above exercise a copy of recordStatus. These go through the two
// places a counter is actually written: the conversation's setOfferStatus
// (an agent's text) and the status menu's PATCH /:id/status (Matt's hand).
// An agent who came down while the offer already read "countered" kept the
// old number, so the Desk showed the old gap and the hold clock kept
// nudging; a counter Matt marked by hand had no number at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { callsInstead } from "./shared/counter-hold.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "counter-amount-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;
const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-counter-amount";
const resolveLocation = () => ({ locationId: LOC, client: { call: async () => ({}) } });
const app = express();
app.use(express.json());
const offersRouter = createOffersRouter({ resolveLocation, uploadDir: process.env.DATA_DIR });
app.use("/api/offers", offersRouter);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());
const patch = (p, body) => fetch(`${B}/api/offers${p}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));
const deps = () => offersRouter.conversationDepsFor({ locationId: LOC, client: { call: async () => ({}) }, saved: {} });
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

test("an agent who comes down from 480 to 430 has 430 on file, and the hold stands down for a call", async () => {
  const address = "2208 Quillback Rd, Auburn, WA 98002";
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-q", contactName: "Rowan Agent", address,
    cashAmount: 400000, status: "countered", createdAt: daysAgo(6), statusAt: daysAgo(4),
    statusHistory: [{ status: "sent", ts: daysAgo(6) }, { status: "countered", ts: daysAgo(4), amount: 480000 }],
    sends: [{ ts: daysAgo(6) }], counter: { amount: 480000, at: daysAgo(4), source: "conversation" },
    // We held our number the day after their 480.
    counterHold: { at: daysAgo(3), ours: 400000, nudges: [], replies: [] } });
  assert.equal(callsInstead(await store.getOffer(o.id)), false, "480 against our 400 is a hold, not a call");

  const r = await deps().setOfferStatus({ contactId: "agent-q", addressHint: address, status: "countered", amount: 430000 });
  assert.equal(r.ok, true, r.reason);
  assert.notEqual(r.unchanged, true, "a new number is news even when the status already reads countered");
  const after = await store.getOffer(o.id);
  assert.equal(after.counter.amount, 430000);
  assert.equal(after.statusHistory.at(-1).amount, 430000, "the history keeps both");
  assert.equal(after.statusHistory.filter((h) => h.status === "countered").length, 2);
  assert.equal(callsInstead(after), true, "430 is within 10% of our 400: a call, not another check-in");

  // The same number again is nothing new.
  const again = await deps().setOfferStatus({ contactId: "agent-q", addressHint: address, status: "countered", amount: 430000 });
  assert.equal(again.unchanged, true);
  assert.equal((await store.getOffer(o.id)).statusHistory.length, 3);
  // And a counter with no number never wipes the one on file.
  const bare = await deps().setOfferStatus({ contactId: "agent-q", addressHint: address, status: "countered" });
  assert.equal(bare.unchanged, true);
  assert.equal((await store.getOffer(o.id)).counter.amount, 430000);
});

test("a counter marked by hand with their number records it", async () => {
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-w", contactName: "Wren Agent", address: "917 Tidewater Ln, Kent, WA 98031",
    cashAmount: 300000, status: "sent", createdAt: daysAgo(3), statusHistory: [{ status: "sent", ts: daysAgo(3) }], sends: [{ ts: daysAgo(3) }] });
  const r = await patch(`/${o.id}/status`, { status: "countered", amount: "345k" });
  assert.equal(r.status, 200, r.error);
  assert.equal(r.offer.counter.amount, 345000, "typed the way a person types it");
  assert.equal(r.offer.counter.source, "operator");
  // They came down on the phone: marked again with the new number.
  const down = await patch(`/${o.id}/status`, { status: "countered", amount: 330000 });
  assert.equal(down.offer.counter.amount, 330000);
  // A number that doesn't read is refused, not dropped.
  const junk = await patch(`/${o.id}/status`, { status: "countered", amount: "three thirty" });
  assert.equal(junk.status, 400);
  assert.equal((await store.getOffer(o.id)).counter.amount, 330000);
});
