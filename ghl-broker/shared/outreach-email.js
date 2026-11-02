// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// outreach-email.js — the introduction email to a listing agent we texted
// (2026-10-20).
//
// Matt: "include an initial email to that agent introducing ourselves,
// telling them a little bit about what we do (including our website), and
// asking if they have any distressed properties. Maybe we do that on day 2."
// So on day 2, beside the day-2 follow-up text, an agent who hasn't answered
// and has an email in GHL gets one email: who we are, what we buy, the
// website, and the ask. Once per agent, ever.
//
// Settings: outreachAutopilot.introEmail. Off by default, and with it on the
// emails wait in the outbox for Matt until `autoSend` is on too.
//
// Pure. ghl-broker/outreach-email.js finds who's due and queues the draft.

import { fillTemplate, firstNameOf, streetLine } from "./standard-texts.js";
import { streetName, openerVariant, countyName } from "./outreach-opener.js";
import { parseUsAddress } from "./us-address.js";
import { coldTouchGapDays, MORNING_SLACK_HOURS } from "./follow-up.js";

export const DEFAULT_INTRO_EMAIL_SUBJECT = "Matt with Shep Flips: houses that need work";
// Under 100 characters, greeting and sign-off included, with their first
// name and the town of the listing we texted them about (2026-11-02, Matt:
// "keep the email outreach emails to under 100 characters but
// personalized"). It read 480 before, with the website and an opt-out line.
export const EMAIL_MAX_CHARS = 99;
export const DEFAULT_INTRO_EMAIL_BODY = "Hi {first},\n\nMatt with Shep Flips. Got any fixers near {town}? The uglier the better!";

export const INTRO_EMAIL_MAX_SUBJECT = 150;
export const INTRO_EMAIL_MAX_BODY = 3000;
// An agent first texted longer ago than `day` plus this is past the point of
// an introduction: switching the email on doesn't email two months of agents.
// Two days wider since 2026-10-27, so the wait after a day-2 text sent late
// in the afternoon still lands inside it.
export const INTRO_EMAIL_LATE_DAYS = 7;

/**
 * normalizeIntroEmail(v) → { enabled, autoSend, day, subject, body }
 *
 * Off, waiting for Matt, day 2, and the default wording until he changes it.
 * A blank subject or body is the default's.
 */
export function normalizeIntroEmail(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const day = Math.round(Number(o.day));
  const subject = String(o.subject ?? "").replace(/\s+/g, " ").trim().slice(0, INTRO_EMAIL_MAX_SUBJECT);
  const body = String(o.body ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, INTRO_EMAIL_MAX_BODY);
  return {
    enabled: o.enabled === true,
    autoSend: o.autoSend === true,
    day: Number.isFinite(day) && day >= 1 ? Math.min(30, day) : 2,
    subject: subject || DEFAULT_INTRO_EMAIL_SUBJECT,
    body: body || DEFAULT_INTRO_EMAIL_BODY,
  };
}

/**
 * areaOf({ address, county }) → "Renton or the surrounding areas" | "King County or the surrounding areas" | "your area"
 *
 * Where the agent works, as the emails name it (2026-10-20, Matt: "looking
 * in the specific city or county where they work … or surrounding areas
 * too … we want to open up the area as much as possible"): the town of the
 * listing we texted them about, else its county, with the towns around it,
 * else "your area", so {area} always fills.
 */
export function areaOf({ address = "", county = "" } = {}) {
  const town = parseUsAddress(address).city.trim();
  const c = countyName(county);
  const place = town || (c ? `${c} County` : "");
  return place ? `${place} or the surrounding areas` : "your area";
}

/**
 * townOf({ address, county }) → "Renton" | "King County" | ""
 *
 * {town} in the emails: the listing's town, else its county. The emails say
 * "near {town}", so where neither is known, or the email would run past
 * EMAIL_MAX_CHARS with it, it reads "near you" (fillEmail).
 */
export function townOf({ address = "", county = "" } = {}) {
  const town = parseUsAddress(address).city.trim();
  const c = countyName(county);
  return town || (c ? `${c} County` : "");
}

/**
 * fillEmail(text, values) → { body, fits } | null
 *
 * The email filled for one agent, kept under EMAIL_MAX_CHARS: with their
 * town, else "you" in its place. Wording a person wrote that can't fit goes
 * as written (fits: false); the caller prefers one that fits.
 */
