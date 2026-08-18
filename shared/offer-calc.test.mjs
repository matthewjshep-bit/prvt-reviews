// offer-calc.test.mjs — pins the arithmetic of the four underwriting models.
// This is money math that prints on a letter someone signs, so each mode gets a
// hand-computed worked example rather than a snapshot: if a test fails, the
// expected number in it is the one to check against a calculator, not to update.
//
//   node --test offer-calc.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { calculateOffers, DEFAULT_OFFER_SETTINGS, estimateHolding, netComparison, repairsAdjustment } from "./offer-calc.js";

const S = DEFAULT_OFFER_SETTINGS;

/* ---------------- backstack (the default) ---------------- */

test("backstack: the full worked stack", () => {
  // 420,000 − 29,400 (7%) − 54,600 (13%) − 62,000 − 21,641 (carry) − 30,000
  // The carry is solved for below; see "holding: the scaled model, leg by leg".
  const { offers } = calculateOffers(
    { address: "1234 Main St", arv: 420000, repairs: 62000 },
    { underwriteMode: "backstack" }
  );
  const c = offers.cash;
  assert.equal(c.mode, "backstack");
  assert.equal(c.sellingCosts, 29400);
  assert.equal(c.flipProfit, 54600);
  assert.equal(c.holding, 21641);
  assert.equal(c.wholesaleFee, 30000);
  assert.equal(c.amount, 222359);
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
  // 300,000 − 21,000 − 39,000 − 10,000 − 15,796 (carry) − 30,000
  assert.equal(offers.cash.amount, 184204);
});

test("backstack: settings drive every leg of the stack", () => {
  const { offers } = calculateOffers(
    { arv: 500000, repairs: 40000 },
    {
      underwriteMode: "backstack",
      sellingCostPct: 6,
      flipProfitPct: 15,
      holdMonths: 4,
      wholesaleFee: 20000,
    }
  );
  // Fixed point, solved by hand. Let h be the carry:
  //   purchase = 500,000 − 30,000 − 75,000 − 40,000 − h  = 355,000 − h
  //   loan     = 85% × (purchase + 40,000)               = 335,750 − 0.85h
  //   h        = (2% + 4 × 11%/12) × loan + 4 × (500,000 × 1.6%/12 + 250)
  //            = 0.0566667 × (335,750 − 0.85h) + 3,666.67
  //   h × 1.0481667 = 22,692.50  →  h = 21,650
  // 500,000 − 30,000 − 75,000 − 40,000 − 21,650 − 20,000
  assert.equal(offers.cash.holding, 21650);
  assert.equal(offers.cash.amount, 313350);
  assert.equal(offers.cash.pctOfArv, 79); // 100 − 6 − 15
});

/* ---------------- holding costs ---------------- */

test("holding: the scaled model, leg by leg", () => {
  // A hand-computed carry at a known purchase price — the piece the fixed
  // point below converges to, checked on its own so a solver bug can't hide
  // inside a plausible-looking total.
  //   cost basis  252,359 + 62,000        = 314,359
  //   loan        85% × 314,359           = 267,205.15
  //   points       2% × loan              =   5,344.10   (once)
  //   interest    loan × 11% ÷ 12         =   2,449.38   per month
  //   taxes       420,000 × 1.1% ÷ 12     =     385.00   per month
  //   insurance   420,000 × 0.5% ÷ 12     =     175.00   per month
  //   utilities                            =     250.00   per month
  //   monthly                              =   3,259.38
  //   holding     5,344.10 + 5 × 3,259.38 =  21,641.01
  const h = estimateHolding({ purchase: 252359, repairs: 62000, arv: 420000 });
  assert.equal(h.model, "scaled");
  assert.equal(Math.round(h.loanAmount), 267205);
  assert.equal(Math.round(h.points), 5344);
  assert.equal(Math.round(h.interest), 2449);
  assert.equal(Math.round(h.taxes), 385);
  assert.equal(Math.round(h.insurance), 175);
  assert.equal(h.utilities, 250);
  assert.equal(Math.round(h.monthly), 3259);
  assert.equal(Math.round(h.total), 21641);
});

test("holding: the backstack's carry is a true fixed point", () => {
  // The loan is sized off what the flipper pays — our price plus the fee — and
  // that price is what the stack solves for. Re-running the estimator against
  // the answer has to reproduce the carry the answer was built from.
  for (const [arv, repairs] of [[420000, 62000], [250000, 15000], [900000, 240000]]) {
    const c = calculateOffers({ arv, repairs }, { underwriteMode: "backstack" }).offers.cash;
    const purchase = c.amount + c.wholesaleFee;
    const again = estimateHolding({ purchase, repairs, arv });
    assert.ok(Math.abs(again.total - c.holding) < 1, `arv ${arv}: ${again.total} vs ${c.holding}`);
  }
});

