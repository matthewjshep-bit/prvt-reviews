// last-word.js — the cold ladder's last text, once, to agents who already
// had the old ladder (Matt, 2026-11-24).
//
// "Some agents we've just been blasting with no reply, and the ones with no
// reply are only going to flag the 'any fixers' kind of messaging... be like
// hey sorry I've been reaching out so much, do you work with investors or
// not, happy to take off list if not." The 11-23 audit found ~790 agents with
// three or more of our texts and never a word back. The ladder now ends on
// that text (shared/outreach-opener.js COLD_LAST_RUNG_TEXTS); this sends it,
// once, to the agents whose ladder ran before it did.
//
// Matt hands over the list (POST /api/outreach/last-word). Each workday
// inside the machine's hours, the 15-minute tick takes the next few off the
// queue, up to `perDay`, and starts each exactly the way the follow-up sweep
// starts a rung: the claim first (a follow_up_sent event filed at
// LAST_WORD_STEP, so the ladder counts it as a repeat already sent), then
// startProactive, which brings every guard the machine has (Stop on the bot,
// a dead number, an opt-out, one voice at a time, the lane breaker, the
// day's spread). Someone who wrote back since the list was made is skipped.
// Their "no" to it is their opt-out (reply-agent.js lastSentIsLastWord).
//
// Durable state in job_cursors ("lastWord"): the queue, today's count, the
// totals, and the last 50 results by contact id (never a name or a text).

import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { conversationConfig, startProactive } from "./reply-agent.js";
import { followUpDedupeKey } from "./shared/follow-up.js";
import { LAST_WORD_STEP } from "./shared/outreach-opener.js";
import { worksOn, machineDays, pacificParts, isOffDay } from "./shared/follow-up-engine.js";
import { workHour } from "./outreach-sweep.js";

export const LAST_WORD_CURSOR = "lastWord";
export const LAST_WORD_DEFAULT_PER_DAY = 160;
export const LAST_WORD_MAX_QUEUE = 2000;
// A few per tick, so a day's share is drafted across the morning and the
// draft's own spread puts each in the machine's hours.
export const LAST_WORD_PER_TICK = 25;
export const LAST_WORD_START_HOUR = 9;
export const LAST_WORD_END_HOUR = 15;
const INBOUND_TYPES = new Set(["text_summary", "call_summary", "inbound_received"]);
const running = new Set();
const iso = (t) => new Date(t).toISOString();
const ptDay = (now) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(now));

/** clampPerDay(n) → a whole number of texts a workday, 10 to 400. */
export function clampPerDay(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(400, Math.max(10, v)) : LAST_WORD_DEFAULT_PER_DAY;
}

/** queueLastWord(doc, contactIds, { perDay }) → { doc, added } — new ids only, never one already queued or done. */
export function queueLastWord(doc = {}, contactIds = [], { perDay, notBefore } = {}) {
  const queue = Array.isArray(doc.queue) ? [...doc.queue] : [];
  const seen = new Set([...queue, ...(Array.isArray(doc.done) ? doc.done : [])]);
  let added = 0;
  for (const raw of contactIds || []) {
    const id = String(raw || "").trim();
    if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id) || seen.has(id) || queue.length >= LAST_WORD_MAX_QUEUE) continue;
    queue.push(id); seen.add(id); added++;
  }
  // The first Pacific day it may send ("2026-11-30"), so a list handed over
  // on a busy day can wait for a quiet one.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(notBefore || "")) ? String(notBefore) : doc.notBefore || null;
  return { doc: { ...doc, queue, perDay: perDay != null ? clampPerDay(perDay) : clampPerDay(doc.perDay), ...(day ? { notBefore: day } : {}) }, added };
}

/** lastWordSkip(events) → why this contact gets nothing now, or "". */
export function lastWordSkip(events = []) {
  if ((events || []).some((e) => INBOUND_TYPES.has(e?.type))) return "they've written back";
  if ((events || []).some((e) => e?.type === "follow_up_sent" && e.data?.kind === "outreach_nudge" && e.data?.lastWord)) return "they had it already";
  return "";
}

/**
 * maybeRunLastWord({ client, locationId, saved, store, sendsEnabled, deps, now }) → { ran, started, skipped } | null
 *
 * Nothing queued, a weekend, a day off, outside 9am–3pm Pacific, the
 * Conversation AI off, today's share done, or a run already going: null.
 */
