// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// next-follow-up.js — one answer per offer: when is the next touch, and what
// is it. The Offers tab's "Next follow-up" column (2026-09-29).
//
// Matt asked for every offer to show the follow-up it has coming. The answer
// was scattered over a dozen clocks — the ladders in follow-up.js, the queued
// drafts, promises, check-ins they asked for, the float timer — and no one
// place could say "Thursday, nudge #2" or "nothing, and here's why". This is
// that place. It reads the same start points and ladder math the sweep uses
// (shared/follow-up.js), so the day the column promises is the day the sweep
// acts.
//
// What it cannot see ahead of time, on purpose: the weekly per-contact cap
// (it depends on the agent's other houses that morning) and the model
// deciding a draft needs a person. The column is the plan, not a guarantee.
//
// Pure. `now` is passed in.

import { effectiveStatus, OPEN_STATUSES, pushesToPaper, offerHeat, aiHoldReasons } from "./offer-status.js";
import {
  nextRungAt, offerNudgeStart, offerNudgeAnchor, passedStart, threadTimes, stepLabel, normalizeSteps,
  CHECKIN_STATUSES, HOT_MIN_HOURS,
} from "./follow-up.js";
import { threadHealth } from "./thread-health.js";
import { botHold, pauseDay, paceOf, paceScale } from "./bot-hold.js";
import { addressKey } from "./us-address.js";

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const iso = (t) => new Date(t).toISOString();
const latest = (xs) => xs.filter(Boolean).sort().at(-1) || null;

export const SWEEP_UTC_HOUR = 16;
// The promise sweep's clock: a promise we made is owed four hours on.
const PROMISE_DUE_HOURS = 4;
const PROMISE_WINDOW_HOURS = 72;

// Kinds the column can name. `who` says whether it goes by itself.
export const NEXT_KINDS = {
  queued:      "Queued to send",
  reply_owed:  "Their text is waiting on you",
  promise:     "We owe them",
  checkin_due: "Check-in they asked for",
  float:       "Float our number",
  offer_nudge: "Nudge",
  hot_push:    "Push to paper",
  passed_checkin: "Check back in",
  deal:        "Deal",
  we_passed:   "We passed",
  superseded:  "Superseded",
  draft:       "Draft",
  stopped:     "Stopped",
  none:        "None scheduled",
};

/**
 * sweepTime(t, sweepHour, weekends) → ms
 *
 * The daily sweep drafts at `sweepHour` UTC; a rung due at `t` goes on the
 * first sweep at or after it. Nudges don't go on a weekend unless the location
 * allows it, so a Saturday rung lands on Monday.
 */
export function sweepTime(t, sweepHour = SWEEP_UTC_HOUR, weekends = "replies_only") {
  const d = new Date(t);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), sweepHour);
  let out = at >= t ? at : at + DAY_MS;
  if (weekends !== "all") {
    // Pacific weekday of the sweep: 16:00 UTC is morning the same day there.
    const wd = () => new Date(out - 8 * HOUR_MS).getUTCDay();
    while (wd() === 0 || wd() === 6) out += DAY_MS;
  }
  return out;
}

const rungText = (label, step, steps) => {
  const l = stepLabel(step, steps);
  return l ? `${label} · ${l}` : label;
};

/**
 * nextFollowUp({ offer, drafts, events, config, now, sweepHour })
 *   → { at, kind, label, who, reason, overdue }
 *
 *   offer   a list row, annotated by current-offer.js (isCurrent/supersededBy)
 *   drafts  this contact's reply drafts, any status
 *   events  this contact's timeline (promises, check-ins, off-market, stops)
 *   config  the normalised conversationAi settings
 *
 * `at` null means nothing is coming; `reason` says why, in the operator's
 * words. `who` is "machine" (goes by itself), "you" (waits for a person), or
 * null. First match wins, in the order below.
 */
