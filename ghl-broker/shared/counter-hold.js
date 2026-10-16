// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

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

/**
 * closeCounter({ ours, theirs, pct }) → { pct } | null
 *
 * Their counter is within `pct` percent above our number (2026-10-15, the
 * funnel review: counters within 5% agreed 13 times in 25, past 25% never).
 * Close enough that a phone call lands it and a held number by text loses
 * it. `pct` 0 is off.
 */
export function closeCounter({ ours = 0, theirs = 0, pct = 10 } = {}) {
  const o = Math.round(Number(ours) || 0), t = Math.round(Number(theirs) || 0), limit = Number(pct) || 0;
  if (!(limit > 0) || !(o > 0) || !(t > o)) return null;
  const gap = ((t - o) / o) * 100;
  return gap <= limit ? { pct: Math.round(gap * 10) / 10 } : null;
}

/**
 * callsInstead(offer, pct) → true when their newest counter came in after our
 * hold and is close to our number (closeCounter): the hold's clock stands
 * down — no check-in, no pass — and the counter is a call again.
 */
export function callsInstead(offer, pct = 10) {
  const h = offer?.counterHold;
  const c = offer?.counter;
  if (!h?.at || !(Number(c?.amount) > 0)) return false;
  if ((ms(c.at) ?? 0) <= (ms(h.at) ?? 0)) return false;
  return Boolean(closeCounter({ ours: Number(h.ours) || Number(offer.cashAmount) || 0, theirs: c.amount, pct }));
}
