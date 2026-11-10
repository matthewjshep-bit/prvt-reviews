// outreach-email.js — the emails to a listing agent who hasn't answered our
// first text (shared/outreach-email.js): the day-2 introduction
// (2026-10-20), and an email with each 14-day check-in after it
// (2026-10-20, runCheckInEmails).
//
// Runs at the end of the morning follow-up sweep (follow-up-sweep.js). An
// email waits as long after a text of ours as the follow-up texts wait
// between themselves (72 hours live; 20 hours from 2026-10-26, 2026-10-27
// since), counting anything their GHL thread shows we sent from outside the
// app, and no intro goes to someone we already emailed. Each email is claimed
// with an event first (`outreach_email_queued` once per agent ever,
// `checkin_email_queued` once per agent per check-in day), then becomes an
// email draft: scheduled across the day's machine hours when it may send
// itself, otherwise waiting in the outbox for Matt. The send itself is
// reply-agent.js sendReplyDraft's, with every guard a text has (a stop, a
// pass, a live thread, an email opt-out).

import { recordEvent } from "./contact-record.js";
import { conversationConfig } from "./reply-agent.js";
import { getContact, emailUnsubscribed, getOurLastTouches } from "./ghl.js";
import { spreadAcrossDay, machineHours } from "./conversation-scheduler.js";
import {
  normalizeIntroEmail, introEmailFor, introEmailDue, INTRO_EMAIL_EVENT_TYPES, INTRO_EMAIL_LATE_DAYS,
  normalizeCheckInEmail, checkInEmailFor, checkInEmailDue, CHECK_IN_EMAIL_EVENT_TYPES, emailGapHours,
  checkInEmailGapHours, emailWaitReason, DEFAULT_INTRO_EMAIL_BODY, DEFAULT_CHECK_IN_EMAILS,
} from "./shared/outreach-email.js";
import { OUTREACH_NUDGE_WINDOW_DAYS } from "./shared/follow-up.js";
import { voiceFlags, hardVoiceKeys, voiceLine } from "./shared/voice.js";

const DAY_MS = 86400000;
const iso = (t) => new Date(t).toISOString();
// The same ceiling the sweep puts on its own starts in a run.
export const MAX_INTRO_EMAILS_PER_RUN = 150;
export const INTRO_EMAIL_KIND = "outreach_email";
export const CHECK_IN_EMAIL_KIND = "checkin_email";

const nameOf = (c) => [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim() || String(c?.contactName || c?.name || "").trim();

// The agent emails we already queued or sent them, newest first: what a new
// one must not repeat (shared/voice.js repeatsUs).
const EMAIL_KINDS = new Set(["outreach_email", "checkin_email"]);
const LIVE = new Set(["draft", "scheduled", "sending", "sent"]);
export async function priorAgentEmails(store, locationId, contactId) {
  const rows = await store.listReplyDrafts(locationId, { contactId, status: [...LIVE], limit: 50 }).catch(() => []);
  return (rows || [])
    .filter((d) => d?.channel === "email" && EMAIL_KINDS.has(d.outbound?.kind))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((d) => ({ text: String(d.sentText || d.reply || ""), at: d.sentAt || d.createdAt || null }))
    .filter((p) => p.text.trim());
}

/**
 * lintEmail({ email, kind, prior, ours, walk }) → { email, flags, hard }
 *
 * The voice check at queue time (2026-11-09). Until then every email went
 * in with `flags: []`. One that repeats an email we already sent them walks
 * to the next of its set (`walk(k)`); what is still hard after that keeps
 * the email out of the send queue: it waits for Matt with the reason.
 * `ours`: the app's own wording; an email Matt wrote himself is flagged,
 * never held.
 */
export function lintEmail({ email, kind, prior = [], ours = true, walk = null, tries = 8 }) {
  const check = (e) => voiceFlags({ text: e.body, channel: "email", kind, prior, machine: ours });
  let best = email;
  let flags = check(email);
  for (let k = 1; k < tries && typeof walk === "function" && hardVoiceKeys(flags).some((f) => /^repeats us/.test(f)); k++) {
    const next = walk(k);
    if (!next || next.body === best.body) break;
    const f = check(next);
    if (!hardVoiceKeys(f).some((x) => /^repeats us/.test(x))) { best = next; flags = f; break; }
  }
  return { email: best, flags, hard: hardVoiceKeys(flags) };
}

// Each agent's events in the window, by contact id.
async function eventsByContact(store, locationId, since, types) {
  const events = await store.listContactEventsSince(locationId, since, { types, limit: 20000 }).catch(() => []);
  const byContact = new Map();
  for (const e of events || []) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }
  return byContact;
}

