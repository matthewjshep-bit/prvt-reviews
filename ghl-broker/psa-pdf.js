// psa-pdf.js — renders the Washington Purchase & Sale Agreement package from
// shared/wa-psa-template.js: branded Offer Summary cover, the numbered
// Agreement, Addendum A (and Addendum B on a short sale), stacked signature
// blocks on each piece, and any earnest-money / proof-of-funds exhibits merged
// on at the end.
//
// Why this exists next to contract-pdf.js rather than inside it: that renderer
// is a one-shell form (heading, Specific Terms table, flat clause list). This
// package is a multi-document envelope with its own letterhead, per-document
// signature pages, stable section numbers and appended exhibit pages. Sharing
// the shell would have meant conditionals on every line of it. They share the
// layout primitives in pdf-text.js instead.
//
// Layout is manual, like every pdf-lib document here: wrapping and page breaks
// are measured with font.widthOfTextAtSize.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PSA_TITLE, PSA_SUBTITLE, PSA_TOKENS,
  PSA_SUMMARY_TITLE, PSA_SUMMARY_INTRO, PSA_PACKAGE_TITLE,
  PSA_ADDITIONAL_TERMS_TITLE, PSA_ADDITIONAL_TERMS_INTRO,
  PSA_SIGNING_LINE, PSA_CLOSING_DISCLAIMER, PSA_FOOTER_PREFIX,
  psaSummaryRows, psaPackageList, psaSections, psaAddenda,
} from "./shared/wa-psa-template.js";
import { mergeTokens } from "./shared/contract-template.js";
import { BRAND_NAVY, BRAND_GOLD } from "./shared/brand-mark.js";
import {
  PAGE_W, PAGE_H, MARGIN, CONTENT_W, FOOTER_Y, FOOTER_RESERVE,
  sanitizeWinAnsi, wrapText,
} from "./pdf-text.js";

// WinAnsi has all of these, and the document reads wrong without them — "§ 6"
// is a cross-reference a broker follows, and "?" 6 is not.
const KEEP = "§·®–—‘’“”…•";
const clean = (s) => sanitizeWinAnsi(s, { keep: KEEP });

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.78, 0.78, 0.8);
// Blue-black: a signature in body-text black reads as part of the typesetting.
const SIGNATURE_INK = rgb(0.09, 0.15, 0.36);

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
// Settings colors are operator-typed; anything that isn't a plain 6-digit hex
// falls back to the house palette rather than throwing mid-render.
function hexColor(value, fallback) {
  const h = HEX_RE.test(String(value || "")) ? String(value) : fallback;
  return rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
}

// Great Vibes (SIL OFL, fonts/GreatVibes-OFL.txt) — the script face the buyer's
// signature is drawn in. Read once and cached: a 450KB file has no business
// being read off disk on every offer.
const SCRIPT_FONT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fonts", "GreatVibes-Regular.ttf");
let scriptFontBytes = null;
async function loadScriptFont() {
  if (!scriptFontBytes) scriptFontBytes = await fs.readFile(SCRIPT_FONT_PATH);
  return scriptFontBytes;
}

const BODY = 10;
const LINE = 13.5;
const GUTTER = 22; // hanging indent for section bodies under "N."

/**
 * @param {"standard"|"short_sale"} mode
 * @param {object} values   pre-formatted token values (money, dates, words)
 * @param {object} company  settings.company — letterhead and signer
 * @param {string} address  printed in the running footer
 * @param {string} additionalTerms  operator's extra terms, unnumbered
 * @param {Array<{title:string,bytes:Buffer,contentType:string}>} exhibits
 * @param {{name:string,date:string}|null} signature  Buyer's pre-applied
 *        signature. Drawn in script on every BUYER line, with the date filled
 *        in. Never applied to a SELLER line — that one is theirs to sign.
 */
