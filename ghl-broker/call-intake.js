// call-intake.js — a phone call, treated like an inbound text.
//
// GHL's workflow fires when a call ends; the transcript follows a few
// minutes later. This waits for it, then hands the transcript to the same
// pipeline a text goes through: the party, the record book, the intent, the
// actions (tiers, underwrites, offer marks, a booking), the profile facts —
// and a draft of the text a person would send right after hanging up. A
// call_summary event lands on the timeline either way.
//
// Nothing on a call releases more than a text would: the transcript reaches
// the same guards, and the follow-up text sends itself only when
// call_followup is on the party's allowlist.

import { store as defaultStore } from "./store.js";
import { searchConversations, listConversationMessages, getMessageTranscription } from "./ghl.js";
import { startReply } from "./reply-agent.js";
import { recordEvent } from "./contact-record.js";

export const POLL_MS = 30 * 1000;
export const MAX_POLLS = 20;              // ~10 minutes
export const MIN_TRANSCRIPT_CHARS = 40;   // a wrong number is not a conversation
export const MAX_TRANSCRIPT_CHARS = 12000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms = Date.now()) => new Date(ms).toISOString();

const isCall = (m) => /CALL/i.test(String(m?.messageType || m?.type || ""));

/**
 * findRecentCall({ client, locationId, contactId, messageId, withinMs }) → { id, direction, at, durationSec } | null
 *
 * The call the webhook meant: by message id when GHL sent one, else the
 * newest call message on the contact inside the window.
 */
export async function findRecentCall({ client, locationId, contactId, messageId = "", withinMs = 6 * 3600000, now = Date.now() }) {
  const { conversations } = await searchConversations(client, locationId, { contactId, limit: 3 });
  for (const convo of conversations) {
    let lastMessageId = null;
    for (let page = 0; page < 2; page++) {
      const r = await listConversationMessages(client, convo.id, { lastMessageId, limit: 50 });
      for (const m of r.messages) {
        if (!isCall(m)) continue;
        const id = m.id || m.messageId;
        const at = Date.parse(m.dateAdded || "") || 0;
        if (messageId ? id === messageId : now - at <= withinMs) {
          return { id, direction: String(m.direction || "").toLowerCase() === "inbound" ? "inbound" : "outbound", at: iso(at || now),
            durationSec: Number(m.meta?.call?.duration ?? m.callDuration ?? m.duration) || 0, status: String(m.meta?.call?.status || m.status || "") };
        }
      }
      if (!r.nextPage || !r.lastMessageId) break;
      lastMessageId = r.lastMessageId;
    }
  }
  return null;
}

/**
 * fetchTranscript(client, locationId, messageId) → string | null
 * Sentences in order, "THEM:"/"US:" by channel when GHL says which side.
 * null when GHL has none (404) — not yet, or never.
 */
export async function fetchTranscript(client, locationId, messageId) {
  let sentences;
  try { sentences = await getMessageTranscription(client, locationId, messageId); }
  catch (e) { if (e?.status === 404) return null; throw e; }
  const rows = (sentences || []).filter((s) => String(s?.transcript || "").trim())
    .sort((a, b) => (Number(a.sentenceIndex) || 0) - (Number(b.sentenceIndex) || 0));
  if (!rows.length) return null;
  const lines = rows.map((s) => {
    const who = Number(s.mediaChannel) === 1 ? "THEM" : Number(s.mediaChannel) === 0 ? "US" : "";
    return `${who ? `${who}: ` : ""}${String(s.transcript).trim()}`;
  });
  return lines.join("\n").slice(0, MAX_TRANSCRIPT_CHARS);
}

/* ---------- jobs ---------- */

const jobs = new Map();
export const listCallJobs = (locationId) => [...jobs.values()].filter((j) => j.locationId === locationId);
export function _resetJobs() { jobs.clear(); }

/**
 * startCallIntake({ client, locationId, saved, store, contactId, messageId, direction, sendsEnabled, deps })
 *   → { skipped, job }
 *
 * Returns at once; the wait for the transcript and the draft run on their
 * own. deps.findCall / deps.transcript / deps.pollMs / deps.maxPolls are
 * injectable so the whole thing runs offline.
 */
