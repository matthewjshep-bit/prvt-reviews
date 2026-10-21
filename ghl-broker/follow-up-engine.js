// follow-up-engine.js — the reads behind Reports → Follow-up. The page and
// its arithmetic are shared/follow-up-engine.js.
//
// Three kinds of read, each the one the sending code itself makes, so the
// page and the machine can't disagree:
//   what went      send events (never pruned) and the outbox's sent rows
//   what's queued  outbox rows with a send time, and machine drafts held
//   what's coming  each sweep's own planner: nextFollowUp on every offer, the
//                  two check-in plans, the follow-up sweep's candidates, the
//                  counter holds, the dispo wave clock, the walkthrough
//                  touches, the written offer after a float
//
// Reads only. Nothing here claims, drafts or sends. Names reach the API body
// and never a log line.

import {
  buildFollowUpEngine, mechanismOf, periodWindow, rollOntoRuns, runsBetween, pacificParts, pacificWallTime,
  FOLLOW_UP_PERIODS, MECHANISM_BY_KEY,
} from "./shared/follow-up-engine.js";
import { annotateCurrent, currentOffers } from "./shared/current-offer.js";
import { buildFlow } from "./shared/flow.js";
import { offerLeaks } from "./shared/line.js";
import { nextRungAt, staleHeld, PERSON_PROMISES, PROMISE_DUE_HOURS } from "./shared/follow-up.js";
import { sweepTime } from "./shared/next-follow-up.js";
import { effectiveStatus, OPEN_STATUSES, priceAgreed, isHot } from "./shared/offer-status.js";
import { holdState, callsInstead } from "./shared/counter-hold.js";
import { paperAfterSilenceDue, paperWent, addWorkingHours, PAPER_FLOAT_MAX_DAYS } from "./shared/paper-follows.js";
import { showingTouches } from "./shared/showing.js";
import { callEventConnected } from "./shared/talked-to.js";
import { attachNextFollowUps } from "./next-follow-up.js";
import { planAgentPulse, pulseWorkflows, pulseTierCards, MATTS_FIFTEEN_REASON, CURSOR_NAME as AGENT_PULSE_CURSOR } from "./agent-pulse.js";
import { planBuyerPulse, pulseSettings as buyerPulseSettings } from "./buyer-pulse.js";
import {
  outreachCandidates, investorCandidates, secondLookCandidates, FOLLOW_UP_UTC_HOUR, CURSOR_NAME as FOLLOW_UP_CURSOR,
} from "./follow-up-sweep.js";
import { conversationConfig, OUTBOUND_KINDS } from "./reply-agent.js";
import { machineHours, nextSendTime } from "./conversation-scheduler.js";
import { allEventsSince } from "./contact-events.js";
import { normalizeDispoAutopilot, catchUpDue, DISPO_SWEEP_UTC_HOUR } from "./dispo-autopilot.js";
import { normalizeOutreachAutopilot } from "./outreach-sweep.js";
import { followUpCandidates, OUTREACH_FOLLOWUP_HOUR, MAX_PER_RUN as GHL_FOLLOW_UP_PER_RUN, CURSOR_NAME as OUTREACH_FOLLOW_UP_CURSOR } from "./outreach-followup.js";
import { addressChaseRungs, ADDRESS_CHASE_WINDOW_DAYS } from "./promise-sweep.js";
import { normalizeAgentPulse } from "./shared/agent-pulse.js";

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const iso = (t) => new Date(t).toISOString();
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
// How far back the clocks look (next-follow-up.js NEXT_WINDOW_DAYS).
const PLAN_DAYS = 130;
// A check-in they asked for can be months out ("in the spring").
const ASK_DAYS = 200;
// A draft queued days ahead (a buyer's week) can send inside the period.
const LEDGER_SLACK_DAYS = 14;
const PROMISE_WINDOW_HOURS = 72;
// What a due check-in is about (shared/agent-pulse.js evaluateAgent pulseReason).
const PULSE_ABOUT = { fresh_listing: "their fresh listing", off_market_listing: "an off-market listing", our_house: "the house they had with us", deal_thanks: "thanks after a deal", general: "anything coming up" };

// Sends written when the text actually leaves (reply-agent.js sendReplyDraft,
// offers.js sendPaperAfterSilence, the import's workflow enrolment).
const SEND_EVENT_TYPES = ["outreach_sent", "outreach_enrolled", "agent_pulse_texted", "pulse_texted", "blast_sent", "second_look_sent", "offer_sent"];
const INBOUND_TYPES = ["text_summary", "call_summary"];
// What the forecasts read off the timeline.
const PLAN_EVENT_TYPES = [
  "checkin_requested", "checkin_sent", "promise_made", "promise_owed", "promise_kept",
  "address_pending", "address_pending_closed", "address_chase_sent", "subject_property_set", "hand_reply", "call_attempt",
  "outreach_enrolled", "offer_sent", "realm_yes", "deal_promoted", "outreach_left", "follow_up_sent",
  ...INBOUND_TYPES,
];

