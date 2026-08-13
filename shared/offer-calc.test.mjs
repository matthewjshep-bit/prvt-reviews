// offer-calc.test.mjs — pins the arithmetic of the three underwriting models.
// This is money math that prints on a letter someone signs, so each mode gets a
// hand-computed worked example rather than a snapshot: if a test fails, the
// expected number in it is the one to check against a calculator, not to update.
//
//   node --test offer-calc.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { calculateOffers, DEFAULT_OFFER_SETTINGS, netComparison, repairsAdjustment } from "./offer-calc.js";

const S = DEFAULT_OFFER_SETTINGS;

/* ---------------- backstack (the default) ---------------- */

test("backstack: the full worked stack", () => {
  // 420,000 − 29,400 (7%) − 54,600 (13%) − 62,000 − 6,000 (5 × 1,200) − 30,000
  const { offers } = calculateOffers(
    { address: "1234 Main St", arv: 420000, repairs: 62000 },
    { underwriteMode: "backstack" }
  );
  const c = offers.cash;
  assert.equal(c.mode, "backstack");
  assert.equal(c.sellingCosts, 29400);
  assert.equal(c.flipProfit, 54600);
  assert.equal(c.holding, 6000);
  assert.equal(c.wholesaleFee, 30000);
  assert.equal(c.amount, 238000);
  assert.equal(c.underwater, false);
});

test("backstack: repairs enter at face value, not through repairsAdjustment", () => {
  // $10k of repairs is below repairBuffer, so the lowball adjustment would
  // inflate it to $40k. The back-stack must subtract exactly $10k.
  const arv = 300000;
  const repairs = 10000;
  assert.equal(repairsAdjustment(repairs, arv, S), 40000); // the model we must NOT use here
  const { offers } = calculateOffers({ arv, repairs }, { underwriteMode: "backstack" });
  assert.equal(offers.cash.repairAdjustment, repairs);
  // 300,000 − 21,000 − 39,000 − 10,000 − 6,000 − 30,000
  assert.equal(offers.cash.amount, 194000);
});

test("backstack: settings drive every leg of the stack", () => {
  const { offers } = calculateOffers(
    { arv: 500000, repairs: 40000 },
    {
      underwriteMode: "backstack",
      sellingCostPct: 6,
      flipProfitPct: 15,
      holdMonths: 4,
      holdMonthlyCost: 1500,
      wholesaleFee: 20000,
    }
  );
  // 500,000 − 30,000 − 75,000 − 40,000 − 6,000 − 20,000
  assert.equal(offers.cash.amount, 329000);
  assert.equal(offers.cash.pctOfArv, 79); // 100 − 6 − 15
});

test("backstack: is deterministic and jitter-free", () => {
  const run = () => calculateOffers({ address: "5 Oak", arv: 333333, repairs: 41111 }, { underwriteMode: "backstack" }).offers.cash.amount;
  assert.equal(run(), run());
  assert.equal(run() % 1, 0, "no fake-precision cents");
});

test("backstack: an underwater stack clamps to 0 and says so", () => {
  const { offers } = calculateOffers({ arv: 200000, repairs: 180000 }, { underwriteMode: "backstack" });
  assert.equal(offers.cash.amount, 0);
  assert.equal(offers.cash.underwater, true);
});

test("backstack: breakdown rows sum back to the offer", () => {
  const { offers } = calculateOffers({ arv: 465000, repairs: 73500 }, { underwriteMode: "backstack" });
  const c = offers.cash;
  const total = c.breakdown.reduce((t, r) => t + (r.sign === "−" ? -r.amount : r.amount), 0);
  assert.equal(total, c.amount);
});

/* ---------------- mao (classic 70% rule) ---------------- */

test("mao: 70% of ARV − repairs − fee", () => {
  const { offers } = calculateOffers({ arv: 400000, repairs: 50000 }, { underwriteMode: "mao" });
  // 280,000 − 50,000 − 30,000
  assert.equal(offers.cash.amount, 200000);
  assert.equal(offers.cash.base, 280000);
  assert.equal(offers.cash.repairAdjustment, 50000);
});

/* ---------------- lowball (the anchoring model) ---------------- */

test("lowball: ~90% of ARV − adjusted repairs − fee, deterministic per property", () => {
  const inputs = { address: "9 Pine Ave", arv: 400000, repairs: 50000 };
  const a = calculateOffers(inputs, { underwriteMode: "lowball" }).offers.cash;
  const b = calculateOffers(inputs, { underwriteMode: "lowball" }).offers.cash;
  assert.equal(a.amount, b.amount, "same property must always yield the same offer");
  // Jitter is bounded: base sits within ±0.52pp of 90% of ARV.
  assert.ok(Math.abs(a.pctUsed - 90) <= 0.52);
  // repairs (50k) exceed repairBuffer but are above 10% of ARV (40k):
  // 2 × 40,000 + 1.5 × 10,000 = 95,000
  assert.equal(a.repairAdjustment, 95000);
});

test("lowball: precisionJitter off gives a clean 90% base", () => {
  const { offers } = calculateOffers(
    { address: "9 Pine Ave", arv: 400000, repairs: 50000 },
    { underwriteMode: "lowball", precisionJitter: false }
  );
  // 360,000 − 95,000 − 30,000
  assert.equal(offers.cash.amount, 235000);
  assert.equal(offers.cash.pctUsed, 90);
});

/* ---------------- shared behaviour across modes ---------------- */

test("the default mode is the back-stack", () => {
  assert.equal(S.underwriteMode, "backstack");
  assert.equal(calculateOffers({ arv: 300000, repairs: 20000 }).offers.cash.mode, "backstack");
});

test("asking price stands in when ARV is blank", () => {
  const { inputs } = calculateOffers({ askingPrice: 250000 });
  assert.equal(inputs.arv, 250000);
});

test("a non-positive ARV is rejected", () => {
  assert.throws(() => calculateOffers({ arv: 0, askingPrice: 0 }), /positive number/);
});

for (const mode of ["backstack", "lowball", "mao"]) {
  test(`${mode}: priceOverride replaces the amount but keeps the model`, () => {
    const { offers } = calculateOffers(
      { arv: 400000, repairs: 50000, priceOverride: 175000, askingPrice: 350000 },
      { underwriteMode: mode }
    );
    const c = offers.cash;
    assert.equal(c.amount, 175000);
    assert.equal(c.overridden, true);
    assert.ok(c.systemAmount > 0, "the modeled number is preserved for display");
    assert.equal(c.pctOfAsking, 50); // 175,000 / 350,000
  });

  test(`${mode}: negative inputs never produce a negative offer`, () => {
    const { offers } = calculateOffers({ arv: 100000, repairs: 500000 }, { underwriteMode: mode });
    assert.equal(offers.cash.amount, 0);
  });
}

/* ---------------- seller net comparison ---------------- */

test("netComparison: the list price a traditional sale needs to match our net", () => {
  const r = netComparison(300000, { sellerAgentPct: 3, buyerAgentPct: 3 });
  assert.equal(r.netA, 291000);              // 300,000 − 3%
  assert.equal(Math.round(r.listPrice), 309574); // 291,000 / 0.94
});

test("netComparison: refuses impossible inputs", () => {
  assert.equal(netComparison(0), null);
  assert.equal(netComparison(300000, { sellerAgentPct: 60, buyerAgentPct: 50 }), null);
});
