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
// The hour it runs, in Pacific time (so daylight saving doesn't move it).
export const OUTREACH_SWEEP_HOUR = Number(process.env.OUTREACH_SWEEP_HOUR || 10); // 10–11am Pacific
export const DEFAULT_DAILY_CAP = 12;
// A sanity ceiling, not a business rule: one RentCast page is 500 listings,
// and the import paces GHL at two contacts at a time.
export const MAX_DAILY_CAP = 500;
// The hard stop: 48 of the free tier's 50. Past 50 RentCast does not refuse —
// it bills $0.20 a request — so this line is the only thing that stops it.
export const RENTCAST_MONTHLY_BUDGET = 48;
const OUTREACH_IMPORTS_ENABLED = process.env.OUTREACH_IMPORTS_ENABLED === "true";

const iso = (ms) => new Date(ms).toISOString();
const DAY_MS = 86400000;
export const DEFAULT_FOLLOW_UP_DAYS = 14;

// A GHL workflow id, or the builder URL it was copied from
// (".../automation/workflow/640e73d6-…"). Anything else is blank.
export function workflowIdFrom(v) {
  const s = String(v || "").trim();
  const id = s.match(/workflow\/([A-Za-z0-9-]+)/)?.[1] || s;
  return /^[A-Za-z0-9-]{6,64}$/.test(id) ? id : "";
}

// [{ county, state }] from an array, or from the settings textarea's
// "King, WA" lines (or ";"-separated). No state, no county.
export function countiesFrom(v) {
  const raw = Array.isArray(v) ? v : String(v || "").split(/[\n;]+/);
  const out = [];
  for (const x of raw) {
    const [county, state] = x && typeof x === "object"
      ? [x.county, x.state]
      : String(x).split(",").map((p) => p.trim());
    const c = String(county || "").replace(/\s+county$/i, "").trim();
    const st = String(state || "").trim().toUpperCase();
    if (c && /^[A-Z]{2}$/.test(st)) out.push({ county: c, state: st });
  }
  return out.slice(0, 20);
}

// Mon–Fri in Pacific time, where the business is. The sweeps fire at 7–10am
// Pacific, so the Pacific weekday is the one that matters.
export const WORK_TZ = process.env.OUTREACH_TZ || "America/Los_Angeles";
// The hour of day (0–23) in the work time zone.
export function workHour(now = Date.now(), tz = WORK_TZ) {
  return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date(now)));
}

export function isWorkday(now = Date.now(), tz = WORK_TZ) {
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date(now));
  return wd !== "Sat" && wd !== "Sun";
}

// Runs left this month, today included, in Pacific dates — what the month's
// remaining RentCast requests get divided by.
export function runsLeftInMonth(now = Date.now(), { weekdaysOnly = true, tz = WORK_TZ } = {}) {
  const month = (t) => new Intl.DateTimeFormat("en-US", { month: "numeric", timeZone: tz }).format(new Date(t));
  const m = month(now);
  let n = 0;
  for (let t = now; month(t) === m; t += DAY_MS) if (!weekdaysOnly || isWorkday(t, tz)) n++;
  return Math.max(1, n);
}

// RentCast's property types, spelled its way.
export const PROPERTY_TYPES = ["Single Family", "Multi-Family", "Manufactured", "Townhouse", "Condo", "Apartment", "Land"];
// Flips: houses, small multis, manufactured, townhomes. Condos and land are not the deal.
export const DEFAULT_PROPERTY_TYPES = ["Single Family", "Multi-Family", "Manufactured", "Townhouse"];
export const DEFAULT_MIN_DAYS_ON_MARKET = 45;
// Requests left for the Pull button, on top of what the sweep spends.
export const DEFAULT_RESERVE_REQUESTS = 2;
// The most one run may spend, however far behind the month is.
export const MAX_REQUESTS_PER_RUN = 10;
export const PAGES_CURSOR = "outreachPages";

/**
 * normalizeOutreachAutopilot(v) → { enabled, dailyCap, firstTouch, requireDistress,
 *   workflowId, counties, followUpEnabled, followUpWorkflowId, followUpDays }
 *
 * The settings blob, coerced. `firstTouch` is who says hello: "app" (the
 * Conversation AI drafts it, no GHL trigger tag), "ghl" (the trigger tag,
 * the workflow's template — the old way), or "workflow" (enroll new contacts
 * straight into `workflowId`, no tag). The follow-up fields drive
 * outreach-followup.js: enrolled contacts who never answered go into
 * `followUpWorkflowId` after `followUpDays`.
 */
