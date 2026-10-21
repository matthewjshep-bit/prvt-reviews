// BeforeYouSign.jsx — the one before-you-sign question left in the app
// (shared/pre-contract.js).
//
// The checklist on the offer pane is gone (2026-10-21): Matt doesn't work
// from it. What's left is the ask at "Mark under contract" when something is
// still a warning.

import { getPreContract } from "./api.js";

/**
 * confirmSigned(offerId) → true to go ahead
 *
 * "Mark under contract" asks once when something is still a warning, and
 * says what. It never stops you: OK promotes. A read that fails asks nothing.
 */
export async function confirmSigned(offerId, { read = getPreContract, ask = (msg) => window.confirm(msg) } = {}) {
  let checks = [];
  try { checks = (await read(offerId))?.checks || []; } catch { return true; }
  const warns = (checks || []).filter((c) => c?.state === "warn");
  if (!warns.length) return true;
  const lines = warns.slice(0, 6).map((c) => `• ${c.label}: ${c.detail || ""}`.slice(0, 180));
  return ask(`Before you sign — ${warns.length} warning${warns.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}\n\nMark it under contract anyway?`);
}

