// desk.js — Today as the Desk: one row per person, in three sections.
//
// Matt, 2026-10-02: his day ran across three places — Today, GHL's Tier 1
// stage and the Offers tab — and Today itself listed the same person up to
// three times (an owed number, the underwrite it waits on, and last night's
// "still owed a number", all about one house). He wants one screen: the people
// worth a phone call, the decisions only he makes, and the machine's work
// folded away.
//
//   Call     a conversation only a person can have: a hot offer to get written
//            up, a counter above our number, somebody who asked for a call, a
//            buyer the bot stays out of.
//   Decide   a decision the machine may not make: a draft it couldn't place, a
//            hand-off, a held underwrite nobody's numbers clear, a deal step.
//   Machine  already moving, with what happens next (folded).
//
// Every row the pipeline and last night's audit produce is a REASON. Reasons
// about one person fold into one row led by the strongest; the rest ride
// along (`also`) with their own buttons. A reason that only repeats a
// stronger one (`quiet`) is not shown but is dismissed with the row, so it
// can't resurface on its own the moment the lead clears.
//
// Pure. The route (ghl-broker/routes/dashboard.js) builds the reasons and
// applies dismissals first; this decides sections, folds and counts.

import { SEVERITY_RANK } from "./pipeline.js";
import { callEventConnected } from "./talked-to.js";

export const DESK_SECTIONS = [
  { key: "call", label: "Call", hint: "Worth a phone call today: the conversations only you can have." },
  { key: "decide", label: "Decide", hint: "Decisions only you make." },
  { key: "machine", label: "The machine is on it", hint: "Already moving.", folds: true },
];
const SECTION_RANK = Object.fromEntries(DESK_SECTIONS.map((s, i) => [s.key, i]));

// A draft about one of these is a phone call, not a text to approve.
export const CALL_INTENTS = new Set(["wants_call", "scheduling", "wants_walkthrough"]);

// The lead of a person's row: the strongest reason, in this order. Call rows
// first (the call list builds the call_* kinds), then the hand-offs and the
// drafts, then the house-level and deal-level work. Anything unlisted sorts
// after these, by severity.
export const KIND_STRENGTH = [
  "call_hot", "call_brought", "hot_stalled", "call_counter", "call_gap", "call_missed", "call_wants", "call_buyer", "deal_interest_stalled",
  "paper_to_sign", "handoff", "investor_price_agreed", "draft_waiting", "promise_owed", "audit_owed",
  "call_first_reply", "call_quiet", "ladder_exhausted",
  "underwrite_held", "offer_ready", "closing_soon", "closing_task_due", "stage_lag",
  "deal_no_buyers", "deal_no_dataroom", "showing_no_window", "underwrite_dropped",
  "call_phone_only", "call_investor", "call_partner",
  "gone_quiet", "showing_soon", "blast_no_opens", "underwrite_failed", "draft_scheduled",
  // What the machine is driving that used to be a call (2026-10-04).
  "hot_machine", "counter_held",
];
const STRENGTH = Object.fromEntries(KIND_STRENGTH.map((k, i) => [k, i]));

// Rows about a deal, not about the agent who listed it: they fold by deal so
// "no buyer package" doesn't hide under the listing agent's other business.
const DEAL_KINDS = new Set(["closing_soon", "closing_task_due", "deal_no_buyers", "blast_no_opens", "deal_interest_stalled", "deal_no_dataroom", "showing_soon", "showing_no_window", "stage_lag"]);
// Already moving by themselves.
const MACHINE_KINDS = new Set(["gone_quiet", "showing_soon", "blast_no_opens", "underwrite_failed", "draft_scheduled"]);
// Last night's findings with no remedy that only report: a float nobody
// answered, an offer with no follow-up. The machine's ladders own them.
const MACHINE_FINDINGS = new Set(["float_unanswered", "offer_no_followup"]);
// The held-underwrite triage's verdicts (last night's findings) that the
// machine carries out itself: it asks for their numbers, re-runs on them,
// drops junk or retires a dead house, or passes a week after an ask.
const MACHINE_HELD = new Set(["held_ask", "held_rerun", "held_junk", "held_over", "held_waiting"]);
const BOT_STAYS_OUT = /bot stays out|on your live deal/i;

