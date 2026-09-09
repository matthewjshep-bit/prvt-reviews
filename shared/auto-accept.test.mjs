// auto-accept.test.mjs — the ceiling the bot may say yes under, unattended.
// Most of these are about REFUSING to produce one: a ceiling computed from
// bad inputs is worse than no ceiling, because it opens the band.

import test from "node:test";
import assert from "node:assert/strict";
import { autoAcceptCeiling, AUTO_ACCEPT_FEE } from "./auto-accept.js";
import { calculateOffers, DEFAULT_OFFER_SETTINGS } from "./offer-calc.js";

const OFFER = { id: "o1", address: "12 Elm St, Renton, WA", cashAmount: 265000, arv: 500000, repairs: 85000 };

test("the ceiling is the highest of the three models recomputed at a ten thousand dollar fee", () => {
  const r = autoAcceptCeiling({ offer: OFFER });
  assert.equal(r.computable, true);
  assert.equal(r.modes.length, 3);
  assert.equal(r.ceiling, Math.max(...r.modes.map((m) => m.amount)));
  assert.equal(r.fee, AUTO_ACCEPT_FEE);
  // and it really is the generous fee, not our usual one
  const atUsualFee = calculateOffers(
    { address: OFFER.address, arv: OFFER.arv, repairs: OFFER.repairs, askingPrice: 0, priceOverride: 0 },
    { underwriteMode: "blended" },
  ).offers.cash.components;
  assert.ok(r.ceiling > Math.max(...atUsualFee.map((m) => m.amount)),
    "dropping the fee to $10k must raise the ceiling");
});

test("the ceiling names which model produced it", () => {
  const r = autoAcceptCeiling({ offer: OFFER });
  assert.ok(r.mode);
  assert.equal(r.modes.find((m) => m.key === r.mode).amount, r.ceiling);
  assert.match(r.basis, /\$10k assignment/);
});

test("an offer with no ARV has no ceiling and never auto-accepts", () => {
  const r = autoAcceptCeiling({ offer: { ...OFFER, arv: 0, calc: undefined } });
  assert.equal(r.computable, false);
  assert.equal(r.ceiling, 0);
  assert.match(r.reason, /no ARV/);
});

test("an offer with no repair estimate has no ceiling and never auto-accepts", () => {
  // Every model subtracts repairs, so a missing figure inflates all three.
  const r = autoAcceptCeiling({ offer: { ...OFFER, repairs: 0 } });
  assert.equal(r.computable, false);
  assert.match(r.reason, /repair estimate/);
});

test("an asking price is never used in place of a missing ARV", () => {
  // calculateOffers substitutes askingPrice for a zero ARV. If that leaked
  // through, the ceiling would be derived from the agent's list price rather
  // than an underwrite — biased high, in the one direction that costs money.
  const r = autoAcceptCeiling({ offer: { ...OFFER, arv: 0, askingPrice: 900000, calc: { inputs: { askingPrice: 900000 } } } });
  assert.equal(r.computable, false);
});

test("the ceiling uses the settings snapshotted on the offer, not today's settings", () => {
  const snapshot = { ...DEFAULT_OFFER_SETTINGS, maoPctOfArv: 55, underwriteMode: "mao" };
  const withSnap = autoAcceptCeiling({ offer: { ...OFFER, calc: { inputs: {}, settings: snapshot } } });
  const withToday = autoAcceptCeiling({ offer: OFFER, settings: { maoPctOfArv: 85 } });
  assert.equal(withSnap.source, "offer_snapshot");
  assert.equal(withToday.source, "location_settings");
  assert.notEqual(withSnap.ceiling, withToday.ceiling);
});

test("a missing calc snapshot falls back to the location settings and says so", () => {
  const r = autoAcceptCeiling({ offer: OFFER, settings: {} });
  assert.equal(r.source, "location_settings");
  assert.equal(r.computable, true);
});

test("retuning the maximum offer percentage moves the ceiling", () => {
  const tight = autoAcceptCeiling({ offer: { ...OFFER, calc: { settings: { ...DEFAULT_OFFER_SETTINGS, underwriteMode: "mao", maoPctOfArv: 60 } } } });
  const loose = autoAcceptCeiling({ offer: { ...OFFER, calc: { settings: { ...DEFAULT_OFFER_SETTINGS, underwriteMode: "mao", maoPctOfArv: 80 } } } });
  assert.ok(loose.ceiling > tight.ceiling);
});

test("an offer whose price was overridden above every model has no band", () => {
  const r = autoAcceptCeiling({ offer: { ...OFFER, cashAmount: 999000 } });
  assert.equal(r.computable, false);
  assert.match(r.reason, /already at or above/);
});

test("an underwater property has no ceiling", () => {
  const r = autoAcceptCeiling({ offer: { ...OFFER, arv: 200000, repairs: 400000, cashAmount: 1 } });
  assert.equal(r.computable, false);
});

test("the same offer yields the same ceiling twice", () => {
  // The lowball model jitters deterministically off the address and the
  // numbers. That is what makes a ceiling safe to write into an audit trail:
  // recompute it a month later and it still explains the decision.
  assert.equal(autoAcceptCeiling({ offer: OFFER }).ceiling, autoAcceptCeiling({ offer: OFFER }).ceiling);
});

test("a ceiling is never produced from no offer at all", () => {
  assert.equal(autoAcceptCeiling({ offer: null }).computable, false);
  assert.equal(autoAcceptCeiling({}).computable, false);
});
