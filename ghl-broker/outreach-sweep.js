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
import { normalizeOpener } from "./shared/outreach-opener.js";
import { isRuralLot } from "./shared/asset-type.js";
import { isOldHouse } from "./outreach-score.js";

export const CURSOR_NAME = "outreach";
export const MIN_GAP_MS = 20 * 3600 * 1000;
// A daily run that failed (RentCast slow, GHL down) is tried again that
// morning rather than costing the whole day: up to three tries, 20+ minutes
// apart, until 1pm Pacific. A run that finished — even with nothing to
// import — is never repeated.
// A failed day comes back until the working day is out, not just until
// lunch: Matt, 2026-09-16, after three mornings of reminding — "I want it to
// be an automatic process every day". Six tries, twenty minutes apart at
// least, from 10am to 5pm Pacific.
export const RETRY_WINDOW_HOURS = 7;
export const RETRY_GAP_MS = 20 * 60 * 1000;
export const MAX_DAILY_TRIES = 6;
// A run that has been "running" this long without finishing is not running.
// The job lives in memory; a hung request or a restart mid-run leaves the
// cursor saying a run is in progress with nothing behind it.
export const STALE_RUN_MS = 45 * 60 * 1000;
// The hour it runs, in Pacific time (so daylight saving doesn't move it).
export const OUTREACH_SWEEP_HOUR = Number(process.env.OUTREACH_SWEEP_HOUR || 10); // 10–11am Pacific
export const DEFAULT_DAILY_CAP = 12;
// A sanity ceiling, not a business rule: one RentCast page is 500 listings,
// and the import paces GHL at two contacts at a time.
export const MAX_DAILY_CAP = 500;
// The hard stop when no plan is set in Settings: 48 of the free tier's 50.
// Past a plan's requests RentCast does not refuse — it bills each one — so the
// budget is the only thing that stops it. A paid plan's number goes in
// Settings (`outreachAutopilot.monthlyRequests`).
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

import { findCounty } from "./shared/us-counties.js";

