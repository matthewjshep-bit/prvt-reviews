// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

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
//
// The one-owner rule: an agent another clock owns is left to it — an open
// offer and its nudges, the push to paper, check-ins on a passed offer, a
// promise, a check-in they asked for, an address chase, the outreach
// workflows, anything waiting in the outbox, a live deal, a thread you picked
// up. The pulse picks them up the day it ends: one voice per agent.
//
// Pure. The runner (ghl-broker/agent-pulse.js) reads; this decides.

import { effectiveStatus, OPEN_STATUSES, DEAD_STATUSES, dealIsOver, priceAgreed } from "./offer-status.js";
import { threadTimes } from "./follow-up.js";
import { nextFollowUp } from "./next-follow-up.js";
import { IRRITATED_RX, PERSON_HAS_IT_DAYS, HAND_REPLY_EVENT } from "./thread-health.js";
import { addressKey, sameStreet } from "./us-address.js";
import { offMarketAskDue } from "./off-market.js";
import { botHold, paceOf, paceScale } from "./bot-hold.js";

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const latest = (xs) => xs.filter(Boolean).sort().at(-1) || null;
const clamp = (x, d, lo, hi) => { const k = Math.round(Number(x)); return Number.isFinite(k) ? Math.min(hi, Math.max(lo, k)) : d; };

export const AGENT_PULSE_DEFAULTS = {
  enabled: false, autoSend: false,
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
};
export const AGENT_PULSE_VOICE_MAX = 600;
export const AGENT_PULSE_MAX_DAILY_CAP = 100;

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
    dailyCap: clamp(o.dailyCap, D.dailyCap, 1, AGENT_PULSE_MAX_DAILY_CAP),
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
  };
}

// Event types the pulse reads for one agent (the runner asks for exactly these).
export const AGENT_PULSE_EVENT_TYPES = [
  "text_summary", "call_summary", "follow_up_sent", "hand_reply", "unsubscribed",
  "promise_made", "promise_owed", "promise_kept",
  "checkin_requested", "checkin_sent", "address_pending", "address_pending_closed", "subject_property_set", "address_chase_sent",
  "outreach_enrolled", "outreach_sent", "outreach_left", "workflow_enrolled", "workflow_left",
  "drive_stopped", "drive_resumed", "listing_off_market", "listing_back_on_market", "offer_sent",
  "offmarket_asked",
];
export const AGENT_PULSE_LEDGER_TYPES = ["agent_pulse_sent", "agent_pulse_texted", "agent_pulse_voided", "listing_pinged", "listing_ping_voided"];
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
 * (routes/outreach.js: "cut-or-cheap" needs a price cut or a cheap $/sqft).
 */
export function listingDistressed(doc = {}, rule = null) {
  if (!doc?.qualifies) return false;
  const d = doc.distress || {};
  return rule === "cut-or-cheap" ? Boolean(d.cut || d.cheap) : Boolean(d.stale || d.cut || d.cheap);
}

/**
 * agentSegment({ offers, lastInboundAt }) → "partner" | "engaged" | "cold"
 */
export function agentSegment({ offers = [], lastInboundAt = null } = {}) {
  if ((offers || []).some((o) => o && (o.deal || priceAgreed(o) || o.realm?.answer === "yes"))) return "partner";
  return lastInboundAt ? "engaged" : "cold";
}

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

/**
 * agentOwner({ offers, drafts, events, config, settings, outreachFollowUpDays, now }) → owner | null
 *
 * The clock that has this agent right now, in words, or null when nothing
 * does. `offers` are this agent's CURRENT rows (shared/current-offer.js).
 */
