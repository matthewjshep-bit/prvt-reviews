// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// follow-up.js — the clock. Which nudge is due on a conversation nobody
// answered, and when we stop.
//
// Until this existed the Conversation AI only ever spoke when spoken to (or
// when an underwrite landed). An offer sent five days ago with no reply just
// sat there, and `no_response` was a thing you typed by hand.
//
// Three ladders, one per kind of silence: an offer the agent never answered,
// a deal we blasted an investor who never replied, and a dataroom somebody
// opened and then went quiet. Each is a list of DAYS SINCE THE TRIGGER —
// absolute offsets, not gaps between touches. That matters twice: an operator
// can reason about "day 3, day 7, day 14" without doing arithmetic, and a
// sweep that missed a day still fires the day-7 step, once, rather than
// catching up by sending three texts in a row.
//
// Pure. No I/O, no clock of its own — `now` is always passed in.

import { paceScale } from "./bot-hold.js";

export const FOLLOW_UP_KINDS = {
  // The cold cadence. Until this existed the twelve touches after a first
  // text lived in a GHL workflow the app could not see, so "gone quiet" on a
  // cold agent was not a thing the queue could say.
  outreach_nudge: { party: "agent",    trigger: "outreach_sent",   label: "Reached out, no reply" },
  offer_nudge:    { party: "agent",    trigger: "offer_open",      label: "Offer with no reply" },
  // A pass is rarely final: listings sit, sellers soften. Check back in on
  // the offer they turned down — would the seller come closer to our number?
  passed_checkin: { party: "agent",    trigger: "offer_passed",    label: "Passed offer, check back in" },
  // A price is agreed and nothing is on paper. The goal from here is the
  // listing agent writing it up on NWMLS forms for us to sign; this ladder
  // keeps asking, tightly, until they do or go quiet.
  hot_push:       { party: "agent",    trigger: "price_agreed",    label: "Price agreed, push to paper" },
  blast_nudge:    { party: "investor", trigger: "blast_sent",      label: "Blasted, no reply" },
  dataroom_nudge: { party: "investor", trigger: "dataroom_viewed", label: "Opened the package, went quiet" },
};

// The hot push's own floor between texts. A constant, not a setting: it
// ignores the shared 40-hour gap and the weekly cap on purpose, and this is
// what it keeps instead.
export const HOT_MIN_HOURS = 20;

export const FOLLOW_UP_KIND_KEYS = Object.keys(FOLLOW_UP_KINDS);
export const kindsFor = (party) => FOLLOW_UP_KIND_KEYS.filter((k) => FOLLOW_UP_KINDS[k].party === party);

// What happens when the ladder runs out. "stop" leaves them alone; the agent
// ladder can additionally write down what the silence meant.
export const ON_EXHAUSTED = ["stop", "mark_no_response"];

// Conservative on purpose, and off on purpose. Three touches over two weeks
// is a follow-up; anything tighter is a campaign, and this ships to an
// operator who has not watched it work yet.
export const DEFAULT_LADDERS = {
  // Six touches over a month for a cold agent: the first two close together
  // while the listing is still fresh in their mind, then it spaces out.
  outreach_nudge: { enabled: false, steps: [2, 5, 9, 14, 21, 30], repeatEvery: 0, onExhausted: "stop" },
  // An offer is asked about until the agent answers — yes, no, or a number.
  // The date printed on it is not a deadline: agents answer lapsed offers all
  // the time, so after day 14 the ladder keeps going, once a week.
  offer_nudge:    { enabled: false, steps: [3, 7, 14], repeatEvery: 7, onExhausted: "mark_no_response" },
  // Every ten days, for four months.
  passed_checkin: { enabled: false, steps: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120], repeatEvery: 0, onExhausted: "stop" },
  // Tight: an agreed price cools fast. It re-anchors on their every reply
  // (follow-up-sweep.js hotCandidates), so these are days since they last
  // spoke, and two with nothing back is a phone call, not a third text.
  hot_push:       { enabled: false, steps: [1, 3, 6, 10], repeatEvery: 0, onExhausted: "stop" },
  blast_nudge:    { enabled: false, steps: [2, 6], repeatEvery: 0, onExhausted: "stop" },
  dataroom_nudge: { enabled: false, steps: [1, 4], repeatEvery: 0, onExhausted: "stop" },
};