// The job behind each row, for "last ran".
const CURSOR_OF = {
  outreach_open: "outreach", ghl_first: "outreach", ghl_followup: OUTREACH_FOLLOW_UP_CURSOR,
  agent_pulse: AGENT_PULSE_CURSOR, matts_fifteen: "mattsFifteen",
  outreach_nudge: FOLLOW_UP_CURSOR, offer_nudge: FOLLOW_UP_CURSOR, hot_push: FOLLOW_UP_CURSOR, counter_nudge: FOLLOW_UP_CURSOR,
  passed_checkin: FOLLOW_UP_CURSOR, second_look: FOLLOW_UP_CURSOR, deal_followup: FOLLOW_UP_CURSOR,
  held_underwrite: "conversationAudit", float: "daytimeDriver", paper_after_float: "paperAfterFloat",
  price_drop: "priceWatch", buyer_pulse: "buyerPulse", blast_wave: "dispo",
};

const lastRunOf = (c) => {
  if (!c) return null;
  const d = c.doc || {};
  const last = d.last && typeof d.last === "object" ? d.last : {};
  return last.finishedAt || last.at || d.lastDaily || c.at || null;
};
// The daily gate's "ran today" (daily-gate.js): a run in the last 20 hours.
const ranToday = (c, now) => {
  const t = ms(c?.doc?.lastDaily || c?.at);
  return t != null && now - t < 20 * HOUR_MS;
};

/**
 * mechanismStatuses({ config, saved, env }) → { [mech]: { state, why } }
 *
 * The same gates the sender checks: the Conversation AI switch, the kind's
 * own switch (OUTBOUND_KINDS[kind].enabled — what startProactive asks), and
 * whether it may send itself (the auto-send allowlist, the per-feature
 * autoSend, the broker's send flags). On = goes by itself; Drafts only =
 * written and held for you; Off = nothing is written.
 *
 *   env  { sends: CARD_SENDS_ENABLED, blasts: DISPO_BLASTS_ENABLED, imports: OUTREACH_IMPORTS_ENABLED }
 */
export function mechanismStatuses({ config, saved = {}, env = {} }) {
  const pa = config.parties?.agent || {}, pi = config.parties?.investor || {};
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  const ap = normalizeAgentPulse(saved.outreachAutopilot?.pulse);
  const da = normalizeDispoAutopilot(saved.dispoAutopilot);
  const bp = buyerPulseSettings(saved);
  const kindOn = (pb, k) => Boolean(OUTBOUND_KINDS[k]?.enabled(pb));
  const listed = (pb, k) => Boolean(pb.autoSend?.enabled && (pb.autoSend.intents || []).includes(k));
  const AI_OFF = { state: "off", why: "the Conversation AI is off" };
  const SENDS_OFF = "sending is off on the broker (CARD_SENDS_ENABLED)";
  // on: the switch; auto: it sends itself; why: what keeps it a draft.
  const st = (on, auto, offWhy, draftWhy) => {
    if (!on) return { state: "off", why: offWhy };
    if (auto) return { state: "on", why: "" };
    return { state: "drafts", why: draftWhy };
  };
  const ai = (fn) => (config.enabled ? fn() : AI_OFF);
  const agentKind = (k, extraOn = true, extraWhy = "") => ai(() => st(kindOn(pa, k) && extraOn, env.sends && listed(pa, k),
    extraWhy && !extraOn ? extraWhy : "switched off in Autopilot", env.sends ? "not on the agent auto-send list — it waits for you" : SENDS_OFF));

  const out = {};
  // First texts
  if (oa.firstTouch === "app") {
    out.outreach_open = !oa.enabled ? { state: "off", why: "the outreach autopilot is off" }
      : !env.imports ? { state: "off", why: "imports are off on the broker (OUTREACH_IMPORTS_ENABLED)" }
      : agentKind("outreach_open");
    out.ghl_first = { state: "off", why: "first touch is the app's" };
  } else {
    out.outreach_open = { state: "off", why: `first touch is set to ${oa.firstTouch === "ghl" ? "GHL" : "a GHL workflow"}` };
    out.ghl_first = oa.enabled && env.imports ? { state: "ghl", why: "" } : { state: "off", why: "the outreach autopilot is off" };
  }
  // Agents
  out.agent_pulse = ai(() => st(ap.enabled, ap.autoSend && env.sends, "the agent check-in is off", env.sends ? "check-ins are drafted for you (auto-send is off)" : SENDS_OFF));
  out.matts_fifteen = ap.mattsFifteen?.enabled ? { state: "drafts", why: "always yours to send" } : { state: "off", why: "Matt's 15 is off" };
  out.outreach_nudge = agentKind("outreach_nudge");
  out.ghl_followup = oa.enabled && oa.followUpEnabled && oa.followUpWorkflowId ? { state: "ghl", why: "" } : { state: "off", why: "the GHL follow-up workflow is off" };
  out.checkin_due = agentKind("checkin_due");
  out.promise_due = config.driver?.promises?.enabled && config.enabled && kindOn(pa, "promise_due")
    ? (env.sends ? { state: "on", why: "" } : { state: "drafts", why: SENDS_OFF }) : agentKind("promise_due");
  out.address_chase = agentKind("address_chase");
  out.held_underwrite = ai(() => st(kindOn(pa, "take_ask") && config.nightlyAudit?.enabled !== false, env.sends && (listed(pa, "take_ask") || listed(pa, "kind_pass")),
    "follow-ups or the nightly audit are off", env.sends ? "not on the agent auto-send list — it waits for you" : SENDS_OFF));
  // Offers
  out.offer_nudge = agentKind("offer_nudge");
  out.hot_push = agentKind("hot_push");
  // Counter holds start with releaseHeld: a clean one sends (counter-hold.js).
  out.counter_nudge = ai(() => st(kindOn(pa, "counter_nudge") && Boolean(pa.counterHold?.enabled), env.sends, "the counter hold is off", SENDS_OFF));
  {
    const af = pa.sendOffer?.afterFloat;
    out.paper_after_float = ai(() => (!af?.enabled ? { state: "off", why: "the written offer after a float is off" }
      : env.sends ? { state: "on", why: "" } : { state: "off", why: SENDS_OFF }));
  }
  out.float = ai(() => st((kindOn(pa, "realm_check") || kindOn(pa, "take_check")) && Boolean(config.driver?.timers?.enabled),
    env.sends && (listed(pa, "realm_check") || listed(pa, "take_check")), "the float timer is off",
    env.sends ? "not on the agent auto-send list — it waits for you" : SENDS_OFF));
  out.passed_checkin = agentKind("passed_checkin", Boolean(pa.followUp?.relist), "only relisted houses get one, and Relist is off");
  out.second_look = agentKind("second_look");
  out.price_drop = agentKind("price_drop");
  // Buyers
  const blastOn = env.sends && env.blasts;
  out.buyer_pulse = ai(() => st(bp.enabled, bp.autoSend && blastOn, "the buyer check-in is off", blastOn ? "buyer check-ins are drafted for you" : "deal texts are off on the broker (DISPO_BLASTS_ENABLED)"));
  const blastStatus = (needsAuto) => {
    if (da.sendWith === "ghl") return { state: "ghl", why: "" };
    // Without blast on promote a deal goes to buyers when you press Blast: yours, not the machine's.
    if (!da.autoBlastOnPromote) return { state: "off", why: needsAuto ? "blast on promote is off" : "blast on promote is off — a deal goes out when you press Blast" };
    return ai(() => st(true, blastOn && listed(pi, "blast_open"), "", blastOn ? "\"sent them a deal\" isn't on the investor auto-send list" : "deal texts are off on the broker (DISPO_BLASTS_ENABLED)"));
  };
  out.blast_first = blastStatus(false);
  out.blast_wave = blastStatus(true);
  out.deal_followup = ai(() => st(kindOn(pi, "deal_followup"), env.sends && listed(pi, "deal_followup"), "switched off in Autopilot", env.sends ? "not on the investor auto-send list — it waits for you" : SENDS_OFF));
  out.showing = ai(() => st(da.showings.remindDayBefore || da.showings.followUpAfter, da.showings.autoSend && blastOn, "walkthrough texts are off", "walkthrough texts are drafted for you"));
  return out;
}