export function agentOwner({ offers = [], drafts = [], events = [], config = {}, settings = {}, outreachFollowUpDays = 14, now = Date.now() } = {}) {
  const s = normalizeAgentPulse(settings);
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
    if (OPEN_STATUSES.has(status) && !o.deal) return "an open offer";
    const next = nextFollowUp({ offer: o, drafts, events, config, now });
    if (["queued", "reply_owed", "promise", "checkin_due", "float", "offer_nudge", "hot_push", "passed_checkin"].includes(next.kind)) {
      return String(next.label || next.kind).toLowerCase();
    }
  }
  // Anything waiting in the outbox: one voice at a time.
  const open = (drafts || []).filter((d) => d && (d.status === "draft" || d.status === "scheduled"));
  if (open.length) return threadTimes(drafts).heldSince ? "their text is waiting on you" : "a text is waiting in the outbox";
  const byTime = [...(events || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const after = (e, t) => String(e.at) > String(t);
  // A promise we made, still inside its window.
  const kept = byTime.filter((e) => e.type === "promise_kept").at(-1)?.at || "";
  if (byTime.some((e) => e.type === "promise_made" && after(e, kept) && now - (ms(e.at) ?? 0) < 72 * HOUR_MS)) return "a promise we made";
  // A check-in they asked for, not yet sent or answered.
  const req = byTime.filter((e) => e.type === "checkin_requested").at(-1);
  if (req && now - (ms(req.at) ?? 0) < 45 * DAY_MS && !byTime.some((e) => e.type === "checkin_sent" && e.data?.requestAt === req.at)
      && !byTime.some((e) => (e.type === "text_summary" || e.type === "call_summary") && after(e, req.at))) return "a check-in they asked for";
  // A property they said was coming, still being chased.
  const pending = byTime.filter((e) => e.type === "address_pending").at(-1);
  if (pending && now - (ms(pending.at) ?? 0) < 32 * DAY_MS
      && !byTime.some((e) => (e.type === "address_pending_closed" || e.type === "subject_property_set") && after(e, pending.at))) return "an address chase";
  // The outreach workflows: the first text and its follow-up are GHL's.
  const left = byTime.filter((e) => e.type === "outreach_left").at(-1)?.at || "";
  const first = byTime.filter((e) => e.type === "outreach_enrolled" && e.data?.kind !== "followup").at(-1);
  const fu = byTime.filter((e) => e.type === "outreach_enrolled" && e.data?.kind === "followup").at(-1);
  if (fu && after(fu, left) && now - (ms(fu.at) ?? 0) < s.ghlWorkflowDays * DAY_MS) return "the outreach follow-up workflow";
  if (first && !fu && after(first, left) && now - (ms(first.at) ?? 0) < (outreachFollowUpDays + 2) * DAY_MS) return "the outreach workflow";
  // Any other GHL workflow the app put them in, unless it's known not to text
  // or it's a drip this check-in replaces (the TIER 2/3 check-ins).
  const quiet = new Set([...s.quietWorkflowIds, ...s.replacesWorkflowIds]);
  for (const w of byTime.filter((e) => e.type === "workflow_enrolled" && !quiet.has(String(e.data?.workflowId || "")))) {
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
 * closed or fell through. Never a house WE walked away from.
 */
export function ourHouseFor({ offers = [], drafts = [], events = [], config = {}, now = Date.now() } = {}) {
  const ended = (offers || []).filter((o) => {
    if (!o) return false;
    if (o.deal) return dealIsOver(o.deal);
    const status = effectiveStatus(o);
    if (status === "we_passed" || !DEAD_STATUSES.has(status)) return false;
    const next = nextFollowUp({ offer: o, drafts, events, config, now });
    return next.kind === "none" || next.kind === "stopped";
  });
  return ended.sort((a, b) => String(b.statusAt || b.createdAt || "").localeCompare(String(a.statusAt || a.createdAt || "")))[0] || null;
}

/**
 * evaluateAgent(agent, ctx) → { status, reason, segment, pulseReason, listing, house, priority }
 *
 *   agent  { contactId, name, tags, offers (all), current (current rows),
 *            drafts, events, ledger, lastInboundAt, listings, facts }
 *   ctx    { settings, config, houses, outreachFollowUpDays, now }
 *
 * status: "stopped" | "owned" | "not_due" | "cold_dropped" | "due".
 */
export function evaluateAgent(agent = {}, { settings = {}, config = {}, houses = {}, outreachFollowUpDays = 14, now = Date.now() } = {}) {
  const s = normalizeAgentPulse(settings);
  const out = (status, reason, more = {}) => ({ contactId: agent.contactId, status, reason, ...more });
  const drafts = agent.drafts || [];
  const events = agent.events || [];
  const ledger = agent.ledger || [];

  const stop = agentStops({ drafts, events, tags: agent.tags || [], botOffTags: config?.routing?.botOffTags || [], now });
  if (stop) return out("stopped", stop);
  const owner = agentOwner({ offers: agent.current || [], drafts, events, config, settings: s, outreachFollowUpDays, now });
  if (owner) return out("owned", owner);

  // Where they stand with us, and how many of our check-ins met silence.
  let segment = agentSegment({ offers: agent.offers || agent.current || [], lastInboundAt: agent.lastInboundAt });
  const voided = new Set(ledger.filter((e) => e.type === "agent_pulse_voided").map((e) => e.data?.claimKey || e.ref).filter(Boolean));
  const texted = ledger.filter((e) => e.type === "agent_pulse_texted" && (!agent.lastInboundAt || String(e.at) > String(agent.lastInboundAt)));
  const unanswered = texted.length;
  const downgraded = segment !== "cold" && s.engagedMaxUnanswered > 0 && unanswered >= s.engagedMaxUnanswered;
  const lastPulseAt = latest(ledger.filter((e) => e.type === "agent_pulse_sent" && !voided.has(e.dedupeKey)).map((e) => e.at));
  const lastTouchAt = latest(events.filter((e) => OUR_TEXT_TYPES.has(e.type)).map((e) => e.at));
  const since = latest([lastTouchAt, agent.lastInboundAt, lastPulseAt]);
  // Check in less / more with them (shared/bot-hold.js): the three weeks and
  // the cold pings stretch or shrink; the quiet days after any text only grow.
  const { rung, floor } = paceScale(paceOf({ events }).factor);
  const everyDays = Math.round(s.everyDays * rung);
  const coldEveryDays = Math.round(s.coldEveryDays * rung);
  const quietDays = Math.round(s.quietDays * floor);
  const quietFor = (days) => !since || now - (ms(since) ?? 0) >= days * DAY_MS;

  const pinged = new Set(ledger.filter((e) => e.type === "listing_pinged").map((e) => e.data?.listingKey).filter(Boolean));
  for (const e of ledger) if (e.type === "listing_ping_voided" && e.data?.listingKey) pinged.delete(e.data.listingKey);
  // A listing the outreach opener already asked them about (the workflow's
  // first text, or the app's) is not news.
  const raised = events.filter((e) => (e.type === "outreach_enrolled" && e.data?.kind !== "followup") || e.type === "outreach_sent")
    .map((e) => String(e.address || "")).filter(Boolean);
  const listing = freshListingFor({ listings: agent.listings || [], pinged, raised, houses, settings: s, now });

  if (segment === "cold" || downgraded) {
    const coldSeg = segment === "cold" ? "cold" : `${segment} gone quiet`;
    if (unanswered >= s.coldMaxUnanswered + (downgraded ? s.engagedMaxUnanswered : 0)) {
      return out("cold_dropped", `${unanswered} check-ins with nothing back`, { segment: coldSeg });
    }
    if (!listing) return out("not_due", "only a new listing of theirs is a reason to text", { segment: coldSeg });
    const lastPing = latest(texted.map((e) => e.at));
    if (lastPing && now - (ms(lastPing) ?? 0) < coldEveryDays * DAY_MS) return out("not_due", `pinged within ${coldEveryDays} days`, { segment: coldSeg });
    if (!quietFor(quietDays)) return out("not_due", `touched within ${quietDays} days`, { segment: coldSeg });
    return out("due", "", { segment: coldSeg, pulseReason: "fresh_listing", listing, priority: [4, -(Number(listing.doc?.score) || 0)] });
  }

  const tier = segment === "partner" ? 0 : 1;
  if (listing && quietFor(quietDays)) {
    return out("due", "", { segment, pulseReason: "fresh_listing", listing, priority: [tier, -(Number(listing.doc?.score) || 0)] });
  }
  if (!quietFor(everyDays)) return out("not_due", `talked within ${everyDays} days`, { segment });
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
export function pickPulseAgents({ agents = [], settings = {}, config = {}, houses = {}, outreachFollowUpDays = 14, seats = null, now = Date.now() } = {}) {
  const s = normalizeAgentPulse(settings);
  const counts = {
    pool: agents.length, bySegment: { partner: 0, engaged: 0, cold: 0 }, stopped: {}, owned: {}, notDue: 0, coldDropped: 0,
    due: { fresh_listing: 0, our_house: 0, general: 0 }, dueNoSeat: 0,
    fresh: { withListing: 0 }, coverage: { touched: 0, pool: 0 },
  };
  const due = [];
  for (const a of agents) {
    const v = evaluateAgent(a, { settings: s, config, houses, outreachFollowUpDays, now });
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
    if (v.pulseReason === "fresh_listing") counts.fresh.withListing++;
    due.push({ agent: a, verdict: v });
  }
  const cmp = (x, y) => {
    const [a0, a1] = x.verdict.priority, [b0, b1] = y.verdict.priority;
    return a0 - b0 || a1 - b1 || String(x.agent.contactId).localeCompare(String(y.agent.contactId));
  };
  due.sort(cmp);
  const cap = seats == null ? s.dailyCap : Math.max(0, seats);
  counts.dueNoSeat = Math.max(0, due.length - cap);
  const toPick = ({ agent, verdict }) => ({
    contactId: agent.contactId, name: agent.name || "", segment: verdict.segment, reason: verdict.pulseReason,
    listingKey: verdict.listing?.listingKey || null,
    subject: agentPulseSubject({ agent, verdict, now }),
  });
  const picks = due.slice(0, cap).map(toPick);
  // The next in line after the day's seats: an agent skipped before being
  // claimed (unsubscribed in GHL, tagged off, no phone) hands the seat on.
  const spares = due.slice(cap, cap + Math.max(5, Math.ceil(s.dailyCap / 2))).map(toPick);
  return { picks, spares, counts };
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
  passed: "passed", no_response: "never heard back", we_passed: "we passed on it", sent: "we sent an offer",
  countered: "they countered", accepted: "we agreed a price", new: "we looked at it",
};
function houseHow(o) {
  if (o?.deal) return o.deal.stage === "closed" || o.deal.stage === "assigned" ? "closed" : o.deal.stage === "fell_through" ? "fell through" : "under contract";
  return HOUSE_HOW[effectiveStatus(o)] || "";
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
export function agentPulseSubject({ agent = {}, verdict = {}, now = Date.now() } = {}) {
  const l = verdict.listing?.doc || null;
  const h = verdict.house || null;
  const how = !h ? "" : h.deal ? (h.deal.stage === "closed" ? "closed" : "fell through") : effectiveStatus(h) === "no_response" ? "never heard back" : "passed";
  const at = (o) => o?.statusAt || o?.createdAt || "";
  const newest = (agent.offers || []).filter((o) => o && o.address && effectiveStatus(o) !== "draft")
    .sort((a, b) => String(at(b)).localeCompare(String(at(a))))[0] || null;
  const areas = factList(agent.facts, "agent_market_area", now).map((f) => f.what);
  return {
    reason: verdict.pulseReason,
    segment: verdict.segment,
    address: l ? street(l.address) : h ? street(h.address) : "",
    listing: l ? { street: street(l.address), city: l.city || cityOf(l.address), dom: Number(l.daysOnMarket) || 0, cut: Boolean(l.distress?.cut), type: String(l.propertyType || "") } : null,
    house: h ? { street: street(h.address), how } : null,
    dealsWithUs: (agent.offers || []).filter((o) => o?.deal).length,
    offersWithUs: (agent.offers || []).length,
    lastSummary: factValue(agent.facts, "last_convo_summary").slice(0, 200),
    nextAction: factValue(agent.facts, "suggested_next_action").slice(0, 160),
    lastHouse: newest ? { street: street(newest.address), how: houseHow(newest), daysAgo: ms(at(newest)) != null ? Math.max(0, Math.floor((now - ms(at(newest))) / DAY_MS)) : null } : null,
    aboutThem: factList(agent.facts, "personal_details", now),
    areas,
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