/**
 * queueEmails({ ...ctx, kind, autoSend, label, due, write, claim, summary }) → { queued, drafted, rows }
 *
 * The loop both emails share: who's `due` (contactId, events → { due,
 * address, … }), the GHL read (an email, not opted out, nothing from us
 * inside the gap — and for the intro, no email from us ever), what to `write`
 * (contact name, due → { subject, body } | null), the `claim` event, the
 * draft. `label` names the switch a waiting draft points to.
 */
async function queueEmails({ client, store, locationId, saved, sendsEnabled, now, dryRun, held, deps, byContact, kind, autoSend, label, due: dueFor, write, claim, summary, gapHours: gap, appWording = true }) {
  const out = { queued: 0, drafted: 0, rows: [] };
  const read = typeof deps.getContact === "function" ? deps.getContact : (id) => getContact(client, id);
  const touches = typeof deps.ourTouches === "function" ? deps.ourTouches : (id) => getOurLastTouches(client, locationId, id);
  const priorEmails = typeof deps.priorEmails === "function" ? deps.priorEmails : (id) => priorAgentEmails(store, locationId, id);
  const config = conversationConfig(saved);
  const lintOn = config.checkIns?.lint !== false;
  const gapHours = gap ?? emailGapHours(config);
  const schedule = !dryRun && sendsEnabled && config.enabled && autoSend;
  const why = !sendsEnabled ? "sends are off on the broker (CARD_SENDS_ENABLED)"
    : !config.enabled ? "Conversation AI is switched off" : `${label} wait for you until they may send themselves (Autopilot → Agents)`;
  const auto = config.autoSend || {};

  for (const [contactId, list] of byContact) {
    if (out.queued + out.drafted >= MAX_INTRO_EMAILS_PER_RUN) break;
    const due = dueFor(contactId, list);
    if (!due.due) continue;
    const row = { contactId, address: due.address, kind, ...(due.step != null ? { step: due.step } : {}) };
    if (held(contactId)) { out.rows.push({ ...row, status: "skipped", reason: "you stopped the bot on them" }); continue; }
    const contact = await read(contactId).catch(() => null);
    if (!contact) { out.rows.push({ ...row, status: "skipped", reason: "couldn't read the contact in GHL" }); continue; }
    if (!String(contact.email || "").trim()) { out.rows.push({ ...row, status: "skipped", reason: "no email in GHL" }); continue; }
    if (emailUnsubscribed(contact)) { out.rows.push({ ...row, status: "skipped", reason: "they opted out of email" }); continue; }
    // The thread itself: a bulk email or a text from GHL leaves no event of
    // ours. Unreadable, the app's own records above decide.
    const ours = await touches(contactId).catch(() => null);
    if (kind === INTRO_EMAIL_KIND && ours?.emailedAt) { out.rows.push({ ...row, status: "skipped", reason: "they already had an email from us" }); continue; }
    if (ours?.lastAt && ours.lastAt <= now && now - ours.lastAt < gapHours * 3600000) {
      out.rows.push({ ...row, status: "skipped", reason: emailWaitReason((now - ours.lastAt) / 3600000, gapHours, "reached") });
      continue;
    }
    const name = nameOf(contact);
    let email = write(name, contactId, due, 0);
    if (!email) { out.rows.push({ ...row, status: "skipped", reason: "the email has a blank we can't fill" }); continue; }
    // The voice check (shared/voice.js): one that repeats an email we sent
    // them walks to the next; what still trips waits for Matt.
    let voice = { flags: [], hard: [] };
    if (lintOn) {
      const prior = await Promise.resolve(priorEmails(contactId)).catch(() => []);
      voice = lintEmail({ email, kind, prior: prior || [], ours: appWording, walk: (k) => write(name, contactId, due, k) });
      email = voice.email;
    }
    const hold = voice.hard.length > 0;
    if (dryRun) { out.rows.push({ ...row, status: "would email", subject: email.subject, ...(hold ? { held: voiceLine(voice.hard) } : {}) }); continue; }

    const claimed = await recordEvent({ store, locationId, contactId, party: "agent", at: iso(now), address: due.address, source: "conversation", ...claim(contactId, due) });
    if (!claimed.inserted) { out.rows.push({ ...row, status: "skipped", reason: "already claimed" }); continue; }

    const go = schedule && !hold;
    const sendAt = go
      ? spreadAcrossDay({ now, quietHours: machineHours(auto), hours: auto.nudgeSpreadHours ?? 8, weekends: auto.weekends || "all" })
      : null;
    const ts = iso(now);
    const record = await store.createReplyDraft({
      locationId, contactId, contactName: name, status: go ? "scheduled" : "draft", channel: "email", jobId: null,
      inbound: "", outbound: { kind, address: due.address, subject: email.subject, ...(due.step != null ? { step: due.step } : {}), ...(email.index != null ? { emailIndex: email.index } : {}) }, voiceKind: kind,
      reply: email.body, intent: kind, confidence: "high", needsHuman: false, humanReason: "",
      summary: summary(due), propertyAddress: due.address, counterAmount: null, autoSendable: !hold, flags: hold ? [voiceLine(voice.hard)] : [],
      voiceFlags: voice.flags.map(({ key, level }) => ({ key, level })), ...(appWording ? {} : { voiceOwn: true }), party: "agent", partySource: "outreach",
      matchedTags: { agent: [], investor: [] }, contextSummary: {}, offersInContext: 0,
      autoSend: { decided: go, reason: go ? "" : hold ? `needs a person: ${voiceLine(voice.hard)}` : why }, humanActive: null, actions: [],
      supersededIds: [], warnings: [], noteOnAutoSend: false, promptVersion: 3,
      ...(go ? { sendAt, scheduledAt: ts } : {}), updatedAt: ts,
    });
    if (go) out.queued++; else out.drafted++;
    out.rows.push({ ...row, status: go ? "scheduled" : "draft", draftId: record?.id || null, sendAt, ...(hold ? { held: voiceLine(voice.hard) } : {}) });
  }
  return out;
}

