// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// offer-calc.js — the cash-offer calculation engine, shared by the broker
// (document generation + persistence) and the frontend (live preview as the
// user types). Pure functions, no I/O, no deps.
//
// Three underwriting models (see UNDERWRITE_MODES), picked per offer:
//
//   backstack (default) — the real underwrite. Subtract every cost a flipper
//     carries from the ARV: selling costs, their profit, repairs at face
//     value, holding, and our assignment fee. This is the one you can defend
//     line by line to a seller's agent.
//   lowball  — the aggressive anchor, documented below.
//   mao      — the classic 70% rule, minus the fee.
//
// The lowball model is reverse engineered from lowballoffer.ai's shipped bundle
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

// How the cash number is underwritten.
// "backstack" is the real underwrite (default): every cost a flipper actually
// carries, stacked backwards off the ARV. "lowball" is the reverse-engineered
// lowballoffer.ai model below; "mao" is the classic flipper 70% rule:
// maoPctOfArv% of ARV minus repairs, minus the fee, no jitter.
export const UNDERWRITE_MODES = [
  { key: "backstack", label: "Back-stack from ARV", hint: "ARV − selling costs − flip profit − repairs − holding − your fee" },
  { key: "lowball", label: "90% ARV − 2× rehab", hint: "aggressive spread + fee" },
  { key: "mao", label: "70% ARV − rehab", hint: "classic 70% rule, minus your fee/spread" },
];

