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

// 2026-11-09 (the voice audit): the agent emails read as copywriting. The
// intro said "I texted you a couple of days ago" on day 5 or later, "value-
// add" and "I'd love to hear about them" (1.7% replies of 408); the
// check-ins ("your friendly neighborhood fixer-upper guy", "a kitchen stuck
// in 1974", "in the best way") drew no reply in 124. Now each is one short
// body, 50 to 85 characters, in Matt's voice, naming their street or town,
// picked per agent, in a frame that ends on the opt-out line and, once
// Matt sets it, his postal address (outreachAutopilot.postalAddress).
export const EMAIL_OPT_OUT_LINE = "If you'd rather I didn't email, just reply and say so.";
const OPT_OUT_RX = /\bif you'?d rather I didn'?t email\b/i;

// The intro (pool H): once per agent, the body picked by the contact id.
export const INTRO_EMAIL_BODIES = [
  "Matt Shepherd here, I texted you about {street}. If a house near {town} needs real work, can I get a look?",
  "It's Matt Shepherd, I texted you about {street}. I fix up older houses around {town}. Got any that need a lot?",
  "Matt with Shep Flips, I texted about {street}. Anything near {town} that's more project than the seller wants?",
  "Matt here, I texted you about {street}. Any sellers near {town} who'd rather not fix up before selling?",
  "Matt Shepherd here. I texted you about {street}, and I'm after houses around {town} that need real work. Have one?",
  "It's Matt from Shep Flips, I texted you about {street}. Any estates or tired rentals coming up near {town}?",
  "Matt Shepherd here, same Matt who texted about {street}. Anything off-market near {town} that needs work?",
  "Matt from Shep Flips, I texted about {street}. If one of yours needs too much for retail buyers, can I see it?",
];
// For an agent whose listing we have no street for: still one ask.
export const INTRO_EMAIL_FALLBACK = "Matt Shepherd here, I texted you about your listing. If you have a house that needs real work, can I get a look?";
/** introFrame(body) → the intro email around one body: greeting, signature, opt-out line. */
export const introFrame = (body) => `Hi {first},\n\n${body}\n\nMatt\nShep Flips · shepflips.com\n\n${EMAIL_OPT_OUT_LINE}`;
// What the editor shows as the default: the first body in its frame. A saved
// copy of this (or of the 10-20 email) reads as never changed, so the body is
// picked per agent from the eight.
export const DEFAULT_INTRO_EMAIL_BODY = introFrame(INTRO_EMAIL_BODIES[0]);
// The intro from 2026-10-20 to 2026-11-09.
export const LEGACY_INTRO_EMAIL_BODY = [
  "Hi {first},",
  "This is Matt Shepherd with Shep Flips. I texted you a couple of days ago about your listing. We're a small local team buying houses that need work around {area}. We fix them up, buy as-is, and try to make it easy on the agent's side.",
  "If you have any distressed or value-add properties, listed or off market, the uglier the better, I'd love to hear about them.",
  "You can see more about us at https://shepflips.com.",
  "If you'd rather I didn't email, just reply and say so.",
  "Thanks,\nMatt Shepherd\nShep Flips",
].join("\n\n");

/**
 * withEmailFooter(body, postalAddress) → the email ending on the opt-out
 * line and, when one is set, the postal address on its own line (CAN-SPAM).
 * A body that already has either keeps its own. Matt's saved wording is
 * never changed on the page; this is added as each email is written.
 */
