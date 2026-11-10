// boot.js — the broker's own start and stop (2026-11-09).
//
// The 11-09 crash was found by an audit script: a restart that wasn't a
// deploy wrote nothing and posted nothing, GET / printed only the commit, a
// failed schema migration was a log line, the 15-minute tick could run over
// itself, and a deploy killed whatever text was halfway out. The pieces here
// are what broker.js wires at boot; each takes its store and timers so a
// test can drive it without starting a server.
//
//   recordBoot     the brokerBoot cursor: a start on the same commit is a
//                  crash or a manual restart, and #machine hears it once
//                  through the job-failed path (shared/line.js LINE_JOBS)
//   sampleMemory   the broker's memory on that cursor every five minutes,
//                  so the restart line can say what it was before it died
//   reportSchema   a failed migration recorded under db:migrate (app_errors),
//                  which #machine also hears
//   rootText       GET /: the commit, the store and the schema
//   guarded        a loop that never starts while its last run is going
//   makeShutdown   SIGTERM: stop the timers, let the sends under way finish
//                  (up to 25 seconds), then exit

import { recordError } from "./app-errors.js";

export const BOOT_CURSOR = "brokerBoot";
export const RESTART_NOTE = "restarted without a deploy (manual or crash)";
// A crash loop is one line in #machine an hour, not one a minute: inside
// this window a restart updates the count on the line already posted.
export const RESTART_QUIET_MS = 60 * 60 * 1000;
export const BOOT_TICK_DELAY_MS = 90 * 1000;
// How long a loop's run may go before the next one starts beside it anyway:
// three ticks, or ten passes of the send loop.
export const TICK_STUCK_MS = 45 * 60 * 1000;
export const SEND_LOOP_STUCK_MS = 5 * 60 * 1000;
export const MEMORY_SAMPLE_MS = 5 * 60 * 1000;
// Render waits 30 seconds after SIGTERM before it kills the process.
export const DRAIN_MS = 25 * 1000;

const iso = (t) => new Date(t).toISOString();
const MB = 1024 * 1024;

/** restartNote({ rss, restarts, now }) → the line #machine and the Line page show. */
export function restartNote({ rss = null, restarts = 1, now = Date.now() } = {}) {
  const parts = [RESTART_NOTE];
  const t = Date.parse(rss?.at || "");
  if (Number(rss?.mb) > 0 && Number.isFinite(t)) {
    const mins = Math.max(0, Math.round((now - t) / 60000));
    parts.push(`memory was ${Math.round(rss.mb)} MB ${mins} min before${Number(rss.peakMb) > Number(rss.mb) ? ` (peak ${Math.round(rss.peakMb)} MB)` : ""}`);
  }
  if (restarts > 1) parts.push(`${restarts} restarts in the last hour`);
  return parts.join("; ");
}

/**
 * recordBoot({ store, locationIds, commit, now }) → [{ locationId, restarted }]
 *
 * One cursor per location (job_cursors is per location, and so is Slack).
 * A start on the commit the last start had is a restart nobody deployed:
 * `last.status` "error", which shared/line.js lineJobs reads as failed and
 * slack-notify.js posts to #machine once per `last.at`. A new commit is a
 * deploy: "ok". With no commit (local dev) or no earlier start on record,
 * nothing is said.
 */
export async function recordBoot({ store, locationIds = [], commit = "", now = Date.now() } = {}) {
  const at = iso(now);
  const sha = String(commit || "").trim();
  const out = [];
  for (const locationId of locationIds) {
    try {
      const cur = await store.getJobCursor(locationId, BOOT_CURSOR);
      const doc = cur?.doc || {};
      const prev = String(doc.commit || "");
      const restarted = Boolean(sha && prev && prev === sha);
      let last = { at, finishedAt: at, status: "ok", error: null };
      let restarts = 0;
      if (restarted) {
        const alertedAt = doc.last?.status === "error" ? Date.parse(doc.last.at || "") : NaN;
        const quiet = Number.isFinite(alertedAt) && now - alertedAt < RESTART_QUIET_MS;
        restarts = quiet ? (Number(doc.restarts) || 1) + 1 : 1;
        // Inside the quiet hour `last.at` stays put, so the Slack claim on it
        // stays spent and only the count on the line moves.
        last = quiet
          ? { ...doc.last, error: restartNote({ rss: doc.rss, restarts, now }) }
          : { at, finishedAt: at, status: "error", error: restartNote({ rss: doc.rss, now }) };
      }
      const next = {
        commit: sha || prev || null, bootAt: at, deployedAt: restarted ? doc.deployedAt || null : at,
        restarts, last, rss: null, rssBefore: doc.rss || null,
      };
      await store.setJobCursor(locationId, BOOT_CURSOR, { at, doc: next });
      out.push({ locationId, restarted });
    } catch (e) {
      out.push({ locationId, restarted: false, error: String(e?.message || e).slice(0, 160) });
    }
  }
  return out;
}

/**
 * sampleMemory({ store, locationIds, bootAt, now, rss }) → MB written
 *
 * The broker's resident memory on its boot cursor, with the peak since this
 * start. Left alone when a newer broker has started since (a deploy's old
 * broker must not write its numbers over the new one's).
 */