export function fillEmail(text, values = {}) {
  const tries = values.town && values.town !== "you" ? [values.town, "you"] : ["you"];
  let first = null;
  for (const town of tries) {
    const body = fillParagraphs(text, { ...values, town });
    if (!body) continue;
    if (body.length <= EMAIL_MAX_CHARS) return { body, fits: true };
    first = first || body;
  }
  return first ? { body: first, fits: false } : null;
}

/**
 * introEmailFor({ introEmail, name, address, county }) → { subject, body } | null
 *
 * The email with its blanks filled ({first}, {town}, {address}, {street},
 * {area}), under EMAIL_MAX_CHARS where the wording allows (fillEmail).
 * A blank we have nothing for leaves the default wording in its place; null
 * only when even that can't be filled.
 */
export function introEmailFor({ introEmail, name = "", address = "", county = "" } = {}) {
  const ie = normalizeIntroEmail(introEmail);
  const values = { first: firstNameOf(name), town: townOf({ address, county }), address: streetLine(address), street: streetName(address), area: areaOf({ address, county }) };
  const subject = fillTemplate(ie.subject, values) || fillTemplate(DEFAULT_INTRO_EMAIL_SUBJECT, values);
  const body = (fillEmail(ie.body, values) || fillEmail(DEFAULT_INTRO_EMAIL_BODY, values))?.body || "";
  return subject && body ? { subject, body } : null;
}

// fillTemplate squeezes whitespace, so an email is filled a paragraph (and a
// line) at a time to keep its shape. "" when a blank can't be filled.
export function fillParagraphs(text, values) {
  const out = [];
  for (const para of String(text || "").split(/\n{2,}/)) {
    const lines = para.split("\n").map((l) => (l.trim() ? fillTemplate(l, values) : ""));
    if (lines.some((l, i) => !l && para.split("\n")[i].trim())) return "";
    out.push(lines.join("\n"));
  }
  return out.join("\n\n").trim();
}

const DAY_MS = 86400000;
// After the first text, any of these and an introduction is beside the point:
// they answered, or we're already talking numbers.
const ENDED_BY = new Set(["text_summary", "call_summary", "email_received", "hand_reply", "offer_sent", "realm_yes", "deal_promoted"]);
// A text of ours claimed or sent (the follow-up, the agent check-in). An
// email never goes the same day as one (2026-10-26: 99 follow-up texts went
// within 12 hours of an email, and "Got your messages. Please take me off
// your list" came back). Since 2026-10-27 it waits as long after a text as
// the follow-up texts wait between themselves (followUp.minHoursBetween,
// 72 live): a cold agent got the follow-up text and the intro email a day
// apart, and two touches inside a day drew three times the STOPs.
const OUR_TEXTS = new Set(["follow_up_sent", "agent_pulse_sent", "agent_pulse_texted"]);
export const EMAIL_AFTER_TEXT_HOURS = 20;
export const EMAIL_GAP_HOURS = 72;

/**
 * emailGapHours(conversationConfig) → hours
 *
 * How long an email to a cold agent waits after a text of ours: the agent
 * follow-up's hours between texts, never under EMAIL_AFTER_TEXT_HOURS.
 */
export function emailGapHours(config) {
  const n = Number(config?.parties?.agent?.followUp?.minHoursBetween);
  return Math.max(EMAIL_AFTER_TEXT_HOURS, Number.isFinite(n) ? n : EMAIL_GAP_HOURS);
}

/**
 * checkInEmailGapHours(conversationConfig) → hours
 *
 * The check-in email waits half a check-in interval after a text (a week,
 * with check-ins every 14 days), counted in mornings, so it lands midway
 * between two check-in texts instead of three days after one (Terry V.,
 * 2026-11-02). Never shorter than emailGapHours.
 */
export function checkInEmailGapHours(config) {
  const every = config?.parties?.agent?.followUp?.ladders?.outreach_nudge?.repeatEvery;
  const half = coldTouchGapDays(every) * 24 - MORNING_SLACK_HOURS;
  return Math.max(emailGapHours(config), half);
}

/**
 * emailWaitReason(hoursSince, gapHours, verb) → "we texted them 2 days ago — an email waits 7 days after a text"
 *
 * In hours up to the 72-hour gap, in days past it (the check-in email's week).
 */
export function emailWaitReason(hoursSince, gapHours, verb = "texted") {
  if (gapHours <= EMAIL_GAP_HOURS) return `we ${verb} them ${Math.floor(hoursSince)} hours ago — an email waits ${gapHours} hours after a text`;
  const since = hoursSince < 48 ? `${Math.floor(hoursSince)} hours` : `${Math.floor(hoursSince / 24)} days`;
  return `we ${verb} them ${since} ago — an email waits ${Math.round(gapHours / 24)} days after a text`;
}

