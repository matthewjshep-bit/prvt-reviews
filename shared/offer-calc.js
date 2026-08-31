// offer-calc.js — the cash-offer calculation engine, shared by the broker
// (document generation + persistence) and the frontend (live preview as the
// user types). Pure functions, no I/O, no deps.
//
// Four underwriting models (see UNDERWRITE_MODES), picked per offer:
//
//   backstack (default) — the real underwrite. Subtract every cost a flipper
//     carries from the ARV: selling costs, their profit, repairs at face
//     value, holding, and our assignment fee. This is the one you can defend
//     line by line to a seller's agent.
//   lowball  — the aggressive anchor, documented below.
//   mao      — the classic 70% rule, minus the fee.
//   blended  — the mean of the three above. The models disagree by design
//     (one defends, one anchors, one is a rule of thumb); averaging them is
//     the number to lead with when you don't want to commit to one lens.
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
// maoPctOfArv% of ARV minus repairs, minus the fee, no jitter. "blended" is
// the mean of those three.
export const UNDERWRITE_MODES = [
  { key: "backstack", label: "Back-stack from ARV", hint: "ARV − selling costs − flip profit − repairs − holding − your fee" },
  { key: "lowball", label: "90% ARV − 2× rehab", hint: "aggressive spread + fee" },
  { key: "mao", label: "70% ARV − rehab", hint: "classic 70% rule, minus your fee/spread" },
  { key: "blended", label: "Blended", hint: "the average of the three models above" },
];

// What "blended" averages, and the short labels its card lists them under.
const BLEND_MODES = ["backstack", "lowball", "mao"];
const MODE_LABELS = Object.fromEntries(UNDERWRITE_MODES.map((m) => [m.key, m.label]));