export function withEmailFooter(body = "", postalAddress = "") {
  let out = String(body || "").trim();
  if (!out) return out;
  if (!OPT_OUT_RX.test(out)) out = `${out}\n\n${EMAIL_OPT_OUT_LINE}`;
  const postal = String(postalAddress || "").trim();
  if (postal && !out.includes(postal)) out = `${out}\n${postal}`;
  return out;
}

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
  // A stored copy of a default (today's or the 10-20 one) is read as never
  // changed: the editor saves the body it shows with every switch.
  const own = body && body !== LEGACY_INTRO_EMAIL_BODY && body !== DEFAULT_INTRO_EMAIL_BODY ? body : "";
  return {
    enabled: o.enabled === true,
    autoSend: o.autoSend === true,
    day: Number.isFinite(day) && day >= 1 ? Math.min(30, day) : 2,
    subject: subject || DEFAULT_INTRO_EMAIL_SUBJECT,
    body: own || DEFAULT_INTRO_EMAIL_BODY,
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
 * townOf({ address, county }) → "Renton" | "King County" | "your area"
 *
 * The {town} an email names: the town of the listing we texted them about,
 * else its county, else "your area", so each of the eight still fills and a
 * check-in never has to repeat the last one.
 */
export function townOf({ address = "", county = "" } = {}) {
  const town = parseUsAddress(address).city.trim();
  const c = countyName(county);
  return town || (c ? `${c} County` : "") || "your area";
}

// Which of a pool an agent gets: the contact's, then the next along when one
// has a blank we can't fill.
function pickBody(list, start, fill) {
  for (let i = 0; i < list.length; i++) {
    const index = (start + i) % list.length;
    const body = fill(list[index]);
    if (body) return { body, index };
  }
  return null;
}

/**
 * introEmailFor({ introEmail, name, address, county, contactId, pools, postalAddress, shift }) → { subject, body, index } | null
 *
 * The email with its blanks filled ({first}, {address}, {street}, {town},
 * {area}). The default body is one of the eight, picked by the contact id
 * (`shift` walks to the next); a body Matt wrote is his, as written. Pools
 * "v1" sends the 10-20 email. Either way it ends on the opt-out line and
 * the postal address when one is set. null when a blank can't be filled.
 */
export function introEmailFor({ introEmail, name = "", address = "", county = "", contactId = "", pools = "v2", postalAddress = "", shift = 0 } = {}) {
  const ie = normalizeIntroEmail(introEmail);
  const values = { first: firstNameOf(name), address: streetLine(address), street: streetName(address), area: areaOf({ address, county }), town: townOf({ address, county }) };
  const subject = fillTemplate(ie.subject, values) || fillTemplate(DEFAULT_INTRO_EMAIL_SUBJECT, values);
  let picked = null;
  if (ie.body !== DEFAULT_INTRO_EMAIL_BODY) picked = { body: fillParagraphs(ie.body, values), index: null };
  if (!picked?.body) {
    picked = pools === "v1"
      ? { body: fillParagraphs(LEGACY_INTRO_EMAIL_BODY, values), index: null }
      : pickBody(INTRO_EMAIL_BODIES, openerVariant(contactId, 997) + Math.max(0, Math.round(Number(shift) || 0)), (b) => fillParagraphs(introFrame(b), values))
        || { body: fillParagraphs(introFrame(INTRO_EMAIL_FALLBACK), values), index: null };
  }
  return subject && picked?.body ? { subject, body: withEmailFooter(picked.body, postalAddress), index: picked.index } : null;
}

// fillTemplate squeezes whitespace, so an email is filled a paragraph (and a
// line) at a time to keep its shape. "" when a blank can't be filled. A
// greeting line with no name to put in it ("Hi {first},") is left out, so an
// email to someone we have no first name for opens on its first sentence.
export function fillParagraphs(text, values) {
  const out = [];
  for (const para of String(text || "").split(/\n{2,}/)) {
    const raw = para.split("\n");
    const lines = raw.map((l) => (l.trim() ? fillTemplate(l, values) : ""));
    const greetingOnly = (l) => /^\s*(?:hi|hey|hello)\s+\{first\}\s*[,.!]?\s*$/i.test(l);
    if (lines.some((l, i) => !l && raw[i].trim() && !(greetingOnly(raw[i]) && !values?.first))) return "";
    const kept = lines.filter((l, i) => l || !raw[i].trim());
    if (kept.some((l) => l.trim())) out.push(kept.join("\n"));
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
// 2026-11-09: eight (pool G), lowercase subjects, a 50 to 85 character body
// naming their town, signed "Matt", ending on the opt-out line.
/** checkInFrame(body) → a check-in email around one body. */
export const checkInFrame = (body) => `Hi {first},\n\n${body}\n\nMatt\nShep Flips\n\n${EMAIL_OPT_OUT_LINE}`;
export const CHECK_IN_EMAIL_BODIES = [
  { subject: "anything near {town}?", body: "Listed or not, anything near {town} that needs real work?" },
  { subject: "older houses", body: "Got any older houses around {town} the seller doesn't want to fix up?" },
  { subject: "estates and rentals", body: "Any estates or long-time rentals coming up around {town}?" },
  { subject: "off-market", body: "Anything off-market around {town} I should see?" },
  { subject: "too much work for retail?", body: "If a listing of yours needs more work than retail buyers want, can I take a look?" },
  { subject: "rough ones", body: "Rough houses are my thing. Seen any around {town} lately?" },
  { subject: "skip the repairs", body: "Any sellers near {town} who'd rather skip the repairs and the showings?" },
  { subject: "still looking near {town}", body: "Still after a fixer near {town}. Got one coming?" },
];
export const DEFAULT_CHECK_IN_EMAILS = CHECK_IN_EMAIL_BODIES.map((e) => ({ subject: e.subject, body: checkInFrame(e.body) }));

// The check-in emails from 2026-10-20 to 2026-11-09 (pools "v1"); a stored
// copy of these reads as never changed.
const CHECK_IN_SIGN_OFF = "Thanks,\nMatt Shepherd\nShep Flips | shepflips.com";
export const LEGACY_CHECK_IN_EMAILS = [
  { subject: "anything ugly lately?",
    body: `Hi {first},\n\nMatt again, your friendly neighborhood fixer-upper guy. Anything around {area} cross your desk lately with shag carpet, a tired roof, or a kitchen stuck in 1974? That's my kind of house, listed or off market.\n\n${CHECK_IN_SIGN_OFF}` },
  { subject: "my two favorite words",
    body: `Hi {first},\n\n"Needs work." If you've come across any fixers or value-add properties around {area} lately, on or off market, I'd love to take a look. I keep it easy on the agent's side.\n\n${CHECK_IN_SIGN_OFF}` },
  { subject: "checking in",
    body: `Hi {first},\n\nQuick check-in from the guy who gets excited about the houses everyone else walks past. Got anything distressed, dated, or downright ugly around {area}? I'm all ears.\n\n${CHECK_IN_SIGN_OFF}` },
  { subject: "the uglier the better",
    body: `Hi {first},\n\nStill on the lookout for the ugliest house in {area} (in the best way). If a fixer lands on your desk, listed or not, send it my way and I'll take a look quickly.\n\n${CHECK_IN_SIGN_OFF}` },
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
  const legacy = emails.length === LEGACY_CHECK_IN_EMAILS.length
    && emails.every((e, i) => e.subject === LEGACY_CHECK_IN_EMAILS[i].subject && e.body === LEGACY_CHECK_IN_EMAILS[i].body);
  return {
    enabled: o.enabled === true,
    autoSend: o.autoSend === true,
    emails: emails.length && !legacy ? emails : DEFAULT_CHECK_IN_EMAILS.map((e) => ({ ...e })),
  };
}

/**
 * checkInEmailFor({ checkInEmail, name, contactId, n, address, county, pools, postalAddress, shift }) → { subject, body, index } | null
 *
 * The n-th check-in email (1 = the first) for this agent: the emails in
 * turn, starting from one picked by the contact id, so a day's batch doesn't
 * all read alike. One with a blank we can't fill gives way to the next;
 * `shift` walks past one more (the queue's answer to a repeat). Pools "v1"
 * with the emails never changed sends the 10-20 ones. Each ends on the
 * opt-out line and the postal address when one is set.
 */
export function checkInEmailFor({ checkInEmail, name = "", contactId = "", n = 1, address = "", county = "", pools = "v2", postalAddress = "", shift = 0 } = {}) {
  const { emails: saved } = normalizeCheckInEmail(checkInEmail);
  const defaults = saved.length === DEFAULT_CHECK_IN_EMAILS.length && saved.every((e, i) => e.subject === DEFAULT_CHECK_IN_EMAILS[i].subject && e.body === DEFAULT_CHECK_IN_EMAILS[i].body);
  const emails = defaults && pools === "v1" ? LEGACY_CHECK_IN_EMAILS : saved;
  const values = { first: firstNameOf(name), area: areaOf({ address, county }), town: townOf({ address, county }) };
  const start = openerVariant(contactId, 997) + Math.max(0, Math.round(Number(n) || 1) - 1) + Math.max(0, Math.round(Number(shift) || 0));
  for (let i = 0; i < emails.length; i++) {
    const index = (start + i) % emails.length;
    const subject = fillTemplate(emails[index].subject, values);
    const body = fillParagraphs(emails[index].body, values);
    if (subject && body) return { subject, body: withEmailFooter(body, postalAddress), index };
  }
  return null;
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