export const DEFAULT_OFFER_SETTINGS = {
  underwriteMode: "backstack", // "backstack" | "lowball" | "mao" — see UNDERWRITE_MODES
  // Back-stack model. The full cost stack a flipper carries between buying the
  // house and banking the profit, subtracted from the ARV:
  //   MAO = ARV − selling costs − flip profit − repairs − holding − assignment fee
  sellingCostPct: 7,         // 3% listing + 3% buyer agent + ~1% closing (his 6–7%)
  flipProfitPct: 13,         // the flipper's margin on ARV (12–15% band, mid)
  holdMonths: 5,             // months carried from purchase to resale
  holdMonthlyCost: 1200,     // taxes + insurance + utilities + loan carry, per month
  maoPctOfArv: 70,           // % of ARV for the "mao" mode
  cashPctOfArv: 90,          // base % of ARV before deductions
  repairBuffer: 30000,       // small-repair floor: repairs < buffer → repairs + buffer
  repairHeavyPctOfArv: 10,   // repairs above this % of ARV are "heavy"
  repairBaseMult: 2,         // multiplier on repairs in the normal band
  repairHeavyMult: 1.5,      // multiplier on the portion above the heavy threshold
  wholesaleFee: 30000,       // flat assignment-fee spread subtracted at the end
  precisionJitter: true,     // deterministic ±0.5pp ARV wobble + cents (lowball anchoring)
  // Presentation
  validityDays: 7,           // default offer-expiry window: seeds the per-offer
                             // "Offer expires" date picker (offerExpires, a
                             // yyyy-mm-dd override that rides along per offer)
  earnestMoney: 2500,        // earnest-money deposit named in the letter
  sellerAgentPct: 3,         // listing-side commission % (seller net comparison)
  buyerAgentPct: 3,          // buyer-side commission % a traditional sale would add
  // "Tentative terms" lines printed on the letter. All overridable per offer
  // from the New Offer page.
  termFinancing: "Funded with cash or private loan",
  termClosing: "",
  termCondition: "Purchased strictly as-is; no repairs or clean-out required",
  termPossession: "At closing, or flexible if you need additional time",
  // Saved letter-terms template: [{label, value}] rows every new offer seeds
  // from ("Save as default template" on the New Offer page). null → the
  // classic five rows built from the term* strings above.
  letterTermsTemplate: null,
  // Saved Purchase & Sale contract clause template: [{id, title, body}] rows
  // edited in Settings. null → DEFAULT_CONTRACT_CLAUSES in contract-template.js.
  contractTemplate: null,
  // Saved Assignment of Contract clause template (dispositions/buyer-facing).
  // null → DEFAULT_ASSIGNMENT_CLAUSES in contract-template.js.
  assignmentTemplate: null,
  // GHL tags counted on the Dashboard page's tag panel (editable inline there).
  dashboardTags: ["offer-created", "agent-outreach"],
  compsApiKey: "",           // enables the comps map + MLS photos (realestateapi.com API key)
  aiApiKey: "",              // enables the AI rehab photo scan (Anthropic API key)
  apifyToken: "",            // Zillow listing photos via Apify (zillow-detail-scraper)
  // Credential for the Zillow comp-capture bookmarklet. Minted server-side by
  // POST /api/offers/comps/capture-token; scoped to appending to the comp
  // inbox and nothing else, because it lives in a browser bookmark. Rotating
  // it kills every bookmarklet built from the old value.
  captureToken: "",
  rentcastApiKey: "",        // enables the Agent Outreach page (rentcast.io API key)
  outreachZips: "",          // default pull market: comma-separated zips (wins over city/state)
  outreachCity: "",
  outreachState: "",
  outreachDaysOld: 180,      // only pull listings listed/updated in the last N days
  // Printed on the offer document letterhead. The brand* fields additionally
  // drive the header on every investor-facing dataroom page — see brandFrom()
  // in ghl-broker/dataroom.js, which validates the colors as hex and falls back
  // to the design-system defaults (#0F172A / #2563EB) when they are blank.
  company: {
    name: "", tagline: "", signer: "", phone: "", email: "",
    wordmark: "", brandPrimary: "", brandAccent: "", brandLinks: [],
  },
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

// Seller net comparison — the "no buyer's commission" pitch, net-to-net.
// Side A: our cash offer, seller pays only the listing side → netA.
// Side B: the list price a traditional sale (paying both sides) needs to
// gross so the seller nets that same amount: netA / (1 − (s+b)/100).
// Returns null when the offer is non-positive or commissions eat the price.
export function netComparison(cashAmount, s = {}) {
  const offer = num(cashAmount);
  const sellerPct = Math.max(0, num(s.sellerAgentPct, 3));
  const buyerPct = Math.max(0, num(s.buyerAgentPct, 3));
  const totalPct = sellerPct + buyerPct;
  if (offer <= 0 || totalPct >= 100) return null;
  const sellerCommissionA = (sellerPct / 100) * offer;
  const netA = offer - sellerCommissionA;
  const listPrice = netA / (1 - totalPct / 100);
  return {
    offer,
    sellerPct,
    buyerPct,
    sellerCommissionA,
    netA,
    listPrice,
    sellerCommissionB: (sellerPct / 100) * listPrice,
    buyerCommissionB: (buyerPct / 100) * listPrice,
  };
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
  if (s.underwriteMode === "backstack") {
    // The real underwrite: stack every cost backwards off the ARV.
    //   ARV − selling costs − flip profit − repairs − holding − assignment fee
    // Repairs enter at FACE VALUE here — repairsAdjustment()'s 2× multiplier is
    // a negotiation anchor for the lowball model, and applying it on top of an
    // explicit profit margin would double-count the same cushion.
    // No jitter either: this is a number you have to be able to defend.
    const sellingCostPct = Math.max(0, num(s.sellingCostPct, 7));
    const flipProfitPct = Math.max(0, num(s.flipProfitPct, 13));
    const holdMonths = Math.max(0, num(s.holdMonths, 5));
    const holdMonthlyCost = Math.max(0, num(s.holdMonthlyCost, 1200));
    const wholesaleFee = num(s.wholesaleFee);

    const sellingCosts = (sellingCostPct / 100) * arv;
    const flipProfit = (flipProfitPct / 100) * arv;
    const holding = holdMonths * holdMonthlyCost;
    const cashRaw = arv - sellingCosts - flipProfit - repairs - holding - wholesaleFee;

    cash = {
      key: "cash",
      label: "Cash",
      mode: "backstack",
      amount: cashRaw > 0 ? Math.round(cashRaw) : 0,
      // The share of ARV left after the two percentage costs — the "~80% line"
      // this model lands on before repairs, holding and the fee come out.
      base: Math.round(arv),
      pctOfArv: Math.round((100 - sellingCostPct - flipProfitPct) * 100) / 100,
      pctUsed: Math.round((100 - sellingCostPct - flipProfitPct) * 100) / 100,
      repairs,
      repairAdjustment: repairs,
      sellingCostPct, flipProfitPct, holdMonths, holdMonthlyCost,
      sellingCosts: Math.round(sellingCosts),
      flipProfit: Math.round(flipProfit),
      holding: Math.round(holding),
      wholesaleFee,
      // A negative stack means repairs + profit exceed the ARV. The amount
      // clamps to 0 like the other modes, but that reads as a bug unless the
      // UI can say why — so flag it rather than silently showing $0.
      underwater: cashRaw <= 0,
      // Generic rows so the card (and any future doc) can render the stack
      // without knowing the model.
      breakdown: [
        { key: "arv", label: "ARV", amount: Math.round(arv), sign: "+" },
        { key: "selling", label: `Selling costs (${sellingCostPct}%)`, amount: Math.round(sellingCosts), sign: "−" },
        { key: "profit", label: `Flip profit (${flipProfitPct}%)`, amount: Math.round(flipProfit), sign: "−" },
        { key: "repairs", label: "Repairs", amount: Math.round(repairs), sign: "−" },
        { key: "holding", label: `Holding (${holdMonths} × ${fmtMoney(holdMonthlyCost)})`, amount: Math.round(holding), sign: "−" },
        { key: "fee", label: "Assignment fee", amount: Math.round(wholesaleFee), sign: "−" },
      ],
      pctOfAsking: askingPrice > 0 ? Math.round((Math.max(0, cashRaw) / askingPrice) * 100) : null,
    };
  } else if (s.underwriteMode === "mao") {
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
