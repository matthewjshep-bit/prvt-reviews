// auto-accept.test.mjs — the ceiling the bot may say yes under, unattended.
// Most of these are about REFUSING to produce one: a ceiling computed from
// bad inputs is worse than no ceiling, because it opens the band.

import test from "node:test";
import assert from "node:assert/strict";
import { autoAcceptCeiling, AUTO_ACCEPT_FEE } from "./auto-accept.js";
import { calculateOffers, DEFAULT_OFFER_SETTINGS } from "./offer-calc.js";

// Priced under the buyer line (70% × 500k − 85k − 10k = 255k), as a real
// offer has to be for the band to be able to open at all.
const OFFER = { id: "o1", address: "12 Elm St, Renton, WA", cashAmount: 240000, arv: 500000, repairs: 85000 };

test("the ceiling is the buyer's line — the maximum-offer model — recomputed at a ten thousand dollar fee", () => {
  const r = autoAcceptCeiling({ offer: OFFER });
  assert.equal(r.computable, true);
  assert.equal(r.modes.length, 3, "all three models stay on the verdict for the audit trail");
  assert.equal(r.mode, "mao");
  assert.equal(r.ceiling, r.modes.find((m) => m.key === "mao").amount);
  assert.equal(r.fee, AUTO_ACCEPT_FEE);
  // and it really is the generous fee, not our usual one
  const atUsualFee = calculateOffers(
    { address: OFFER.address, arv: OFFER.arv, repairs: OFFER.repairs, askingPrice: 0, priceOverride: 0 },
    { underwriteMode: "blended" },
  ).offers.cash.components;
  assert.ok(r.ceiling > atUsualFee.find((m) => m.key === "mao").amount,
    "dropping the fee to $10k must raise the ceiling");
});

test("on a big-ARV, light-rehab house the generous models can't lift the ceiling past what a buyer pays", () => {
  // 39811 226th Ave SE, 2026-09-14: "90% ARV − 2× rehab" came out $584k at a
  // $10k fee, the buyer line about $500k, and a $550k counter went through.
  const house = { id: "o2", address: "39811 226th Ave SE, Enumclaw, WA", cashAmount: 0, arv: 850000, repairs: 54000 };
  const r = autoAcceptCeiling({ offer: house });
  const generous = Math.max(...r.modes.map((m) => m.amount));
  assert.ok(generous > r.ceiling, `a model above the buyer line exists (${generous} vs ${r.ceiling})`);
  assert.equal(r.ceiling, r.modes.find((m) => m.key === "mao").amount);
  const between = Math.round((r.ceiling + generous) / 2);
  assert.ok(between > r.ceiling, "a counter between the buyer line and the generous model is over the ceiling");
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
  // 72% keeps the snapshot's buyer line (≈265k) above the fixture's offer, so a
  // ceiling exists to compare; 55% put it under the offer and there was none.
  const snapshot = { ...DEFAULT_OFFER_SETTINGS, maoPctOfArv: 72, underwriteMode: "mao" };
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

/* ---------- the guard ---------- */

import { evaluateCounterBand, evaluateAcceptance } from "./auto-accept.js";

const BAND = { enabled: true, dailyCap: 2, acceptance: false, maxAmount: 0 };
const CEILING = autoAcceptCeiling({ offer: OFFER }).ceiling;
const band = (over = {}) => evaluateCounterBand({
  offer: OFFER, openOffers: [OFFER], band: BAND, releasedToday: 0,
  draft: { counterAmount: CEILING - 1000, confidence: "high", propertyAddress: OFFER.address },
  inboundMessage: `seller says $${(CEILING - 1000).toLocaleString("en-US")}`,
  ...over,
});
const failed = (v) => v.checks.find((c) => !c.ok)?.name;

test("a counter under the ceiling passes", () => {
  assert.equal(band().passed, true, band().reason);
});

test("a counter exactly at the ceiling is allowed", () => {
  const v = band({ draft: { counterAmount: CEILING, confidence: "high", propertyAddress: OFFER.address }, inboundMessage: `$${CEILING.toLocaleString("en-US")}` });
  assert.equal(v.passed, true, v.reason);
});

test("a counter more than 10% over the ceiling is refused", () => {
  const over = Math.round(CEILING * 1.2);
  const v = band({ draft: { counterAmount: over, confidence: "high", propertyAddress: OFFER.address }, inboundMessage: `$${over.toLocaleString("en-US")}` });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "under_ceiling");
  assert.match(v.reason, /over the/);
  assert.equal(v.counterBack, false);
});

test("a counter a little over the ceiling is answered by countering back AT the ceiling", () => {
  // Matt, 2026-09-14: counters go automatically instead of waiting for review.
  const over = CEILING + 1;
  const v = band({ draft: { counterAmount: over, confidence: "high", propertyAddress: OFFER.address }, inboundMessage: `$${over.toLocaleString("en-US")}` });
  assert.equal(v.passed, true, v.reason);
  assert.equal(v.counterBack, true);
  assert.equal(v.releaseAmount, CEILING, "we answer with the most we'd pay, not their number");
});

test("counter back still needs every other check — a medium-confidence read parks", () => {
  const over = CEILING + 1;
  const v = band({ draft: { counterAmount: over, confidence: "medium", propertyAddress: OFFER.address }, inboundMessage: `$${over.toLocaleString("en-US")}` });
  assert.equal(v.passed, false);
  assert.equal(v.counterBack, false);
});

test("a number the model read but the agent never typed fails", () => {
  // The single most important check here. Everything else is arithmetic;
  // this is the one that says we did not imagine the number.
  const v = band({ inboundMessage: "seller wants a bit more than that" });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "their_own_words");
});