// Why an email waits: a text of ours inside the gap, or null.
function textedWithin(list, now, gapHours) {
  const last = list.filter((e) => OUR_TEXTS.has(e.type)).map((e) => Date.parse(e.at || "")).filter((t) => Number.isFinite(t) && t <= now);
  if (!last.length) return null;
  const hours = (now - Math.max(...last)) / 3600000;
  return hours < gapHours ? emailWaitReason(hours, gapHours) : null;
}
export const INTRO_EMAIL_EVENT_TYPES = ["outreach_sent", "outreach_email_queued", ...ENDED_BY, ...OUR_TEXTS];

/**
 * introEmailDue({ events, day, now, gapHours }) → { due: true, openedAt, address } | { due: false, reason }
 *
 * One agent's timeline. Due from `day` days after our first text, for
 * INTRO_EMAIL_LATE_DAYS more, when nothing since says they answered or we
 * moved on, and no intro email was ever queued.
 */
export function introEmailDue({ events = [], day = 2, now = Date.now(), gapHours = EMAIL_GAP_HOURS } = {}) {
  const list = [...events].filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (list.some((e) => e.type === "outreach_email_queued")) return { due: false, reason: "already emailed" };
  const opened = list.filter((e) => e.type === "outreach_sent").at(-1);
  if (!opened) return { due: false, reason: "no first text from the app" };
  const at = Date.parse(opened.at || "");
  if (!Number.isFinite(at)) return { due: false, reason: "no first text from the app" };
  if (list.some((e) => ENDED_BY.has(e.type) && String(e.at) > String(opened.at))) return { due: false, reason: "they answered, or we're past an introduction" };
  if (now < at + day * DAY_MS) return { due: false, reason: `day ${day} hasn't come round yet` };
  if (now >= at + (day + INTRO_EMAIL_LATE_DAYS) * DAY_MS) return { due: false, reason: "too long since the first text" };
  const waits = textedWithin(list, now, gapHours);
  if (waits) return { due: false, reason: waits };
  return { due: true, openedAt: opened.at, address: opened.address || "", county: opened.data?.county || "" };
}

/* ---------- the check-in emails ---------- */

// An email with each 14-day check-in text, to an agent who had the intro
// email and still hasn't answered (2026-10-20, Matt: "an email follow-up
// with the 14-day check-in: something short, concise, and to the point …
// Make it personable. Make it fun."). One per check-in, the next of these
// each time, subject and body together.
// Under 100 characters each since 2026-11-02 (EMAIL_MAX_CHARS), "near
// {town}" so a long name and town still fit as "near you".
export const DEFAULT_CHECK_IN_EMAILS = [
  { subject: "anything ugly lately?",
    body: "Hi {first},\n\nAnything ugly near {town} lately? Listed or not, I'm buying.\n\nMatt" },
  { subject: "my two favorite words",
    body: "Hi {first},\n\n\"Needs work.\" Seen any fixers near {town} lately? Send them my way.\n\nMatt" },
  { subject: "checking in",
    body: "Hi {first},\n\nGot anything dated or downright ugly near {town}? I'm all ears.\n\nMatt" },
  { subject: "the uglier the better",
    body: "Hi {first},\n\nIf the ugliest house near {town} lands on your desk, send it my way!\n\nMatt" },
];
export const CHECK_IN_EMAIL_MAX = 8;
// A check-in whose day passed more than this long ago isn't sent late: the
// next one comes round in two weeks. Six days since 2026-10-27: it waits
// 72 hours after the check-in text, which can go as late as 6pm.
export const CHECK_IN_EMAIL_LATE_DAYS = 6;
// Since 2026-11-02 the email waits a week after the check-in text, so the
// window is the wait plus three days of mornings and weekends.
export function checkInEmailLateDays(gapHours = EMAIL_GAP_HOURS) {
  return Math.max(CHECK_IN_EMAIL_LATE_DAYS, Math.ceil((Number(gapHours) || 0) / 24) + 3);
}

/**
 * normalizeCheckInEmail(v) → { enabled, autoSend, emails: [{ subject, body }] }
 *
 * Off and waiting for Matt by default, with the default emails until he
 * writes his own. One with a blank subject or body is dropped.
 */
