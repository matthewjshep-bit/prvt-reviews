// pdf-text.js — the text-layout primitives shared by every pdf-lib document
// renderer (contract-pdf.js, psa-pdf.js). pdf-lib does no text layout of its
// own: wrapping, page geometry, and encoding safety are all manual, and both
// renderers need the identical rules or their pages stop lining up.
//
// Extracted verbatim from contract-pdf.js — behaviour is unchanged for callers
// that don't pass the new `keep` option.

export const PAGE_W = 612; // US Letter, points
export const PAGE_H = 792;
export const MARGIN = 54;
export const CONTENT_W = PAGE_W - MARGIN * 2;
export const FOOTER_Y = 36; // baseline of the footer line
export const FOOTER_RESERVE = 24; // content must stay this far above the footer

// pdf-lib's standard fonts are WinAnsi-encoded and THROW on characters outside
// it (emoji, most non-Latin scripts). Map the common typographic characters to
// ASCII and drop the rest to "?" so user-typed text can never crash a render.
const CHAR_MAP = {
  "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"', "„": '"',
  "–": "-", "—": "--", "―": "--", "…": "...", " ": " ",
  "•": "-", "·": "-", "‐": "-", "‑": "-", "−": "-",
};

// `keep` is an opt-in set of characters to pass through untouched instead of
// folding to ASCII. Only ever pass characters WinAnsiEncoding actually has —
// the section sign, the middle dot, en/em dashes, curly quotes, the ellipsis —
// or pdf-lib will throw at draw time. Empty by default, so the contract renders
// byte-for-byte as it did before this module existed.
export function sanitizeWinAnsi(str, { keep = "" } = {}) {
  const kept = new Set(keep);
  return String(str || "")
    .replace(/[‘’‚“”„–—―… •·‐‑−]/g,
      (c) => (kept.has(c) ? c : CHAR_MAP[c]))
    .replace(/[^\n\x20-\x7e]/g, (c) => (kept.has(c) ? c : "?"));
}

// Greedy word wrap. Splits on \n first (blank lines survive as "" entries so
// paragraph spacing is preserved); hard-breaks any single word wider than
// maxWidth (long underscore blanks, pasted URLs).
export function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    if (!para.trim()) { lines.push(""); continue; }
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (font.widthOfTextAtSize(word, size) > maxWidth) {
        // Peel off the widest prefix that fits (flushing any pending line first).
        //
        // Binary search, not a walk down from the end: an operator pasting a
        // few thousand characters with no spaces in them (a URL, a metes-and-
        // bounds description, a mashed paragraph) would otherwise cost O(n^2)
        // width measurements over O(n)-length strings and stall the render for
        // seconds. Searching up from 1 also guarantees at least one character
        // is consumed per pass, so a glyph wider than the column can't spin
        // here forever.
        if (line) { lines.push(line); line = ""; }
        let lo = 1;
        let hi = word.length - 1;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (font.widthOfTextAtSize(word.slice(0, mid), size) > maxWidth) hi = mid - 1;
          else lo = mid;
        }
        lines.push(word.slice(0, lo));
        word = word.slice(lo);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}