export async function startCallIntake({ client, locationId, saved = {}, store = defaultStore, contactId, messageId = "", direction = "", sendsEnabled = false, deps = {}, now = Date.now() }) {
  if (!contactId) return { skipped: "contact_id required", job: null };
  // One job per call. GHL fires a workflow twice now and then.
  for (const j of jobs.values()) {
    if (j.locationId === locationId && j.contactId === contactId && (messageId ? j.messageId === messageId : now - Date.parse(j.startedAt) < 10 * 60000) && j.status !== "error") {
      return { skipped: `already handling this call (${j.id})`, job: null };
    }
  }
  const job = { id: `call-${Date.now().toString(36)}`, locationId, contactId, messageId: messageId || null, direction: direction || null,
    status: "queued", phase: "queued", startedAt: iso(now), finishedAt: null, polls: 0, transcriptChars: 0, replyJobId: null, skipped: null, error: null };
  jobs.set(job.id, job);
  run(job, { client, locationId, saved, store, sendsEnabled, deps }).catch((e) => {
    job.status = "error"; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = iso();
  });
  return { skipped: null, job };
}

async function run(job, { client, locationId, saved, store, sendsEnabled, deps }) {
  const pollMs = deps.pollMs ?? POLL_MS;
  const maxPolls = deps.maxPolls ?? MAX_POLLS;
  const find = deps.findCall || ((args) => findRecentCall({ client, ...args }));
  const read = deps.transcript || ((id) => fetchTranscript(client, locationId, id));

  job.status = "running"; job.phase = "finding the call";
  let call = await find({ locationId, contactId: job.contactId, messageId: job.messageId || "" });
  // The workflow can fire before the message row exists. One more look.
  if (!call) { await sleep(pollMs); job.polls++; call = await find({ locationId, contactId: job.contactId, messageId: job.messageId || "" }); }
  if (!call) { job.status = "done"; job.skipped = "no call found on the contact"; job.finishedAt = iso(); return; }
  job.messageId = call.id; job.direction = call.direction; job.callAt = call.at; job.durationSec = call.durationSec;

  // Already read? The event's key is the call itself.
  const dedupeKey = `call:${call.id}`;
  const seen = await store.listContactEvents?.(locationId, job.contactId, { types: ["call_summary"], limit: 50 }).catch(() => []) || [];
  if (seen.some((e) => e.dedupeKey === dedupeKey)) { job.status = "done"; job.skipped = "this call was already read"; job.finishedAt = iso(); return; }

  job.phase = "waiting for the transcript";
  let transcript = null;
  for (let i = 0; i < maxPolls; i++) {
    transcript = await read(call.id);
    if (transcript) break;
    job.polls++;
    if (i < maxPolls - 1) await sleep(pollMs);
  }
  if (!transcript) {
    await recordEvent({ store, locationId, contactId: job.contactId, type: "call_summary", at: call.at, source: "call", ref: call.id, dedupeKey,
      data: { direction: call.direction, durationSec: call.durationSec, summary: "(call, no transcript available)", transcribed: false } });
    job.status = "done"; job.skipped = "no transcript from GHL — is call transcription on for this number?"; job.finishedAt = iso(); return;
  }
  job.transcriptChars = transcript.length;
  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    await recordEvent({ store, locationId, contactId: job.contactId, type: "call_summary", at: call.at, source: "call", ref: call.id, dedupeKey,
      data: { direction: call.direction, durationSec: call.durationSec, summary: transcript, transcribed: true, tooShort: true } });
    job.status = "done"; job.skipped = "too short to be a conversation"; job.finishedAt = iso(); return;
  }

  job.phase = "reading";
  const r = await startReply({
    client, locationId, saved, store, contactId: job.contactId, message: transcript, channel: "sms", sendsEnabled, deps,
    inboundKind: "call", call: { messageId: call.id, direction: call.direction, at: call.at, durationSec: call.durationSec, dedupeKey, transcript },
  });
  if (r.skipped) { job.skipped = r.skipped; }
  else job.replyJobId = r.job?.id || null;
  job.status = "done"; job.phase = ""; job.finishedAt = iso();
}

