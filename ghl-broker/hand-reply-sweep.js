// hand-reply-sweep.js — a text Matt typed in GHL counts as answered.
//
// Matt, 2026-10-04: seven rows on the Desk were texts he had already answered
// — by hand, in GHL, not through the app. The app only knew about replies
// sent from its own composer (hand-reply.js); a GHL-typed text left no trace,
// so the open draft, last night's "texts we never answered" row and the call
// row all stayed.
//
// Every tick this reads the conversations that moved since the last look and
// finds the outbound texts a PERSON sent. GHL marks those with a userId; the
// app's own sends (the bot, the composer, offer documents) arrive as source
// "app" with no userId, and workflows as source "workflow". For each:
//   - a `hand_reply` event {via: "ghl"} on the timeline — the same event the
//     composer writes, which the audit, the Desk and the drivers' brake
//     (thread-health.js person_has_it) already read;
//   - the contact's open drafts written before it stand aside, marked
//     "you answered it in GHL", the way the composer stands them aside;
//   - deps.onHandText, so what the text SAID can move the offer
//     (our-no-is-a-pass).
//
// Read-only toward GHL; it sends nothing. The words stay in GHL: neither the
// event nor any log carries them.

import { store as defaultStore } from "./store.js";
import { searchConversations, listConversationMessages, removeContactTags as defaultRemoveContactTags } from "./ghl.js";
import { recordEvent } from "./contact-record.js";
import { RA_TAGS } from "./reply-agent.js";
import { HAND_REPLY_EVENT } from "./shared/thread-health.js";

export const HAND_REPLY_CURSOR = "handReplies";
// First run, and the cleanup's look back: how far a fresh cursor reaches.
export const FIRST_LOOKBACK_MS = 3 * 86400000;
// Re-read a little before the cursor: GHL can stamp a message a moment
// before the conversation's lastMessageDate moves. The event key de-dupes.
const OVERLAP_MS = 5 * 60000;
const MAX_PAGES = 6;
const OPEN = ["draft", "scheduled"];
const iso = (ms) => new Date(ms).toISOString();
const atOf = (m) => Date.parse(m?.dateAdded || "") || 0;
const stamp = (c) => Number(c?.lastMessageDate) || Date.parse(c?.lastMessageDate || c?.dateUpdated || "") || 0;

/** A text a person sent: GHL put a user on it. The app and workflows never do. */
export function isPersonText(m) {
  if (String(m?.direction || "").toLowerCase() !== "outbound") return false;
  const type = String(m?.messageType || m?.type || "").toUpperCase();
  if (!/SMS|EMAIL|WHATSAPP|GMB|FB|IG|LIVE_CHAT/.test(type) || /ACTIVITY|CALL|REACTION/.test(type)) return false;
  return Boolean(m.userId);
}

/**
 * findHandTexts({ client, locationId, sinceMs, now }) → [{ contactId, id, at, channel, body }]
 *
 * Conversations whose last message moved after `sinceMs`, newest first,
 * paged until past it; in each, the person-sent texts after `sinceMs`.
 * `body` is for the caller's eyes only (onHandText) — never stored.
 */
export async function findHandTexts({ client, locationId, sinceMs, now = Date.now(), maxPages = MAX_PAGES, report = null }) {
  const convos = [];
  let startAfterDate;
  // Whether everything since `sinceMs` was read: a page cap or a failed
  // read leaves the cursor where it was, so the next tick reads it again.
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const r = await searchConversations(client, locationId, { limit: 50, ...(startAfterDate ? { startAfterDate } : {}) });
    const list = r.conversations || [];
    if (!list.length) { complete = true; break; }
    for (const c of list) if (stamp(c) > sinceMs && !convos.some((x) => x.id === c.id)) convos.push(c);
    const oldest = Math.min(...list.map(stamp));
    if (!(oldest > sinceMs)) { complete = true; break; }
    startAfterDate = oldest;
  }
  const out = [];
  for (const convo of convos) {
    const r = await listConversationMessages(client, convo.id, { limit: 30 }).catch(() => { complete = false; return { messages: [] }; });
    for (const m of r.messages || []) {
      const at = atOf(m);
      if (at <= sinceMs || at > now + 60000 || !isPersonText(m)) continue;
      const contactId = convo.contactId || m.contactId;
      if (!contactId) continue;
      out.push({ contactId, id: m.id || m.messageId || `${contactId}:${at}`, at: iso(at),
        channel: /EMAIL/i.test(String(m.messageType || m.type || "")) ? "email" : "sms", body: String(m.body || "") });
    }
  }
  if (report) report.complete = complete;
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * recordHandText({ client, store, locationId, text, deps }) → { recorded, stoodAside }
 *
 * The timeline event, and the open drafts written before it set aside. A
 * draft written after it answers something newer and is left alone.
 */