export async function maybeRunLastWord({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const cursor = await store.getJobCursor?.(locationId, LAST_WORD_CURSOR).catch(() => null);
  const doc = cursor?.doc || {};
  if (!Array.isArray(doc.queue) || !doc.queue.length) return null;
  const config = conversationConfig(saved);
  if (!config.enabled) return null;
  const h = workHour(now);
  if (h < LAST_WORD_START_HOUR || h >= LAST_WORD_END_HOUR) return null;
  if (!worksOn(pacificParts(now).wd, machineDays(config.autoSend?.weekends))) return null;
  if (isOffDay(now, config.autoSend?.offDays)) return null;
  if (running.has(locationId)) return null;
  const today = ptDay(now);
  if (doc.notBefore && today < doc.notBefore) return null;
  const doneToday = doc.day === today ? Number(doc.doneToday) || 0 : 0;
  const perDay = clampPerDay(doc.perDay);
  const take = Math.min(LAST_WORD_PER_TICK, perDay - doneToday, doc.queue.length);
  if (take <= 0) return null;

  // The cursor first: the batch leaves the queue before anything is sent, so
  // a run a deploy kills never sends one twice (the claim below is the other
  // half: a contact claimed once is never started again).
  const batch = doc.queue.slice(0, take);
  const claimed = { ...doc, queue: doc.queue.slice(take), day: today, doneToday: doneToday + take, runAt: iso(now) };
  await store.setJobCursor(locationId, LAST_WORD_CURSOR, { at: iso(now), doc: claimed });

  running.add(locationId);
  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;
  const ladder = config.parties?.agent?.followUp?.ladders?.outreach_nudge || {};
  const results = [];
  try {
    for (const contactId of batch) {
      try {
        const events = await store.listContactEvents(locationId, contactId, { limit: 300 }).catch(() => []);
        const why = lastWordSkip(events);
        if (why) { results.push({ contactId, status: "skipped", reason: why }); continue; }
        const claim = await recordEvent({
          store, locationId, contactId, party: "agent", type: "follow_up_sent", at: iso(now), source: "conversation",
          ref: `outreach_nudge:${contactId}:${LAST_WORD_STEP}`,
          dedupeKey: followUpDedupeKey({ kind: "outreach_nudge", subjectId: contactId, step: LAST_WORD_STEP }),
          data: { kind: "outreach_nudge", step: LAST_WORD_STEP, lastWord: true, ladder: ladder.steps || [] },
        });
        if (!claim?.inserted) { results.push({ contactId, status: "skipped", reason: "already claimed" }); continue; }
        const opened = (events || []).filter((e) => e?.type === "outreach_sent" || e?.type === "outreach_enrolled").at(-1);
        const r = await start({
          client, locationId, saved, store, contactId, kind: "outreach_nudge", offer: null,
          subject: { address: opened?.address || "", step: LAST_WORD_STEP, steps: ladder.steps?.length ? ladder.steps : [2],
            repeatEvery: Number(ladder.repeatEvery) > 0 ? Number(ladder.repeatEvery) : 14, lastWord: true },
          sendsEnabled, deps,
        });
        if (r?.skipped) results.push({ contactId, status: "skipped", reason: String(r.skipped).slice(0, 160) });
        else results.push({ contactId, status: "started", jobId: r?.job?.id || null });
      } catch (e) {
        results.push({ contactId, status: "error", reason: String(e?.message || e).slice(0, 160) });
      }
    }
  } finally {
    running.delete(locationId);
  }
  const started = results.filter((r) => r.status === "started").length;
  const skipped = results.length - started;
  const after = (await store.getJobCursor?.(locationId, LAST_WORD_CURSOR).catch(() => null))?.doc || claimed;
  await store.setJobCursor(locationId, LAST_WORD_CURSOR, { at: iso(Date.now()), doc: {
    ...after,
    done: [...(Array.isArray(after.done) ? after.done : []), ...batch].slice(-LAST_WORD_MAX_QUEUE),
    started: (Number(after.started) || 0) + started,
    skipped: (Number(after.skipped) || 0) + skipped,
    last: [...results, ...(Array.isArray(after.last) ? after.last : [])].slice(0, 50),
  } });
  return { ran: true, started, skipped };
}

/** lastWordStatus(doc) → counts only, for the route. */
export function lastWordStatus(doc = {}) {
  return {
    queued: Array.isArray(doc.queue) ? doc.queue.length : 0,
    perDay: clampPerDay(doc.perDay),
    notBefore: doc.notBefore || null, today: doc.day || null, doneToday: Number(doc.doneToday) || 0,
    started: Number(doc.started) || 0, skipped: Number(doc.skipped) || 0,
    last: (Array.isArray(doc.last) ? doc.last : []).slice(0, 20),
  };
}