export async function renderPsaPdf({
  mode = "standard", values = {}, company = {}, address = "",
  additionalTerms = "", exhibits = [], signature = null,
} = {}) {
  const pdf = await PDFDocument.create();
  const times = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // The script face is embedded only when there is actually a signature to
  // draw — it is by far the largest thing in the file, even subsetted.
  const signName = String(signature?.name || "").trim();
  let script = null;
  if (signName) {
    pdf.registerFontkit(fontkit);
    script = await pdf.embedFont(await loadScriptFont(), { subset: true });
  }

  const NAVY = hexColor(company.brandPrimary, BRAND_NAVY);
  const GOLD = hexColor(company.brandAccent, BRAND_GOLD);

  let page = null;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const ensureSpace = (needed) => {
    if (y - needed < FOOTER_Y + FOOTER_RESERVE) newPage();
  };
  const gap = (h) => { ensureSpace(h); y -= h; };
  const drawLine = (x1, y1, x2, y2, color = RULE, thickness = 0.6) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, color, thickness });

  // Wrap + draw a block at x, advancing the cursor and page-breaking between
  // lines. Returns nothing — callers that need the height measure first.
  const drawWrapped = (text, opts = {}) => {
    const { x = MARGIN, width = CONTENT_W, font = times, size = BODY, leading = LINE, color = INK } = opts;
    for (const line of wrapText(clean(text), font, size, width)) {
      ensureSpace(leading);
      y -= leading;
      if (line) page.drawText(line, { x, y, size, font, color });
    }
  };
  const centered = (text, { font = bold, size = 14, color = INK } = {}) => {
    const t = clean(text);
    ensureSpace(size + 4);
    y -= size + 4;
    page.drawText(t, { x: (PAGE_W - font.widthOfTextAtSize(t, size)) / 2, y, size, font, color });
  };

  const merge = (text) => mergeTokens(text, values, PSA_TOKENS);
  const blockHeight = (text, font, size, width, leading) =>
    wrapText(clean(text), font, size, width).length * leading;

  newPage();

  /* ---- Letterhead (page 1 only, like the paper original) ----------------- */
  // The wordmark's separator dot is drawn as its own gold run rather than
  // colored inline, the same split dataroom.js and the console header do.
  {
    const name = clean(company.wordmark || company.name || "");
    if (name) {
      const size = 22;
      y -= size;
      let x = MARGIN;
      const parts = name.split("·");
      parts.forEach((part, i) => {
        if (i > 0) {
          page.drawText("·", { x, y, size, font: helvBold, color: GOLD });
          x += helvBold.widthOfTextAtSize("·", size);
        }
        page.drawText(part, { x, y, size, font: helvBold, color: NAVY });
        x += helvBold.widthOfTextAtSize(part, size);
      });
      const sub = [company.tagline, company.email, company.phone].map(clean).filter(Boolean).join("  —  ");
      if (sub) {
        y -= 13;
        page.drawText(sub, { x: MARGIN, y, size: 8.5, font: helv, color: MUTED });
      }
      gap(8);
      drawLine(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 1.4);
      gap(6);
    }
  }

  /* ---- Page 1 — Offer Summary ------------------------------------------- */
  const summaryRows = psaSummaryRows(mode, {
    emdExhibitNo: exhibitNumber(exhibits, "emdCheck"),
    pofExhibitNo: exhibitNumber(exhibits, "proofOfFunds"),
  });

  centered(PSA_SUMMARY_TITLE, { size: 15, color: NAVY });
  gap(8);
  drawWrapped(PSA_SUMMARY_INTRO, { font: italic, size: 8.5, leading: 11, color: MUTED });
  gap(10);

  {
    const LABEL_W = 118;
    const VALUE_X = MARGIN + LABEL_W + 10;
    const VALUE_W = PAGE_W - MARGIN - VALUE_X;
    drawLine(MARGIN, y, PAGE_W - MARGIN, y);
    for (const [label, template, opts = {}] of summaryRows) {
      const font = opts.italic ? italic : times;
      const text = merge(template);
      const lines = wrapText(clean(text), font, BODY, VALUE_W);
      const rowH = Math.max(1, lines.length) * LINE + 6;
      ensureSpace(rowH); // a summary row never splits across pages
      const top = y;
      page.drawText(clean(label), { x: MARGIN, y: top - LINE, size: 9, font: helvBold, color: NAVY });
      lines.forEach((line, j) => {
        if (line) page.drawText(line, { x: VALUE_X, y: top - LINE * (j + 1), size: BODY, font, color: INK });
      });
      y = top - rowH;
      drawLine(MARGIN, y + 2, PAGE_W - MARGIN, y + 2);
    }
  }
  gap(12);

  {
    const items = psaPackageList(mode, {
      emdExhibitNo: exhibitNumber(exhibits, "emdCheck"),
      pofExhibitNo: exhibitNumber(exhibits, "proofOfFunds"),
    });
    ensureSpace(LINE * (items.length + 1));
    y -= LINE;
    page.drawText(clean(PSA_PACKAGE_TITLE), { x: MARGIN, y, size: 10, font: helvBold, color: NAVY });
    items.forEach((item, i) => {
      y -= LINE;
      page.drawText(`${i + 1}.`, { x: MARGIN, y, size: 9.5, font: times, color: INK });
      page.drawText(clean(item), { x: MARGIN + 16, y, size: 9.5, font: times, color: INK });
    });
  }

  /* ---- The Agreement ----------------------------------------------------- */
  newPage();
  centered(PSA_TITLE, { size: 15, color: NAVY });
  centered(PSA_SUBTITLE, { font: italic, size: 9.5, color: MUTED });
  gap(12);

  const sections = psaSections(mode);
  for (const section of sections) {
    // Widow control: never strand a section title at the foot of a page.
    ensureSpace(LINE * 3 + 8);
    gap(8);
    y -= LINE;
    page.drawText(`${section.n}.`, { x: MARGIN, y, size: BODY, font: bold, color: NAVY });
    page.drawText(clean(section.title), { x: MARGIN + GUTTER, y, size: BODY, font: bold, color: NAVY });
    drawWrapped(merge(section.body), { x: MARGIN + GUTTER, width: CONTENT_W - GUTTER });

    // § 2 prints the legal description as its own indented block so a long
    // metes-and-bounds paste stays visually separate from the prose.
    if (section.legalBlock) {
      gap(6);
      drawWrapped(merge("{{legal_description}}"), {
        x: MARGIN + GUTTER + 14, width: CONTENT_W - GUTTER - 14, font: italic, leading: 12.5,
      });
      gap(6);
    }
    if (section.bodyAfter) drawWrapped(merge(section.bodyAfter), { x: MARGIN + GUTTER, width: CONTENT_W - GUTTER });

    // § 21 lists only the exhibits that actually shipped.
    if (section.incorporationSuffix) {
      const exhibitSentence = exhibits
        .map((ex, i) => `Exhibit ${i + 1} — ${ex.title}.`)
        .join(" ");
      const tail = [exhibitSentence, section.incorporationSuffix].filter(Boolean).join(" ");
      drawWrapped(tail, { x: MARGIN + GUTTER, width: CONTENT_W - GUTTER });
    }
  }

  if (String(additionalTerms || "").trim()) {
    ensureSpace(LINE * 4 + 8);
    gap(10);
    y -= LINE;
    page.drawText(PSA_ADDITIONAL_TERMS_TITLE, { x: MARGIN, y, size: BODY, font: bold, color: NAVY });
    drawWrapped(PSA_ADDITIONAL_TERMS_INTRO, { x: MARGIN, font: italic, size: 9, leading: 12, color: MUTED });
    drawWrapped(additionalTerms, { x: MARGIN });
  }

  gap(14);
  drawWrapped(PSA_SIGNING_LINE);
  gap(6);
  signatures();

  /* ---- Addenda ----------------------------------------------------------- */
  for (const addendum of psaAddenda(mode)) {
    newPage();
    centered(addendum.label, { size: 14, color: NAVY });
    centered(addendum.title, { font: bold, size: 10.5, color: GOLD });
    gap(10);
    drawWrapped(merge(addendum.intro));
    for (const clause of addendum.clauses) {
      ensureSpace(LINE * 3 + 8);
      gap(8);
      y -= LINE;
      page.drawText(`${clause.num}.`, { x: MARGIN, y, size: BODY, font: bold, color: NAVY });
      page.drawText(clean(clause.title), { x: MARGIN + 30, y, size: BODY, font: bold, color: NAVY });
      drawWrapped(merge(clause.body), { x: MARGIN + 30, width: CONTENT_W - 30 });
    }
    gap(14);
    signatures();
  }

  /* ---- Closing disclaimer ------------------------------------------------ */
  {
    const h = blockHeight(PSA_CLOSING_DISCLAIMER, italic, 7.5, CONTENT_W, 9.5);
    ensureSpace(h + 18);
    gap(14);
    drawLine(MARGIN, y, PAGE_W - MARGIN, y, GOLD, 0.8);
    gap(4);
    drawWrapped(PSA_CLOSING_DISCLAIMER, { font: italic, size: 7.5, leading: 9.5, color: MUTED });
  }

  /* ---- Exhibits ---------------------------------------------------------- */
  for (let i = 0; i < exhibits.length; i++) {
    await appendExhibit(pdf, exhibits[i], i + 1, { helvBold, times });
  }

  /* ---- Footer (second pass — needs the final page count) ------------------ */
  {
    const pages = pdf.getPages();
    const label = [PSA_FOOTER_PREFIX, clean(address).trim()].filter(Boolean).join("  |  ");
    pages.forEach((p, i) => {
      const text = `${label}  |  Page ${i + 1} of ${pages.length}`;
      // Width per page, not PAGE_W: a copied exhibit page may not be letter.
      p.drawText(text, {
        x: (p.getWidth() - times.widthOfTextAtSize(text, 8)) / 2,
        y: FOOTER_Y, size: 8, font: times, color: MUTED,
      });
    });
  }

  return Buffer.from(await pdf.save());

  // BUYER over SELLER, stacked. The paper original signs each document
  // separately, so this is called once per piece (Agreement, each addendum) —
  // and so a pre-applied buyer signature lands on all of them, because a signed
  // agreement stapled to unsigned addenda looks like a mistake.
  function signatures() {
    const blockH = 16 + 30 + 12 + LINE * 4;
    const roles = [
      { role: "BUYER", name: buyerSignatureName(), email: values.signer_email, phone: values.signer_phone, signed: Boolean(script) },
      // Never signed for them, whatever is configured. This line is the
      // counterparty's assent and forging it is the one thing this file must
      // not do.
      { role: "SELLER", name: values.seller_name, email: "", phone: "", signed: false },
    ];
    // Both blocks are placed as a unit. Fitting them one at a time strands the
    // seller's block alone on a page of its own, which on a document you are
    // asking someone to sign reads as a printing error.
    ensureSpace(blockH * 2 + 24);
    for (const sig of roles) {
      y -= 16;
      page.drawText(sig.role, { x: MARGIN, y, size: 10.5, font: helvBold, color: NAVY });
      y -= 30;
      // The script sits ON the rule, slightly above it, the way a pen would.
      if (sig.signed) {
        const size = 21;
        page.drawText(signName, { x: MARGIN + 6, y: y + 5, size, font: script, color: SIGNATURE_INK });
      }
      drawLine(MARGIN, y, PAGE_W - MARGIN, y, INK, 0.8);
      y -= 10;
      page.drawText("Signature", { x: MARGIN, y, size: 8, font: times, color: MUTED });
      y -= LINE + 2;
      page.drawText(`Printed name: ${clean(sig.name || "").trim() || "_".repeat(34)}`,
        { x: MARGIN, y, size: BODY, font: times, color: INK });
      y -= LINE;
      const capacity = sig.signed ? clean(signature?.capacity || "").trim() : "";
      page.drawText(`Title / capacity: ${capacity || "_".repeat(28)}`, { x: MARGIN, y, size: BODY, font: times, color: INK });
      y -= LINE;
      const dated = sig.signed ? clean(signature?.date || "").trim() : "";
      page.drawText(`Date: ${dated || "_".repeat(28)}`, { x: MARGIN, y, size: BODY, font: times, color: INK });
      y -= LINE;
      const contact = `Email: ${clean(sig.email || "").trim() || "_".repeat(26)}   |   Phone: ${clean(sig.phone || "").trim() || "_".repeat(18)}`;
      page.drawText(contact, { x: MARGIN, y, size: 9, font: times, color: INK });
      y -= 8;
    }
  }

  // "Acme Holdings LLC, by Matt Shepherd, Manager" — the entity signs, a human
  // signs for it, and a seller's attorney will look for both.
  function buyerSignatureName() {
    const entity = String(values.buyer_entity || "").trim();
    const signer = String(values.signer_name || "").trim();
    if (entity && signer) return `${entity}, by ${signer}, Manager`;
    return entity || signer || "";
  }
}