/**
 * runIntroEmails({ client, store, locationId, saved, sendsEnabled, now, dryRun, held, deps })
 *   → { queued, drafted, rows }
 *
 * `held(contactId)` says the bot is stopped on them (the sweep's bot-hold
 * read). `deps.getContact` stands in for GHL in tests.
 */
export async function runIntroEmails({ client, store, locationId, saved = {}, sendsEnabled = false, now = Date.now(), dryRun = false, held = () => false, deps = {} }) {
  const ie = normalizeIntroEmail(saved?.outreachAutopilot?.introEmail);
  if (!ie.enabled) return { queued: 0, drafted: 0, rows: [] };
  const config = conversationConfig(saved);
  const gapHours = emailGapHours(config);
  const pools = config.checkIns?.pools || "v2";
  const postalAddress = String(saved?.outreachAutopilot?.postalAddress || "").trim();
  const byContact = await eventsByContact(store, locationId, iso(now - (ie.day + INTRO_EMAIL_LATE_DAYS + 1) * DAY_MS), INTRO_EMAIL_EVENT_TYPES);
  return queueEmails({ client, store, locationId, saved, sendsEnabled, now, dryRun, held, deps, byContact,
    // The app's own wording is held to the voice check; Matt's own body, or
    // the 10-20 email a "v1" rollback puts back, is flagged, never held.
    kind: INTRO_EMAIL_KIND, autoSend: ie.autoSend, label: "intro emails", appWording: ie.body === DEFAULT_INTRO_EMAIL_BODY && pools !== "v1",
    due: (contactId, list) => introEmailDue({ events: list, day: ie.day, now, gapHours }),
    write: (name, contactId, due, shift = 0) => introEmailFor({ introEmail: ie, name, address: due.address, county: due.county, contactId, pools, postalAddress, shift }),
    claim: (contactId, due) => ({ type: "outreach_email_queued", ref: `${INTRO_EMAIL_KIND}:${contactId}`,
      dedupeKey: `${INTRO_EMAIL_KIND}:${contactId}`, data: { day: ie.day, firstTextAt: due.openedAt } }),
    summary: () => `Introduces us by email, ${ie.day} days after the first text, and asks for distressed properties.` });
}