/* ---------- the poller: no GHL trigger needed ---------- */

export const CALLS_CURSOR = "calls";
export const CALL_SWEEP_LOOKBACK_MS = 24 * 3600000;
export const MAX_CALLS_PER_SWEEP = 20;

/**
 * findNewCalls({ client, locationId, sinceMs, now }) → [{ contactId, id, direction, at, durationSec }]
 *
 * Conversations that moved since `sinceMs`, newest first, and every call
 * message in them newer than that. One search plus one message page per
 * conversation that changed — a handful of requests a tick.
 */
export async function findNewCalls({ client, locationId, sinceMs, now = Date.now(), limit = MAX_CALLS_PER_SWEEP }) {
  const { conversations } = await searchConversations(client, locationId, { limit: 50 });
  const out = [];
  for (const convo of conversations) {
    const moved = Date.parse(convo.lastMessageDate || convo.dateUpdated || "") || 0;
    if (moved && moved <= sinceMs) continue;
    const lastType = String(convo.lastMessageType || "");
    // A conversation whose newest message is a text may still hold a call
    // behind it; only skip when GHL says nothing moved.
    const r = await listConversationMessages(client, convo.id, { limit: 30 }).catch(() => ({ messages: [] }));
    for (const m of r.messages) {
      if (!isCall(m)) continue;
      const at = Date.parse(m.dateAdded || "") || 0;
      if (at <= sinceMs || now - at > CALL_SWEEP_LOOKBACK_MS) continue;
      out.push({ contactId: convo.contactId || m.contactId, id: m.id || m.messageId, direction: String(m.direction || "").toLowerCase() === "inbound" ? "inbound" : "outbound",
        at: iso(at), durationSec: Number(m.meta?.call?.duration ?? m.callDuration ?? m.duration) || 0, lastType });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * maybeSweepCalls({ client, locationId, saved, store, sendsEnabled, deps, now }) → number started
 *
 * The tick's call. Runs when the Conversation AI is on and `callIntake` is
 * switched on in its config; remembers the newest call it saw in
 * job_cursors so each call is picked up once. A GHL workflow is not needed
 * — but if one is wired too, the per-call dedupe makes the second arrival
 * a no-op.
 */
export async function maybeSweepCalls({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now(), log = () => {} }) {
  const cai = saved?.conversationAi || {};
  if (cai.enabled === false || cai.callIntake?.enabled === false) return 0;
  if (!String(saved?.aiApiKey || "").trim()) return 0;
  const cursor = await store.getJobCursor?.(locationId, CALLS_CURSOR).catch(() => null);
  const sinceMs = cursor?.at ? Date.parse(cursor.at) : now - 2 * 3600000;   // first run: the last two hours only
  let calls;
  try { calls = await (deps.findNewCalls || findNewCalls)({ client, locationId, sinceMs, now }); }
  catch (e) {
    if (e?.status === 401 || e?.status === 403) log(`call sweep ${locationId}: the token lacks conversations.readonly`);
    else log(`call sweep ${locationId}: ${e?.message}`);
    return 0;
  }
  let started = 0;
  let newest = sinceMs;
  for (const c of calls) {
    newest = Math.max(newest, Date.parse(c.at) || 0);
    if (!c.contactId) continue;
    const r = await startCallIntake({ client, locationId, saved, store, contactId: c.contactId, messageId: c.id, direction: c.direction, sendsEnabled, deps, now });
    if (!r.skipped) started++;
  }
  // The cursor moves to the newest call seen (or now when nothing was), so
  // a transcript that lags is still found by its own job, not by re-reading.
  await store.setJobCursor?.(locationId, CALLS_CURSOR, { at: iso(calls.length ? newest : now), doc: { found: calls.length, started } }).catch(() => {});
  if (calls.length) log(`call sweep ${locationId}: ${calls.length} call(s), ${started} read`);
  return started;
}