/** A draft that is a counter above our number (the band's refusal, or the intent). */
export function isCounterDraft(d) {
  if (!d) return false;
  const x = d.exception;
  return d.intent === "counter" || Boolean(x && !x.passed && Number(x.theirAmount) > 0);
}

/**
 * sectionFor(reason, { draftsById, heldByOffer }) → "call" | "decide" | "machine"
 *
 *   draftsById   open drafts by id (a draft row's intent decides it)
 *   heldByOffer  offerId → last night's held-underwrite finding kind
 */
export function sectionFor(a, { draftsById = new Map(), heldByOffer = new Map() } = {}) {
  if (!a) return "decide";
  if (a.section && SECTION_RANK[a.section] != null) return a.section;
  const kind = String(a.kind || "");
  if (kind.startsWith("call_")) return "call";
  // The pipeline already put it with the machine: a timer, a promise the
  // driver keeps, a draft that sends itself.
  if (a.group === "machine") return "machine";
  if (MACHINE_KINDS.has(kind)) return "machine";
  switch (kind) {
    case "hot_stalled":
    case "deal_interest_stalled":
      return "call";
    case "draft_waiting": {
      const d = draftsById.get(a.draftId);
      return d && (CALL_INTENTS.has(d.intent) || isCounterDraft(d)) ? "call" : "decide";
    }
    case "audit_owed":
      if (a.findingKind === "counter_stalled") return "call";
      if (CALL_INTENTS.has(a.intent) || BOT_STAYS_OUT.test(String(a.detail || ""))) return "call";
      if (MACHINE_FINDINGS.has(a.findingKind)) return "machine";
      return "decide";
    case "underwrite_held": {
      // Asked for their numbers and they wrote back without one: a call.
      const verdict = heldByOffer.get(a.offerId);
      if (verdict === "held_call") return "call";
      return MACHINE_HELD.has(verdict) ? "machine" : "decide";
    }
    case "closing_soon":
      // Overdue is a decision (Mark closed / Fell through); next week is not.
      return a.severity === "now" ? "decide" : "machine";
    default:
      return "decide";
  }
}

/** foldKey(reason) → the row it belongs to: a person, a deal, an offer, or itself. */
export function foldKey(a) {
  if (DEAL_KINDS.has(a?.kind) && a.offerId) return `deal:${a.offerId}`;
  if (a?.kind === "draft_scheduled" && a.count) return `row:${a.id}`;   // a blast is one decision about a deal
  if (a?.contactId) return `person:${a.contactId}`;
  if (a?.offerId) return `offer:${a.offerId}`;
  return `row:${a?.id}`;
}

// Weaker reasons that only repeat a stronger one in the same row.
function redundant(r, siblings) {
  const has = (pred) => siblings.some((s) => s !== r && pred(s));
  if (r.kind === "audit_owed" && r.findingKind === "promise_open_overdue") return has((s) => s.kind === "promise_owed");
  // Only a live call row stands in for these: one the tries ran out on has
  // gone back to the machine, and the row it replaced is the decision again.
  const calling = (s, kind) => s.kind === kind && s.section === "call";
  if (r.kind === "audit_owed" && r.findingKind === "counter_stalled") return has((s) => (calling(s, "call_counter") || s.isCounter) && (!r.offerId || s.offerId === r.offerId));
  if (r.kind === "hot_stalled") return has((s) => calling(s, "call_hot") && s.offerId === r.offerId);
  if (r.kind === "draft_waiting" && r.isCounter) return has((s) => calling(s, "call_counter") && s.offerId === r.offerId);
  return false;
}

// How much a call is worth, for Call rows the call list didn't build and so
// carry no score of their own (shared/call-list.js scores the rest).
const CALL_FALLBACK = { hot_stalled: 98, draft_waiting: 88, audit_owed: 82, deal_interest_stalled: 80 };
export const callScore = (a) => (a?.score != null && Number.isFinite(Number(a.score)) ? Number(a.score) : CALL_FALLBACK[a?.kind] ?? 50);
// Call is worked by what a call is worth; the other sections by what the row is.
const rankOf = (a) => (a.section === "call"
  ? [SECTION_RANK.call, -callScore(a), STRENGTH[a.kind] ?? 99, SEVERITY_RANK[a.severity] ?? 3]
  : [SECTION_RANK[a.section] ?? 9, STRENGTH[a.kind] ?? 99, 0, SEVERITY_RANK[a.severity] ?? 3]);