/* ---------- what the bot promised ---------- */

// "Let me run this by my underwriting team today and get back to you with a
// number." Said to eleven agents on 2026-09-14, and for several of them —
// Emily Cressey, Foster, Shawn Filer — nothing ran and nothing came back. A
// promise is a clock like any other: when it is due and nothing went out,
// somebody has to keep it.
export const PROMISE_DUE_HOURS = 4;

/**
 * detectPromise(text) → "number" | "answer" | null
 *
 * Whether a reply WE sent commits us to coming back. "number" when it's our
 * numbers ("get back to you with a number", "run it by underwriting", "have a
 * number back to you today"); "answer" when it's anything else ("let me run
 * that by my partner and get back to you this afternoon").
 */
export function detectPromise(text = "") {
  const t = String(text || "");
  const number = [
    /\b(?:number|numbers|figure|offer)\b[^.?!]{0,40}\bback\s+to\s+you\b/i,
    /\b(?:get|come|circle)\s+back\s+(?:to\s+you\s+)?with\s+(?:a|an|the|our)\s+(?:\w+\s+)?(?:number|figure|offer|price)\b/i,
    /\b(?:run|re-?run|running)\s+(?:it|this|that|the\s+(?:numbers|address)|[\w-]+)\s+(?:by|past|through)\s+(?:my\s+|our\s+|the\s+)?underwriting\b/i,
    /\bnumbers?\s+re-?run\b/i,
  ];
  if (number.some((re) => re.test(t))) return "number";
  if (/\b(?:get|come|circle)\s+back\s+to\s+you\b|\bback\s+to\s+you\s+(?:today|this\s+afternoon|tonight|tomorrow|later)\b/i.test(t)) return "answer";
  return null;
}

/**
 * isDeflection(text) → boolean
 *
 * An owed ANSWER that names a partner or "checking": the bot was asked
 * something it had no answer for and said it would find out. The owner's
 * answer (Today's answer box) is what keeps it, and what stops the next one.
 */
