// agent-pulse.js — every agent on a clock (the greenhouse).
//
// Matt, 2026-09-29: "reach out to these agents proactively and frequently,
// every 3 weeks or so, to see if they have any new listings or leads". Until
// this, every clock that texted an agent belonged to one thing — a first text,
// an offer, a phrase they used — and every one of them ended: the outreach
// follow-up after one enrollment, the passed-offer check-ins at day 120, the
// "I'll send you deals" check-ins after six weeks. When the last one ended the
// agent dropped off the line for good, and the daily pull skipped their next
// distressed listing because they were "already in GHL".
//
// This is the clock that owns an agent when nothing else does.
//
//   partner   a deal with us, an agreed price, or a yes to a number — ever
//   source    they brought us a house we never texted them about (2026-10-09)
//   engaged   they have written back at least once
//   cold      never answered
//
// Engaged and partner agents hear from us every `everyDays` (21): about a
// fresh distressed listing of theirs when there is one (the moment for it is
// now, so that one may come sooner — never within `quietDays` of a touch),
// else the house they had with us once its clocks have ended, else "anything
// coming up that needs work?". A cold agent hears ONLY about a fresh listing
// of theirs, `coldEveryDays` apart, and never after `coldMaxUnanswered` pings
// with nothing back. An engaged agent `engagedMaxUnanswered` pulses into
// silence is treated as cold (0 = never). Matt's decisions, 2026-09-29.
// A cold agent we made an offer to, sent or drafted, is checked in on like an
// engaged one until `coldMaxUnanswered` check-ins go unanswered (2026-10-09).
//
// The one-owner rule: an agent another clock owns is left to it — an open
// offer and its nudges, the push to paper, check-ins on a passed offer, a
// promise, a check-in they asked for, an address chase, the outreach
// workflows, anything waiting in the outbox (a held draft for a week), a live
// deal, a thread you picked up. The pulse picks them up the day it ends: one
// voice per agent. An open offer with nothing coming and a quiet week ends too
// (openOfferIdle).
//
// Pure. The runner (ghl-broker/agent-pulse.js) reads; this decides.

import { effectiveStatus, OPEN_STATUSES, DEAD_STATUSES, dealIsOver, priceAgreed } from "./offer-status.js";
import { threadTimes, staleHeld, leadCheckInPending } from "./follow-up.js";
import { nextFollowUp } from "./next-follow-up.js";
import { IRRITATED_RX, PERSON_HAS_IT_DAYS, HAND_REPLY_EVENT, HOUSE_OVER_REASONS, threadHealth } from "./thread-health.js";
import { offerHasTheirAnswer } from "./tiers.js";
import { addressKey, sameStreet, parseUsAddress } from "./us-address.js";
import { offMarketAskDue } from "./off-market.js";
import { botHold, paceOf, paceScale } from "./bot-hold.js";
import { cadenceDays, requestStands, isAutoReply } from "./brush-offs.js";
import { optOutInTranscript, CONVERSATION_AI_DEFAULTS } from "./conversation-ai.js";

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const iso = (t) => new Date(t).toISOString();
const latest = (xs) => xs.filter(Boolean).sort().at(-1) || null;
const clamp = (x, d, lo, hi) => { const k = Math.round(Number(x)); return Number.isFinite(k) ? Math.min(hi, Math.max(lo, k)) : d; };

export const AGENT_PULSE_DEFAULTS = {
  enabled: false, autoSend: false,
  // The thank-you after a deal closes (dealToThank) stays a draft for you
  // unless this is on, whatever autoSend says.
  thanksAutoSend: false,
  dailyCap: 20, everyDays: 21, quietDays: 7,
  freshDays: 14, listingSeenDays: 30,
  coldEveryDays: 60, coldMaxUnanswered: 3, engagedMaxUnanswered: 6,
  hour: 12, weekdaysOnly: true,
  ghlWorkflowDays: 21, quietWorkflowIds: [],
  // The GHL drips this check-in replaces. Empty: the published "tier …
  // nurture" workflows in GHL's list (tierDrips) — never TIER 2/3 themselves.
  replacesWorkflowIds: [],
  // Matt's own notes on how the check-in should sound, handed to the drafter.
  voice: "",
  // Matt's 15 (2026-10-15): once a week, his best agents' check-ins drafted
  // for him to make his own and send. Off by default.
  mattsFifteen: { enabled: false, size: 15, weekday: 1, hour: 8 },
};
export const AGENT_PULSE_VOICE_MAX = 600;
// 0 means no cap (Matt, 2026-10-05: "there should be no caps"): every agent
// due a check-in gets one that day. The per-agent spacing still holds.
export const AGENT_PULSE_MAX_DAILY_CAP = 5000;

/**
 * normalizeAgentPulse(v) → settings, every switch off by default.
 *
 * `enabled` drafts the day's check-ins into the outbox; `autoSend` lets a
 * draft the money guard passed go on its own. Lives at
 * settings.outreachAutopilot.pulse — outside the autonomy dial, like the
 * buyer pulse, so switching it on never moves the dial.
 */