test("a counter below our own number fails", () => {
  const v = band({ draft: { counterAmount: 100000, confidence: "high", propertyAddress: OFFER.address }, inboundMessage: "they'd take $100,000" });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "above_ours");
});

test("an agent with two open offers and no address named fails", () => {
  // Saying yes on the wrong house is worse than not saying yes at all.
  const other = { ...OFFER, id: "o2", address: "3 Fir Ln" };
  const v = band({ openOffers: [OFFER, other], draft: { counterAmount: CEILING - 1000, confidence: "high", propertyAddress: "" } });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "one_offer");
  // Naming the property is what resolves it.
  const named = band({ openOffers: [OFFER, other], draft: { counterAmount: CEILING - 1000, confidence: "high", propertyAddress: OFFER.address } });
  assert.equal(named.passed, true, named.reason);
});

test("a medium-confidence counter fails even inside the band", () => {
  // Hard-coded high, not the page's minConfidence: an operator who relaxed
  // the bar for questions did not thereby relax it for money.
  const v = band({ draft: { counterAmount: CEILING - 1000, confidence: "medium", propertyAddress: OFFER.address } });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "sure");
});

test("a counter the model flagged for a person fails", () => {
  const v = band({ draft: { counterAmount: CEILING - 1000, confidence: "high", needsHuman: true, humanReason: "they mention a lawyer", propertyAddress: OFFER.address } });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "sure");
});

test("an offer that already used its exception fails", () => {
  const used = { ...OFFER, counterBand: { at: "2026-09-01T00:00:00Z" } };
  const v = band({ offer: used, openOffers: [used] });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "once_per_offer");
});

test("an offer that became a deal fails", () => {
  const done = { ...OFFER, deal: { stage: "under_contract" } };
  const v = band({ offer: done, openOffers: [done] });
  assert.equal(v.passed, false);
});

test("the daily cap is enforced from the count it is handed", () => {
  assert.equal(band({ releasedToday: 1 }).passed, true);
  const v = band({ releasedToday: 2 });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "under_daily_cap");
});

test("an absolute cap lowers the ceiling but never raises it", () => {
  const low = band({ band: { ...BAND, maxAmount: OFFER.cashAmount + 1000 } });
  assert.equal(low.ceiling, OFFER.cashAmount + 1000);
  assert.equal(low.passed, false, "our counter is above the operator's hard cap");
  const high = band({ band: { ...BAND, maxAmount: 99000000 } });
  assert.equal(high.ceiling, CEILING, "a cap above the derived ceiling changes nothing");
});

test("an offer with no ARV can never open the band", () => {
  const bare = { id: "o1", address: "12 Elm St", cashAmount: 240000 };
  const v = band({ offer: bare, openOffers: [bare] });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "ceiling_computable");
});

test("the verdict carries the whole audit trail, pass or fail", () => {
  for (const v of [band(), band({ draft: { counterAmount: CEILING + 50000, confidence: "high", propertyAddress: OFFER.address }, inboundMessage: `$${(CEILING + 50000).toLocaleString("en-US")}` })]) {
    assert.equal(v.kind, "counter_band");
    assert.ok(v.checks.length >= 9, "every check is recorded either way");
    assert.ok(v.at);
    assert.equal(v.offerId, "o1");
    assert.ok(v.modes.length === 3, "all three models ride along so the number can be explained later");
  }
});

