// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// stale-unsent.js — a number we priced and never sent, closed out quietly.
//
// The 2026-10-16 audit: six priced offers whose number never went out, some
// since August. The Offers column said "Our number never went out — float or
// send it" ("the float timer didn't send it"), Today held them for Matt, and
// nobody was going to. A number nobody sent in ten days is not a decision
// anyone is waiting on: the row is retired as we_passed with "never sent:
// closed after N days", nothing is texted, and the agent goes to the agent
// check-in like anyone whose house is done (shared/agent-pulse.js offerOwner).
//
// It only closes our own stale rows and sends nothing, so it ships ON:
// parties.agent.followUp.retireUnsentDays (10; 0 turns it off). It rides the
// nightly held-underwrite sweep (ghl-broker/held-underwrites.js).
//
// Pure. `now` is passed in.

import { effectiveStatus, isAiGenerated, priceAgreed, isHot } from "./offer-status.js";
import { paperWent } from "./paper-follows.js";
import { pricedAt } from "./current-offer.js";
import { PERSON_HAS_IT_DAYS, CALL_HAS_IT_HOURS, HAND_REPLY_EVENT } from "./thread-health.js";
import { callEventConnected } from "./talked-to.js";
import { RETIRE_UNSENT_DEFAULT_DAYS } from "./conversation-ai.js";

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

export { RETIRE_UNSENT_DEFAULT_DAYS };
// A person's own work on a row stands this long: made by hand, revised,
// pinned, approved or published.
export const PERSON_GRACE_DAYS = 14;
// When the number was due out: the float timer's hours for an auto-underwrite,
// a day for one made by hand (shared/next-follow-up.js reads them the same way).
export const HAND_DUE_HOURS = 24;
export const STALE_UNSENT_BY = "stale-unsent";

/**
 * numberWentOut(offer) → boolean
 *
 * Anything of ours on it in front of them: a letter that went, our number
 * texted (floatSentAt — a number in a plain reply carries only this), a realm
 * check, our read floated, or a nudge.
 */
export function numberWentOut(o) {
  if (!o) return false;
  return paperWent(o) || Boolean(o.floatSentAt || o.proactive?.realmCheckAt || o.proactive?.takeCheckAt) || (o.followUps || []).length > 0;
}

// A person on the thread lately: a reply they answered by hand, a text typed
// on Today, a call that connected (shared/thread-health.js, the same windows).
function personHasThread({ drafts = [], events = [], now }) {
  if ((drafts || []).some((d) => d?.answeredBy === "you" && now - (ms(d.updatedAt || d.createdAt) ?? 0) <= PERSON_HAS_IT_DAYS * DAY_MS)) return true;
  if ((events || []).some((e) => e?.type === HAND_REPLY_EVENT && now - (ms(e.at) ?? 0) <= PERSON_HAS_IT_DAYS * DAY_MS)) return true;
  return (events || []).some((e) => callEventConnected(e) && now - (ms(e.at) ?? 0) <= CALL_HAS_IT_HOURS * HOUR_MS && (ms(e.at) ?? 0) <= now);
}

// The last time a person put their hand on this row.
function personTouchedAt(o) {
  const hand = !isAiGenerated(o) ? [ms(o.createdAt)] : [];
  return Math.max(0, ...[
    ...hand,
    ...(o.revisions || []).filter((r) => r?.by === "you").map((r) => ms(r.ts)),
    o.pin?.at && !o.pin.off ? ms(o.pin.at) : null,
    ms(o.approved?.at),
    ms(o.autoUnderwrite?.publishedAt),
  ].filter((t) => t != null));
}

/**
 * staleUnsent({ offer, drafts, events, days, floatAfterHours, now })
 *   → { retire, why, overdueDays? }
 *
 *   offer            the agent's CURRENT row on the house (the caller drops
 *                    superseded rows and held drafts)
 *   drafts, events   this contact's reply drafts and timeline
 *   days             parties.agent.followUp.retireUnsentDays (0 = off)
 *   floatAfterHours  driver.timers.floatAfterHours
 */
export function staleUnsent({ offer = null, drafts = [], events = [], days = RETIRE_UNSENT_DEFAULT_DAYS, floatAfterHours = 4, now = Date.now() } = {}) {
  const no = (why) => ({ retire: false, why });
  const limit = Math.round(Number(days) || 0);
  if (limit <= 0) return no("switched off");
  if (!offer?.id) return no("no offer");
  if (offer.deal) return no("it is a deal");
  if (offer.status === "draft") return no("a held underwrite has its own triage");
  if (effectiveStatus(offer) !== "new") return no(`the offer is ${effectiveStatus(offer).replace(/_/g, " ")}`);
  if (!(Number(offer.cashAmount) > 0)) return no("no number on it");
  if (numberWentOut(offer)) return no("our number went out");
  if (priceAgreed(offer) || isHot(offer) || offer.realm?.answer === "yes") return no("they said yes to it");

  const anchor = pricedAt(offer);
  if (!anchor) return no("no date on it");
  const touched = personTouchedAt(offer);
  if (touched && now - touched < PERSON_GRACE_DAYS * DAY_MS) return no(`a person worked on it ${Math.floor((now - touched) / DAY_MS)} days ago`);
  const dueAt = anchor + (isAiGenerated(offer) ? Math.max(1, Number(floatAfterHours) || 4) : HAND_DUE_HOURS) * HOUR_MS;
  const overdueDays = Math.floor((now - dueAt) / DAY_MS);
  if (overdueDays < limit) return no(`${Math.max(0, overdueDays)} days overdue, not ${limit}`);
  if (personHasThread({ drafts, events, now })) return no("you have the thread");
  // A text about it still waiting to go — a float you pressed, held for you.
  const waiting = (drafts || []).find((d) => d && (d.status === "draft" || d.status === "scheduled") && d.outbound?.offerId === offer.id
    && now - (ms(d.createdAt) ?? 0) < limit * DAY_MS);
  if (waiting) return no("a text about it is waiting in the outbox");
  const age = Math.floor((now - anchor) / DAY_MS);
  return { retire: true, overdueDays, why: `never sent: closed after ${age} days` };
}

/**
 * staleUnsentPatch(offer, { why, now }) → the offer, retired
 *
 * we_passed, the reason on the row and in its history, and `retired` saying
 * who — the held sweep's own shape, so every reader of a retired row reads
 * this one.
 */
export function staleUnsentPatch(offer, { why, now = Date.now() } = {}) {
  const ts = new Date(now).toISOString();
  return {
    ...offer, status: "we_passed", statusAt: ts, statusNote: why,
    statusHistory: [...(offer.statusHistory || []), { status: "we_passed", ts, note: why }],
    retired: { at: ts, by: STALE_UNSENT_BY, reason: why }, updatedAt: ts,
  };
}
