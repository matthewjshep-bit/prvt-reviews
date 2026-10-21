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
import { streetName } from "./outreach-opener.js";

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