export function isDeflection(text = "") {
  const t = String(text || "");
  if (detectPromise(t) !== "answer") return false;
  return /\b(?:my|our)\s+(?:business\s+)?partner(?:'s)?\b|\bcheck\s+(?:on\s+that|with|into)\b|\bfind\s+out\b|\bnot\s+something\s+I\s+want\s+to\s+guess\b/i.test(t);
}

/**
 * questionIn(inbound) → string
 * The question they asked: the last sentence ending in "?", else the whole
 * message, clipped.
 */
export function questionIn(inbound = "") {
  const t = String(inbound || "").replace(/\s+/g, " ").trim();
  const asked = t.split(/(?<=[.!?])\s+/).filter((x) => x.trim().endsWith("?")).at(-1);
  return (asked || t).trim().slice(0, 240);
}

/* ---------- when they said to check back ---------- */

// "I'll check back in when I get into the office this Wednesday" (Tyler
// Anderson, 2026-09-14). They named the day; nothing remembered it. A check-in
// they asked for is the warmest follow-up there is.
const CHECKIN_CUE = /\b(?:check(?:ing)?\s+(?:back|in)|circle\s+back|touch\s+base|reach\s+(?:back\s+)?out|follow\s+up|get\s+back\s+to\s+you|let\s+you\s+know|back\s+in\s+(?:town|the\s+office)|in(?:to)?\s+the\s+office|hit\s+you\s+up|text\s+you|talk\s+(?:then|soon))\b/i;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// 17:00 UTC ≈ 10am Pacific, the morning after the day they named.
const morningOf = (ms) => { const d = new Date(ms); d.setUTCHours(17, 0, 0, 0); return d.toISOString(); };

/**
 * checkInRequested(text, now) → { dueAt, phrase } | null
 *
 * Only when the message says they'll come back to us (a check-in cue) AND
 * names when: a weekday, tomorrow, next week, a few weeks, a month. Due the
 * morning after the day they named, so it lands after they had their chance.
 */
export function checkInRequested(text = "", now = Date.now()) {
  const t = String(text || "");
  if (!CHECKIN_CUE.test(t)) return null;
  return timeNamed(t, now);
}

/**
 * timeNamed(text, now) → { dueAt, phrase } | null
 *
 * The when, on its own: a weekday, tomorrow, next week, a few weeks, a month.
 * Due the morning after, so it lands after they had their chance.
 */
export function timeNamed(text = "", now = Date.now()) {
  const t = String(text || "");
  const day =/\b(?:this\s+|next\s+|on\s+)?(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\b/i.exec(t);
  if (day) {
    const want = WEEKDAYS.indexOf(day[1].toLowerCase().slice(0, 3));
    let add = (want - new Date(now).getUTCDay() + 7) % 7;
    if (add === 0) add = 7;
    return { dueAt: morningOf(now + (add + 1) * DAY_MS), phrase: day[0].trim() };
  }
  if (/\btomorrow\b/i.test(t)) return { dueAt: morningOf(now + 2 * DAY_MS), phrase: "tomorrow" };
  if (/\bnext\s+week\b/i.test(t)) return { dueAt: morningOf(now + 8 * DAY_MS), phrase: "next week" };
  const weeks = /\b(?:a\s+)?(?:few|couple(?:\s+of)?|2|two|3|three)\s+weeks?\b/i.exec(t);
  if (weeks) return { dueAt: morningOf(now + 15 * DAY_MS), phrase: weeks[0].trim() };
  if (/\b(?:a|next)\s+month\b/i.test(t)) return { dueAt: morningOf(now + 31 * DAY_MS), phrase: "a month" };
  return null;
}

/**
 * takingItToSeller(text, now) → { dueAt, phrase } | null
 *
 * The agent is taking our number to the seller and will come back: Julie
 * Nutley's "I will run it by them ... I will share with them and get back
 * with you" (2026-09-15). Nothing for a person to decide, so the bot can say
 * thanks. If they don't come back, a check-in goes two mornings later.
 */
const TO_SELLER_RX = /\b(?:run|take|bring|present|share|show|send|pass)\s+(?:it|this|that|the\s+(?:number|offer))?\s*(?:by|to|with|past|along\s+to)\s+(?:them|him|her|my\s+(?:sellers?|clients?)|the\s+(?:sellers?|owners?|clients?))\b/i;
const COME_BACK_RX = /\b(?:get|circle|come)\s+back\s+(?:to|with)\s+you\b|\blet\s+you\s+know\s+what\s+(?:they|he|she)\b|\bsee\s+what\s+(?:they|he|she)\s+(?:say|think)/i;
export function takingItToSeller(text = "", now = Date.now()) {
  const t = String(text || "");
  if (!TO_SELLER_RX.test(t) && !(COME_BACK_RX.test(t) && /\b(?:sellers?|owners?|them|clients?)\b/i.test(t))) return null;
  const when = timeNamed(t, now);
  return { dueAt: when?.dueAt || morningOf(now + 2 * DAY_MS), phrase: when?.phrase || "hearing back from the seller" };
}

/**
 * unansweredCheckIn(now) → { dueAt, phrase }
 *
 * Nothing went out. An agent texted us, the draft was held for a person, and
 * the thread's next move belongs to nobody: Thomas Rinow, 2026-09-15, gave us
 * the seller's number ("that are willing to go to 670") on a live offer and
 * heard nothing back, then emailed the next morning to close it out himself.
 *
 * The outbox is where a held draft waits, but an outbox row is not a clock.
 * This is the clock: two mornings on, the check-in sweep comes back to them
 * unless they (or a person here) spoke first.
 */
export const UNANSWERED_CHECKIN_DAYS = 2;
export function unansweredCheckIn(now = Date.now()) {
  return { dueAt: morningOf(now + UNANSWERED_CHECKIN_DAYS * DAY_MS), phrase: "" };
}

// The next morning's opening, for a clock the nightly audit sets at dusk.
export const nextMorning = (now = Date.now()) => morningOf(now + DAY_MS);

/**
 * addressPending({ intent, propertyAddress, message, now }) → { hint, firstDueAt, phrase } | null
 *
 * They told us a property is coming and the message carries no address:
 * Alexandria Goforth's "I will likely have one in Spanaway soon" (2026-09-15).
 * `hint` is their words, so the chase can refer to it the way they did; a time
 * they named ("in a few weeks") is when the first check-in lands.
 */
export const ADDRESS_PENDING_INTENTS = new Set(["new_property", "deal_available"]);
export function addressPending({ intent = "", propertyAddress = "", message = "", now = Date.now() } = {}) {
  if (!ADDRESS_PENDING_INTENTS.has(intent) || String(propertyAddress || "").trim()) return null;
  const hint = String(message || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!hint) return null;
  const when = timeNamed(hint, now);
  return { hint, firstDueAt: when?.dueAt || null, phrase: when?.phrase || "" };
}

/**
 * offersToSendDeals(text) → boolean
 *
 * The agent offered to be a source: "You got an email I can send properties
 * to?" (Karamveer Tiwana), "I'll keep you in mind for any fixers" (Greg
 * Devey), "I'll keep an eye on some more properties" (Christian Simonson).
 */
export function offersToSendDeals(text = "") {
  const t = String(text || "");
  return /\b(?:email|number|address)\s+(?:i\s+can|to)\s+send\b/i.test(t)
    || /\b(?:send|forward|pass)\s+(?:you\s+|them\s+|along\s+)?(?:some\s+|any\s+|more\s+)?(?:properties|deals|listings|fixers|leads)\b/i.test(t)
    || /\bkeep\s+(?:you|an\s+eye(?:\s+out)?)\b[^.?!]{0,40}\b(?:fixers?|deals?|properties|listings|in\s+mind)\b/i.test(t)
    || /\bfirst\s+look\b|\boff[\s-]?market\b/i.test(t);
}

export const MAX_LADDER_STEPS = 12;
export const MAX_STEP_DAY = 120;
export const MAX_REPEAT_DAYS = 60;

// Every rung the ladder has reached by `now`, plus the next one: the
// configured days, then — for a repeating ladder — one more every
// `repeatEvery` days after the last. A repeat rung's step is its day offset
// like any other, so its dedupe key is as stable as a configured one.
// `unit` is a paced day (shared/bot-hold.js): the rungs keep their numbers,
// only the time to each one stretches or shrinks.
function rungsThrough(ladder, repeatEvery, started, now, unit = DAY_MS) {
  const every = Math.round(Number(repeatEvery) || 0);
  if (!(every > 0) || !ladder.length) return ladder;
  const out = [...ladder];
  const daysIn = Math.floor((now - started) / unit);
  for (let d = ladder[ladder.length - 1] + every; d <= daysIn + every; d += every) out.push(d);
  return out;
}

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/**
 * normalizeSteps(v) → [day]
 *
 * Whole days, in range, sorted, deduped, capped. A saved ladder is never
 * trusted: the same coercion runs on the console and on the broker.
 */
export function normalizeSteps(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,\s]+/);
  const out = [];
  for (const x of raw) {
    const n = Math.round(Number(String(x).trim()));
    if (!Number.isFinite(n) || n < 1 || n > MAX_STEP_DAY) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b).slice(0, MAX_LADDER_STEPS);
}

