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
import { streetName, openerVariant } from "./outreach-opener.js";

export const DEFAULT_INTRO_EMAIL_SUBJECT = "Matt with Shep Flips: houses that need work";
export const DEFAULT_INTRO_EMAIL_BODY = [
  "Hi {first},",
  "This is Matt Shepherd with Shep Flips. I texted you a couple of days ago about your listing. We're a small local team that buys houses that need work, fixes them up, and puts them back on the market. We buy as-is and try to make it easy on the agent's side.",
  "If you have any distressed or value-add properties, listed or off market, the uglier the better, I'd love to hear about them.",
  "You can see more about us at https://shepflips.com.",
  "If you'd rather I didn't email, just reply and say so.",
  "Thanks,\nMatt Shepherd\nShep Flips",
].join("\n\n");

export const INTRO_EMAIL_MAX_SUBJECT = 150;
export const INTRO_EMAIL_MAX_BODY = 3000;
// An agent first texted longer ago than `day` plus this is past the point of
// an introduction: switching the email on doesn't email two months of agents.
export const INTRO_EMAIL_LATE_DAYS = 5;

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
 * introEmailFor({ introEmail, name, address }) → { subject, body } | null
 *
 * The email with its blanks filled ({first}, {address}, {street}). A blank
 * we have nothing for leaves the default wording in its place; null only
 * when even that can't be filled.
 */
export function introEmailFor({ introEmail, name = "", address = "" } = {}) {
  const ie = normalizeIntroEmail(introEmail);
  const values = { first: firstNameOf(name), address: streetLine(address), street: streetName(address) };
  const subject = fillTemplate(ie.subject, values) || fillTemplate(DEFAULT_INTRO_EMAIL_SUBJECT, values);
  const body = fillParagraphs(ie.body, values) || fillParagraphs(DEFAULT_INTRO_EMAIL_BODY, values);
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
export const INTRO_EMAIL_EVENT_TYPES = ["outreach_sent", "outreach_email_queued", ...ENDED_BY];

/**
 * introEmailDue({ events, day, now }) → { due: true, openedAt, address } | { due: false, reason }
 *
 * One agent's timeline. Due from `day` days after our first text, for
 * INTRO_EMAIL_LATE_DAYS more, when nothing since says they answered or we
 * moved on, and no intro email was ever queued.
 */
export function introEmailDue({ events = [], day = 2, now = Date.now() } = {}) {
  const list = [...events].filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (list.some((e) => e.type === "outreach_email_queued")) return { due: false, reason: "already emailed" };
  const opened = list.filter((e) => e.type === "outreach_sent").at(-1);
  if (!opened) return { due: false, reason: "no first text from the app" };
  const at = Date.parse(opened.at || "");
  if (!Number.isFinite(at)) return { due: false, reason: "no first text from the app" };
  if (list.some((e) => ENDED_BY.has(e.type) && String(e.at) > String(opened.at))) return { due: false, reason: "they answered, or we're past an introduction" };
  if (now < at + day * DAY_MS) return { due: false, reason: `day ${day} hasn't come round yet` };
  if (now >= at + (day + INTRO_EMAIL_LATE_DAYS) * DAY_MS) return { due: false, reason: "too long since the first text" };
  return { due: true, openedAt: opened.at, address: opened.address || "" };
}

/* ---------- the check-in emails ---------- */

// An email with each 14-day check-in text, to an agent who had the intro
// email and still hasn't answered (2026-10-20, Matt: "an email follow-up
// with the 14-day check-in: something short, concise, and to the point …
// Make it personable. Make it fun."). One per check-in, the next of these
// each time, subject and body together.
const CHECK_IN_SIGN_OFF = "Thanks,\nMatt Shepherd\nShep Flips | shepflips.com\n\nRather not get these? Just reply and say so.";
export const DEFAULT_CHECK_IN_EMAILS = [
  { subject: "anything ugly lately?",
    body: `Hi {first},\n\nMatt again, your friendly neighborhood fixer-upper guy. Anything cross your desk lately with shag carpet, a tired roof, or a kitchen stuck in 1974? That's my kind of house, listed or off market.\n\n${CHECK_IN_SIGN_OFF}` },
  { subject: "my two favorite words",
    body: `Hi {first},\n\n"Needs work." If you've come across any fixers or value-add properties lately, on or off market, I'd love to take a look. I keep it easy on the agent's side.\n\n${CHECK_IN_SIGN_OFF}` },
  { subject: "checking in",
    body: `Hi {first},\n\nQuick check-in from the guy who gets excited about the houses everyone else walks past. Got anything distressed, dated, or downright ugly on your radar? I'm all ears.\n\n${CHECK_IN_SIGN_OFF}` },
  { subject: "the uglier the better",
    body: `Hi {first},\n\nStill on the lookout for the ugliest house in town (in the best way). If a fixer lands on your desk, listed or not, send it my way and I'll take a look quickly.\n\n${CHECK_IN_SIGN_OFF}` },
];
export const CHECK_IN_EMAIL_MAX = 8;
// A check-in whose day passed more than this long ago isn't sent late: the
// next one comes round in two weeks.
export const CHECK_IN_EMAIL_LATE_DAYS = 3;

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
 * checkInEmailFor({ checkInEmail, name, contactId, n }) → { subject, body, index } | null
 *
 * The n-th check-in email (1 = the first) for this agent: the emails in
 * turn, starting from one picked by the contact id, so a day's batch doesn't
 * all read alike. One with a blank we can't fill gives way to the next.
 */
export function checkInEmailFor({ checkInEmail, name = "", contactId = "", n = 1 } = {}) {
  const { emails } = normalizeCheckInEmail(checkInEmail);
  const values = { first: firstNameOf(name) };
  const start = openerVariant(contactId, 997) + Math.max(0, Math.round(Number(n) || 1) - 1);
  for (let i = 0; i < emails.length; i++) {
    const index = (start + i) % emails.length;
    const subject = fillTemplate(emails[index].subject, values);
    const body = fillParagraphs(emails[index].body, values);
    if (subject && body) return { subject, body, index };
  }
  return null;
}

export const CHECK_IN_EMAIL_EVENT_TYPES = ["outreach_sent", "outreach_email_queued", "checkin_email_queued", ...ENDED_BY];

/**
 * checkInEmailDue({ events, steps, repeatEvery, now, windowDays })
 *   → { due: true, step, n, address } | { due: false, reason }
 *
 * The check-in rungs of the cold-agent ladder: day last+every, last+2·every
 * … before `windowDays`. Due on a rung's day (and up to
 * CHECK_IN_EMAIL_LATE_DAYS after) when they had the intro email, haven't
 * answered, and this rung's email hasn't been queued.
 */
export function checkInEmailDue({ events = [], steps = [], repeatEvery = 0, now = Date.now(), windowDays = 60 } = {}) {
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
  if (daysIn - step > CHECK_IN_EMAIL_LATE_DAYS) return { due: false, reason: `day ${step} went by` };
  if (list.some((e) => e.type === "checkin_email_queued" && Number(e.data?.step) === step)) return { due: false, reason: `day ${step} already emailed` };
  return { due: true, step, n, address: opened.address || "" };
}
