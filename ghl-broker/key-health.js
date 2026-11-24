// key-health.js — the paid keys the machine runs on, read once a day
// (2026-11-23 audit, AH-1).
//
// The Apify token was rejected from 11-11 to 11-18: every auto-underwrite
// stopped early, new-agent outreach fell to nothing and price watch went
// quiet, and nobody knew for a week. Now, from 7am Pacific on the tick:
//
//   Apify      GET /v2/users/me (who the token is) and /v2/users/me/limits
//              (the month's usage against its limit). Both free.
//   Anthropic  the models list, one row. Free; never a completion.
//
// RentCast, Tracerfy, RealEstateAPI and Bricked have no read that isn't
// metered or a paid lookup, so they aren't checked here.
//
// Each key's verdict goes on the `keyHealth` cursor (shared/machine-health.js
// keyEntry): ok, rejected (401/402/403 — the provider said no) or no answer
// (kept, never called failing). While a key is rejected it's read again every
// hour, so a fixed key clears the same day. What to say about it is
// slack-notify.js's (#machine, @Matt, once a day while it lasts) and the
// strip's on Offers and Deals (routes/dashboard.js /machine).
//
// Off unless settings.keyHealth.enabled. Reads only: sends nothing to anyone,
// spends nothing, flips no switch.

import Anthropic from "@anthropic-ai/sdk";
import { store as defaultStore } from "./store.js";
import { recordError, scrubMessage } from "./app-errors.js";
import { workHour } from "./outreach-sweep.js";
import {
  KEY_HEALTH_CURSOR, normalizeKeyHealth, keyHealthDue, keyEntry, apifyUsage, probeVerdict, ptDay,
} from "./shared/machine-health.js";

export const CURSOR_NAME = KEY_HEALTH_CURSOR;
const APIFY = "https://api.apify.com/v2";
const PROBE_TIMEOUT_MS = 15000;
const iso = (t) => new Date(t).toISOString();
const running = new Set();
export function _resetKeyHealth() { running.clear(); }

/**
 * probeApify(token, { fetchFn }) → { ok, status, error, usage? } | { skipped }
 *
 * Who the token is, then the month's usage. The token goes in the header,
 * never the URL, and no error carries it.
 */
export async function probeApify(token, { fetchFn = globalThis.fetch } = {}) {
  const t = String(token || "").trim();
  if (!t) return { skipped: "no Apify token saved" };
  const headers = { authorization: `Bearer ${t}`, accept: "application/json" };
  try {
    const me = await fetchFn(`${APIFY}/users/me`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const ok = probeVerdict(me.status);
    if (ok !== true) return { ok, status: me.status, error: `Apify answered ${me.status}` };
    let usage = null;
    try {
      const lim = await fetchFn(`${APIFY}/users/me/limits`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (lim.ok) usage = apifyUsage(await lim.json());
    } catch { /* the usage read is a bonus; the key answered */ }
    return { ok: true, status: me.status, ...(usage ? { usage } : {}) };
  } catch (e) {
    return { ok: null, status: null, error: `no answer: ${scrubMessage(e).replace(t, "…").slice(0, 120)}` };
  }
}

/**
 * probeAnthropic(key, { listModels }) → { ok, status, error } | { skipped }
 *
 * One row of the models list: free, and it says whether the key is good.
 * `listModels(key)` is the SDK's by default; tests hand their own.
 */
export async function probeAnthropic(key, { listModels = null } = {}) {
  const k = String(key || "").trim();
  if (!k) return { skipped: "no Claude key saved" };
  const list = listModels || ((apiKey) => new Anthropic({ apiKey, maxRetries: 0, timeout: PROBE_TIMEOUT_MS }).models.list({ limit: 1 }));
  try {
    await list(k);
    return { ok: true, status: 200 };
  } catch (e) {
    const status = Number(e?.status) || null;
    return { ok: probeVerdict(status, e?.message), status, error: scrubMessage(e).replace(k, "…").slice(0, 160) };
  }
}

/**
 * runKeyHealth({ saved, deps, prev, now }) → { apify, anthropic }: each key's cursor row.
 *
 *   deps.fetch       Apify's reads (globalThis.fetch by default)
 *   deps.listModels  the Anthropic read
 */
export async function runKeyHealth({ saved = {}, deps = {}, prev = {}, now = Date.now() } = {}) {
  const [apify, anthropic] = await Promise.all([
    probeApify(saved?.apifyToken, { fetchFn: deps.fetch || globalThis.fetch }),
    probeAnthropic(saved?.aiApiKey, { listModels: deps.listModels || null }),
  ]);
  return { apify: keyEntry(prev?.apify, apify, now), anthropic: keyEntry(prev?.anthropic, anthropic, now) };
}

/**
 * maybeRunKeyHealth({ locationId, saved, store, deps, now }) → { started, keys } | null
 *
 * The tick's decision (shared/machine-health.js keyHealthDue): the cursor is
 * written before the reads, a run that died is retried, and the day's tries
 * are capped. Awaited: three GETs.
 */
export async function maybeRunKeyHealth({ locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() } = {}) {
  if (!normalizeKeyHealth(saved?.keyHealth).enabled) return null;
  if (running.has(locationId)) return null;
  const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const doc = cur?.doc || {};
  const gate = keyHealthDue(doc, { now, hourNow: workHour(now) });
  if (!gate.go) return null;
  running.add(locationId);
  try {
    await store.setJobCursor?.(locationId, CURSOR_NAME, {
      at: iso(now), doc: { ...doc, day: ptDay(now), tries: gate.tries, lastRun: iso(now), run: { startedAt: iso(now) }, failed: false, error: "", ...(gate.stale ? { staleRun: doc.run } : {}) },
    }).catch(() => {});
    try {
      const keys = await runKeyHealth({ saved, deps, prev: doc.keys || {}, now });
      const finishedAt = iso(Date.now());
      await patch(store, locationId, { keys, run: null, failed: false, error: "",
        last: { finishedAt, status: "done", rejected: Object.entries(keys).filter(([, k]) => k.ok === false).map(([name]) => name) } });
      return { started: true, keys };
    } catch (e) {
      const error = scrubMessage(e).slice(0, 200);
      await recordError(store, { locationId, area: "key-health", err: e, context: { stage: "run" } });
      await patch(store, locationId, { run: null, failed: true, error, last: { finishedAt: iso(Date.now()), status: "error", error } });
      return { started: true, error };
    }
  } finally {
    running.delete(locationId);
  }
}

async function patch(store, locationId, fields) {
  const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: cur?.at || iso(Date.now()), doc: { ...(cur?.doc || {}), ...fields } }).catch(() => {});
}
