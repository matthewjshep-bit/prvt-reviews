import test from "node:test";
import assert from "node:assert/strict";
import {
  analyze, irr, loanBalance, maxOffer, normalizeIncomeDeal, operate, pmt, sampleIncomeDeal,
  sensitivity, underwriteIncome, validateIncomeDeal, verdictOf, blankIncomeDeal,
} from "./income-underwrite.js";

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const eightPlex = () => normalizeIncomeDeal(sampleIncomeDeal("multi_family"));

test("the sample 8-plex's in-place NOI is today's rents less normal vacancy and every expense", () => {
  const op = operate(eightPlex(), 1, true);
  // GPR 117,600 + other 2,400 − vacancy 5,880 − credit 1,176 = EGI 112,944
  near(op.gpr, 117600);
  near(op.egi, 112944);
  // 32,800 fixed + 4,800 R&M + 2,400 reserves + 8% management 9,035.52
  near(op.opex, 49035.52, 0.01);
  near(op.noi, 63908.48, 0.01);
});

test("stabilized is market rents with one year of growth and no rehab vacancy", () => {
  const op = operate(eightPlex(), 2, false);
  near(op.gpr, (4 * 1650 + 4 * 1350) * 12 * 1.03);
  assert.equal(op.vacancyRate, 0.05);
  assert.equal(operate(eightPlex(), 1, false).vacancyRate, 0.10);
});

test("a 0% loan pays back evenly and an amortized balance falls", () => {
  assert.equal(pmt(0, 30, 360000), 1000);
  near(pmt(0.07, 30, 1) * 12, 0.0798363, 0.000001);
  const d = { ...eightPlex(), ioYears: 2 };
  assert.equal(loanBalance(d, 500000, 2), 500000);
  assert.ok(loanBalance(d, 500000, 5) < 500000);
});

test("IRR is NaN when the cash never changes sign", () => {
  assert.ok(Number.isNaN(irr([-100, -10, -10])));
  near(irr([-100, 110]), 0.10, 1e-6);
});

test("the lender's DSCR price is shown but never sets the offer", () => {
  const r = maxOffer(eightPlex());
  const dscr = r.tests.find((t) => t.key === "dscr");
  assert.ok(dscr.info);
  // It is the lowest number on the board, and the offer is still above it.
  assert.ok(dscr.price < r.maxOffer, `${dscr.price} vs ${r.maxOffer}`);
  assert.notEqual(r.binding, "dscr");
});

test("the max offer is the lowest of the four return tests, and that test is named", () => {
  const r = maxOffer(eightPlex());
  const capping = r.tests.filter((t) => !t.info);
  const low = Math.min(...capping.map((t) => t.price));
  assert.equal(r.maxOffer, Math.floor(low));
  assert.equal(r.tests.filter((t) => t.binding).length, 1);
  near(r.tests.find((t) => t.key === "market").price, 63908.48 / 0.065, 1);
  // At the max offer every capping test passes.
  const at = analyze(r.deal, r.maxOffer);
  assert.ok(at.metrics.coc2 >= r.deal.targetCoc - 1e-6);
  assert.ok(at.metrics.irr >= r.deal.targetIrr - 1e-6);
  assert.ok(at.metrics.yieldOnCost >= r.deal.targetYoc - 1e-6);
});

test("a loan the income can't cover is cut below LTV and flagged", () => {
  const a = analyze(eightPlex(), 1295000);
  assert.ok(a.dscrCut);
  assert.ok(a.loan < 0.75 * 1295000);
  const u = underwriteIncome(sampleIncomeDeal("multi_family"));
  assert.ok(u.flags.some((f) => f.key === "dscr_cut" && f.level === "warn"));
});

test("a deal that loses money at every price offers nothing", () => {
  const d = { ...sampleIncomeDeal("multi_family"), taxes: 200000 };
  const r = maxOffer(d);
  assert.equal(r.maxOffer, 0);
});

test("validation names the problem instead of pricing a broken deal", () => {
  const d = normalizeIncomeDeal({ ...blankIncomeDeal("multi_family"), marketCap: 0, holdYears: 20, amortYears: 0, minDscr: 0 });
  const errs = validateIncomeDeal(d);
  assert.ok(errs.some((e) => /unit/.test(e)));
  assert.ok(errs.some((e) => /asking/.test(e)));
  assert.ok(errs.some((e) => /Market cap/.test(e)));
  assert.ok(errs.some((e) => /1 to 15/.test(e)));
  assert.ok(errs.some((e) => /Amortization/.test(e)));
  assert.ok(errs.some((e) => /DSCR/.test(e)));
  assert.equal(underwriteIncome(d).ok, false);
});

test("the sensitivity grid is 5 by 5 and IRR falls as the price rises", () => {
  const s = sensitivity(eightPlex(), 1000000);
  assert.equal(s.irr.length, 5);
  assert.equal(s.irr[0].length, 5);
  assert.ok(s.irr[0][2] > s.irr[4][2]);
  assert.ok(s.irr[2][0] > s.irr[2][4]); // a lower exit cap sells for more
});

test("a commercial lease that ends rolls to market after the downtime", () => {
  const d = normalizeIncomeDeal({
    ...blankIncomeDeal("commercial"),
    askingPrice: 500000,
    downtimeMonths: 6,
    tenants: [{ name: "A", sqft: 1000, rentPsf: 20, marketRentPsf: 30, recoveries: 0, yearsLeft: 2 }],
  });
  assert.equal(operate(d, 2, false).gpr, 20000 * 1.03);          // still on the lease
  near(operate(d, 3, false).gpr, 30000 * 1.03 ** 2);               // rolled
  near(operate(d, 3, false).rollover, 30000 * 1.03 ** 2 * 0.5);    // six months dark
  assert.equal(operate(d, 4, false).rollover, 0);
  assert.equal(operate(d, 3, true).gpr, 20000 * 1.03 ** 2);        // in place never rolls
});

test("leasing up a vacant suite isn't flagged as a rent raise", () => {
  const u = underwriteIncome(sampleIncomeDeal("commercial"));
  assert.ok(u.ok);
  assert.ok(!u.flags.some((f) => f.key === "rent_lift"));
});

test("the verdict reads works, close or overpriced against the asking price", () => {
  assert.equal(verdictOf(100, 100).status, "works");
  assert.equal(verdictOf(95, 100).status, "close");
  assert.equal(verdictOf(80, 100).status, "over");
});