export const DEFAULT_OFFER_SETTINGS = {
  underwriteMode: "backstack", // "backstack" | "lowball" | "mao" — see UNDERWRITE_MODES
  // Back-stack model. The full cost stack a flipper carries between buying the
  // house and banking the profit, subtracted from the ARV:
  //   MAO = ARV − selling costs − flip profit − repairs − holding − assignment fee
  sellingCostPct: 7,         // 3% listing + 3% buyer agent + ~1% closing (his 6–7%)
  flipProfitPct: 13,         // the flipper's margin on ARV (12–15% band, mid)
  holdMonths: 5,             // months carried from purchase to resale
  // Holding costs — see estimateHolding(). "scaled" (default) sizes the carry
  // off the deal itself; "flat" is the old holdMonths × holdMonthlyCost.
  holdingModel: "scaled",    // "scaled" | "flat"
  holdMonthlyCost: 1200,     // "flat" model only: all-in carry per month
  loanToCostPct: 85,         // hard money lends this % of (purchase + rehab)
  loanRatePct: 11,           // annual interest on that loan, interest-only
  loanPointsPct: 2,          // origination points, charged once on the loan
  taxRatePct: 1.1,           // annual property tax, % of ARV
  insuranceRatePct: 0.5,     // annual vacant/builder's-risk insurance, % of ARV
  utilitiesMonthly: 250,     // power, water, lawn, snow, minor upkeep — per month
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
  // Enables "paste a Google Drive folder" in the dataroom photo importer.
  // A plain API key (not OAuth) is enough because the folders it reads are
  // link-shared; it is only ever used to LIST a folder, never to download.
  // See ghl-broker/drive-folder.js.
  googleApiKey: "",
  outreachZips: "",          // default pull market: comma-separated zips (wins over city/state)
  outreachCity: "",
  outreachState: "",
  outreachDaysOld: 180,      // only pull listings listed/updated in the last N days
  // Auto-underwrite (an inbound agent text -> a full offer). The broker also
  // needs AUTO_UNDERWRITE_ENABLED=true before anything is published; this is
  // the spend ceiling, because each run costs Apify credits and two Claude
  // vision calls. See ghl-broker/auto-underwrite.js.
  autoUnderwriteDailyCap: 25,
  // Where closed sales come from. "zillow" scrapes the sold map through Apify
  // (the book the operator already reads by eye, and it carries the $/sqft
  // spread the price proxy below needs); "realestateapi" uses county + MLS
  // records. Zillow needs only the Apify token; RealEstateAPI needs its key.
  compsSource: "zillow",
  // How a comp's renovation condition is decided. "price" takes the top of the
  // $/sqft spread inside an already-tight comp set as a stand-in for renovated
  // — free and instant. "ai" reads each comp's sold listing photos, which is
  // more accurate and costs a scrape plus a vision call per comp.
  compsCondition: "price",
  // Printed on the offer document letterhead. The brand* fields additionally
  // drive the header on every investor-facing dataroom page — see brandFrom()
  // in ghl-broker/dataroom.js, which validates the colors as hex and falls back
  // to the design-system defaults (#0F172A / #2563EB) when they are blank.
  company: {
    name: "", tagline: "", signer: "", phone: "", email: "",
    wordmark: "", brandPrimary: "", brandAccent: "", brandLinks: [], logoUrl: "",
  },
  // Standing defaults for the Purchase & Sale Agreement (the seller-facing
  // "official offer"). These are the fields that are the same on every offer —
  // the per-deal blanks live on the offer itself. The two exhibit URLs point at
  // the earnest money check copy and the lender proof-of-funds letter; when one
  // is blank the PDF drops both the page AND the reference to it, so an offer
  // never cites an exhibit that isn't in the envelope.
  psa: {
    buyerEntity: "",
    buyerEntityState: "Washington",
    titleCompany: "", titleOfficer: "", titlePhone: "",
    lenderName: "",
    feasibilityDays: 10,
    closingDays: 21,
    counterDays: 5,
    emdCheckUrl: "", proofOfFundsUrl: "",
    // Pre-apply the buyer's signature to every agreement, so ten offers a day
    // don't mean ten signatures a day. OFF by default and deliberately so:
    // turning it on means a binding offer leaves the building already signed,
    // which is the operator's call to make once, in Settings, not a default
    // that arrives with a deploy. Only ever applied to the BUYER line.
    autoSign: false,
    signatureName: "",       // blank falls back to company.signer
    signatureCapacity: "Manager",
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

// Holding costs, estimated from the size of the deal rather than guessed flat.
//
// A single $/month figure cannot be right across a $150k rural cosmetic and a
// $700k gut: the loan carry alone moves by an order of magnitude, and it is by
// far the largest line. So the default model derives every leg from numbers the
// offer already has — no new per-deal data entry:
//
//   loan      = loanToCostPct% × (purchase price + repairs)  — hard-money LTC
//   points    = loanPointsPct% × loan                        — charged once
//   interest  = loan × loanRatePct% ÷ 12                     — per month, IO
//   taxes     = ARV × taxRatePct% ÷ 12                       — per month
//   insurance = ARV × insuranceRatePct% ÷ 12                 — vacant policy
//   utilities = utilitiesMonthly                             — the flat rump
//
//   holding   = points + holdMonths × (interest + taxes + insurance + utilities)
//
// Per deal you move holdMonths and everything else follows. Set loanToCostPct
// to 0 for an all-cash buyer and the two loan legs drop out. holdingModel:
// "flat" restores the old holdMonths × holdMonthlyCost behaviour verbatim.
//
// basis: { purchase, repairs, arv } — purchase is what the FLIPPER pays, i.e.
// our contract price plus the assignment fee, because that's what they borrow
// against. Returns whole-dollar-ish floats; the caller rounds.
export function estimateHolding(basis = {}, settingsOverride = {}) {
  const s = effectiveSettings(settingsOverride);
  const months = Math.max(0, num(s.holdMonths, 5));
  const arv = Math.max(0, num(basis.arv));

  if (s.holdingModel === "flat") {
    const monthly = Math.max(0, num(s.holdMonthlyCost, 1200));
    return {
      model: "flat", months, monthly, total: months * monthly,
      loanAmount: 0, points: 0, interest: 0, taxes: 0, insurance: 0, utilities: monthly,
    };
  }

  const cost = Math.max(0, num(basis.purchase)) + Math.max(0, num(basis.repairs));
  const loanAmount = (Math.max(0, num(s.loanToCostPct, 85)) / 100) * cost;
  const points = (Math.max(0, num(s.loanPointsPct, 2)) / 100) * loanAmount;
  const interest = (loanAmount * Math.max(0, num(s.loanRatePct, 11))) / 100 / 12;
  const taxes = (arv * Math.max(0, num(s.taxRatePct, 1.1))) / 100 / 12;
  const insurance = (arv * Math.max(0, num(s.insuranceRatePct, 0.5))) / 100 / 12;
  const utilities = Math.max(0, num(s.utilitiesMonthly, 250));
  const monthly = interest + taxes + insurance + utilities;
  return {
    model: "scaled", months, monthly, loanAmount, points,
    interest, taxes, insurance, utilities,
    total: points + months * monthly,
  };
}

// The label the holding row carries on the offer stack — the model's own
// arithmetic, short enough to sit in a table cell.
function holdingLabel(d) {
  if (d.model === "flat") return `Holding (${d.months} × ${fmtMoney(Math.round(d.monthly))})`;
  const pts = d.points > 0 ? ` + ${fmtMoney(Math.round(d.points))} pts` : "";
  return `Holding (${d.months} mo × ${fmtMoney(Math.round(d.monthly))}${pts})`;
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
  // The nested blobs need their own merge — a saved partial would otherwise
  // replace the defaults wholesale and blank out keys it never mentioned.
  s.company = { ...DEFAULT_OFFER_SETTINGS.company, ...((overrides || {}).company || {}) };
  s.psa = { ...DEFAULT_OFFER_SETTINGS.psa, ...((overrides || {}).psa || {}) };
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
    const wholesaleFee = num(s.wholesaleFee);

    const sellingCosts = (sellingCostPct / 100) * arv;
    const flipProfit = (flipProfitPct / 100) * arv;

    // Holding and price are mutually dependent: the loan is sized off the
    // purchase price, and the purchase price is what the stack solves for. So
    // iterate to a fixed point. The feedback factor is the LTC times the
    // holding rate — around 6% — so it settles below a cent within a few
    // passes; eight is free and leaves headroom for aggressive settings.
    let hold = estimateHolding({ arv, repairs, purchase: 0 }, s);
    for (let i = 0; i < 8; i++) {
      const purchase = Math.max(0, arv - sellingCosts - flipProfit - repairs - hold.total);
      hold = estimateHolding({ arv, repairs, purchase }, s);
    }
    const holding = hold.total;
    const holdMonthlyCost = hold.monthly;
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
      sellingCostPct, flipProfitPct, holdMonths,
      // The EFFECTIVE monthly carry, derived under the scaled model rather
      // than read back off the setting — anything rendering this should show
      // what the deal actually costs to hold.
      holdMonthlyCost: Math.round(holdMonthlyCost),
      sellingCosts: Math.round(sellingCosts),
      flipProfit: Math.round(flipProfit),
      holding: Math.round(holding),
      // Every leg of the carry, for the tooltip / any future line-by-line view.
      holdingDetail: {
        model: hold.model,
        months: hold.months,
        monthly: Math.round(hold.monthly),
        loanAmount: Math.round(hold.loanAmount),
        points: Math.round(hold.points),
        interest: Math.round(hold.interest),
        taxes: Math.round(hold.taxes),
        insurance: Math.round(hold.insurance),
        utilities: Math.round(hold.utilities),
      },
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
        { key: "holding", label: holdingLabel(hold), amount: Math.round(holding), sign: "−" },
        { key: "fee", label: "Assignment fee", amount: Math.round(wholesaleFee), sign: "−" },
      ],
      pctOfAsking: askingPrice > 0 ? Math.round((Math.max(0, cashRaw) / askingPrice) * 100) : null,
    };
  } else if (s.underwriteMode === "blended") {
    // The mean of the other three. They disagree on purpose — the back-stack
    // defends, the lowball anchors, the 70% rule is a sanity check — so the
    // average is the number to lead with when you don't want to argue any one
    // lens. Each component is computed WITHOUT the manual price override
    // (that's applied once, to the blend) but with every other setting the
    // user has in play, so the fee and the carry assumptions carry through.
    const parts = BLEND_MODES.map((mode) => {
      const one = calculateOffers({ ...rawInputs, priceOverride: 0 }, { ...s, underwriteMode: mode });
      return { key: mode, label: MODE_LABELS[mode] || mode, amount: Math.round(num(one.offers.cash.amount)) };
    });
    const cashRaw = parts.reduce((t, p) => t + p.amount, 0) / parts.length;
    cash = {
      key: "cash",
      label: "Cash",
      mode: "blended",
      amount: cashRaw > 0 ? Math.round(cashRaw) : 0,
      base: Math.round(arv),
      pctOfArv: Math.round((Math.max(0, cashRaw) / arv) * 10000) / 100,
      pctUsed: Math.round((Math.max(0, cashRaw) / arv) * 10000) / 100,
      repairs,
      repairAdjustment: repairs,
      wholesaleFee: num(s.wholesaleFee),
      // The three numbers being averaged, for the card. Each is already net of
      // the fee, so the blend is too — there is no fee row left to subtract.
      components: parts,
      // Only underwater when there is genuinely nothing to offer. One zero
      // component among three simply drags the average down.
      underwater: cashRaw <= 0,
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