test("holding: scales with the deal instead of sitting flat", () => {
  const small = calculateOffers({ arv: 180000, repairs: 20000 }, { underwriteMode: "backstack" }).offers.cash;
  const large = calculateOffers({ arv: 900000, repairs: 20000 }, { underwriteMode: "backstack" }).offers.cash;
  // The whole point of the change: a $900k carry is not a $180k carry.
  assert.ok(large.holding > small.holding * 3, `${large.holding} vs ${small.holding}`);
  // And a longer hold costs more, linearly in the recurring legs.
  const long = calculateOffers({ arv: 420000, repairs: 62000 }, { underwriteMode: "backstack", holdMonths: 10 }).offers.cash;
  const short = calculateOffers({ arv: 420000, repairs: 62000 }, { underwriteMode: "backstack", holdMonths: 5 }).offers.cash;
  assert.ok(long.holding > short.holding);
});

test("holding: an all-cash buyer drops the loan legs", () => {
  // loanToCostPct 0 → no points, no interest; taxes + insurance + utilities
  // still run. 400,000 × 1.6% ÷ 12 = 533.33; + 250 = 783.33 × 5 = 3,916.67
  const h = estimateHolding({ purchase: 250000, repairs: 40000, arv: 400000 }, { loanToCostPct: 0 });
  assert.equal(h.loanAmount, 0);
  assert.equal(h.points, 0);
  assert.equal(h.interest, 0);
  assert.equal(Math.round(h.total), 3917);
});

test("holding: the flat model is still available verbatim", () => {
  const h = estimateHolding({ purchase: 250000, repairs: 40000, arv: 400000 },
    { holdingModel: "flat", holdMonths: 4, holdMonthlyCost: 1500 });
  assert.equal(h.model, "flat");
  assert.equal(h.total, 6000);
  // And it drives the stack the way it always did.
  const { offers } = calculateOffers(
    { arv: 500000, repairs: 40000 },
    { underwriteMode: "backstack", holdingModel: "flat", sellingCostPct: 6, flipProfitPct: 15,
      holdMonths: 4, holdMonthlyCost: 1500, wholesaleFee: 20000 }
  );
  // 500,000 − 30,000 − 75,000 − 40,000 − 6,000 − 20,000
  assert.equal(offers.cash.holding, 6000);
  assert.equal(offers.cash.amount, 329000);
});

test("holding: the row label states the model's own arithmetic", () => {
  const scaled = calculateOffers({ arv: 420000, repairs: 62000 }, { underwriteMode: "backstack" }).offers.cash;
  assert.match(scaled.breakdown.find((r) => r.key === "holding").label, /5 mo × \$3,259 \+ \$5,344 pts/);
  const flat = calculateOffers({ arv: 420000, repairs: 62000 },
    { underwriteMode: "backstack", holdingModel: "flat" }).offers.cash;
  assert.match(flat.breakdown.find((r) => r.key === "holding").label, /5 × \$1,200/);
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

/* ---------------- blended (the mean of the other three) ---------------- */

test("blended: the plain average of the three models", () => {
  const inputs = { address: "1234 Main St", arv: 420000, repairs: 62000 };
  const parts = ["backstack", "lowball", "mao"].map(
    (m) => calculateOffers(inputs, { underwriteMode: m }).offers.cash.amount
  );
  const c = calculateOffers(inputs, { underwriteMode: "blended" }).offers.cash;
  assert.equal(c.mode, "blended");
  assert.equal(c.amount, Math.round(parts.reduce((t, n) => t + Math.round(n), 0) / 3));
  // 222,359 + 232,319 + 202,000 = 656,678 → 218,893 (rounded mean)
  assert.equal(c.amount, 218893);
});

test("blended: the components are reported, in mode order, already net of fee", () => {
  const c = calculateOffers({ address: "2 Elm", arv: 380000, repairs: 45000 },
    { underwriteMode: "blended" }).offers.cash;
  assert.deepEqual(c.components.map((p) => p.key), ["backstack", "lowball", "mao"]);
  for (const p of c.components) assert.ok(p.amount > 0 && p.label);
  // Each component already subtracted the fee, so the blend must not show a
  // second one to take out — it is a finished number.
  assert.equal(c.wholesaleFee, 30000);
  assert.ok(!c.breakdown, "the blend has no cost stack of its own");
});

test("blended: settings reach every component", () => {
  const inputs = { address: "3 Elm", arv: 380000, repairs: 45000 };
  const cheap = calculateOffers(inputs, { underwriteMode: "blended", wholesaleFee: 5000 }).offers.cash;
  const dear = calculateOffers(inputs, { underwriteMode: "blended", wholesaleFee: 45000 }).offers.cash;
  // The fee comes out of all three, so it comes out of the mean one-for-one.
  assert.equal(cheap.amount - dear.amount, 40000);
});

test("blended: an override replaces the blend, not the components it averages", () => {
  const c = calculateOffers({ address: "4 Elm", arv: 380000, repairs: 45000, priceOverride: 190000 },
    { underwriteMode: "blended" }).offers.cash;
  assert.equal(c.amount, 190000);
  assert.equal(c.overridden, true);
  const modeled = calculateOffers({ address: "4 Elm", arv: 380000, repairs: 45000 },
    { underwriteMode: "blended" }).offers.cash.amount;
  assert.equal(c.systemAmount, modeled, "the override must not leak into the components");
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

for (const mode of ["backstack", "lowball", "mao", "blended"]) {
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