export function normalizeCheckInEmail(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const emails = (Array.isArray(o.emails) ? o.emails : [])
    .map((e) => ({
      subject: String(e?.subject ?? "").replace(/\s+/g, " ").trim().slice(0, INTRO_EMAIL_MAX_SUBJECT),
      body: String(e?.body ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, INTRO_EMAIL_MAX_BODY),
    }))
    .filter((e) => e.subject && e.body)
    .slice(0, CHECK_IN_EMAIL_MAX);
  return {
    enabled: o.enabled === true,
    autoSend: o.autoSend === true,
    emails: emails.length ? emails : DEFAULT_CHECK_IN_EMAILS.map((e) => ({ ...e })),
  };
}

/**
 * checkInEmailFor({ checkInEmail, name, contactId, n, address, county }) → { subject, body, index } | null
 *
 * The n-th check-in email (1 = the first) for this agent: the emails in
 * turn, starting from one picked by the contact id, so a day's batch doesn't
 * all read alike. One with a blank we can't fill gives way to the next.
 */
export function checkInEmailFor({ checkInEmail, name = "", contactId = "", n = 1, address = "", county = "" } = {}) {
  const { emails } = normalizeCheckInEmail(checkInEmail);
  const values = { first: firstNameOf(name), town: townOf({ address, county }), area: areaOf({ address, county }) };
  const start = openerVariant(contactId, 997) + Math.max(0, Math.round(Number(n) || 1) - 1);
  // The next one in turn that fills under EMAIL_MAX_CHARS; one that fills
  // but runs long only when none fits.
  let long = null;
  for (let i = 0; i < emails.length; i++) {
    const index = (start + i) % emails.length;
    const subject = fillTemplate(emails[index].subject, values);
    const filled = fillEmail(emails[index].body, values);
    if (!subject || !filled) continue;
    if (filled.fits) return { subject, body: filled.body, index };
    long = long || { subject, body: filled.body, index };
  }
  return long;
}

export const CHECK_IN_EMAIL_EVENT_TYPES = ["outreach_sent", "outreach_email_queued", "checkin_email_queued", ...ENDED_BY, ...OUR_TEXTS];

/**
 * checkInEmailDue({ events, steps, repeatEvery, now, windowDays, gapHours })
 *   → { due: true, step, n, address } | { due: false, reason }
 *
 * The check-in rungs of the cold-agent ladder: day last+every, last+2·every
 * … before `windowDays`. Due on a rung's day (and up to
 * CHECK_IN_EMAIL_LATE_DAYS after) when they had the intro email, haven't
 * answered, and this rung's email hasn't been queued.
 */
export function checkInEmailDue({ events = [], steps = [], repeatEvery = 0, now = Date.now(), windowDays = 60, gapHours = EMAIL_GAP_HOURS } = {}) {
  const every = Math.round(Number(repeatEvery) || 0);
  const configured = (steps || []).map(Number).filter((d) => Number.isFinite(d) && d > 0);
  if (!(every > 0) || !configured.length) return { due: false, reason: "the follow-up doesn't repeat" };
  const list = [...events].filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const opened = list.filter((e) => e.type === "outreach_sent").at(-1);
  const at = Date.parse(opened?.at || "");
  if (!opened || !Number.isFinite(at)) return { due: false, reason: "no first text from the app" };
  if (!list.some((e) => e.type === "outreach_email_queued" && String(e.at) >= String(opened.at))) return { due: false, reason: "no intro email went" };
  if (list.some((e) => ENDED_BY.has(e.type) && String(e.at) > String(opened.at))) return { due: false, reason: "they answered, or we're past an introduction" };
  const last = Math.max(...configured);
  const daysIn = Math.floor((now - at) / DAY_MS);
  if (daysIn < last + every) return { due: false, reason: `day ${last + every} hasn't come round yet` };
  const n = Math.floor((daysIn - last) / every);
  const step = last + n * every;
  if (step >= windowDays) return { due: false, reason: "past the follow-up window" };
  // Wide enough that the wait after the check-in text still lands inside it.
  if (daysIn - step > checkInEmailLateDays(gapHours)) return { due: false, reason: `day ${step} went by` };
  if (list.some((e) => e.type === "checkin_email_queued" && Number(e.data?.step) === step)) return { due: false, reason: `day ${step} already emailed` };
  const waits = textedWithin(list, now, gapHours);
  if (waits) return { due: false, reason: waits };
  return { due: true, step, n, address: opened.address || "", county: opened.data?.county || "" };
}
