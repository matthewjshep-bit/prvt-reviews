// outreach-sweep.js — the top of the funnel, once a day, on its own.
//
// The Agent Method's daily input is ten to twelve new listing agents. Until
// this existed that number was a person pressing Pull, reading a table, and
// pressing Import — and the first text was a GHL workflow template. This
// runs the same pull the button runs (settings defaults: zips, city, age),
// picks the best agents nobody has spoken to, imports them under the daily
// cap, and asks the Conversation AI for the first text. Nothing here sends;
// the drafts land in the outbox and leave only if outreach_open is on the
// allowlist. Two switches, as everywhere else.
//
// Same shape as the follow-up sweep: rides the broker's 15-minute tick,
// fires in one UTC hour, and writes its job_cursors row BEFORE running so a
// crash mid-sweep can't spend a second RentCast request the same day.

import { store as defaultStore } from "./store.js";

export const CURSOR_NAME = "outreach";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const OUTREACH_SWEEP_UTC_HOUR = Number(process.env.OUTREACH_SWEEP_UTC_HOUR || 15); // ≈ 7–8am Pacific
export const DEFAULT_DAILY_CAP = 12;
// Leave a few requests for the buttons: 45 of the free tier's 50.
export const RENTCAST_MONTHLY_BUDGET = 45;
const OUTREACH_IMPORTS_ENABLED = process.env.OUTREACH_IMPORTS_ENABLED === "true";

const iso = (ms) => new Date(ms).toISOString();

/**
 * normalizeOutreachAutopilot(v) → { enabled, dailyCap, firstTouch, requireDistress }
 *
 * The settings blob, coerced. `firstTouch` is who says hello: "app" (the
 * Conversation AI drafts it, no GHL trigger tag) or "ghl" (the trigger tag,
 * the workflow's template — the old way, kept for anyone not ready).
 */
export function normalizeOutreachAutopilot(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const cap = Math.round(Number(o.dailyCap));
  return {
    enabled: o.enabled === true,
    dailyCap: Number.isFinite(cap) ? Math.min(100, Math.max(1, cap)) : DEFAULT_DAILY_CAP,
    firstTouch: o.firstTouch === "ghl" ? "ghl" : "app",
    requireDistress: o.requireDistress !== false,
  };
}

/**
 * pickAgentsToImport(rows, { cap, requireDistress }) → [row]
 *
 * Who gets a text today. Only agents nobody has touched: status "new" (not
 * imported, not skipped), no existing GHL contact (a match means a thread we
 * would be talking over), and a phone. The most distressed book first —
 * that is the whole thesis of the outreach — then the biggest.
 */
export function pickAgentsToImport(rows = [], { cap = DEFAULT_DAILY_CAP, requireDistress = true } = {}) {
  const ok = rows.filter((r) => {
    const d = r?.doc || {};
    if (r.status !== "new") return false;
    if (r.contactId || d.ghl?.contactId) return false;
    if (!d.phone) return false;
    if (requireDistress && !(Number(d.distressedCount) > 0)) return false;
    return true;
  });
  ok.sort((a, b) =>
    (Number(b.doc?.distressedCount) || 0) - (Number(a.doc?.distressedCount) || 0) ||
    (Number(b.doc?.hook?.score) || 0) - (Number(a.doc?.hook?.score) || 0) ||
    (Number(b.doc?.listingCount) || 0) - (Number(a.doc?.listingCount) || 0));
  return ok.slice(0, Math.max(0, cap));
}

/* ---------- job registry (in memory, like the other sweeps) ---------- */

const jobs = new Map();
export const getOutreachJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }
export function publicOutreachJob(job) {
  if (!job) return null;
  const { ...pub } = job;
  return pub;
}

/**
 * startOutreachSweep({ locationId, client, saved, store, deps, trigger, dryRun, now }) → job
 *
 * `deps.runPull(locationId, client, body)` and `deps.importAgents({...})`
 * are the outreach router's own functions, injected so this is testable
 * with neither RentCast nor GHL.
 */
