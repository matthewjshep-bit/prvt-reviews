// gmail-sync.js — the email with one person, read from Matt's Gmail when it
// is needed.
//
// When the reply agent is about to draft for a contact (and when someone
// presses "Check Gmail" in their drawer), this searches the inbox for mail
// from or to that contact's addresses in the last lookbackDays, keeps the
// mail a person wrote, and writes one email_received / email_sent event per
// message (keyed on the Gmail message id, so a second read writes nothing).
// The reply agent then reads them as "EMAIL WITH THEM" (shared/gmail.js
// emailContextText). The rest of the inbox is never looked at.
//
// First built as a 15-minute poll of the whole inbox; Matt, 2026-09-28:
// read it only when the conversation AI needs it. Read-only: nothing here
// sends, and nothing here starts a reply. Logs and results carry counts,
// never addresses, subjects or words.

import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { gmailEnv, makeGmail } from "./gmail-api.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { isPersonMail, summarizeMessage, emailEvent, addressInEmail, emailDedupeKey, EMAIL_EVENT_TYPES } from "./shared/gmail.js";

export const MAX_MESSAGES = 25;           // newest first; older ones are already on the record
export const MAX_ADDRESSES = 3;
export const RECHECK_MS = 10 * 60 * 1000;  // two drafts a minute apart don't search twice
export const DRAFT_TIMEOUT_MS = 8000;      // a slow Gmail never holds a draft longer than this

const lastChecked = new Map();   // `${locationId}|${contactId}` → ms
export function _reset() { lastChecked.clear(); }

/** The contact's addresses, as GHL has them: the main one first. */
export function contactEmails(contact) {
  const out = [];
  const add = (v) => { const e = String(v || "").trim().toLowerCase(); if (e.includes("@") && !out.includes(e)) out.push(e); };
  add(contact?.email);
  for (const a of contact?.additionalEmails || []) add(a?.email ?? a);
  return out.slice(0, MAX_ADDRESSES);
}

export const gmailQuery = (emails, days) =>
  `{${emails.map((e) => `from:${e} to:${e} cc:${e}`).join(" ")}} newer_than:${days}d -in:chats`;

/**
 * syncContactGmail({ locationId, contactId, emails, saved, store, deps, now, force })
 *   → { skipped } | { found, recorded, already, bulk }
 *
 * `deps.gmail` stands in for the Gmail client in tests. Without `force`, a
 * contact checked in the last RECHECK_MS is not searched again.
 */
export async function syncContactGmail({ locationId, contactId, emails = [], saved = {}, store = defaultStore, deps = {}, now = Date.now(), force = false, env = process.env }) {
  const cfg = normalizeConversationAi(saved?.conversationAi || {}).gmail;
  if (!cfg.enabled) return { skipped: "Gmail is switched off in Conversation AI settings" };
  const creds = deps.gmail ? null : gmailEnv(env);
  if (!deps.gmail && !creds) return { skipped: "the broker has no Gmail credentials (GMAIL_REFRESH_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)" };
  if (!contactId || !emails.length) return { skipped: "no email address on the contact" };
  const key = `${locationId}|${contactId}`;
  if (!force && now - (lastChecked.get(key) || 0) < RECHECK_MS) return { skipped: "checked a few minutes ago" };
  lastChecked.set(key, now);

  const gmail = deps.gmail || makeGmail(creds);
  const profile = await gmail.profile();
  const self = [String(profile.emailAddress || "").toLowerCase()].filter(Boolean);
  const ids = await gmail.list(gmailQuery(emails, cfg.lookbackDays), { max: MAX_MESSAGES });

  const seen = new Set((await store.listContactEvents?.(locationId, contactId, { types: EMAIL_EVENT_TYPES, limit: 500 }).catch(() => []) || []).map((e) => e.dedupeKey));
  const offers = await store.listOffers?.(locationId, { contactId, limit: 25, lean: true }).catch(() => []) || [];
  const counts = { found: ids.length, recorded: 0, already: 0, bulk: 0 };
  for (const id of ids) {
    if (seen.has(emailDedupeKey(id))) { counts.already++; continue; }
    let msg;
    try { msg = await gmail.message(id); } catch (e) { if (e?.status === 404) continue; throw e; }
    if (!isPersonMail(msg)) { counts.bulk++; continue; }
    const s = summarizeMessage(msg, { self });
    if (!s.id || !s.at) continue;
    const address = addressInEmail(s, offers.map((o) => o?.address).filter(Boolean));
    const offer = address ? offers.find((o) => o?.address === address) : null;
    const { inserted } = await recordEvent({ store, locationId, ...emailEvent(s, { contactId, address, offerId: offer?.id || null }) });
    if (inserted) counts.recorded++; else counts.already++;
  }
  return counts;
}

/**
 * gmailBeforeDraft(args) → the same result, never throws, never waits past
 * DRAFT_TIMEOUT_MS. What the reply agent calls; a failure is a warning on
 * the draft, and the draft goes on with whatever the record already has.
 */
export async function gmailBeforeDraft({ warnings = [], timeoutMs = DRAFT_TIMEOUT_MS, ...args }) {
  const cfg = normalizeConversationAi(args.saved?.conversationAi || {}).gmail;
  if (!cfg.enabled) return { skipped: "off" };
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ skipped: "timeout" }), timeoutMs); });
  try {
    const r = await Promise.race([syncContactGmail(args), timeout]);
    if (r.skipped === "timeout") warnings.push("gmail: took too long, drafted without it");
    return r;
  } catch (e) {
    warnings.push(`gmail: HTTP ${e?.status || "?"}`);
    return { skipped: `HTTP ${e?.status || "?"}` };
  } finally { clearTimeout(timer); }
}
