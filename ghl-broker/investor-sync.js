// investor-sync.js — the buyer book re-read from GHL once a night.
//
// The Dispositions list is a cache of every contact with a buyer tag. What an
// investor tells us reaches their row as soon as it's filed (investor-row.js);
// this is the backstop for everything else: new buyers, tags added or
// removed in GHL, fields edited there by hand. Until 2026-09-23 the only
// refresh was the Sync button, and the book went ten days without one.
//
// Read-only against GHL; the work is routes/dispo.js `syncBook`, the same
// function the button calls. Off until dispoAutopilot.bookSync.enabled; runs
// in its Pacific hour (4am by default, ahead of the 11am pulse check, which
// picks from this book), every day.
//
// Gating is conversation-audit.js's: the cursor is written before the run, a
// run that died is retried once it is stale, and the night's tries are capped.

import { store as defaultStore } from "./store.js";
import { workHour } from "./outreach-sweep.js";
import { recordError } from "./app-errors.js";

export const CURSOR_NAME = "investorBookSync";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const RETRY_WINDOW_HOURS = 5;
export const RETRY_GAP_MS = 20 * 60 * 1000;
export const MAX_DAILY_TRIES = 3;
// A full walk scans every buyer's conversation that moved; give it room.
export const STALE_RUN_MS = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const jobs = new Map();
export const getBookSyncJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }

export function normalizeBookSync(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const hour = Math.round(Number(o.hour));
  return {
    enabled: o.enabled === true,
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 4,
  };
}
export const bookSyncSettings = (saved = {}) => normalizeBookSync(saved?.dispoAutopilot?.bookSync);

/**
 * startBookSync({ client, locationId, store, deps: { syncBook }, trigger, now }) → job
 */
export function startBookSync({ client, locationId, store = defaultStore, deps = {}, trigger = "daily", now = Date.now() }) {
  if (jobs.get(locationId)?.status === "running") throw Object.assign(new Error("a book sync is already going"), { http: 409 });
  const job = { id: `bs-${Date.now().toString(36)}`, locationId, trigger, status: "running", startedAt: iso(now), finishedAt: null, result: null, error: null };
  jobs.set(locationId, job);
  const finish = async (patch) => {
    Object.assign(job, patch, { finishedAt: new Date().toISOString() });
    const r = job.result || {};
    const last = {
      id: job.id, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
      synced: r.synced ?? null, created: r.created ?? null, removed: r.removed ?? null, truncated: r.truncated ?? null,
      warnings: (r.warnings || []).slice(0, 3),
    };
    const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
    const { run: _run, ...doc } = cursor?.doc || {};
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: cursor?.at || iso(now), doc: { ...doc, last, failed: job.status === "error" } }).catch(() => {});
  };
  (async () => {
    if (typeof deps.syncBook !== "function") throw new Error("no syncBook");
    const result = await deps.syncBook({ locationId, client });
    await finish({ status: "done", result });
  })().catch(async (e) => {
    await recordError(store, { locationId, area: "investor-sync", err: e });
    await finish({ status: "error", error: String(e?.message || e).slice(0, 300) });
  });
  return job;
}

/**
 * maybeRunBookSync({ client, locationId, saved, store, deps, now }) → boolean
 *
 * Off the 15-minute tick. Fires in its Pacific hour; a failed or vanished
 * run comes back up to three times that night.
 */
export async function maybeRunBookSync({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() }) {
  const s = bookSyncSettings(saved);
  if (!s.enabled) return false;
  const h = workHour(now);
  if (h < s.hour || h >= s.hour + RETRY_WINDOW_HOURS) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const doc = cursor?.doc || {};
  const dailyAt = doc.lastDaily ? Date.parse(doc.lastDaily) : null;
  const ranToday = dailyAt != null && now - dailyAt < MIN_GAP_MS;
  const stale = doc.run?.startedAt && now - Date.parse(doc.run.startedAt) > STALE_RUN_MS;
  let tries = 1;
  if (ranToday) {
    const triedSoFar = Number(doc.tries) || 1;
    if (!(doc.failed || stale) || triedSoFar >= MAX_DAILY_TRIES || now - dailyAt < RETRY_GAP_MS) return false;
    tries = triedSoFar + 1;
  } else if (h !== s.hour) {
    return false;
  }
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { tries, lastDaily: iso(now), run: { startedAt: iso(now) }, last: doc.last || null } }).catch(() => {});
  startBookSync({ client, locationId, store, deps, trigger: "daily", now });
  return true;
}
