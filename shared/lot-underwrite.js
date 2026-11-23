// lot-underwrite.js — what an old house on a big lot is worth to a builder,
// and what we can pay its owner.
//
// The luxury teardown lane (Matt, 2026-11-23, from the "Lux Blueprint"
// method). In a high-end pocket the builders buy old houses on big lots, tear
// them down and build $3M–$8M homes. Lots are scarce, so a builder pays close
// to full value for one off-market. The seller would pay about 8% to list
// (two commissions plus closing). We offer the lot value less what the seller
// would have paid to sell, so they net the same as listing with no showings,
// and a builder takes the contract at about the lot value. The spread is the
// seller's avoided selling costs — $75k to $150k on a $1M–$2M lot.
//
//   lot value  = median sold price of teardown-type houses in the same band
//                (same pocket, lot in the band, built before the cutoff) —
//                a builder buys the envelope, so dollars per lot, not per sqft
//   offer      = lot value × (1 − the seller's selling costs)
//   assign at  ≈ lot value
//   spread     = assign at − offer − any agent fee
//
// Not ARV less rehab: no remodel of a 2,300 sqft house reaches the new-build
// price, so the house is worth nothing and the roof and furnace don't matter.
// Zillow's estimate undervalues these (it prices the house, not the land), so
// an offer can beat the Zestimate and still leave a spread.
//
// Washington: REET is the seller's in both cases (listing or selling to us),
// so it creates no spread. The selling costs here are commission plus the
// closing costs that aren't REET.
//
// Pure. The same result shape as the land engine ({ maxOffer, binding,
// tests }) so the editor and the server treat the hand-priced models alike.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const copy = (x) => JSON.parse(JSON.stringify(x));

export const DEFAULT_SELLING_COST_PCT = 0.08;
export const DEFAULT_MIN_SPREAD = 75000;
// A house this share of the new builds' size (or bigger) might be remodelled
// instead of torn down: the teardown test flags it.
export const TEARDOWN_HOUSE_RATIO = 0.6;

export const DEFAULT_LOT_DEAL = {
  kind: "lot",
  name: "",
  askingPrice: 0,          // what the seller wants, when they've said
  lotSqft: 0,              // the subject
  yearBuilt: 0,
  houseSqft: 0,
  // Sold teardown-type houses in the band: price is the one that matters.
  comps: [],               // [{ label, price, lotSqft, yearBuilt, houseSqft, soldAt }]
  // The builders' exits nearby: context for the teardown test and the pitch.
  newBuilds: [],           // [{ label, price, lotSqft, sqft, priorLotPrice, priorLotDate }]
  sellingCostPct: DEFAULT_SELLING_COST_PCT,  // what the seller avoids by not listing
  agentFeePct: 0,          // 0.025 when the builder comes through an agent, paid out of the spread
  minSpread: DEFAULT_MIN_SPREAD,
  // The screens a lot has to pass (the method's §1D): a main road or a corner
  // costs a builder's buyer privacy; a lot already on the MLS, with cuts, isn't
  // selling for a reason.
  screens: { arterial: false, corner: false, listed: false, priceCuts: 0 },
};

// The worked example from the method: Scottsdale 85254, ¾–1 acre lots, 1960s–70s
// houses, new builds at $4M–$5M. Figures as shown on screen.
export const SAMPLE_LOT_DEAL = {
  ...DEFAULT_LOT_DEAL,
  name: "Sample ¾-acre teardown (example figures)",
  askingPrice: 1250000,
  lotSqft: 34848,
  yearBuilt: 1966,
  houseSqft: 2300,
  comps: [
    { label: "Sold 2026, 0.8 ac, built 1971", price: 1050000, lotSqft: 34848, yearBuilt: 1971, houseSqft: 2100, soldAt: "2026-03" },
    { label: "Sold 2026, ¾ ac, built 1968", price: 1300000, lotSqft: 32670, yearBuilt: 1968, houseSqft: 2400, soldAt: "2026-05" },
    { label: "Sold 2026, just under 1 ac, built 1963", price: 1300000, lotSqft: 42000, yearBuilt: 1963, houseSqft: 1900, soldAt: "2026-06" },
    { label: "Sold 2026, 0.8 ac, built 1974", price: 1350000, lotSqft: 34848, yearBuilt: 1974, houseSqft: 2600, soldAt: "2026-08" },
    { label: "Sold 2026, 1 ac, built 1966", price: 1560000, lotSqft: 43560, yearBuilt: 1966, houseSqft: 2200, soldAt: "2026-09" },
  ],
  newBuilds: [
    { label: "New build, 1 ac", price: 4100000, lotSqft: 43560, sqft: 6000, priorLotPrice: 1200000, priorLotDate: "2024-06" },
    { label: "New build, ¾ ac", price: 5250000, lotSqft: 32670, sqft: 7200, priorLotPrice: 1175000, priorLotDate: "2023" },
    { label: "New build, ¾ ac", price: 4600000, lotSqft: 32670, sqft: 6500, priorLotPrice: 1100000, priorLotDate: "2023" },
    { label: "New build, 6,300 sqft", price: 4800000, lotSqft: 32670, sqft: 6300, priorLotPrice: 0, priorLotDate: "" },
  ],
};