function compare(x, y) {
  const a = rankOf(x), b = rankOf(y);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * foldDesk(reasons, { drafts, heldByOffer, callCap }) → { rows, counts }
 *
 * rows: one per person (or deal, or lone row), the lead reason's fields plus
 *   section   where it sits
 *   also      the other reasons, strongest first, each with its own ops
 *   quiet     reasons that only repeat a stronger one (dismissed with it)
 *   reasonIds every reason's id, so an old ?row= link finds its person
 * Sections in order. Call by what the call is worth (the call list's
 * score), the rest by the lead's strength, then severity, then the order the
 * reasons came in. Call rows past `callCap` carry `later: true` — the rail
 * keeps them behind "N more to call".
 *
 * A person the call list already tried `triesBeforeMachine` times (its row
 * went to the machine) is not a call again through another reason: those
 * reasons become decisions — mark them, or keep trying.
 */
export function foldDesk(reasons = [], { drafts = [], heldByOffer = new Map(), callCap = Infinity } = {}) {
  const draftsById = new Map((drafts || []).filter((d) => d?.id).map((d) => [d.id, d]));
  const held = heldByOffer instanceof Map ? heldByOffer : new Map(Object.entries(heldByOffer || {}));
  const placed = (reasons || []).filter(Boolean).map((a, i) => {
    const d = a.kind === "draft_waiting" ? draftsById.get(a.draftId) : null;
    return { ...a, section: sectionFor(a, { draftsById, heldByOffer: held }), ...(d && isCounterDraft(d) ? { isCounter: true } : {}), _i: i };
  });
  const spent = new Set(placed.filter((r) => String(r.kind).startsWith("call_") && r.section === "machine").map(foldKey));
  for (const r of placed) if (r.section === "call" && !String(r.kind).startsWith("call_") && spent.has(foldKey(r))) r.section = "decide";
  const byKey = new Map();
  for (const r of placed) {
    const k = foldKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const rows = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((x, y) => compare(x, y) || x._i - y._i);
    const shown = sorted.filter((r) => !redundant(r, sorted));
    const lead = shown[0] || sorted[0];
    const strip = ({ _i, ...rest }) => rest;
    rows.push({
      ...strip(lead),
      foldKey: key,
      section: lead.section,
      also: shown.filter((r) => r !== lead).map(strip),
      quiet: sorted.filter((r) => !shown.includes(r)).map(strip),
      reasonIds: sorted.map((r) => r.id),
      _i: lead._i,
    });
  }
  rows.sort((x, y) => compare(x, y) || x._i - y._i);
  let calls = 0;
  for (const r of rows) if (r.section === "call" && ++calls > callCap) r.later = true;
  const counts = Object.fromEntries(DESK_SECTIONS.map((s) => [s.key, 0]));
  for (const r of rows) counts[r.section] = (counts[r.section] || 0) + 1;
  return { rows: rows.map(({ _i, ...r }) => r), counts };
}

/**
 * nameRows(reasons, names) → reasons, each with the person's name where it was missing
 *
 * A promise the bot made to an agent with no offer and no draft in reach read
 * "An agent: we owe them an answer" (two such rows on 2026-10-02). `names` is
 * { contactId: name } off the contact record and GHL. The old title rides
 * along as `dismissedAs`, so a row dismissed while it said "An agent" stays
 * dismissed now that it has a name (shared/today-dismiss.js).
 */
export function nameRows(reasons = [], names = {}) {
  return (reasons || []).map((a) => {
    const name = a?.contactId && !a.contactName ? String(names[a.contactId] || "").trim() : "";
    if (!name) return a;
    const title = String(a.title || "");
    const renamed = /^An agent\b/.test(title) ? title.replace(/^An agent/, name) : title;
    return { ...a, contactName: name, title: renamed, ...(renamed !== title && !a.dismissedAs ? { dismissedAs: title } : {}) };
  });
}

/**
 * machineDrives(config) → the `machine` argument of callList: what the
 * machine keeps moving by itself, from the conversation settings.
 *
 * Matt, 2026-10-04: "today should only be for urgent things only a human
 * should do and i expect the app to do everything else". A hot offer is
 * the machine's while the push-to-paper ladder is on; a counter we held our
 * number on while the hold is on; a quiet offer while the offer ladder
 * repeats. Each switch off puts its rows back on the call list.
 */
export function machineDrives(config) {
  const pb = config?.parties?.agent;
  const fu = pb?.followUp;
  const on = Boolean(config?.enabled && fu?.enabled);
  return {
    hotPush: on && Boolean(fu?.ladders?.hot_push?.enabled),
    offerNudge: on && Boolean(fu?.ladders?.offer_nudge?.enabled),
    // The hold's check-ins ride the follow-up clock (counter-hold.js).
    counterHold: on && pb?.counterHold?.enabled
      ? { enabled: true, checkIns: Number(pb.counterHold.checkIns) || 2, gapHours: Number(fu?.minHoursBetween) || 72 } : null,
    nudges: on && Boolean(fu?.ladders?.offer_nudge?.enabled) && Number(fu?.ladders?.offer_nudge?.repeatEvery) > 0,
  };
}

/** heldVerdicts(audit) → Map offerId → the held-underwrite finding kind from last night. */
export function heldVerdicts(audit) {
  const out = new Map();
  for (const f of audit?.findings || []) {
    if (f?.offerId && /^held_/.test(String(f.kind || ""))) out.set(f.offerId, f.kind);
  }
  return out;
}

/* ---------- the strip: today against the line's targets ---------- */

const TZ = "America/Los_Angeles";
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/** pacificStart(now, { month }) → epoch ms of midnight Pacific today (or on the 1st). */
export function pacificStart(now = Date.now(), { month = false } = {}) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offset = wall - Math.floor(now / 1000) * 1000;   // Pacific minus UTC
  return Date.UTC(+parts.year, +parts.month - 1, month ? 1 : +parts.day) - offset;
}

