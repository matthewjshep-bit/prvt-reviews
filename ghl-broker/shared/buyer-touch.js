// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// buyer-touch.js — how often the machine may start a text to one buyer.
//
// Buck, 3511 NE 153rd St (2026-10-05): two pulse checks, the deal, a
// walkthrough invite and "Last check on this one…" in eleven days, to a
// buyer who had written once, to ask who this was. Every one of those was
// fine on its own rules; nothing counted them together. Matt: this is a
// relationship business — be intentional, don't spam, and when two deals
// come up close together, send them together.
//
// So, per buyer, across every deal: a buyer who has never written back hears
// from the machine once in 7 days; a buyer we're talking to (a reply in the
// last month, or on a deal with us) twice. Our answers to their texts and
// anything a person sends never count — only texts the machine started.
// Over the limit, a deal text waits for the buyer's week to open and goes
// together with whatever else is waiting for them (blast-refresh.js).
//
// Pure. The broker reads the drafts and events (ghl-broker/buyer-touch.js).

const DAY_MS = 86400000;
export const TOUCH_WINDOW_DAYS = 7;

// Texts the machine starts to a buyer. The walkthrough reminder and
// follow-up count toward the week but are never held by it — they go to a
// buyer who booked a time (showing-sweep.js).
export const TOUCH_KINDS = new Set([
  "blast_open", "deal_followup", "buyer_pulse", "showing_reminder", "showing_followup",
  // Retired 2026-10-05, still in the history.
  "blast_nudge", "dataroom_nudge",
]);
// Deals sent within this long of each other went out as one text.
const SAME_TEXT_MS = 10 * 60000;

export const DEFAULT_TOUCH_BUDGET = { enabled: true, quietPerWeek: 1, talkingPerWeek: 2, talkingDays: 30, bundleMax: 3 };

const int = (v, d, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function normalizeTouchBudget(src = {}) {
  const s = src && typeof src === "object" ? src : {};
  const d = DEFAULT_TOUCH_BUDGET;
  return {
    enabled: s.enabled !== false,
    quietPerWeek: int(s.quietPerWeek, d.quietPerWeek, 1, 7),
    talkingPerWeek: int(s.talkingPerWeek, d.talkingPerWeek, 1, 7),
    talkingDays: int(s.talkingDays, d.talkingDays, 1, 365),
    bundleMax: int(s.bundleMax, d.bundleMax, 1, 3),
  };
}

const ms = (v) => {
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : null;
};

/**
 * touchTimes(drafts, { now, days }) → [ms], oldest first
 *
 * When the machine started a text to this buyer, from their sent drafts.
 * Only investor texts with a machine kind; a reply (no outbound kind) or a
 * hand text never counts. Deals sent minutes apart (one combined text) are
 * one touch.
 */
export function touchTimes(drafts = [], { now = Date.now(), days = TOUCH_WINDOW_DAYS } = {}) {
  const from = now - days * DAY_MS;
  const times = (drafts || [])
    .filter((d) => d?.status === "sent" && (d.party || "investor") === "investor" && TOUCH_KINDS.has(d.outbound?.kind))
    .map((d) => ms(d.sentAt || d.updatedAt))
    .filter((t) => t != null && t > from && t <= now)
    .sort((a, b) => a - b);
  const out = [];
  for (const t of times) if (!out.length || t - out[out.length - 1] > SAME_TEXT_MS) out.push(t);
  return out;
}

/**
 * isTalking({ events, now, talkingDays }) → boolean
 *
 * They wrote or called in the last `talkingDays`, or spoke up on / took a
 * deal in that time. `events` are the contact's record events.
 */
export function isTalking({ events = [], now = Date.now(), talkingDays = DEFAULT_TOUCH_BUDGET.talkingDays } = {}) {
  const from = now - talkingDays * DAY_MS;
  return (events || []).some((e) => ["text_summary", "call_summary", "investor_evaluating", "investor_committed"].includes(e?.type)
    && (ms(e.at) ?? 0) > from);
}

/**
 * touchLimit({ drafts, events, now, budget }) → { open, at, used, allowed, talking }
 *
 * `open`: the machine may start a text to them now. Otherwise `at` is when
 * it may (the oldest touch in the window turns seven days old).
 */
export function touchLimit({ drafts = [], events = [], now = Date.now(), budget = {} } = {}) {
  const b = normalizeTouchBudget(budget);
  const talking = isTalking({ events, now, talkingDays: b.talkingDays });
  const allowed = talking ? b.talkingPerWeek : b.quietPerWeek;
  if (!b.enabled) return { open: true, at: now, used: 0, allowed, talking };
  const times = touchTimes(drafts, { now });
  if (times.length < allowed) return { open: true, at: now, used: times.length, allowed, talking };
  // The touch that has to age out for one more to fit.
  const at = times[times.length - allowed] + TOUCH_WINDOW_DAYS * DAY_MS;
  return { open: false, at, used: times.length, allowed, talking };
}
