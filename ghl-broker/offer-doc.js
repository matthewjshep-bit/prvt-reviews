// offer-doc.js — builds the letter-size offer document rendered by cardgen.
// The template is constructed per offer with all values already resolved, so
// no binding context is needed at render time. Layout follows the cardgen
// template schema (percent coordinates, letter canvas 1224×1584).

import { fmtMoney } from "./shared/offer-calc.js";

const LETTER = { width: 1224, height: 1584 };

const INK = "#0f172a";      // page background
const GOLD = "#d4af37";     // accent
const WHITE = "#ffffff";
const MUTED = "#94a3b8";
const SOFT = "#cbd5e1";

let _n = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}${(_n++).toString(36)}`;

const text = (x, y, w, h, content, o = {}) => ({
  id: uid("t"), type: "text", x, y, width: w, height: h, content,
  fontFamily: o.font || "Inter", fontWeight: o.weight || "regular",
  fontSize: o.size || 30, color: o.color || WHITE, align: o.align || "left",
  lineHeight: o.lineHeight || 1.3,
  ...(o.autoFit ? { autoFit: true } : {}),
  ...(o.maxLines ? { maxLines: o.maxLines } : {}),
  visible: true,
});
const rule = (y) => ({
  id: uid("r"), type: "shape", shape: "rect", x: 6, y, width: 88, height: 0.18,
  fill: "rgba(148,163,184,0.35)", visible: true,
});
const label = (x, y, content, w = 60) =>
  text(x, y, w, 3, content, { size: 24, color: MUTED, weight: "bold" });

// calc: output of calculateOffers(). meta: { contactName, dateLabel, validLabel }.
export function buildOfferDocument({ calc, meta = {}, locationId = "" }) {
  const { inputs, settings, offers } = calc;
  const { cash, sellerFinance: sf, leaseOption: lo } = offers;
  const company = settings.company || {};
  const layers = [];

  /* ---- header ---- */
  if (company.name) layers.push(text(6, 3, 88, 3.2, company.name.toUpperCase(), { size: 26, color: GOLD, weight: "bold" }));
  layers.push(text(6, 6.2, 88, 6, "Purchase Offer", { font: "Archivo Black", weight: "bold", size: 74, autoFit: true, maxLines: 1 }));
  layers.push(text(6, 12.6, 88, 2.8,
    [meta.dateLabel ? `Presented ${meta.dateLabel}` : "", meta.validLabel ? `valid through ${meta.validLabel}` : ""].filter(Boolean).join(" · "),
    { size: 26, color: SOFT }));
  layers.push(text(6, 16, 88, 2.8, `Property: ${inputs.address || "Subject property"}`, { size: 28, color: WHITE, weight: "bold", autoFit: true, maxLines: 1 }));
  if (meta.contactName) {
    layers.push(text(6, 18.8, 88, 2.6, `Prepared for ${meta.contactName}`, { size: 26, color: SOFT, autoFit: true, maxLines: 1 }));
  }
  layers.push(rule(22.2));

  /* ---- Option A: cash ---- */
  layers.push(label(6, 23.6, "OPTION A — ALL CASH"));
  layers.push(text(6, 26.6, 60, 8.2, fmtMoney(cash.amount), { font: "Archivo Black", weight: "bold", size: 120, color: GOLD, autoFit: true, maxLines: 1 }));
  layers.push(text(6, 34.6, 88, 4.6,
    `As-is, no repairs, no agent commissions, no fees. Close in as few as ${cash.closeDays} days — you pick the date.`,
    { size: 27, color: SOFT, maxLines: 3 }));

  layers.push(rule(40.4));

  /* ---- Option B: seller finance ---- */
  layers.push(label(6, 41.8, "OPTION B — SELLER FINANCING"));
  layers.push(text(6, 44.8, 52, 6.4, fmtMoney(sf.price), { font: "Archivo Black", weight: "bold", size: 92, color: WHITE, autoFit: true, maxLines: 1 }));
  const sfLines = [
    `${fmtMoney(sf.down)} down, then ${fmtMoney(sf.monthly)}/month` +
      (sf.annualRatePct > 0 ? ` at ${sf.annualRatePct}% interest` : " with 0% interest") +
      (sf.balloon > 0 ? `, ${fmtMoney(sf.balloon)} balloon at year ${sf.balloonYears}` : ` over ${sf.termYears} years`),
    `Total collected over the term: ${fmtMoney(sf.totalToSeller)} — top-dollar price in exchange for terms.`,
  ];
  layers.push(text(6, 51.4, 88, 7, sfLines.join("\n"), { size: 27, color: SOFT, lineHeight: 1.45, maxLines: 5 }));

  layers.push(rule(59.4));

  /* ---- Option C: lease option (only when rent was provided) ---- */
  let y = 60.8;
  if (lo) {
    layers.push(label(6, y, "OPTION C — LEASE OPTION"));
    layers.push(text(6, y + 3, 52, 6, fmtMoney(lo.price), { font: "Archivo Black", weight: "bold", size: 84, color: WHITE, autoFit: true, maxLines: 1 }));
    layers.push(text(6, y + 9.2, 88, 6.4,
      `${fmtMoney(lo.optionFee)} option fee today, ${fmtMoney(lo.monthly)}/month for ${lo.termMonths} months.\n` +
      `${lo.rentCreditPct}% of every payment (${fmtMoney(lo.monthlyCredit)}/mo) credits toward your price.`,
      { size: 27, color: SOFT, lineHeight: 1.45, maxLines: 4 }));
    y += 16.6;
    layers.push(rule(y));
    y += 1.4;
  }

  /* ---- validity badge + fine print ---- */
  layers.push({
    id: uid("badge"), type: "badge", x: 6, y, width: 46, height: 4.2,
    icon: "check", text: meta.validLabel ? `Offer valid through ${meta.validLabel}` : "Limited-time offer",
    bgColor: GOLD, textColor: INK, fontFamily: "Inter", fontSize: 28, cornerRadius: 999, visible: true,
  });
  layers.push(text(6, y + 6, 88, 8,
    "This letter is a non-binding expression of interest, not a purchase contract. Any accepted option will be " +
    "documented in a standard purchase agreement and is subject to interior inspection and clear, marketable title. " +
    "Choose whichever option works best for you — or reply with a counter.",
    { size: 21, color: "#64748b", lineHeight: 1.4, maxLines: 6 }));

  /* ---- footer band ---- */
  layers.push({ id: uid("fband"), type: "shape", shape: "rect", x: 0, y: 92, width: 100, height: 8, fill: "#020617", visible: true });
  const contactBits = [company.signer, company.phone, company.email].filter(Boolean).join(" · ");
  layers.push(text(6, 94.4, 88, 4,
    contactBits
      ? `Ready to move forward? ${contactBits}`
      : "Ready to move forward? Reply to this message and we'll take it from there.",
    { size: 26, weight: "bold", autoFit: true, maxLines: 2 }));

  return {
    locationId,
    name: `Offer — ${inputs.address || "property"}`.slice(0, 120),
    canvas: LETTER,
    background: { color: INK },
    dataSources: [],
    layers,
  };
}
