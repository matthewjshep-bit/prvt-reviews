// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// showing.js — the buyer walkthrough, as a thing a deal has.
//
// A buyer who walks a house buys a house (RUNBOOK, dispositions). So every
// text to a buyer about a deal under contract is working toward one thing: a
// time they have said they will be there. Matt, 2026-09-29: one group window
// per house, agreed with the listing agent, that every blast and every reply
// invites buyers to — one ask of the agent, and buyers who see each other on
// the porch move faster.
//
// What lives here is pure: the shape stored at `offer.deal.showing`, how a
// window reads in a text, the question a blast ends on, the text that asks the
// listing agent for a window, and what the investor prompt is told. Sending
// and storing are the broker's.
//
// What the machine may do with it (Matt, 2026-09-29): ask a buyer for a time
// and ask the listing agent for a window on its own — neither commits anyone.
// A text that CONFIRMS a time to a buyer is a person's: `wants_walkthrough`
// stays in NEVER_AUTO and those replies are drafts on Today.

import { dealOutreachPaused, investorStatus } from "./offer-status.js";

export const SHOWING_TZ = "America/Los_Angeles";

// Who opens the door. It differs per deal, so the deal says; the bot tells a
// buyer only what this says, and never an access code — none is stored.
export const ACCESS_MODES = ["", "agent", "lockbox", "matt"];
export const ACCESS_LABEL = {
  "": "not set",
  agent: "Listing agent lets them in",
  lockbox: "Lockbox (we send access once the time is confirmed)",
  matt: "Matt meets them there",
};

export const AGENT_ASK_STATUSES = ["none", "asked", "confirmed"];

// A buyer's answer to the window. `coming` is them saying yes to a window we
// named; `cant_make_it` is a no to the time, not to the house.
export const RSVP_STATUSES = ["interested", "coming", "cant_make_it", "attended", "no_show"];
export const RSVP_LABEL = {
  interested: "Wants to see it",
  coming: "Coming",
  cant_make_it: "Can't make the window",
  attended: "Walked it",
  no_show: "No-show",
};
// What the model may report from a buyer's text (schema enum). "" = nothing
// about the walkthrough in this message.
export const RSVP_SIGNALS = ["", "interested", "coming", "cant_make_it"];

