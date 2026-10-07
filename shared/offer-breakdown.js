// offer-breakdown.js — "how we got to this number", written for the listing
// agent rather than for us.
//
// The offer letter states a price. An agent who can see the arithmetic behind
// it argues with the inputs instead of dismissing the offer as a lowball, which
// is the whole reason this section exists.
//
// Matt, 2026-10-07: "we usually use the 70–75% ARV − rehab number, but I want
// them to know what we base it off of (holding costs, profit margin, etc)". So
// the price is whatever the offer's own model said — usually mao — and this
// module explains the gap between what the house is worth fixed up and that
// price, in costs an agent recognises: closing to buy and to resell, holding
// it while the work gets done, the work itself, and the profit and risk that
// make it worth doing at all.
//
// The constraint that shapes everything here: the agent must NOT see the
// assignment fee. It's our margin, and an agent who can read it off a page
// will take it to their seller as "they're marking your house up $15k".
//
// The naive fix — print the stack and delete the fee row — is worse than
// printing the fee: the column then sums to offer + fee, and the fee is
// recoverable by anyone who subtracts. A visibly-wrong column also destroys the
// credibility the section was supposed to buy.
//
// So the costs are computed independently of the fee and of the printed price
// — the back-stack cost model (selling costs and holding, shared/offer-calc.js)
// rerun on the offer's own frozen settings against the same ARV and repairs —
// and one line is the RESIDUAL: whatever it takes for the column to total the
// offer actually printed. That line is labelled for what it genuinely
// contains, the profit and risk of buying the house as-is. It ties out exactly
// regardless of rounding, the lowball model's cents, a list-price cap or a
// manual override, and a bigger fee only ever moves that one line.
//
// Texts name the costs and never put a figure on profit and risk; the page,
// the letter and the email show every line. See RUNBOOK "How we got our number".
//
// Pure functions. Money in whole dollars (cents only with { exact: true }).

