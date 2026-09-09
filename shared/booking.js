// booking.js — the calendar, as a structural guard.
//
// "Let's talk Thursday" is an intent the bot recognises and has always had to
// hand to a person, because proposing a time is a commitment. This makes it
// one the machine can keep: the times it may name come from the calendar's
// free slots, the reply may name ONLY those (verbatim labels, so the check is
// a substring match and not a judgment), and a time the other side picks is
// booked only if it was one we offered and is still free.
//
// Same shape as the counter band (shared/auto-accept.js): a verdict with
// named checks, written onto the draft pass or fail. Pure — the slots and
// the clock are passed in.

export const BOOKING_DEFAULTS = Object.freeze({
  enabled: false,
  calendarId: "",
  calendarName: "",
  daysAhead: 5,          // how far out we look for free slots
  slotsToOffer: 3,       // at most this many times in one text
  durationMin: 15,       // the appointment's length
  minLeadHours: 2,       // never a slot sooner than this
  title: "Call with {{name}}",
});

export const BOOKING_INTENTS = {
  agent: ["wants_call", "scheduling"],
  investor: ["wants_call", "wants_walkthrough"],
};

// Words that mean a time is on the table. Cheap pre-check so the calendar is
// read only when it could matter — most texts never mention one.
export const SCHEDULING_RE =
  /\b(call|talk|phone|chat|hop on|jump on|meet|walk(?:through| it| the)?|tour|show(?:ing)?|see (?:it|the)|time|when|schedule|available|availability|free (?:at|on|tomorrow|today)|tomorrow|tonight|morning|afternoon|(?:mon|tues?|wed(?:nes)?|thurs?|fri|sat(?:ur)?|sun)(?:day)?\b|\d{1,2}\s?(?:am|pm))\b/i;

export const looksLikeScheduling = (text) => SCHEDULING_RE.test(String(text || ""));

/**
 * slotLabel(iso, timeZone) → "Thu Sep 11 at 2:00pm"
 *
 * One exact rendering per slot. The reply must carry it verbatim, so the
 * label is the contract: short, unambiguous, the way a person texts a time.
 */
export function slotLabel(iso, timeZone = "America/Los_Angeles") {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(t);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const minute = get("minute");
  const ampm = get("dayPeriod").toLowerCase();
  return `${get("weekday")} ${get("month")} ${get("day")} at ${get("hour")}:${minute}${ampm}`;
}

/**
 * pickSlots(freeSlots, { now, count, minLeadHours, timeZone }) → [{ iso, label }]
 *
 * From everything the calendar has, the few worth naming: after the lead
 * time, at most one per day, spread across the days we looked at (two on
 * Thursday and one on Friday reads better than three on Thursday).
 */
export function pickSlots(freeSlots = [], { now = Date.now(), count = 3, minLeadHours = 2, timeZone = "America/Los_Angeles" } = {}) {
  const lead = now + Math.max(0, Number(minLeadHours) || 0) * 3600000;
  const ok = [...new Set(freeSlots.map(String))]
    .map((iso) => ({ iso, t: Date.parse(iso) }))
    .filter((s) => Number.isFinite(s.t) && s.t >= lead)
    .sort((a, b) => a.t - b.t);
  const byDay = new Map();
  for (const s of ok) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s.t));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }
  const out = [];
  const days = [...byDay.values()];
  // Round-robin across days: the first free slot of each day, then seconds.
  for (let round = 0; out.length < count && days.some((d) => d.length > round); round++) {
    for (const d of days) {
      if (out.length >= count) break;
      // Prefer mid-morning / early-afternoon over the very first slot of a day.
      const pick = d[round];
      if (pick) out.push(pick);
    }
  }
  return out.slice(0, count).map((s) => ({ iso: s.iso, label: slotLabel(s.iso, timeZone) }));
}

const sameInstant = (a, b) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
const inList = (iso, list) => (list || []).some((x) => sameInstant(typeof x === "string" ? x : x?.iso, iso));

