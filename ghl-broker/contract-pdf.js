// contract-pdf.js — renders the Purchase & Sale Agreement (and, via the
// `layout` options, the Assignment of Contract Agreement) as a real text PDF
// via pdf-lib (selectable text, flowing pagination), unlike the image-page
// offer documents. Layout follows standard association-form conventions —
// Specific Terms summary table, numbered General Terms clauses, signature
// blocks, per-page footer with initials lines — with entirely original text.
//
// pdf-lib does no text layout of its own: hanging indents and page breaks are
// manual here; wrapping, page geometry and WinAnsi safety come from pdf-text.js.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { CONTRACT_DISCLAIMER, CONTRACT_PREAMBLE, CONTRACT_TOKENS, mergeTokens } from "./shared/contract-template.js";
import {
  PAGE_W, PAGE_H, MARGIN, CONTENT_W, FOOTER_Y, FOOTER_RESERVE,
  sanitizeWinAnsi, wrapText,
} from "./pdf-text.js";

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.78, 0.78, 0.8);

// `layout` customizes the document shell for other contract types (title,
// preamble, Specific Terms rows, token list for blank widths, signature roles,
// per-page initials label). Defaults reproduce the Purchase & Sale Agreement.
export async function renderContractPdf({ clauses = [], values = {}, meta = {}, layout = {} }) {
  const pdf = await PDFDocument.create();
  const times = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);

  const BODY = 10;
  const LINE = 13.5; // body leading

  let page = null;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const ensureSpace = (needed) => {
    if (y - needed < FOOTER_Y + FOOTER_RESERVE) newPage();
  };
  newPage();

  const drawLine = (x1, y1, x2, y2, color = RULE, thickness = 0.6) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color, thickness });

  // Wrap + draw a text block at x with the given width, advancing the cursor.
  // Page-breaks between lines when needed.
  const drawWrapped = (text, { x = MARGIN, width = CONTENT_W, font = times, size = BODY, leading = LINE, color = INK } = {}) => {
    for (const line of wrapText(sanitizeWinAnsi(text), font, size, width)) {
      ensureSpace(leading);
      y -= leading;
      if (line) page.drawText(line, { x, y, size, font, color });
    }
  };

  const gap = (h) => { ensureSpace(h); y -= h; };

  const tokens = layout.tokens || CONTRACT_TOKENS;

  // ---- Heading -------------------------------------------------------------
  const title = layout.title || "PURCHASE AND SALE AGREEMENT";
  const titleSize = 15;
  y -= titleSize;
  page.drawText(title, {
    x: (PAGE_W - bold.widthOfTextAtSize(title, titleSize)) / 2,
    y, size: titleSize, font: bold, color: INK,
  });
  gap(14);
  drawWrapped(CONTRACT_DISCLAIMER, { font: italic, size: 7.5, leading: 9.5, color: MUTED });
  gap(10);
  drawLine(MARGIN, y, PAGE_W - MARGIN, y, RULE, 1);
  gap(12);

  // ---- Preamble ------------------------------------------------------------
  drawWrapped(mergeTokens(layout.preamble || CONTRACT_PREAMBLE, values, tokens));
  gap(12);

  // ---- Specific Terms ------------------------------------------------------
  const blank = (n) => "_".repeat(n);
  const specificRows = layout.specificRows || [
    ["Date of Agreement", values.effective_date || blank(18)],
    ["Buyer", values.buyer_name || blank(30)],
    ["Seller", values.seller_name || blank(30)],
    ["Property Address", values.address || blank(40)],
    ["Purchase Price", values.price || blank(14)],
    ["Earnest Money", values.earnest_money || blank(12)],
    ["Inspection Period", values.inspection_days ? `${values.inspection_days} days from the Effective Date` : `${blank(5)} days from the Effective Date`],
    ["Closing Date", values.closing_date ? `On or before ${values.closing_date}` : `On or before ${blank(18)}`],
    ["Title / Escrow Company", values.title_company || blank(30)],
    ["Special Provisions", values.special_provisions ? "Yes -- see the Special Provisions paragraph in the General Terms" : "None unless stated in the General Terms"],
  ];

  const sectionHeader = (label) => {
    ensureSpace(30);
    y -= 14;
    page.drawText(label, { x: MARGIN, y, size: 11, font: bold, color: INK });
    y -= 6;
    drawLine(MARGIN, y, PAGE_W - MARGIN, y);
    y -= 4;
  };

  sectionHeader("SPECIFIC TERMS");
  const LABEL_W = 150;
  const VALUE_X = MARGIN + LABEL_W + 12;
  const VALUE_W = PAGE_W - MARGIN - VALUE_X;
  specificRows.forEach(([label, value], i) => {
    const valueLines = wrapText(sanitizeWinAnsi(String(value)), times, BODY, VALUE_W);
    const rowH = Math.max(1, valueLines.length) * LINE + 5;
    ensureSpace(rowH); // keep each row on one page
    const rowTop = y;
    page.drawText(`${i + 1}.`, { x: MARGIN, y: rowTop - LINE, size: BODY, font: bold, color: INK });
    page.drawText(label, { x: MARGIN + 16, y: rowTop - LINE, size: BODY, font: bold, color: INK });
    valueLines.forEach((line, j) => {
      if (line) page.drawText(line, { x: VALUE_X, y: rowTop - LINE * (j + 1), size: BODY, font: times, color: INK });
    });
    y = rowTop - rowH;
    drawLine(MARGIN, y + 2, PAGE_W - MARGIN, y + 2);
  });
  gap(10);

  // ---- General Terms -------------------------------------------------------
  sectionHeader("GENERAL TERMS");
  const GUTTER = 22; // hanging indent for clause bodies under "N."
  clauses.forEach((clause, i) => {
    // Widow control: never strand a clause title at the bottom of a page.
    ensureSpace(LINE * 3 + 6);
    gap(6);
    y -= LINE;
    const num = `${i + 1}.`;
    page.drawText(num, { x: MARGIN, y, size: BODY, font: bold, color: INK });
    page.drawText(sanitizeWinAnsi(clause.title || "").trim(), { x: MARGIN + GUTTER, y, size: BODY, font: bold, color: INK });
    const body = mergeTokens(clause.body, values, tokens);
    drawWrapped(body, { x: MARGIN + GUTTER, width: CONTENT_W - GUTTER });
  });
  gap(18);

  // ---- Signature blocks ----------------------------------------------------
  // Default: SELLER / BUYER, no company lines (the P&S shape). `layout.signatures`
  // overrides with [{role, name, company?}] — a `company` key (even empty)
  // prints a Company line in that column.
  const signatures = layout.signatures || [
    { role: "SELLER", name: meta.sellerName },
    { role: "BUYER", name: meta.buyerName },
  ];
  const withCompany = signatures.some((s) => "company" in s);
  const COL_W = (CONTENT_W - 40) / 2;
  const sigBlockH = 14 + 26 + 12 + LINE * (withCompany ? 3 : 2) + 20;
  ensureSpace(sigBlockH + 10); // whole block stays on one page
  const leftX = MARGIN;
  const rightX = MARGIN + COL_W + 40;
  const topY = y;
  const sigColumn = (x, sig) => {
    let cy = topY;
    cy -= 14;
    page.drawText(`${sig.role}:`, { x, y: cy, size: 11, font: bold, color: INK });
    cy -= 26;
    drawLine(x, cy, x + COL_W, cy, INK, 0.8);
    cy -= 12;
    page.drawText("Signature", { x, y: cy, size: 8, font: times, color: MUTED });
    cy -= LINE + 4;
    page.drawText(`Name: ${sanitizeWinAnsi(sig.name || "").trim() || "_".repeat(30)}`, { x, y: cy, size: BODY, font: times, color: INK });
    if ("company" in sig) {
      cy -= LINE + 4;
      page.drawText(`Company: ${sanitizeWinAnsi(sig.company || "").trim() || "_".repeat(26)}`, { x, y: cy, size: BODY, font: times, color: INK });
    }
    cy -= LINE + 4;
    page.drawText(`Date: ${"_".repeat(24)}`, { x, y: cy, size: BODY, font: times, color: INK });
    return cy;
  };
  const endL = sigColumn(leftX, signatures[0]);
  const endR = sigColumn(rightX, signatures[1]);
  y = Math.min(endL, endR) - 10;

  // ---- Footer (second pass — needs the final page count) -------------------
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, {
      x: (PAGE_W - times.widthOfTextAtSize(label, 8)) / 2,
      y: FOOTER_Y, size: 8, font: times, color: MUTED,
    });
    if (i < pages.length - 1) {
      // Initials on every page except the signature page.
      const initials = layout.initialsLabels || ["Seller's Initials", "Buyer's Initials"];
      p.drawText(`${initials[0]} ${"_".repeat(8)}    ${initials[1]} ${"_".repeat(8)}`, {
        x: MARGIN, y: FOOTER_Y, size: 8, font: times, color: MUTED,
      });
    }
  });

  return Buffer.from(await pdf.save());
}