export function nextFollowUp({ offer, drafts = [], events = [], config = {}, now = Date.now(), sweepHour = SWEEP_UTC_HOUR } = {}) {
  const out = (kind, { at = null, label = NEXT_KINDS[kind], who = null, reason = "", until = null } = {}) => ({
    at: at == null ? null : iso(at), kind, label, who, reason,
    overdue: at != null && at < now - HOUR_MS,
    ...(until ? { until } : {}),
  });
  if (!offer) return out("none");
  const status = effectiveStatus(offer);

  /* ---- no follow-up, by design ---- */
  if (offer.deal) return out("deal", { label: `Deal · ${String(offer.deal.stage || "under_contract").replace(/_/g, " ")}`, reason: "a deal runs on its closing checklist, not follow-ups" });
  if (offer.status === "draft") {
    const held = aiHoldReasons(offer);
    return out("draft", { label: held.length ? "Held underwrite — waiting on you" : "Draft — not an offer yet", who: "you", reason: held.join("; ") });
  }
  if (offer.supersededBy) return out("superseded", { label: "See the current offer", reason: "a newer row on this house is the one we ask about" });
  if (status === "we_passed") return out("we_passed", { label: "We passed — no follow-up", reason: "our own pass is never chased" });
  if (status === "accepted") return out("deal", { label: "Accepted — promote to a deal", who: "you" });

  const pb = config?.parties?.agent || {};
  const fu = pb.followUp || {};
  const ladders = fu.ladders || {};
  const auto = pb.autoSend || {};
  const weekends = auto.weekends || "replies_only";
  const whoFor = (intent) => (config?.enabled && auto.enabled && (auto.intents || []).includes(intent) ? "machine" : "you");
  const mine = (e) => !e?.offerId || e.offerId === offer.id;
  const times = threadTimes(drafts);

  /* ---- the thread is stopped ---- */
  const unsub = (events || []).find((e) => e?.type === "unsubscribed") || drafts.find((d) => d?.intent === "opt_out" && String(d.inbound || "").trim());
  if (unsub) return out("stopped", { label: "Stopped — they opted out", reason: "they opted out" });
  const hold = botHold({ events, offerId: offer.id, now });
  if (hold.held) {
    return hold.kind === "paused"
      ? out("stopped", { label: `Paused until ${pauseDay(hold.until)}`, until: hold.until, reason: hold.reason || "paused by you" })
      : out("stopped", { label: "Stopped by you", reason: hold.reason || "stopped by you" });
  }

  /* ---- something is already queued ---- */
  const queued = times.scheduled.find((d) => !d.outbound?.offerId || d.outbound.offerId === offer.id);
  if (queued) {
    const kind = queued.outbound?.kind || queued.intent || "reply";
    return out("queued", { at: ms(queued.sendAt), label: `Queued · ${String(kind).replace(/_/g, " ")}`, who: "machine", reason: "already drafted and scheduled" });
  }

  /* ---- their text is waiting on a person ---- */
  if (times.heldSince) {
    return out("reply_owed", { at: ms(times.heldSince), label: "Reply held — waiting on you", who: "you", reason: "the bot drafted a reply and held it for you" });
  }

  const candidates = [];

  /* ---- a promise we made ---- */
  const pr = (events || []).filter((e) => ["promise_made", "promise_owed", "promise_kept"].includes(e?.type) && (ms(e.at) ?? 0) >= now - PROMISE_WINDOW_HOURS * HOUR_MS)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const keptAt = pr.filter((e) => e.type === "promise_kept").at(-1)?.at || "";
  const made = pr.filter((e) => e.type === "promise_made" && String(e.at) > keptAt && e.data?.asksThem !== true);
  if (made.length) {
    const due = ms(made[0].data?.dueAt) ?? (ms(made[0].at) + PROMISE_DUE_HOURS * HOUR_MS);
    const what = made.some((p) => p.data?.what === "number") ? "a number" : "an answer";
    candidates.push(out("promise", { at: due, label: `We owe them ${what}`, who: config?.driver?.promises?.enabled ? "machine" : whoFor("promise_due"), reason: "the bot said we'd come back to them" }));
  }

  /* ---- a check-in they asked for ---- */
  const byTime = [...(events || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const req = byTime.filter((e) => e?.type === "checkin_requested").at(-1);
  if (req && fu.enabled && !byTime.some((e) => e.type === "checkin_sent" && e.data?.requestAt === req.at)
      && !byTime.some((e) => (e.type === "text_summary" || e.type === "call_summary") && String(e.at) > String(req.at))) {
    const phrase = String(req.data?.phrase || "").trim();
    candidates.push(out("checkin_due", { at: ms(req.data?.dueAt) ?? ms(req.at), label: phrase ? `Check-in they asked for (${phrase})` : NEXT_KINDS.checkin_due, who: whoFor("checkin_due") }));
  }

  /* ---- the ladders ---- */
  // Check in less / more (shared/bot-hold.js): the rungs move, the gaps only grow.
  const pace = paceOf({ events }).factor;
  const gapScale = paceScale(pace).floor;
  const machineGap = (t) => {
    const touched = ms(times.lastMachineTouchAt);
    const floor = touched == null ? t : Math.max(t, touched + (Number(fu.minHoursBetween) || 0) * gapScale * HOUR_MS);
    return floor;
  };
  let ladderNote = "";
  if (fu.enabled && OPEN_STATUSES.has(status)) {
    const hotOn = ladders.hot_push?.enabled && ladders.hot_push.steps?.length;
    if (hotOn && pushesToPaper(offer)) {
      const heat = offerHeat(offer);
      const hotAt = heat?.at || offer.counterBand?.acceptedAt || offer.realm?.ts || offer.statusAt || offer.createdAt;
      const anchor = latest([hotAt, times.lastInboundAt]);
      const sent = (offer.followUps || []).filter((f) => f?.kind === "hot_push" && String(f.at || "") > anchor).map((f) => f.step);
      const r = nextRungAt({ steps: ladders.hot_push.steps, repeatEvery: ladders.hot_push.repeatEvery, startedAt: anchor, sentSteps: sent, now, pace });
      if (r) {
        const touched = ms(times.lastMachineTouchAt);
        const t = Math.max(r.due ? now : ms(r.at), touched == null ? 0 : touched + HOT_MIN_HOURS * gapScale * HOUR_MS);
        candidates.push(out("hot_push", { at: sweepTime(t, sweepHour, weekends), label: rungText("Push to paper", r.step, ladders.hot_push.steps), who: whoFor("hot_push") }));
      } else ladderNote = "the push to paper ran out — the next move is a call";
    } else if (ladders.offer_nudge?.enabled && ladders.offer_nudge.steps?.length
        // Nothing went out on it yet (no letter, nothing floated): not a
        // nudge — the float below is its next move (follow-up-sweep.js
        // agentCandidates skips it the same way).
        && !(status === "new" && !(offer.sends || []).some((s) => s?.ts) && !offer.proactive?.realmCheckAt && !offer.proactive?.takeCheckAt)) {
      const L = ladders.offer_nudge;
      const onPaper = (offer.sends || []).some((s) => s?.ts);
      const nudgeFrom = onPaper ? offerNudgeStart(offer) : (offer.proactive?.realmCheckAt || offer.proactive?.takeCheckAt || offerNudgeStart(offer));
      const a = offerNudgeAnchor({ startedAt: nudgeFrom, lastInboundAt: times.lastInboundAt, lastHandledAt: times.lastHandledAt });
      if (a.waitingOnUs) ladderNote = "they replied and nothing has answered it";
      else {
        const sent = (offer.followUps || []).filter((f) => f?.kind === "offer_nudge" && (!a.reanchored || String(f.at || "") > a.startedAt)).map((f) => f.step);
        const r = nextRungAt({ steps: L.steps, repeatEvery: L.repeatEvery, startedAt: a.startedAt, sentSteps: sent, now, pace });
        let brake = null;
        if (a.reanchored) {
          const h = threadHealth({ offer, drafts, events, now });
          if (!h.drive && h.reason !== "two_unanswered") brake = h;
        }
        if (brake) ladderNote = `the machine stands down: ${brake.detail}`;
        else if (r) {
          const t = machineGap(r.due ? now : ms(r.at));
          candidates.push(out("offer_nudge", { at: sweepTime(t, sweepHour, weekends), label: rungText("Nudge", r.step, L.steps), who: whoFor("offer_nudge") }));
        } else ladderNote = "the nudges ran out";
      }
    }
    // A priced offer nobody has floated: the timer floats it.
    const floated = offer.proactive?.realmCheckAt || offer.proactive?.takeCheckAt || (offer.sends || []).length;
    const timers = config?.driver?.timers;
    if (status === "new" && !floated && timers?.enabled) {
      const t = (ms(offer.createdAt) ?? now) + (Number(timers.floatAfterHours) || 4) * HOUR_MS;
      // The timer tries once (today-timers.js claims per offer) and not at all
      // when the float was skipped for a reason. A day past due, it isn't
      // coming by itself.
      candidates.push(t < now - DAY_MS
        ? out("float", { at: t, label: "Our number never went out — float or send it", who: "you", reason: "the float timer didn't send it" })
        : out("float", { at: t, label: "Float our number", who: "machine" }));
    }
  } else if (fu.enabled && CHECKIN_STATUSES.has(status) && ladders.passed_checkin?.enabled && ladders.passed_checkin.steps?.length) {
    const L = ladders.passed_checkin;
    const passed = passedStart(offer);
    const key = offer.address ? addressKey(offer.address) : "";
    // Off the market stops it, until the price watch sees it come back
    // (follow-up-sweep.js passedCandidates reads the same two events).
    const mine = (events || []).filter((e) => (e?.type === "listing_off_market" || e?.type === "listing_back_on_market")
      && (e.offerId === offer.id || (key && e.address && addressKey(e.address) === key)) && String(e.at) > String(passed));
    const lastOff = mine.filter((e) => e.type === "listing_off_market").map((e) => e.at).sort().at(-1) || null;
    const lastBack = mine.filter((e) => e.type === "listing_back_on_market").map((e) => e.at).sort().at(-1) || null;
    if (lastOff && !(lastBack && String(lastBack) > String(lastOff))) return out("stopped", { label: "Stopped — listing went off market", reason: "pending or sold; the price watch saw it go" });
    const relisted = fu.relist && lastBack ? lastBack : null;
    const start = relisted || passed;
    const r = nextRungAt({ steps: L.steps, repeatEvery: L.repeatEvery, startedAt: start, sentSteps: (offer.followUps || []).filter((f) => f?.kind === "passed_checkin" && (!relisted || String(f.at || "") > String(relisted))).map((f) => f.step), now, pace });
    if (r) {
      // A live conversation pauses the check-in; it resumes three days after they last wrote.
      const talking = ms(times.lastInboundAt);
      const t = machineGap(Math.max(r.due ? now : ms(r.at), talking == null ? 0 : talking + 72 * HOUR_MS));
      const label = rungText(status === "no_response" ? "Check back in (never heard back)" : "Check back in", r.step, L.steps);
      candidates.push(out("passed_checkin", { at: sweepTime(t, sweepHour, weekends), label, who: whoFor("passed_checkin") }));
    } else ladderNote = `check-ins finished (day ${normalizeSteps(L.steps).at(-1)})`;
  } else if (!fu.enabled) ladderNote = "follow-ups are switched off";

  if (candidates.length) {
    return candidates.sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  }
  return out("none", { reason: ladderNote || `nothing follows up a ${status.replace(/_/g, " ")} offer` });
}