/**
 * dueStep({ steps, startedAt, sentSteps, lastInboundAt, lastTouchAt, now,
 *           stopOnAnyInbound, minHoursBetween, repeatEvery, pace })
 *   → { due: true, step, dayOffset } | { due: false, reason }
 *
 * `pace` (shared/bot-hold.js): 2 checks in half as often, 0.5 twice as
 * often. It scales the time to each rung; the gap between texts only ever
 * grows with it.
 *
 * `step` is the day offset itself, so it is stable if the operator reorders
 * or inserts a rung: step 7 means "the day-7 touch" forever, and a ladder
 * edited mid-conversation cannot re-send a touch already made.
 *
 * `reason` is in the operator's words — it goes on the sweep's result row so
 * "why didn't it follow up?" is a lookup rather than a guess.
 */
export function dueStep({
  steps = [], startedAt, sentSteps = [], lastInboundAt = null, lastTouchAt = null,
  now = Date.now(), stopOnAnyInbound = true, minHoursBetween = 0, repeatEvery = 0, pace = 1,
} = {}) {
  const configured = normalizeSteps(steps);
  if (!configured.length) return { due: false, reason: "no ladder" };
  const started = ms(startedAt);
  if (started == null) return { due: false, reason: "nothing to count from" };
  const { rung, floor } = paceScale(pace);
  const unit = DAY_MS * rung;
  const ladder = rungsThrough(configured, repeatEvery, started, now, unit);

  // They answered. That is the whole point of the ladder and it ends here —
  // whatever they said, a person or the reply agent is now in a conversation,
  // and a scheduled nudge on top of it is the bot talking over itself.
  const inbound = ms(lastInboundAt);
  if (stopOnAnyInbound && inbound != null && inbound > started) {
    return { due: false, reason: "they replied" };
  }

  const done = new Set(sentSteps.map((s) => Math.round(Number(s))).filter(Number.isFinite));
  // The rung we would be sending TODAY: the highest one whose day has passed,
  // whether or not it was sent. Two things fall out of that, both deliberate:
  //
  //   A sweep that was down for a fortnight comes back and sends one message
  //   rather than working through the backlog into somebody's phone.
  //
  //   And a rung is never fired in arrears. If the day-14 touch has gone and
  //   the day-7 one was skipped — they were on a live deal that week, the
  //   sweep stood aside — day 7 does not come back round on day 20. Same rule
  //   protects an operator who inserts a day-1 rung into a ladder mid-flight:
  //   it applies to the next conversation, not retroactively to this one.
  const overdue = ladder.filter((d) => started + d * unit <= now);
  const pick = overdue.length ? overdue[overdue.length - 1] : null;
  if (pick == null || done.has(pick)) {
    const next = ladder.find((d) => !done.has(d) && started + d * unit > now);
    return { due: false, reason: next == null ? "ladder finished" : `day ${next} hasn't come round yet` };
  }

  const touched = ms(lastTouchAt);
  if (minHoursBetween > 0 && touched != null && now - touched < minHoursBetween * floor * 3600000) {
    const hrs = Math.round((now - touched) / 3600000);
    return { due: false, reason: `we texted them ${hrs}h ago — too soon` };
  }
  return { due: true, step: pick, dayOffset: pick };
}

