// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// offer-calc.js — the offer calculation engine, shared by the broker (document
// generation + persistence) and the frontend (live preview as the user types).
// Pure functions, no I/O, no deps.
//
// The cash and seller-finance models are reverse engineered from
// lowballoffer.ai's shipped bundle (app/page-*.js, decoded 2026-07-26):
//
//   Cash ("fix & flip"):
//     base    = ~90% of ARV  (they randomize among 90.0147/90.2987/89.661/89.479)
//     minus   repairs adjustment (piecewise, continuous):
//               repairs < $30k          → repairs + $30,000
//               $30k…10% of ARV         → 2 × repairs
//               above 10% of ARV        → 2×(10% ARV) + 1.5×(excess)
//     minus   flat $30,000 assignment-fee spread
//     (plus random cents for fake precision; their "MAO" readout is offer+$20k)
//
//   Creative (seller finance):
//     price   = 110% of as-is/asking value
//     down    = 5% of price
//     monthly = (price − down) / 360   (0% interest, 360 months)
//
// We keep the same math but make the "authentic-looking" randomness
// DETERMINISTIC: a hash of the inputs picks the ARV multiplier wobble and the
// cents, so the same property always yields the same offer.
//
// All percentage settings are whole numbers (90 = 90%). Money in dollars.

export const DEFAULT_OFFER_SETTINGS = {
  // Cash offer (lowballoffer.ai fix & flip model)
  cashPctOfArv: 90,          // base % of ARV before deductions
  repairBuffer: 30000,       // small-repair floor: repairs < buffer → repairs + buffer
  repairHeavyPctOfArv: 10,   // repairs above this % of ARV are "heavy"
  repairBaseMult: 2,         // multiplier on repairs in the normal band
  repairHeavyMult: 1.5,      // multiplier on the portion above the heavy threshold
  wholesaleFee: 30000,       // flat assignment-fee spread subtracted at the end
  precisionJitter: true,     // deterministic ±0.5pp ARV wobble + cents (lowball anchoring)
  // Seller finance (lowballoffer.ai "creative" model)
  sfPricePctOfAsking: 110,   // purchase price as % of asking/as-is value
  sfDownPct: 5,              // down payment as % of price
  sfAnnualRatePct: 0,        // annual interest rate (0 = principal-only payments)
  sfTermYears: 30,           // amortization term (360 months)
  sfBalloonYears: 0,         // 0 = fully amortized, no balloon
  // Lease option
  loPricePctOfAsking: 103,   // strike price as % of asking
  loOptionFeePct: 2,         // non-refundable option fee as % of strike price
  loTermMonths: 36,
  loRentCreditPct: 25,       // % of each rent payment credited toward purchase
  // Presentation
  closeDays: 14,             // advertised days-to-close on the cash offer
  validityDays: 7,           // offer expiry window printed on the document
  roundTo: 100,              // rounding for seller-finance / lease-option figures
  // Printed on the offer document
  company: { name: "", signer: "", phone: "", email: "" },
};

