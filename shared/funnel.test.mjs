// funnel.test.mjs — the report. Read-only by design; these tests mostly pin
// the counting rules, because a funnel that double-counts is worse than no
// funnel at all.

import test from "node:test";
import assert from "node:assert/strict";
import { offerFunnel, counterSpread, passReasons, followUpPerformance, priceBand } from "./funnel.js";

const h = (status, ts, extra = {}) => ({ status, ts, ...extra });
const D = (n) => `2026-09-${String(n).padStart(2, "0")}T12:00:00.000Z`;

test("an offer that was sent then countered then passed counts once in each column", () => {
  const f = offerFunnel([{ id: "o1", createdAt: D(1), cashAmount: 265000,
    statusHistory: [h("new", D(1)), h("sent", D(2)), h("countered", D(4)), h("passed", D(6))] }]);
  assert.equal(f.created, 1);
  assert.equal(f.sent, 1);
  assert.equal(f.countered, 1);
  assert.equal(f.passed, 1);
  assert.equal(f.open, 0);
});

test("an offer we walked away from is dead, counted apart from the ones they refused", () => {
  const f = offerFunnel([
    { id: "a", createdAt: D(1), statusHistory: [h("sent", D(2)), h("we_passed", D(5))] },
    { id: "b", createdAt: D(1), statusHistory: [h("sent", D(2)), h("passed", D(5))] },
  ]);
  assert.equal(f.sent, 2);
  assert.equal(f.passed, 1);
  assert.equal(f.wePassed, 1);
  assert.equal(f.open, 0);
  assert.equal(f.rates.deadOfSent, 100);
});

test("an offer sent twice is still one send", () => {
  // FIRST occurrence only — otherwise a chased offer inflates the funnel and
  // the conversion rate quietly falls as you work harder.
  const f = offerFunnel([{ id: "o1", createdAt: D(1), statusHistory: [h("sent", D(2)), h("sent", D(5))] }]);
  assert.equal(f.sent, 1);
});

test("an offer with no status history is counted from its effective status", () => {
  const f = offerFunnel([{ id: "o1", createdAt: D(1), sends: [{ ts: D(2) }] }]);
  assert.equal(f.created, 1);
  assert.equal(f.sent, 1);
});

test("a draft never counts — it never left the building", () => {
  assert.equal(offerFunnel([{ id: "o1", status: "draft", createdAt: D(1) }]).created, 0);
});

test("a promoted deal counts as accepted even when nobody wrote the status down", () => {
  const f = offerFunnel([{ id: "o1", createdAt: D(1), statusHistory: [h("sent", D(2))], deal: { stage: "under_contract", createdAt: D(5) } }]);
  assert.equal(f.accepted, 1);
  assert.equal(f.open, 0);
});

test("an offer still waiting on the agent is open", () => {
  const f = offerFunnel([{ id: "o1", createdAt: D(1), statusHistory: [h("sent", D(2))] }]);
  assert.equal(f.open, 1);
});

test("rates are per stage, not per offer", () => {
  const f = offerFunnel([
    { id: "a", createdAt: D(1), statusHistory: [h("sent", D(1)), h("countered", D(2)), h("accepted", D(3))] },
    { id: "b", createdAt: D(1), statusHistory: [h("sent", D(1)), h("countered", D(2))] },
    { id: "c", createdAt: D(1), statusHistory: [h("sent", D(1))] },
    { id: "d", createdAt: D(1), statusHistory: [h("new", D(1))] },
  ]);
  assert.equal(f.sent, 3);
  assert.equal(f.rates.counteredOfSent, 66.7);
  assert.equal(f.rates.acceptedOfCountered, 50);
});

test("an empty book returns zeroes rather than NaN rates", () => {
  const f = offerFunnel([]);
  assert.equal(f.created, 0);
  for (const v of Object.values(f.rates)) assert.equal(v, 0);
});

test("the daily series is ordered and buckets each event on its own day", () => {
  const f = offerFunnel([{ id: "o1", createdAt: D(1), statusHistory: [h("sent", D(3)), h("countered", D(2))] }]);
  assert.deepEqual(f.daily.map((d) => d.date), ["2026-09-01", "2026-09-02", "2026-09-03"]);
});

/* ---------- the spread ---------- */

test("the counter spread reads our number and theirs from the offer, not from a note", () => {
  const s = counterSpread([{ id: "o1", address: "12 Elm St", cashAmount: 250000,
    counter: { amount: 275000 }, statusHistory: [h("countered", D(3), { amount: 275000 })] }]);
  assert.equal(s.n, 1);
  assert.equal(s.items[0].liftDollars, 25000);
  assert.equal(s.items[0].liftPct, 10);
});

test("a counter recorded only on the ledger is still read", () => {
  const s = counterSpread([{ id: "o1", cashAmount: 250000, statusHistory: [h("countered", D(3), { amount: 275000 })] }]);
  assert.equal(s.n, 1);
});

