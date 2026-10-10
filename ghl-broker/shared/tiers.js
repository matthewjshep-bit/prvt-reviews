// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// tiers.js — Tier 1 / Tier 2, from the app's own record.
//
// Matt, 2026-10-02: "I'm okay with thinking outside the GHL opportunities
// pipelines if it's better to do in our app to track tier 1 (agents who have
// a property in hand that is a flip potential), tier 2 everyone else that
// needs to be nurtured and has responded. And same with dispositions."
//
// GHL's tiers were tags and card stages the bot and the workflows wrote, and
// they drifted (2026-09-15: 174 of 663 cards out of line; 2026-10-02: a third
// of Tier 1 had nothing live). These are never stored: each read derives the
// tier from what the app knows, so it can't drift.
//
// Agents
//   Tier 1  a property in hand that could be a flip: a live deal with us, an
//           offer out (sent, countered, hot, or priced and not sent yet), an
//           underwrite held for a look, or a house they named in the last
//           three weeks that we haven't priced yet
//   Tier 2  has written back to us, nothing in hand right now — the agent
//           check-in keeps them warm (shared/agent-pulse.js)
//   Cold    never written back — only a new listing of theirs is a reason to text
// Buyers
//   Tier 1  on a live deal now: evaluating, soft-committed or committed
//   Tier 2  talking to us or replied — the buyer check-in keeps them warm
//   Cold    messaged, never answered; or never messaged
//
// Pure.

import { effectiveStatus, isHot, needsAiReview, aiHoldReasons, OPEN_STATUSES, LIVE_DEAL_STAGES } from "./offer-status.js";
import { addressKey } from "./us-address.js";
import { relationshipOf } from "./talked-to.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const street = (a) => String(a || "").split(",")[0].trim();

export const TIERS = {
  t1: { label: "Tier 1", agent: "A property in hand that could be a flip", buyer: "On a live deal now" },
  t2: { label: "Tier 2", agent: "Has written back; nothing in hand — the check-in keeps them warm", buyer: "Talking to us — the buyer check-in keeps them warm" },
  cold: { label: "Cold", agent: "Never written back", buyer: "Never answered, or never messaged" },
  opted_out: { label: "Opted out", agent: "Opted out", buyer: "Tagged unsubscribed or do-not-contact" },
};
// A house they named stays "in hand" this long without an offer.
export const NAMED_HOUSE_DAYS = 21;
// A held underwrite older than this is history (the nightly triage retires it).
export const HELD_DAYS = 21;

/**
 * offerHasTheirAnswer(offer) → boolean
 *
 * An offer only their answer could have moved: a deal, a counter, a yes or
 * no to a number, they passed, it sold. The record of an agent who wrote
 * back, even when the timeline doesn't hold their text (rows from before the
 * timeline existed, a call, an email). The check-in reads it the same way
 * (shared/agent-pulse.js agentSegment).
 */
export function offerHasTheirAnswer(o) {
  return Boolean(o && (o.deal || Number(o.counter?.amount) > 0 || o.realm?.answer || ["countered", "passed", "accepted", "unavailable"].includes(effectiveStatus(o))));
}

/**
 * agentTier({ offers, events, lastInboundAt, now }) → { tier, why, address? }
 *
 *   offers         the agent's offers (current rows; drafts included for held underwrites)
 *   events         their timeline (subject_property_set, address_pending/_closed, unsubscribed)
 *   lastInboundAt  when they last wrote to us
 */