import { calculateOffers, effectiveSettings } from "./offer-calc.js";

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const pct = (v) => {
  const n = num(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const cents = (n) => Math.round(n * 100) / 100;

// A profit-and-risk line above this share of the ARV is a cheap house, where
// financing, the work and the risk don't shrink with the price. Said in a
// caption so the line doesn't read as greed.
export const BIG_RESIDUAL_PCT = 22;

/**
 * offerMath(offer, { exact }) → null | {
 *   mode, total, arv, repairs, pctOfArv,
 *   closing: { sell, sellPct, buy, buyPct, total },
 *   holding: { months, model, total, detail: [{ label, amount }] },
 *   residual, premium, residualPctOfArv, big,
 *   rows: [{ key, label, amount, sign, pctOfArv, detail? }],
 * }
 *
 * null when there is nothing defensible to show: no calc, no ARV, a $0 or
 * underwater offer, or a calc the engine can't rerun. `exact` keeps the
 * printed price to the cent (the letter prints the lowball model's cents);
 * otherwise everything is whole dollars.
 */
export function offerMath(offer, { exact = false } = {}) {
  const calc = offer?.calc;
  const cash = calc?.offers?.cash;
  // A negative stack clamps the offer to 0, and a breakdown of a $0 offer
  // reads as a bug rather than a position.
  if (!cash || cash.underwater) return null;
  const raw = num(cash.amount) || num(offer?.cashAmount);
  const total = exact ? cents(raw) : Math.round(raw);
  // The ARV comes from the inputs, never from cash.base: the percentage
  // models set base to the DISCOUNTED basis (70% of ARV), which would both
  // mislabel the top line and shrink the residual to exactly the fee.
  const arv = Math.round(num(calc?.inputs?.arv) || (cash.mode === "backstack" ? num(cash.base) : 0));
  if (total <= 0 || arv <= 0) return null;
  const repairs = Math.max(0, Math.round(num(calc?.inputs?.repairs ?? cash.repairs)));

  // The costs, off the offer's own frozen settings (old offers fall back to
  // today's defaults). The conversation blob is not a cost and is the one
  // nested thing effectiveSettings would normalise, so it stays out.
  const { conversationAi, ...frozen } = calc?.settings || {};
  let stack;
  try {
    stack = calculateOffers({ arv, repairs, priceOverride: 0 }, { ...frozen, underwriteMode: "backstack" }).offers.cash;
  } catch {
    return null;
  }
  const s = effectiveSettings(frozen);
  const sellPct = pct(stack.sellingCostPct);
  const sell = Math.round(num(stack.sellingCosts));
  // What a flipper pays for the house before any fee — the purchase the
  // back-stack solves for — is what their purchase closing is a share of.
  const basis = Math.max(0, arv - num(stack.sellingCosts) - num(stack.flipProfit) - repairs - num(stack.holding));
  const buyPct = Math.max(0, pct(s.buyClosingPct));
  const buy = Math.round((basis * buyPct) / 100);
  const closingTotal = sell + buy;

  const hd = stack.holdingDetail || {};
  const months = Math.max(0, num(hd.months ?? stack.holdMonths));
  const holdingTotal = Math.round(num(stack.holding));
  const holdingDetail = holdingLines(hd, months, holdingTotal);

  const stated = arv - closingTotal - holdingTotal - repairs;
  const gap = exact ? cents(stated - total) : stated - total;
  const residual = gap > 0 ? gap : 0;
  const premium = gap < 0 ? -gap : 0;
  const share = (n) => Math.round((n / arv) * 1000) / 10;

  const rows = [{ key: "arv", label: "After-repair value", amount: arv, sign: "+", pctOfArv: 100 }];
  if (closingTotal > 0) {
    rows.push({
      key: "closing", label: "Closing costs, buying and reselling", amount: closingTotal, sign: "−", pctOfArv: share(closingTotal),
      detail: [
        { label: `Resale: agents and closing (${sellPct}%)`, amount: sell },
        ...(buy > 0 ? [{ label: `Purchase closing (${buyPct}%)`, amount: buy }] : []),
      ],
    });
  }
  if (holdingTotal > 0) {
    rows.push({
      key: "holding", label: `Holding, ${months} month${months === 1 ? "" : "s"}`, amount: holdingTotal, sign: "−",
      pctOfArv: share(holdingTotal), detail: holdingDetail,
    });
  }
  if (repairs > 0) rows.push({ key: "repairs", label: "Renovation budget", amount: repairs, sign: "−", pctOfArv: share(repairs) });
  if (residual > 0) rows.push({ key: "return", label: "Profit & risk", amount: residual, sign: "−", pctOfArv: share(residual) });
  // Only reachable by a price set above what the costs leave room for (a
  // manual override). Said plainly rather than as a negative subtraction.
  if (premium > 0) rows.push({ key: "premium", label: "Premium over our numbers", amount: premium, sign: "+", pctOfArv: share(premium) });

  const residualPctOfArv = share(residual);
  return {
    mode: cash.mode || null,
    total, arv, repairs,
    // What Matt prices off: "about 70% of the ARV, less the work".
    pctOfArv: Math.round(((total + repairs) / arv) * 100),
    closing: { sell, sellPct, buy, buyPct, total: closingTotal },
    holding: { months, model: hd.model || s.holdingModel, total: holdingTotal, detail: holdingDetail },
    residual, premium, residualPctOfArv,
    big: residualPctOfArv > BIG_RESIDUAL_PCT,
    rows,
  };
}

// Holding as the lines an agent would recognise, summing exactly to the row.
function holdingLines(hd, months, total) {
  if (!total) return [];
  if (hd.model === "flat") {
    return [{ label: `${months} months at $${Math.round(num(hd.monthly)).toLocaleString("en-US")} a month`, amount: total }];
  }
  const lines = [
    { label: "Loan interest and points", amount: Math.round(num(hd.points) + months * num(hd.interest)) },
    { label: "Property taxes", amount: Math.round(months * num(hd.taxes)) },
    { label: "Insurance", amount: Math.round(months * num(hd.insurance)) },
    { label: "Utilities and upkeep", amount: Math.round(months * num(hd.utilities)) },
  ].filter((l) => l.amount > 0);
  if (!lines.length) return [];
  // Rounding lands on the biggest line, so the parts always add to the row.
  // The order stays the reading order: loan, taxes, insurance, utilities.
  const off = total - lines.reduce((t, l) => t + l.amount, 0);
  lines.reduce((big, l) => (l.amount > big.amount ? l : big), lines[0]).amount += off;
  return lines;
}

/**
 * offerBreakdown(offer) → null | { rows, total, basis, caption? }
 *
 * The agent page's column (ghl-broker/offer-page.js): offerMath's rows, a
 * caption under them, and a second caption on a cheap house.
 */
export function offerBreakdown(offer) {
  const m = offerMath(offer);
  if (!m) return null;
  return {
    rows: m.rows,
    total: m.total,
    // Rendered as a caption. Kept out of the rows so it can't be mistaken for
    // a line item in the arithmetic.
    basis: "What it's worth fixed up, less what it costs to buy it, carry it while the work gets done, renovate it and resell it, and the profit that makes the risk worth taking.",
    ...(m.big ? { caption: "On a lower-priced house the cost of financing, the work and the risk don't shrink with the price, so they take a bigger share of it." } : {}),
  };
}

// Guard used by the tests and by anything that wants to assert the promise
// this module exists to keep: the column adds up, and the fee never appears.
export function breakdownTotals(breakdown) {
  if (!breakdown) return null;
  const sum = breakdown.rows.reduce((t, r) => t + (r.sign === "+" ? r.amount : -r.amount), 0);
  const total = breakdown.total;
  return { sum: cents(sum), total, balanced: Math.abs(sum - total) < 0.005 };
}

/**
 * compactMath(m) → the few numbers a lean offer row carries (row.math), or
 * null. Everything the bot and the send texts need, ~150 bytes.
 */
export function compactMath(m) {
  if (!m) return null;
  return {
    arv: m.arv, repairs: m.repairs, total: Math.round(m.total), pctOfArv: m.pctOfArv,
    closing: m.closing.total, closingSell: m.closing.sell, closingBuy: m.closing.buy, sellPct: m.closing.sellPct, buyPct: m.closing.buyPct,
    holding: m.holding.total, months: m.holding.months,
    residual: Math.round(m.residual), premium: Math.round(m.premium), big: m.big,
  };
}

// Either shape: offerMath's or compactMath's.
const flat = (m) => (m && typeof m.closing === "object" ? compactMath(m) : m);

// Thousands the way we text them: "500", "38", "1.25M". No dollar sign.
export const kWords = (n) => {
  const v = Math.max(0, num(n));
  return v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : `${Math.round(v / 1000)}`;
};

const listWords = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * mathSentence(m) → one text-sized sentence, or "" when there is nothing to
 * say plainly (no math, or a price set above the model).
 *
 * "We base it on about 69% of the 500 it's worth fixed up, less the 50 of
 * work; the rest covers about 38 to buy and resell, 26 to hold it 5 months
 * and our profit and risk."
 *
 * Thousands, no dollar signs, never a figure on profit and risk. Worded so
 * the transcript readers (shared/current-offer.js) never take a cost for a
 * price: "we base it on" marks where the math starts.
 */
export function mathSentence(math) {
  const m = flat(math);
  if (!m || m.premium > 0 || !(m.arv > 0) || !(m.total > 0)) return "";
  const work = m.repairs > 0 ? `, less the ${kWords(m.repairs)} of work` : "";
  const parts = [
    m.closing > 0 ? `about ${kWords(m.closing)} to buy and resell` : "",
    m.holding > 0 ? `${kWords(m.holding)} to hold it ${m.months} month${m.months === 1 ? "" : "s"}` : "",
    "our profit and risk",
  ].filter(Boolean);
  return `We base it on about ${m.pctOfArv}% of the ${kWords(m.arv)} it's worth fixed up${work}; the rest covers ${listWords(parts)}.`;
}

/**
 * mathAllowedAmounts(m) → [dollars] the reply gate may let a text say when
 * we show our work: the ARV, the work, the closing costs (and their parts)
 * and the holding — exact and to the nearest thousand. Never profit and
 * risk: a text that names it is held as a figure not in the offer book.
 */
export function mathAllowedAmounts(math) {
  const m = flat(math);
  if (!m) return [];
  const out = new Set();
  for (const n of [m.arv, m.repairs, m.closing, m.closingSell, m.closingBuy, m.holding]) {
    const v = Math.round(num(n));
    if (v > 0) { out.add(v); out.add(Math.round(v / 1000) * 1000); }
  }
  out.delete(0);
  return [...out];
}

/**
 * mathFigures(m) → the figures as the bot may say them, in thousands, for a
 * prompt: { arvK, repairsK, closingK, holdingK, months, pct }.
 */
export function mathFigures(math) {
  const m = flat(math);
  if (!m) return null;
  return {
    arvK: kWords(m.arv), repairsK: m.repairs > 0 ? kWords(m.repairs) : "", closingK: m.closing > 0 ? kWords(m.closing) : "",
    holdingK: m.holding > 0 ? kWords(m.holding) : "", months: m.months, pct: m.pctOfArv,
  };
}