/**
 * exhausted({ steps, sentSteps, startedAt, now }) → boolean
 *
 * True once the last rung's day has passed. Note it does NOT require every
 * rung to have been sent: a ladder whose middle step was skipped (they were
 * on a live deal that week) is still over when its last day goes by.
 */
export function exhausted({ steps = [], sentSteps = [], startedAt, now = Date.now(), repeatEvery = 0, pace = 1 } = {}) {
  // A repeating ladder never runs out: it asks until they answer.
  if (Math.round(Number(repeatEvery) || 0) > 0) return false;
  const ladder = normalizeSteps(steps);
  if (!ladder.length) return false;
  const started = ms(startedAt);
  if (started == null) return false;
  const last = ladder[ladder.length - 1];
  if (started + last * DAY_MS * paceScale(pace).rung > now) return false;
  return !dueStep({ steps: ladder, startedAt, sentSteps, now, stopOnAnyInbound: false, pace }).due;
}

/**
 * nextRungAt({ steps, repeatEvery, startedAt, sentSteps, now }) → { at, step, due } | null
 *
 * The same ladder dueStep reads, asked the other way round: not "is a rung
 * due now" but "which rung is next, and on what day". `due` means the rung's
 * day has passed and it hasn't gone — the next sweep sends it. null when the
 * ladder is finished. Inbound, the gap between texts and the weekly cap are
 * the caller's (they aren't a property of the ladder).
 */
