// investor-thread.js — every message an investor and we have exchanged, read
// whole out of GHL: every conversation, every page, every call transcript,
// the investor's own words out of an email thread. What the investor read
// (investor-read.js) is built from.
//
// enrich.js buildTranscript is a prompt-sized digest (5 conversations, 400
// messages, 60k characters, calls cut at 4,000). This is the full record, so
// a quote can be checked against what they really wrote.
//
// GHL throttles a scan of a few hundred threads (2026-10-29: 4-way, no retry,
// 1,524 of 2,058 threw 429 and the scan looked finished). Every request here
// retries 429 / 5xx / a dropped connection with backoff, and a thread that
// still fails says so (`failed`) instead of reading as an empty one.

import {
  searchConversations as ghlSearchConversations,
  listConversationMessages as ghlListMessages,
  getMessageTranscription as ghlTranscription,
  messageWords as ghlMessageWords,
} from "./ghl.js";

const MAX_CONVERSATIONS = 20;
const MAX_PAGES = 60; // 6,000 messages in one conversation: a runaway, not a thread
const OUR_EMAIL_CHARS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const retryable = (err) => {
  const s = Number(err?.status);
  if (s === 429 || s >= 500) return true;
  // fetch threw (timeout, reset): no status at all
  return !s && /fetch failed|timeout|aborted|ECONNRESET|socket|network/i.test(String(err?.message || err?.name || ""));
};

export async function withRetry(fn, { tries = 6, baseMs = 1500, wait = sleep } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (!retryable(err) || i === tries - 1) throw err;
      await wait(baseMs * 2 ** i + Math.floor(Math.random() * 400));
    }
  }
  throw last;
}

const stripHtml = (s) =>
  String(s || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<(?:br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n").trim();

export function channelOf(m) {
  const t = String(m?.messageType || m?.type || "").toUpperCase();
  if (t.includes("ACTIVITY") || t.includes("OPPORTUNITY") || t.includes("REVIEW")) return null;
  if (t.includes("VOICEMAIL")) return "voicemail";
  if (t.includes("CALL")) return "call";
  if (t.includes("SMS")) return "sms";
  if (t.includes("EMAIL")) return "email";
  if (/FACEBOOK|INSTAGRAM|WHATSAPP|GMB|LIVE_CHAT|WEBCHAT/.test(t)) return "chat";
  return null;
}

// GHL's transcription rows, in order, merged into speaker turns.
export function transcriptTurns(sentences = []) {
  const turns = [];
  for (const s of [...sentences].sort((a, b) => (a.sentenceIndex || 0) - (b.sentenceIndex || 0))) {
    const text = String(s?.transcript || "").trim();
    if (!text) continue;
    const speaker = String(s.mediaChannel ?? "?");
    const prev = turns[turns.length - 1];
    if (prev && prev.speaker === speaker) prev.text = `${prev.text} ${text}`;
    else turns.push({ speaker, text });
  }
  return turns;
}

const callSeconds = (m) => {
  const meta = m?.meta?.call || m?.meta || {};
  const n = Number(meta.duration ?? m?.duration);
  return Number.isFinite(n) ? n : null;
};

/**
 * readInvestorThread(client, locationId, contactId, { deps, transcripts }) →
 *   { contactId, messages: [{ id, at, dir, channel, body, secs?, status?, turns? }], stats }
 *
 * Oldest first. `dir` is "them" or "us". A call carries `turns` when GHL has
 * a transcription. Their email is the newest email of theirs in the thread,
 * above the quoted history (ghl.js messageWords); ours is cut to a paragraph
 * of context. Throws only when the first read fails; a page or transcript
 * that fails after retries is counted in `stats.failures` and the rest of the
 * thread is still returned.
 */
export async function readInvestorThread(client, locationId, contactId, { deps = {}, transcripts = true } = {}) {
  const search = deps.searchConversations || ghlSearchConversations;
  const list = deps.listConversationMessages || ghlListMessages;
  const transcribe = deps.getMessageTranscription || ghlTranscription;
  const words = deps.messageWords || ghlMessageWords;
  const retry = (fn) => withRetry(fn, deps.retry || {});

  const stats = { conversations: 0, messages: 0, theirs: 0, calls: 0, callsTranscribed: 0, failures: 0, failedWith: {} };
  const failed = (err, where) => {
    stats.failures++;
    const k = `${where}:${err?.status || "error"}`;
    stats.failedWith[k] = (stats.failedWith[k] || 0) + 1;
  };
  const { conversations } = await retry(() => search(client, locationId, { contactId, limit: MAX_CONVERSATIONS }));
  const out = [];
  const seen = new Set();
  for (const convo of conversations.slice(0, MAX_CONVERSATIONS)) {
    stats.conversations++;
    let lastMessageId;
    for (let page = 0; page < MAX_PAGES; page++) {
      let r;
      try { r = await retry(() => list(client, convo.id, { lastMessageId, limit: 100 })); }
      catch (err) { failed(err, "page"); break; }
      for (const m of r.messages || []) {
        const id = m.id || m.messageId || null;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const channel = channelOf(m);
        if (!channel) continue;
        const at = new Date(m.dateAdded || 0);
        if (Number.isNaN(at.getTime()) || at.getTime() <= 0) continue;
        const dir = String(m.direction || "").toLowerCase() === "inbound" ? "them" : "us";
        const row = { id, at: at.toISOString(), dir, channel, body: "" };
        if (channel === "call" || channel === "voicemail") {
          row.secs = callSeconds(m);
          row.status = String(m?.meta?.call?.status || m.status || "").toLowerCase() || null;
          row.body = String(m.body || "").trim();
          stats.calls++;
        } else if (channel === "email") {
          if (dir === "them") {
            try { row.body = await retry(() => words(client, m)); }
            catch (err) { failed(err, "email"); row.body = stripHtml(m.body); }
          } else {
            row.body = stripHtml(m.body).slice(0, OUR_EMAIL_CHARS);
          }
        } else {
          row.body = String(m.body || "").trim();
        }
        if (!row.body && channel !== "call" && channel !== "voicemail") continue;
        out.push(row);
      }
      if (!r.nextPage || !r.lastMessageId) break;
      lastMessageId = r.lastMessageId;
    }
  }

  if (transcripts) {
    for (const row of out) {
      if ((row.channel !== "call" && row.channel !== "voicemail") || !row.id) continue;
      try {
        const turns = transcriptTurns(await retry(() => transcribe(client, locationId, row.id)));
        if (turns.length) { row.turns = turns; stats.callsTranscribed++; }
      } catch (err) {
        if (err?.status === 400 || err?.status === 404 || err?.status === 422) continue; // no recording / not transcribed (GHL answers 400 for some)
        if (err?.status === 401 || err?.status === 403) { stats.transcriptsUnavailable = true; break; }
        failed(err, "transcript");
      }
    }
  }

  out.sort((a, b) => a.at.localeCompare(b.at));
  stats.messages = out.length;
  stats.theirs = out.filter((m) => m.dir === "them" && m.channel !== "call" && m.channel !== "voicemail").length;
  return { contactId, messages: out, stats };
}
