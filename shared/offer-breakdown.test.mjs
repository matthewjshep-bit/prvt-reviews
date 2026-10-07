// offer-breakdown.test.mjs — the "how we got here" column shown to the agent.
//
// Two promises, and breaking either is worse than having no section at all:
//
//   1. The column adds up to the offer on the letter. A stack that doesn't
//      reconcile destroys the credibility the section was built to buy — and
//      worse, the gap IS the assignment fee, so a wrong column hands over the
//      exact number it was hiding.
//   2. The assignment fee never appears, as a row or as a value. Not in
//      backstack mode, not in the percentage models, not after an override.
//
// These run against the real calculateOffers output rather than hand-built
// fixtures, so a change to the underwriting engine can't quietly break them.
//
//   node --test offer-breakdown.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { calculateOffers } from "./offer-calc.js";
import { breakdownTotals, offerBreakdown, offerMath, compactMath, mathSentence, mathAllowedAmounts } from "./offer-breakdown.js";
import { pricesWeName, shorthandPrices } from "./current-offer.js";
import { leanOfferDoc, toListOffer } from "./offer-status.js";

const FEE = 15000;
const asOffer = (inputs, settings) => {
  const calc = calculateOffers(inputs, { wholesaleFee: FEE, ...settings });
  return { calc, cashAmount: calc.offers.cash.amount };
};

const MODES = ["backstack", "mao", "lowball", "blended"];
const CASES = [
  { label: "typical", inputs: { address: "1 Main St", arv: 420000, repairs: 28500 } },
  { label: "no repairs", inputs: { address: "2 Main St", arv: 500000, repairs: 0 } },
  { label: "heavy repairs", inputs: { address: "3 Main St", arv: 600000, repairs: 180000 } },
  { label: "with asking price", inputs: { address: "4 Main St", arv: 350000, repairs: 40000, askingPrice: 399000 } },
];

test("the column always totals the printed offer", () => {
  for (const mode of MODES) {
    for (const c of CASES) {
      const offer = asOffer(c.inputs, { underwriteMode: mode });
      const b = offerBreakdown(offer);
      assert.ok(b, `${mode}/${c.label}: expected a breakdown`);
      const t = breakdownTotals(b);
      assert.ok(t.balanced, `${mode}/${c.label}: rows sum to ${t.sum}, offer is ${t.total}`);
      assert.equal(t.total, Math.round(offer.calc.offers.cash.amount));
    }
  }
});

test("the assignment fee never appears — as a row, a label, or a value", () => {
  for (const mode of MODES) {
    for (const c of CASES) {
      const offer = asOffer(c.inputs, { underwriteMode: mode });
      const b = offerBreakdown(offer);
      for (const r of b.rows) {
        assert.notEqual(r.amount, FEE, `${mode}/${c.label}: a row equals the fee exactly`);
        assert.doesNotMatch(r.label, /fee|assignment|wholesale/i, `${mode}/${c.label}: ${r.label}`);
      }
      assert.ok(!b.rows.some((r) => r.key === "fee"));
      assert.doesNotMatch(JSON.stringify(b), /assignment|wholesale/i);
    }
  }
});

test("a bigger fee moves only the residual line, never a stated cost", () => {
  const inputs = { address: "5 Main St", arv: 420000, repairs: 28500 };
  for (const mode of ["backstack", "mao"]) {
    const small = offerBreakdown(asOffer(inputs, { underwriteMode: mode, wholesaleFee: 5000 }));
    const large = offerBreakdown(asOffer(inputs, { underwriteMode: mode, wholesaleFee: 45000 }));

    const row = (b, k) => b.rows.find((r) => r.key === k);
    assert.equal(row(small, "arv").amount, row(large, "arv").amount, `${mode}: ARV is unchanged`);
    assert.equal(row(small, "closing").amount, row(large, "closing").amount, `${mode}: closing costs unchanged`);
    assert.equal(row(small, "repairs").amount, row(large, "repairs").amount, `${mode}: repairs unchanged`);
    assert.equal(row(small, "holding").amount, row(large, "holding").amount, `${mode}: carrying costs unchanged`);
    // The whole fee difference lands in the one line that doesn't name it.
    assert.equal(row(large, "return").amount - row(small, "return").amount, 40000, mode);
    assert.ok(breakdownTotals(small).balanced && breakdownTotals(large).balanced);
  }
});