export const MAX_WINDOWS = 3;
const MAX_RSVPS = 200;

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const isoOrNull = (v) => {
  const t = Date.parse(String(v || ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** normalizeShowing(raw) → the stored shape, whatever came in. */
export function normalizeShowing(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const windows = (Array.isArray(s.windows) ? s.windows : [])
    .map((w) => {
      const start = isoOrNull(w?.start);
      let end = isoOrNull(w?.end);
      if (!start) return null;
      // An end at or before the start is a typo; an hour is the usual window.
      if (!end || Date.parse(end) <= Date.parse(start)) end = new Date(Date.parse(start) + 3600000).toISOString();
      return { start, end };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, MAX_WINDOWS);
  const a = s.access && typeof s.access === "object" ? s.access : {};
  const access = { mode: ACCESS_MODES.includes(a.mode) ? a.mode : "", note: str(a.note, 200) };
  const k = s.agentAsk && typeof s.agentAsk === "object" ? s.agentAsk : {};
  const agentAsk = {
    status: AGENT_ASK_STATUSES.includes(k.status) ? k.status : "none",
    at: isoOrNull(k.at),
    draftId: str(k.draftId, 64),
  };
  const seen = new Set();
  const rsvps = [];
  for (const r of Array.isArray(s.rsvps) ? s.rsvps : []) {
    const contactId = str(r?.contactId, 64);
    if (!contactId || seen.has(contactId) || !RSVP_STATUSES.includes(r?.status)) continue;
    seen.add(contactId);
    rsvps.push({
      contactId,
      name: str(r.name, 120),
      status: r.status,
      windowStart: isoOrNull(r.windowStart),
      at: isoOrNull(r.at) || new Date(0).toISOString(),
      source: str(r.source, 20) || "manual",
    });
    if (rsvps.length >= MAX_RSVPS) break;
  }
  return { windows, access, agentAsk, rsvps };
}

/** The operator-editable part of a PATCH: windows and access. The rest is the machine's. */
export function applyShowingEdit(current, edit = {}) {
  const cur = normalizeShowing(current);
  const next = { ...cur };
  if (Array.isArray(edit.windows)) next.windows = edit.windows;
  if (edit.access && typeof edit.access === "object") next.access = { ...cur.access, ...edit.access };
  if (edit.agentAsk && typeof edit.agentAsk === "object") next.agentAsk = { ...cur.agentAsk, ...edit.agentAsk };
  if (Array.isArray(edit.rsvps)) next.rsvps = edit.rsvps;
  const out = normalizeShowing(next);
  // A window the operator typed in is the agent's answer: the ask is settled.
  if (out.windows.length && out.agentAsk.status !== "confirmed" && Array.isArray(edit.windows)) {
    out.agentAsk = { ...out.agentAsk, status: "confirmed" };
  }
  return out;
}

const parts = (iso, timeZone) => {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(new Date(iso));
  const get = (type) => p.find((x) => x.type === type)?.value || "";
  return { weekday: get("weekday"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), ampm: get("dayPeriod").toLowerCase() };
};
const clock = (p) => `${p.hour}${p.minute === "00" ? "" : `:${p.minute}`}${p.ampm}`;

/**
 * windowLabel({ start, end }) → "Sat Oct 3, 10am-12pm"
 *
 * How a window reads in a text. No en dash (the carrier scrub turns dashes
 * into commas) and no year: a window is always within the next few weeks.
 */
export function windowLabel(w, timeZone = SHOWING_TZ) {
  if (!w?.start || !Number.isFinite(Date.parse(w.start))) return "";
  const a = parts(w.start, timeZone);
  const day = `${a.weekday} ${a.month} ${a.day}`;
  if (!w.end || !Number.isFinite(Date.parse(w.end))) return `${day} at ${clock(a)}`;
  const b = parts(w.end, timeZone);
  const sameDay = `${b.weekday} ${b.month} ${b.day}` === day;
  if (!sameDay) return `${day} ${clock(a)} to ${b.weekday} ${clock(b)}`;
  // "10-12pm" is ambiguous across noon; say both halves when they differ.
  const start = a.ampm === b.ampm ? `${a.hour}${a.minute === "00" ? "" : `:${a.minute}`}` : clock(a);
  return `${day}, ${start}-${clock(b)}`;
}

/** upcomingWindows(showing, now) → windows that haven't ended, soonest first. */
export function upcomingWindows(showing, now = Date.now()) {
  return normalizeShowing(showing).windows.filter((w) => Date.parse(w.end) > now);
}

/**
 * walkthroughAsk({ showing, now }) → the question a buyer text ends on.
 *
 * With a window: name it and ask them to commit to it. Without one: ask when
 * they could get out there — their answer is what we take to the agent.
 */
export function walkthroughAsk({ showing = null, now = Date.now() } = {}) {
  const next = upcomingWindows(showing, now);
  if (!next.length) return "When could you get out to walk it?";
  const labels = next.slice(0, 2).map((w) => windowLabel(w));
  return next.length === 1
    ? `Walkthrough is ${labels[0]}. Can you make it?`
    : `Walkthroughs are ${labels[0]} or ${labels[1]}. Which works for you?`;
}

/**
 * agentAskText({ agentName, address, now }) → the text to the listing agent.
 *
 * A template, not a model draft: the agent on a deal under contract is under
 * the live-deal hold, and this is the one thing we need from them. It asks
 * for a window and how access works — never for a specific buyer's time, so
 * one answer covers every buyer.
 */
export function agentAskText({ agentName = "", address = "" } = {}) {
  const first = String(agentName || "").trim().split(/\s+/)[0] || "";
  const street = String(address || "").split(",")[0].trim() || "the house";
  return `${first ? `Hi ${first}, ` : "Hi, "}I'd like to line up a buyer walkthrough at ${street} this week. ` +
    `What day and time window works for you, about an hour? And will you let them in or is there a lockbox?`;
}

/** rsvpFor(showing, contactId) → the buyer's row or null. */
export function rsvpFor(showing, contactId) {
  return normalizeShowing(showing).rsvps.find((r) => r.contactId === contactId) || null;
}

/**
 * recordRsvp(showing, { contactId, name, status, windowStart, source, at }) → showing
 *
 * Latest answer wins, with one exception: a buyer the operator marked as
 * having walked it (or not shown up) is past the invite, and a stray "yes"
 * from the bot's read of a later text doesn't undo that.
 */
export function recordRsvp(showing, { contactId, name = "", status, windowStart = null, source = "conversation", at = new Date().toISOString() } = {}) {
  const cur = normalizeShowing(showing);
  if (!contactId || !RSVP_STATUSES.includes(status)) return cur;
  const prev = cur.rsvps.find((r) => r.contactId === contactId);
  if (prev && ["attended", "no_show"].includes(prev.status) && source !== "manual") return cur;
  // "interested" never downgrades a "coming".
  if (prev?.status === "coming" && status === "interested") return cur;
  const row = { contactId, name: name || prev?.name || "", status, windowStart: windowStart || prev?.windowStart || null, at, source };
  return normalizeShowing({ ...cur, rsvps: [row, ...cur.rsvps.filter((r) => r.contactId !== contactId)] });
}

/**
 * showingContextLines(showing, { contactId, now }) → string[]
 *
 * What the investor prompt is told about a deal's walkthrough: the windows
 * and where this buyer stands. Never another buyer's name. Access and
 * occupancy come from shared/deal-access.js.
 */
export function showingContextLines(showing, { contactId = "", now = Date.now() } = {}) {
  const s = normalizeShowing(showing);
  const next = upcomingWindows(s, now);
  const out = [];
  if (next.length) out.push(`walkthrough window${next.length > 1 ? "s" : ""}: ${next.map((w) => windowLabel(w)).join("; ")}`);
  else out.push("walkthrough: no window set yet; ask which day they could get out, and say you'll line it up with the agent");
  // How they get in is the deal's access record (shared/deal-access.js),
  // told to the prompt beside this — not the walkthrough's to say.
  const mine = contactId ? s.rsvps.find((r) => r.contactId === contactId) : null;
  if (mine) out.push(`their walkthrough answer so far: ${RSVP_LABEL[mine.status].toLowerCase()}`);
  const coming = s.rsvps.filter((r) => r.status === "coming").length;
  if (coming > 1) out.push(`${coming} buyers are coming to the walkthrough (you may say others are coming; never who)`);
  return out;
}

/** showingSummary(showing, now) → counts for Today and the Deals table. */
export function showingSummary(showing, now = Date.now()) {
  const s = normalizeShowing(showing);
  const next = upcomingWindows(s, now)[0] || null;
  const count = (st) => s.rsvps.filter((r) => r.status === st).length;
  return {
    next,
    nextLabel: next ? windowLabel(next) : "",
    hoursToNext: next ? (Date.parse(next.start) - now) / 3600000 : null,
    agentAsk: s.agentAsk.status,
    askedAt: s.agentAsk.at,
    coming: count("coming"),
    interested: count("interested"),
    cantMakeIt: count("cant_make_it"),
    attended: count("attended"),
    accessSet: Boolean(s.access.mode),
  };
}

/* ---------- the reminder and the follow-up ---------- */

// The afternoon before a window, Pacific: when "see you tomorrow" goes.
export const REMIND_FROM_HOUR = 15;
export const REMIND_TO_HOUR = 18;
// After a window ends: long enough that they're home, soon enough to matter.
export const FOLLOW_UP_AFTER_HOURS = 2;
export const FOLLOW_UP_WITHIN_HOURS = 48;

const pacific = (t) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: SHOWING_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const get = (type) => p.find((x) => x.type === type)?.value || "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
};

/**
 * showingTouches(offer, { now, remindDayBefore, followUpAfter }) → [{ kind, contactId, name, windowStart, windowLabel, street, key }]
 *
 * The walkthrough texts a deal owes right now (ghl-broker/showing-sweep.js):
 *   showing_reminder  the afternoon before a window, to each buyer who said
 *                     they're coming to it;
 *   showing_followup  two hours to two days after a window, to each buyer who
 *                     came or said they would. A no-show or a no gets nothing.
 * `key` is the claim: one of each per buyer per window, ever. A buyer who has
 * since committed, passed or been taken off the deal has answered, and a deal
 * somebody is taking (dealOutreachPaused) texts nobody new. Pure.
 */
export function showingTouches(offer = {}, { now = Date.now(), remindDayBefore = false, followUpAfter = false } = {}) {
  const deal = offer?.deal;
  if (!deal || deal.stage !== "under_contract" || (!remindDayBefore && !followUpAfter)) return [];
  if (dealOutreachPaused(deal)) return [];
  const s = normalizeShowing(deal.showing);
  if (!s.windows.length || !s.rsvps.length) return [];
  const answered = new Set((deal.investors || []).filter((i) => ["committed", "soft_commit", "passed"].includes(investorStatus(i?.status))).map((i) => i.contactId));
  const street = String(offer.address || "").split(",")[0].trim();
  const out = [];
  const add = (kind, r, w) => out.push({ kind, contactId: r.contactId, name: r.name || "", windowStart: w.start, windowLabel: windowLabel(w), street,
    key: `${kind}:${offer.id}:${r.contactId}:${w.start}` });
  // Which window an answer is for: the one they named, or with none named the
  // soonest window after they answered.
  const windowOf = (r) => r.windowStart
    ? s.windows.find((w) => w.start === r.windowStart) || null
    : s.windows.find((w) => Date.parse(w.end) > Date.parse(r.at || 0)) || null;
  const here = pacific(now);
  const tomorrow = pacific(now + 86400000).day;
  for (const r of s.rsvps) {
    if (answered.has(r.contactId)) continue;
    const w = windowOf(r);
    if (!w) continue;
    if (remindDayBefore && r.status === "coming" && Date.parse(w.start) > now && pacific(Date.parse(w.start)).day === tomorrow
        && here.hour >= REMIND_FROM_HOUR && here.hour < REMIND_TO_HOUR) add("showing_reminder", r, w);
    const since = (now - Date.parse(w.end)) / 3600000;
    if (followUpAfter && ["coming", "attended"].includes(r.status) && since >= FOLLOW_UP_AFTER_HOURS && since <= FOLLOW_UP_WITHIN_HOURS) add("showing_followup", r, w);
  }
  return out;
}