export function normalizeAgentPulse(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const D = AGENT_PULSE_DEFAULTS;
  const idList = (v) => [...new Set((Array.isArray(v) ? v : String(v || "").split(/[\s,]+/))
    .map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 20);
  const ids = idList(o.quietWorkflowIds);
  return {
    enabled: o.enabled === true,
    autoSend: o.autoSend === true,
    thanksAutoSend: o.thanksAutoSend === true,
    dailyCap: clamp(o.dailyCap, D.dailyCap, 0, AGENT_PULSE_MAX_DAILY_CAP),
    everyDays: clamp(o.everyDays, D.everyDays, 7, 90),
    quietDays: clamp(o.quietDays, D.quietDays, 2, 30),
    freshDays: clamp(o.freshDays, D.freshDays, 1, 60),
    listingSeenDays: clamp(o.listingSeenDays, D.listingSeenDays, 3, 90),
    coldEveryDays: clamp(o.coldEveryDays, D.coldEveryDays, 30, 180),
    coldMaxUnanswered: clamp(o.coldMaxUnanswered, D.coldMaxUnanswered, 1, 6),
    engagedMaxUnanswered: clamp(o.engagedMaxUnanswered, D.engagedMaxUnanswered, 0, 20),
    hour: clamp(o.hour, D.hour, 8, 17),
    weekdaysOnly: o.weekdaysOnly !== false,
    ghlWorkflowDays: clamp(o.ghlWorkflowDays, D.ghlWorkflowDays, 0, 90),
    quietWorkflowIds: ids,
    replacesWorkflowIds: idList(o.replacesWorkflowIds),
    voice: String(o.voice || "").trim().slice(0, AGENT_PULSE_VOICE_MAX),
    mattsFifteen: normalizeMattsFifteen(o.mattsFifteen),
  };
}

/**
 * normalizeMattsFifteen(v) → { enabled, size, weekday, hour }
 *
 * `weekday` is 0 (Sunday) … 6 in Pacific time, Monday by default; `hour` the
 * Pacific hour the drafts are written, before his day starts.
 */
export function normalizeMattsFifteen(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const D = AGENT_PULSE_DEFAULTS.mattsFifteen;
  return {
    enabled: o.enabled === true,
    size: clamp(o.size, D.size, 1, 40),
    weekday: clamp(o.weekday, D.weekday, 0, 6),
    hour: clamp(o.hour, D.hour, 6, 17),
  };
}

// Event types the pulse reads for one agent (the runner asks for exactly these).
export const AGENT_PULSE_EVENT_TYPES = [
  "text_summary", "call_summary", "follow_up_sent", "hand_reply", "unsubscribed",
  "promise_made", "promise_owed", "promise_kept",
  "checkin_requested", "checkin_sent", "address_pending", "address_pending_closed", "subject_property_set", "address_chase_sent",
  "outreach_enrolled", "outreach_sent", "outreach_left", "workflow_enrolled", "workflow_left", "investor_minded",
  "drive_stopped", "drive_resumed", "listing_off_market", "listing_back_on_market", "offer_sent",
  "offmarket_asked",
  // Houses passed or kicked off the Tier 1 list: never raised again.
  "tier1_passed", "tier1_kicked", "tier1_added",
  // A house they named that we never priced: the one thing a check-in may
  // ask about (2026-10-15, checkInHook).
  "house_mentioned",
];
export const AGENT_PULSE_LEDGER_TYPES = ["agent_pulse_sent", "agent_pulse_texted", "agent_pulse_voided", "listing_pinged", "listing_ping_voided", "agent_pulse_joined"];
// What counts as them having written back (store.lastContactActivity with
// inboundOnly — a text summary only when it summarises THEIR text).
export const INBOUND_EVENT_TYPES = [
  "text_summary", "call_summary", "agent_estimate", "property_details", "realm_yes", "realm_no",
  "checkin_requested", "address_pending", "outreach_left", "email_received",
];
// Every text of ours the timeline knows about.
const OUR_TEXT_TYPES = new Set(["follow_up_sent", "agent_pulse_texted", "outreach_enrolled", "outreach_sent", "hand_reply", "checkin_sent", "address_chase_sent"]);

// Tags that mean "do not text", however spelled, and the bot-off tags.
const BLOCK_TAG_RX = /^(?:dnc|dnd|do[-\s]?not[-\s]?(?:contact|text|call)|opt(?:ed)?[-\s]?out|unsubscribed?|stop|wrong[-\s]?number)$/i;
export function blockedByTags(tags = [], botOffTags = []) {
  const off = new Set((botOffTags || []).map((t) => String(t).toLowerCase()));
  return (tags || []).map((t) => String(t).trim()).find((t) => BLOCK_TAG_RX.test(t) || off.has(t.toLowerCase())) || null;
}

/**
 * listingDistressed(doc, rule) — the pull's own reading: a listing that
 * passed the sweep's filters and is distressed by the agent row's rule
 * (routes/outreach.js: "cut-or-cheap" needs a price cut or a cheap $/sqft,
 * "cut-or-old" a price cut or a house built before 1980 — OLD_HOUSE_YEAR in
 * ghl-broker/outreach-score.js).
 */
export function listingDistressed(doc = {}, rule = null) {
  if (!doc?.qualifies) return false;
  // Came off the market lately without selling (the off-market pull): that is the distress.
  if (doc.offMarket === true) return true;
  const d = doc.distress || {};
  if (rule === "cut-or-old") {
    const y = Number(doc.yearBuilt) || 0;
    return Boolean(d.cut || d.old || (y > 1800 && y < 1980));
  }
  return rule === "cut-or-cheap" ? Boolean(d.cut || d.cheap) : Boolean(d.stale || d.cut || d.cheap);
}

/**
 * agentSegment({ offers, lastInboundAt }) → "partner" | "source" | "engaged" | "cold"
 *
 * "source" (2026-10-09): they brought us a house we never texted them about
 * (offer.leadSource, shared/lead-source.js) — how every off-market deal with
 * a committed buyer came. Ranked with partners, and never dropped for silence.
 */
export function agentSegment({ offers = [], lastInboundAt = null } = {}) {
  if ((offers || []).some((o) => o && (o.deal || priceAgreed(o) || o.realm?.answer === "yes"))) return "partner";
  if ((offers || []).some((o) => o && broughtUs(o))) return "source";
  // An offer only their answer could have moved (they passed, countered, it
  // sold) is a reply, even when the timeline doesn't hold their text — the
  // tiers read it the same way (shared/tiers.js).
  return lastInboundAt || (offers || []).some(offerHasTheirAnswer) ? "engaged" : "cold";
}
const broughtUs = (o) => o.leadSource?.source === "agent_brought" || o.autoUnderwrite?.leadSource === "agent_brought";
const TOP_SEGMENTS = new Set(["partner", "source"]);

/**
 * agentStops({ drafts, events, tags, botOffTags, now }) → reason | null
 *
 * What stops the pulse for good (until it changes): they opted out, you
 * stopped the thread, they sound annoyed, a do-not-text or bot-off tag. A
 * house they passed on, or one that sold, is not a reason to stop talking to
 * the agent — those are the house's.
 */
export function agentStops({ drafts = [], events = [], tags = [], botOffTags = [], now = Date.now() } = {}) {
  if ((events || []).some((e) => e?.type === "unsubscribed")) return "they opted out";
  const inbound = [
    ...(drafts || []).filter((d) => String(d?.inbound || "").trim()).map((d) => ({ at: d.createdAt, text: d.inbound, intent: d.intent })),
    ...(events || []).filter((e) => e?.type === "text_summary" && String(e.data?.inbound || "").trim()).map((e) => ({ at: e.at, text: e.data.inbound, intent: e.data?.intent })),
  ].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  if (inbound.some((m) => m.intent === "opt_out")) return "they opted out";
  const tag = blockedByTags(tags, botOffTags);
  if (tag) return `tagged "${tag}"`;
  // A stop on the whole thread (no house named), until Resume or the
  // pause's date (shared/bot-hold.js).
  const hold = botHold({ events, wholeThreadOnly: true, now });
  if (hold.held) return hold.kind === "paused" ? "you paused the thread" : "you stopped the thread";
  if (inbound.slice(0, 3).some((m) => IRRITATED_RX.test(m.text))) return "they sound annoyed";
  return null;
}

// GHL's TIER 1 / TIER 2 / TIER 3 workflows (the playbook's tier rules enroll
// agents in them) move the agent's Acquisitions card and send nothing; the
// tier texts were the separate "Tier 2+3 nurture" (2026-09-30), since put to
// Draft. An enrollment in one held the agent for 21 days with no text coming:
// 165 agents on 2026-10-09, 72 of them with an offer from us.
export const CARD_ONLY_WORKFLOW_RX = /^\s*tier\s*[123]\s*$/i;

// A number a person priced and never sent is theirs to send for a week; after
// that it is not a conversation the agent is waiting on.
export const UNSENT_STALE_DAYS = 7;

/**
 * openOfferIdle({ offer, drafts, events, config, now }) → reason | null
 *
 * An open offer with nothing coming on it and nothing to wait for. Matt,
 * 2026-10-09: every agent with an offer, sent or just drafted, is followed up
 * regularly — on the offer, or for their next off-market house. Two kinds of
 * open offer held the agent for good with nothing coming:
 *   - a no the machine stands down on. The first no asks what the seller
 *     would take and keeps the offer open; when that goes unanswered nothing
 *     moves it again (four on 2026-10-09, the oldest from 9/24);
 *   - a priced number a person never sent, a week on (seven, back to July).
 * Either way the agent check-in asks for their next one.
 *
 * 2026-10-14: the Line still listed open offers the machine had stood down on
 * 8–13 days back, and others where the agent wrote and nothing answered it.
 * Any offer with nothing coming — the push to paper ran out, a reply nobody
 * answered, follow-ups switched off, you stopped the bot on that house — lets
 * the agent go once there has been no text either way for STOOD_DOWN_QUIET_DAYS.
 * A text this week, an offer made this week, a person on the thread, a pause
 * with a date, or anything still coming on the offer — a nudge, the push to
 * paper, a float, a promise, a reply held this week — keeps the agent with it.
 * `drafts` are read with stale held rows forgotten (forgetStaleHeld).
 */
export const STOOD_DOWN_QUIET_DAYS = 7;
// The safety net (2026-10-16): an open offer whose machine clock claims a
// step is coming, but hasn't fired once in this long (since its last step, or
// since our number went out), with no word either way in that time, doesn't
// hold the agent — that clock isn't running. A pause with a date, a person on
// the thread, or a clock that is firing still holds them.
export const SILENT_OPEN_DAYS = 14;
const MACHINE_CLOCKS = new Set(["offer_nudge", "hot_push", "passed_checkin"]);
function clockStalled({ offer, next, now }) {
  // Whoever sends the step (the machine, or a draft for you), one that never
  // fires is the same stall.
  if (!MACHINE_CLOCKS.has(next.kind)) return false;
  const fired = (offer.followUps || []).filter((f) => f?.kind === next.kind).map((f) => ms(f.at)).filter((t) => t != null);
  const presented = [offer.floatSentAt, offer.proactive?.realmCheckAt, ...(offer.sends || []).map((x) => x?.ts || x?.at)].map(ms).filter((t) => t != null);
  const since = fired.length ? Math.max(...fired) : presented.length ? Math.min(...presented) : null;
  return since != null && now - since >= SILENT_OPEN_DAYS * DAY_MS;
}
export function openOfferIdle({ offer, drafts = [], events = [], config = {}, lastInboundAt = null, now = Date.now() } = {}) {
  if (!offer) return null;
  const list = forgetStaleHeld(drafts, now);
  const next = nextFollowUp({ offer, drafts: list, events, config, now });
  const stoodDown = next.kind === "none" || (next.kind === "stopped" && !next.until);
  if (!stoodDown) {
    if (clockStalled({ offer, next, now })) {
      const lastAny = lastWordAt({ offer, drafts: list, events, lastInboundAt });
      if ((lastAny == null || now - lastAny >= SILENT_OPEN_DAYS * DAY_MS)
          && threadHealth({ offer, drafts: list, events, now }).reason !== "person_has_it") {
        return `its ${next.kind.replace(/_/g, " ")} hasn't gone in ${SILENT_OPEN_DAYS} days and nobody has texted either way`;
      }
    }
    if (next.kind === "float" && next.who === "you" && next.at && now - (ms(next.at) ?? now) > UNSENT_STALE_DAYS * DAY_MS) {
      return "our number never went out";
    }
    return null;
  }
  const h = threadHealth({ offer, drafts: list, events, now });
  if (next.kind === "none" && !h.drive && HOUSE_OVER_REASONS.has(h.reason)) return `the machine stands down: ${h.detail}`;
  if (h.reason === "person_has_it") return null;
  const last = lastWordAt({ offer, drafts: list, events, lastInboundAt });
  if (last != null && now - last < STOOD_DOWN_QUIET_DAYS * DAY_MS) return null;
  return `nothing coming on it and no text for ${STOOD_DOWN_QUIET_DAYS} days: ${next.reason || next.label}`;
}

/**
 * forgetStaleHeld(drafts, now) → drafts
 *
 * A held reply or a person's draft a week old (shared/follow-up.js staleHeld)
 * is not something the agent is waiting on: it stays on the Desk, and the
 * pulse reads it as set aside. Their text in it still counts as their text.
 */
export function forgetStaleHeld(drafts = [], now = Date.now()) {
  return (drafts || []).map((d) => (staleHeld(d, now) ? { ...d, status: "set_aside" } : d));
}

// Any text either way with this agent, or anything done on the offer itself.
const WORD_EVENT_TYPES = new Set([...OUR_TEXT_TYPES, "text_summary", "call_summary", "email_received", "offer_sent"]);
function lastWordAt({ offer = {}, drafts = [], events = [], lastInboundAt = null } = {}) {
  const times = [
    lastInboundAt, offer.createdAt, offer.statusAt, offer.proactive?.realmCheckAt, offer.proactive?.takeCheckAt, offer.floatSentAt,
    ...(offer.sends || []).map((s) => s?.ts || s?.at),
    ...(offer.followUps || []).map((f) => f?.at),
    ...(drafts || []).filter((d) => d && (d.status === "sent" || String(d.inbound || "").trim())).map((d) => (d.status === "sent" ? d.sentAt || d.updatedAt || d.createdAt : d.createdAt)),
    ...(events || []).filter((e) => e && WORD_EVENT_TYPES.has(e.type)).map((e) => e.at),
  ].map(ms).filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}

/**
 * offerOwner({ offers, drafts, events, config, lastInboundAt, now }) → owner | null
 *
 * The offer clocks alone: a live deal, a held underwrite, an open offer, or
 * whatever clock the Offers column says is coming on one. A lead check-in
 * (promise-sweep.js) waits behind these and goes after.
 */
export function offerOwner({ offers = [], drafts: allDrafts = [], events = [], config = {}, lastInboundAt = null, now = Date.now() } = {}) {
  // A held draft owns the agent for a week, not for good (forgetStaleHeld).
  const drafts = forgetStaleHeld(allDrafts, now);
  // Offers first: a live deal, an open offer, and whatever clock the Offers
  // column says is coming on each (the same answer, from the same code).
  for (const o of offers || []) {
    if (!o) continue;
    if (o.deal && !dealIsOver(o.deal)) return "a live deal";
    const status = effectiveStatus(o);
    // A held underwrite on a house they gave us: we owe them a number, and
    // the nightly triage (held-underwrites) asks or retires it within 14 days.
    if (o.status === "draft") {
      if (now - (ms(o.createdAt) ?? 0) < 14 * DAY_MS) return "a held underwrite";
      continue;
    }
    if (OPEN_STATUSES.has(status) && !o.deal) {
      if (openOfferIdle({ offer: o, drafts, events, config, lastInboundAt, now })) continue;
      return "an open offer";
    }
    const next = nextFollowUp({ offer: o, drafts, events, config, now });
    if (["queued", "reply_owed", "promise", "checkin_due", "float", "offer_nudge", "hot_push", "passed_checkin"].includes(next.kind)) {
      return String(next.label || next.kind).toLowerCase();
    }
  }
  return null;
}

/**
 * agentOwner({ offers, drafts, events, config, settings, outreachFollowUpDays, outreachFollowUpOn, lastInboundAt, now }) → owner | null
 *
 * The clock that has this agent right now, in words, or null when nothing
 * does. `offers` are this agent's CURRENT rows (shared/current-offer.js).
 * `outreachFollowUpOn`: outreachAutopilot.followUpEnabled.
 */
export function agentOwner({ offers = [], drafts: allDrafts = [], events = [], config = {}, settings = {}, outreachFollowUpDays = 14, outreachFollowUpOn = true, lastInboundAt = null, now = Date.now() } = {}) {
  const s = normalizeAgentPulse(settings);
  // A held draft owns the agent for a week, not for good (forgetStaleHeld).
  const drafts = forgetStaleHeld(allDrafts, now);
  const held = offerOwner({ offers, drafts, events, config, lastInboundAt, now });
  if (held) return held;
  // Anything waiting in the outbox: one voice at a time.
  const open = (drafts || []).filter((d) => d && (d.status === "draft" || d.status === "scheduled"));
  if (open.length) return threadTimes(drafts).heldSince ? "their text is waiting on you" : "a text is waiting in the outbox";
  const byTime = [...(events || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const after = (e, t) => String(e.at) > String(t);
  // A promise we made, still inside its window.
  const kept = byTime.filter((e) => e.type === "promise_kept").at(-1)?.at || "";
  if (byTime.some((e) => e.type === "promise_made" && after(e, kept) && now - (ms(e.at) ?? 0) < 72 * HOUR_MS)) return "a promise we made";
  // A check-in they asked for, not yet sent or answered.
  const req = byTime.filter((e) => e.type === "checkin_requested" && e.data?.kind !== "lead").at(-1);
  if (req && requestStands(req, now) && !byTime.some((e) => e.type === "checkin_sent" && e.data?.requestAt === req.at)
      && !byTime.some((e) => (e.type === "text_summary" || e.type === "call_summary") && after(e, req.at))) return "a check-in they asked for";
  // A lead they told us the timing of ("relisting in the spring") has them
  // only in the run-up to its day, so the two texts don't land together.
  // Further out the regular check-in keeps its clock (Matt: every agent who
  // replied hears from us every few weeks) and stays generic; the lead's own
  // check-in still goes on its day (promise-sweep.js).
  const lead = leadCheckInPending(byTime, now);
  if (lead && (ms(lead.data?.dueAt) ?? 0) - now <= s.everyDays * DAY_MS) return "a lead they told us about";
  // A property they said was coming, still being chased.
  const pending = byTime.filter((e) => e.type === "address_pending").at(-1);
  if (pending && now - (ms(pending.at) ?? 0) < 32 * DAY_MS
      && !byTime.some((e) => (e.type === "address_pending_closed" || e.type === "subject_property_set") && after(e, pending.at))) return "an address chase";
  // The outreach workflows: the first text and its follow-up are GHL's.
  const left = byTime.filter((e) => e.type === "outreach_left").at(-1)?.at || "";
  const first = byTime.filter((e) => e.type === "outreach_enrolled" && e.data?.kind !== "followup").at(-1);
  const fu = byTime.filter((e) => e.type === "outreach_enrolled" && e.data?.kind === "followup").at(-1);
  // With the GHL follow-up switched off (2026-10-16) its enrollments text
  // nobody: the app's nudge has that cohort, then this check-in does.
  if (outreachFollowUpOn && fu && after(fu, left) && now - (ms(fu.at) ?? 0) < s.ghlWorkflowDays * DAY_MS) return "the outreach follow-up workflow";
  if (first && !fu && after(first, left) && now - (ms(first.at) ?? 0) < (outreachFollowUpDays + 2) * DAY_MS) return "the outreach workflow";
  // Any other GHL workflow the app put them in, unless it's known not to text
  // or it's a drip this check-in replaces (the TIER 2/3 check-ins).
  const quiet = new Set([...s.quietWorkflowIds, ...s.replacesWorkflowIds]);
  for (const w of byTime.filter((e) => e.type === "workflow_enrolled" && !quiet.has(String(e.data?.workflowId || ""))
      && !CARD_ONLY_WORKFLOW_RX.test(String(e.data?.workflowName || "")))) {
    const out = byTime.some((e) => e.type === "workflow_left" && e.data?.workflowId === w.data?.workflowId && after(e, w.at));
    if (!out && now - (ms(w.at) ?? 0) < s.ghlWorkflowDays * DAY_MS) return `a GHL workflow${w.data?.workflowName ? ` (${String(w.data.workflowName).slice(0, 40)})` : ""}`;
  }
  // A thread you picked up is yours for a few days.
  const byHand = byTime.some((e) => e.type === HAND_REPLY_EVENT && now - (ms(e.at) ?? 0) <= PERSON_HAS_IT_DAYS * DAY_MS)
    || (drafts || []).some((d) => d?.answeredBy === "you" && now - (ms(d.updatedAt || d.createdAt) ?? 0) <= PERSON_HAS_IT_DAYS * DAY_MS);
  if (byHand) return "you have the thread";
  return null;
}

/**
 * freshListingFor({ listings, pinged, raised, houses, settings, now }) → listing | null
 *
 * The best distressed listing of theirs we first saw lately and they still
 * have up: not one we've raised with them, not a house we already have a
 * live offer on, not one we walked away from.
 */
export function freshListingFor({ listings = [], pinged = new Set(), raised = [], houses = {}, settings = {}, now = Date.now() } = {}) {
  const s = normalizeAgentPulse(settings);
  const live = houses.live || new Set();
  const walked = houses.walked || new Map();
  const ok = (listings || []).filter((l) => {
    if (!l?.listingKey || pinged.has(l.listingKey)) return false;
    if (!listingDistressed(l.doc, l.distressRule)) return false;
    if (now - (ms(l.firstSeen) ?? 0) > s.freshDays * DAY_MS) return false;
    if (now - (ms(l.lastSeen) ?? 0) > s.listingSeenDays * DAY_MS) return false;
    const k = addressKey(l.doc?.address || "");
    if (!k || live.has(k)) return false;
    // Spelled however the opener spelled it: same number, same street.
    if ((raised || []).some((r) => sameStreet(r, l.doc?.address || ""))) return false;
    const w = walked.get(k);
    if (w && now - (ms(w) ?? 0) < 180 * DAY_MS) return false;
    return true;
  });
  ok.sort((a, b) => (Number(b.doc?.score) || 0) - (Number(a.doc?.score) || 0) || String(b.firstSeen).localeCompare(String(a.firstSeen)));
  return ok[0] || null;
}

/**
 * ourHouseFor({ offers, drafts, events, config, now }) → offer | null
 *
 * Their newest house with us whose clocks have ended: they passed (or went
 * quiet) and the check-ins are done or it went off the market, or the deal
 * closed. Never a house WE walked away from, and never a deal that fell
 * through — nobody is checked in with about that (5232 S Yakima, 2026-10-03).
 */
export function ourHouseFor({ offers = [], drafts = [], events = [], config = {}, now = Date.now() } = {}) {
  const ended = (offers || []).filter((o) => {
    if (!o) return false;
    if (o.deal) return dealIsOver(o.deal) && o.deal.stage !== "fell_through";
    const status = effectiveStatus(o);
    if (status === "we_passed" || !DEAD_STATUSES.has(status)) return false;
    const next = nextFollowUp({ offer: o, drafts, events, config, now });
    return next.kind === "none" || next.kind === "stopped" || next.kind === "unavailable";
  });
  return ended.sort((a, b) => String(b.statusAt || b.createdAt || "").localeCompare(String(a.statusAt || a.createdAt || "")))[0] || null;
}

// How long after a close the thank-you is still timely.
export const DEAL_THANKS_DAYS = 30;
// Give the close a couple of days to settle before the bot says anything.
const DEAL_THANKS_AFTER_DAYS = 2;
const CLOSED_STAGES = new Set(["closed", "assigned"]);

/**
 * dealToThank({ offers, events, ledger, now }) → the offer (with closedAt) | null
 *
 * Matt, 2026-10-09: after Vashon closed, Matt's "let me know if you get any
 * fixers across your desk" and the check-in that followed brought the next
 * house (4747 46th). A deal of theirs that closed in the last
 * DEAL_THANKS_DAYS, with no text of ours since the close (yours counts: a
 * thank-you you sent by hand is the thank-you) and no thank-you check-in on
 * it yet.
 */
export function dealToThank({ offers = [], events = [], ledger = [], now = Date.now() } = {}) {
  const closedAt = (o) => (o.deal?.stageHistory || []).filter((h) => CLOSED_STAGES.has(h?.stage)).map((h) => h.ts || h.at).filter(Boolean).sort().at(-1)
    || o.deal?.closedAt || o.deal?.updatedAt || o.statusAt || null;
  const thanked = new Set((ledger || []).filter((e) => e?.type === "agent_pulse_sent" && e.data?.reason === "deal_thanks" && e.address).map((e) => addressKey(e.address)));
  const ourTexts = (events || []).filter((e) => OUR_TEXT_TYPES.has(e?.type)).map((e) => ms(e.at)).filter((t) => t != null);
  const due = (offers || []).filter((o) => o?.deal && CLOSED_STAGES.has(o.deal.stage) && o.address).map((o) => ({ ...o, closedAt: closedAt(o) })).filter((o) => {
    const t = ms(o.closedAt);
    if (t == null || now - t > DEAL_THANKS_DAYS * DAY_MS || now - t < DEAL_THANKS_AFTER_DAYS * DAY_MS) return false;
    if (thanked.has(addressKey(o.address))) return false;
    return !ourTexts.some((x) => x > t);
  });
  return due.sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))[0] || null;
}

/**
 * tierCard(agent) → { tier: "t2" | "t3", movedAt } | null
 *
 * Matt, 2026-10-09: "there is no outreach going out now from tiers 2 and 3
 * and we need to be doing everything from the app" — the "Tier 2+3 nurture"
 * drip is off. Every agent on a Tier 2 or Tier 3 card hears from the
 * check-in, the first time `everyDays` after the day the card moved there.
 */
export function tierCard(agent = {}) {
  const c = agent?.ghlTier;
  return c && (c.tier === "t2" || c.tier === "t3") ? { tier: c.tier, movedAt: c.movedAt || null } : null;
}

/**
 * checkInSlot(contactId, days) → 0 … days-1
 *
 * A slot of its own for an agent, the same every time it's asked: FNV-1a of
 * the contact id. What spreads a crowd that joins the check-in at once.
 */
export function checkInSlot(contactId = "", days = 21) {
  const n = Math.max(1, Math.round(Number(days)) || 1);
  let h = 0x811c9dc5;
  for (const ch of String(contactId || "")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % n;
}

const pacificWeekday = (t) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(new Date(t));
const isWeekend = (t) => { const d = pacificWeekday(t); return d === "Sat" || d === "Sun"; };

/**
 * firstCheckInAt({ contactId, joinedAt, everyDays }) → ISO | null
 *
 * When an agent who joined the check-in on `joinedAt` gets their first one:
 * their own weekday (Pacific) within the `everyDays` from it. The run is
 * weekdays only, so a weekend slot would only pile onto Monday. Null without
 * a join date.
 */
export function firstCheckInAt({ contactId = "", joinedAt = null, everyDays = 21 } = {}) {
  const t = ms(joinedAt);
  if (t == null) return null;
  const n = Math.max(1, Math.round(Number(everyDays)) || 1);
  const workdays = [];
  for (let d = 0; d < n; d++) if (!isWeekend(t + d * DAY_MS)) workdays.push(d);
  if (!workdays.length) return iso(t);
  return iso(t + workdays[checkInSlot(contactId, workdays.length)] * DAY_MS);
}

// A check-in about a listing of theirs: a fresh one, or one that came off the
// market lately without selling (2026-10-15, "off_market_listing": the text
// asks whether the seller still hopes to sell).
export const LISTING_REASONS = new Set(["fresh_listing", "off_market_listing"]);
const listingReason = (listing) => (listing?.doc?.offMarket === true ? "off_market_listing" : "fresh_listing");

/**
 * evaluateAgent(agent, ctx) → { status, reason, segment, pulseReason, listing, house, priority }
 *
 *   agent  { contactId, name, tags, offers (all), current (current rows),
 *            drafts, events, ledger, lastInboundAt, listings, facts,
 *            joinedAt, joinedByReply }
 *   ctx    { settings, config, houses, outreachFollowUpDays, outreachFollowUpOn, now }
 *
 * status: "stopped" | "owned" | "not_due" | "cold_dropped" | "due".
 */
export function evaluateAgent(agent = {}, { settings = {}, config = {}, houses = {}, outreachFollowUpDays = 14, outreachFollowUpOn = true, now = Date.now() } = {}) {
  const s = normalizeAgentPulse(settings);
  const out = (status, reason, more = {}) => ({ contactId: agent.contactId, status, reason, ...more });
  const drafts = agent.drafts || [];
  const events = agent.events || [];
  const ledger = agent.ledger || [];

  const stop = agentStops({ drafts, events, tags: agent.tags || [], botOffTags: config?.routing?.botOffTags || [], now });
  if (stop) return out("stopped", stop);
  const owner = agentOwner({ offers: agent.current || [], drafts, events, config, settings: s, outreachFollowUpDays, outreachFollowUpOn, lastInboundAt: agent.lastInboundAt, now });
  if (owner) return out("owned", owner);

  // Where they stand with us, and how many of our check-ins met silence.
  let segment = agentSegment({ offers: agent.offers || agent.current || [], lastInboundAt: agent.lastInboundAt });
  // An agent who talks like an investor is a source before they've sent a
  // house (shared/lead-source.js investorMindedCue).
  if ((segment === "engaged" || segment === "cold") && events.some((e) => e?.type === "investor_minded")) segment = "source";
  const voided = new Set(ledger.filter((e) => e.type === "agent_pulse_voided").map((e) => e.data?.claimKey || e.ref).filter(Boolean));
  const texted = ledger.filter((e) => e.type === "agent_pulse_texted" && (!agent.lastInboundAt || String(e.at) > String(agent.lastInboundAt)));
  const unanswered = texted.length;
  const downgraded = segment !== "cold" && segment !== "source" && s.engagedMaxUnanswered > 0 && unanswered >= s.engagedMaxUnanswered;
  const lastPulseAt = latest(ledger.filter((e) => e.type === "agent_pulse_sent" && !voided.has(e.dedupeKey)).map((e) => e.at));
  const lastTouchAt = latest(events.filter((e) => OUR_TEXT_TYPES.has(e.type)).map((e) => e.at));
  // Their card in GHL's Tier 2 or Tier 3 (agent.ghlTier, read off the
  // Acquisitions board): the check-in comes `everyDays` after the day they
  // moved there, or after our last word, whichever is later.
  const card = tierCard(agent);
  const since = latest([lastTouchAt, agent.lastInboundAt, lastPulseAt, card?.movedAt]);
  // Check in less / more with them (shared/bot-hold.js): the three weeks and
  // the cold pings stretch or shrink; the quiet days after any text only grow.
  const { rung, floor } = paceScale(paceOf({ events }).factor);
  // How often they asked to hear from us (fact checkinEvery, read off their
  // own words by shared/brush-offs.js): "every 2–3 months", "you're on my
  // email list", "I have enough wholesalers". Every wait is at least that
  // long, a fresh listing of theirs included (2026-10-14: an agent who asked
  // for every two or three months heard from us a month later).
  const asked = cadenceDays(agent.facts);
  const everyDays = Math.max(Math.round(s.everyDays * rung), asked);
  const coldEveryDays = Math.max(Math.round(s.coldEveryDays * rung), asked);
  const quietDays = Math.max(Math.round(s.quietDays * floor), asked);
  const waitWhy = (days, plain) => (asked && days === asked ? `they asked for a check-in every ${asked} days` : plain);
  const quietFor = (days) => !since || now - (ms(since) ?? 0) >= days * DAY_MS;
  // When a wait ends, for the plan's per-agent list.
  const after = (t, days) => (ms(t) == null ? null : new Date(ms(t) + days * DAY_MS).toISOString());

  const pinged = new Set(ledger.filter((e) => e.type === "listing_pinged").map((e) => e.data?.listingKey).filter(Boolean));
  for (const e of ledger) if (e.type === "listing_ping_voided" && e.data?.listingKey) pinged.delete(e.data.listingKey);
  // A listing the outreach opener already asked them about (the workflow's
  // first text, or the app's) is not news.
  const raised = events.filter((e) => (e.type === "outreach_enrolled" && e.data?.kind !== "followup") || e.type === "outreach_sent")
    .map((e) => String(e.address || "")).filter(Boolean);
  const listing = freshListingFor({ listings: agent.listings || [], pinged, raised, houses, settings: s, now });

  // An agent we've made an offer to, sent or just drafted, is followed up
  // like one who wrote back — the next one is the point, not that house —
  // until `coldMaxUnanswered` check-ins have met silence (Matt, 2026-10-09:
  // "every single agent who has an offer"). Then the cold rule has them.
  // The same goes for an agent on a Tier 2 or Tier 3 card: GHL's nurture
  // drip is off and the app does all of it (Matt, 2026-10-09).
  const offered = segment === "cold" && ((agent.offers || agent.current || []).some(Boolean) || Boolean(card)) && unanswered < s.coldMaxUnanswered;
  if ((segment === "cold" && !offered) || downgraded) {
    const coldSeg = segment === "cold" ? "cold" : `${segment} gone quiet`;
    if (unanswered >= s.coldMaxUnanswered + (downgraded ? s.engagedMaxUnanswered : 0)) {
      return out("cold_dropped", `${unanswered} check-ins with nothing back`, { segment: coldSeg });
    }
    if (!listing) return out("not_due", "only a new listing of theirs is a reason to text", { segment: coldSeg });
    const lastPing = latest(texted.map((e) => e.at));
    if (lastPing && now - (ms(lastPing) ?? 0) < coldEveryDays * DAY_MS) return out("not_due", waitWhy(coldEveryDays, `pinged within ${coldEveryDays} days`), { segment: coldSeg, dueAt: after(lastPing, coldEveryDays) });
    if (!quietFor(quietDays)) return out("not_due", waitWhy(quietDays, `touched within ${quietDays} days`), { segment: coldSeg, dueAt: after(since, quietDays) });
    return out("due", "", { segment: coldSeg, pulseReason: listingReason(listing), listing, priority: [4, -(Number(listing.doc?.score) || 0)] });
  }

  const tier = TOP_SEGMENTS.has(segment) ? 0 : 1;
  // A deal of theirs just closed: thank them and ask for the next one, ahead
  // of everything else today.
  const thanks = dealToThank({ offers: agent.offers || agent.current || [], events, ledger, now });
  if (thanks) return out("due", "", { segment, pulseReason: "deal_thanks", house: thanks, priority: [-1, -(ms(thanks.closedAt) ?? 0)] });
  if (listing && quietFor(quietDays)) {
    return out("due", "", { segment, pulseReason: listingReason(listing), listing, priority: [tier, -(Number(listing.doc?.score) || 0)] });
  }
  if (!quietFor(everyDays)) return out("not_due", waitWhy(everyDays, card && since === card.movedAt ? `moved to Tier ${card.tier.slice(1)} within ${everyDays} days` : `talked within ${everyDays} days`), { segment, dueAt: after(since, everyDays) });
  // Joined the check-in long after their last word (the repliers, 2026-10-14):
  // the first one lands on their own day in the next `everyDays`, not all on
  // the morning they joined. Only the first: once checked in on, or once
  // anyone has talked since, the clock above decides.
  // `joinedAt`: the runner's agent_pulse_joined, or the replier backfill's
  // run. One who joined by their reply and isn't written down yet joins
  // today, so a preview spreads them from today, as the next run will.
  // A ping we sent them as a cold agent before they joined is not the clock:
  // the pool agents whose old reply the backfill found (2026-10-16) had
  // those, and are spread like every other joiner.
  const joinedAt = agent.joinedAt || (agent.joinedByReply ? iso(now) : null);
  const onClock = (e) => !(e.data?.segment === "cold" && String(e.at) <= String(joinedAt));
  const clockPulse = ledger.some((e) => e.type === "agent_pulse_sent" && !voided.has(e.dedupeKey) && onClock(e));
  const firstAt = firstCheckInAt({ contactId: agent.contactId, joinedAt, everyDays });
  if (firstAt && !clockPulse && !texted.some(onClock) && !(since && String(since) > String(joinedAt)) && now < ms(firstAt)) {
    return out("not_due", `joined the check-in; first one spread over ${everyDays} days`, { segment, dueAt: firstAt });
  }
  const house = ourHouseFor({ offers: agent.current || [], drafts, events, config, now });
  const overdue = since ? now - (ms(since) ?? 0) : Infinity;
  return out("due", "", { segment, pulseReason: house ? "our_house" : "general", house, priority: [2 + tier, -overdue] });
}

/**
 * pickPulseAgents({ agents, settings, config, houses, outreachFollowUpDays, seats, now }) → { picks, counts }
 *
 * The day's check-ins, best first: fresh listings of partners and engaged
 * agents, then partners and engaged agents who are due (most overdue first),
 * then cold agents' fresh listings (best listing first). `seats` is what is
 * left of the day's cap.
 */
export function pickPulseAgents({ agents = [], settings = {}, config = {}, houses = {}, outreachFollowUpDays = 14, outreachFollowUpOn = true, seats = null, now = Date.now() } = {}) {
  const s = normalizeAgentPulse(settings);
  const counts = {
    pool: agents.length, bySegment: { partner: 0, source: 0, engaged: 0, cold: 0 }, stopped: {}, owned: {}, notDue: 0, coldDropped: 0,
    due: { deal_thanks: 0, fresh_listing: 0, off_market_listing: 0, our_house: 0, general: 0 }, dueNoSeat: 0,
    fresh: { withListing: 0 }, coverage: { touched: 0, pool: 0 },
    ghlTier: { t2: 0, t3: 0, due: 0 },
  };
  const due = [];
  // One line per agent (no names): what the check-in will do and when.
  const verdicts = [];
  for (const a of agents) {
    const v = evaluateAgent(a, { settings: s, config, houses, outreachFollowUpDays, outreachFollowUpOn, now });
    const card = tierCard(a);
    if (card) { counts.ghlTier[card.tier]++; if (v.status === "due") counts.ghlTier.due++; }
    verdicts.push({ contactId: a.contactId, status: v.status, reason: v.reason || v.pulseReason || "", segment: v.segment || null,
      dueAt: v.status === "due" ? iso(now) : v.dueAt || null, tier: card?.tier || null, movedAt: card?.movedAt || null });
    const seg = agentSegment({ offers: a.offers || a.current || [], lastInboundAt: a.lastInboundAt });
    counts.bySegment[seg]++;
    if (seg !== "cold") {
      counts.coverage.pool++;
      const touched = latest([
        ...(a.events || []).filter((e) => OUR_TEXT_TYPES.has(e.type)).map((e) => e.at),
        ...(a.ledger || []).filter((e) => e.type === "agent_pulse_texted").map((e) => e.at),
        a.lastInboundAt,
      ]);
      if (touched && now - (ms(touched) ?? 0) <= s.everyDays * DAY_MS) counts.coverage.touched++;
    }
    if (v.status === "stopped") { counts.stopped[v.reason] = (counts.stopped[v.reason] || 0) + 1; continue; }
    if (v.status === "owned") { counts.owned[v.reason] = (counts.owned[v.reason] || 0) + 1; continue; }
    if (v.status === "cold_dropped") { counts.coldDropped++; continue; }
    if (v.status === "not_due") { counts.notDue++; continue; }
    counts.due[v.pulseReason]++;
    if (LISTING_REASONS.has(v.pulseReason)) counts.fresh.withListing++;
    due.push({ agent: a, verdict: v });
  }
  const cmp = (x, y) => {
    const [a0, a1] = x.verdict.priority, [b0, b1] = y.verdict.priority;
    return a0 - b0 || a1 - b1 || String(x.agent.contactId).localeCompare(String(y.agent.contactId));
  };
  due.sort(cmp);
  const cap = seats == null ? (s.dailyCap > 0 ? s.dailyCap : Infinity) : Math.max(0, seats);
  counts.dueNoSeat = Math.max(0, due.length - cap);
  const toPick = ({ agent, verdict }) => ({
    contactId: agent.contactId, name: agent.name || "", segment: verdict.segment, reason: verdict.pulseReason,
    listingKey: verdict.listing?.listingKey || null,
    subject: agentPulseSubject({ agent, verdict, houses, now }),
  });
  const picks = due.slice(0, cap).map(toPick);
  // The next in line after the day's seats: an agent skipped before being
  // claimed (unsubscribed in GHL, tagged off, no phone) hands the seat on.
  const spares = cap === Infinity ? [] : due.slice(cap, cap + Math.max(5, Math.ceil(s.dailyCap / 2))).map(toPick);
  return { picks, spares, counts, verdicts };
}

/**
 * pickMattsFifteen({ agents, settings, config, houses, outreachFollowUpDays, now }) → [pick]
 *
 * Matt's 15 (2026-10-15): the funnel review found his own specific texts got
 * 70% replies and the bot's generic check-ins 35%. Once a week, his best
 * agents get a check-in drafted for HIM to make his own and send: partners
 * first, then the agents who brought us houses, then the ones who write
 * back, each by their latest word to us and then how many houses we've had
 * with them. Never one who is stopped, never one another clock has, and
 * never one we or they texted this past week (they're already talking).
 * Cold agents are the machine's.
 */
const MATT_SEGMENT_RANK = { partner: 0, source: 1, engaged: 2 };
const MATT_QUIET_DAYS = 7;
export function pickMattsFifteen({ agents = [], settings = {}, config = {}, houses = {}, outreachFollowUpDays = 14, outreachFollowUpOn = true, now = Date.now() } = {}) {
  const s = normalizeAgentPulse(settings);
  const rows = [];
  for (const a of agents || []) {
    const v = evaluateAgent(a, { settings: s, config, houses, outreachFollowUpDays, outreachFollowUpOn, now });
    if (v.status === "stopped" || v.status === "owned") continue;
    if (!(v.segment in MATT_SEGMENT_RANK)) continue;
    const touched = latest([
      ...(a.events || []).filter((e) => OUR_TEXT_TYPES.has(e?.type)).map((e) => e.at),
      ...(a.ledger || []).filter((e) => e?.type === "agent_pulse_texted").map((e) => e.at),
      a.lastInboundAt,
    ]);
    if (touched && now - (ms(touched) ?? 0) < MATT_QUIET_DAYS * DAY_MS) continue;
    rows.push({ a, v });
  }
  rows.sort((x, y) => MATT_SEGMENT_RANK[x.v.segment] - MATT_SEGMENT_RANK[y.v.segment]
    || String(y.a.lastInboundAt || "").localeCompare(String(x.a.lastInboundAt || ""))
    || (y.a.offers || []).length - (x.a.offers || []).length
    || String(x.a.contactId).localeCompare(String(y.a.contactId)));
  return rows.slice(0, s.mattsFifteen.size).map(({ a, v }) => {
    // Due today: the check-in it was due (their listing, a thank-you).
    // Otherwise a general one, with its one real thing (checkInHook).
    const verdict = v.status === "due" ? v : { pulseReason: "general", segment: v.segment };
    return {
      contactId: a.contactId, name: a.name || "", segment: v.segment, reason: verdict.pulseReason,
      listingKey: verdict.listing?.listingKey || null,
      subject: { ...agentPulseSubject({ agent: a, verdict, houses, now }), forMatt: true },
    };
  });
}

const street = (address) => String(address || "").split(",")[0].trim();
const cityOf = (address) => { const p = String(address || "").split(",").map((x) => x.trim()).filter(Boolean); return p.length >= 3 ? p[p.length - 2].replace(/\s+\d{5}.*$/, "") : ""; };
const factValue = (facts, key) => {
  const list = facts?.[key];
  return Array.isArray(list) && list.length ? String([...list].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0]?.value || "") : "";
};

// A list fact, newest first, with how long ago each was said: something from
// last spring must never read as if it were yesterday.
const factList = (facts, key, now, max = 3) => {
  const list = Array.isArray(facts?.[key]) ? facts[key] : [];
  const seen = new Set();
  return [...list].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .map((f) => ({ what: String(f?.value || "").trim().slice(0, 120), daysAgo: ms(f?.at) != null ? Math.max(0, Math.floor((now - ms(f.at)) / DAY_MS)) : null }))
    .filter((f) => f.what && !seen.has(f.what.toLowerCase()) && seen.add(f.what.toLowerCase()))
    .slice(0, max);
};

// How a house of theirs ended, in the words a text would use.
const HOUSE_HOW = {
  passed: "passed", no_response: "never heard back", we_passed: "we passed on it", unavailable: "it sold or came off the market", sent: "we sent an offer",
  countered: "they countered", accepted: "we agreed a price", new: "we looked at it",
};
function houseHow(o) {
  if (o?.deal) return o.deal.stage === "closed" || o.deal.stage === "assigned" ? "closed" : o.deal.stage === "fell_through" ? "fell through" : "under contract";
  return HOUSE_HOW[effectiveStatus(o)] || "";
}

// The same house, or for one named with no number ("Pine St, Shelton"), the
// same street: an offer on 1412 Pine St is that house priced.
const streetNameKey = (raw) => addressKey(parseUsAddress(raw).street || "");
function sameHouseLoose(a, b) {
  if (sameStreet(a, b)) return true;
  const pa = parseUsAddress(a), pb = parseUsAddress(b);
  if (pa.houseNo && pb.houseNo) return false;
  const ka = streetNameKey(a);
  return Boolean(ka) && ka === streetNameKey(b);
}

// How long a house they named stays a reason to check in, and how long one
// of our closes is news in their town.
export const MENTIONED_HOOK_DAYS = 60;
export const CLOSE_HOOK_DAYS = 60;

/**
 * mentionedHouseFor({ events, offers, now }) → { address, street, label, town, at } | null
 *
 * The newest house they named in the last MENTIONED_HOOK_DAYS that we never
 * priced (no offer on it, sent or drafted), never passed or kicked off the
 * Tier 1 list, and that isn't the listing our first text was about.
 */
export function mentionedHouseFor({ events = [], offers = [], now = Date.now() } = {}) {
  const priced = (offers || []).map((o) => o?.address).filter(Boolean);
  const passed = (events || []).filter((e) => e?.address && (e.type === "tier1_passed" || e.type === "tier1_kicked")).map((e) => e.address);
  const opened = (events || []).filter((e) => e?.address && (e.type === "outreach_sent" || e.type === "outreach_enrolled")).map((e) => e.address);
  const gone = [...priced, ...passed, ...opened];
  const list = (events || []).filter((e) => e?.type === "house_mentioned" && (e.address || e.data?.label))
    .filter((e) => { const t = ms(e.at); return t != null && now - t <= MENTIONED_HOOK_DAYS * DAY_MS; })
    .filter((e) => !e.address || !gone.some((a) => sameHouseLoose(a, e.address)))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const e = list[0];
  if (!e) return null;
  return { address: String(e.address || ""), street: street(e.address), label: String(e.data?.label || "").slice(0, 60),
    town: String(e.data?.town || cityOf(e.address) || "").slice(0, 40), at: e.at };
}

/**
 * recentCloses(offers, now) → [{ town, at }]
 *
 * Our deals that closed in the last CLOSE_HOOK_DAYS, by town only: a check-in
 * may say "we just closed on one in Kent", never which house.
 */
export function recentCloses(offers = [], now = Date.now()) {
  const out = [];
  for (const o of offers || []) {
    if (!o?.deal || o.deal.stage !== "closed" || !o.address) continue;
    const at = (o.deal.stageHistory || []).filter((h) => h?.stage === "closed").map((h) => h.ts || h.at).filter(Boolean).sort().at(-1) || o.deal.closedAt || null;
    const t = ms(at);
    const town = cityOf(o.address);
    if (t == null || !town || now - t > CLOSE_HOOK_DAYS * DAY_MS || t > now) continue;
    out.push({ town, at });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// The towns an agent works: their listings, the houses we've had with them,
// and the areas they told us.
function agentTowns(agent = {}) {
  const towns = new Set();
  for (const l of agent.listings || []) if (l?.doc?.city || l?.doc?.address) towns.add(String(l.doc.city || cityOf(l.doc.address)).trim().toLowerCase());
  for (const o of agent.offers || []) if (o?.address) towns.add(cityOf(o.address).toLowerCase());
  for (const e of agent.events || []) if (e?.type === "house_mentioned" && (e.data?.town || e.address)) towns.add(String(e.data?.town || cityOf(e.address)).toLowerCase());
  for (const f of agent.facts?.agent_market_area || []) towns.add(String(f?.value || "").trim().toLowerCase());
  towns.delete("");
  return towns;
}

/**
 * checkInHook({ agent, verdict, houses, now }) → { kind, … } | null
 *
 * The ONE real thing a check-in names (2026-10-15, the funnel review: Matt's
 * own specific texts got 70% replies, the generic check-ins 35%). In order:
 *   listing        their fresh listing (the check-in is about it)
 *   mentioned      a house they named in the last 60 days that we never
 *                  priced or passed on
 *   closed_nearby  one of our deals closed in the last 60 days in a town they
 *                  work, named by town only
 *   situation      otherwise, a kind of seller we're good for
 * Never a house we priced or passed on, and never "did it sell?" (Matt,
 * 2026-10-08). The thank-you after a close has none: it is about that deal.
 */
export function checkInHook({ agent = {}, verdict = {}, houses = {}, now = Date.now() } = {}) {
  if (verdict.pulseReason === "deal_thanks") return null;
  if (LISTING_REASONS.has(verdict.pulseReason) && verdict.listing) return { kind: "listing" };
  const m = mentionedHouseFor({ events: agent.events || [], offers: agent.offers || [], now });
  if (m) {
    const days = Math.max(0, Math.floor((now - (ms(m.at) ?? now)) / DAY_MS));
    return { kind: "mentioned", address: m.address, street: m.street, label: m.label, town: m.town, daysAgo: days };
  }
  const towns = agentTowns(agent);
  const close = (houses.closes || []).find((c) => towns.has(String(c.town || "").toLowerCase()));
  if (close) return { kind: "closed_nearby", town: close.town };
  return { kind: "situation" };
}

/**
 * agentPulseSubject({ agent, verdict, now }) → what the text may lean on
 *
 * The listing by street, city, days on market, whether it was cut and what
 * kind — never its price. The house by street and how it ended; the newest
 * house we've had with them. What we last talked about, what they've told us
 * about themselves and the areas they work, each with how long ago. Nothing
 * else, and never a number: the check-in's money guard holds any.
 */
export function agentPulseSubject({ agent = {}, verdict = {}, houses = {}, now = Date.now() } = {}) {
  const l = verdict.listing?.doc || null;
  const hook = checkInHook({ agent, verdict, houses, now });
  const h = verdict.house || null;
  const how = !h ? "" : h.deal ? (h.deal.stage === "closed" ? "closed" : "fell through") : effectiveStatus(h) === "no_response" ? "never heard back" : "passed";
  const at = (o) => o?.statusAt || o?.createdAt || "";
  // A house we passed on (or that's gone, or that came off the Tier 1 list)
  // is never the check-in's material: the nurture is about what's next.
  const avoid = [...new Set([
    ...(agent.offers || []).filter((o) => o?.address && ["we_passed", "unavailable"].includes(effectiveStatus(o))).map((o) => street(o.address)),
    ...(agent.events || []).filter((e) => e?.address && (e.type === "tier1_passed" || e.type === "tier1_kicked")).map((e) => street(e.address)),
  ].filter(Boolean))];
  const newest = (agent.offers || []).filter((o) => o && o.address && effectiveStatus(o) !== "draft" && !avoid.includes(street(o.address)))
    .sort((a, b) => String(at(b)).localeCompare(String(at(a))))[0] || null;
  const areas = factList(agent.facts, "agent_market_area", now).map((f) => f.what);
  return {
    reason: verdict.pulseReason,
    segment: verdict.segment,
    // The whole address, city and ZIP: the reply to this text is about this
    // house, and an underwrite that starts from it has to find it on a map.
    // "5413 Welfare Ave NE" alone held as "couldn't locate", and the agent
    // was asked for the city we'd had from RentCast (2026-10-13). The text
    // itself names the listing by street (listing.street, listing.city).
    address: l ? String(l.address || "").trim() : h ? String(h.address || "").trim() : "",
    listing: l ? { street: street(l.address), city: l.city || cityOf(l.address), dom: Number(l.daysOnMarket) || 0, cut: Boolean(l.distress?.cut), type: String(l.propertyType || ""),
      ...(l.offMarket === true ? { offMarket: true } : {}) } : null,
    house: h ? { street: street(h.address), how } : null,
    dealsWithUs: (agent.offers || []).filter((o) => o?.deal).length,
    offersWithUs: (agent.offers || []).length,
    lastSummary: factValue(agent.facts, "last_convo_summary").slice(0, 200),
    nextAction: factValue(agent.facts, "suggested_next_action").slice(0, 160),
    lastHouse: newest ? { street: street(newest.address), how: houseHow(newest), daysAgo: ms(at(newest)) != null ? Math.max(0, Math.floor((now - ms(at(newest))) / DAY_MS)) : null } : null,
    aboutThem: factList(agent.facts, "personal_details", now),
    areas,
    avoid,
    // The one real thing this check-in names (checkInHook): their fresh
    // listing, a house they mentioned that we never priced, one of our
    // closes in their town (by town only), or a kind of seller we're good for.
    hook,
    // Every house we've had with them, for the gate that holds a check-in
    // naming one (ghl-broker/reply-agent.js): never a house we priced or
    // passed on (Matt, 2026-10-09). The hook's own house is left out.
    // Never shown to the drafter.
    pastHouses: [...new Set([
      ...(agent.offers || []).map((o) => o?.address),
      ...(agent.events || []).filter((e) => e?.type === "tier1_passed" || e?.type === "tier1_kicked" || e?.type === "subject_property_set").map((e) => e?.address),
    ].filter(Boolean).map(String))]
      .filter((a) => (!l || street(a) !== street(l.address)) && !(hook?.kind === "mentioned" && hook.address && sameHouseLoose(a, hook.address)))
      .slice(0, 30),
    // Asked about off-market houses in the last month? Then not this time.
    offMarketAskDue: offMarketAskDue(agent.events || [], now),
  };
}

/**
 * tierDrips({ pulse, conversationAi, workflows }) → [{ id, name }]
 *
 * The GHL drips this check-in replaces (Matt, 2026-09-30: "make sure the tier
 * 2/3 workflow that checks in is being replaced"). The texts come from a
 * nurture workflow GHL starts by itself when an agent's card moves to Tier 2
 * or Tier 3 ("Tier 2+3 nurture") — NOT the TIER 2/3 workflows the playbook
 * enrolls agents in, which move the card and must keep running. So: a list
 * set by hand wins; without one, every published workflow in GHL's list whose
 * name says both "tier" and "nurture" (never a disposition one). Without the
 * list it guesses nothing. Names come from GHL's list, else the playbook.
 */
const NURTURE_RX = /nurture/i;
const TIER_RX = /tier/i;
const DISPO_RX = /dispo/i;
export function tierDrips({ pulse = {}, conversationAi = null, workflows = null } = {}) {
  const agentPb = conversationAi?.parties?.agent || {};
  const playbookNames = new Map([
    ...Object.values(agentPb.intentRules || {}).flatMap((r) => (Array.isArray(r?.actions) ? r.actions : [])),
    ...(Array.isArray(agentPb.fallback?.actions) ? agentPb.fallback.actions : []),
  ].filter((a) => a?.workflowId).map((a) => [String(a.workflowId), String(a.workflowName || "")]));
  const listNames = new Map((Array.isArray(workflows) ? workflows : []).filter((w) => w?.id).map((w) => [String(w.id), String(w.name || "")]));
  const nameOf = (id) => listNames.get(id) || playbookNames.get(id) || "";
  const set = normalizeAgentPulse(pulse).replacesWorkflowIds;
  if (set.length) return set.map((id) => ({ id, name: nameOf(id) }));
  if (!Array.isArray(workflows)) return [];
  return workflows
    .filter((w) => w?.id && String(w.status || "").toLowerCase() !== "draft" && NURTURE_RX.test(String(w.name || "")) && TIER_RX.test(String(w.name || "")) && !DISPO_RX.test(String(w.name || "")))
    .map((w) => ({ id: String(w.id), name: String(w.name || "") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- the repliers outside the pool (ghl-broker/replier-backfill.js) ---------- */

// Phone-side auto-replies: a text that came from their phone, not from them.
// Only a thread with nothing else from them is "auto_reply".
export const AUTO_REPLY_RX = /\b(?:do not disturb while driving|i(?:'|’)?m driving with do not disturb|auto[- ]?(?:reply|response|responder)|this is an automated|automated (?:message|response|reply)|(?:does not|doesn'?t|cannot|can'?t|unable to|not able to) (?:receive|accept|read|respond to) (?:text|sms)|(?:text|sms)(?: messages?)? (?:are|is) not (?:monitored|received|accepted)|out of (?:the )?office|(?:on vacation|out of town) (?:until|through|thru)|(?:use|have) a different number for text(?:ing|s)?|thank you for contacting the [\w\s]{0,30}(?:desk|line|team)\b[^]*\bpress \d)\b/i;
// A stop at the END of a short text ("not my listing, pls stop"), and a
// polite "don't text me": optOutInTranscript only reads a stop that leads.
const STOP_TAIL_RX = /\bstop\W*$/i;
const NO_NEED_RX = /\bno need to (?:message|text|contact) me\b/i;
const smsDnd = (c) => c?.dnd === true || ["active", "permanent"].includes(String(c?.dndSettings?.SMS?.status || "").toLowerCase());
const replyChannel = (m) => {
  const t = String(m?.messageType || m?.type || "").toUpperCase();
  if (t.includes("ACTIVITY") || t.includes("OPPORTUNITY")) return null;
  if (t.includes("CALL")) return "call";
  if (t.includes("SMS")) return "sms";
  return null;
};

/**
 * classifyReplierThread({ messages, contact, optOut }) → { kind, why, lastInboundAt, channel, inbound, lastText? }
 *
 * One agent's GHL thread (raw conversation messages, any order), read for
 * the one-time replier backfill. `kind`:
 *   none       nothing from them by text or call
 *   opted_out  SMS DND in GHL, a do-not-text tag, or a stop in their own
 *              words anywhere in the thread (optOutInTranscript: "STOP",
 *              "wrong number", "take me off your list")
 *   auto_reply every text from them is their phone answering for them
 *   annoyed    one of their last three texts sounds annoyed
 *   engaged    a person wrote back (or called): they join the check-in
 * Only `engaged` carries a word of theirs (`lastText`, ≤300 chars) — for the
 * timeline event, never a log line.
 */
export function classifyReplierThread({ messages = [], contact = null, optOut = CONVERSATION_AI_DEFAULTS.optOut } = {}) {
  const inbound = (messages || [])
    .map((m) => ({ m, channel: replyChannel(m), at: ms(m?.dateAdded) }))
    .filter((x) => x.channel && x.at != null && String(x.m?.direction || "").toLowerCase() === "inbound")
    .filter((x) => x.channel === "call" || String(x.m?.body || "").trim())
    .sort((a, b) => a.at - b.at);
  const last = inbound.at(-1);
  const base = { lastInboundAt: last ? iso(last.at) : null, channel: last?.channel || null, inbound: inbound.length };
  if (!last) return { kind: "none", why: "no reply", ...base };
  if (smsDnd(contact)) return { kind: "opted_out", why: "dnd", ...base };
  if (blockedByTags(contact?.tags || [])) return { kind: "opted_out", why: "tag", ...base };
  const texts = inbound.filter((x) => x.channel === "sms").map((x) => ({ at: x.at, text: String(x.m.body || "").replace(/\s+/g, " ").trim() }));
  const transcript = texts.map((x) => `[${iso(x.at).slice(0, 16).replace("T", " ")}] THEM sms: ${x.text}`).join("\n");
  const stopLine = (t) => (STOP_TAIL_RX.test(t) && t.split(/\s+/).length <= 6) || NO_NEED_RX.test(t);
  if (optOutInTranscript(transcript, optOut || CONVERSATION_AI_DEFAULTS.optOut) || texts.some((x) => stopLine(x.text))) return { kind: "opted_out", why: "said stop", ...base };
  const calls = inbound.length - texts.length;
  if (!calls && texts.every((x) => AUTO_REPLY_RX.test(x.text) || isAutoReply(x.text))) return { kind: "auto_reply", why: "auto-reply only", ...base };
  if (texts.slice(-3).some((x) => IRRITATED_RX.test(x.text))) return { kind: "annoyed", why: "sounds annoyed", ...base };
  return { kind: "engaged", why: "replied", ...base, lastText: (texts.at(-1)?.text || "").slice(0, 300) };
}