export async function sampleMemory({ store, locationIds = [], bootAt, now = Date.now(), rss = process.memoryUsage().rss } = {}) {
  const mb = Math.round(Number(rss) / MB);
  for (const locationId of locationIds) {
    try {
      const cur = await store.getJobCursor(locationId, BOOT_CURSOR);
      const doc = cur?.doc || {};
      if (doc.bootAt && doc.bootAt !== iso(bootAt)) continue;
      const peakMb = Math.max(mb, Number(doc.rss?.peakMb) || 0);
      await store.setJobCursor(locationId, BOOT_CURSOR, { at: cur?.at || iso(bootAt), doc: { ...doc, rss: { at: iso(now), mb, peakMb } } });
    } catch { /* a missed sample is a missed sample */ }
  }
  return mb;
}

/**
 * reportSchema({ store, locationIds, result, now }) → rows recorded
 *
 * A migration that failed goes to app_errors under db:migrate, scrubbed like
 * every other error (the message is the database's, about the schema).
 */
export async function reportSchema({ store, locationIds = [], result = null, now = Date.now() } = {}) {
  if (!result || result.ok !== false || result.skipped) return 0;
  let n = 0;
  for (const locationId of locationIds) {
    const row = await recordError(store, { locationId, area: "db:migrate", err: new Error(`schema migration failed: ${result.error || "unknown error"}`), now });
    if (row) n++;
  }
  return n;
}

/** rootText({ commit, backend, schema }) → GET /'s one line: the deploy check, the store, the schema. */
export function rootText({ commit = "", backend = "file", schema = "none" } = {}) {
  return `offer broker ok @ ${(String(commit || "") || "dev").slice(0, 7)} db=${backend} schema=${schema}`;
}

/** rootHandler({ commit, backend, schema }) → express handler; `schema` is db.js schemaState. */
export function rootHandler({ commit = "", backend = "file", schema = () => ({ status: "none" }) } = {}) {
  return (_req, res) => res.type("text/plain").send(rootText({ commit, backend, schema: schema()?.status || "none" }));
}

/**
 * guarded(run, { name, log, staleMs, now }) → fn
 *
 * The loop's body, run at most once at a time: a call while the last one is
 * still going returns { skipped: "running" } and starts nothing. The tick's
 * jobs await GHL one after another, and on a slow GHL day one tick used to
 * run into the next. A run going longer than `staleMs` is taken for stuck
 * (a call that never answers): the next call starts anyway and says so, so
 * one hung request can't stop the loop for good. `fn.idle()` resolves when
 * nothing is running.
 */
export function guarded(run, { name = "loop", log = () => {}, staleMs = Infinity, now = () => Date.now(), quietSkips = false } = {}) {
  let current = null;
  let startedAt = 0;
  const fn = async (...args) => {
    if (current) {
      const mins = Math.round((now() - startedAt) / 60000);
      if (now() - startedAt < staleMs) {
        if (!quietSkips) log(`${name}: the last run is still going; this one is skipped`);
        return { skipped: "running" };
      }
      log(`${name}: the last run has been going ${mins} min; starting a new one beside it`);
    }
    const p = Promise.resolve().then(() => run(...args));
    current = p;
    startedAt = now();
    try { return await p; } finally { if (current === p) current = null; }
  };
  fn.running = () => current !== null;
  fn.idle = () => (current ? current.then(() => {}, () => {}) : Promise.resolve());
  return fn;
}

/**
 * makeShutdown({ timers, idle, server, timeoutMs, log, exit }) → shutdown(signal)
 *
 *   timers   () => the intervals and timeouts to stop
 *   idle     [() => promise]: what to wait for (the send loop, the sends in flight)
 *
 * The first signal stops every timer and the server, then waits for `idle`
 * (at most `timeoutMs`) and exits 0. `shutdown.stopping()` is what the send
 * loop asks before it claims another text.
 */
export function makeShutdown({ timers = () => [], idle = [], server = null, timeoutMs = DRAIN_MS, log = console.log, exit = (code) => process.exit(code) } = {}) {
  let done = null;
  const shutdown = (signal = "SIGTERM") => {
    if (done) return done;
    done = (async () => {
      for (const t of (typeof timers === "function" ? timers() : timers) || []) { clearInterval(t); clearTimeout(t); }
      try { server?.close?.(); } catch { /* already closed */ }
      log(`${signal}: draining, nothing new starts`);
      let timer = null;
      let late = false;
      const waitAll = Promise.all((idle || []).map((f) => Promise.resolve().then(f).catch(() => {})));
      const cap = new Promise((r) => { timer = setTimeout(() => { late = true; r(); }, timeoutMs); });
      await Promise.race([waitAll, cap]);
      clearTimeout(timer);
      log(late ? `${signal}: stopped after ${Math.round(timeoutMs / 1000)}s with work still going` : `${signal}: drained`);
      exit(0);
    })();
    return done;
  };
  shutdown.stopping = () => done !== null;
  return shutdown;
}

/** untilIdle(count, { pollMs }) → resolves when count() is 0 (the scheduler's in-flight sends). */
export async function untilIdle(count, { pollMs = 200 } = {}) {
  while (Number(count()) > 0) await new Promise((r) => setTimeout(r, pollMs));
}