export function nextRungAt({ steps = [], repeatEvery = 0, startedAt, sentSteps = [], now = Date.now(), pace = 1 } = {}) {
  const configured = normalizeSteps(steps);
  const started = ms(startedAt);
  if (!configured.length || started == null) return null;
  const unit = DAY_MS * paceScale(pace).rung;
  // Far enough ahead that a repeating ladder always has a rung after `now`.
  const every = Math.round(Number(repeatEvery) || 0);
  const ladder = rungsThrough(configured, every, started, now + Math.max(every, 1) * unit, unit);
  const done = new Set(sentSteps.map((s) => Math.round(Number(s))).filter(Number.isFinite));
  const overdue = ladder.filter((d) => started + d * unit <= now);
  const pick = overdue.at(-1);
  if (pick != null && !done.has(pick)) return { at: new Date(started + pick * unit).toISOString(), step: pick, due: true };
  const next = ladder.find((d) => !done.has(d) && started + d * unit > now);
  return next == null ? null : { at: new Date(started + next * unit).toISOString(), step: next, due: false };
}

/* ---------- where each offer ladder counts from ---------- */
// The sweep (ghl-broker/follow-up-sweep.js) and the Offers tab's "Next
// follow-up" column (shared/next-follow-up.js) both read these, so the day
// the column promises is the day the sweep acts.

const latest = (xs) => xs.filter(Boolean).sort().at(-1) || null;

/** An open offer: from the last time we put it in front of them. */
export function offerNudgeStart(offer) {
  return latest((offer?.sends || []).map((s) => s?.ts)) || offer?.statusAt || offer?.createdAt || null;
}

/**
 * threadTimes(drafts) → { lastInboundAt, lastHandledAt, lastMachineTouchAt, heldSince, scheduled }
 *
 * One contact's reply drafts, read for the clocks. A draft row exists for
 * every inbound, so this is who spoke last and whether it was dealt with:
 *
 *   lastHandledAt       our last text out (a reply counts as much as a nudge),
 *                       or an inbound we chose to leave — "ok thanks" is
 *                       dismissed or skipped, not owed
 *   lastMachineTouchAt  our last machine-started text (the 40-hour gap)
 *   heldSince           their newest text, when its reply is held for a person
 *   scheduled           replies queued to send, soonest first
 */
export function threadTimes(drafts = []) {
  const list = (drafts || []).filter(Boolean);
  const inbound = list.filter((d) => String(d.inbound || "").trim());
  const newestIn = [...inbound].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))).at(-1) || null;
  return {
    lastInboundAt: latest(inbound.map((d) => d.createdAt)),
    lastHandledAt: latest([
      ...list.filter((d) => d.status === "sent").map((d) => d.sentAt || d.updatedAt || d.createdAt),
      ...inbound.filter((d) => d.status === "dismissed" || d.status === "skipped").map((d) => d.createdAt),
    ]),
    lastMachineTouchAt: latest(list.filter((d) => d.outbound?.kind && d.status === "sent").map((d) => d.updatedAt || d.createdAt)),
    heldSince: newestIn?.status === "draft" ? newestIn.createdAt : null,
    scheduled: list.filter((d) => (d.status === "scheduled" || d.status === "sending") && d.sendAt)
      .sort((a, b) => String(a.sendAt).localeCompare(String(b.sendAt))),
  };
}

/* ---------- one voice: the machine never talks over a waiting reply ---------- */

// Every kind of text the machine starts on its own (ghl-broker/reply-agent.js
// OUTBOUND_KINDS, less the answer a person types on Today). One of these may
// replace an older one nobody sent: the next nudge standing in for the last
// is still one voice. Anything else in the outbox answers THEM or is a
// person's own: a reply to their text, your answer to a question the bot
// couldn't field, your hand-written check-in, the walkthrough ask, a queued
// deal text.
export const MACHINE_STARTED_KINDS = new Set([
  "outreach_open", "outreach_nudge", "take_check", "realm_check", "offer_nudge", "counter_nudge", "take_ask",
  "hot_push", "passed_checkin", "promise_due", "price_drop", "checkin_due", "address_chase",
  "blast_nudge", "dataroom_nudge", "buyer_pulse", "agent_pulse", "showing_reminder", "showing_followup"]);

