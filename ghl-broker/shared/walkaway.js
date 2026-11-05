// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// walkaway.js — the machine negotiates up to the offer engine's walk-away (auto-underwrite v2, 2026-11-04).
//
// Matt (2026-11-04): on grade-A houses the machine may come up in at most two steps to a walk-away
// (investor price − the $15k minimum fee), never past it; anything higher is his, as a call. This
// knowingly loosens "never above what we sent" (shared/auto-accept.js never_above_sent) for those
// offers only: an offer the engine made live (`offer.pricing.live`, grade A) that no person has
// touched. Every other offer keeps the counter band exactly as it was.
//
// The 100-day read: agreement happens close in — within 5% of the seller's number 15 of 50 agreed,
// 5–10% 3 of 25, past 10% 6 of 228. So the moves are spent only when their number is within 10% of
// the walk-away; further off, the existing hold-then-pass path answers.
//
//   their ≤ ours                          not a counter (the acceptance path has it)
//   their ≤ walk-away                     take their number: "N works for us"
//   their ≤ walk-away × 1.10, moves left  move: first halfway (≤ half the gap), then the walk-away
//                                         itself as "best we can do"
//   otherwise                             not ours to move: held, and a close one becomes a call
//
// Pure.

export const WALKAWAY_MAX_MOVES = 2;
export const WALKAWAY_REACH = 0.10;
const HAND = new Set(["revise", "publish", "send", "pin", "today"]);
const round250 = (n) => Math.round(n / 250) * 250;
const num = (v) => Math.round(Number(v) || 0);

/** walkawayOffer(offer) → true when the walk-away, not the counter band, answers counters on it. */
export function walkawayOffer(offer) {
  const p = offer?.pricing;
  if (!p?.live || p.grade !== "A" || !(num(p.walkAway) > 0)) return false;
  // A person stood behind a number of their own: it's his to move.
  if (HAND.has(offer.approved?.by) || (offer.revisions || []).some((r) => r?.by === "you") || offer.pin?.at) return false;
  return true;
}

/**
 * evaluateWalkaway({ offer, theirAmount, theirOwnWords, comeDown }) →
 *   { kind: "walkaway", passed, checks, theirAmount, ceiling, releaseAmount, counterBack, final, reason }
 *
 * `ceiling` is the walk-away; `releaseAmount` the number we move to (their number when it's at or
 * under the walk-away). `counterBack`: we answer with a number of ours, not theirs. `final`: that
 * number is the walk-away itself.
 */
export function evaluateWalkaway({ offer = null, theirAmount = 0, theirOwnWords = false, comeDown = null } = {}) {
  const checks = [];
  const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail }); return Boolean(ok); };
  const ours = num(offer?.cashAmount);
  const walk = num(offer?.pricing?.walkAway);
  const their = num(theirAmount);
  const moves = num(offer?.pricing?.moves);
  const verdict = (passed, extra = {}) => ({ kind: "walkaway", passed, checks, theirAmount: their, ceiling: walk, releaseAmount: 0, counterBack: false, final: false,
    reason: passed ? "" : checks.filter((c) => !c.ok).map((c) => c.detail || c.name).join("; "), ...extra });

  check("engine_offer", walkawayOffer(offer), "not an offer the engine priced and sent on its own");
  check("current_number", !comeDown, comeDown ? "we texted a different number after this offer last moved" : "");
  check("their_own_words", their > 0 && theirOwnWords, their > 0 ? "their number isn't in their own message" : "no number read");
  check("above_ours", their > ours, "at or under our own number");
  if (checks.some((c) => !c.ok)) return verdict(false);

  if (their <= walk) return verdict(true, { releaseAmount: their });

  const reach = Math.round(walk * (1 + WALKAWAY_REACH));
  if (!check("within_reach", their <= reach, `${their} is more than ${Math.round(WALKAWAY_REACH * 100)}% over the ${walk} walk-away`)) return verdict(false);
  if (!check("moves_left", moves < WALKAWAY_MAX_MOVES, `both moves made (${moves}) — yours to call`)) return verdict(false);
  if (!check("room_left", ours < walk, "we're already at the walk-away")) return verdict(false);

  // Halfway to their number the first time (never past the walk-away); the walk-away the second.
  const half = round250(ours + (their - ours) / 2);
  const move = moves >= WALKAWAY_MAX_MOVES - 1 ? walk : Math.min(walk, Math.max(half, ours + 250));
  return verdict(true, { releaseAmount: move, counterBack: true, final: move >= walk });
}

/** walkawayReply({ amount, street, final, theirs }) → the text that goes with the revised offer. */
export function walkawayReply({ amount = 0, street = "", final = false, theirs = false } = {}) {
  const k = amount % 1000 === 0 ? `${amount / 1000}k` : Number(amount).toLocaleString("en-US");
  const on = street ? ` on ${street}` : "";
  if (theirs) return `${k} works for us${on}. Sending the updated offer over now.`;
  if (final) return `Best we can do${on} is ${k} as-is. Sending the updated offer over now.`;
  return `We can come up to ${k}${on}. Sending the updated offer over now.`;
}