/* ---------- forecasts ---------- */

// A ladder rung, the way the follow-up sweep would take it (follow-up-sweep.js
// runSweep / dueStep): not after they answered when the ladder stops on any
// inbound, never inside the gap since our last touch, on the next sweep.
function ladderAt(c, { fu, weekends, now }) {
  if (fu.stopOnAnyInbound && c.lastInboundAt && String(c.lastInboundAt) > String(c.startedAt)) return null;
  const r = nextRungAt({ steps: c.ladder.steps, repeatEvery: c.ladder.repeatEvery, startedAt: c.startedAt, sentSteps: c.sentSteps || [], now });
  if (!r) return null;
  let t = r.due ? now : ms(r.at);
  const touched = ms(c.lastTouchAt);
  if (touched != null) t = Math.max(t, touched + (Number(fu.minHoursBetween) || 0) * HOUR_MS);
  return { at: sweepTime(t, FOLLOW_UP_UTC_HOUR, weekends), step: r.step };
}

// Inside the machine's hours (conversation-scheduler.js): a machine-started
// text due at night goes in the morning.
const inMachineHours = (t, config) => {
  const out = Date.parse(nextSendTime({ now: t, delayMs: 0, quietHours: machineHours(config.autoSend || {}) }));
  return Number.isFinite(out) ? out : t;
};

const byContact = (rows) => {
  const m = new Map();
  for (const r of rows || []) {
    if (!r?.contactId) continue;
    if (!m.has(r.contactId)) m.set(r.contactId, []);
    m.get(r.contactId).push(r);
  }
  for (const list of m.values()) list.sort((a, b) => String(a.at || a.createdAt || "").localeCompare(String(b.at || b.createdAt || "")));
  return m;
};

/**
 * contactAsks({ events, config, now }) → [item] — the check-ins they asked
 * for and the promises we made, one per contact (next-follow-up.js reads
 * these the same way, per offer; these also cover agents with no offer).
 */
