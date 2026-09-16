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

export const FOLLOW_UP_KINDS = {
  // The cold cadence. Until this existed the twelve touches after a first
  // text lived in a GHL workflow the app could not see, so "gone quiet" on a
  // cold agent was not a thing the queue could say.
  outreach_nudge: { party: "agent",    trigger: "outreach_sent",   label: "Reached out, no reply" },
  offer_nudge:    { party: "agent",    trigger: "offer_open",      label: "Offer with no reply" },
  // A pass is rarely final: listings sit, sellers soften. Check back in on
  // the offer they turned down — would the seller come closer to our number?
  passed_checkin: { party: "agent",    trigger: "offer_passed",    label: "Passed offer, check back in" },
  blast_nudge:    { party: "investor", trigger: "blast_sent",      label: "Blasted, no reply" },
  dataroom_nudge: { party: "investor", trigger: "dataroom_viewed", label: "Opened the package, went quiet" },
};

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
function rungsThrough(ladder, repeatEvery, started, now) {
  const every = Math.round(Number(repeatEvery) || 0);
  if (!(every > 0) || !ladder.length) return ladder;
  const out = [...ladder];
  const daysIn = Math.floor((now - started) / DAY_MS);
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
 *           stopOnAnyInbound, minHoursBetween })
 *   → { due: true, step, dayOffset } | { due: false, reason }
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
  now = Date.now(), stopOnAnyInbound = true, minHoursBetween = 0, repeatEvery = 0,
} = {}) {
  const configured = normalizeSteps(steps);
  if (!configured.length) return { due: false, reason: "no ladder" };
  const started = ms(startedAt);
  if (started == null) return { due: false, reason: "nothing to count from" };
  const ladder = rungsThrough(configured, repeatEvery, started, now);

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
  const overdue = ladder.filter((d) => started + d * DAY_MS <= now);
  const pick = overdue.length ? overdue[overdue.length - 1] : null;
  if (pick == null || done.has(pick)) {
    const next = ladder.find((d) => !done.has(d) && started + d * DAY_MS > now);
    return { due: false, reason: next == null ? "ladder finished" : `day ${next} hasn't come round yet` };
  }

  const touched = ms(lastTouchAt);
  if (minHoursBetween > 0 && touched != null && now - touched < minHoursBetween * 3600000) {
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
export function exhausted({ steps = [], sentSteps = [], startedAt, now = Date.now(), repeatEvery = 0 } = {}) {
  // A repeating ladder never runs out: it asks until they answer.
  if (Math.round(Number(repeatEvery) || 0) > 0) return false;
  const ladder = normalizeSteps(steps);
  if (!ladder.length) return false;
  const started = ms(startedAt);
  if (started == null) return false;
  const last = ladder[ladder.length - 1];
  if (started + last * DAY_MS > now) return false;
  return !dueStep({ steps: ladder, startedAt, sentSteps, now, stopOnAnyInbound: false }).due;
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