// A draft that answers something they sent. Reply rows carry no outbound
// kind — a photo-only text has an empty `inbound`, so the kind decides.
export const answersInbound = (d) => !d?.outbound?.kind || Boolean(String(d?.inbound || "").trim());

const OWN_DRAFT_WORD = { check_in: "check-in", partner_answer: "answer", showing_ask: "walkthrough ask", blast_open: "deal text" };

/**
 * blockingDraft(open, { continues }) → draft | null
 *
 * `open` is one contact's outbox. The row a machine-started text would talk
 * over: waiting (draft or scheduled), not the machine's own, and not the
 * reply this text carries on from — the re-quote that answers their numbers,
 * the check-in that is the net under a held reply. Until 2026-09-29 every
 * machine text superseded whatever was waiting, so a question held for a
 * person left Today and a canned check-in went out in its place.
 */
export function blockingDraft(open = [], { continues = null } = {}) {
  return (open || []).find((d) => d && (d.status === "draft" || d.status === "scheduled")
    && d.id !== continues && !MACHINE_STARTED_KINDS.has(d.outbound?.kind)) || null;
}

/** Why the machine stood down, in the words a skipped row shows. */
export function blockingReason(d) {
  if (answersInbound(d)) return "their text is waiting on you — the machine won't talk over it";
  return `your ${OWN_DRAFT_WORD[d?.outbound?.kind] || String(d?.outbound?.kind || "draft").replace(/_/g, " ")} to them is waiting in the outbox`;
}

/**
 * offerNudgeAnchor({ startedAt, lastInboundAt, lastHandledAt })
 *   → { startedAt, reanchored, waitingOnUs }
 *
 * They answered, it was dealt with, and it went quiet: the offer is still
 * open and still ours to ask about, counted from when it was dealt with.
 * Until 2026-09-29 the ladder ended at their first reply ("they replied") and
 * a sent or countered offer could sit with no clock at all. If THEIR text is
 * the last word and nobody has dealt with it, nothing is anchored — that is a
 * reply we owe, not a follow-up.
 */
export function offerNudgeAnchor({ startedAt, lastInboundAt = null, lastHandledAt = null } = {}) {
  const inbound = ms(lastInboundAt);
  const start = ms(startedAt);
  if (inbound == null || start == null || inbound <= start) return { startedAt, reanchored: false, waitingOnUs: false };
  const handled = ms(lastHandledAt);
  if (handled == null || handled < inbound) return { startedAt, reanchored: false, waitingOnUs: true };
  return { startedAt: new Date(handled).toISOString(), reanchored: true, waitingOnUs: false };
}

// The dead statuses a check-in brings back: their pass, and a number that
// went out and never got a word back (shared/offer-status.js REVIVABLE_STATUSES).
export const CHECKIN_STATUSES = new Set(["passed", "no_response"]);

/** A passed or gone-quiet offer: from when it was marked so. */
export function passedStart(offer) {
  const status = offer?.status;
  return latest((offer?.statusHistory || []).filter((h) => h?.status === status).map((h) => h.ts))
    || offer?.statusAt || offer?.createdAt || null;
}

/**
 * followUpDedupeKey({ kind, subjectId, step }) → string
 *
 * The contact_events unique key, and therefore the claim. Two ticks racing on
 * the same rung write the same key, and the unique index makes the second one
 * a no-op. This is the whole concurrency story — there is no lock.
 */
export function followUpDedupeKey({ kind, subjectId, step }) {
  return `followup:${kind}:${String(subjectId || "none")}:${Math.round(Number(step) || 0)}`;
}

/**
 * stepLabel(step, steps) → "step 2 of 3"
 * What the outbox row says. Position, not day, because that is how a person
 * reads a follow-up they are about to approve.
 */
export function stepLabel(step, steps = []) {
  const ladder = normalizeSteps(steps);
  const n = Math.round(Number(step));
  const i = ladder.indexOf(n);
  if (i >= 0) return `step ${i + 1} of ${ladder.length}`;
  // A repeat rung, past the configured days.
  return ladder.length && n > ladder[ladder.length - 1] ? `still asking (day ${n})` : "";
}