export function contactAsks({ events = [], config, now = Date.now() }) {
  const out = [];
  const fu = config.parties?.agent?.followUp || {};
  if (!config.enabled || !fu.enabled) return out;
  for (const [contactId, list] of byContact(events)) {
    const req = list.filter((e) => e.type === "checkin_requested").at(-1);
    if (req && !list.some((e) => e.type === "checkin_sent" && e.data?.requestAt === req.at)
        && !list.some((e) => INBOUND_TYPES.includes(e.type) && String(e.at) > String(req.at))) {
      const at = ms(req.data?.dueAt) ?? ms(req.at);
      if (at != null) out.push({ mech: "checkin_due", at: iso(at), contactId, address: req.address || "", note: String(req.data?.phrase || "").slice(0, 60) });
    }
    const pr = list.filter((e) => ["promise_made", "promise_owed", "promise_kept"].includes(e.type) && (ms(e.at) ?? 0) >= now - PROMISE_WINDOW_HOURS * HOUR_MS);
    const keptAt = pr.filter((e) => e.type === "promise_kept").at(-1)?.at || "";
    const made = pr.filter((e) => e.type === "promise_made" && e.data?.by !== "you" && !PERSON_PROMISES.has(e.data?.what) && String(e.at) > keptAt
      && (e.data?.asksThem !== true || e.data?.what === "paper"));
    if (made.length) {
      const at = ms(made[0].data?.dueAt) ?? (ms(made[0].at) + PROMISE_DUE_HOURS * HOUR_MS);
      out.push({ mech: "promise_due", at: iso(at), contactId, address: made[0].address || "", note: made[0].data?.what ? `we owe them ${made[0].data.what === "number" ? "a number" : made[0].data.what === "paper" ? "the written offer" : "an answer"}` : "" });
    }
  }
  return out;
}

// promise-sweep.js youTookIt: your own text, or a call that connected or that we placed.
const youTookIt = (e) => e.type === "hand_reply"
  || (e.type === "call_summary" && callEventConnected(e))
  || (e.type === "call_attempt" && (e.source === "operator" || e.data?.direction === "outbound"));

/** addressChases({ events, now }) → [item] — the next rung of each open address chase (promise-sweep.js runAddressChase). */
export function addressChases({ events = [], now = Date.now() }) {
  const out = [];
  const since = now - ADDRESS_CHASE_WINDOW_DAYS * DAY_MS;
  for (const [contactId, list] of byContact(events)) {
    const pending = list.filter((e) => e.type === "address_pending" && (ms(e.at) ?? 0) >= since).at(-1);
    if (!pending) continue;
    const after = (e) => String(e.at) > String(pending.at);
    if (list.some((e) => after(e) && (e.type === "subject_property_set" || e.type === "address_pending_closed" || youTookIt(e)))) continue;
    const rungs = addressChaseRungs(pending);
    const sent = new Set(list.filter((e) => e.type === "address_chase_sent" && e.data?.pendingAt === pending.at).map((e) => Number(e.data?.step)));
    let due = -1;
    rungs.forEach((t, i) => { if (t <= now) due = i; });
    // The sweep sends only the latest rung that's due, never a backlog.
    const i = due >= 0 && !sent.has(due) ? due : rungs.findIndex((t, k) => k > due && t > now);
    if (i < 0) continue;
    out.push({ mech: "address_chase", at: iso(Math.max(rungs[i], now)), contactId, note: `ask ${i + 1} of ${rungs.length}` });
  }
  return out;
}

/* ---------- the read ---------- */

// The plan doesn't depend on the period: switching chips reuses it.
const planMemo = new Map();
const PLAN_MEMO_MS = 60000;

async function planContext({ store, locationId, saved, client, now, deps }) {
  const hit = planMemo.get(locationId);
  if (hit && Math.abs(now - hit.at) < PLAN_MEMO_MS) return hit.ctx;
  const since = iso(now - PLAN_DAYS * DAY_MS);
  const [offersRaw, drafts, openDrafts, planRead, askRead, deals, cursors] = await Promise.all([
    store.listOffers(locationId, { limit: 5000, lean: true }).catch(() => []),
    store.listReplyDrafts(locationId, { since, limit: 4000 }).catch(() => []),
    store.listReplyDrafts(locationId, { status: ["draft", "scheduled", "sending"], limit: 3000 }).catch(() => []),
    allEventsSince(store, locationId, since, { types: PLAN_EVENT_TYPES }, { ceiling: 100000 }).catch(() => ({ events: [], truncated: false })),
    store.listContactEventsSince(locationId, iso(now - ASK_DAYS * DAY_MS), { types: ["checkin_requested", "checkin_sent"], limit: 20000 }).catch(() => []),
    store.listDeals(locationId, { limit: 500 }).catch(() => []),
    typeof store.listJobCursors === "function" ? store.listJobCursors(locationId).catch(() => []) : [],
  ]);
  const offers = annotateCurrent(offersRaw);
  await attachNextFollowUps({ store, locationId, saved, offers, drafts, now }).catch(() => {});
  const ctx = { offers, drafts, openDrafts, events: planRead.events || [], askEvents: askRead || [], deals, cursors, truncated: Boolean(planRead.truncated) };
  // The planners: each sweep's own.
  const config = conversationConfig(saved || {});
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  const [agentPlan, buyerPlan, outreach, investors, looks] = await Promise.all([
    planAgentPulse({ locationId, saved, store, now,
      workflows: await pulseWorkflows(client, locationId, deps).catch(() => null),
      tierCards: await pulseTierCards(client, locationId, deps).catch(() => null) }).catch(() => null),
    deps.buyerBook ? planBuyerPulse({ locationId, saved, store, now, deps: { book: deps.buyerBook } }).catch(() => null) : null,
    outreachCandidates({ store, locationId, config, now, ghlCohort: oa.nudgeGhlCohort }).catch(() => []),
    investorCandidates({ store, locationId, config, now }).catch(() => []),
    secondLookCandidates({ store, locationId, config, now }).catch(() => []),
  ]);
  Object.assign(ctx, { agentPlan, buyerPlan, outreach, investors, looks });
  planMemo.set(locationId, { at: now, ctx });
  return ctx;
}