const num = (v, fallback = 0) => {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const roundTo = (v, step) => (step > 0 ? Math.round(v / step) * step : Math.round(v));

export const fmtMoney = (v) => {
  const n = num(v);
  const hasCents = Math.abs(n - Math.round(n)) > 0.004;
  return (
    "$" +
    n.toLocaleString("en-US", hasCents ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {})
  );
};

// FNV-1a — deterministic stand-in for lowballoffer.ai's Math.random() theater.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Monthly payment for principal P at annual rate (whole %) over n months.
// Zero-interest amortizes principal evenly.
export function monthlyPayment(principal, annualRatePct, months) {
  if (months <= 0) return 0;
  const r = num(annualRatePct) / 100 / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

// Remaining balance after k payments of `payment` on principal P at monthly rate r.
export function remainingBalance(principal, annualRatePct, payment, k) {
  const r = num(annualRatePct) / 100 / 12;
  if (r === 0) return Math.max(0, principal - payment * k);
  return principal * Math.pow(1 + r, k) - payment * ((Math.pow(1 + r, k) - 1) / r);
}

// The lowballoffer.ai repairs adjustment (piecewise, continuous at both knees).
export function repairsAdjustment(repairs, arv, s) {
  const heavy = (s.repairHeavyPctOfArv / 100) * arv;
  if (repairs < s.repairBuffer) return repairs + s.repairBuffer;
  if (repairs > heavy) return s.repairBaseMult * heavy + s.repairHeavyMult * (repairs - heavy);
  return s.repairBaseMult * repairs;
}

// Merge partial settings over the defaults (one level deep + company).
export function effectiveSettings(overrides = {}) {
  const s = { ...DEFAULT_OFFER_SETTINGS, ...(overrides || {}) };
  s.company = { ...DEFAULT_OFFER_SETTINGS.company, ...((overrides || {}).company || {}) };
  return s;
}

// inputs: { address, askingPrice, arv?, repairs?, monthlyRent? }
// Returns { inputs, settings, offers: { cash, sellerFinance, leaseOption|null } }.
// Throws { message, http:400 } on unusable inputs.
export function calculateOffers(rawInputs = {}, settingsOverride = {}) {
  const s = effectiveSettings(settingsOverride);

  const askingPrice = num(rawInputs.askingPrice);
  if (askingPrice <= 0) {
    throw Object.assign(new Error("askingPrice must be a positive number"), { http: 400 });
  }
  const arv = num(rawInputs.arv) > 0 ? num(rawInputs.arv) : askingPrice;
  const repairs = Math.max(0, num(rawInputs.repairs));
  const monthlyRent = Math.max(0, num(rawInputs.monthlyRent));
  const inputs = {
    address: String(rawInputs.address || "").trim(),
    askingPrice, arv, repairs, monthlyRent,
  };

  /* ---- Option A: cash (lowballoffer.ai fix & flip) ---- */
  // Deterministic jitter: theirs picks the multiplier at random from a table
  // spanning 89.479–90.2987 (i.e. base −0.52…+0.30) and appends random cents.
  const seed = hash32(`${inputs.address}|${askingPrice}|${arv}|${repairs}`);
  const pctWobble = s.precisionJitter ? (seed % 83) / 100 - 0.52 : 0;
  const cents = s.precisionJitter ? ((seed >>> 8) % 100) / 100 : 0;
  const pctUsed = s.cashPctOfArv + pctWobble;
  const repairAdj = repairsAdjustment(repairs, arv, s);
  const cashRaw = (pctUsed / 100) * arv - repairAdj - num(s.wholesaleFee);
  const cashAmount = cashRaw > 0 ? Math.floor(cashRaw) + cents : 0;
  const cash = {
    key: "cash",
    label: "Cash",
    amount: cashAmount,
    pctOfArv: s.cashPctOfArv,
    pctUsed: Math.round(pctUsed * 100) / 100,
    repairs,
    repairAdjustment: Math.round(repairAdj),
    wholesaleFee: num(s.wholesaleFee),
    closeDays: s.closeDays,
    pctOfAsking: askingPrice > 0 ? Math.round((Math.max(0, cashRaw) / askingPrice) * 100) : 0,
  };

  /* ---- Option B: seller finance (lowballoffer.ai creative) ---- */
  const sfPrice = roundTo(askingPrice * (s.sfPricePctOfAsking / 100), s.roundTo);
  const sfDown = roundTo(sfPrice * (s.sfDownPct / 100), s.roundTo);
  const sfPrincipal = sfPrice - sfDown;
  const sfMonths = Math.max(1, Math.round(s.sfTermYears * 12));
  const sfMonthly = monthlyPayment(sfPrincipal, s.sfAnnualRatePct, sfMonths);
  const balloonMonths = Math.round(num(s.sfBalloonYears) * 12);
  const hasBalloon = balloonMonths > 0 && balloonMonths < sfMonths;
  const sfBalloon = hasBalloon
    ? remainingBalance(sfPrincipal, s.sfAnnualRatePct, sfMonthly, balloonMonths)
    : 0;
  const paidMonths = hasBalloon ? balloonMonths : sfMonths;
  const sellerFinance = {
    key: "sellerFinance",
    label: "Seller Finance",
    price: sfPrice,
    down: sfDown,
    principal: sfPrincipal,
    annualRatePct: num(s.sfAnnualRatePct),
    termYears: s.sfTermYears,
    monthly: Math.round(sfMonthly),
    balloonYears: hasBalloon ? num(s.sfBalloonYears) : 0,
    balloon: hasBalloon ? roundTo(sfBalloon, s.roundTo) : 0,
    totalToSeller: Math.round(sfDown + sfMonthly * paidMonths + (hasBalloon ? sfBalloon : 0)),
  };

  /* ---- Option C: lease option (needs a rent number) ---- */
  let leaseOption = null;
  if (monthlyRent > 0) {
    const loPrice = roundTo(askingPrice * (s.loPricePctOfAsking / 100), s.roundTo);
    const loFee = roundTo(loPrice * (s.loOptionFeePct / 100), s.roundTo);
    leaseOption = {
      key: "leaseOption",
      label: "Lease Option",
      price: loPrice,
      optionFee: loFee,
      monthly: Math.round(monthlyRent),
      termMonths: s.loTermMonths,
      rentCreditPct: s.loRentCreditPct,
      monthlyCredit: Math.round(monthlyRent * (s.loRentCreditPct / 100)),
    };
  }

  return { inputs, settings: s, offers: { cash, sellerFinance, leaseOption } };
}
