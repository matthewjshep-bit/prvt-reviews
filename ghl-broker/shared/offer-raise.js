// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// offer-raise.js — a sent offer's price goes up only when a person says so (2026-11-09).
//
// The editor saves as you type (2026-10-23), and a live save re-renders the letter behind the
// agent's link and moves the bot's number. Opening a machine-sent offer to fix a term re-priced it
// on the first keystroke: the engine sent 254k, the editor re-ran it at today's settings and the
// letter said 300k (UWM-03). Never above our number (memory never-raise-our-number) means a save
// that comes out above what the agent was last sent waits for a person to confirm the raise.
//
// The ceiling is the higher of:
//   - the number the agent was last sent: the amount in effect at the newest send that went;
//   - the engine's walk-away, on an offer the engine made live (pricing.live). The machine may
//     already step up to it (shared/walkaway.js), so a person may too.
// An offer that never went out has no ceiling: it's still being priced.
//
// Pure.

const num = (v) => Math.round(Number(v) || 0);
const ok = (s) => s && (!s.results || Object.values(s.results).some((r) => r?.ok));
const NOT_OUT = new Set(["", "new", "draft"]);

/** wentOut(offer) → true when the agent has our number: a send that went, a float, or a status past "not sent". */
export function wentOut(offer) {
  if (!offer) return false;
  if ((offer.sends || []).some(ok)) return true;
  if (offer.floatSentAt || offer.proactive?.takeCheckAt || offer.proactive?.realmCheckAt) return true;
  return !NOT_OUT.has(String(offer.status || ""));
}

/**
 * lastSentAmount(offer) → the number the agent was last sent, or 0 when nothing went out.
 *
 * The send ledger carries no amount, so it is read off the revision ledger: the first revision's
 * `from` is the number before any revision, and each revision stamped at or before the newest send
 * moved it to its `to`. With no send on the ledger (marked sent by hand, floated), it's today's.
 */
export function lastSentAmount(offer) {
  if (!wentOut(offer)) return 0;
  const sends = (offer.sends || []).filter(ok).map((s) => String(s.ts || s.at || "")).filter(Boolean).sort();
  const cash = num(offer.cashAmount);
  if (!sends.length) return cash;
  const last = sends.at(-1);
  const revs = (offer.revisions || []).filter((r) => r && r.ts).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (!revs.length) return cash;
  let amount = num(revs[0].from) || cash;
  for (const r of revs) {
    if (String(r.ts) > last) break;
    amount = num(r.to) || amount;
  }
  return amount;
}

/**
 * raiseCeiling(offer) → the most a person's save may come out at without confirming, or 0 when
 * there is no ceiling (nothing went out).
 */
export function raiseCeiling(offer) {
  const sent = lastSentAmount(offer);
  if (!sent) return 0;
  const walk = offer?.pricing?.live ? num(offer.pricing.walkAway) : 0;
  return Math.max(sent, walk);
}

/** raiseNeedsConfirm({ offer, to }) → { from, to } when `to` raises a sent offer past its ceiling, else null. */
export function raiseNeedsConfirm({ offer = null, to = 0 } = {}) {
  const ceiling = raiseCeiling(offer);
  const next = num(to);
  if (!ceiling || !(next > ceiling)) return null;
  return { from: ceiling, to: next };
}

/** raiseLine({ from, to }) → "This raises a sent offer from 254k to 300k: confirm?" */
export function raiseLine({ from = 0, to = 0 } = {}) {
  const k = (n) => (n % 1000 === 0 ? `${n / 1000}k` : Number(n).toLocaleString("en-US"));
  return `This raises a sent offer from ${k(num(from))} to ${k(num(to))}: confirm?`;
}