/** _resetPlanMemo() — tests. */
export function _resetPlanMemo() { planMemo.clear(); }

/**
 * followUpEngineFor({ store, locationId, saved, period, now, client, deps, env })
 *   → buildFollowUpEngine() output
 *
 *   deps  { buyerBook(locationId), listWorkflows(), tierCards() } — the GHL
 *         reads the agent check-in plan wants (cached there), and the buyer
 *         book; any left out, that part of the plan is thinner, not wrong
 *   env   { sends, blasts, imports } — the broker's send flags
 */
export async function followUpEngineFor({ store, locationId, saved = {}, period = "week", now = Date.now(), client = null, deps = {}, env = {} }) {
  if (!FOLLOW_UP_PERIODS.includes(period)) throw Object.assign(new Error(`unknown period "${period}"`), { http: 400 });
  const config = conversationConfig(saved || {});
  const win = periodWindow(period, now);
  const until = win.end;
  const startIso = iso(win.start);

  const [ctx, ledger, periodRead] = await Promise.all([
    planContext({ store, locationId, saved, client, now, deps }),
    (typeof store.listReplyDraftLedger === "function"
      ? store.listReplyDraftLedger(locationId, { status: "sent", since: iso(win.start - LEDGER_SLACK_DAYS * DAY_MS), limit: 50000 })
      : store.listReplyDrafts(locationId, { status: "sent", since: iso(win.start - LEDGER_SLACK_DAYS * DAY_MS), limit: 20000 })).catch(() => []),
    allEventsSince(store, locationId, startIso, { types: [...SEND_EVENT_TYPES, ...INBOUND_TYPES, "import"] }, { ceiling: 100000 }).catch(() => ({ events: [], truncated: false })),
  ]);
  const periodEvents = periodRead.events || [];

  // Names, from the offers and the outbox. Never logged.
  const names = new Map();
  for (const o of ctx.offers) if (o?.contactId && o.contactName) names.set(o.contactId, o.contactName);
  for (const d of [...ctx.drafts, ...ctx.openDrafts, ...ledger]) if (d?.contactId && d.contactName && !names.has(d.contactId)) names.set(d.contactId, d.contactName);
  for (const e of periodEvents) if (e?.contactId && e.data?.contactName && !names.has(e.contactId)) names.set(e.contactId, e.data.contactName);
  const nameOf = (id) => names.get(id) || "";

  // Which wave a deal text was: the deal's own blasts, by time.
  const blastsBy = new Map();
  for (const o of [...ctx.deals, ...ctx.offers]) {
    const b = Array.isArray(o?.deal?.blasts) ? o.deal.blasts : [];
    if (o?.id && b.length && !blastsBy.has(o.id)) blastsBy.set(o.id, b.map((x) => ms(x.at)).filter((t) => t != null).sort((a, b) => a - b));
  }
  const waveOf = (offerId, at) => {
    const times = blastsBy.get(offerId) || [];
    const t = ms(at);
    if (!times.length || t == null) return 1;
    // The wave whose queueing came last before this text (a minute's grace).
    return Math.max(1, times.filter((x) => x <= t + 60000).length);
  };

  /* --- what went --- */
  const forMatt = new Set(ledger.filter((d) => d.outbound?.forMatt).map((d) => d.id));
  const sent = [];
  for (const e of periodEvents) {
    let mech = null;
    switch (e.type) {
      case "outreach_sent": mech = "outreach_open"; break;
      case "outreach_enrolled": mech = e.data?.kind === "followup" ? "ghl_followup" : "ghl_first"; break;
      case "agent_pulse_texted": mech = e.data?.reason === MATTS_FIFTEEN_REASON || forMatt.has(e.data?.draftId) ? "matts_fifteen" : "agent_pulse"; break;
      case "pulse_texted": mech = "buyer_pulse"; break;
      case "blast_sent": mech = waveOf(e.offerId, e.at) > 1 ? "blast_wave" : "blast_first"; break;
      case "second_look_sent": mech = "second_look"; break;
      case "offer_sent": if (e.data?.by === "after_float" || e.data?.by === "after_answer") mech = "paper_after_float"; break;
      default: break;
    }
    if (mech) sent.push({ mech, src: "event", at: e.at, contactId: e.contactId, name: nameOf(e.contactId), offerId: e.offerId || null, address: e.address || "" });
  }
  for (const d of ledger) {
    if (d.status !== "sent" || d.hasInbound) continue;
    const mech = mechanismOf(d, { wave: waveOf(d.outbound?.offerId, d.createdAt) });
    if (!mech) continue;
    sent.push({ mech, src: "draft", at: d.sentAt || d.createdAt, contactId: d.contactId, name: d.contactName || nameOf(d.contactId),
      offerId: d.outbound?.offerId || null, address: d.outbound?.address || "", who: d.autoSent ? "machine" : "you" });
  }
  const inbound = periodEvents.filter((e) => e.type === "call_summary" || (e.type === "text_summary" && String(e.data?.inbound || "").trim()))
    .map((e) => ({ contactId: e.contactId, at: e.at }));

  /* --- what's written --- */
  const queued = [], held = [];
  for (const d of ctx.openDrafts) {
    if (String(d.inbound || "").trim()) continue;
    const mech = mechanismOf(d, { wave: waveOf(d.outbound?.offerId, d.createdAt) });
    if (!mech) continue;
    const item = { mech, contactId: d.contactId, name: d.contactName || nameOf(d.contactId), offerId: d.outbound?.offerId || null, address: d.outbound?.address || "" };
    if ((d.status === "scheduled" || d.status === "sending") && d.sendAt) queued.push({ ...item, at: d.sendAt, who: "machine" });
    else if (d.status === "draft" && !staleHeld(d, now)) held.push({ ...item, at: d.createdAt, who: "you", note: String(d.autoSend?.reason || d.humanReason || "").slice(0, 120) });
  }

  /* --- what's coming --- */
  const status = mechanismStatuses({ config, saved, env });
  const live = (mech) => status[mech] && status[mech].state !== "off";
  const whoOf = (mech) => (status[mech]?.state === "on" || status[mech]?.state === "ghl" ? "machine" : "you");
  const cursorOf = (name) => ctx.cursors.find((c) => c?.name === name) || null;
  const planned = [];
  const plan = (mech, x) => { if (live(mech)) planned.push({ mech, who: whoOf(mech), ...x, name: x.name || nameOf(x.contactId) }); };
  const pa = config.parties?.agent || {}, pi = config.parties?.investor || {};
  const weekends = pa.autoSend?.weekends || "replies_only";

  // Offers: the Offers column's own answer, on each house's current row.
  const current = ctx.offers.filter((o) => o && !o.supersededBy && o.isCurrent !== false);
  const NEXT_MECH = { offer_nudge: "offer_nudge", hot_push: "hot_push", passed_checkin: "passed_checkin", float: "float" };
  for (const o of current) {
    const n = o.nextFollowUp;
    const mech = n && NEXT_MECH[n.kind];
    if (!mech || !n.at || (mech === "float" && n.who !== "machine")) continue;
    plan(mech, { at: n.at, contactId: o.contactId, offerId: o.id, address: o.address || "", note: n.label || "", who: n.who === "machine" ? whoOf(mech) : "you" });
  }
  // Check-ins they asked for, promises we made, address chases.
  const asks = contactAsks({ events: [...ctx.askEvents, ...ctx.events.filter((e) => e.type !== "checkin_requested" && e.type !== "checkin_sent")], config, now });
  for (const a of asks) plan(a.mech, { ...a, at: iso(inMachineHours(Math.max(ms(a.at), now), config)) });
  for (const a of addressChases({ events: ctx.events, now })) plan("address_chase", { ...a, at: iso(inMachineHours(ms(a.at), config)) });

  // The cold-agent ladder and the buyer's deal follow-up: the sweep's candidates.
  for (const c of ctx.outreach) {
    const r = ladderAt(c, { fu: pa.followUp || {}, weekends, now });
    if (r) plan("outreach_nudge", { at: iso(r.at), contactId: c.contactId, address: c.address || "", note: `day ${r.step}` });
  }
  for (const c of ctx.investors) {
    const r = ladderAt(c, { fu: pi.followUp || {}, weekends: pi.autoSend?.weekends || "replies_only", now });
    if (r) plan("deal_followup", { at: iso(r.at), contactId: c.contactId, offerId: c.offerId, address: c.address || "" });
  }
  // A second look: picked each morning, so only today's picks are known.
  if (!ranToday(cursorOf(FOLLOW_UP_CURSOR), now)) {
    for (const c of ctx.looks) plan("second_look", { at: iso(sweepTime(now, FOLLOW_UP_UTC_HOUR, weekends)), contactId: c.contactId, offerId: c.offerId, address: c.address || "" });
  }

  // Counter holds (counter-hold.js runCounterHolds), from the drafts already read.
  if (live("counter_nudge")) {
    const hold = pa.counterHold || {};
    const gapHours = Number(pa.followUp?.minHoursBetween) || 72;
    const draftsBy = byContact(ctx.drafts.map((d) => ({ ...d, at: d.createdAt })));
    for (const o of current) {
      if (!o?.counterHold?.at || !o.contactId || o.deal || !OPEN_STATUSES.has(effectiveStatus(o)) || priceAgreed(o) || isHot(o) || callsInstead(o, hold.callWithinPct ?? 10)) continue;
      const ds = draftsBy.get(o.contactId) || [];
      const lastInboundAt = ds.filter((d) => String(d.inbound || "").trim()).map((d) => d.createdAt).sort().at(-1) || null;
      const lastOutboundAt = ds.filter((d) => d.status === "sent").map((d) => d.sentAt || d.updatedAt || d.createdAt).filter(Boolean).sort().at(-1) || null;
      const checkIns = hold.checkIns || 2;
      const s = holdState(o, { lastInboundAt, lastOutboundAt, checkIns, gapHours, now });
      const unmoved = (o.counterHold.nudges || []).length + (o.counterHold.replies || []).length;
      if (unmoved >= checkIns) continue;      // what comes next is our pass, not a text
      const at = s.next === "nudge" ? now : s.next === "wait" && s.at ? ms(s.at) : null;
      if (at != null) plan("counter_nudge", { at: iso(sweepTime(at, FOLLOW_UP_UTC_HOUR, weekends)), contactId: o.contactId, offerId: o.id, address: o.address || "", note: `check-in ${unmoved + 1} of ${checkIns}` });
    }
  }

  // The written offer after a float nobody answered (offers.js sendPaperAfterSilence).
  if (live("paper_after_float")) {
    const af = pa.sendOffer?.afterFloat || {};
    const oldest = now - (PAPER_FLOAT_MAX_DAYS + 1) * DAY_MS;
    const draftsBy = byContact(ctx.drafts.map((d) => ({ ...d, at: d.createdAt })));
    const eventsBy = byContact(ctx.events);
    const floated = current.filter((o) => !o.deal && !paperWent(o) && ["new", "sent"].includes(effectiveStatus(o))
      && Math.max(ms(o.floatSentAt) ?? 0, ms(o.proactive?.realmCheckAt) ?? 0) > oldest).slice(0, 100);
    // The lean row has no paperAfterFloat: read the few in full.
    const full = await Promise.all(floated.map((o) => store.getOffer(o.id).catch(() => null)));
    full.forEach((o, i) => {
      if (!o || o.paperAfterFloat) return;
      const q = paperAfterSilenceDue({ offer: o, drafts: draftsBy.get(o.contactId) || [], events: eventsBy.get(o.contactId) || [], silenceHours: af.silenceHours, withFloat: af.withFloat, now });
      let at = null;
      if (q.due) at = now;
      else if (q.floatAt && /not a working day/.test(q.reason)) at = addWorkingHours(ms(q.floatAt), af.silenceHours ?? 24);
      if (at != null) plan("paper_after_float", { at: iso(inMachineHours(at, config)), contactId: o.contactId, offerId: o.id, address: o.address || floated[i].address || "" });
    });
  }

  // The agent check-in: each agent's own due day (shared/agent-pulse.js
  // evaluateAgent), onto the weekday noon runs at the daily cap.
  if (live("agent_pulse") && ctx.agentPlan) {
    const s = ctx.agentPlan.settings || {};
    const due = (ctx.agentPlan.verdicts || []).filter((v) => v.status === "due" || (v.status === "not_due" && v.dueAt))
      // A due verdict's reason is what the check-in is about; a later one's is
      // why it waits — so later ones say only which agents they are.
      .map((v) => ({ contactId: v.contactId, due: v.status === "due" ? iso(now) : v.dueAt,
        note: [v.segment, v.status === "due" ? PULSE_ABOUT[v.reason] : ""].filter(Boolean).join(" · ") }));
    const seats = ctx.agentPlan.seats;
    for (const x of rollOntoRuns(due, { hour: s.hour ?? 12, weekdaysOnly: s.weekdaysOnly !== false, cap: s.dailyCap > 0 ? s.dailyCap : Infinity,
      firstCap: Number.isFinite(seats) ? seats : null, now, until, ranToday: ranToday(cursorOf(AGENT_PULSE_CURSOR), now) })) {
      plan("agent_pulse", { at: x.at, contactId: x.contactId, note: x.note });
    }
  }
  // Matt's 15: a batch on its weekday, for him.
  if (live("matts_fifteen")) {
    const s = normalizeAgentPulse(saved.outreachAutopilot?.pulse).mattsFifteen;
    const ran = ranToday(cursorOf("mattsFifteen"), now);
    for (const r of runsBetween({ hour: s.hour, weekdaysOnly: false, from: now - 5 * HOUR_MS, until })) {
      if (pacificParts(r).wd !== s.weekday || (ran && r <= now + 20 * HOUR_MS)) continue;
      planned.push({ mech: "matts_fifteen", who: "you", at: iso(Math.max(r, now)), count: s.size, note: `${s.size} check-ins drafted for you` });
    }
  }
  // The GHL follow-up workflow: enrolled `followUpDays` after the first text, 11am weekdays, 100 a run.
  if (live("ghl_followup")) {
    const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
    const nudged = new Set(ctx.events.filter((e) => e.type === "follow_up_sent" && e.data?.kind === "outreach_nudge").map((e) => e.contactId));
    const due = followUpCandidates(ctx.events, { days: oa.followUpDays, now: until })
      .filter((c) => !nudged.has(c.contactId))
      .map((c) => ({ contactId: c.contactId, address: c.address, due: iso(ms(c.enrolledAt) + oa.followUpDays * DAY_MS) }));
    for (const x of rollOntoRuns(due, { hour: OUTREACH_FOLLOWUP_HOUR, weekdaysOnly: oa.weekdaysOnly !== false, cap: GHL_FOLLOW_UP_PER_RUN, now, until,
      ranToday: ranToday(cursorOf(OUTREACH_FOLLOW_UP_CURSOR), now) })) {
      planned.push({ mech: "ghl_followup", who: "machine", at: x.at, contactId: x.contactId, name: nameOf(x.contactId), address: x.address || "" });
    }
  }

  // Buyers: the check-in plan, the wave clock, the walkthrough touches.
  if (live("buyer_pulse") && ctx.buyerPlan) {
    const s = ctx.buyerPlan.settings || {};
    const picks = (ctx.buyerPlan.picks || []).map((p) => ({ contactId: p.contactId, name: p.name || "", due: iso(now) }));
    // The rest of the buyers due now wait for later runs at the daily cap.
    const rest = Math.max(0, (Number(ctx.buyerPlan.counts?.eligible) || 0) - picks.length);
    const anon = Array.from({ length: Math.min(rest, 5000) }, () => ({ contactId: null, due: iso(now) }));
    const rolled = rollOntoRuns([...picks, ...anon], { hour: s.hour ?? 11, weekdaysOnly: s.weekdaysOnly !== false, cap: s.dailyCap || 10,
      firstCap: ctx.buyerPlan.counts?.seatsLeft ?? null, now, until, ranToday: ranToday(cursorOf("buyerPulse"), now) });
    const bundles = new Map();
    for (const x of rolled) {
      if (x.contactId) { plan("buyer_pulse", { at: x.at, contactId: x.contactId, name: x.name }); continue; }
      bundles.set(x.at, (bundles.get(x.at) || 0) + 1);
    }
    for (const [at, count] of bundles) plan("buyer_pulse", { at, count, note: `${count} buyer${count === 1 ? "" : "s"} due, picked that morning` });
  }
  if (live("blast_wave")) {
    for (const o of ctx.deals) {
      if (!o?.deal || !catchUpDue(o.deal).due) continue;
      plan("blast_wave", { at: iso(sweepTime(now, DISPO_SWEEP_UTC_HOUR, "all")), offerId: o.id, address: o.address || "",
        note: "anyone new who buys in the area" });
    }
  }
  if (live("showing")) {
    const sh = normalizeDispoAutopilot(saved.dispoAutopilot).showings;
    for (const o of ctx.deals) {
      const windows = o?.deal?.showing?.windows || [];
      for (const w of windows) {
        const start = ms(w.start), end = ms(w.end);
        if (start == null || end == null) continue;
        // The two moments the sweep would find each touch due: the afternoon
        // before (15:30 Pacific), and two hours after the window ends.
        const p = pacificParts(start);
        const probes = [pacificWallTime(p.y, p.m - 1, p.d - 1, 15) + 30 * 60000, end + 2 * HOUR_MS + 60000];
        for (const t of probes) {
          if (t <= now || t >= until) continue;
          for (const x of showingTouches(o, { now: t, remindDayBefore: sh.remindDayBefore, followUpAfter: sh.followUpAfter })) {
            if (x.windowStart !== w.start) continue;
            plan("showing", { at: iso(t), contactId: x.contactId, name: x.name, offerId: o.id, address: o.address || "", note: x.kind === "showing_reminder" ? "reminder" : "follow-up" });
          }
        }
      }
    }
  }

  /* --- the rest of the page --- */
  const cohort = buildFlow({ offers: [], drafts: [], events: periodEvents, now, windowStartMs: win.start, windowEndMs: now, feedLimit: 0 }).cohort || null;
  const leaks = offerLeaks(current, { now });
  const lastRuns = {};
  for (const [mech, name] of Object.entries(CURSOR_OF)) lastRuns[mech] = lastRunOf(cursorOf(name));

  const settings = {
    fu: pa.followUp || {}, ifu: pi.followUp || {},
    agentPulse: normalizeAgentPulse(saved.outreachAutopilot?.pulse), buyerPulse: buyerPulseSettings(saved),
    dispo: normalizeDispoAutopilot(saved.dispoAutopilot), outreach: normalizeOutreachAutopilot(saved.outreachAutopilot),
    afterFloat: pa.sendOffer?.afterFloat || {}, counterHold: pa.counterHold || {}, timers: config.driver?.timers || {},
    secondLook: pa.followUp?.secondLook || {},
  };

  const page = buildFollowUpEngine({
    period, now, sent, queued, held, planned, inbound, cohort, status, lastRuns, settings,
    nothingScheduled: { count: leaks.nothing, rows: leaks.rows.filter((r) => r.leak === "nothing").map((r) => ({ ...r, name: nameOf(r.contactId) })) },
    retentionDays: config.retentionDays ?? 180,
    truncated: Boolean(ctx.truncated || periodRead.truncated || ctx.agentPlan?.truncated),
  });
  return {
    ...page,
    tierCardsRead: ctx.agentPlan ? Boolean(ctx.agentPlan.tierCardsRead) : null,
    buyerPlanRead: Boolean(ctx.buyerPlan),
    env: { sends: Boolean(env.sends), blasts: Boolean(env.blasts), imports: Boolean(env.imports) },
  };
}

export { MECHANISM_BY_KEY };
