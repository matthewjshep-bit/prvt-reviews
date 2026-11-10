// daily-gate.js — a job that runs once a day, and comes back if a deploy
// killed it.
//
// The nightly audit's gating (conversation-audit.js maybeRunConversationAudit),
// shared. Every push to main redeploys the broker, and the in-memory job
// registries go with it. A daily job that stamped its cursor and then died
// used to lose the day: the cursor said "ran", nothing was running, and the
// next chance was tomorrow. Now:
//
//   - the cursor is written BEFORE the run, with `run` on it while it goes;
//   - a run the cursor says is going, with nothing in memory behind it for
//     STALE_RUN_MS, is retried as if it had failed;
//   - a failed run is retried, at most MAX_DAILY_TRIES a day, RETRY_GAP_MS
//     apart, inside the job's window;
//   - a new day may start anywhere in the window — a deploy across the start
//     hour no longer skips it;
//   - "ran today" is the Pacific calendar date (2026-11-09), not "under 20
//     hours ago": a run retried at 2:30pm used to keep the next morning's
//     run from starting, and a long window (the tier check's 7am to 8pm)
//     pushed the next day into the afternoon.
//
// The caller passes the hour in the job's own clock (UTC for some, Pacific
// for others). The day is Pacific, where the business is; a UTC job whose
// window runs over midnight Pacific is still one run (ranThisDay).

import { pacificParts } from "./shared/follow-up-engine.js";

export const RETRY_GAP_MS = 20 * 60 * 1000;
export const STALE_RUN_MS = 45 * 60 * 1000;
export const MAX_DAILY_TRIES = 4;
// No longer how "ran today" is decided (see ranThisDay). Kept for callers
// that still pass `minGapMs`, which is ignored.
export const MIN_GAP_MS = 20 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

const iso = (ms) => new Date(ms).toISOString();

/** pacificDay(t) → "2026-11-09": the calendar date in Pacific time. */
export function pacificDay(t) {
  const p = pacificParts(t);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/**
 * ranThisDay({ dailyAt, now, hourNow, startHour }) → boolean
 *
 * The day's run has already started: `dailyAt` (when it was claimed) is the
 * same Pacific date as `now`, or, for a window on the UTC clock that runs
 * over midnight Pacific, falls inside the window that is open now.
 */
export function ranThisDay({ dailyAt, now = Date.now(), hourNow = null, startHour = null }) {
  if (dailyAt == null || !Number.isFinite(dailyAt)) return false;
  if (pacificDay(dailyAt) === pacificDay(now)) return true;
  if (hourNow == null || startHour == null || !(hourNow >= startHour)) return false;
  const windowOpened = now - (now % HOUR_MS) - (hourNow - startHour) * HOUR_MS;
  return dailyAt >= windowOpened;
}

/**
 * claimDailyRun({ store, locationId, cursorName, now, hourNow, startHour, windowHours, running })
 *   → { go, tries, retry }
 *
 * `running`: whether this broker has the job going in memory right now.
 */
export async function claimDailyRun({
  store, locationId, cursorName, now = Date.now(), hourNow, startHour, windowHours = 3, running = false,
  maxTries = MAX_DAILY_TRIES, retryGapMs = RETRY_GAP_MS, staleRunMs = STALE_RUN_MS,
}) {
  if (!(hourNow >= startHour && hourNow < startHour + windowHours)) return { go: false };
  if (running) return { go: false };
  const cursor = await store.getJobCursor?.(locationId, cursorName).catch(() => null);
  const doc = cursor?.doc || {};
  // A cursor written before this gate existed has only `at`: that IS the day's run.
  const dailyAt = doc.lastDaily ? Date.parse(doc.lastDaily) : (cursor?.at ? Date.parse(cursor.at) : null);
  const ranToday = ranThisDay({ dailyAt, now, hourNow, startHour });
  const stale = Boolean(doc.run?.startedAt) && now - Date.parse(doc.run.startedAt) > staleRunMs;
  let tries = 1;
  if (ranToday) {
    const triedSoFar = Number(doc.tries) || 1;
    if (!(doc.failed || stale) || triedSoFar >= maxTries || now - dailyAt < retryGapMs) return { go: false };
    tries = triedSoFar + 1;
  }
  const { run: _run, failed: _failed, error: _error, ...keep } = doc;
  await store.setJobCursor?.(locationId, cursorName, {
    at: iso(now),
    doc: { ...keep, tries, lastDaily: iso(now), run: { startedAt: iso(now) }, last: doc.last || null, ...(stale ? { staleRun: doc.run } : {}) },
  }).catch(() => {});
  return { go: true, tries, retry: tries > 1 };
}

/**
 * closeDailyRun({ store, locationId, cursorName, last, failed, error })
 *
 * The run is over: `run` comes off the cursor, `last` says what it did, and
 * `failed` asks for a retry inside the window.
 */
export async function closeDailyRun({ store, locationId, cursorName, last = null, failed = false, error = null }) {
  const cursor = await store.getJobCursor?.(locationId, cursorName).catch(() => null);
  const { run: _run, ...doc } = cursor?.doc || {};
  await store.setJobCursor?.(locationId, cursorName, {
    at: cursor?.at || iso(Date.now()),
    doc: { ...doc, last, failed: Boolean(failed), error: error ? String(error).slice(0, 300) : null },
  }).catch(() => {});
}
