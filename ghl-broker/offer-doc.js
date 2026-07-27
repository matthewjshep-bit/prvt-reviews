// offer-doc.js — builds the letter-size cash-offer document rendered by
// cardgen. The template is constructed per offer with all values already
// resolved, so no binding context is needed at render time. Layout follows the
// cardgen template schema (percent coordinates, letter canvas 1224×1584).

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
  const { inputs, settings } = calc;
  const { cash } = calc.offers;
  const company = settings.company || {};
  const layers = [];

  /* ---- header ---- */
  if (company.name) layers.push(text(6, 3.5, 88, 3.2, company.name.toUpperCase(), { size: 26, color: GOLD, weight: "bold" }));
  layers.push(text(6, 7, 88, 6, "Cash Offer", { font: "Archivo Black", weight: "bold", size: 78, autoFit: true, maxLines: 1 }));
  layers.push(text(6, 13.8, 88, 2.8,
    [meta.dateLabel ? `Presented ${meta.dateLabel}` : "", meta.validLabel ? `valid through ${meta.validLabel}` : ""].filter(Boolean).join(" · "),
    { size: 26, color: SOFT }));
  layers.push(text(6, 17.6, 88, 2.8, `Property: ${inputs.address || "Subject property"}`, { size: 28, color: WHITE, weight: "bold", autoFit: true, maxLines: 1 }));
  if (meta.contactName) {
    layers.push(text(6, 20.4, 88, 2.6, `Prepared for ${meta.contactName}`, { size: 26, color: SOFT, autoFit: true, maxLines: 1 }));
  }
  layers.push(rule(24.6));

  /* ---- the offer ---- */
  layers.push(label(6, 26.6, "OUR ALL-CASH OFFER"));
  layers.push(text(6, 29.8, 88, 11, fmtMoney(cash.amount), { font: "Archivo Black", weight: "bold", size: 150, color: GOLD, autoFit: true, maxLines: 1 }));
  layers.push(text(6, 41.4, 88, 4.6,
    `Exactly as it sits — no repairs, no cleanouts, no showings. Close in as few as ${cash.closeDays} days, on the date you pick.`,
    { size: 28, color: SOFT, maxLines: 3, lineHeight: 1.4 }));

  layers.push(rule(48));

  /* ---- what this means ---- */
  layers.push(label(6, 50, "WHAT THIS MEANS FOR YOU"));
  layers.push(text(6, 53.6, 88, 24,
    "•  No agent commissions or closing-cost surprises — the number above is our offer\n\n" +
    "•  No financing contingency — cash means no lender, no appraisal, no falling through\n\n" +
    "•  Sell strictly as-is — leave anything you don't want, we handle it\n\n" +
    "•  You choose the closing date — fast, or whenever suits your move",
    { size: 30, color: "#e2e8f0", lineHeight: 1.5, maxLines: 14 }));

  /* ---- validity badge + fine print ---- */
  layers.push({
    id: uid("badge"), type: "badge", x: 6, y: 79, width: 46, height: 4.2,
    icon: "check", text: meta.validLabel ? `Offer valid through ${meta.validLabel}` : "Limited-time offer",
    bgColor: GOLD, textColor: INK, fontFamily: "Inter", fontSize: 28, cornerRadius: 999, visible: true,
  });
  layers.push(text(6, 85, 88, 6.5,
    "This letter is a non-binding expression of interest, not a purchase contract. An accepted offer will be " +
    "documented in a standard purchase agreement and is subject to interior inspection and clear, marketable title. " +
    "Have a number in mind? Reply with a counter — we're flexible.",
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
