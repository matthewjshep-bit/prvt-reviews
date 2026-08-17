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
import { breakdownTotals, offerBreakdown } from "./offer-breakdown.js";

const FEE = 15000;
const asOffer = (inputs, settings) => {
  const calc = calculateOffers(inputs, { wholesaleFee: FEE, ...settings });
  return { calc, cashAmount: calc.offers.cash.amount };
};

const MODES = ["backstack", "mao", "lowball"];
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
  const small = offerBreakdown(asOffer(inputs, { underwriteMode: "backstack", wholesaleFee: 5000 }));
  const large = offerBreakdown(asOffer(inputs, { underwriteMode: "backstack", wholesaleFee: 45000 }));

  const row = (b, k) => b.rows.find((r) => r.key === k);
  assert.equal(row(small, "arv").amount, row(large, "arv").amount, "ARV is unchanged");
  assert.equal(row(small, "selling").amount, row(large, "selling").amount, "resale costs unchanged");
  assert.equal(row(small, "repairs").amount, row(large, "repairs").amount, "repairs unchanged");
  assert.equal(row(small, "holding").amount, row(large, "holding").amount, "carrying costs unchanged");
  // The whole fee difference lands in the one line that doesn't name it.
  assert.equal(row(large, "return").amount - row(small, "return").amount, 40000);
  assert.ok(breakdownTotals(small).balanced && breakdownTotals(large).balanced);
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

test("percentage models compress to one margin line rather than inventing costs", () => {
  for (const mode of ["mao", "lowball"]) {
    const b = offerBreakdown(asOffer({ address: "8 Main St", arv: 420000, repairs: 28500 }, { underwriteMode: mode }));
    assert.deepEqual(b.rows.map((r) => r.key), ["arv", "repairs", "return"]);
    assert.ok(!b.rows.some((r) => r.key === "selling" || r.key === "holding"),
      "no fabricated resale/carrying lines for a model that doesn't compute them");
  }
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
