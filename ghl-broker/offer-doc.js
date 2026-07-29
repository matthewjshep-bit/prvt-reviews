// offer-doc.js — builds the letter-size cash-offer document rendered by
// cardgen: a light, letterhead-style LETTER OF INTENT (not a dark flyer).
// The template is constructed per offer with all values already resolved, so
// no binding context is needed at render time. Layout follows the cardgen
// template schema (percent coordinates, letter canvas 1224×1584).

import { fmtMoney } from "./shared/offer-calc.js";

const LETTER = { width: 1224, height: 1584 };

const PAPER = "#fdfcf9";    // warm white
const INK = "#1e293b";      // body text
const DARK = "#0f172a";     // headline text
const MUTED = "#64748b";
const FAINT = "#94a3b8";
const GOLD = "#a5802a";     // letterhead accent
const RULE = "rgba(100,116,139,0.35)";

let _n = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}${(_n++).toString(36)}`;

const text = (x, y, w, h, content, o = {}) => ({
  id: uid("t"), type: "text", x, y, width: w, height: h, content,
  fontFamily: o.font || "Inter", fontWeight: o.weight || "regular",
  fontSize: o.size || 26, color: o.color || INK, align: o.align || "left",
  lineHeight: o.lineHeight || 1.35,
  ...(o.autoFit ? { autoFit: true } : {}),
  ...(o.maxLines ? { maxLines: o.maxLines } : {}),
  visible: true,
});
const rule = (y, x = 8, w = 84) => ({
  id: uid("r"), type: "shape", shape: "rect", x, y, width: w, height: 0.14,
  fill: RULE, visible: true,
});
// Fake letter-spacing (the schema has no tracking property). Non-breaking
// spaces are used because the SVG renderer collapses runs of regular spaces.
const NB = "\u00A0";
const sp = (s) => s.toUpperCase().split(" ").map((w) => w.split("").join(NB)).join(`${NB} ${NB}`);

/* ---- number → words ("Four Hundred Twelve Thousand Five Hundred Dollars") ---- */
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function threeDigits(n) {
  const out = [];
  if (n >= 100) { out.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20) {
    out.push(n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[Math.floor(n / 10)]);
  } else if (n > 0) out.push(ONES[n]);
  return out.join(" ");
}
export function moneyInWords(amount) {
  let n = Math.floor(Math.max(0, amount));
  const cents = Math.round((amount - n) * 100);
  if (n === 0) return cents ? `${cents}/100 Dollars` : "Zero Dollars";
  const parts = [];
  const scales = [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"], [1, ""]];
  for (const [div, name] of scales) {
    if (n >= div) {
      const chunk = Math.floor(n / div);
      parts.push(name ? `${threeDigits(chunk)} ${name}` : threeDigits(chunk));
      n %= div;
    }
  }
  return `${parts.join(" ")} Dollars${cents ? ` and ${cents}/100` : ""}`;
}

// Rehab Scope of Work — the internal second document saved with each offer:
// property address, itemized scope lines, contingency, and the total that
// backs the repairs number used in the offer math.
export function buildScopeDocument({ scope = [], total = 0, address = "", meta = {}, company = {}, locationId = "" }) {
  const layers = [];
  const subtotal = scope.reduce((t, s) => t + (Number(s.cost) || 0), 0);
  const contingency = Math.max(0, Math.round(total - subtotal));

  /* ---- letterhead ---- */
  layers.push({ id: uid("bar"), type: "shape", shape: "rect", x: 0, y: 0, width: 100, height: 0.55, fill: GOLD, visible: true });
  if (company.name) {
    layers.push(text(8, 3.6, 56, 3.6, sp(company.name), { font: "Source Serif", weight: "bold", size: 40, color: DARK, autoFit: true, maxLines: 1 }));
  }
  if (company.tagline) {
    layers.push(text(8, 7.3, 56, 2.2, sp(company.tagline), { size: 17, color: GOLD, weight: "bold", autoFit: true, maxLines: 1 }));
  }
  if (meta.dateLabel) {
    layers.push(text(56, 3.6, 36, 3, meta.dateLabel, { size: 20, color: MUTED, align: "right" }));
  }
  layers.push(rule(11));

  /* ---- title + property ---- */
  layers.push(text(8, 13.6, 84, 3, sp("Rehab Scope of Work"), { font: "Source Serif", weight: "bold", size: 34, color: DARK, align: "center", autoFit: true, maxLines: 1 }));
  layers.push(text(8, 17.2, 84, 2.6, address || "Subject property", { size: 26, weight: "bold", color: INK, align: "center", autoFit: true, maxLines: 1 }));
  layers.push(text(8, 20, 84, 2, sp("Estimated Repair Items"), { size: 16, color: MUTED, align: "center" }));

  /* ---- line items (single column ≤ 26 items, else two columns) ---- */
  const startY = 24;
  const rowH = 2.35;
  const drawRows = (items, x, w) => {
    let y = startY;
    for (const s of items) {
      layers.push(text(x, y, w - 12, 2.1, s.label, { size: 20, color: INK, autoFit: true, maxLines: 1 }));
      layers.push(text(x + w - 12, y, 12, 2.1, fmtMoney(s.cost), { size: 20, color: DARK, weight: "bold", align: "right", autoFit: true, maxLines: 1 }));
      layers.push({ id: uid("r"), type: "shape", shape: "rect", x, y: y + 2.05, width: w, height: 0.08, fill: "rgba(100,116,139,0.18)", visible: true });
      y += rowH;
    }
    return y;
  };
  const items = scope.slice(0, 52);
  let endY;
  if (items.length <= 26) {
    endY = drawRows(items, 8, 84);
  } else {
    const half = Math.ceil(items.length / 2);
    const y1 = drawRows(items.slice(0, half), 8, 41);
    const y2 = drawRows(items.slice(half), 51, 41);
    endY = Math.max(y1, y2);
  }

  /* ---- totals ---- */
  let y = Math.min(endY + 1.5, 84);
  layers.push(text(8, y, 72, 2.2, "Line items subtotal", { size: 21, color: MUTED, align: "right" }));
  layers.push(text(80, y, 12, 2.2, fmtMoney(subtotal), { size: 21, color: INK, align: "right", autoFit: true, maxLines: 1 }));
  if (contingency > 0) {
    y += 2.6;
    layers.push(text(8, y, 72, 2.2, "Contingency & rounding", { size: 21, color: MUTED, align: "right" }));
    layers.push(text(80, y, 12, 2.2, fmtMoney(contingency), { size: 21, color: INK, align: "right", autoFit: true, maxLines: 1 }));
  }
  y += 3;
  layers.push({ id: uid("tbar"), type: "shape", shape: "rect", x: 8, y, width: 84, height: 0.18, fill: RULE, visible: true });
  y += 1.2;
  layers.push(text(8, y, 60, 3.4, sp("Total Rehab Estimate"), { size: 20, color: GOLD, weight: "bold" }));
  layers.push(text(48, y - 0.8, 44, 4.4, fmtMoney(total || subtotal), { font: "Source Serif", weight: "bold", size: 54, color: DARK, align: "right", autoFit: true, maxLines: 1 }));

  /* ---- fine print ---- */
  layers.push(rule(95.4));
  layers.push(text(8, 96.4, 84, 3.4,
    "Preliminary walkthrough estimate for planning and underwriting purposes only — not a contractor bid. " +
    "Quantities and costs subject to interior inspection and licensed contractor quotes.",
    { size: 14, color: FAINT, lineHeight: 1.4, maxLines: 3 }));

  return {
    locationId,
    name: `Rehab SOW — ${address || "property"}`.slice(0, 120),
    canvas: LETTER,
    background: { color: PAPER },
    dataSources: [],
    layers,
  };
}

// Condition notes — page 2 of the Rehab Scope of Work: the walkthrough
// summary and the per-item rationale from the photo review. Deliberately
// phrased as inspection notes (no tooling references) — this page can be
// shown to partners/lenders. Returns null when there's nothing to print.
export function buildScopeNotesDocument({ summary = "", notes = [], address = "", meta = {}, company = {}, locationId = "" }) {
  const cleanSummary = String(summary || "").slice(0, 700);
  const items = (Array.isArray(notes) ? notes : [])
    .map((n) => ({ label: String(n?.label || "").slice(0, 60), note: String(n?.note || "").slice(0, 220) }))
    .filter((n) => n.label && n.note)
    .slice(0, 24);
  if (!cleanSummary && !items.length) return null;

  const layers = [];

  /* ---- letterhead ---- */
  layers.push({ id: uid("bar"), type: "shape", shape: "rect", x: 0, y: 0, width: 100, height: 0.55, fill: GOLD, visible: true });
  if (company.name) {
    layers.push(text(8, 3.6, 56, 3.6, sp(company.name), { font: "Source Serif", weight: "bold", size: 40, color: DARK, autoFit: true, maxLines: 1 }));
  }
  if (company.tagline) {
    layers.push(text(8, 7.3, 56, 2.2, sp(company.tagline), { size: 17, color: GOLD, weight: "bold", autoFit: true, maxLines: 1 }));
  }
  if (meta.dateLabel) {
    layers.push(text(56, 3.6, 36, 3, meta.dateLabel, { size: 20, color: MUTED, align: "right" }));
  }
  layers.push(rule(11));

  /* ---- title + property ---- */
  layers.push(text(8, 13.6, 84, 3, sp("Condition Assessment"), { font: "Source Serif", weight: "bold", size: 34, color: DARK, align: "center", autoFit: true, maxLines: 1 }));
  layers.push(text(8, 17.2, 84, 2.6, address || "Subject property", { size: 26, weight: "bold", color: INK, align: "center", autoFit: true, maxLines: 1 }));
  layers.push(text(8, 20, 84, 2, sp("Walkthrough & photo-review notes"), { size: 16, color: MUTED, align: "center" }));

  /* ---- summary ---- */
  let y = 24;
  if (cleanSummary) {
    layers.push(text(8, y, 84, 2, sp("Overall condition"), { size: 15, color: GOLD, weight: "bold" }));
    y += 2.4;
    layers.push(text(8, y, 84, 9, cleanSummary, { size: 19, color: INK, lineHeight: 1.4, maxLines: 6 }));
    y += 9.6;
    layers.push(rule(y - 0.6));
  }

  /* ---- per-item notes (single column when few, two columns when dense) ---- */
  if (items.length) {
    layers.push(text(8, y, 84, 2, sp("Item notes"), { size: 15, color: GOLD, weight: "bold" }));
    y += 2.6;
    const available = 93.5 - y;
    const drawNotes = (list, x, w, rowH, size, maxLines) => {
      let ny = y;
      for (const n of list) {
        layers.push(text(x, ny, w, rowH - 0.4, `${n.label} — ${n.note}`, { size, color: INK, lineHeight: 1.3, maxLines }));
        ny += rowH;
      }
    };
    if (items.length <= 14) {
      const rowH = Math.max(3.0, Math.min(3.8, available / items.length));
      drawNotes(items, 8, 84, rowH, rowH >= 3.4 ? 17 : 16, 2);
    } else {
      const half = Math.ceil(items.length / 2);
      const rowH = Math.max(3.4, Math.min(5.2, available / half));
      const maxLines = rowH >= 4.4 ? 3 : 2;
      drawNotes(items.slice(0, half), 8, 40.5, rowH, 14, maxLines);
      drawNotes(items.slice(half), 51.5, 40.5, rowH, 14, maxLines);
    }
  }

  /* ---- fine print ---- */
  layers.push(rule(95.4));
  layers.push(text(8, 96.4, 84, 3.4,
    "Observations from listing photos and exterior review for planning purposes only — not an inspection report. " +
    "Conditions subject to interior walkthrough and licensed contractor evaluation.",
    { size: 14, color: FAINT, lineHeight: 1.4, maxLines: 3 }));

  return {
    locationId,
    name: `Condition notes — ${address || "property"}`.slice(0, 120),
    canvas: LETTER,
    background: { color: PAPER },
    dataSources: [],
    layers,
  };
}

// Comparable Sales Analysis — the companion document listing the closed sales
// (and manual comps) selected in the comps workspace to back the ARV used in
// the offer. comps: [{address, price, sqft, beds, baths, saleDate, distance,
// manual}]. subject: provider record for the subject. All inputs originate
// from the client snapshot, so counts and string lengths are capped here.
export function buildCompsDocument({ comps = [], subject = null, estimate = null, arv = 0, subjectSqft = 0, months = 0, address = "", meta = {}, company = {}, locationId = "" }) {
  const items = comps.slice(0, 20).map((c) => ({
    address: String(c.address || "Comp").slice(0, 90),
    price: Math.round(Number(c.price) || 0),
    sqft: Math.round(Number(c.sqft) || 0),
    beds: c.beds != null && c.beds !== "" ? Number(c.beds) : null,
    baths: c.baths != null && c.baths !== "" ? Number(c.baths) : null,
    saleDate: String(c.saleDate || "").slice(0, 10),
    distance: c.distance != null ? Number(c.distance) : null,
    manual: Boolean(c.manual),
  })).filter((c) => c.price > 0);
  if (!items.length) return null;

  const layers = [];

  /* ---- letterhead ---- */
  layers.push({ id: uid("bar"), type: "shape", shape: "rect", x: 0, y: 0, width: 100, height: 0.55, fill: GOLD, visible: true });
  if (company.name) {
    layers.push(text(8, 3.6, 56, 3.6, sp(company.name), { font: "Source Serif", weight: "bold", size: 40, color: DARK, autoFit: true, maxLines: 1 }));
  }
  if (company.tagline) {
    layers.push(text(8, 7.3, 56, 2.2, sp(company.tagline), { size: 17, color: GOLD, weight: "bold", autoFit: true, maxLines: 1 }));
  }
  if (meta.dateLabel) {
    layers.push(text(56, 3.6, 36, 3, meta.dateLabel, { size: 20, color: MUTED, align: "right" }));
  }
  layers.push(rule(11));

  /* ---- title + property ---- */
  layers.push(text(8, 13.6, 84, 3, sp("Comparable Sales Analysis"), { font: "Source Serif", weight: "bold", size: 34, color: DARK, align: "center", autoFit: true, maxLines: 1 }));
  layers.push(text(8, 17.2, 84, 2.6, address || "Subject property", { size: 26, weight: "bold", color: INK, align: "center", autoFit: true, maxLines: 1 }));
  const subjBits = [
    subject?.beds != null ? `${subject.beds} bd` : "",
    subject?.baths != null ? `${subject.baths} ba` : "",
    subject?.sqft ? `${Number(subject.sqft).toLocaleString()} sqft` : "",
    subject?.yearBuilt ? `built ${subject.yearBuilt}` : "",
  ].filter(Boolean).join(" · ");
  layers.push(text(8, 20, 84, 2,
    sp(subjBits ? `Subject: ${subjBits}` : months ? `Closed sales · last ${months} months` : "Closed sales"),
    { size: 15, color: MUTED, align: "center", autoFit: true, maxLines: 1 }));

  /* ---- table header ---- */
  const col = {
    addr: { x: 8, w: 31 }, bdba: { x: 40, w: 6 }, sqft: { x: 46.5, w: 7 },
    sold: { x: 54.5, w: 9 }, dist: { x: 64.5, w: 5.5 }, ppsf: { x: 71, w: 8.5 }, price: { x: 80.5, w: 11.5 },
  };
  const headY = 24;
  const head = (c, label, align = "right") =>
    layers.push(text(col[c].x, headY, col[c].w, 1.8, label.toUpperCase(), { size: 13, color: FAINT, weight: "bold", align }));
  head("addr", "Address", "left"); head("bdba", "Bd/Ba"); head("sqft", "Sqft");
  head("sold", "Sold"); head("dist", "Mi"); head("ppsf", "$/Sqft"); head("price", "Price");
  layers.push({ id: uid("hr"), type: "shape", shape: "rect", x: 8, y: headY + 1.9, width: 84, height: 0.14, fill: RULE, visible: true });

  /* ---- rows ---- */
  const rowH = 2.5;
  let y = headY + 2.6;
  for (const c of items) {
    const cell = (k, v, o = {}) => v && layers.push(text(col[k].x, y, col[k].w, 2, v, { size: 19, color: INK, align: "right", autoFit: true, maxLines: 1, ...o }));
    cell("addr", c.address + (c.manual ? " *" : ""), { align: "left" });
    cell("bdba", c.beds != null ? `${c.beds}/${c.baths ?? "?"}` : "");
    cell("sqft", c.sqft ? c.sqft.toLocaleString() : "");
    cell("sold", c.saleDate ? c.saleDate.slice(0, 7) : c.manual ? "manual" : "", { color: MUTED });
    cell("dist", c.distance != null ? String(Math.round(c.distance * 100) / 100) : "", { color: MUTED });
    cell("ppsf", c.sqft > 0 ? fmtMoney(Math.round(c.price / c.sqft)) : "", { color: MUTED });
    cell("price", fmtMoney(c.price), { weight: "bold", color: DARK });
    layers.push({ id: uid("r"), type: "shape", shape: "rect", x: 8, y: y + 2.05, width: 84, height: 0.08, fill: "rgba(100,116,139,0.18)", visible: true });
    y += rowH;
  }
  if (items.some((c) => c.manual)) {
    layers.push(text(8, y + 0.2, 84, 1.6, "* added manually", { size: 13, color: FAINT }));
    y += 1.8;
  }

  /* ---- summary ---- */
  const withSqft = items.filter((c) => c.sqft > 0);
  const avgPpsf = withSqft.length
    ? Math.round(withSqft.reduce((t, c) => t + c.price / c.sqft, 0) / withSqft.length)
    : 0;
  const prices = items.map((c) => c.price).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const medianPrice = prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);
  y = Math.min(y + 1.5, 82);
  layers.push(text(8, y, 72, 2.2, `Median sale price (${items.length} comps)`, { size: 21, color: MUTED, align: "right" }));
  layers.push(text(80, y, 12, 2.2, fmtMoney(medianPrice), { size: 21, color: INK, align: "right", autoFit: true, maxLines: 1 }));
  if (avgPpsf > 0) {
    y += 2.6;
    layers.push(text(8, y, 72, 2.2, `Average $/sqft (${withSqft.length} comps)`, { size: 21, color: MUTED, align: "right" }));
    layers.push(text(80, y, 12, 2.2, `${fmtMoney(avgPpsf)}`, { size: 21, color: INK, align: "right", autoFit: true, maxLines: 1 }));
  }
  if (estimate?.price) {
    y += 2.6;
    layers.push(text(8, y, 72, 2.2, "Automated valuation (AVM)", { size: 21, color: MUTED, align: "right" }));
    layers.push(text(72, y, 20, 2.2, fmtMoney(estimate.price), { size: 21, color: INK, align: "right", autoFit: true, maxLines: 1 }));
  }

  /* ---- ARV ---- */
  y += 3;
  layers.push({ id: uid("tbar"), type: "shape", shape: "rect", x: 8, y, width: 84, height: 0.18, fill: RULE, visible: true });
  y += 1.2;
  const sqftNum = Math.round(Number(subjectSqft) || 0) || (subject?.sqft ? Math.round(Number(subject.sqft)) : 0);
  const basis = avgPpsf > 0 && sqftNum > 0 ? `${fmtMoney(avgPpsf)}/sqft × ${sqftNum.toLocaleString()} sqft` : `${items.length} comparable sales`;
  layers.push(text(8, y, 58, 3.4, sp("After-Repair Value (ARV)"), { size: 20, color: GOLD, weight: "bold", autoFit: true, maxLines: 1 }));
  layers.push(text(8, y + 3, 58, 2, basis, { size: 17, color: MUTED }));
  layers.push(text(48, y - 0.8, 44, 4.4, fmtMoney(arv), { font: "Source Serif", weight: "bold", size: 54, color: DARK, align: "right", autoFit: true, maxLines: 1 }));

  /* ---- fine print ---- */
  layers.push(rule(95.4));
  layers.push(text(8, 96.4, 84, 3.4,
    "Comparable sales sourced from county deed records and MLS data for planning and underwriting purposes only — " +
    "not an appraisal. Selection and valuation subject to interior inspection and market conditions at time of sale.",
    { size: 14, color: FAINT, lineHeight: 1.4, maxLines: 3 }));

  return {
    locationId,
    name: `Comps — ${address || "property"}`.slice(0, 120),
    canvas: LETTER,
    background: { color: PAPER },
    dataSources: [],
    layers,
  };
}

// calc: output of calculateOffers(). meta: { contactName, dateLabel, validLabel }.
export function buildOfferDocument({ calc, meta = {}, locationId = "" }) {
  const { inputs, settings } = calc;
  const { cash } = calc.offers;
  const company = settings.company || {};
  const firstName = (meta.contactName || "").trim().split(/\s+/)[0] || "";
  const signer = company.signer || company.name || "The Buyer";
  const layers = [];

  /* ---- top accent bar + letterhead ---- */
  layers.push({ id: uid("bar"), type: "shape", shape: "rect", x: 0, y: 0, width: 100, height: 0.55, fill: GOLD, visible: true });
  if (company.name) {
    layers.push(text(8, 3.6, 56, 3.6, sp(company.name), { font: "Source Serif", weight: "bold", size: 40, color: DARK, autoFit: true, maxLines: 1 }));
  }
  if (company.tagline) {
    layers.push(text(8, 7.3, 56, 2.2, sp(company.tagline), { size: 17, color: GOLD, weight: "bold", autoFit: true, maxLines: 1 }));
  }
  const senderLines = [company.signer, company.email, company.phone].filter(Boolean).join("\n");
  if (senderLines) {
    layers.push(text(56, 3.6, 36, 7, senderLines, { size: 20, color: MUTED, align: "right", lineHeight: 1.45, maxLines: 3 }));
  }
  layers.push(rule(11));

  /* ---- title ---- */
  layers.push(text(8, 13.6, 84, 3, sp("Letter of Intent to Purchase"), { font: "Source Serif", weight: "bold", size: 34, color: DARK, align: "center", autoFit: true, maxLines: 1 }));
  layers.push(text(8, 16.8, 84, 2, sp("All-Cash Offer"), { size: 18, color: GOLD, weight: "bold", align: "center" }));

  /* ---- meta lines ---- */
  const metaRows = [
    ["DATE", meta.dateLabel || ""],
    ...(meta.contactName ? [["TO", meta.contactName]] : []),
    ["PROPERTY", inputs.address || "Subject property"],
  ];
  let y = 20.6;
  for (const [k, v] of metaRows) {
    layers.push(text(8, y, 18, 2.4, k, { size: 19, color: FAINT, weight: "bold" }));
    layers.push(text(27, y - 0.15, 65, 2.4, v, { size: 24, color: INK, weight: k === "PROPERTY" ? "bold" : "regular", autoFit: true, maxLines: 1 }));
    y += 2.7;
  }

  /* ---- salutation + opening ---- */
  y += 0.8;
  layers.push(text(8, y, 84, 2.5, firstName ? `Dear ${firstName},` : "Hello,", { size: 25 }));
  y += 3;
  layers.push(text(8, y, 84, 6.2,
    `I${signer !== "The Buyer" ? `, ${signer},` : ""} am writing to express my interest in purchasing the property at ` +
    `${inputs.address || "the address above"}. Below are the tentative terms and details of my offer:`,
    { size: 25, lineHeight: 1.42, maxLines: 3 }));

  /* ---- price block ---- */
  y += 7.4;
  layers.push(text(8, y, 84, 2, sp("Purchase Price"), { size: 18, color: MUTED, align: "center" }));
  layers.push(text(8, y + 2.4, 84, 6.6, fmtMoney(cash.amount), { font: "Source Serif", weight: "bold", size: 104, color: DARK, align: "center", autoFit: true, maxLines: 1 }));
  layers.push(text(8, y + 9.3, 84, 2.2, moneyInWords(cash.amount), { size: 21, color: MUTED, align: "center", autoFit: true, maxLines: 1 }));
  layers.push({
    id: uid("badge"), type: "badge", x: 27, y: y + 12, width: 46, height: 3.2,
    icon: "check", text: "ALL CASH · NO FINANCING CONTINGENCY",
    bgColor: "#f4ecd7", textColor: GOLD, fontFamily: "Inter", fontSize: 20, cornerRadius: 999, visible: true,
  });

  /* ---- tentative terms ---- */
  y += 17.4;
  layers.push(text(8, y, 84, 2.2, sp("Tentative Terms"), { size: 18, color: GOLD, weight: "bold" }));
  y += 2.9;
  const terms = [
    ["Purchase Price", `${fmtMoney(cash.amount)}, all cash`],
    ["Financing", String(settings.termFinancing || "").trim() || "None — funded with cash; no loan or appraisal contingency"],
    ["Earnest Money", `${fmtMoney(settings.earnestMoney)}, deposited with escrow upon mutual acceptance`],
    ["Closing Date", String(settings.termClosing || "").trim() || `On or before ${cash.closeDays} days from acceptance — or a date of your choosing`],
    ["Condition", String(settings.termCondition || "").trim() || "Purchased strictly as-is; no repairs or clean-out required"],
    ["Possession", String(settings.termPossession || "").trim() || "At closing, or flexible if you need additional time"],
  ];
  for (const [k, v] of terms) {
    layers.push(text(8, y, 19, 4.2, k, { size: 20, weight: "bold", color: DARK, lineHeight: 1.25, maxLines: 2 }));
    layers.push(text(28, y, 64, 4.2, v, { size: 20, color: INK, lineHeight: 1.3, maxLines: 2 }));
    y += 3.1;
  }

  /* ---- validity + closing paragraph ---- */
  y += 0.8;
  layers.push(text(8, y, 84, 8,
    `This offer is valid through ${meta.validLabel || "the date above"}. It is presented in good faith to open a ` +
    `conversation — final terms would be set out in a mutually signed purchase and sale agreement. My goal is a ` +
    `simple, private sale on the timeline that works best for you; I'd welcome the chance to talk it through ` +
    `whenever you're ready.`,
    { size: 22, lineHeight: 1.42, maxLines: 5 }));

  /* ---- signature ---- */
  y += 8.2;
  layers.push(text(8, y, 84, 2.2, "Sincerely,", { size: 22 }));
  y += 2.6;
  layers.push(text(8, y, 84, 2.5, signer, { font: "Source Serif", weight: "bold", size: 28, color: DARK, autoFit: true, maxLines: 1 }));
  const sigLine = [company.name, company.email || company.phone].filter(Boolean).join(" · ");
  if (sigLine) {
    layers.push(text(8, y + 2.6, 84, 1.9, sigLine, { size: 18, color: MUTED, autoFit: true, maxLines: 1 }));
  }

  /* ---- fine print ---- */
  layers.push(rule(95.4));
  layers.push(text(8, 96.4, 84, 3.4,
    "This letter of intent is a non-binding expression of interest and does not by itself create a contract or " +
    "obligation on either party. Any purchase would be subject to a mutually executed purchase and sale agreement " +
    "and to interior inspection and clear, marketable title.",
    { size: 14, color: FAINT, lineHeight: 1.4, maxLines: 3 }));

  return {
    locationId,
    name: `Offer — ${inputs.address || "property"}`.slice(0, 120),
    canvas: LETTER,
    background: { color: PAPER },
    dataSources: [],
    layers,
  };
}