export function agentTier({ offers = [], events = [], lastInboundAt = null, now = Date.now() } = {}) {
  if ((events || []).some((e) => e?.type === "unsubscribed")) return { tier: "opted_out", why: "opted out" };
  const live = (offers || []).filter((o) => o && !o.supersededBy && o.isCurrent !== false);
  const deal = live.find((o) => o.deal && LIVE_DEAL_STAGES.has(o.deal.stage));
  if (deal) return { tier: "t1", why: `under contract on ${street(deal.address)}`, address: deal.address };
  const hot = live.find((o) => !o.deal && OPEN_STATUSES.has(effectiveStatus(o)) && isHot(o));
  if (hot) return { tier: "t1", why: `hot on ${street(hot.address)}`, address: hot.address };
  const countered = live.find((o) => !o.deal && effectiveStatus(o) === "countered");
  if (countered) return { tier: "t1", why: `countered on ${street(countered.address)}`, address: countered.address };
  const sent = live.find((o) => !o.deal && effectiveStatus(o) === "sent");
  if (sent) return { tier: "t1", why: `offer out on ${street(sent.address)}`, address: sent.address };
  const priced = live.find((o) => !o.deal && effectiveStatus(o) === "new");
  if (priced) return { tier: "t1", why: `priced ${street(priced.address)}, not sent yet`, address: priced.address };
  const held = (offers || []).find((o) => o?.status === "draft" && needsAiReview(o) && aiHoldReasons(o).length && now - (ms(o.createdAt) ?? 0) <= HELD_DAYS * DAY_MS);
  if (held) return { tier: "t1", why: `underwriting ${street(held.address)}`, address: held.address };
  // A house they named, not priced yet: the reply agent set it as the subject,
  // or they mentioned one with no address we could use yet.
  const pricedKeys = new Set((offers || []).map((o) => addressKey(o?.address || "")).filter(Boolean));
  const recent = (e) => now - (ms(e?.at) ?? 0) <= NAMED_HOUSE_DAYS * DAY_MS;
  // Not one they told us isn't a flip: Tier 1 is houses that need work. Nor
  // the icebreaker house while we're still asking about it, or once we passed
  // (shared/flip-read.js).
  // Nor one passed or kicked off the Tier 1 list (shared/tier-one.js).
  const passedKeys = new Set((events || []).filter((e) => (e?.type === "tier1_passed" || e?.type === "tier1_kicked") && e.address).map((e) => addressKey(e.address)));
  const named = [...(events || [])].filter((e) => e?.type === "subject_property_set" && e.address && !e.data?.notOurKind && !e.data?.qualifying && recent(e) && !pricedKeys.has(addressKey(e.address)) && !passedKeys.has(addressKey(e.address)))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (named) return { tier: "t1", why: `sent us ${street(named.address)}, not priced yet`, address: named.address };
  const pending = (events || []).filter((e) => e?.type === "address_pending" && recent(e));
  const closed = (events || []).filter((e) => e?.type === "address_pending_closed");
  const openPending = pending.find((p) => !closed.some((c) => String(c.at) >= String(p.at)));
  if (openPending) return { tier: "t1", why: "has a house for us, waiting on the address" };
  // Written back: their last word on the timeline, or an offer only their
  // answer could have moved (a counter, a yes, a pass, a deal) — the record
  // of a partner from before the timeline existed.
  const answered = (offers || []).some(offerHasTheirAnswer);
  if (lastInboundAt || answered) {
    const dead = live.find((o) => !o.deal && !OPEN_STATUSES.has(effectiveStatus(o)));
    return { tier: "t2", why: dead ? `nothing in hand (${effectiveStatus(dead).replace(/_/g, " ")} on ${street(dead.address)})` : "nothing in hand" };
  }
  return { tier: "cold", why: "never written back" };
}

/**
 * buyerTier(investor) → "t1" | "t2" | "cold" | "opted_out"
 *
 * `investor` is a Dispositions book row: tags, talk, engagement, the reply
 * and message dates, and `onLiveDeal` (shared/offer-status.js buyersInPlay).
 */
export function buyerTier(i = {}) {
  const r = i.relationship || relationshipOf(i);
  if (r === "opted_out") return "opted_out";
  if (i.onLiveDeal) return "t1";
  if (r === "talking" || r === "replied") return "t2";
  return "cold";
}
