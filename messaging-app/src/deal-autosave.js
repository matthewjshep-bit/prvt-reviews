// deal-autosave.js — the deal modal saves as you go, with no Save buttons
// (2026-11-23; Matt's rule for offers, 10-23: "save as you type everywhere").
//
// A field saves when you leave it (blur), a picker or a date when it changes.
// Not on every keystroke: a deal save can ask first (clearing the price or the
// fee, a contract price far off our number), and a prompt in the middle of
// typing "450k" would ask about "4". Closing the modal saves what is still
// open. These are the pure parts, so they can be tested without a browser.

export const TERM_KEYS = ["contractPrice", "assignmentFee", "closingDate", "inspectionDate", "notes"];
const MONEY = new Set(["contractPrice", "assignmentFee"]);

const savedValue = (deal, k) => (MONEY.has(k) ? deal?.[k] ?? "" : deal?.[k] || "");
const blank = (v) => String(v ?? "").trim() === "";

/** termsFrom(deal) → the terms form as the deal stands. */
export function termsFrom(deal = {}) {
  return Object.fromEntries(TERM_KEYS.map((k) => [k, savedValue(deal, k)]));
}

/**
 * termsChanges(terms, deal, { parse }) → { body, clearing }
 *   body      only the fields that differ from the deal, or null
 *   clearing  the money fields being emptied (or typed as 0) that hold a number
 * `parse` reads "15k" as 15000 (shared/money.js parseMoney).
 */
export function termsChanges(terms = {}, deal = {}, { parse = Number } = {}) {
  const body = {};
  for (const k of TERM_KEYS) {
    if (String(terms[k] ?? "") !== String(savedValue(deal, k))) body[k] = terms[k];
  }
  const clearing = ["contractPrice", "assignmentFee"]
    .filter((k) => k in body && (blank(terms[k]) || parse(terms[k]) === 0) && deal?.[k] != null);
  return { body: Object.keys(body).length ? body : null, clearing };
}

/**
 * settleTerms(current, sent, deal) → terms
 * After a save, a field still showing what was sent takes the deal's stored
 * form ("15k" → 15000), so it doesn't read as changed and save again. A field
 * typed into since the save began is left alone.
 */
export function settleTerms(current = {}, sent = {}, deal = {}) {
  const out = { ...current };
  for (const k of Object.keys(sent)) {
    if (String(current[k] ?? "") === String(sent[k] ?? "")) out[k] = savedValue(deal, k);
  }
  return out;
}

/** revertTerms(current, keys, deal) → terms with `keys` put back to the deal's. */
export function revertTerms(current = {}, keys = [], deal = {}) {
  const out = { ...current };
  for (const k of keys) out[k] = savedValue(deal, k);
  return out;
}

/** sameWindows(a, b) → the two lists of { start, end } name the same times. */
export function sameWindows(a = [], b = []) {
  const key = (l) => JSON.stringify((l || []).map((w) => [Date.parse(w.start), w.end ? Date.parse(w.end) : null]));
  return key(a) === key(b);
}

/**
 * savedLine(state) → "Saving…" | "Saved" | "Not saved: …" | ""
 * state: { phase: "" | "saving" | "saved" | "error", error? }
 */
export function savedLine(state = {}) {
  if (state.phase === "saving") return "Saving…";
  if (state.phase === "saved") return "Saved";
  if (state.phase === "error") return `Not saved${state.error ? `: ${state.error}` : ""}`;
  return "";
}