/**
 * runCheckInEmails({ client, store, locationId, saved, sendsEnabled, now, dryRun, held, deps })
 *   → { queued, drafted, rows }
 *
 * The email with each check-in after the follow-ups (the cold-agent
 * ladder's repeat rungs, every 14 days by default): to agents who had the
 * intro email and haven't answered, the next of the check-in emails each
 * time. Off unless outreachAutopilot.checkInEmail is on and the ladder
 * repeats.
 */
export async function runCheckInEmails({ client, store, locationId, saved = {}, sendsEnabled = false, now = Date.now(), dryRun = false, held = () => false, deps = {} }) {
  const ce = normalizeCheckInEmail(saved?.outreachAutopilot?.checkInEmail);
  const ladder = conversationConfig(saved).parties?.agent?.followUp?.ladders?.outreach_nudge;
  if (!ce.enabled || !(Number(ladder?.repeatEvery) > 0) || !ladder?.steps?.length) return { queued: 0, drafted: 0, rows: [] };
  // A week after the check-in text, not three days (Terry V., 2026-11-02).
  const config = conversationConfig(saved);
  const gapHours = checkInEmailGapHours(config);
  const pools = config.checkIns?.pools || "v2";
  const postalAddress = String(saved?.outreachAutopilot?.postalAddress || "").trim();
  const appWording = pools !== "v1" && ce.emails.length === DEFAULT_CHECK_IN_EMAILS.length
    && ce.emails.every((e, i) => e.subject === DEFAULT_CHECK_IN_EMAILS[i].subject && e.body === DEFAULT_CHECK_IN_EMAILS[i].body);
  const byContact = await eventsByContact(store, locationId, iso(now - (OUTREACH_NUDGE_WINDOW_DAYS + 1) * DAY_MS), CHECK_IN_EMAIL_EVENT_TYPES);
  return queueEmails({ client, store, locationId, saved, sendsEnabled, now, dryRun, held, deps, byContact, gapHours,
    kind: CHECK_IN_EMAIL_KIND, autoSend: ce.autoSend, label: "check-in emails", appWording,
    due: (contactId, list) => checkInEmailDue({ events: list, steps: ladder.steps, repeatEvery: ladder.repeatEvery, now, windowDays: OUTREACH_NUDGE_WINDOW_DAYS, gapHours }),
    write: (name, contactId, due, shift = 0) => checkInEmailFor({ checkInEmail: ce, name, contactId, n: due.n, address: due.address, county: due.county, pools, postalAddress, shift }),
    claim: (contactId, due) => ({ type: "checkin_email_queued", ref: `${CHECK_IN_EMAIL_KIND}:${contactId}:${due.step}`,
      dedupeKey: `${CHECK_IN_EMAIL_KIND}:${contactId}:${due.step}`, data: { step: due.step, n: due.n } }),
    summary: (due) => `The day-${due.step} check-in by email: anything distressed on their desk?` });
}
