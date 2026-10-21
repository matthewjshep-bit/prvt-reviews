// outreach-email.js — the day-2 introduction email to a listing agent who
// hasn't answered our first text (2026-10-20, shared/outreach-email.js).
//
// Runs at the end of the morning follow-up sweep (follow-up-sweep.js), so it
// goes the same day as the day-2 follow-up text. Each agent due is claimed
// with an `outreach_email_queued` event (one per agent, ever), then gets an
// email draft: scheduled across the day's machine hours when the email may
// send itself, otherwise waiting in the outbox for Matt. The send itself is
// reply-agent.js sendReplyDraft's, with every guard a text has (a stop, a
// pass, a live thread, an email opt-out).

import { recordEvent } from "./contact-record.js";
import { conversationConfig } from "./reply-agent.js";
import { getContact, emailUnsubscribed } from "./ghl.js";
import { spreadAcrossDay, machineHours } from "./conversation-scheduler.js";
import { normalizeIntroEmail, introEmailFor, introEmailDue, INTRO_EMAIL_EVENT_TYPES, INTRO_EMAIL_LATE_DAYS } from "./shared/outreach-email.js";

const DAY_MS = 86400000;
const iso = (t) => new Date(t).toISOString();
// The same ceiling the sweep puts on its own starts in a run.
export const MAX_INTRO_EMAILS_PER_RUN = 150;
export const INTRO_EMAIL_KIND = "outreach_email";

const nameOf = (c) => [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim() || String(c?.contactName || c?.name || "").trim();

/**
 * runIntroEmails({ client, store, locationId, saved, sendsEnabled, now, dryRun, held, deps })
 *   → { queued, drafted, rows }
 *
 * `held(contactId)` says the bot is stopped on them (the sweep's bot-hold
 * read). `deps.getContact` stands in for GHL in tests.
 */
export async function runIntroEmails({ client, store, locationId, saved = {}, sendsEnabled = false, now = Date.now(), dryRun = false, held = () => false, deps = {} }) {
  const out = { queued: 0, drafted: 0, rows: [] };
  const ie = normalizeIntroEmail(saved?.outreachAutopilot?.introEmail);
  if (!ie.enabled) return out;
  const read = typeof deps.getContact === "function" ? deps.getContact : (id) => getContact(client, id);
  const config = conversationConfig(saved);
  const schedule = !dryRun && sendsEnabled && config.enabled && ie.autoSend;
  const why = !sendsEnabled ? "sends are off on the broker (CARD_SENDS_ENABLED)"
    : !config.enabled ? "Conversation AI is switched off" : "intro emails wait for you until they may send themselves (Autopilot → Agents)";

  const since = iso(now - (ie.day + INTRO_EMAIL_LATE_DAYS + 1) * DAY_MS);
  const events = await store.listContactEventsSince(locationId, since, { types: INTRO_EMAIL_EVENT_TYPES, limit: 20000 }).catch(() => []);
  const byContact = new Map();
  for (const e of events || []) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }

  const auto = config.autoSend || {};
  for (const [contactId, list] of byContact) {
    if (out.queued + out.drafted >= MAX_INTRO_EMAILS_PER_RUN) break;
    const due = introEmailDue({ events: list, day: ie.day, now });
    if (!due.due) continue;
    const row = { contactId, address: due.address, kind: INTRO_EMAIL_KIND };
    if (held(contactId)) { out.rows.push({ ...row, status: "skipped", reason: "you stopped the bot on them" }); continue; }
    const contact = await read(contactId).catch(() => null);
    if (!contact) { out.rows.push({ ...row, status: "skipped", reason: "couldn't read the contact in GHL" }); continue; }
    if (!String(contact.email || "").trim()) { out.rows.push({ ...row, status: "skipped", reason: "no email in GHL" }); continue; }
    if (emailUnsubscribed(contact)) { out.rows.push({ ...row, status: "skipped", reason: "they opted out of email" }); continue; }
    const name = nameOf(contact);
    const email = introEmailFor({ introEmail: ie, name, address: due.address });
    if (!email) { out.rows.push({ ...row, status: "skipped", reason: "the email has a blank we can't fill" }); continue; }
    if (dryRun) { out.rows.push({ ...row, status: "would email", subject: email.subject }); continue; }

    const claim = await recordEvent({
      store, locationId, contactId, party: "agent", type: "outreach_email_queued", at: iso(now),
      address: due.address, source: "conversation", ref: `${INTRO_EMAIL_KIND}:${contactId}`,
      dedupeKey: `${INTRO_EMAIL_KIND}:${contactId}`, data: { day: ie.day, firstTextAt: due.openedAt },
    });
    if (!claim.inserted) { out.rows.push({ ...row, status: "skipped", reason: "already claimed" }); continue; }

    const sendAt = schedule
      ? spreadAcrossDay({ now, quietHours: machineHours(auto), hours: auto.nudgeSpreadHours ?? 8, weekends: auto.weekends || "all" })
      : null;
    const ts = iso(now);
    const record = await store.createReplyDraft({
      locationId, contactId, contactName: name, status: schedule ? "scheduled" : "draft", channel: "email", jobId: null,
      inbound: "", outbound: { kind: INTRO_EMAIL_KIND, address: due.address, subject: email.subject },
      reply: email.body, intent: INTRO_EMAIL_KIND, confidence: "high", needsHuman: false, humanReason: "",
      summary: `Introduces us by email, ${ie.day} days after the first text, and asks for distressed properties.`,
      propertyAddress: due.address, counterAmount: null, autoSendable: true, flags: [], party: "agent", partySource: "outreach",
      matchedTags: { agent: [], investor: [] }, contextSummary: {}, offersInContext: 0,
      autoSend: { decided: schedule, reason: schedule ? "" : why }, humanActive: null, actions: [],
      supersededIds: [], warnings: [], noteOnAutoSend: false, promptVersion: 3,
      ...(schedule ? { sendAt, scheduledAt: ts } : {}), updatedAt: ts,
    });
    if (schedule) out.queued++; else out.drafted++;
    out.rows.push({ ...row, status: schedule ? "scheduled" : "draft", draftId: record?.id || null, sendAt });
  }
  return out;
}