export function normalizeOutreachAutopilot(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const cap = Math.round(Number(o.dailyCap));
  const days = Math.round(Number(o.followUpDays));
  const minDom = Math.round(Number(o.minDaysOnMarket));
  const year = Math.round(Number(o.maxYearBuilt));
  const reserve = Math.round(Number(o.reserveRequests));
  const types = (Array.isArray(o.propertyTypes) ? o.propertyTypes : String(o.propertyTypes ?? "").split("|"))
    .map((t) => PROPERTY_TYPES.find((p) => p.toLowerCase() === String(t).trim().toLowerCase())).filter(Boolean);
  return {
    enabled: o.enabled === true,
    dailyCap: Number.isFinite(cap) ? Math.min(MAX_DAILY_CAP, Math.max(1, cap)) : DEFAULT_DAILY_CAP,
    weekdaysOnly: o.weekdaysOnly !== false,
    firstTouch: o.firstTouch === "ghl" || o.firstTouch === "workflow" ? o.firstTouch : "app",
    requireDistress: o.requireDistress !== false,
    workflowId: workflowIdFrom(o.workflowId),
    counties: countiesFrom(o.counties),
    followUpEnabled: o.followUpEnabled === true,
    followUpWorkflowId: workflowIdFrom(o.followUpWorkflowId),
    followUpDays: Number.isFinite(days) && days > 0 ? Math.min(90, Math.max(3, days)) : DEFAULT_FOLLOW_UP_DAYS,
    // What RentCast is asked for, so a 500-listing page is already mostly
    // distress: listed at least this long ago (0 = any), these types, this old.
    minDaysOnMarket: o.minDaysOnMarket === 0 || o.minDaysOnMarket === "0" ? 0
      : Number.isFinite(minDom) && minDom > 0 ? Math.min(365, minDom) : DEFAULT_MIN_DAYS_ON_MARKET,
    propertyTypes: o.propertyTypes === undefined ? [...DEFAULT_PROPERTY_TYPES] : [...new Set(types)],
    maxYearBuilt: year >= 1800 && year <= 2100 ? year : 0,
    reserveRequests: Number.isFinite(reserve) && reserve >= 0 ? Math.min(20, reserve) : DEFAULT_RESERVE_REQUESTS,
  };
}

/**
 * pullQuery(oa) → the RentCast filters the sweep sends with every pull.
 */
