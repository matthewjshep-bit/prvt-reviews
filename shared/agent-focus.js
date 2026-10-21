// agent-focus.js — one agent, one house at a time.
//
// The Auburn listing agent, 2026-09-19 → 09-30: six machine texts in eleven days about
// three houses. Every house kept its own clock — the live offer's nudges on
// Auburn, a ten-day check-in on Military Rd (they passed on it in August), one
// more on an old Sheridan row after it had sold — and nothing looked at them as
// one person. On 9/21 the Military Rd check-in went out INSTEAD of the nudge
// on the live offer: two drafts started in one run, and the later one won.
//
// Matt's rule (2026-10-02):
//
//   - While an agent has a live offer, the machine talks about that house.
//   - A house they passed on gets a light touch: one short line on the live
//     offer's nudge, at most once a month, no number. A house WE passed on
//     never comes up.
//   - Unprompted texts to one agent are three days apart and two a week at
//     most (followUp.minHoursBetween / maxPerContactPerWeek). An answer to
//     their text, a number we promised or they asked for, a price drop on the
//     market, and the push to paper on an agreed price are never held by it.
//
// The sweep asks before it claims a rung (ghl-broker/follow-up-sweep.js);
// startProactive asks again for every other door — the nightly audit, the
// agent check-in — so no path texts around it.
//
// Pure. `now` is passed in.

import { effectiveStatus, OPEN_STATUSES, dealIsOver, pushesToPaper } from "./offer-status.js";
import { currentOffers, houseKey, isDraftOffer, pricedAt } from "./current-offer.js";
import { MACHINE_STARTED_KINDS } from "./follow-up.js";

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

// A passed house comes up on the live offer's nudge at most this often.
export const LIGHT_TOUCH_DAYS = 30;

// Texts the machine starts that nobody asked for: these wait their turn.
// Not here, on purpose: a reply, the number they're waiting on (realm_check,
// take_check, take_ask), a promise we made (promise_due, call_followup), a
// check-in they asked for (checkin_due), the address of a house they said is
// coming (address_chase), a price drop (the market moved — rare, and the
// reason to text), and the hot push (its own 20-hour floor).
export const UNPROMPTED_AGENT_KINDS = new Set([
  "offer_nudge", "counter_nudge", "passed_checkin", "agent_pulse", "outreach_open", "outreach_nudge", "second_look",
]);

// Texts about something other than the live offer. While one is out, these
// wait — a passed house rides on the nudge instead. The second look at a
// past offer (shared/second-look.js) waits the same way.
export const OFF_FOCUS_KINDS = new Set(["passed_checkin", "agent_pulse", "second_look"]);

/* ---------- the live offer ---------- */

/**
 * isLiveOffer(offer) → boolean
 *
 * A conversation in progress about this house: a deal still closing, an
 * accepted offer, or an open one we actually put in front of them (on paper
 * or floated by text). A priced row nobody floated is not a conversation yet.
 */
export function isLiveOffer(o) {
  if (!o || isDraftOffer(o)) return false;
  if (o.deal) return !dealIsOver(o.deal);
  const s = effectiveStatus(o);
  if (s === "accepted") return true;
  if (!OPEN_STATUSES.has(s)) return false;
  if (s !== "new") return true;
  return (o.sends || []).some((x) => x?.ts) || Boolean(o.proactive?.realmCheckAt || o.proactive?.takeCheckAt);
}

const rank = (o) => (o.deal ? 0 : pushesToPaper(o) ? 1 : effectiveStatus(o) === "accepted" ? 2 : effectiveStatus(o) === "countered" ? 3 : 4);

/**
 * focusOf(offers, { contactId }) → offer | null
 *
 * The house the machine talks to this agent about. Current rows only
 * (shared/current-offer.js): a deal closing first, then an agreed price,
 * an acceptance, a counter, and otherwise the offer whose number moved last.
 */
export function focusOf(offers = [], { contactId = "" } = {}) {
  const mine = (offers || []).filter((o) => o && (!contactId || o.contactId === contactId));
  const live = currentOffers(mine).filter(isLiveOffer);
  if (!live.length) return null;
  return live.sort((a, b) => (rank(a) - rank(b)) || (pricedAt(b) - pricedAt(a)) || String(b.id || "").localeCompare(String(a.id || "")))[0];
}

export const streetOf = (address = "") => String(address || "").split(",")[0].trim();
const sameHouse = (a, b) => Boolean(a && b) && houseKey(a) === houseKey(b);

/**
 * focusHolds({ kind, address, focus }) → reason | null
 *
 * A check-in about another house, or a "what else is coming up", while a
 * live offer is out: it waits, and the live offer's nudge is the touch.
 */
export function focusHolds({ kind = "", address = "", focus = null } = {}) {
  if (!focus || !OFF_FOCUS_KINDS.has(kind)) return null;
  if (kind !== "agent_pulse" && address && sameHouse(address, focus.address)) return null;
  return `one house at a time — the live offer on ${streetOf(focus.address)} is what we text them about`;
}