test("a manual price override still reconciles", () => {
  for (const mode of MODES) {
    // Below the modeled number.
    const low = asOffer({ address: "6 Main St", arv: 420000, repairs: 28500, priceOverride: 250000 }, { underwriteMode: mode });
    const bLow = offerBreakdown(low);
    assert.equal(bLow.total, 250000);
    assert.ok(breakdownTotals(bLow).balanced, `${mode}: override low doesn't reconcile`);

    // Above it — the stated costs no longer leave room, so it reads as a
    // premium rather than a negative subtraction.
    const high = asOffer({ address: "7 Main St", arv: 420000, repairs: 28500, priceOverride: 415000 }, { underwriteMode: mode });
    const bHigh = offerBreakdown(high);
    assert.equal(bHigh.total, 415000);
    assert.ok(breakdownTotals(bHigh).balanced, `${mode}: override high doesn't reconcile`);
    assert.ok(bHigh.rows.every((r) => r.amount >= 0), "no negative amounts");
    assert.ok(bHigh.rows.some((r) => r.key === "premium"));
  }
});

// Matt, 2026-10-07: we price at 70–75% of ARV less the work, and the agent
// should see what that's based on. Every model gets the same real costs —
// the back-stack cost model on the offer's own settings — and only the
// residual differs between them.
test("every model itemises the same real costs; only profit and risk differs", () => {
  const inputs = { address: "8 Main St", arv: 420000, repairs: 28500 };
  const rows = MODES.map((mode) => offerBreakdown(asOffer(inputs, { underwriteMode: mode })).rows);
  for (const r of rows) assert.deepEqual(r.map((x) => x.key), ["arv", "closing", "holding", "repairs", "return"]);
  for (const k of ["arv", "closing", "holding", "repairs"]) {
    assert.equal(new Set(rows.map((r) => r.find((x) => x.key === k).amount)).size, 1, `${k} is the same in every model`);
  }
});

test("the closing and holding lines break down into parts that add up", () => {
  const m = offerMath(asOffer({ address: "8 Main St", arv: 500000, repairs: 50000 }, { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000 }));
  assert.equal(m.total, 295000);
  assert.equal(m.pctOfArv, 69, "what Matt prices off: (offer + work) / ARV");
  for (const key of ["closing", "holding"]) {
    const row = m.rows.find((r) => r.key === key);
    assert.equal(row.detail.reduce((t, d) => t + d.amount, 0), row.amount, key);
  }
  assert.equal(m.closing.sell, 35000, "7% to resell");
  assert.ok(m.closing.buy > 0, "and a purchase closing");
  assert.ok(m.rows.every((r) => !/fee|assignment|wholesale/i.test(JSON.stringify(r))));
});

test("a cheap house is flagged so the page can explain a big profit-and-risk line", () => {
  const cheap = offerMath(asOffer({ address: "9 Oak St", arv: 200000, repairs: 40000 }, { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000 }));
  assert.equal(cheap.total, 80000);
  assert.equal(cheap.big, true);
  assert.ok(offerBreakdown(asOffer({ address: "9 Oak St", arv: 200000, repairs: 40000 }, { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000 })).caption);
  const typical = offerMath(asOffer({ address: "8 Main St", arv: 500000, repairs: 50000 }, { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000 }));
  assert.equal(typical.big, false);
});

test("the letter's exact math keeps the lowball model's cents and still ties", () => {
  const offer = asOffer({ address: "9 Main St", arv: 428500, repairs: 22000 }, { underwriteMode: "lowball", precisionJitter: true });
  const m = offerMath(offer, { exact: true });
  assert.equal(m.total, offer.calc.offers.cash.amount);
  assert.ok(breakdownTotals({ rows: m.rows, total: m.total }).balanced);
});