/* ---------- acceptance ---------- */

const acc = (over = {}) => evaluateAcceptance({
  offer: OFFER, openOffers: [OFFER], band: { ...BAND, acceptance: true }, releasedToday: 0,
  draft: { confidence: "high", propertyAddress: OFFER.address, counterAmount: 0 },
  inboundMessage: "seller signed off, we're good to go",
  ...over,
});

test("a plain acceptance passes when the acceptance half is switched on", () => {
  assert.equal(acc().passed, true, acc().reason);
});

test("acceptance stays shut when only the counter half is on", () => {
  const v = acc({ band: { ...BAND, acceptance: false } });
  assert.equal(v.passed, false);
  assert.match(v.reason, /acceptance is off/);
});

test("an acceptance that names a new number is not an acceptance", () => {
  const v = acc({ inboundMessage: "they'll do it at $290,000" });
  assert.equal(v.passed, false);
  assert.match(v.reason, /that is a counter/);
});

test("an acceptance repeating our own number back is still an acceptance", () => {
  const v = acc({ inboundMessage: `yes, $${OFFER.cashAmount.toLocaleString("en-US")} works for them` });
  assert.equal(v.passed, true, v.reason);
});

test("an acceptance that rounds our number is still an acceptance (825,000 on our 825,240)", () => {
  const ours = { ...OFFER, cashAmount: 825240.29 };
  const v = acc({ offer: ours, openOffers: [ours], inboundMessage: "They agreed to accept 825,000 offer" });
  assert.equal(v.passed, true, v.reason);
  const far = acc({ offer: ours, openOffers: [ours], inboundMessage: "They agreed to accept 800,000" });
  assert.equal(far.passed, false, "25k off is a counter");
});

test("an acceptance is only ever signalled once", () => {
  const done = { ...OFFER, acceptanceSignal: { at: "2026-09-01T00:00:00Z" } };
  assert.equal(acc({ offer: done, openOffers: [done] }).passed, false);
});

test("a bare run of digits is not a number they said", () => {
  // "98056" is a zip and "1450" is a square footage. A figure has to look
  // like money before it can open the band — the conservative direction.
  const v = band({ inboundMessage: `seller would do ${CEILING - 1000}` });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "their_own_words");
});


test("the ceiling never goes above 90% of the list price", () => {
  // A generous buyer line on a cheap listing: the list price wins.
  const listed = autoAcceptCeiling({ offer: { ...OFFER, cashAmount: 100000, askingPrice: 250000 } });
  assert.equal(listed.computable, true, listed.reason);
  assert.equal(listed.ceiling, 225000);
  assert.equal(listed.listCapped, true);
  assert.match(listed.basis, /90% of the \$250k list price/);
});

test("a list price above the buyer line leaves the buyer line as the ceiling", () => {
  const r = autoAcceptCeiling({ offer: { ...OFFER, askingPrice: 900000 } });
  assert.equal(r.listCapped, false);
  assert.equal(r.ceiling, r.modes.find((m) => m.key === "mao").amount);
});

test("the share of list comes from the offer's snapshot settings when set", () => {
  const r = autoAcceptCeiling({ offer: { ...OFFER, cashAmount: 100000, askingPrice: 250000, calc: { settings: { ...DEFAULT_OFFER_SETTINGS, maxOfferPctOfList: 80 } } } });
  assert.equal(r.ceiling, 200000);
});

/* ---------- the investor band (2026-09-17, Matt's decision) ---------- */

import { evaluateInvestorBand, INVESTOR_MIN_FEE_FLOOR } from "./auto-accept.js";

// Contract 400k + a 25k fee = asking 425k. Floor with a 10k minimum fee: 410k.
// Five percent off asking: 403,750. So the tighter limit is the floor, 410k.
const DEAL_OFFER = { id: "deal1", address: "23706 138th Dr SE, Snohomish, WA 98296", cashAmount: 400000,
  deal: { stage: "under_contract", contractPrice: 400000, assignmentFee: 25000, investors: [{ contactId: "b1", status: "evaluating" }] } };