export async function recordHandText({ client = null, store = defaultStore, locationId, text, deps = {} }) {
  const who = text.contactId;
  const r = await recordEvent({
    store, locationId, contactId: who, type: HAND_REPLY_EVENT, at: text.at, source: "operator", ref: text.id,
    dedupeKey: `hand_reply:${who}:${text.id}`, data: { via: "ghl", messageId: text.id, channel: text.channel, chars: text.body.length },
  }).catch(() => ({ inserted: 0 }));
  if (!r?.inserted) return { recorded: false, stoodAside: 0 };
  const open = await store.listReplyDrafts(locationId, { contactId: who, status: OPEN, limit: 50 }).catch(() => []);
  const before = open.filter((d) => String(d.createdAt || "") < text.at);
  const ts = new Date().toISOString();
  for (const d of before) {
    await store.updateReplyDraft(d.id, {
      ...d, status: "dismissed", answeredBy: "you", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
      flags: [...(d.flags || []), "you answered it in GHL — the bot stood aside"],
    });
  }
  if (before.length && client) await (deps.removeContactTags || defaultRemoveContactTags)(client, who, [RA_TAGS.draft]).catch(() => {});
  if (typeof deps.onHandText === "function") await deps.onHandText({ ...text, locationId }).catch(() => {});
  return { recorded: true, stoodAside: before.length };
}

const running = new Set();
const groupBy = (texts) => {
  const m = new Map();
  for (const t of texts) { if (!m.has(t.contactId)) m.set(t.contactId, []); m.get(t.contactId).push(t); }
  return m;
};

/**
 * maybeSweepHandReplies({ client, locationId, saved, store, deps, now, sinceMs, log })
 *   → { found, recorded, stoodAside } | null
 *
 * Every tick. The cursor (job_cursors "handReplies") moves to the start of
 * this run less a small overlap; a first run looks back FIRST_LOOKBACK_MS.
 * `sinceMs` overrides the cursor and leaves it where it was (the one-time
 * cleanup); `dryRun` reports per contact and writes nothing. One run per
 * location at a time.
 */
export async function maybeSweepHandReplies({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now(), sinceMs = null, dryRun = false, maxPages = MAX_PAGES, log = () => {} }) {
  if (saved?.conversationAi?.enabled === false) return null;
  if (running.has(locationId)) return null;
  running.add(locationId);
  try {
    const cursor = sinceMs == null ? await store.getJobCursor?.(locationId, HAND_REPLY_CURSOR).catch(() => null) : null;
    const from = sinceMs ?? (cursor?.at ? Date.parse(cursor.at) - OVERLAP_MS : now - FIRST_LOOKBACK_MS);
    let texts;
    const report = { complete: true };
    try { texts = await (deps.findHandTexts || findHandTexts)({ client, locationId, sinceMs: from, now, maxPages, report }); }
    catch (e) { log(`hand-reply sweep ${locationId}: ${e?.message}`); return null; }
    // A dry run says what it would set aside and writes nothing.
    if (dryRun) {
      const contacts = [];
      for (const [contactId, list] of groupBy(texts)) {
        const open = await store.listReplyDrafts(locationId, { contactId, status: OPEN, limit: 50 }).catch(() => []);
        const lastAt = list.at(-1).at;
        contacts.push({ contactId, texts: list.length, lastAt, wouldStandAside: open.filter((d) => String(d.createdAt || "") < lastAt).map((d) => d.id) });
      }
      return { dryRun: true, found: texts.length, contacts };
    }
    let recorded = 0, stoodAside = 0;
    for (const t of texts) {
      const r = await recordHandText({ client, store, locationId, text: t, deps });
      if (r.recorded) recorded++;
      stoodAside += r.stoodAside;
    }
    // Moved on only when the read was whole; the event keys de-dupe a re-read.
    if (sinceMs == null && report.complete) await store.setJobCursor?.(locationId, HAND_REPLY_CURSOR, { at: iso(now), doc: { found: texts.length, recorded, stoodAside } }).catch(() => {});
    if (recorded) log(`hand-reply sweep ${locationId}: ${recorded} typed in GHL, ${stoodAside} draft(s) stood aside`);
    return { found: texts.length, recorded, stoodAside };
  } finally {
    running.delete(locationId);
  }
}