/* ---------- in a text ---------- */

const MAO = { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000 };

test("the text sentence names the costs in thousands, never a dollar sign or a profit figure", () => {
  const m = offerMath(asOffer({ address: "8 Main St", arv: 500000, repairs: 50000 }, MAO));
  const t = mathSentence(m);
  assert.equal(t, "We base it on about 69% of the 500 it's worth fixed up, less the 50 of work; the rest covers about 38 to buy and resell, 26 to hold it 5 months and our profit and risk.");
  assert.doesNotMatch(t, /\$/);
  assert.doesNotMatch(t, /\b91\b/, "profit and risk has no figure");
  assert.equal(mathSentence(compactMath(m)), t, "the lean row's math says the same");
  // Nothing in it reads as a price on the house.
  assert.deepEqual(pricesWeName(t, 295000), []);
  assert.deepEqual(shorthandPrices(t, 295000), []);
});

test("a price set above the model gets no sentence, and no math means none", () => {
  const over = offerMath(asOffer({ address: "7 Main St", arv: 420000, repairs: 28500, priceOverride: 415000 }, MAO));
  assert.ok(over.premium > 0);
  assert.equal(mathSentence(over), "");
  assert.equal(mathSentence(null), "");
});

test("the gate may hear the ARV, work, closing and holding, never profit and risk", () => {
  const m = offerMath(asOffer({ address: "8 Main St", arv: 500000, repairs: 50000 }, MAO));
  const ok = mathAllowedAmounts(m);
  for (const n of [500000, 50000, 38245, 38000, 25538, 26000, 35000]) assert.ok(ok.includes(n), String(n));
  assert.ok(!ok.includes(91217) && !ok.includes(91000), "profit and risk is never allowed");
});

test("a lean offer row carries the math, and re-trimming keeps it", () => {
  const offer = { id: "o1", address: "8 Main St", status: "sent", createdAt: "2026-10-01T00:00:00Z", ...asOffer({ address: "8 Main St", arv: 500000, repairs: 50000 }, MAO) };
  const row = toListOffer(leanOfferDoc(offer));
  assert.equal(row.math.total, 295000);
  assert.equal(row.math.residual, 91217);
  assert.deepEqual(toListOffer(row).math, row.math);
  assert.equal(JSON.stringify(row.math).length < 260, true, "a row stays a row");
});

test("the lowball model's cents jitter doesn't break the column", () => {
  // precisionJitter puts fractional cents on the amount; the residual is
  // derived from the printed number, so it has to absorb them.
  for (const arv of [317000, 428500, 613250]) {
    const offer = asOffer({ address: "9 Main St", arv, repairs: 22000 }, { underwriteMode: "lowball", precisionJitter: true });
    const t = breakdownTotals(offerBreakdown(offer));
    assert.ok(t.balanced, `arv ${arv}: ${t.sum} != ${t.total}`);
  }
});

test("nothing to defend means nothing is shown", () => {
  // Repairs and profit exceed the ARV — the offer clamps to 0.
  const underwater = asOffer({ address: "10 Main St", arv: 200000, repairs: 400000 }, { underwriteMode: "backstack" });
  assert.equal(underwater.calc.offers.cash.underwater, true);
  assert.equal(offerBreakdown(underwater), null);

  assert.equal(offerBreakdown(null), null);
  assert.equal(offerBreakdown({}), null);
  assert.equal(offerBreakdown({ calc: { offers: {} } }), null);
});

test("a zero-repair offer omits the renovation line instead of printing $0", () => {
  const b = offerBreakdown(asOffer({ address: "11 Main St", arv: 500000, repairs: 0 }, { underwriteMode: "backstack" }));
  assert.ok(!b.rows.some((r) => r.key === "repairs"));
  assert.ok(breakdownTotals(b).balanced);
});