test("the counter spread is empty when no counter carried a number", () => {
  assert.equal(counterSpread([{ id: "o1", cashAmount: 250000, statusHistory: [h("countered", D(3))] }]).n, 0);
});

test("the spread reports what happened after the counter", () => {
  const s = counterSpread([
    { id: "a", cashAmount: 250000, counter: { amount: 260000 }, statusHistory: [h("countered", D(2)), h("accepted", D(4))] },
    { id: "b", cashAmount: 250000, counter: { amount: 300000 }, statusHistory: [h("countered", D(2)), h("passed", D(4))] },
    { id: "c", cashAmount: 250000, counter: { amount: 270000 }, statusHistory: [h("countered", D(2))] },
  ]);
  assert.deepEqual(s.items.map((i) => i.outcome).sort(), ["accepted", "open", "passed"]);
  assert.equal(s.medianLiftPct, 8);
});

test("price bands group the book in fifty thousand dollar steps", () => {
  assert.equal(priceBand(265000), "250–300k");
  assert.equal(priceBand(0), "unknown");
});

/* ---------- pass reasons ---------- */

const dealWith = (id, address, cashAmount, feedback) => ({ id, address, cashAmount, deal: { feedback, investors: [] } });

test("pass reasons grouped by area put two Tacoma deals under one key", () => {
  const rows = [
    dealWith("a", "12 Elm St, Tacoma, WA 98404", 250000, [{ contactId: "b1", code: "price" }]),
    dealWith("b", "9 Oak Ave, Tacoma, WA 98404", 300000, [{ contactId: "b2", code: "price" }, { contactId: "b3", code: "area" }]),
    dealWith("c", "3 Fir Ln, Renton, WA 98056", 400000, [{ contactId: "b4", code: "rehab_scope" }]),
  ];
  const g = passReasons(rows, { by: "area" });
  const tacoma = g.find((x) => x.key.toLowerCase() === "tacoma");
  assert.equal(tacoma.total, 3);
  assert.equal(tacoma.byCode[0].code, "price");
  assert.equal(tacoma.byCode[0].count, 2);
});

test("pass reasons count one buyer once per deal however many places it was written", () => {
  const rows = [{ id: "a", address: "12 Elm St", cashAmount: 250000, deal: {
    feedback: [{ contactId: "b1", code: "price" }],
    investors: [{ contactId: "b1", reason: { code: "price", note: "no meat" } }],
  } }];
  assert.equal(passReasons(rows, { by: "deal" })[0].total, 1);
});

test("a reason recorded only on the investor row is still counted", () => {
  const rows = [{ id: "a", address: "12 Elm St", cashAmount: 250000, deal: {
    feedback: [], investors: [{ contactId: "b1", reason: { code: "timing" } }],
  } }];
  assert.equal(passReasons(rows)[0].byCode[0].code, "timing");
});

test("an offer that never became a deal has no pass reasons to report", () => {
  assert.deepEqual(passReasons([{ id: "a", address: "x", cashAmount: 1 }]), []);
});

/* ---------- did the nudges work ---------- */

const fu = (contactId, kind, step, at) => ({ contactId, at, data: { kind, step } });

test("a follow-up that got a reply four days later counts as replied inside a five-day window", () => {
  const r = followUpPerformance(
    [fu("c1", "offer_nudge", 3, D(1))],
    [{ contactId: "c1", at: D(5) }],
  );
  assert.equal(r[0].replied, 1);
  assert.equal(r[0].replyRate, 100);
  assert.equal(r[0].medianHoursToReply, 96);
});

test("a reply outside the window is not credited to the nudge", () => {
  const r = followUpPerformance([fu("c1", "offer_nudge", 3, D(1))], [{ contactId: "c1", at: D(20) }]);
  assert.equal(r[0].replied, 0);
});

test("something they said before the nudge is not a reply to it", () => {
  const r = followUpPerformance([fu("c1", "offer_nudge", 3, D(10))], [{ contactId: "c1", at: D(2) }]);
  assert.equal(r[0].replied, 0);
});

test("each rung is reported on its own so a ladder can be shortened", () => {
  const r = followUpPerformance(
    [fu("c1", "offer_nudge", 3, D(1)), fu("c2", "offer_nudge", 3, D(1)), fu("c3", "offer_nudge", 14, D(1))],
    [{ contactId: "c1", at: D(2) }],
  );
  assert.deepEqual(r.map((x) => [x.step, x.sent, x.replied]), [[3, 2, 1], [14, 1, 0]]);
});

test("a follow-up with no reply counts as sent and not replied", () => {
  const r = followUpPerformance([fu("c1", "blast_nudge", 2, D(1))], []);
  assert.deepEqual([r[0].sent, r[0].replied, r[0].replyRate], [1, 0, 0]);
});