/**
 * evaluateBookingGuard({ draft, offered, previouslyOffered, freeSlots, config, now })
 *   → { kind: "booking", passed, reason, checks, offered, chosen, at }
 *
 * Two shapes of message, one guard:
 *
 *   We PROPOSE times. Every slot the model says it offered must be in
 *   `offered` (the list we handed it — which came from the calendar), and
 *   its label must appear verbatim in the reply. No slot at all is a fail:
 *   a reply about a call that names no time is a holding reply, and a
 *   person should read it.
 *
 *   They PICK one. `chosenSlot` must be one we previously offered and must
 *   still be free right now. The reply must carry its label.
 */
export function evaluateBookingGuard({ draft = {}, offered = [], previouslyOffered = [], freeSlots = [], config = {}, now = Date.now() } = {}) {
  const checks = [];
  const at = new Date(now).toISOString();
  const reply = String(draft.reply || "");
  const fail = (reason) => ({ kind: "booking", passed: false, reason, checks, offered: [], chosen: null, at });
  const max = Math.max(1, Number(config.slotsToOffer) || 3);

  const chosen = String(draft.chosenSlot || "").trim();
  if (chosen) {
    const prev = (previouslyOffered || []).find((s) => sameInstant(s.iso || s, chosen));
    checks.push({ name: "chosen_was_offered", ok: Boolean(prev), detail: prev ? prev.label || chosen : `we never offered ${chosen}` });
    if (!prev) return fail("they named a time we never offered");
    const free = inList(chosen, freeSlots);
    checks.push({ name: "chosen_still_free", ok: free, detail: free ? "still open" : "that slot is gone" });
    if (!free) return fail(`${prev.label || chosen} is no longer free`);
    const said = reply.includes(prev.label);
    checks.push({ name: "reply_names_it", ok: said, detail: prev.label });
    if (!said) return fail("the reply does not confirm the time in the words we use");
    return { kind: "booking", passed: true, reason: `booking ${prev.label}`, checks, offered: [], chosen: { iso: prev.iso || chosen, label: prev.label }, at };
  }

  const said = (Array.isArray(draft.offeredSlots) ? draft.offeredSlots : []).map(String).filter(Boolean);
  checks.push({ name: "offered_any", ok: said.length > 0, detail: `${said.length} time${said.length === 1 ? "" : "s"}` });
  if (!said.length) return fail("no time was offered — a person should answer this one");
  checks.push({ name: "offered_count", ok: said.length <= max, detail: `${said.length} of ${max}` });
  if (said.length > max) return fail(`named ${said.length} times, the page allows ${max}`);
  const resolved = [];
  for (const iso of said) {
    const slot = (offered || []).find((s) => sameInstant(s.iso, iso));
    if (!slot) { checks.push({ name: "slot_from_calendar", ok: false, detail: iso }); return fail("named a time that is not on the calendar"); }
    if (!reply.includes(slot.label)) { checks.push({ name: "reply_names_it", ok: false, detail: slot.label }); return fail(`the reply does not say "${slot.label}" as written`); }
    resolved.push(slot);
  }
  checks.push({ name: "slot_from_calendar", ok: true, detail: resolved.map((s) => s.label).join(", ") });
  checks.push({ name: "reply_names_it", ok: true, detail: "every offered time is in the text, verbatim" });
  return { kind: "booking", passed: true, reason: `offers ${resolved.map((s) => s.label).join(", ")}`, checks, offered: resolved, chosen: null, at };
}

/**
 * bookingContextText({ offered, previouslyOffered, timeZone }) → string
 *
 * The block the model reads. Labels are the contract, so they are repeated
 * as "say exactly".
 */
export function bookingContextText({ offered = [], previouslyOffered = [] } = {}) {
  const lines = [];
  if (previouslyOffered.length) {
    lines.push("TIMES WE ALREADY OFFERED THEM (if this message picks one, set chosenSlot to its ISO value and confirm it using the exact label):");
    for (const s of previouslyOffered) lines.push(`  ${s.label}  →  ${s.iso}`);
  }
  if (offered.length) {
    lines.push("TIMES YOU MAY PROPOSE FOR A CALL OR A VISIT (say each exactly as labelled, never any other time; set offeredSlots to the ISO values you used):");
    for (const s of offered) lines.push(`  ${s.label}  →  ${s.iso}`);
  }
  return lines.join("\n");
}
