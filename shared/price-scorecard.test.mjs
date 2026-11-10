// price-scorecard.test.mjs — the offer engine's scorecard: how close to Matt, how close to the market.

import test from "node:test";
import assert from "node:assert/strict";
import { outcomeOf, measure, scorecard, graduated, scorecardLine, BARS } from "./price-scorecard.js";

const NOW = Date.parse("2026-11-20T03:00:00Z");
const day = (n) => new Date(NOW - n * 86400000).toISOString();

test("the outcome is the number a person stood behind, the seller's lowest counter, a yes, and the sale", () => {
  const offers = [
    { id: "m1", address: "4417 Somerset Ln, Everett, WA 98203", cashAmount: 310000, autoUnderwrite: { basis: "bricked", leadSource: "agent_brought" }, status: "sent", sends: [{ ts: day(9) }], createdAt: day(10), updatedAt: day(9) },
    { id: "h1", address: "4417 Somerset Lane, Everett WA", cashAmount: 335000, approved: { by: "publish", at: day(5) }, autoUnderwrite: { skeleton: true },
      calc: { inputs: { arv: 600000, repairs: 90000 } }, status: "countered", createdAt: day(6), updatedAt: day(4),
      statusHistory: [{ status: "countered", amount: 365000, ts: day(4) }, { status: "countered", amount: 352000, ts: day(3) }],
      priceWatch: { sold: { price: 371000, at: "2026-11-15" } } },
    { id: "x", address: "99 Other St, Everett, WA", cashAmount: 1 },
  ];
  const o = outcomeOf({ address: "4417 Somerset Ln, Everett, WA 98203", offers });
  assert.deepEqual(o.offerIds, ["m1", "h1"]);
  assert.equal(o.mattNumber, 335000);
  assert.equal(o.mattArv, 600000);
  assert.equal(o.mattRehab, 90000);
  assert.equal(o.machineSent, 310000, "the machine's sent number, with nobody behind it");
  assert.equal(o.sellerLowest, 352000);
  assert.equal(o.agreed, false);
  assert.deepEqual(o.sold, { price: 371000, at: "2026-11-15" });
  assert.equal(o.leadSource, "agent_brought");
  assert.equal(outcomeOf({ address: "1 Nowhere Rd", offers }), null);
});

test("Matt's 75% and our 70% are compared at one formula", () => {
  // Matt priced 335k off ARV 600k / rehab 90k (≈ 75% − rehab − fee). At OUR formula his inputs give
  // 0.7 × 600k − 90k − 15k = 315k; an engine walk-away of 315k is right on him, not 6% low.
  const m = measure({ v2: { arv: 600000, rehab: 90000, walkAway: 315000, grade: "A", at: day(5) }, outcome: { mattArv: 600000, mattRehab: 90000 } });
  assert.equal(m.walkVsMatt, 1);
  assert.equal(m.arvGap, 0);
  assert.equal(m.rehabBelow, false);
  assert.equal(m.overMatt, false);
});

test("priced over what it sold for counts high", () => {
  const m = measure({ v2: { arv: 600000, rehab: 90000, walkAway: 400000, grade: "A", at: day(5) }, outcome: { sold: { price: 371000 } } });
  assert.equal(m.overSold, true);
  const card = scorecard([{ v2: { arv: 600000, rehab: 90000, walkAway: 400000, grade: "A", at: day(5) }, outcome: { sold: { price: 371000 } } }], { now: NOW });
  assert.equal(card.byGrade.A.overSold, 1);
  assert.ok(card.ready.A.missing.some((x) => /1 over what the house sold for/.test(x)));
});

test("under 20 houses a grade isn't ready", () => {
  const rec = (i, over = {}) => ({ v2: { arv: 600000, rehab: 95000, walkAway: 310000, grade: "A", triage: "workable", at: day(i % 25) }, outcome: { mattArv: 610000, mattRehab: 90000 }, ...over });
  const few = scorecard(Array.from({ length: 12 }, (_, i) => rec(i)), { now: NOW });
  assert.equal(few.ready.A.ready, false);
  assert.match(few.ready.A.missing[0], /12 of 20 houses/);
  const enough = scorecard(Array.from({ length: 22 }, (_, i) => rec(i)), { now: NOW });
  assert.equal(enough.byGrade.A.withMatt, 22);
  assert.equal(enough.ready.A.ready, true, JSON.stringify(enough.ready.A.missing));
  assert.match(scorecardLine(enough), /grade A is ready for your switch/);
});

test("rehab under Matt's on more than 30% of houses holds a grade back", () => {
  const low = (i) => ({ v2: { arv: 600000, rehab: 60000, walkAway: 300000, grade: "A", at: day(1) }, outcome: { mattArv: 600000, mattRehab: 90000 } });
  const card = scorecard(Array.from({ length: 25 }, (_, i) => low(i)), { now: NOW });
  assert.equal(card.byGrade.A.rehabBelowShare, 1);
  assert.ok(card.ready.A.missing.some((x) => /rehab under yours on 100%/.test(x)));
  assert.deepEqual(BARS, { minHouses: 20, arvGap: 0.05, rehabBelowShare: 0.3, overMatt: 0.1 });
});

