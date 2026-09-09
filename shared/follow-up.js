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
  outreach_nudge: { enabled: false, steps: [2, 5, 9, 14, 21, 30], onExhausted: "stop" },
  offer_nudge:    { enabled: false, steps: [3, 7, 14], onExhausted: "mark_no_response" },
  blast_nudge:    { enabled: false, steps: [2, 6],     onExhausted: "stop" },
  dataroom_nudge: { enabled: false, steps: [1, 4],     onExhausted: "stop" },
};

export const MAX_LADDER_STEPS = 6;
export const MAX_STEP_DAY = 120;

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
  now = Date.now(), stopOnAnyInbound = true, minHoursBetween = 0,
} = {}) {
  const ladder = normalizeSteps(steps);
  if (!ladder.length) return { due: false, reason: "no ladder" };
  const started = ms(startedAt);
  if (started == null) return { due: false, reason: "nothing to count from" };

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
export function exhausted({ steps = [], sentSteps = [], startedAt, now = Date.now() } = {}) {
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
  const i = ladder.indexOf(Math.round(Number(step)));
  return i < 0 ? "" : `step ${i + 1} of ${ladder.length}`;
}
