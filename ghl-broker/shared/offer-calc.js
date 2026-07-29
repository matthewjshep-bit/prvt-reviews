// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// offer-calc.js — the cash-offer calculation engine, shared by the broker
// (document generation + persistence) and the frontend (live preview as the
// user types). Pure functions, no I/O, no deps.
//
// The model is reverse engineered from lowballoffer.ai's shipped bundle
// (app/page-*.js, decoded 2026-07-26) — their "fix & flip" cash offer:
//
//   base    = ~90% of ARV  (they randomize among 90.0147/90.2987/89.661/89.479)
//   minus   repairs adjustment (piecewise, continuous):
//             repairs < $30k          → repairs + $30,000
//             $30k…10% of ARV         → 2 × repairs
//             above 10% of ARV        → 2×(10% ARV) + 1.5×(excess)
//   minus   flat $30,000 assignment-fee spread
//   (plus random cents for fake precision; their "MAO" readout is offer+$20k)
//
// We keep the same math but make the "authentic-looking" randomness
// DETERMINISTIC: a hash of the inputs picks the ARV multiplier wobble and the
// cents, so the same property always yields the same offer.
//
// All percentage settings are whole numbers (90 = 90%). Money in dollars.

// How the cash number is underwritten. "lowball" is the reverse-engineered
// lowballoffer.ai model below; "mao" is the classic flipper 70% rule:
// maoPctOfArv% of ARV minus repairs, no fee, no jitter.
export const UNDERWRITE_MODES = [
  { key: "lowball", label: "90% ARV − 2× rehab", hint: "aggressive spread + fee" },
  { key: "mao", label: "70% ARV − rehab", hint: "classic 70% rule, minus your fee/spread" },
];

export const DEFAULT_OFFER_SETTINGS = {
  underwriteMode: "lowball", // "lowball" (below) | "mao" (maoPctOfArv·ARV − repairs)
  maoPctOfArv: 70,           // % of ARV for the "mao" mode
  cashPctOfArv: 90,          // base % of ARV before deductions
  repairBuffer: 30000,       // small-repair floor: repairs < buffer → repairs + buffer
  repairHeavyPctOfArv: 10,   // repairs above this % of ARV are "heavy"
  repairBaseMult: 2,         // multiplier on repairs in the normal band
  repairHeavyMult: 1.5,      // multiplier on the portion above the heavy threshold
  wholesaleFee: 30000,       // flat assignment-fee spread subtracted at the end
  precisionJitter: true,     // deterministic ±0.5pp ARV wobble + cents (lowball anchoring)
  // Presentation
  closeDays: 14,             // advertised days-to-close
  validityDays: 7,           // offer expiry window printed on the document
  earnestMoney: 2500,        // earnest-money deposit named in the letter
  // "Tentative terms" lines printed on the letter. termClosing "" → built
  // from closeDays ("On or before N days from acceptance — or a date of your
  // choosing"). All overridable per offer from the New Offer page.
  termFinancing: "None — funded with cash",
  termClosing: "",
  termCondition: "Purchased strictly as-is; no repairs or clean-out required",
  termPossession: "At closing, or flexible if you need additional time",
  compsApiKey: "",           // enables the comps map + MLS photos (realestateapi.com API key)
  aiApiKey: "",              // enables the AI rehab photo scan (Anthropic API key)
  apifyToken: "",            // Zillow listing photos via Apify (zillow-detail-scraper)
  // Printed on the offer document letterhead
  company: { name: "", tagline: "", signer: "", phone: "", email: "" },
};

const num = (v, fallback = 0) => {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

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

// inputs: { address, arv, repairs?, askingPrice? } — the offer is driven by
// ARV + repairs; asking price is optional context (defaults ARV when ARV is
// blank, and powers the "% of asking" readout).
// Returns { inputs, settings, offers: { cash } }.
// Throws { message, http:400 } on unusable inputs.
export function calculateOffers(rawInputs = {}, settingsOverride = {}) {
  const s = effectiveSettings(settingsOverride);

  const askingPrice = Math.max(0, num(rawInputs.askingPrice));
  const arv = num(rawInputs.arv) > 0 ? num(rawInputs.arv) : askingPrice;
  if (arv <= 0) {
    throw Object.assign(new Error("arv (or askingPrice) must be a positive number"), { http: 400 });
  }
  const repairs = Math.max(0, num(rawInputs.repairs));
  // Manual final-price override: when set, it replaces the modeled amount on
  // the letter (the breakdown still shows the model that anchored it).
  const priceOverride = Math.max(0, num(rawInputs.priceOverride));
  const inputs = {
    address: String(rawInputs.address || "").trim(),
    askingPrice, arv, repairs, priceOverride,
  };

  let cash;
  if (s.underwriteMode === "mao") {
    // Classic 70% rule: maoPctOfArv% of ARV minus repairs at face value,
    // minus the fee/spread. No jitter — a clean underwriting number.
    const base = (num(s.maoPctOfArv, 70) / 100) * arv;
    const cashRaw = base - repairs - num(s.wholesaleFee);
    cash = {
      key: "cash",
      label: "Cash",
      mode: "mao",
      amount: cashRaw > 0 ? Math.round(cashRaw) : 0,
      base: Math.round(base),
      pctOfArv: num(s.maoPctOfArv, 70),
      pctUsed: num(s.maoPctOfArv, 70),
      repairs,
      repairAdjustment: repairs,
      wholesaleFee: num(s.wholesaleFee),
      closeDays: s.closeDays,
      pctOfAsking: askingPrice > 0 ? Math.round((Math.max(0, cashRaw) / askingPrice) * 100) : null,
    };
  } else {
    // Deterministic jitter: theirs picks the multiplier at random from a table
    // spanning 89.479–90.2987 (i.e. base −0.52…+0.30) and appends random cents.
    const seed = hash32(`${inputs.address}|${askingPrice}|${arv}|${repairs}`);
    const pctWobble = s.precisionJitter ? (seed % 83) / 100 - 0.52 : 0;
    const cents = s.precisionJitter ? ((seed >>> 8) % 100) / 100 : 0;
    const pctUsed = s.cashPctOfArv + pctWobble;
    const base = (pctUsed / 100) * arv;
    const repairAdj = repairsAdjustment(repairs, arv, s);
    const cashRaw = base - repairAdj - num(s.wholesaleFee);
    cash = {
      key: "cash",
      label: "Cash",
      mode: "lowball",
      amount: cashRaw > 0 ? Math.floor(cashRaw) + cents : 0,
      base: Math.round(base),
      pctOfArv: s.cashPctOfArv,
      pctUsed: Math.round(pctUsed * 100) / 100,
      repairs,
      repairAdjustment: Math.round(repairAdj),
      wholesaleFee: num(s.wholesaleFee),
      closeDays: s.closeDays,
      pctOfAsking: askingPrice > 0 ? Math.round((Math.max(0, cashRaw) / askingPrice) * 100) : null,
    };
  }

  if (priceOverride > 0) {
    cash.systemAmount = cash.amount;
    cash.amount = priceOverride;
    cash.overridden = true;
    cash.pctOfAsking = askingPrice > 0 ? Math.round((priceOverride / askingPrice) * 100) : null;
  }

  return { inputs, settings: s, offers: { cash } };
}
