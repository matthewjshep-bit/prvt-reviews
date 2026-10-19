// land-underwrite.js — what a piece of land is worth to us.
//
// Land has no rent and no rehab, so neither the flip back-stack (offer-calc.js)
// nor the income approach (income-underwrite.js) fits. Matt, 2026-10-18: a
// simple analyzer — what nearby land sold for per acre (or per lot), less
// what it costs to make the site buildable, at a share of value we choose.
//
//   value     = median comp $/acre (or $/lot) × the subject's acres (or lots)
//   max offer = value × offer % − site costs − closing
//
// Pure. The same result shape as the income engine ({ maxOffer, binding,
// tests }) so the editor and the server treat both alike.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const copy = (x) => JSON.parse(JSON.stringify(x));

export const LAND_BASIS = ["acre", "lot"];

export const DEFAULT_LAND_DEAL = {
  kind: "land",
  name: "",
  askingPrice: 0,
  basis: "acre",        // price comps per acre or per lot
  size: 0,              // the subject's acres (or lots)
  comps: [],            // [{ label, price, size }] — size in the same basis
  siteCosts: { clearing: 0, utilities: 0, permits: 0, other: 0 },
  offerPct: 0.6,        // share of value we pay before site costs
  closingPct: 0.02,
};

export const SAMPLE_LAND_DEAL = {
  ...DEFAULT_LAND_DEAL,
  name: "Sample 2.5-acre parcel (example figures)",
  askingPrice: 325000,
  basis: "acre",
  size: 2.5,
  comps: [
    { label: "Sold 3/2026, 2.1 ac", price: 260000, size: 2.1 },
    { label: "Sold 6/2026, 3.0 ac", price: 345000, size: 3.0 },
    { label: "Sold 8/2026, 1.8 ac", price: 238000, size: 1.8 },
  ],
  siteCosts: { clearing: 15000, utilities: 30000, permits: 8000, other: 0 },
};

export const blankLandDeal = () => copy(DEFAULT_LAND_DEAL);
export const sampleLandDeal = () => copy(SAMPLE_LAND_DEAL);

/** normalizeLandDeal(raw) → every field a finite number, comps trimmed to real rows. */
export function normalizeLandDeal(raw = {}) {
  const d = DEFAULT_LAND_DEAL;
  const sc = raw?.siteCosts || {};
  const pick = (k) => (raw?.[k] === undefined || raw?.[k] === null || raw?.[k] === "" ? d[k] : num(raw[k]));
  return {
    kind: "land",
    name: String(raw?.name ?? "").slice(0, 120),
    askingPrice: Math.max(0, pick("askingPrice")),
    basis: LAND_BASIS.includes(raw?.basis) ? raw.basis : "acre",
    size: Math.max(0, pick("size")),
    comps: (Array.isArray(raw?.comps) ? raw.comps : []).slice(0, 30).map((c) => ({
      label: String(c?.label || "").slice(0, 80),
      price: Math.max(0, num(c?.price)),
      size: Math.max(0, num(c?.size)),
    })),
    siteCosts: {
      clearing: Math.max(0, num(sc.clearing)),
      utilities: Math.max(0, num(sc.utilities)),
      permits: Math.max(0, num(sc.permits)),
      other: Math.max(0, num(sc.other)),
    },
    offerPct: Math.min(1, Math.max(0, pick("offerPct"))),
    closingPct: Math.max(0, pick("closingPct")),
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** validateLandDeal(deal) → plain-English problems; [] means it can be priced. */
export function validateLandDeal(d) {
  const out = [];
  const unit = d.basis === "lot" ? "lots" : "acres";
  if (!(num(d.size) > 0)) out.push(`Enter how many ${unit} the property is.`);
  if (!d.comps.some((c) => c.price > 0 && c.size > 0)) out.push(`Add at least one sold comp with its price and ${unit}.`);
  if (!(num(d.askingPrice) > 0)) out.push("Enter the asking price.");
  if (!(num(d.offerPct) > 0)) out.push("Offer % of value has to be above 0%.");
  return out;
}

/**
 * underwriteLand(raw) → { ok, errors, deal, result }
 *
 * result: { maxOffer, binding: "value", perUnit, value, siteTotal, closing,
 *           tests: [{ key, label, price, binding }] }
 */
export function underwriteLand(raw) {
  const deal = normalizeLandDeal(raw);
  const errors = validateLandDeal(deal);
  if (errors.length) return { ok: false, errors, deal };
  const usable = deal.comps.filter((c) => c.price > 0 && c.size > 0);
  const perUnit = median(usable.map((c) => c.price / c.size));
  const value = perUnit * deal.size;
  const siteTotal = Object.values(deal.siteCosts).reduce((s, v) => s + v, 0);
  // Closing is paid on the price, so solve P = value × pct − site − P × closing.
  const raw0 = (value * deal.offerPct - siteTotal) / (1 + deal.closingPct);
  const maxOffer = Math.max(0, Math.floor(raw0));
  const closing = maxOffer * deal.closingPct;
  return {
    ok: true, errors: [], deal,
    result: {
      maxOffer, binding: "value", perUnit, value, siteTotal, closing, comps: usable.length,
      tests: [
        { key: "value", label: `Offer at ${Math.round(deal.offerPct * 100)}% of value`, price: maxOffer, binding: true },
        { key: "market", label: "Land value (comps)", price: value, binding: false, info: true },
      ],
    },
  };
}
