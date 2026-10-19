// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// underwrite-model.js — which way an offer was priced, and the calc it makes.
//
// Three ways to price a property (Matt, 2026-10-18):
//   comps  — a house: comps → ARV, less the work and our costs (offer-calc.js).
//            Every offer made before this file existed is a comps offer.
//   income — multi-family or commercial: NOI and return tests (income-underwrite.js).
//   land   — $/acre or $/lot from sold land, less site work (land-underwrite.js).
//
// An income or land offer is priced by hand. Everything the machine does to
// a comps offer on its own — re-quoting off the agent's ARV, the counter
// band, a fresh auto-underwrite — reruns flip math, so it stays off these:
// underwriteModel() is the one question every one of those asks.
//
// The calc an income or land offer stores has the SAME shape as
// calculateOffers' (inputs, settings, offers.cash), so the letter, the CRM
// fields, the list and the deal read it without knowing which way it was
// priced. Its ARV and repairs are 0 on purpose: nothing flip-shaped can be
// derived from them.

import { effectiveSettings } from "./offer-calc.js";
import { underwriteIncome, INCOME_KINDS, TEST_LABELS } from "./income-underwrite.js";
import { underwriteLand } from "./land-underwrite.js";

export const UNDERWRITE_MODELS = ["comps", "income", "land"];

const asModel = (v) => (v === "income" || v === "land" ? v : "");

/** modelForAsset("multi_family") → "income"; "land" → "land"; anything else → "comps". */
export function modelForAsset(type) {
  if (type === "multi_family" || type === "commercial") return "income";
  if (type === "land") return "land";
  return "comps";
}

/**
 * underwriteModel(offerOrSnapshot) → "comps" | "income" | "land"
 *
 * The offer's own field first (lean list rows carry it). A priced offer is
 * whatever its calc says — the workspace autosaves while you try the other
 * analyzer, and that isn't a re-price until you save. A draft goes by its
 * workspace. Missing is comps: every older offer.
 */
export function underwriteModel(x) {
  if (!x || typeof x !== "object") return "comps";
  const own = asModel(x.underwriteModel);
  if (own) return own;
  if (x.calc && typeof x.calc === "object") return asModel(x.calc.model) || "comps";
  return asModel(x.draft?.model) || asModel(x.snapshot?.model) || asModel(x.model) || "comps";
}

/** pricedByHand(offer) → true for an income or land offer (no machine re-pricing). */
export const pricedByHand = (offer) => underwriteModel(offer) !== "comps";

const fail = (msg) => Object.assign(new Error(msg), { http: 400 });
const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * runUnderwrite(model, deal) → the engine's answer for that model:
 *   income → underwriteIncome(deal), land → underwriteLand(deal).
 */
export function runUnderwrite(model, deal) {
  if (model === "income") return underwriteIncome(deal);
  if (model === "land") return underwriteLand(deal);
  return { ok: false, errors: ["not an income or land offer"], deal };
}

/**
 * buildUnderwriteCalc({ model, deal, inputs, settings }) → calc
 *
 * `inputs` is the editor's { address, askingPrice, priceOverride }. The asking
 * price on the form wins over the deal's, so there is one asking price. A
 * typed price override is the letter's number; otherwise the max offer.
 * Throws a 400 with the engine's words when the deal can't be priced.
 */
export function buildUnderwriteCalc({ model, deal = {}, inputs = {}, settings = {} } = {}) {
  const m = asModel(model);
  if (!m) throw fail("underwrite model must be income or land");
  const asking = num(inputs.askingPrice) || num(deal.askingPrice);
  const run = runUnderwrite(m, { ...deal, askingPrice: asking });
  if (!run.ok) throw fail(run.errors.join(" "));
  const r = run.result;
  const systemAmount = Math.max(0, Math.round(r.maxOffer));
  const override = Math.round(num(inputs.priceOverride));
  const amount = override > 0 ? override : systemAmount;
  const value = m === "income" ? r.marketValue : r.value;
  const summary = m === "income"
    ? {
        kind: run.deal.kind,
        inPlaceNoi: Math.round(r.inPlace.noi),
        stabilizedNoi: Math.round(r.stabilized.noi),
        marketCap: run.deal.marketCap,
        size: r.inPlace.size,
        sizeLabel: run.sizeLabel,
      }
    : {
        kind: "land",
        perUnit: Math.round(r.perUnit),
        basis: run.deal.basis,
        size: run.deal.size,
        siteTotal: Math.round(r.siteTotal),
        comps: r.comps,
      };
  return {
    model: m,
    inputs: {
      address: String(inputs.address || "").trim(),
      askingPrice: asking,
      arv: 0,
      repairs: 0,
      priceOverride: override > 0 ? override : 0,
    },
    settings: effectiveSettings(settings),
    offers: {
      cash: {
        key: "cash",
        mode: m,
        amount,
        base: Math.round(value),
        wholesaleFee: 0,
        pctOfAsking: asking > 0 ? Math.round((amount / asking) * 1000) / 10 : null,
        ...(override > 0 ? { systemAmount, overridden: true } : {}),
      },
    },
    underwrite: {
      model: m,
      maxOffer: systemAmount,
      binding: r.binding,
      bindingLabel: (r.tests.find((t) => t.binding) || {}).label || TEST_LABELS[r.binding] || "",
      value: Math.round(value),
      tests: r.tests.map((t) => ({ key: t.key, label: t.label, price: Math.round(t.price), info: Boolean(t.info), binding: Boolean(t.binding) })),
      ...summary,
      deal: run.deal,
    },
  };
}

const pct2 = (v) => `${(v * 100).toFixed(2)}%`;

/**
 * incomeMath(calc) → { total, rows } in offerMath's shape for the letter's
 * "How we priced it" box, or null for a comps calc (or nothing to show).
 *
 * Income: the in-place NOI and the cap rate it makes at our price, so NOI ÷
 * cap = the price printed. Never our return targets. Land: the value from
 * sold land, the site work, and what's left for holding, risk and resale.
 */
export function incomeMath(calc) {
  const u = calc?.underwrite;
  const total = Math.round(Number(calc?.offers?.cash?.amount) || 0);
  if (!u || !(total > 0)) return null;
  if (calc.model === "income") {
    if (!(u.inPlaceNoi > 0)) return null;
    return {
      total,
      rows: [
        { key: "arv", label: "Net operating income, in place", amount: u.inPlaceNoi, sign: "+" },
        { key: "cap", label: "Cap rate at this price", text: pct2(u.inPlaceNoi / total) },
      ],
    };
  }
  if (calc.model === "land") {
    if (!(u.value > 0)) return null;
    const rows = [{ key: "arv", label: `Land value, ${u.comps} sold comp${u.comps === 1 ? "" : "s"}`, amount: u.value, sign: "+" }];
    if (u.siteTotal > 0) rows.push({ key: "site", label: "Site work", amount: u.siteTotal, sign: "−" });
    const left = u.value - (u.siteTotal || 0) - total;
    if (left > 0) rows.push({ key: "margin", label: "Holding, risk & resale", amount: left, sign: "−" });
    return { total, rows };
  }
  return null;
}

export { INCOME_KINDS };