test("the card splits by lead source and keeps the last 30 days apart from the 30 before", () => {
  const r = (lead, ago, gap) => ({ v2: { arv: 600000 * (1 + gap), rehab: 90000, walkAway: 300000, grade: "B", at: day(ago) }, leadSource: lead, outcome: { mattArv: 600000, mattRehab: 90000 } });
  const card = scorecard([r("agent_brought", 5, 0.02), r("hook", 10, 0.04), r("agent_brought", 40, 0.12)], { now: NOW });
  assert.deepEqual(Object.keys(card.byLead).sort(), ["agent_brought", "hook"]);
  assert.equal(card.trend.last30.n, 2);
  assert.equal(card.trend.prior30.n, 1);
  assert.ok(card.trend.last30.arvGap < card.trend.prior30.arvGap, "getting closer");
  assert.equal(graduated(card.byGrade.C).ready, false);
});

/* ---------- against their number, and an honest median (2026-11-09) ---------- */

// Twenty-two houses that clear every bar against Matt's own numbers.
const ready = (i, over = {}) => ({ v2: { arv: 600000, rehab: 95000, walkAway: 310000, grade: "A", at: day(1 + (i % 20)) }, outcome: { mattArv: 610000, mattRehab: 90000 }, ...over });

test("a walk-away above the seller's stated number counts against the grade", () => {
  const over = ready(0, { reads: { sellerNumber: 300000 } });
  const m = measure(over);
  assert.equal(m.overTheir, true);
  assert.equal(Math.round(m.walkVsTheir * 1000) / 1000, 1.033);
  // Their number said later (property_details), not known when the engine priced it.
  assert.equal(measure(ready(1, { outcome: { mattArv: 610000, mattRehab: 90000, theirNumber: 330000 } })).overTheir, false);
  const card = scorecard([over, ...Array.from({ length: 21 }, (_, i) => ready(i + 1))], { now: NOW });
  assert.equal(card.byGrade.A.overTheir, 1);
  assert.equal(card.byGrade.A.withTheir, 1);
  assert.equal(card.ready.A.ready, false);
  assert.ok(card.ready.A.missing.some((x) => /1 walk-away above their stated number/.test(x)), card.ready.A.missing.join("; "));
});

test("ARV gaps of 2, 4, 10 and 12 percent read 7 percent and not ready", () => {
  const gaps = [0.02, 0.04, 0.10, 0.12];
  const recs = Array.from({ length: 20 }, (_, i) => ready(i, { v2: { arv: 600000 * (1 + gaps[i % 4]), rehab: 95000, walkAway: 310000, grade: "A", at: day(1 + i) }, outcome: { mattArv: 600000, mattRehab: 90000 } }));
  const card = scorecard(recs, { now: NOW });
  assert.equal(card.byGrade.A.arvGap, 0.07);
  assert.equal(card.ready.A.ready, false);
  assert.ok(card.ready.A.missing.some((x) => /ARV off yours by 7%/.test(x)), card.ready.A.missing.join("; "));
});

test("the engine's ARV and rehab are measured against the agent's own read", () => {
  const m = measure({ v2: { arv: 660000, rehab: 60000, walkAway: 300000, grade: "B", at: day(2) }, reads: { theirRepairs: 80000 }, outcome: { theirArv: 600000 } });
  assert.equal(m.arvVsTheir, 1.1);
  assert.equal(m.rehabVsTheir, 0.75);
  const card = scorecard([{ v2: { arv: 660000, rehab: 60000, walkAway: 300000, grade: "B", at: day(2) }, reads: { theirRepairs: 80000 }, outcome: { theirArv: 600000 } }], { now: NOW });
  assert.equal(card.byGrade.B.arvVsTheir, 1.1);
  assert.equal(card.byGrade.B.rehabVsTheir, 0.75);
});

test("their read on a house is the newest number they said about that house", async () => {
  const { theirReadOf } = await import("./price-scorecard.js");
  const events = [
    { type: "property_details", address: "12 Alder Way, Kent, WA", at: day(9), data: { sellerAsk: 410000 } },
    { type: "property_details", address: "12 Alder Way, Kent WA", at: day(3), data: { sellerAsk: 395000 } },
    { type: "agent_estimate", address: "12 Alder Way, Kent, WA", at: day(4), data: { arv: 520000, rehab: 70000 } },
    { type: "property_details", address: "99 Other Rd, Kent, WA", at: day(1), data: { sellerAsk: 1 } },
  ];
  assert.deepEqual(theirReadOf({ address: "12 Alder Way, Kent, WA 98030", events }), { theirNumber: 395000, theirArv: 520000, theirRehab: 70000 });
});

test("the deals and the buyers' answer key are a second bar", async () => {
  const { goldenBar } = await import("./price-scorecard.js");
  // An invented golden set: one win, one that died, one still open.
  const golden = { deals: [
    { id: "w1", outcome: "won", contract: 290000, matt: { arv: 520000, rehab: 50000 }, buyers: {} },
    { id: "d1", outcome: "dead", contract: 400000, matt: { arv: 600000, rehab: 40000 }, buyers: { arv: 540000, rehab: 120000 } },
    { id: "o1", outcome: "open", contract: 350000, matt: { arv: 500000, rehab: 40000 }, buyers: {} },
  ] };
  const price = ({ arv, rehab }) => ({ walkAway: 0.7 * arv - rehab - 15000 });
  const bar = goldenBar(golden, { price });
  assert.deepEqual(bar.won, { n: 1, reached: 1 });
  assert.deepEqual(bar.dead, { n: 1, stayedOut: 1 }, "on the buyers' numbers the walk-away sits 10% or more under a deal that died");
  assert.equal(bar.rows.length, 2, "an open deal isn't scored");
});