export function pullQuery(oa) {
  return {
    daysOld: `${Math.max(1, oa.minDaysOnMarket || 1)}:*`,
    ...(oa.propertyTypes.length ? { propertyType: oa.propertyTypes.join("|") } : {}),
    ...(oa.maxYearBuilt ? { yearBuilt: `*:${oa.maxYearBuilt}` } : {}),
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
    pull: null, county: null, candidates: 0, picked: 0, imported: 0, opened: 0, enrolled: 0, warnings: [], results: [], error: null,
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

  // 0. The RentCast meter. The free tier is 50 requests a month and overage
  // is billed, not refused. Spend it evenly: what's left (less a reserve for
  // the Pull button) over the runs left this month.
  job.phase = "budget";
  let perRun = 1;
  try {
    const pulls = await store.listOutreachPulls(locationId, { limit: 200 });
    const monthStart = new Date(now); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const used = pulls.filter((p) => new Date(p.createdAt) >= monthStart).reduce((s, p) => s + (Number(p.doc?.requestsUsed) || 0), 0);
    const budget = Number(saved.rentcastMonthlyBudget) > 0 ? Number(saved.rentcastMonthlyBudget) : RENTCAST_MONTHLY_BUDGET;
    const spendable = budget - used - oa.reserveRequests;
    const runsLeft = runsLeftInMonth(now, { weekdaysOnly: oa.weekdaysOnly });
    perRun = Math.min(MAX_REQUESTS_PER_RUN, Math.max(1, Math.floor(spendable / runsLeft)));
    job.budget = { used, budget, reserve: oa.reserveRequests, runsLeft, perRun: spendable > 0 ? perRun : 0 };
    if (spendable <= 0) {
      job.warnings.push(`RentCast budget: ${used} of ${budget} requests used this month (${oa.reserveRequests} kept for the Pull button) — the sweep is standing down until next month`);
      job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
      return;
    }
  } catch (e) { job.warnings.push(`budget check: ${String(e?.message || e).slice(0, 120)}`); }

  // Enrolling with no workflow picked would import people nobody texts.
  // Stop before the pull spends a request; never fall back to the tag.
  if (oa.firstTouch === "workflow" && !oa.workflowId) {
    job.warnings.push("first touch is a GHL workflow but none is picked — pick it in Settings");
    job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
    return;
  }

  // 1. The pull, filtered at RentCast so a page is mostly stale listings.
  // With a county list: walk the counties page by page — the county whose
  // turn it is, from where the last run stopped, then the next county once
  // it's read to the end. Without one: the saved market defaults. A cache
  // hit is free.
  job.phase = "pulling";
  const query = { ...pullQuery(oa), maxRequests: perRun };
  let pages = null;
  let county = null;
  let key = null;
  if (oa.counties.length) {
    pages = (await store.getJobCursor?.(locationId, PAGES_CURSOR).catch(() => null))?.doc || {};
    const turn = (Number(pages.turn) || 0) % oa.counties.length;
    county = oa.counties[turn];
    key = `${county.county}, ${county.state}`;
    query.county = county.county; query.state = county.state;
    query.offset = Number(pages.offsets?.[key]) || 0;
    pages = { ...pages, turn };
  }
  job.county = key;
  const pull = await deps.runPull(locationId, client, query);
  job.pull = { batchId: pull.batchId, batchName: pull.batchName, requestsUsed: pull.requestsUsed, cached: pull.cached,
    listingsFetched: pull.listingsFetched, listingsKept: pull.listingsKept, agentsTotal: pull.agentsTotal, agentsNew: pull.agentsNew,
    offset: query.offset ?? 0, nextOffset: pull.nextOffset || 0, totalCount: pull.totalCount ?? null };
  job.warnings.push(...(pull.warnings || []).filter((w) => !/^county filter kept/.test(w)).slice(0, 5));

  // Remember where this county stopped. A dry run leaves the place alone,
  // so the live run after a preview reads the same pages (from the cache).
  if (county && !job.dryRun) {
    const next = Number(pull.nextOffset) || 0;
    await store.setJobCursor?.(locationId, PAGES_CURSOR, { at: iso(now), doc: {
      turn: next ? pages.turn : (pages.turn + 1) % oa.counties.length,
      offsets: { ...(pages.offsets || {}), [key]: next },
      totals: { ...(pages.totals || {}), [key]: pull.totalCount ?? null },
      lastCounty: key,
    } }).catch((e) => job.warnings.push(`page cursor: ${String(e?.message || e).slice(0, 120)}`));
  }

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
    // "workflow": enrolled by id — only contacts the import CREATED, so
    // nobody already in GHL (and so possibly mid-workflow) is enrolled.
    applyTag: oa.firstTouch === "ghl", openWith: oa.firstTouch === "app" ? "app" : null,
    enrollWorkflowId: oa.firstTouch === "workflow" ? oa.workflowId : null,
    sessionSuffix: `auto-${iso(now).slice(0, 10)}`, dryRun: job.dryRun ? true : false,
  });
  job.imported = r.imported || 0;
  job.opened = r.opened || 0;
  job.enrolled = r.enrolled || 0;
  job.dryRun = Boolean(r.dryRun);
  job.warnings.push(...(r.warnings || []).slice(0, 10));
  const byKey = new Map((r.results || []).map((x) => [x.agentKey, x]));
  job.results = job.results.map((x) => {
    const y = byKey.get(x.agentKey) || {};
    return { ...x, ok: y.ok !== false, action: y.action || (y.dryRun ? (y.wouldCreate ? "would create" : y.wouldUpdate ? "would update" : "dry run") : ""),
      contactId: y.contactId || null, opened: y.opened || null, enrolled: y.enrolled || (y.wouldEnroll ? { would: true } : null), error: y.error || null };
  });

  job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
}

/**
 * maybeStartOutreachSweep({ locationId, client, saved, store, deps, hour, now }) → boolean
 *
 * The tick's decision. Gates: the hour, the toggle, a RentCast key, no run
 * in progress, and the durable cursor at least MIN_GAP_MS old.
 */
export async function maybeStartOutreachSweep({ locationId, client, saved = {}, store = defaultStore, deps = {}, hour = OUTREACH_SWEEP_HOUR, now = Date.now() }) {
  if (workHour(now) !== hour) return false;
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  if (!oa.enabled) return false;
  if (oa.weekdaysOnly && !isWorkday(now)) return false;
  if (!String(saved.rentcastApiKey || "").trim()) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  if (cursor?.at && now - Date.parse(cursor.at) < MIN_GAP_MS) return false;
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: {} }).catch(() => {});
  startOutreachSweep({ locationId, client, saved, store, deps, trigger: "daily", now });
  return true;
}

export const importsEnabled = () => OUTREACH_IMPORTS_ENABLED;