export function startOutreachSweep({ locationId, client, saved = {}, store = defaultStore, deps = {}, trigger = "manual", dryRun = false, now = Date.now() }) {
  const existing = jobs.get(locationId);
  if (existing?.status === "running") {
    throw Object.assign(new Error("an outreach sweep is already running for this location"), { http: 409 });
  }
  const job = {
    id: `oa-${Date.now().toString(36)}`, locationId, trigger, dryRun,
    status: "running", phase: "pulling", startedAt: iso(now), finishedAt: null,
    pull: null, candidates: 0, picked: 0, imported: 0, opened: 0, warnings: [], results: [], error: null,
  };
  jobs.set(locationId, job);
  run(job, { locationId, client, saved, store, deps, now }).catch((e) => {
    job.status = "error";
    job.error = String(e?.message || e).slice(0, 300);
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

async function run(job, { locationId, client, saved, store, deps, now }) {
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  if (typeof deps.runPull !== "function" || typeof deps.importAgents !== "function") {
    throw new Error("outreach sweep needs runPull and importAgents");
  }

  // 0. The RentCast meter. The free tier is 50 requests a month; a daily
  // pull that spent the last of them would leave the buttons dead too.
  job.phase = "budget";
  try {
    const pulls = await store.listOutreachPulls(locationId, { limit: 60 });
    const monthStart = new Date(now); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const used = pulls.filter((p) => new Date(p.createdAt) >= monthStart).reduce((s, p) => s + (Number(p.doc?.requestsUsed) || 0), 0);
    const budget = Number(saved.rentcastMonthlyBudget) > 0 ? Number(saved.rentcastMonthlyBudget) : RENTCAST_MONTHLY_BUDGET;
    job.budget = { used, budget };
    if (used >= budget) {
      job.warnings.push(`RentCast budget: ${used} of ${budget} requests used this month — the sweep is standing down until next month`);
      job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
      return;
    }
  } catch (e) { job.warnings.push(`budget check: ${String(e?.message || e).slice(0, 120)}`); }

  // 1. The pull, on the location's saved defaults. A cache hit is free.
  const pull = await deps.runPull(locationId, client, {});
  job.pull = { batchId: pull.batchId, batchName: pull.batchName, requestsUsed: pull.requestsUsed, cached: pull.cached,
    listingsKept: pull.listingsKept, agentsTotal: pull.agentsTotal, agentsNew: pull.agentsNew };
  job.warnings.push(...(pull.warnings || []).slice(0, 5));

  // 2. Who is new to us, and how many of them today.
  job.phase = "picking";
  const rows = await store.listOutreachAgents(locationId, { batchId: pull.batchId, status: "new", limit: 1000 });
  job.candidates = rows.length;
  const picked = pickAgentsToImport(rows, { cap: oa.dailyCap, requireDistress: oa.requireDistress });
  job.picked = picked.length;
  job.results = picked.map((r) => ({ agentKey: r.agentKey, name: r.doc?.name || "", hook: r.doc?.hook?.address || "", distressed: r.doc?.distressedCount || 0 }));
  if (!picked.length) {
    job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
    return;
  }

  // 3. The import. Dry unless the env gate is on — importAgents applies the
  // gate itself; passing dryRun through keeps a manual "show me" honest.
  job.phase = "importing";
  const r = await deps.importAgents({
    locationId, client, agentKeys: picked.map((p) => p.agentKey), batchId: pull.batchId,
    // "app": the bot says hello and the GHL trigger tag stays off, so the
    // workflow template cannot text them as well. "ghl": the old way.
    applyTag: oa.firstTouch === "ghl", openWith: oa.firstTouch === "app" ? "app" : null,
    sessionSuffix: `auto-${iso(now).slice(0, 10)}`, dryRun: job.dryRun ? true : false,
  });
  job.imported = r.imported || 0;
  job.opened = r.opened || 0;
  job.dryRun = Boolean(r.dryRun);
  job.warnings.push(...(r.warnings || []).slice(0, 10));
  const byKey = new Map((r.results || []).map((x) => [x.agentKey, x]));
  job.results = job.results.map((x) => {
    const y = byKey.get(x.agentKey) || {};
    return { ...x, ok: y.ok !== false, action: y.action || (y.dryRun ? (y.wouldCreate ? "would create" : y.wouldUpdate ? "would update" : "dry run") : ""),
      contactId: y.contactId || null, opened: y.opened || null, error: y.error || null };
  });

  job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
}

/**
 * maybeStartOutreachSweep({ locationId, client, saved, store, deps, utcHour, now }) → boolean
 *
 * The tick's decision. Gates: the hour, the toggle, a RentCast key, no run
 * in progress, and the durable cursor at least MIN_GAP_MS old.
 */
export async function maybeStartOutreachSweep({ locationId, client, saved = {}, store = defaultStore, deps = {}, utcHour = OUTREACH_SWEEP_UTC_HOUR, now = Date.now() }) {
  if (new Date(now).getUTCHours() !== utcHour) return false;
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  if (!oa.enabled) return false;
  if (!String(saved.rentcastApiKey || "").trim()) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  if (cursor?.at && now - Date.parse(cursor.at) < MIN_GAP_MS) return false;
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: {} }).catch(() => {});
  startOutreachSweep({ locationId, client, saved, store, deps, trigger: "daily", now });
  return true;
}

export const importsEnabled = () => OUTREACH_IMPORTS_ENABLED;
