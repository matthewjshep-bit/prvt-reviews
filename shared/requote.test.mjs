// requote.test.mjs — re-running our own arithmetic on the agent's numbers.
// The clamps are the whole safety story: an agent who wants a higher price
// has exactly two levers, and both are bounded against what we underwrote.

import test from "node:test";
import assert from "node:assert/strict";
import { planRequote, clampToOurs, REQUOTE_DEFAULTS } from "./requote.js";
import { autoAcceptCeiling } from "./auto-accept.js";
import { calculateOffers } from "./offer-calc.js";

const BAND = { ...REQUOTE_DEFAULTS, enabled: true };
// Priced by the calculator, the way a real offer is — so "re-running the same
// inputs lands on the same number" is a true statement about this fixture and
// not an accident of a figure typed into a test.
const OURS = Math.round(calculateOffers(
  { address: "12 Elm St, Renton, WA", arv: 500000, repairs: 85000, askingPrice: 0, priceOverride: 0 }, {},
).offers.cash.amount);
const OFFER = {
  id: "o1", address: "12 Elm St, Renton, WA", cashAmount: OURS,
  arv: 500000, repairs: 85000, createdAt: "2026-09-01T00:00:00.000Z",
  calc: { at: "2026-09-01T00:00:00.000Z", inputs: { arv: 500000, repairs: 85000 } },
};
const later = (t = "2026-09-05T00:00:00.000Z") => t;

test("an agent ARV forty percent above ours moves our number by at most ten percent", () => {
  const c = clampToOurs({ theirArv: 700000, ourArv: 500000, ourRehab: 85000, band: BAND });
  assert.equal(c.arv, 550000, "500k + 10%");
  assert.equal(c.clamped, true);
  assert.match(c.basis, /ARV was capped/);
});

test("an agent who says the rehab is nothing cannot cut our repair estimate past a quarter", () => {
  const c = clampToOurs({ theirRehab: 0, theirArv: 500000, ourArv: 500000, ourRehab: 85000, band: BAND });
  assert.equal(c.repairs, 85000, "no number from them at all is not a cut — ours stands");
  const c2 = clampToOurs({ theirRehab: 10000, theirArv: 500000, ourArv: 500000, ourRehab: 85000, band: BAND });
  assert.equal(c2.repairs, 63750, "85k less 25%");
  assert.equal(c2.clamped, true);
});

test("numbers that are worse for us than ours are taken whole", () => {
  // Nothing needs protecting from an agent talking our price DOWN.
  const c = clampToOurs({ theirArv: 400000, theirRehab: 150000, ourArv: 500000, ourRehab: 85000, band: BAND });
  assert.equal(c.arv, 400000);
  assert.equal(c.repairs, 150000);
  assert.equal(c.clamped, false);
});

test("re-quoting on a better ARV raises our number", () => {
  const r = planRequote({ offer: OFFER, take: { arv: 540000, rehab: 85000, at: later() }, band: BAND });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.from, OURS);
  assert.ok(r.to > r.from, "their better ARV should move us up");
});

test("a take older than our underwrite is not new information", () => {
  const r = planRequote({ offer: OFFER, take: { arv: 540000, at: "2026-08-20T00:00:00.000Z" }, band: BAND });
  assert.equal(r.ok, false);
  assert.match(r.reason, /predates our underwrite/);
});

test("an offer that has already been re-quoted once is refused", () => {
  const used = { ...OFFER, requotes: [{ ts: later() }] };
  const r = planRequote({ offer: used, take: { arv: 540000, at: later() }, band: BAND });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already re-quoted once/);
});

test("re-quoting with nothing new from them is refused", () => {
  const r = planRequote({ offer: OFFER, take: {}, band: BAND });
  assert.equal(r.ok, false);
  assert.match(r.reason, /nothing new/);
});

test("re-quoting is refused outright when the switch is off", () => {
  const r = planRequote({ offer: OFFER, take: { arv: 540000, at: later() }, band: REQUOTE_DEFAULTS });
  assert.equal(r.ok, false);
  assert.match(r.reason, /switched off/);
});

test("a re-quote that would land above the auto-accept ceiling is refused", () => {
  // The shared bound: the bot must never talk ITSELF up past the number it
  // would have been allowed to say yes to THEM at.
  const ceiling = autoAcceptCeiling({ offer: OFFER }).ceiling;
  const r = planRequote({ offer: OFFER, take: { arv: 550000, rehab: 20000, at: later() }, band: BAND, ceiling: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /above what we'd pay/);
  // and the same plan passes when the real ceiling leaves room
  const ok = planRequote({ offer: OFFER, take: { arv: 520000, rehab: 85000, at: later() }, band: BAND, ceiling });
  assert.equal(ok.ok, true, ok.reason);
  assert.ok(ok.to <= ceiling);
});

test("the clamp records that it bit so the reply can say so", () => {
  const r = planRequote({ offer: OFFER, take: { arv: 900000, rehab: 85000, at: later() }, band: BAND, ceiling: 0 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.clamped, true);
  assert.ok(r.basis, "the reply has to be able to say 'with your numbers, adjusted'");
});

test("their numbers landing on the price we already sent is not a re-quote", () => {
  const r = planRequote({ offer: OFFER, take: { arv: 500000, rehab: 85000, at: later() }, band: BAND });
  assert.equal(r.ok, false);
  assert.match(r.reason, /same price/);
});

test("numbers that put the deal underwater are refused rather than sent as zero", () => {
  const r = planRequote({ offer: OFFER, take: { arv: 500000, rehab: 900000, at: later() }, band: BAND });
  assert.equal(r.ok, false);
  assert.match(r.reason, /underwater/);
});

test("their counter price is never an input to our math", () => {
  // planRequote takes arv and rehab and nothing else. A price they want is a
  // negotiating position, not an underwriting input, and there is deliberately
  // no parameter for it.
  const r = planRequote({ offer: OFFER, take: { counterAmount: 400000, at: later() }, band: BAND });
  assert.equal(r.ok, false);
  assert.match(r.reason, /nothing new/);
});