/* ---------- spacing ---------- */

/**
 * machineTexts(drafts) → [{ at, kind }]
 *
 * One contact's reply drafts, read for the texts the machine started that
 * went out or are queued to. A queued one counts from when it will send.
 * Replies and a person's own drafts aren't the machine's, and don't count.
 */
export function machineTexts(drafts = []) {
  const out = [];
  for (const d of drafts || []) {
    const kind = d?.outbound?.kind;
    if (!kind || !MACHINE_STARTED_KINDS.has(kind)) continue;
    let at = null;
    if (d.status === "sent") at = ms(d.sentAt) ?? ms(d.updatedAt) ?? ms(d.createdAt);
    else if (d.status === "scheduled" || d.status === "sending") at = ms(d.sendAt) ?? ms(d.createdAt);
    if (at != null) out.push({ at, kind });
  }
  return out.sort((a, b) => a.at - b.at);
}

// The check-ins: a text that asks what else they have, not about a live
// offer. Matt, 2026-10-21: "if we checked in the day before and then we
// double-text them the day after, it just comes off as too needy and
// aggressive." Each clock spaced itself and nothing spaced them against each
// other, so the outreach follow-up's check-in and the agent check-in could
// land days apart.
export const CHECK_IN_KINDS = new Set(["agent_pulse", "outreach_nudge", "passed_checkin"]);
export const CHECK_IN_GAP_DAYS = 14;
// A ladder's next rung keeps its own steps (the follow-up on day 3, then day
// 10); only the agent check-in has no ladder, so it is spaced against itself too.
const ownLadder = (kind, other) => kind === other && kind !== "agent_pulse";

/**
 * spacingHolds({ kind, sent, now, minHours, perWeek, floor, startedToday })
 *   → reason | null
 *
 * `sent` is machineTexts(drafts). `startedToday` counts drafts this run
 * started that aren't rows yet. `floor` is the person's pace (check in less
 * stretches the gap; more never shrinks it below the setting). A check-in
 * also waits CHECK_IN_GAP_DAYS after any other check-in, sent or queued.
 */
export function spacingHolds({ kind = "", sent = [], now = Date.now(), minHours = 0, perWeek = 0, floor = 1, startedToday = 0 } = {}) {
  if (!UNPROMPTED_AGENT_KINDS.has(kind)) return null;
  if (CHECK_IN_KINDS.has(kind)) {
    const checkIns = sent.filter((x) => CHECK_IN_KINDS.has(x.kind) && !ownLadder(kind, x.kind)).map((x) => x.at);
    const lastCheckIn = checkIns.length ? Math.max(...checkIns) : null;
    const gapDays = CHECK_IN_GAP_DAYS * Math.max(1, Number(floor) || 1);
    if (lastCheckIn != null && now - lastCheckIn < gapDays * DAY_MS) {
      if (lastCheckIn > now) return "a check-in to them is already queued";
      const days = Math.floor((now - lastCheckIn) / DAY_MS);
      return `we checked in with them ${days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`} — check-ins are ${gapDays} days apart`;
    }
  }
  const last = sent.length ? Math.max(...sent.map((x) => x.at)) : null;
  const gap = (Number(minHours) || 0) * Math.max(1, Number(floor) || 1) * HOUR_MS;
  if (gap > 0 && last != null && now - last < gap) {
    const hrs = Math.max(0, Math.round((now - last) / HOUR_MS));
    return last > now ? "a text to them is already queued" : `we texted them ${hrs}h ago — unprompted texts are ${Math.round(gap / HOUR_MS)}h apart`;
  }
  const week = sent.filter((x) => x.at > now - 7 * DAY_MS).length + (Number(startedToday) || 0);
  if (perWeek > 0 && week >= perWeek) return `they've had ${week} texts from us this week (the most is ${perWeek})`;
  return null;
}

/* ---------- the light touch ---------- */

/**
 * lightTouchDue({ offers, now, days }) → boolean
 *
 * No passed house of theirs has come up — on its own or on a nudge — in the
 * last `days`. `offers` are the agent's rows.
 */
export function lightTouchDue({ offers = [], now = Date.now(), days = LIGHT_TOUCH_DAYS } = {}) {
  const last = (offers || []).flatMap((o) => (o?.followUps || []).filter((f) => f?.kind === "passed_checkin").map((f) => ms(f.at) ?? 0));
  return !last.length || Math.max(...last) <= now - days * DAY_MS;
}

/**
 * pickAside(candidates) → candidate | null
 *
 * Of the passed houses whose check-in is due, the one they passed on most
 * recently — the freshest in their mind.
 */
export function pickAside(candidates = []) {
  return [...(candidates || [])].sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))[0] || null;
}