/**
 * deskKpis({ offers, cards, events, targets, now }) → { calls, offers, hot, contracts }
 *
 *   calls      today: { talked, tried } — calls that were a conversation
 *              (talked-to.js callEventConnected) and every call placed,
 *              including the ones nobody picked up (call_attempt)
 *   offers     today: { sent, floated, target } — the send ledger and the
 *              floats (our read or a number), against offersPerDay
 *   hot        the board's Hot lane: current offers, price agreed or flagged,
 *              not yet a deal
 *   contracts  this month: { count, target } — deals whose first stage
 *              landed this month (a deal that later fell through still was
 *              one), against dealsPerMonth
 */
export function deskKpis({ offers = [], cards = [], events = [], targets = {}, now = Date.now() } = {}) {
  const day = pacificStart(now);
  const month = pacificStart(now, { month: true });
  const within = (t, from) => t != null && t >= from && t <= now;
  let talked = 0, tried = 0;
  for (const e of events || []) {
    if (!within(ms(e?.at), day)) continue;
    if (e.type === "call_attempt") tried++;
    else if (e.type === "call_summary") { tried++; if (callEventConnected(e)) talked++; }
  }
  let sent = 0, floated = 0, contracts = 0;
  for (const o of offers || []) {
    if (!o) continue;
    // A send that went through (Reports' rule, flow.js): a failed attempt isn't an offer out.
    if ((o.sends || []).some((x) => within(ms(x?.ts), day) && (!x.results || Object.values(x.results).some((r) => r?.ok)))) sent++;
    if (within(ms(o.proactive?.takeCheckAt), day) || within(ms(o.proactive?.realmCheckAt), day)) floated++;
    if (o.deal) {
      const first = (o.deal.stageHistory || []).map((h) => ms(h?.ts)).filter((t) => t != null).sort((a, b) => a - b)[0] ?? ms(o.deal.createdAt);
      if (within(first, month)) contracts++;
    }
  }
  return {
    calls: { talked, tried },
    offers: { sent, floated, target: Number(targets.offersPerDay) || 0 },
    hot: (cards || []).filter((c) => c?.lane === "hot").length,
    contracts: { count: contracts, target: Number(targets.dealsPerMonth) || 0 },
  };
}
