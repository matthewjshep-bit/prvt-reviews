// counter-hold.js — where a held counter stands (the clock after our hold).
//
// Matt, 2026-10-04: "hold, then pass". The reply agent sends our number once
// on a counter above it; ghl-broker/counter-hold.js keeps the clock after it.
// This is the clock's arithmetic, pure, so the Desk can say "next check-in
// Thu" and "passes Mon" from a lean row.

// "300K" / "197.5K" — never rounded up (call-list.js kText, kept here so
// the Desk's call list can read this module without a cycle).
const kText = (n) => { const v = Math.round(Number(n) || 0); if (!v) return ""; return v >= 1e6 ? `${Math.floor(v / 1e4) / 100}M` : `${Math.floor(v / 100) / 10}K`; };

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const iso = (t) => new Date(t).toISOString();

/**
 * holdState(offer, { lastInboundAt, lastOutboundAt, checkIns, gapHours, now }) → { next, at, why }
 *
 * Pure. `next` is "wait" (not yet, or they wrote and the reply agent has
 * it), "nudge" (a check-in is due) or "pass" (they didn't move).
 */
export function holdState(offer, { lastInboundAt = null, lastOutboundAt = null, checkIns = 2, gapHours = 72, now = Date.now() } = {}) {
  const h = offer?.counterHold;
  if (!h?.at) return { next: "none", why: "no hold" };
  // Our last word counts as a touch too: when they wrote something that
  // wasn't a counter and we answered it, the clock picks up from our answer
  // instead of waiting forever on "they wrote since".
  const touches = [h.at, ...(h.nudges || []), ...(h.replies || []), lastOutboundAt].map(ms).filter((t) => t != null);
  const lastTouch = Math.max(...touches);
  const inAt = ms(lastInboundAt);
  // They wrote after our last word: the reply agent answered (or holds) it.
  if (inAt != null && inAt > lastTouch + 60000) return { next: "wait", why: "they wrote since — the conversation has it" };
  const due = lastTouch + gapHours * 3600000;
  const unmoved = (h.nudges || []).length + (h.replies || []).length;
  if (now < due) return { next: "wait", at: iso(due), why: unmoved >= checkIns ? "passes then if nothing moves" : "next check-in" };
  return unmoved >= checkIns
    ? { next: "pass", why: `held at ${kText(h.ours)}; ${unmoved} check-in${unmoved === 1 ? "" : "s"} and they didn't move` }
    : { next: "nudge", why: `check-in ${unmoved + 1} of ${checkIns} after the hold` };
}