const IBAND = { enabled: true, dailyCap: 1, minFee: 10000, maxDropPct: 5 };
const ib = (over = {}) => evaluateInvestorBand({
  offer: DEAL_OFFER, asking: 425000, contactId: "b1", liveDeals: [DEAL_OFFER], band: IBAND, releasedToday: 0,
  draft: { intent: "price_pushback", counterAmount: 415000, confidence: "high", needsHuman: false, propertyAddress: DEAL_OFFER.address },
  inboundMessage: "I could do 415k on this one", ...over,
});

test("a buyer who names a number above our floor gets a yes, at their number", () => {
  const v = ib();
  assert.equal(v.passed, true, v.reason);
  assert.equal(v.kind, "investor_band");
  assert.equal(v.releaseAmount, 415000);
  assert.equal(v.floor, 410000);
  assert.equal(v.counterBack, false, "no counter-back in this version");
});

test("a number under contract plus the minimum fee is a person's call", () => {
  const v = ib({ draft: { intent: "price_pushback", counterAmount: 405000, confidence: "high" }, inboundMessage: "405k and I'm in" });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "above_floor");
});

test("more than five percent off asking waits for a person even when the fee survives", () => {
  // A fat fee: contract 300k, asking 425k. 380k keeps an 80k fee but is 10.6% off asking.
  const fat = { ...DEAL_OFFER, deal: { ...DEAL_OFFER.deal, contractPrice: 300000, assignmentFee: 125000 } };
  const v = ib({ offer: fat, liveDeals: [fat], draft: { intent: "price_pushback", counterAmount: 380000, confidence: "high" }, inboundMessage: "380k" });
  assert.equal(v.passed, false);
  assert.equal(failed(v), "within_drop", "a second rail, in case the contract price on the deal is wrong");
});

test("a number the buyer did not type is never accepted", () => {
  const v = ib({ inboundMessage: "that's too rich for me, can you do better?" });
  assert.equal(failed(v), "their_own_words");
});

test("a minimum fee set below the floor is lifted to it", () => {
  const v = ib({ band: { ...IBAND, minFee: 1000 }, draft: { intent: "price_pushback", counterAmount: 402000, confidence: "high" }, inboundMessage: "402k" });
  assert.equal(v.floor, 400000 + INVESTOR_MIN_FEE_FLOOR);
  assert.equal(v.passed, false);
});

test("the second pushback on the same deal waits for a person, even from a different buyer", () => {
  const used = { ...DEAL_OFFER, deal: { ...DEAL_OFFER.deal, investorBand: { at: "2026-09-16T00:00:00Z", contactId: "b9", amount: 418000 } } };
  assert.equal(failed(ib({ offer: used, liveDeals: [used] })), "once_per_deal");
});

test("anything but a sure read, a live deal and one deal waits for a person", () => {
  assert.equal(failed(ib({ draft: { intent: "price_pushback", counterAmount: 415000, confidence: "medium" } })), "sure");
  assert.equal(failed(ib({ draft: { intent: "price_pushback", counterAmount: 415000, confidence: "high", needsHuman: true } })), "sure");
  const found = { ...DEAL_OFFER, deal: { ...DEAL_OFFER.deal, stage: "buyer_found" } };
  assert.equal(failed(ib({ offer: found, liveDeals: [found] })), "deal_live");
  const spoken = { ...DEAL_OFFER, deal: { ...DEAL_OFFER.deal, investors: [{ contactId: "b2", status: "committed" }] } };
  assert.equal(failed(ib({ offer: spoken, liveDeals: [spoken] })), "deal_live", "spoken for by someone else");
  const other = { ...DEAL_OFFER, id: "deal2", address: "9 Oak St, Kent, WA" };
  assert.equal(failed(ib({ liveDeals: [DEAL_OFFER, other], draft: { intent: "price_pushback", counterAmount: 415000, confidence: "high", propertyAddress: "" } })), "one_deal");
  assert.equal(failed(ib({ offer: null, liveDeals: [] })), "one_deal");
});

test("at or over asking is not a pushback, the daily cap holds, and the switch has to be on", () => {
  assert.equal(failed(ib({ draft: { intent: "price_pushback", counterAmount: 425000, confidence: "high" }, inboundMessage: "425k works" })), "below_asking");
  assert.equal(failed(ib({ releasedToday: 1 })), "under_daily_cap");
  assert.equal(ib({ band: { ...IBAND, enabled: false } }).passed, false);
  assert.equal(failed(ib({ asking: 0 })), "below_asking", "no asking price, no arithmetic");
});
