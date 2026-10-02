// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// bot-hold.js — "stop the bot on them": one reading of what a person pressed.
//
// Stop, Pause and Resume (the work pane's Bot menu, a promise row's Stop)
// write contact_events `drive_stopped` / `drive_resumed`
// (ghl-broker/routes/dashboard.js). Matt, 2026-10-01: a stop is the whole
// person, and while it holds nothing goes to them by itself — no nudge, no
// check-in, no letter, no auto-reply. Their texts still get a draft, and the
// draft waits for him. Every place a text can leave asks this, so the stop
// means the same thing to the reply agent, the sweeps, the audit and the
// Offers column. Before this, four readers each had their own copy of the
// toggle and most senders read none of them.
//
// Pure: events in, a verdict out. The runner reads the events with no time
// window (ghl-broker/bot-hold.js), so a stop pressed in June still holds in
// October.

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

export const STOP_EVENT = "drive_stopped";
export const RESUME_EVENT = "drive_resumed";
export const PACE_EVENT = "cadence_set";
// What a hold (and a pace) is read from.
export const BOT_EVENT_TYPES = [STOP_EVENT, RESUME_EVENT, PACE_EVENT, "unsubscribed"];

// Pause presets on the Bot menu. A pause is a stop with an end date.
export const PAUSE_PRESETS = { "1w": 7, "2w": 14, "1m": 30 };
export const PAUSE_LABEL = { "1w": "1 week", "2w": "2 weeks", "1m": "1 month" };
export const MAX_PAUSE_DAYS = 35;

// Check in less / normal / more, per person (Matt, 2026-10-01). A pace
// scales the TIME between our own unprompted texts — the offer nudge, the
// passed check-in, the hot push, the pulses — never a rung's number (that is
// its dedupe key) and never a count cap. "More" brings rungs sooner but never
// shrinks a floor (the gap between texts, the hot push's 20 hours); "less"
// stretches both. Their own asks, promises and price drops keep their days.
export const PACES = ["less", "normal", "more"];
export const PACE_FACTOR = { less: 2, normal: 1, more: 0.5 };
export const MIN_PACE = 0.5;
export const MAX_PACE = 2;
export const PACE_LABEL = { less: "Checking in less", normal: "Normal pace", more: "Checking in more" };

const NOT_HELD = Object.freeze({ held: false, kind: null, since: null, until: null, endedAt: null, reason: "" });

/**
 * botHold({ events, offerId, wholeThreadOnly, now }) → { held, kind, since, until, endedAt, reason }
 *
 *   kind     "stopped" (until Resume) | "paused" (until a date) | null
 *   reason   what was typed with the stop — for the screen only, never a
 *            log line or a skip reason (holdLine leaves it out)
 *   endedAt  a pause that ran out by itself, so the column can say so
 *
 * A stop names the whole person (no offerId) or one house. With an offerId,
 * the whole person's stops and that house's count; with none, any stop
 * counts. `wholeThreadOnly` counts only the whole person's (the agent pulse
 * talks to the agent, not about a house). The newest press wins.
 */
export function botHold({ events = [], offerId = null, wholeThreadOnly = false, now = Date.now() } = {}) {
  const mine = (e) => (wholeThreadOnly ? !e.offerId : !e.offerId || !offerId || e.offerId === offerId);
  const last = (events || [])
    .filter((e) => (e?.type === STOP_EVENT || e?.type === RESUME_EVENT) && mine(e))
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
    .at(-1);
  if (!last || last.type !== STOP_EVENT) return { ...NOT_HELD };
  const until = ms(last.data?.until);
  const reason = String(last.data?.reason || "").trim().slice(0, 200);
  if (until != null && until <= now) return { ...NOT_HELD, endedAt: new Date(until).toISOString() };
  return {
    held: true, kind: until != null ? "paused" : "stopped", since: last.at || null,
    until: until != null ? new Date(until).toISOString() : null, endedAt: null, reason,
  };
}

/** "Oct 15", in Pacific time — the day a pause ends. */
export function pauseDay(iso) {
  const t = ms(iso);
  return t == null ? "" : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

/**
 * holdLine(hold) → "you stopped the bot on them" | "paused until Oct 15" | ""
 *
 * The words a skip, a flag or a log line carries. Never the reason a person
 * typed: skip lines are logged, and a reason can hold a name.
 */
export function holdLine(hold) {
  if (!hold?.held) return "";
  if (hold.kind === "unread") return "couldn't read whether you stopped the bot";
  return hold.kind === "paused" ? `paused until ${pauseDay(hold.until)}` : "you stopped the bot on them";
}

/**
 * pauseUntil({ preset, until, now }) → { until } | { error }
 *
 * No preset and no date: a stop until Resume ({ until: null }). A pause ends
 * more than an hour from now and at most five weeks out — a longer one is a
 * stop with a reminder nobody set.
 */
export function pauseUntil({ preset = null, until = null, now = Date.now() } = {}) {
  let at = null;
  if (preset) {
    const days = PAUSE_PRESETS[preset];
    if (!days) return { error: "pick 1 week, 2 weeks or 1 month" };
    at = now + days * DAY_MS;
  } else if (until) {
    at = ms(until);
    if (at == null) return { error: "that isn't a date" };
  } else {
    return { until: null };
  }
  if (at <= now + HOUR_MS) return { error: "pick a date in the future" };
  if (at > now + MAX_PAUSE_DAYS * DAY_MS) return { error: "pick a date in the next five weeks" };
  return { until: new Date(at).toISOString() };
}

/**
 * paceOf({ events }) → { pace, factor, since }
 * The newest Check in less / normal / more. Anything unreadable is normal.
 */
export function paceOf({ events = [] } = {}) {
  const last = (events || []).filter((e) => e?.type === PACE_EVENT)
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))).at(-1);
  const pace = PACES.includes(last?.data?.pace) ? last.data.pace : "normal";
  return { pace, factor: PACE_FACTOR[pace], since: pace === "normal" ? null : last?.at || null };
}

/**
 * paceScale(factor) → { rung, floor }
 *   rung   multiplies the time to each rung (2 = half as often)
 *   floor  multiplies a minimum gap: stretched by "less", never shrunk
 */
export function paceScale(factor = 1) {
  const f = Math.min(MAX_PACE, Math.max(MIN_PACE, Number(factor) || 1));
  return { rung: f, floor: Math.max(1, f) };
}

/**
 * mergeEvents(...lists) → events
 *
 * One timeline from several reads (a windowed read plus the no-window read
 * of the stop events), each event once.
 */
export function mergeEvents(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const e of list || []) {
      if (!e) continue;
      const key = e.id != null ? `id:${e.id}` : `${e.type}|${e.at}|${e.dedupeKey || ""}|${e.contactId || ""}|${e.offerId || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}