// [{ county, state }] from an array, or from the settings textarea's
// "King, WA" lines (or ";"-separated). A line with no state takes
// `defaultState` — the business is in Washington, and "King / Pierce /
// Snohomish" typed without one used to parse to no counties at all, so the
// 10am sweep failed with "no market configured".
export function countiesFrom(v, defaultState = "WA") {
  const raw = Array.isArray(v) ? v : String(v || "").split(/[\n;]+/);
  const out = [];
  for (const x of raw) {
    const [county, state] = x && typeof x === "object"
      ? [x.county, x.state]
      : String(x).split(",").map((p) => p.trim());
    const c = String(county || "").replace(/\s+county$/i, "").trim();
    // A defaulted state is only trusted for a county that really is in it —
    // "Nowhere" with no state is a typo, not Nowhere, WA.
    if (c && !String(state || "").trim() && !findCounty(c, defaultState)) continue;
    const st = String(state || defaultState || "").trim().toUpperCase();
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

// The calendar date in the work time zone.
function zonedDate(t, tz = WORK_TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", timeZone: tz })
    .formatToParts(new Date(t)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day };
}

// Midnight of a calendar date in the work time zone, as epoch ms.
function zonedMidnight(y, m, d, tz = WORK_TZ) {
  const guess = Date.UTC(y, m - 1, d);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23", timeZone: tz })
    .formatToParts(new Date(guess)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  // How far the zone's clock is from UTC at that moment.
  return guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess);
}

/**
 * rentcastCycle(now, cycleDay) → { start, end } (epoch ms)
 *
 * The billing month the requests count against. RentCast renews a plan on
 * the day it was bought, not on the 1st; dates are Pacific, like the sweep.
 */
export function rentcastCycle(now = Date.now(), cycleDay = 1, tz = WORK_TZ) {
  const day = Math.min(28, Math.max(1, Math.round(Number(cycleDay)) || 1));
  const { y, m, d } = zonedDate(now, tz);
  const [sy, sm] = d >= day ? [y, m] : m === 1 ? [y - 1, 12] : [y, m - 1];
  const [ny, nm] = sm === 12 ? [sy + 1, 1] : [sy, sm + 1];
  return { start: zonedMidnight(sy, sm, day, tz), end: zonedMidnight(ny, nm, day, tz) };
}

// Runs left in the billing month, today included, in Pacific dates — what the
// month's remaining RentCast requests get divided by.
export function runsLeftInCycle(now = Date.now(), { weekdaysOnly = true, cycleDay = 1, tz = WORK_TZ } = {}) {
  const { end } = rentcastCycle(now, cycleDay, tz);
  let n = 0;
  for (let t = now; t < end; t += DAY_MS) if (!weekdaysOnly || isWorkday(t, tz)) n++;
  return Math.max(1, n);
}

export function runsLeftInMonth(now = Date.now(), { weekdaysOnly = true, tz = WORK_TZ } = {}) {
  return runsLeftInCycle(now, { weekdaysOnly, cycleDay: 1, tz });
}

// RentCast's property types, spelled its way.
export const PROPERTY_TYPES = ["Single Family", "Multi-Family", "Manufactured", "Townhouse", "Condo", "Apartment", "Land"];
// Single-family houses only (Matt, 2026-10-01: focus on SFR). Multi-family,
// manufactured and townhouses can still be ticked in Settings; they aren't
// the default, and the auto-underwrite holds them anyway (settings.focusKinds).
export const DEFAULT_PROPERTY_TYPES = ["Single Family"];
export const DEFAULT_MIN_DAYS_ON_MARKET = 45;
// The most a hook listing may ask. Above it the agent is not our buyer's
// market, however stale the listing. 0 = no cap.
export const DEFAULT_MAX_LIST_PRICE = 1500000;
// What counts as distress for the sweep. The query already asks for listings
// 45+ days old, so "stale" is true of every one of them and proves nothing:
// it takes a price cut or an older house. A price under the market's $/sqft
// ("cut-or-cheap", until 2026-10) found finished houses in slow towns.
export const SWEEP_DISTRESS_RULE = "cut-or-old";
// Requests left for the Pull button, on top of what the sweep spends.
export const DEFAULT_RESERVE_REQUESTS = 2;
// The most one run may spend, however far behind the month is. Ten was the
// free tier's world; on a paid plan the month's budget spread over the
// workdays left is what really limits a run. The Pull button keeps ten.
export const MAX_REQUESTS_PER_RUN = 40;
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
  const maxPrice = Math.round(Number(o.maxListPrice));
  const monthly = Math.round(Number(o.monthlyRequests));
  const cycleDay = Math.round(Number(o.cycleDay));
  const types = (Array.isArray(o.propertyTypes) ? o.propertyTypes : String(o.propertyTypes ?? "").split("|"))
    .map((t) => PROPERTY_TYPES.find((p) => p.toLowerCase() === String(t).trim().toLowerCase())).filter(Boolean);
  return {
    enabled: o.enabled === true,
    dailyCap: Number.isFinite(cap) ? Math.min(MAX_DAILY_CAP, Math.max(1, cap)) : DEFAULT_DAILY_CAP,
    weekdaysOnly: o.weekdaysOnly !== false,
    firstTouch: o.firstTouch === "ghl" || o.firstTouch === "workflow" ? o.firstTouch : "app",
    // Matt's own first texts, the voice the bot writes them in.
    opener: normalizeOpener(o.opener),
    requireDistress: o.requireDistress !== false,
    // The share of the day's first texts (0–100) that go to agents whose
    // listings are all finished (Matt, 2026-10-09: 25). The three
    // off-market deals with committed buyers started on turnkey listings;
    // the house was the agent's next one. 0 = distress only, as before.
    turnkeyShare: Math.min(100, Math.max(0, Math.round(Number(o.turnkeyShare)) || 0)),
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
    reserveRequests: Number.isFinite(reserve) && reserve >= 0 ? Math.min(100, reserve) : DEFAULT_RESERVE_REQUESTS,
    // The RentCast plan: requests a month (0 = not set, the old budget
    // applies) and the day of the month it renews.
    monthlyRequests: Number.isFinite(monthly) && monthly > 0 ? Math.min(100000, monthly) : 0,
    cycleDay: Number.isFinite(cycleDay) && cycleDay >= 1 ? Math.min(28, cycleDay) : 1,
    maxListPrice: o.maxListPrice === 0 || o.maxListPrice === "0" ? 0
      : Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : DEFAULT_MAX_LIST_PRICE,
    // "counties": a circle per county, one after another. "statewide": one
    // read of the counties' state, filed by county (readState).
    coverage: o.coverage === "statewide" ? "statewide" : "counties",
    // Agents with no phone on their listings: Zillow's page for the listing,
    // at most `perRun` a pull (routes/outreach.js ingestCohort). Off by default.
    zillowLookup: {
      enabled: o.zillowLookup?.enabled === true,
      perRun: Math.min(40, Math.max(1, Math.round(Number(o.zillowLookup?.perRun)) || 25)),
    },
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
    ...(oa.maxListPrice ? { maxPrice: oa.maxListPrice } : {}),
    ...(oa.requireDistress ? { distressRule: SWEEP_DISTRESS_RULE } : {}),
    // The county's population centre, not the whole-county circle (see
    // METRO_CIRCLES in routes/outreach.js). Part of the query signature, so
    // the saved page offsets from the old circles start over.
    metro: true,
  };
}

// Ask the pull to keep turnkey-only agents (flagged) when there are seats for
// them. Not part of pullQuery: the saved page places don't start over for it.
export const keepTurnkeyFor = (oa) => (oa.requireDistress && oa.turnkeyShare > 0 ? { keepTurnkey: true } : {});

/**
 * pickAgentsToImport(rows, { cap, requireDistress, turnkeyShare }) → [row]
 *
 * Who gets a text today. Only agents nobody has touched: status "new" (not
 * imported, not skipped), no existing GHL contact (a match means a thread we
 * would be talking over), and a phone. The most distressed book first —
 * that is the whole thesis of the outreach — then the biggest.
 *
 * `maxPrice`, `distressRule` and `propertyTypes` are checked on the row itself, not trusted to
 * the pull: the batch keeps agents from earlier pulls made under looser
 * filters, and a row counted by another rule (or none) doesn't qualify.
 * Under "cut-or-old" the stored hook itself is read again (a price cut, or
 * built before OLD_HOUSE_YEAR), so a row from a "cut-or-cheap" pull whose
 * hook was cut or old still goes, and a cheap finished house doesn't.
 * `maxYearBuilt` (> 0) drops a hook built after it; no year on record goes
 * ahead, as it does in the pull.
 */
export function hookMeetsCutOrOld(hook = {}) {
  const cut = hook.priceCut === true
    || (Array.isArray(hook.components) && hook.components.some((c) => c?.key === "cuts" && Number(c.points) > 0));
  return cut || isOldHouse(hook.yearBuilt);
}

export function pickAgentsToImport(rows = [], { cap = DEFAULT_DAILY_CAP, requireDistress = true, maxPrice = 0, distressRule = null, propertyTypes = [], maxYearBuilt = 0, turnkeyShare = 0 } = {}) {
  const types = new Set((propertyTypes || []).map((t) => String(t).toLowerCase()));
  const reachable = (r) => r?.status === "new" && !r.contactId && !r.doc?.ghl?.contactId && Boolean(r.doc?.phone);
  // Same market rules as everyone else: the price cap, no rural, the types.
  const inMarket = (d) => (!maxPrice || (Number(d.hook?.price) > 0 && Number(d.hook.price) <= maxPrice))
    && !isRuralLot(d.hook?.lotSize)
    && !(types.size && d.hook?.propertyType && !types.has(String(d.hook.propertyType).toLowerCase()));
  const ok = rows.filter((r) => {
    const d = r?.doc || {};
    if (!reachable(r)) return false;
    if (requireDistress && d.turnkey) return false;
    if (requireDistress && !(Number(d.distressedCount) > 0)) return false;
    if (requireDistress && distressRule === "cut-or-old") {
      // A row from any price-signal pull is read again by its hook; a
      // stale-only ("any") or unlabelled row stays out, as it did before.
      if (!["cut-or-old", "cut-or-cheap"].includes(d.distressRule)) return false;
      if (!hookMeetsCutOrOld(d.hook)) return false;
    } else if (requireDistress && distressRule && d.distressRule !== distressRule) return false;
    if (maxYearBuilt > 0 && Number(d.hook?.yearBuilt) > maxYearBuilt) return false;
    if (maxPrice && !(Number(d.hook?.price) > 0 && Number(d.hook.price) <= maxPrice)) return false;
    // A rural hook (two acres or more) from a pull made before the rural
    // filter is not a reason to text them either (Matt, 2026-10-08).
    if (isRuralLot(d.hook?.lotSize)) return false;
    // Nor is a hook of a type outside the setting (Matt, 2026-10-08: no
    // manufactured homes): rows from pulls made before single-family-only
    // still sit in the batches. No type on record goes ahead.
    if (types.size && d.hook?.propertyType && !types.has(String(d.hook.propertyType).toLowerCase())) return false;
    return true;
  });
  ok.sort((a, b) =>
    (Number(b.doc?.distressedCount) || 0) - (Number(a.doc?.distressedCount) || 0) ||
    (Number(b.doc?.hook?.score) || 0) - (Number(a.doc?.hook?.score) || 0) ||
    (Number(b.doc?.listingCount) || 0) - (Number(a.doc?.listingCount) || 0));
  const share = requireDistress ? Math.min(100, Math.max(0, Number(turnkeyShare) || 0)) / 100 : 0;
  if (!share) return ok.slice(0, Math.max(0, cap));
  // The turnkey seats: agents kept only for them (routes/outreach.js), the
  // biggest book first. Woven in at the share — the import walks the list in
  // order and stops at the day's number, so the order is the split. Never
  // more than the share: when the distressed agents run out, so does the list.
  const turnkey = rows.filter((r) => reachable(r) && r.doc?.turnkey && inMarket(r.doc))
    .sort((a, b) => (Number(b.doc?.listingCount) || 0) - (Number(a.doc?.listingCount) || 0) || (Number(b.doc?.hook?.score) || 0) - (Number(a.doc?.hook?.score) || 0));
  return weave(ok, turnkey, share).slice(0, Math.max(0, cap));
}

// weave(main, side, share) → main with side woven in so that, at every point,
// side makes up `share` of the list so far (rounded down).
export function weave(main = [], side = [], share = 0) {
  const out = [];
  let i = 0, j = 0;
  for (let k = 1; i < main.length; k++) {
    const sideHere = j < side.length && Math.floor(k * share) > Math.floor((k - 1) * share);
    out.push(sideHere ? side[j++] : main[i++]);
  }
  return out;
}

/* ---------- the RentCast meter ---------- */

// The month's requests: the plan in Settings, else the old top-level
// override, else the free tier's 48.
export function monthlyBudget(saved = {}, oa = normalizeOutreachAutopilot(saved.outreachAutopilot)) {
  if (oa.monthlyRequests > 0) return oa.monthlyRequests;
  return Number(saved.rentcastMonthlyBudget) > 0 ? Number(saved.rentcastMonthlyBudget) : RENTCAST_MONTHLY_BUDGET;
}

// Every request since the cycle began. Summed by the store, not from a page of
// recent pulls — a page of 200 undercounted once a run recorded several pulls.
async function requestsSince(store, locationId, sinceIso) {
  if (typeof store.sumOutreachRequests === "function") return Number(await store.sumOutreachRequests(locationId, sinceIso)) || 0;
  const since = Date.parse(sinceIso);
  const pulls = await store.listOutreachPulls(locationId, { limit: 5000 });
  return pulls.filter((p) => new Date(p.createdAt).getTime() >= since).reduce((s, p) => s + (Number(p.doc?.requestsUsed) || 0), 0);
}

/**
 * rentcastBudget({ store, locationId, saved, now }) → { used, budget, reserve, runsLeft, perRun, since }
 *
 * What a run may spend: what's left this billing month, less the reserve for
 * the Pull button, over the runs left — at least one, at most
 * MAX_REQUESTS_PER_RUN, and 0 once nothing is left.
 */
export async function rentcastBudget({ store = defaultStore, locationId, saved = {}, now = Date.now() }) {
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  const { start } = rentcastCycle(now, oa.cycleDay);
  const used = await requestsSince(store, locationId, iso(start));
  const budget = monthlyBudget(saved, oa);
  const spendable = budget - used - oa.reserveRequests;
  const runsLeft = runsLeftInCycle(now, { weekdaysOnly: oa.weekdaysOnly, cycleDay: oa.cycleDay });
  const perRun = spendable > 0 ? Math.min(MAX_REQUESTS_PER_RUN, Math.max(1, Math.floor(spendable / runsLeft))) : 0;
  return { used, budget, reserve: oa.reserveRequests, runsLeft, perRun, since: iso(start) };
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
  // The run, on the cursor, where a restart can't lose it: `run` while it is
  // going, `last` once it is over. The page and GET /autopilot read these
  // when the in-memory job is gone, so "what happened to outreach today?"
  // has an answer after a deploy.
  const stamp = async (patch) => {
    const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: cur?.at || iso(now), doc: { ...(cur?.doc || {}), ...patch } }).catch(() => {});
  };
  const summary = () => ({
    id: job.id, trigger, dryRun: job.dryRun, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt,
    county: job.county, candidates: job.candidates, picked: job.picked, imported: job.imported, enrolled: job.enrolled,
    skippedExisting: job.skippedExisting || 0, requestsUsed: job.pull?.requestsUsed ?? null, error: job.error, warning: job.warnings[0] || "",
    // Which counties this run read before it found somebody (or gave up).
    tried: (job.tried || []).slice(0, 12),
  });
  // A long run (many counties, hundreds of one-at-a-time imports) says it's
  // still alive after every pull and import, so the tick doesn't take it for
  // a hung one and start a second.
  const runDoc = { id: job.id, trigger, startedAt: job.startedAt };
  const beat = () => stamp({ run: { ...runDoc, beatAt: new Date().toISOString() } });
  stamp({ run: runDoc })
    .then(() => run(job, { locationId, client, saved, store, deps, now, beat }))
    .then(async () => { await stamp({ run: null, last: summary() }); })
    .catch(async (e) => {
      job.status = "error";
      job.error = String(e?.message || e).slice(0, 300);
      job.finishedAt = new Date().toISOString();
      // Remembered on the day's cursor, so the tick can try the day again.
      await stamp({ run: null, last: summary(), ...(trigger === "daily" ? { failed: true, error: job.error } : {}) });
    });
  return job;
}

