// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// money.js — a dollar figure the way a person types it.
//
// 2026-11-09: the deal's contract price and fee went through a parser that
// knew neither "15k" nor "740k". A fee typed as 15k saved as nothing, so the
// buyer pages and the deal texts priced the house at the contract with no
// fee; a price typed as 740k cleared the price. One reader for the Deals
// modal, the status menu's "Their number?" and the broker.
//
// Pure.

const MONEY_RX = /^(\d+(?:\.\d+)?|\.\d+)(k|m)?$/;

/**
 * parseMoney(v) → a number of dollars (0 or more), or null
 *
 * "15k" → 15000, "$450K" → 450000, "4.18M" → 4180000, "867,280.87" →
 * 867280.87. A dollar sign, commas and spaces are fine; a range, a word or a
 * minus sign is not, and empty is null: never a guess.
 */
export function parseMoney(v) {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(/^\$/, "").replace(/[,\s]/g, "");
  const m = MONEY_RX.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
