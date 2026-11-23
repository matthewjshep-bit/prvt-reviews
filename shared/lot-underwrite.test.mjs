// lot-underwrite.test.mjs — a teardown lot is priced off what builders pay,
// less what the seller would have paid to list.

import test from "node:test";
import assert from "node:assert/strict";
import { blankLotDeal, lotWarnings, normalizeLotDeal, sampleLotDeal, underwriteLot } from "./lot-underwrite.js";

test("a lot priced at lot value less the seller's selling costs leaves those costs as the spread", () => {
  const run = underwriteLot(sampleLotDeal());
  assert.ok(run.ok, run.errors.join(" "));
  const r = run.result;
  assert.equal(r.lotValue, 1300000, "the median of five sold teardowns");
  assert.equal(r.maxOffer, 1196000, "lot value less 8%");
  assert.equal(r.assignAt, 1300000, "a builder takes it at the lot value");
  assert.equal(r.spread, 104000);
  assert.equal(r.binding, "offer");
  assert.equal(r.value, r.lotValue, "value is the lot value, as the land engine names it");
  assert.equal(r.tests.find((t) => t.binding).price, r.maxOffer);
  assert.ok(r.tests.find((t) => t.key === "assign").info, "what a builder pays is shown, never the binding test");
});

test("an agent fee on the builder's side comes out of the spread, not the offer", () => {
  // The fee takes the sample under its $75k floor, which is the point of the floor.
  assert.equal(underwriteLot({ ...sampleLotDeal(), agentFeePct: 0.025 }).ok, false);
  const run = underwriteLot({ ...sampleLotDeal(), agentFeePct: 0.025, minSpread: 70000 });
  assert.ok(run.ok);
  assert.equal(run.result.maxOffer, 1196000, "the seller's number doesn't move");
  assert.equal(run.result.agentFee, 29900);
  assert.equal(run.result.spread, 104000 - 29900);
});

test("a spread under the minimum doesn't price, and says what to do", () => {
  const run = underwriteLot({ ...blankLotDeal(), comps: [{ label: "", price: 900000 }], minSpread: 75000 });
  assert.equal(run.ok, false);
  assert.match(run.errors[0], /spread is \$72k, under your \$75k minimum/);
  const ok = underwriteLot({ ...blankLotDeal(), comps: [{ label: "", price: 900000 }], minSpread: 70000 });
  assert.ok(ok.ok, "lowering the minimum prices it");
  assert.equal(ok.result.maxOffer, 828000);
});

test("no sold teardown, or no selling costs, is told in plain words", () => {
  const none = underwriteLot(blankLotDeal());
  assert.equal(none.ok, false);
  assert.match(none.errors[0], /Add at least one sold teardown/);
  const free = underwriteLot({ ...sampleLotDeal(), sellingCostPct: 0 });
  assert.equal(free.ok, false);
  assert.match(free.errors[0], /above 0%/);
});

test("the sample passes the teardown test; a big new house on a small lot doesn't", () => {
  assert.deepEqual(lotWarnings(normalizeLotDeal(sampleLotDeal())), []);
  const w = lotWarnings(normalizeLotDeal({ ...sampleLotDeal(), houseSqft: 4200, yearBuilt: 1992, lotSqft: 12000 }));
  const keys = w.map((x) => x.key);
  assert.deepEqual(keys, ["teardown", "teardown", "band"]);
  assert.match(w[0].text, /remodel might compete/);
  assert.match(w[1].text, /built 1992, newer than every teardown/);
  assert.match(w[2].text, /12,000 sqft; the comps sold between/);
});

test("a lot on a main road, or one already listed with cuts, carries the warning but still prices", () => {
  const run = underwriteLot({ ...sampleLotDeal(), screens: { arterial: true, corner: false, listed: true, priceCuts: 2 } });
  assert.ok(run.ok);
  const keys = run.result.warnings.map((w) => w.key);
  assert.deepEqual(keys, ["road", "listed"]);
  assert.match(run.result.warnings[0].text, /on a main road — builders of \$4M\+ homes want an interior lot/);
  assert.match(run.result.warnings[1].text, /2 price cuts/);
});

test("garbage in the deal is tidied, not trusted", () => {
  const d = normalizeLotDeal({ sellingCostPct: 3, agentFeePct: -1, minSpread: "x", comps: [{ price: "1,0" }, null], screens: { priceCuts: "2.6", arterial: "yes" }, yearBuilt: "1966.4" });
  assert.equal(d.sellingCostPct, 0.5);
  assert.equal(d.agentFeePct, 0);
  assert.equal(d.minSpread, 0);
  assert.equal(d.comps.length, 2);
  assert.equal(d.screens.priceCuts, 3);
  assert.equal(d.screens.arterial, true);
  assert.equal(d.yearBuilt, 1966);
});
