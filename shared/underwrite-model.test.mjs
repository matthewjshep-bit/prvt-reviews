import test from "node:test";
import assert from "node:assert/strict";
import { buildUnderwriteCalc, incomeMath, modelForAsset, pricedByHand, underwriteModel } from "./underwrite-model.js";
import { sampleIncomeDeal } from "./income-underwrite.js";
import { sampleLandDeal, underwriteLand } from "./land-underwrite.js";
import { offerMath } from "./offer-breakdown.js";

test("every offer made before income underwriting reads as a comps offer", () => {
  assert.equal(underwriteModel({}), "comps");
  assert.equal(underwriteModel({ calc: { inputs: { arv: 400000 } }, asset: { type: "multi_family" } }), "comps");
  assert.equal(underwriteModel(null), "comps");
  assert.equal(pricedByHand({ snapshot: {} }), false);
});

test("the model is read off the offer, its calc or its workspace", () => {
  assert.equal(underwriteModel({ underwriteModel: "income" }), "income");
  assert.equal(underwriteModel({ calc: { model: "land" } }), "land");
  assert.equal(underwriteModel({ draft: { model: "income" } }), "income");
  assert.equal(underwriteModel({ snapshot: { model: "bogus" } }), "comps");
});

test("trying the income analyzer on a priced house doesn't make it an income offer until it's saved", () => {
  assert.equal(underwriteModel({ calc: { inputs: { arv: 400000 } }, snapshot: { model: "income" } }), "comps");
});

test("multi-family and commercial price by income, land by land, a house by comps", () => {
  assert.equal(modelForAsset("multi_family"), "income");
  assert.equal(modelForAsset("commercial"), "income");
  assert.equal(modelForAsset("land"), "land");
  assert.equal(modelForAsset("sfr"), "comps");
  assert.equal(modelForAsset(""), "comps");
});

test("an income calc has the comps calc's shape, with no ARV to rerun flip math on", () => {
  const calc = buildUnderwriteCalc({ model: "income", deal: sampleIncomeDeal("multi_family"), inputs: { address: "1 Main St", askingPrice: "1,295,000" } });
  assert.equal(calc.model, "income");
  assert.equal(calc.inputs.arv, 0);
  assert.equal(calc.inputs.repairs, 0);
  assert.equal(calc.offers.cash.amount, calc.underwrite.maxOffer);
  assert.ok(calc.offers.cash.amount > 900000 && calc.offers.cash.amount < 1000000);
  assert.equal(calc.underwrite.binding, "coc");
  assert.equal(offerMath({ calc }), null);
});

test("a typed price is the letter's number and the engine's is kept beside it", () => {
  const calc = buildUnderwriteCalc({ model: "income", deal: sampleIncomeDeal("multi_family"), inputs: { askingPrice: 1295000, priceOverride: "950,000" } });
  assert.equal(calc.offers.cash.amount, 950000);
  assert.ok(calc.offers.cash.overridden);
  assert.equal(calc.offers.cash.systemAmount, calc.underwrite.maxOffer);
});

test("a deal the engine can't price is a 400 in plain words", () => {
  assert.throws(() => buildUnderwriteCalc({ model: "income", deal: { kind: "multi_family" }, inputs: {} }),
    (e) => e.http === 400 && /unit/.test(e.message));
});

test("the letter's income box ties out: NOI at that cap rate is the price", () => {
  const calc = buildUnderwriteCalc({ model: "income", deal: sampleIncomeDeal("multi_family"), inputs: { askingPrice: 1295000 } });
  const m = incomeMath(calc);
  assert.equal(m.total, calc.offers.cash.amount);
  const noi = m.rows[0].amount;
  const cap = Number(m.rows[1].text.replace("%", "")) / 100;
  assert.ok(Math.abs(noi / cap - m.total) / m.total < 0.001);
  assert.equal(incomeMath({ offers: { cash: { amount: 1 } } }), null);
});

test("land: median $/acre × acres, at the offer share, less site work and closing", () => {
  const r = underwriteLand(sampleLandDeal()).result;
  // $/acre: 123,810 · 115,000 · 132,222 → median 123,810 × 2.5 ac
  assert.ok(Math.abs(r.perUnit - 260000 / 2.1) < 1);
  const expect = Math.floor((r.value * 0.6 - 53000) / 1.02);
  assert.equal(r.maxOffer, expect);
  const calc = buildUnderwriteCalc({ model: "land", deal: sampleLandDeal(), inputs: { askingPrice: 325000 } });
  const box = incomeMath(calc);
  assert.equal(box.rows[0].key, "arv");
  assert.ok(box.rows.some((row) => row.key === "site"));
});

test("land with no comps or no acreage asks for them instead of pricing", () => {
  const r = underwriteLand({ askingPrice: 100000 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /acres/.test(e)));
  assert.ok(r.errors.some((e) => /comp/.test(e)));
});