async function run(job, { locationId, client, saved, store, deps, now, beat = async () => {} }) {
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  if (typeof deps.runPull !== "function" || typeof deps.importAgents !== "function") {
    throw new Error("outreach sweep needs runPull and importAgents");
  }

  // 0. The RentCast meter. A plan's requests are billed past its number, not
  // refused. Spend them evenly: what's left this billing month (less a
  // reserve for the Pull button) over the runs left.
  job.phase = "budget";
  let perRun = 1;
  try {
    const b = await rentcastBudget({ store, locationId, saved, now });
    const { used, budget, reserve, runsLeft } = b;
    perRun = b.perRun;
    job.budget = { used, budget, reserve, runsLeft, perRun };
    if (perRun <= 0) {
      job.warnings.push(`RentCast budget: ${used} of ${budget} requests used this month (${reserve} kept for the Pull button) — the sweep is standing down until the plan renews`);
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

  // The app says hello (2026-10-04): every agent it creates needs a text the
  // Conversation AI's day still has room for, or they sit in GHL untexted and
  // are never picked again. First texts that didn't go on an earlier run are
  // tried first; today's new agents get what's left. No cap is loosened —
  // the day's number comes down to fit.
  if (oa.firstTouch === "app") {
    job.phase = "room";
    let room = Infinity;
    if (typeof deps.firstTextRoom === "function") {
      room = await Promise.resolve(deps.firstTextRoom({ locationId, saved })).catch(() => Infinity);
    }
    if (!job.dryRun && room > 0 && typeof deps.retryFirstTexts === "function") {
      const r = await deps.retryFirstTexts({ locationId, client, limit: room })
        .catch((e) => { job.warnings.push(`retrying first texts: ${String(e?.message || e).slice(0, 120)}`); return null; });
      if (r?.retried) {
        job.retried = r.retried;
        job.reopened = r.opened || 0;
        room -= r.retried;
      }
    }
    if (room < oa.dailyCap) {
      const fit = Math.max(0, Math.floor(room));
      job.warnings.push(`the Conversation AI's daily cap leaves room for ${fit} first text${fit === 1 ? "" : "s"} today (the rest is kept for people who text us) — importing ${fit}, not ${oa.dailyCap}`);
      oa.dailyCap = fit;
    }
    if (oa.dailyCap <= 0) {
      job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
      return;
    }
  }

  // 1. The pull, filtered at RentCast so a page is mostly stale listings.
  // With a county list: walk the counties page by page — the county whose
  // turn it is, from where the last run stopped, then the next county once
  // it's read to the end. Without one: the saved market defaults. A cache
  // hit is free.
  //
  // The run fills the day (2026-10-02). It used to stop at the first county
  // that yielded anyone — Pierce gave up one new agent and the day was over
  // with requests unspent. Now it keeps going, county after county, while it
  // has requests left and hasn't found the day's number (with room over, for
  // the agents the import finds already in GHL). Each county is read at most
  // once a run. An empty or failing county gives up its turn; only when every
  // county fails does the run fail (and come back on the retry clock).
  const querySig = JSON.stringify(pullQuery(oa));
  const n = Math.max(1, oa.counties.length);
  const wanted = Math.ceil(oa.dailyCap * 1.5);
  let left = perRun;
  let pages = null;
  if (oa.counties.length) {
    pages = (await store.getJobCursor?.(locationId, PAGES_CURSOR).catch(() => null))?.doc || {};
    // The saved places belong to the filters they were read with: a new price
    // cap or rule is a different result list, and an old offset would skip into it.
    if (pages.query !== querySig) pages = { ...pages, offsets: {}, totals: {} };
  }
  const startTurn = (Number(pages?.turn) || 0) % n;
  const savePages = async (doc) => {
    if (job.dryRun) return;   // a preview leaves the place alone
    pages = { ...doc, query: querySig };
    await store.setJobCursor?.(locationId, PAGES_CURSOR, { at: iso(now), doc: pages })
      .catch((e) => job.warnings.push(`page cursor: ${String(e?.message || e).slice(0, 120)}`));
  };
  const groups = [];          // [{ key, batchId, picked }] in the order read
  const seenAgents = new Set();
  const seenPhones = new Set();
  let pickedTotal = 0;
  let pulls = 0;
  // The first county this run left with pages and people still in it: the
  // next run starts there, whatever counties this one went on to.
  let keepTurn = null;
  job.tried = [];

  // 2. Who is new to us in a county's batch. Ranked, and deliberately longer
  // than the day's number: the import walks it one agent at a time, skips
  // anyone already in GHL, and stops once `dailyCap` brand-new contacts exist.
  // Pending/sold and condos are already out: the RentCast pull asks for Active
  // listings of the configured property types only. Turnkey can't be told
  // from RentCast, and those agents weed themselves out (a turnkey reply is Tier 2).
  // An agent with listings in two counties is picked in the first one only —
  // and one phone is one person, whatever key each listing gave them.
  const pickFrom = async (key, batchId) => {
    job.phase = "picking";
    // Only rows the pick can reach (new, not in GHL here or in another batch,
    // with a phone): reading "new" rows newest-first let a county full of
    // people we can't text crowd out the ones we can.
    const rows = typeof store.listOutreachPickable === "function"
      ? await store.listOutreachPickable(locationId, { batchId, limit: 1000 })
      : await store.listOutreachAgents(locationId, { batchId, status: "new", limit: 1000 });
    job.candidates = (job.candidates || 0) + rows.length;
    const fresh = pickAgentsToImport(rows, { cap: MAX_DAILY_CAP, requireDistress: oa.requireDistress,
      maxPrice: oa.maxListPrice, distressRule: oa.requireDistress ? SWEEP_DISTRESS_RULE : null, propertyTypes: oa.propertyTypes,
      maxYearBuilt: oa.maxYearBuilt, turnkeyShare: oa.turnkeyShare })
      .filter((r) => !seenAgents.has(r.agentKey) && !seenPhones.has(String(r.doc?.phone)));
    for (const r of fresh) { seenAgents.add(r.agentKey); seenPhones.add(String(r.doc?.phone)); }
    if (fresh.length) groups.push({ key, batchId, picked: fresh });
    pickedTotal += fresh.length;
    job.picked = pickedTotal;
    if (!fresh.length && key) job.warnings.push(`${key}: nobody new to text (${rows.length} on file, all already in GHL, without a phone, or outside the rules) — moving on`);
    return { rows, fresh };
  };

  if (oa.coverage === "statewide" && oa.counties.length) {
    // One read of the state, filed county by county into each county's batch.
    await readState({ oa, job, locationId, client, store, deps, now, left, querySig, pickFrom, beat });
  } else for (let attempt = 0; attempt < n; attempt++) {
    // Stop before a pull, not after it: a run with nothing left spends nothing.
    if (attempt > 0 && (left <= 0 || pickedTotal >= wanted)) break;
    job.phase = "pulling";
    const query = { ...pullQuery(oa), ...keepTurnkeyFor(oa), maxRequests: Math.max(1, left) };
    let county = null;
    let key = null;
    const turn = (startTurn + attempt) % n;
    if (oa.counties.length) {
      county = oa.counties[turn];
      key = `${county.county}, ${county.state}`;
      query.county = county.county; query.state = county.state;
      query.offset = Number(pages.offsets?.[key]) || 0;
    }
    job.county = key;
    // Its own batch per market. Without a batchId the pull lands in the most
    // recent batch, whatever that is — on 2026-09-14 a King pull went into a
    // hand-made "Spokane County · Sep 3" batch and picked Spokane agents from
    // it. The pick below reads the whole batch, so the batch IS the market.
    const batchId = await autopilotBatchId({ store, locationId, market: key || "saved market" }).catch(() => undefined);
    if (batchId) query.batchId = batchId;
    let pull;
    try {
      pull = await deps.runPull(locationId, client, query, { maxRequestsCap: MAX_REQUESTS_PER_RUN });
    } catch (e) {
      const why = String(e?.message || e).slice(0, 120);
      job.tried.push({ county: key, error: why });
      job.warnings.push(`${key || "the saved market"}: the pull failed (${why}) — moving on`);
      const last = attempt === n - 1 || !county;
      if (last && !pulls) throw e;
      if (county) await savePages({ ...pages, turn: (turn + 1) % n });
      if (last) break;
      continue;
    }
    pulls++;
    const used = Number(pull.requestsUsed) || 0;
    left -= used;
    const prev = job.pull;
    job.pull = {
      batchId: pull.batchId, batchName: pull.batchName, requestsUsed: (prev?.requestsUsed || 0) + used, cached: pull.cached,
      listingsFetched: (prev?.listingsFetched || 0) + (Number(pull.listingsFetched) || 0),
      listingsKept: (prev?.listingsKept || 0) + (Number(pull.listingsKept) || 0),
      agentsTotal: (prev?.agentsTotal || 0) + (Number(pull.agentsTotal) || 0),
      agentsNew: (prev?.agentsNew || 0) + (Number(pull.agentsNew) || 0),
      // Where in the county the run read — only meaningful for one county.
      ...(prev ? { offset: null, nextOffset: null, totalCount: null }
        : { offset: query.offset ?? 0, nextOffset: pull.nextOffset || 0, totalCount: pull.totalCount ?? null }),
    };
    job.warnings.push(...(pull.warnings || []).filter((w) => !/^county filter kept [1-9]/.test(w)).slice(0, 6));
    await beat();

    const { rows, fresh } = await pickFrom(key, pull.batchId);
    job.tried.push({ county: key, candidates: rows.length, picked: fresh.length, requestsUsed: used,
      ...(county ? { offset: query.offset ?? 0, nextOffset: Number(pull.nextOffset) || 0, totalCount: pull.totalCount ?? null } : {}) });

    // Remember where this county stopped. The turn stays on a county that
    // still has pages and people in it (the run ran out of requests there);
    // it passes on when the county is read to the end — or came up empty.
    if (county) {
      const next = Number(pull.nextOffset) || 0;
      if (keepTurn == null && next && fresh.length) keepTurn = turn;
      await savePages({
        ...pages,
        turn: keepTurn ?? (turn + 1) % n,
        offsets: { ...(pages.offsets || {}), [key]: next },
        totals: { ...(pages.totals || {}), [key]: pull.totalCount ?? null },
        lastCounty: key,
      });
    }
    if (!county) break;
  }
  job.county = groups.map((g) => g.key).filter(Boolean).join(" · ") || job.county;
  const picked = groups.flatMap((g) => g.picked);
  job.results = picked.map((r) => ({ agentKey: r.agentKey, name: r.doc?.name || "", hook: r.doc?.hook?.address || "", distressed: r.doc?.distressedCount || 0 }));
  if (!picked.length) {
    job.warnings.push("no county had anyone new to text today");
    job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
    return;
  }

  // 3. The import, county by county into each county's own batch, until the
  // day's number of brand-new contacts exists. Dry unless the env gate is on —
  // importAgents applies the gate itself; passing dryRun through keeps a
  // manual "show me" honest.
  job.phase = "importing";
  let made = 0;
  let dry = false;
  const outcomes = [];
  for (const g of groups) {
    const room = oa.dailyCap - made;
    if (room <= 0) break;
    await beat();
    const r = await deps.importAgents({
      locationId, client, agentKeys: g.picked.map((p) => p.agentKey), batchId: g.batchId,
      // "app": the bot says hello and the GHL trigger tag stays off, so the
      // workflow template cannot text them as well. "ghl": the old way.
      // "workflow": enrolled by id — only contacts the import CREATED, so
      // nobody already in GHL (and so possibly mid-workflow) is enrolled.
      applyTag: oa.firstTouch === "ghl", openWith: oa.firstTouch === "app" ? "app" : null,
      enrollWorkflowId: oa.firstTouch === "workflow" ? oa.workflowId : null,
      sessionSuffix: `auto-${iso(now).slice(0, 10)}`, dryRun: job.dryRun ? true : false,
      newOnly: true, createLimit: room, county: g.key || "",
    });
    const results = Array.isArray(r.results) ? r.results : [];
    made += results.length
      ? results.filter((x) => x.action === "created" || x.wouldCreate).length
      : Number(r.imported) || 0;
    job.imported = (job.imported || 0) + (r.imported || 0);
    job.opened = (job.opened || 0) + (r.opened || 0);
    job.enrolled = (job.enrolled || 0) + (r.enrolled || 0);
    job.skippedExisting = (job.skippedExisting || 0) + (r.skippedExisting || 0);
    dry = dry || Boolean(r.dryRun);
    job.warnings.push(...(r.warnings || []).slice(0, 10));
    outcomes.push(...results);
  }
  job.dryRun = dry;
  const byKey = new Map(outcomes.map((x) => [x.agentKey, x]));
  // Only the agents the import actually reached and didn't skip as existing.
  const reached = byKey.size
    ? job.results.filter((x) => byKey.has(x.agentKey) && !byKey.get(x.agentKey).skipped)
    : job.results.slice(0, oa.dailyCap);
  job.results = reached.map((x) => {
    const y = byKey.get(x.agentKey) || {};
    return { ...x, ok: y.ok !== false, action: y.action || (y.dryRun ? (y.wouldCreate ? "would create" : y.wouldUpdate ? "would update" : "dry run") : ""),
      contactId: y.contactId || null, opened: y.opened || null, enrolled: y.enrolled || (y.wouldEnroll ? { would: true } : null), error: y.error || null };
  });

  job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
}

// How far back a resumed statewide lap starts: listings come and go
// overnight, so the list shifts under a saved offset. Rows are keyed by
// listing and agent, so re-reading a few costs a little and duplicates none.
export const STATEWIDE_STEP_BACK = 50;

/**
 * readState(...) — the statewide sweep's read (2026-10-02). One RentCast query
 * for the counties' state, from where the last run stopped, filed by county
 * into "Autopilot · King, WA" and friends, then each county's batch picked in
 * the order the counties are listed. The place lives on the `outreachPages`
 * cursor under `statewide` ({ offset, total, lapAt, query }); a lap read to
 * the end starts over the next run.
 */
async function readState({ oa, job, locationId, client, store, deps, now, left, querySig, pickFrom, beat }) {
  const state = oa.counties[0].state;
  const counties = oa.counties.filter((c) => c.state === state);
  if (counties.length < oa.counties.length) {
    job.warnings.push(`statewide reads one state (${state}); ${oa.counties.length - counties.length} county(ies) in other states were left out`);
  }
  const cursor = (await store.getJobCursor?.(locationId, PAGES_CURSOR).catch(() => null))?.doc || {};
  const place = cursor.statewide?.query === querySig ? cursor.statewide : {};
  const saved = Number(place.offset) || 0;
  const offset = saved > 0 ? Math.max(0, saved - STATEWIDE_STEP_BACK) : 0;
  const batchIds = {};
  for (const c of counties) {
    const key = `${c.county}, ${c.state}`;
    batchIds[key] = await autopilotBatchId({ store, locationId, market: key });
  }
  job.phase = "pulling";
  job.county = state;
  const pull = await deps.runPull(locationId, client, {
    ...pullQuery(oa), ...keepTurnkeyFor(oa), statewide: true, state, counties, batchIds, offset, maxRequests: Math.max(1, left),
  }, { maxRequestsCap: MAX_REQUESTS_PER_RUN });
  const used = Number(pull.requestsUsed) || 0;
  job.pull = {
    requestsUsed: used, cached: pull.cached, listingsFetched: Number(pull.listingsFetched) || 0,
    listingsKept: (pull.counties || []).reduce((s, c) => s + (Number(c.listingsKept) || 0), 0),
    agentsTotal: (pull.counties || []).reduce((s, c) => s + (Number(c.agentsTotal) || 0), 0),
    agentsNew: (pull.counties || []).reduce((s, c) => s + (Number(c.agentsNew) || 0), 0),
    offset, nextOffset: Number(pull.nextOffset) || 0, totalCount: pull.totalCount ?? null,
  };
  job.warnings.push(...(pull.warnings || []).slice(0, 8));
  await beat();
  if (!job.dryRun) {
    const next = Number(pull.nextOffset) || 0;
    await store.setJobCursor?.(locationId, PAGES_CURSOR, { at: iso(now), doc: {
      ...cursor,
      statewide: { offset: next, total: pull.totalCount ?? null, query: querySig, ...(next ? { lapAt: place.lapAt || null } : { lapAt: iso(now) }) },
    } }).catch((e) => job.warnings.push(`page cursor: ${String(e?.message || e).slice(0, 120)}`));
  }
  const byKey = new Map((pull.counties || []).map((c) => [c.key, c]));
  for (const c of counties) {
    const key = `${c.county}, ${c.state}`;
    const got = byKey.get(key);
    const batchId = got?.batchId || batchIds[key];
    if (!batchId) continue;
    const { rows, fresh } = await pickFrom(key, batchId);
    job.tried.push({ county: key, candidates: rows.length, picked: fresh.length, listings: Number(got?.listingsFetched) || 0, agentsNew: Number(got?.agentsNew) || 0 });
  }
  return used;
}

// "Autopilot · King, WA" — found by name, created once, never auto-renamed
// (autoNamed false), so every run for a market adds to the same batch and the
// agents a page didn't reach today are still there tomorrow.
export async function autopilotBatchId({ store, locationId, market }) {
  if (typeof store.listOutreachBatches !== "function" || typeof store.createOutreachBatch !== "function") return undefined;
  const name = `Autopilot · ${market}`;
  const hit = (await store.listOutreachBatches(locationId)).find((b) => b.name === name);
  if (hit) return hit.id;
  const created = await store.createOutreachBatch(locationId, { name, autoNamed: false });
  return created?.id;
}

/**
 * maybeStartOutreachSweep({ locationId, client, saved, store, deps, hour, now }) → boolean
 *
 * The tick's decision. Gates: the hour, the toggle, a RentCast key, no run
 * in progress, and the durable cursor at least MIN_GAP_MS old.
 */
export async function maybeStartOutreachSweep({ locationId, client, saved = {}, store = defaultStore, deps = {}, hour = OUTREACH_SWEEP_HOUR, now = Date.now() }) {
  const h = workHour(now);
  if (h < hour || h >= hour + RETRY_WINDOW_HOURS) return false;
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  if (!oa.enabled) return false;
  if (oa.weekdaysOnly && !isWorkday(now)) return false;
  if (!String(saved.rentcastApiKey || "").trim()) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const doc = cursor?.doc || {};
  const ranToday = cursor?.at && now - Date.parse(cursor.at) < MIN_GAP_MS;
  // The cursor says a run is going, and nothing in memory is: it hung, or
  // the process restarted under it. Either way the day isn't done.
  // Measured from the run's last sign of life, not its start: a run that
  // fills the day can rightly take longer than STALE_RUN_MS.
  const stale = doc.run?.startedAt && now - Date.parse(doc.run.beatAt || doc.run.startedAt) > STALE_RUN_MS;
  let tries = 1;
  if (ranToday) {
    // Only a failed (or vanished) run comes back, spaced out and a few times at most.
    const triedSoFar = Number(doc.tries) || 1;
    if (!(doc.failed || stale) || triedSoFar >= MAX_DAILY_TRIES || now - Date.parse(cursor.at) < RETRY_GAP_MS) return false;
    tries = triedSoFar + 1;
  } else if (h !== hour) {
    return false;   // a fresh day starts in its own hour; the window is for retries
  }
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { tries, last: doc.last || null, ...(stale ? { staleRun: doc.run } : {}) } }).catch(() => {});
  startOutreachSweep({ locationId, client, saved, store, deps, trigger: "daily", now });
  return true;
}

export const importsEnabled = () => OUTREACH_IMPORTS_ENABLED;