// Which exhibit slot a given kind landed in (1-based), or 0 when the operator
// never uploaded one. Drives both the summary wording and § 21.
function exhibitNumber(exhibits, kind) {
  const i = exhibits.findIndex((e) => e.kind === kind);
  return i < 0 ? 0 : i + 1;
}

// PDFs are copied page-for-page; images get a captioned page of their own,
// scaled to fit the margins. Anything unreadable is skipped rather than
// failing the whole render — a bad check scan should not block the offer.
async function appendExhibit(pdf, exhibit, number, { helvBold, times }) {
  const caption = `EXHIBIT ${number} — ${sanitizeWinAnsi(exhibit.title || "", { keep: "—" })}`;
  try {
    if (exhibit.contentType === "application/pdf") {
      const src = await PDFDocument.load(exhibit.bytes, { ignoreEncryption: true });
      const copied = await pdf.copyPages(src, src.getPageIndices());
      copied.forEach((p, i) => {
        pdf.addPage(p);
        if (i === 0) p.drawText(caption, { x: 24, y: 18, size: 8, font: times, color: MUTED });
      });
      return;
    }
    const img = exhibit.contentType === "image/png"
      ? await pdf.embedPng(exhibit.bytes)
      : await pdf.embedJpg(exhibit.bytes);
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawText(caption, { x: MARGIN, y: PAGE_H - MARGIN, size: 10, font: helvBold, color: INK });
    const maxW = CONTENT_W;
    const maxH = PAGE_H - MARGIN * 2 - 40;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, { x: (PAGE_W - w) / 2, y: PAGE_H - MARGIN - 30 - h, width: w, height: h });
  } catch {
    // Unreadable exhibit: the package still renders, minus this page.
  }
}