export const blankLotDeal = () => copy(DEFAULT_LOT_DEAL);
export const sampleLotDeal = () => copy(SAMPLE_LOT_DEAL);

const str = (v, max) => String(v ?? "").trim().slice(0, max);

/** normalizeLotDeal(raw) → every field a finite number, the tables trimmed to real rows. */
export function normalizeLotDeal(raw = {}) {
  const d = DEFAULT_LOT_DEAL;
  const pick = (k) => (raw?.[k] === undefined || raw?.[k] === null || raw?.[k] === "" ? d[k] : num(raw[k]));
  const sc = raw?.screens || {};
  return {
    kind: "lot",
    name: str(raw?.name, 120),
    askingPrice: Math.max(0, pick("askingPrice")),
    lotSqft: Math.max(0, pick("lotSqft")),
    yearBuilt: Math.max(0, Math.round(pick("yearBuilt"))),
    houseSqft: Math.max(0, pick("houseSqft")),
    comps: (Array.isArray(raw?.comps) ? raw.comps : []).slice(0, 30).map((c) => ({
      label: str(c?.label, 80),
      price: Math.max(0, num(c?.price)),
      lotSqft: Math.max(0, num(c?.lotSqft)),
      yearBuilt: Math.max(0, Math.round(num(c?.yearBuilt))),
      houseSqft: Math.max(0, num(c?.houseSqft)),
      soldAt: str(c?.soldAt, 20),
    })),
    newBuilds: (Array.isArray(raw?.newBuilds) ? raw.newBuilds : []).slice(0, 30).map((b) => ({
      label: str(b?.label, 80),
      price: Math.max(0, num(b?.price)),
      lotSqft: Math.max(0, num(b?.lotSqft)),
      sqft: Math.max(0, num(b?.sqft)),
      priorLotPrice: Math.max(0, num(b?.priorLotPrice)),
      priorLotDate: str(b?.priorLotDate, 20),
    })),
    sellingCostPct: Math.min(0.5, Math.max(0, pick("sellingCostPct"))),
    agentFeePct: Math.min(0.2, Math.max(0, pick("agentFeePct"))),
    minSpread: Math.max(0, pick("minSpread")),
    screens: {
      arterial: Boolean(sc.arterial),
      corner: Boolean(sc.corner),
      listed: Boolean(sc.listed),
      priceCuts: Math.max(0, Math.round(num(sc.priceCuts))),
    },
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const usableComps = (d) => d.comps.filter((c) => c.price > 0);
const kText = (n) => `$${Math.round(n / 1000).toLocaleString("en-US")}k`;

/** validateLotDeal(deal) → plain-English problems; [] means it can be priced. */
export function validateLotDeal(d) {
  const out = [];
  const comps = usableComps(d);
  if (!comps.length) out.push("Add at least one sold teardown with its price.");
  if (!(d.sellingCostPct > 0)) out.push("The seller's selling costs have to be above 0% — that's where the spread comes from.");
  if (comps.length && d.sellingCostPct > 0) {
    const { spread } = spreadOf(d, comps);
    if (spread < d.minSpread) {
      out.push(`The spread is ${kText(spread)}, under your ${kText(d.minSpread)} minimum. Lower the minimum, or this lot isn't one for us.`);
    }
  }
  return out;
}

function spreadOf(d, comps) {
  const lotValue = median(comps.map((c) => c.price));
  const sellingCosts = lotValue * d.sellingCostPct;
  const maxOffer = Math.max(0, Math.floor(lotValue - sellingCosts));
  const agentFee = maxOffer * d.agentFeePct;
  const assignAt = Math.round(lotValue);
  const spread = assignAt - maxOffer - agentFee;
  return { lotValue, sellingCosts, maxOffer, agentFee, assignAt, spread };
}

/**
 * lotWarnings(deal) → [{ key, text }] — what a person should look at before
 * the offer goes out. None of these stops the pricing.
 *   teardown: the house is big enough, or new enough, that a remodel might
 *             compete with a rebuild — check it's really a teardown
 *   band:     the lot is outside the band the comps sold in
 *   road:     a main road or a corner — builders of $4M+ homes want privacy
 *   listed:   already on the MLS, with price cuts — find out why it isn't selling
 */
export function lotWarnings(d) {
  const out = [];
  const comps = usableComps(d);
  const builds = d.newBuilds.filter((b) => b.sqft > 0);
  if (d.houseSqft > 0 && builds.length) {
    const typical = median(builds.map((b) => b.sqft));
    if (typical > 0 && d.houseSqft >= typical * TEARDOWN_HOUSE_RATIO) {
      out.push({ key: "teardown", text: `the house is ${Math.round(d.houseSqft).toLocaleString("en-US")} sqft against new builds around ${Math.round(typical).toLocaleString("en-US")} — a remodel might compete, so check it's really a teardown` });
    }
  }
  const years = comps.map((c) => c.yearBuilt).filter((y) => y > 0);
  if (d.yearBuilt > 0 && years.length && d.yearBuilt > Math.max(...years)) {
    out.push({ key: "teardown", text: `built ${d.yearBuilt}, newer than every teardown that sold here (latest ${Math.max(...years)})` });
  }
  const lots = comps.map((c) => c.lotSqft).filter((l) => l > 0);
  if (d.lotSqft > 0 && lots.length) {
    const lo = Math.min(...lots) * 0.9;
    const hi = Math.max(...lots) * 1.1;
    if (d.lotSqft < lo || d.lotSqft > hi) {
      out.push({ key: "band", text: `the lot is ${Math.round(d.lotSqft).toLocaleString("en-US")} sqft; the comps sold between ${Math.round(Math.min(...lots)).toLocaleString("en-US")} and ${Math.round(Math.max(...lots)).toLocaleString("en-US")}` });
    }
  }
  if (d.screens.arterial || d.screens.corner) {
    const where = d.screens.arterial && d.screens.corner ? "on a main road, at a corner" : d.screens.arterial ? "on a main road" : "at a corner";
    out.push({ key: "road", text: `${where} — builders of $4M+ homes want an interior lot with privacy and no road noise; the same lot inside the neighborhood sells for more` });
  }
  if (d.screens.listed) {
    const cuts = d.screens.priceCuts;
    out.push({ key: "listed", text: cuts > 0 ? `already on the MLS with ${cuts} price cut${cuts === 1 ? "" : "s"} — find out why it isn't selling before you price it` : "already on the MLS — a listed lot has builders looking at it already" });
  }
  return out;
}

/**
 * underwriteLot(raw) → { ok, errors, deal, result }
 *
 * result: { maxOffer, binding: "offer", value, lotValue, sellingCosts, assignAt,
 *           agentFee, spread, comps, warnings, tests: [{ key, label, price, binding, info }] }
 * `value` is the lot value, under the name the land engine uses, so the shared
 * calc builder reads both the same way.
 */
export function underwriteLot(raw) {
  const deal = normalizeLotDeal(raw);
  const errors = validateLotDeal(deal);
  if (errors.length) return { ok: false, errors, deal };
  const comps = usableComps(deal);
  const { lotValue, sellingCosts, maxOffer, agentFee, assignAt, spread } = spreadOf(deal, comps);
  const pct = Math.round(deal.sellingCostPct * 1000) / 10;
  return {
    ok: true, errors: [], deal,
    result: {
      maxOffer, binding: "offer", value: lotValue, lotValue, sellingCosts, assignAt, agentFee: Math.round(agentFee), spread: Math.round(spread),
      comps: comps.length, warnings: lotWarnings(deal),
      tests: [
        { key: "offer", label: `Lot value less the seller's ${pct}% selling costs`, price: maxOffer, binding: true },
        { key: "assign", label: "Lot value (what a builder pays)", price: assignAt, binding: false, info: true },
      ],
    },
  };
}
