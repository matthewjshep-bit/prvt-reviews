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
import { normalizeIntroEmail, normalizeCheckInEmail } from "./shared/outreach-email.js";
import { isRuralLot } from "./shared/asset-type.js";
import { isOldHouse, DISTRESS_RULES, RECENT_LISTERS_DAYS } from "./outreach-score.js";
import { workflowIdFrom } from "./shared/ghl-calls.js";
import { listingDistress } from "./shared/listing-distress.js";
import { streetKey } from "./comps-zillow.js";
import { worksOn, runDaysFrom } from "./shared/follow-up-engine.js";

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
// A sanity ceiling on a hand-run import, not a business rule. The sweep's own
// day has no cap when `dailyCap` is 0 (2026-10-21, Matt: "Why is the cap 500?
// Let's get rid of that limit") — what RentCast finds is the limit.
export const MAX_DAILY_CAP = 5000;
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
// (".../automation/workflow/640e73d6-…"). Anything else is blank. Shared
// since 2026-10-15: Settings' GHL calls link is read the same way.
export { workflowIdFrom };

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

// A day the job runs on, by its `days` (shared/follow-up-engine.js RUN_DAYS):
// Monday to Friday unless it says Sunday to Friday or every day.
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function isWorkday(now = Date.now(), tz = WORK_TZ, days = "mon_fri") {
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date(now));
  return worksOn(WEEKDAY_INDEX[wd], days);
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
export function runsLeftInCycle(now = Date.now(), { weekdaysOnly = true, days = runDaysFrom({ weekdaysOnly }), cycleDay = 1, tz = WORK_TZ } = {}) {
  const { end } = rentcastCycle(now, cycleDay, tz);
  let n = 0;
  for (let t = now; t < end; t += DAY_MS) if (isWorkday(t, tz, days)) n++;
  return Math.max(1, n);
}

export function runsLeftInMonth(now = Date.now(), { weekdaysOnly = true, days = runDaysFrom({ weekdaysOnly }), tz = WORK_TZ } = {}) {
  return runsLeftInCycle(now, { days, cycleDay: 1, tz });
}

// RentCast's property types, spelled its way.
export const PROPERTY_TYPES = ["Single Family", "Multi-Family", "Manufactured", "Townhouse", "Condo", "Apartment", "Land"];
// Single-family houses only (Matt, 2026-10-01: focus on SFR). Multi-family
// and townhouses can still be ticked in Settings; they aren't the default,
// and the auto-underwrite holds them anyway (settings.focusKinds).
// Manufactured is never kept, ticked or not (Matt, 2026-10-13).
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
// Rules for one market over the ones above, keyed like the county list
// ("Deschutes, OR"). Bend (2026-10-21, Matt: "at least for Bend, targeting
// just primarily distressed property signals. Those are properties that are
// at least 16 years old. Look for days on market, properties that have been
// sitting"): built 2010 or before, asked of RentCast, then sitting 60 days,
// a price cut, or priced under the area — "old" can't be the signal there,
// where most houses are newer than 1980 — and no turnkey seats.
export const MARKET_RULES = ["maxYearBuilt", "minDaysOnMarket", "staleDom", "distressRule", "turnkeyShare"];
export const DEFAULT_MARKETS = {
  "Deschutes, OR": { maxYearBuilt: 2010, minDaysOnMarket: 21, staleDom: 60, distressRule: "any", turnkeyShare: 0 },
};

/** marketsFrom(v) → { "County, ST": { …only the rules it sets } } */
export function marketsFrom(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return structuredClone(DEFAULT_MARKETS);
  const out = {};
  for (const [rawKey, r] of Object.entries(v).slice(0, 20)) {
    const [c] = countiesFrom([rawKey]);
    if (!c || !r || typeof r !== "object") continue;
    const m = {};
    const year = Math.round(Number(r.maxYearBuilt));
    if (year >= 1800 && year <= 2100) m.maxYearBuilt = year;
    const dom = Math.round(Number(r.minDaysOnMarket));
    if (Number.isFinite(dom) && dom >= 0 && r.minDaysOnMarket !== "" && r.minDaysOnMarket != null) m.minDaysOnMarket = Math.min(365, dom);
    const stale = Math.round(Number(r.staleDom));
    if (stale >= 1) m.staleDom = Math.min(365, stale);
    if (DISTRESS_RULES.includes(r.distressRule)) m.distressRule = r.distressRule;
    const share = Math.round(Number(r.turnkeyShare));
    if (Number.isFinite(share) && r.turnkeyShare !== "" && r.turnkeyShare != null) m.turnkeyShare = Math.min(100, Math.max(0, share));
    out[`${c.county}, ${c.state}`] = m;
  }
  return out;
}

/**
 * marketRules(oa, key) → { maxYearBuilt, minDaysOnMarket, staleDom, distressRule, turnkeyShare }
 *
 * The rules a county's pull and pick go by: its own (oa.markets[key]) over
 * the sweep's. `distressRule` is null when the sweep doesn't require distress.
 */
export function marketRules(oa, key = null) {
  const m = (key && oa.markets?.[key]) || {};
  return {
    maxYearBuilt: m.maxYearBuilt ?? oa.maxYearBuilt,
    minDaysOnMarket: m.minDaysOnMarket ?? oa.minDaysOnMarket,
    staleDom: m.staleDom ?? null,
    distressRule: oa.requireDistress ? m.distressRule ?? SWEEP_DISTRESS_RULE : null,
    turnkeyShare: m.turnkeyShare ?? oa.turnkeyShare,
  };
}

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
    .map((t) => PROPERTY_TYPES.find((p) => p.toLowerCase() === String(t).trim().toLowerCase())).filter((t) => t && t !== "Manufactured");
  return {
    enabled: o.enabled === true,
    // 0 = no cap: everyone the day's pull finds.
    dailyCap: o.dailyCap === 0 || o.dailyCap === "0" ? 0 : Number.isFinite(cap) ? Math.min(MAX_DAILY_CAP, Math.max(1, cap)) : DEFAULT_DAILY_CAP,
    // The hour the daily pull starts, Pacific (2026-10-21, Matt: "move all
    // agent polls to 9 am instead of 10 am"). 7am–3pm; the env's otherwise.
    hour: Number.isInteger(Number(o.hour)) && Number(o.hour) >= 7 && Number(o.hour) <= 15 && o.hour !== "" && o.hour !== null ? Number(o.hour) : OUTREACH_SWEEP_HOUR,
    // The days it runs: "mon_fri", "sun_fri" or "all" (`weekdaysOnly` was the switch before).
    days: runDaysFrom(o),
    weekdaysOnly: runDaysFrom(o) !== "all",
    firstTouch: o.firstTouch === "ghl" || o.firstTouch === "workflow" ? o.firstTouch : "app",
    // Matt's own first texts, the voice the bot writes them in.
    opener: normalizeOpener(o.opener),
    // The introduction email on day 2 (outreach-email.js). Off by default.
    introEmail: normalizeIntroEmail(o.introEmail),
    // An email with each 14-day check-in after it (outreach-email.js). Off by default.
    checkInEmail: normalizeCheckInEmail(o.checkInEmail),
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
    // The app's "Reached out, no reply" nudge also follows up the agents the
    // GHL workflow texted first (2026-10-16, follow-up-sweep.js
    // ghlCohortCandidates), and takes them out of the GHL follow-up
    // workflow before it does. Off by default; with it on, turn
    // `followUpEnabled` off so one system owns their follow-up.
    nudgeGhlCohort: o.nudgeGhlCohort === true,
    // What RentCast is asked for, so a 500-listing page is already mostly
    // distress: listed at least this long ago (0 = any), these types, this old.
    minDaysOnMarket: o.minDaysOnMarket === 0 || o.minDaysOnMarket === "0" ? 0
      : Number.isFinite(minDom) && minDom > 0 ? Math.min(365, minDom) : DEFAULT_MIN_DAYS_ON_MARKET,
    propertyTypes: o.propertyTypes === undefined ? [...DEFAULT_PROPERTY_TYPES] : [...new Set(types)],
    maxYearBuilt: year >= 1800 && year <= 2100 ? year : 0,
    // Rules for a market of its own (Bend), over these.
    markets: marketsFrom(o.markets),
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
    // Imported agents nobody ever texted, seen again by a pull, get the first
    // text before anyone new is pulled (2026-10-15, retryFirstTexts). Off by default.
    neverTexted: { enabled: o.neverTexted?.enabled === true },
    // Listings that came off the market lately without selling (2026-10-15):
    // `share` (0–100) of the day's new agents and of its RentCast requests go
    // to one county's off-market pull, in turn. Off by default.
    expired: {
      enabled: o.expired?.enabled === true,
      share: o.expired?.share === undefined ? 25 : Math.min(100, Math.max(0, Math.round(Number(o.expired.share)) || 0)),
    },
    // Agents in these counties who had a listing come down in the last
    // `withinDays`, sold or not, held to the county's distress rule
    // (2026-10-26, Matt: "only with people who have active listings in the
    // last 60-90 days … can rentcast pull this info"): `share` (0–100) of the
    // day's RentCast requests, one county a run, in turn. Off by default.
    recentListers: normalizeRecentListers(o.recentListers),
    // Read each picked listing on Zillow before its agent is texted
    // (2026-10-17, screenPicked): still for sale, and remarks that say it
    // needs work. At most `perRun` lookups a run, about a fifth of a cent
    // each. Off by default.
    distressCheck: {
      enabled: o.distressCheck?.enabled === true,
      perRun: Math.min(MAX_SCREEN_PER_RUN, Math.max(SCREEN_CHUNK, Math.round(Number(o.distressCheck?.perRun)) || DEFAULT_SCREEN_PER_RUN)),
    },
  };
}

/**
 * normalizeRecentListers(v) → { enabled, counties: [{ county, state }], withinDays, share }
 */
export function normalizeRecentListers(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const days = Math.round(Number(o.withinDays));
  return {
    enabled: o.enabled === true,
    counties: countiesFrom(o.counties),
    withinDays: Number.isFinite(days) && days > 0 ? Math.min(120, Math.max(30, days)) : RECENT_LISTERS_DAYS,
    share: o.share === undefined ? 25 : Math.min(100, Math.max(0, Math.round(Number(o.share)) || 0)),
  };
}

// The listing check (outreachAutopilot.distressCheck). Zillow is read 40
// listings to an actor run; what it said about a listing is remembered a
// month, so an agent passed over today isn't paid for again tomorrow.
export const SCREEN_CHUNK = 40;
export const DEFAULT_SCREEN_PER_RUN = 200;
export const MAX_SCREEN_PER_RUN = 600;
export const SCREEN_CURSOR = "outreachScreen";
export const SCREEN_REMEMBER_DAYS = 30;
const SCREEN_REMEMBER_MAX = 6000;

// Why a listing didn't pass, grouped for the run's summary.
function screenBucket(why = "") {
  if (/^not for sale/.test(why)) return "pending or sold";
  if (/^built in/.test(why)) return "new build";
  if (/^reads finished/.test(why)) return "reads finished";
  if (/^nothing in the remarks/.test(why)) return "no sign it needs work";
  if (/^no listing remarks/.test(why)) return "no remarks";
  if (/^Zillow couldn't find/.test(why)) return "not on Zillow";
  return "other";
}

/**
 * screenAddresses({ items, locationId, store, deps, now, perRun, want, remember, beat })
 *   → { verdict, stats, warnings }
 *
 * The Zillow read behind the listing check, for the sweep's picks and the
 * check-in's focus listings alike. `items` are { id, address, yearBuilt } in
 * the order they should be read; `verdict` maps each id the read reached to
 * true (still for sale and its remarks say it needs work,
 * shared/listing-distress.js) or false. An id with no verdict wasn't reached:
 * the run's `perRun` lookups were spent, `want` were already kept, or a
 * lookup failed — and nobody it would have checked is texted. What Zillow
 * said about an address is remembered SCREEN_REMEMBER_DAYS on the
 * `outreachScreen` cursor (unless `remember` is false, a dry run), so it
 * isn't paid for twice.
 */
export async function screenAddresses({ items = [], locationId, store = defaultStore, deps = {}, now = Date.now(), perRun = DEFAULT_SCREEN_PER_RUN, want = Infinity, remember = true, beat = async () => {} } = {}) {
  const stats = { checked: 0, remembered: 0, kept: 0, dropped: {}, waiting: 0 };
  const verdict = new Map();
  const warnings = [];
  const cursor = (await store.getJobCursor?.(locationId, SCREEN_CURSOR).catch(() => null))?.doc || {};
  const seen = { ...(cursor.seen || {}) };
  const recent = (e) => e && Date.parse(e.at) > now - SCREEN_REMEMBER_DAYS * DAY_MS;
  const drop = (why) => { const b = screenBucket(why); stats.dropped[b] = (stats.dropped[b] || 0) + 1; };
  const keyOf = (it) => streetKey(it.address || "");
  const toRead = [];
  for (const it of items) {
    const k = keyOf(it);
    if (!k) { verdict.set(it.id, false); drop("no address"); continue; }
    if (recent(seen[k])) {
      verdict.set(it.id, seen[k].ok === true);
      stats.remembered++;
      if (seen[k].ok) stats.kept++; else drop(seen[k].why);
      continue;
    }
    toRead.push(it);
  }
  let i = 0;
  while (i < toRead.length && stats.kept < want && stats.checked < perRun) {
    const chunk = toRead.slice(i, i + Math.min(SCREEN_CHUNK, perRun - stats.checked));
    i += chunk.length;
    let found;
    try {
      found = await deps.screenListings({ locationId, addresses: chunk.map((it) => it.address) });
    } catch (e) {
      warnings.push(`listing check: ${String(e?.message || e).slice(0, 120)} — the agents it didn't get to wait for the next run`);
      break;
    }
    stats.checked += chunk.length;
    for (const it of chunk) {
      const z = found?.get?.(keyOf(it)) || null;
      const v = z
        ? listingDistress({ status: z.status, description: z.description, yearBuilt: z.yearBuilt || it.yearBuilt }, { now })
        : { ok: false, why: "Zillow couldn't find the listing", signals: [] };
      verdict.set(it.id, v.ok);
      seen[keyOf(it)] = { at: iso(now), ok: v.ok, ...(v.why ? { why: v.why } : {}), ...(v.signals?.length ? { signals: v.signals.slice(0, 3) } : {}) };
      if (v.ok) stats.kept++; else drop(v.why);
    }
    await beat();
  }
  stats.waiting = items.filter((it) => !verdict.has(it.id)).length;
  if (remember) {
    const keep = Object.entries(seen).filter(([, e]) => recent(e))
      .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, SCREEN_REMEMBER_MAX);
    await store.setJobCursor?.(locationId, SCREEN_CURSOR, { at: iso(now), doc: { seen: Object.fromEntries(keep) } })
      .catch((e) => warnings.push(`listing check memory: ${String(e?.message || e).slice(0, 120)}`));
  }
  return { verdict, stats, warnings };
}

// "12 of 40 listings read as needing work (left out: 20 reads finished, …)"
export function screenSummary(stats) {
  const dropped = Object.entries(stats.dropped || {}).map(([b, n]) => `${n} ${b}`).join(", ");
  return `${stats.kept} of ${stats.checked + stats.remembered} listings read as needing work${dropped ? ` (left out: ${dropped})` : ""}`;
}

/**
 * screenPicked({ groups, oa, job, locationId, store, deps, now, beat })
 *
 * Matt, 2026-10-17: "we're simply reaching out on a listing that has
 * distress signals. We should definitely double-check that it has distress
 * signals." The 10/16 run texted 375 agents off RentCast's numbers (a price
 * cut, or built before 1980), and the answers were "it's move in ready",
 * "new construction", "it's pending", "did you look at the listing?". So each
 * picked agent's listing is read on Zillow (screenAddresses), in the pick's
 * order, until the day has its number (with a fifth over, for the ones the
 * import finds already in GHL) or the run's lookups are spent; only those
 * whose listing is still for sale and says it needs work stay picked. One the
 * run didn't get to waits for the next. A failed lookup texts nobody it would
 * have checked. The off-market seats have their own Zillow check
 * (routes/outreach.js keepOffMarket) and are left alone.
 */
async function screenPicked({ groups, oa, job, locationId, store, deps, now, beat = async () => {} }) {
  // The off-market seats have their own check, and a recent lister's house
  // is gone by definition: neither is for sale to read.
  const screened = (g) => !g.offMarket && !g.pastListing;
  if (typeof deps.screenListings !== "function") {
    job.screen = { checked: 0, remembered: 0, kept: 0, dropped: {}, waiting: 0 };
    job.warnings.push("listing check is on but this broker can't read Zillow — nobody is texted today");
    for (const g of groups) if (screened(g)) g.picked = [];
    return;
  }
  const rows = groups.filter(screened).flatMap((g) => g.picked);
  const { verdict, stats, warnings } = await screenAddresses({
    items: rows.map((r) => ({ id: r.agentKey, address: r.doc?.hook?.address || "", yearBuilt: r.doc?.hook?.yearBuilt })),
    locationId, store, deps, now, perRun: oa.distressCheck.perRun, want: Math.ceil(oa.dailyCap * 1.2), remember: !job.dryRun, beat,
  });
  job.screen = stats;
  job.warnings.push(...warnings);
  for (const g of groups) if (screened(g)) g.picked = g.picked.filter((r) => verdict.get(r.agentKey) === true);
  if (stats.checked) job.warnings.push(`listing check: ${screenSummary(stats)}`);
}

/**
 * pullQuery(oa, key) → the RentCast filters the sweep sends with every pull,
 * by the market's own rules when it has them (marketRules).
 */
export function pullQuery(oa, key = null) {
  const r = marketRules(oa, key);
  return {
    daysOld: `${Math.max(1, r.minDaysOnMarket || 1)}:*`,
    ...(oa.propertyTypes.length ? { propertyType: oa.propertyTypes.join("|") } : {}),
    ...(r.maxYearBuilt ? { yearBuilt: `*:${r.maxYearBuilt}` } : {}),
    // A market's own year is checked again after the pull, as the hand-made Pull does.
    ...(key && oa.markets?.[key]?.maxYearBuilt ? { maxYearBuilt: r.maxYearBuilt } : {}),
    ...(oa.maxListPrice ? { maxPrice: oa.maxListPrice } : {}),
    ...(r.distressRule ? { distressRule: r.distressRule } : {}),
    ...(r.staleDom ? { staleDom: r.staleDom } : {}),
    // The county's population centre, not the whole-county circle (see
    // METRO_CIRCLES in routes/outreach.js). Part of the query signature, so
    // the saved page offsets from the old circles start over.
    metro: true,
  };
}

// A market with rules of its own reads its pages by its own query: new rules
// start its place over without touching anyone else's. Null for the rest,
// whose place belongs to the sweep's query (`pages.query`).
const marketSig = (oa, key) => (key && oa.markets?.[key] ? JSON.stringify(pullQuery(oa, key)) : null);

// Ask the pull to keep turnkey-only agents (flagged) when there are seats for
// them. Not part of pullQuery: the saved page places don't start over for it.
export const keepTurnkeyFor = (oa, key = null) => (oa.requireDistress && marketRules(oa, key).turnkeyShare > 0 ? { keepTurnkey: true } : {});

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
 * ahead, as it does in the pull. Under "cut-old-or-stale" a hook sitting
 * `staleDom` days goes too.
 */
export function hookMeetsCutOrOld(hook = {}) {
  const cut = hook.priceCut === true
    || (Array.isArray(hook.components) && hook.components.some((c) => c?.key === "cuts" && Number(c.points) > 0));
  return cut || isOldHouse(hook.yearBuilt);
}

export function pickAgentsToImport(rows = [], { cap = DEFAULT_DAILY_CAP, requireDistress = true, maxPrice = 0, distressRule = null, propertyTypes = [], maxYearBuilt = 0, turnkeyShare = 0, staleDom = null } = {}) {
  const types = new Set((propertyTypes || []).map((t) => String(t).toLowerCase()));
  // Never a mobile home, whatever is ticked (Matt, 2026-10-13).
  const mobile = (d) => String(d.hook?.propertyType || "").toLowerCase() === "manufactured";
  const reachable = (r) => r?.status === "new" && !r.contactId && !r.doc?.ghl?.contactId && Boolean(r.doc?.phone);
  // Same market rules as everyone else: the price cap, no rural, the types.
  const inMarket = (d) => (!maxPrice || (Number(d.hook?.price) > 0 && Number(d.hook.price) <= maxPrice))
    && !isRuralLot(d.hook?.lotSize)
    && !mobile(d)
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
    } else if (requireDistress && distressRule === "cut-old-or-stale") {
      // Pierce (2026-10-26): any row is read again by its hook — a cut, an
      // older house, or a listing sitting the market's `staleDom` days.
      if (!hookMeetsCutOrOld(d.hook) && !(Number(staleDom) > 0 && Number(d.hook?.dom) >= Number(staleDom))) return false;
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
    if (mobile(d)) return false;
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
  const runsLeft = runsLeftInCycle(now, { days: oa.days, cycleDay: oa.cycleDay });
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
    // First texts that went before the pull: retries, and agents nobody had texted.
    retried: job.retried || 0, neverTexted: job.neverTexted || 0, opened: job.opened || 0,
    // Which counties this run read before it found somebody (or gave up).
    tried: (job.tried || []).slice(0, 12),
    // The off-market seats' pull, when on (outreachAutopilot.expired).
    ...(job.offMarket ? { offMarket: job.offMarket } : {}),
    // The listing check, when on (outreachAutopilot.distressCheck).
    ...(job.screen ? { screen: job.screen } : {}),
    // The recent listers' pull, when on (outreachAutopilot.recentListers).
    ...(job.recentListers ? { recentListers: job.recentListers } : {}),
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
  // No cap (0): everyone the day's pull finds.
  if (!(oa.dailyCap > 0)) oa.dailyCap = Infinity;

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
      const r = await deps.retryFirstTexts({ locationId, client, limit: room, neverTexted: oa.neverTexted.enabled })
        .catch((e) => { job.warnings.push(`retrying first texts: ${String(e?.message || e).slice(0, 120)}`); return null; });
      if (r?.retried) {
        job.retried = r.retried;
        job.reopened = r.opened || 0;
        // How many of them were agents nobody had ever texted.
        if (r.neverTexted) job.neverTexted = r.neverTexted;
        room -= r.retried;
      }
    }
    if (room < oa.dailyCap) {
      const fit = Math.max(0, Math.floor(room));
      job.warnings.push(`the Conversation AI's daily cap leaves room for ${fit} first text${fit === 1 ? "" : "s"} today (the rest is kept for people who text us) — importing ${fit}, not ${Number.isFinite(oa.dailyCap) ? oa.dailyCap : "everyone found"}`);
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
  const groups = [];          // [{ key, batchId, picked, limit? }] in the order read
  const seenAgents = new Set();
  const seenPhones = new Set();
  let pickedTotal = 0;
  let pulls = 0;

  // 1b. The off-market seats (2026-10-15, outreachAutopilot.expired, off by
  // default): one county a run, in turn, read for listings that came off the
  // market in the last 30 days without selling, into its own batch
  // ("Autopilot · Off-market · King, WA" — the same listing in the county's
  // batch would collide). `share` of the day's requests and new agents go to
  // it, first; the regular pull gets the rest. Agents already in GHL hear
  // about it from the check-in (shared/agent-pulse.js "off_market_listing").
  // The regular pull always keeps at least one request: a run with only one
  // left skips the off-market seats.
  if (oa.expired.enabled && oa.expired.share > 0 && oa.counties.length && left > 1) {
    const share = oa.expired.share / 100;
    const seats = Math.max(1, Math.round(oa.dailyCap * share));
    const reqs = Math.max(1, Math.min(left - 1, Math.round(perRun * share) || 1));
    const turn = (Number(pages?.expiredTurn) || 0) % n;
    const county = oa.counties[turn];
    const key = `${county.county}, ${county.state}`;
    job.phase = "pulling off-market";
    try {
      const batchId = await autopilotBatchId({ store, locationId, market: `Off-market · ${key}` });
      const query = { ...pullQuery(oa, key), county: county.county, state: county.state, status: "Inactive", maxRequests: reqs, ...(batchId ? { batchId } : {}) };
      const pull = await deps.runPull(locationId, client, query, { maxRequestsCap: MAX_REQUESTS_PER_RUN });
      const used = Number(pull.requestsUsed) || 0;
      left -= used;
      const rows = typeof store.listOutreachPickable === "function"
        ? await store.listOutreachPickable(locationId, { batchId: pull.batchId, limit: 1000 })
        : await store.listOutreachAgents(locationId, { batchId: pull.batchId, status: "new", limit: 1000 });
      const fresh = pickAgentsToImport(rows, { cap: MAX_DAILY_CAP, requireDistress: false, maxPrice: oa.maxListPrice, propertyTypes: oa.propertyTypes, maxYearBuilt: marketRules(oa, key).maxYearBuilt })
        .filter((r) => r.doc?.hook?.offMarket && !seenAgents.has(r.agentKey) && !seenPhones.has(String(r.doc?.phone)));
      for (const r of fresh) { seenAgents.add(r.agentKey); seenPhones.add(String(r.doc?.phone)); }
      if (fresh.length) groups.push({ key, batchId: pull.batchId, picked: fresh, limit: seats, offMarket: true });
      pickedTotal += Math.min(fresh.length, seats);
      job.offMarket = { county: key, requestsUsed: used, listingsKept: Number(pull.listingsKept) || 0, candidates: rows.length, picked: fresh.length, seats };
      job.warnings.push(...(pull.warnings || []).filter((w) => /^off-market/.test(w)).slice(0, 2).map((w) => `${key}: ${w}`));
    } catch (e) {
      job.warnings.push(`${key}: the off-market pull failed (${String(e?.message || e).slice(0, 120)}) — moving on`);
    }
    await savePages({ ...pages, expiredTurn: (turn + 1) % n });
    await beat();
  }
  // 1c. The recent listers (2026-10-26, outreachAutopilot.recentListers, off
  // by default): one of its counties a run, in turn, read for listings that
  // came down in the last `withinDays`, sold or not, by the county's own
  // rules, into "Autopilot · Recent · Pierce, WA". `share` of the day's
  // requests, from where its last read stopped; the regular pull always
  // keeps at least one. Anyone already in GHL is skipped by the import, so
  // only agents new to us hear the past-listing text.
  const rl = oa.recentListers;
  if (rl.enabled && rl.share > 0 && rl.counties.length && left > 1) {
    const reqs = Math.max(1, Math.min(left - 1, Math.round(perRun * rl.share / 100) || 1));
    const turn = (Number(pages?.recentTurn) || 0) % rl.counties.length;
    const county = rl.counties[turn];
    const key = `${county.county}, ${county.state}`;
    job.phase = "pulling recent listers";
    try {
      const r = await readRecentListers({ oa, county, reqs, pages, locationId, client, store, deps });
      left -= r.used;
      const fresh = r.fresh.filter((x) => !seenAgents.has(x.agentKey) && !seenPhones.has(String(x.doc?.phone)));
      for (const x of fresh) { seenAgents.add(x.agentKey); seenPhones.add(String(x.doc?.phone)); }
      const seats = Math.max(1, Math.round(oa.dailyCap * rl.share / 100));
      if (fresh.length) groups.push({ key, batchId: r.batchId, picked: fresh, limit: seats, pastListing: true });
      pickedTotal += Math.min(fresh.length, seats);
      job.recentListers = { ...r.stats, picked: fresh.length };
      job.warnings.push(...r.warnings);
      // The turn stays on a county with pages left and people in them.
      await savePages({ ...(pages || {}), recentTurn: r.next && fresh.length ? turn : (turn + 1) % rl.counties.length,
        recent: { ...(pages?.recent || {}), [key]: { offset: r.next, sig: r.sig } } });
    } catch (e) {
      job.warnings.push(`${key}: the recent listers' pull failed (${String(e?.message || e).slice(0, 120)}) — moving on`);
      await savePages({ ...(pages || {}), recentTurn: (turn + 1) % rl.counties.length });
    }
    await beat();
  }
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
    // By the market's own rules where it has them (Bend).
    const rules = marketRules(oa, key);
    const fresh = pickAgentsToImport(rows, { cap: MAX_DAILY_CAP, requireDistress: oa.requireDistress,
      maxPrice: oa.maxListPrice, distressRule: rules.distressRule, propertyTypes: oa.propertyTypes,
      maxYearBuilt: rules.maxYearBuilt, turnkeyShare: rules.turnkeyShare, staleDom: rules.staleDom })
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
    // A county in another state (Deschutes, OR for Bend, 2026-10-21) is read
    // after it by its own circle, as the "counties" coverage reads one — a
    // whole second state for one county would be most of a lap's requests —
    // and the state's read leaves a request for each.
    const others = oa.counties.filter((c) => c.state !== oa.counties[0].state);
    left -= await readState({ oa, job, locationId, client, store, deps, now, left: Math.max(1, left - others.length), querySig, pickFrom, beat });
    if (others.length) {
      // readState moved the state's place on the cursor: read it again, or
      // saving a county's place below would put the old one back.
      pages = (await store.getJobCursor?.(locationId, PAGES_CURSOR).catch(() => null))?.doc || pages || {};
      if (pages.query !== querySig) pages = { ...pages, offsets: {}, totals: {} };
    }
    for (const county of others) {
      if (left <= 0) {
        job.warnings.push(`${county.county}, ${county.state}: no requests left this run — next run`);
        continue;
      }
      const key = `${county.county}, ${county.state}`;
      job.phase = "pulling";
      job.county = key;
      const sig = marketSig(oa, key);
      const query = { ...pullQuery(oa, key), ...keepTurnkeyFor(oa, key), county: county.county, state: county.state,
        offset: sig === (pages.sigs?.[key] ?? sig) ? Number(pages.offsets?.[key]) || 0 : 0, maxRequests: Math.max(1, left) };
      const batchId = await autopilotBatchId({ store, locationId, market: key }).catch(() => undefined);
      if (batchId) query.batchId = batchId;
      let pull;
      try {
        pull = await deps.runPull(locationId, client, query, { maxRequestsCap: MAX_REQUESTS_PER_RUN });
      } catch (e) {
        const why = String(e?.message || e).slice(0, 120);
        job.tried.push({ county: key, error: why });
        job.warnings.push(`${key}: the pull failed (${why}) — moving on`);
        continue;
      }
      const used = Number(pull.requestsUsed) || 0;
      left -= used;
      if (job.pull) job.pull.requestsUsed += used;
      job.warnings.push(...(pull.warnings || []).filter((w) => !/^county filter kept [1-9]/.test(w)).slice(0, 6));
      await beat();
      const { rows, fresh } = await pickFrom(key, pull.batchId);
      job.tried.push({ county: key, candidates: rows.length, picked: fresh.length, requestsUsed: used,
        listings: Number(pull.listingsFetched) || 0, agentsNew: Number(pull.agentsNew) || 0 });
      await savePages({
        ...pages,
        offsets: { ...(pages.offsets || {}), [key]: Number(pull.nextOffset) || 0 },
        totals: { ...(pages.totals || {}), [key]: pull.totalCount ?? null },
        sigs: { ...(pages.sigs || {}), [key]: sig },
      });
    }
  } else for (let attempt = 0; attempt < n; attempt++) {
    // Stop before a pull, not after it: a run with nothing left spends nothing.
    if (attempt > 0 && (left <= 0 || pickedTotal >= wanted)) break;
    job.phase = "pulling";
    let county = null;
    let key = null;
    const turn = (startTurn + attempt) % n;
    if (oa.counties.length) {
      county = oa.counties[turn];
      key = `${county.county}, ${county.state}`;
    }
    const sig = marketSig(oa, key);
    const query = { ...pullQuery(oa, key), ...keepTurnkeyFor(oa, key), maxRequests: Math.max(1, left) };
    if (county) {
      query.county = county.county; query.state = county.state;
      query.offset = sig === (pages.sigs?.[key] ?? sig) ? Number(pages.offsets?.[key]) || 0 : 0;
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
        sigs: { ...(pages.sigs || {}), [key]: sig },
        lastCounty: key,
      });
    }
    if (!county) break;
  }
  job.county = groups.map((g) => g.key).filter(Boolean).join(" · ") || job.county;
  // 2b. The listing itself says it needs work (outreachAutopilot.distressCheck).
  if (oa.distressCheck.enabled && groups.length) {
    job.phase = "checking listings";
    await screenPicked({ groups, oa, job, locationId, store, deps, now, beat });
    job.picked = groups.reduce((n, g) => n + g.picked.length, 0);
  }
  const picked = groups.flatMap((g) => g.picked);
  job.results = picked.map((r) => ({ agentKey: r.agentKey, name: r.doc?.name || "", hook: r.doc?.hook?.address || "", distressed: r.doc?.distressedCount || 0 }));
  if (!picked.length) {
    job.warnings.push(job.screen ? "no picked listing read as needing work today" : "no county had anyone new to text today");
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
    const room = Math.min(oa.dailyCap - made, g.limit ?? Infinity);
    if (oa.dailyCap - made <= 0) break;
    // The listing check can leave a county with nobody (2026-10-26: the import
    // refused the empty list and the whole run failed).
    if (room <= 0 || !g.picked.length) continue;
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

/**
 * stateRead(oa, counties) → { query, rules, sig }
 *
 * What the statewide read asks RentCast for, and how each county's share of
 * it is filed. With no county of rules of its own it is the sweep's query, as
 * before, and `rules` is empty. Once one has them (Pierce, 2026-10-26: a house
 * sitting 60 days counts there, and 14 days on the market is enough), the one
 * query has to be the loosest of them — the fewest days on the market, no
 * year bound if any county has none — and every county is filed by its own
 * rules (routes/outreach.js runStatewidePull), so King still needs its 21
 * days and a cut or an older house. `sig` is the read's place on the cursor:
 * new rules start the lap over once.
 */
export function stateRead(oa, counties = []) {
  const base = pullQuery(oa);
  const keys = counties.map((c) => `${c.county}, ${c.state}`);
  if (!keys.some((k) => oa.markets?.[k])) return { query: base, rules: {}, sig: null };
  const rules = {};
  for (const k of keys) {
    const r = marketRules(oa, k);
    rules[k] = { minDom: Math.max(1, r.minDaysOnMarket || 1), maxYearBuilt: r.maxYearBuilt || 0,
      ...(r.distressRule ? { distressRule: r.distressRule } : {}), ...(r.staleDom ? { staleDom: r.staleDom } : {}) };
  }
  const minDom = Math.min(...keys.map((k) => rules[k].minDom));
  const years = keys.map((k) => rules[k].maxYearBuilt);
  const { yearBuilt: _y, ...rest } = base;
  const query = { ...rest, daysOld: `${minDom}:*`, ...(years.includes(0) ? {} : { yearBuilt: `*:${Math.max(...years)}` }) };
  return { query, rules, sig: JSON.stringify({ query, rules }) };
}

/**
 * readRecentListers({ oa, county, reqs, pages, locationId, client, store, deps })
 *   → { key, batchId, sig, next, used, rows, fresh, stats, warnings }
 *
 * One read of a county's recent listers (outreachAutopilot.recentListers):
 * RentCast's "Inactive" listings by the county's own rules, listed within
 * about a year of the window, from where the last read stopped (`pages.recent`,
 * kept only while the query is the same), into "Autopilot · Recent · Pierce,
 * WA"; then the agents in it the pick would text (new to us, a phone, a
 * listing that meets the county's distress rule). Saves nothing itself.
 */
export async function readRecentListers({ oa, county, reqs = 1, pages = null, locationId, client, store = defaultStore, deps = {} }) {
  const rl = oa.recentListers;
  const key = `${county.county}, ${county.state}`;
  const rules = marketRules(oa, key);
  // Listed in about the last year, at any age: how long a house that has
  // already come down sat says nothing about its agent.
  const ask = { ...pullQuery(oa, key), daysOld: `1:${rl.withinDays + 270}`,
    county: county.county, state: county.state, status: "Inactive", recent: true, withinDays: rl.withinDays };
  const sig = JSON.stringify(ask);
  const place = pages?.recent?.[key]?.sig === sig ? pages.recent[key] : {};
  const batchId = await autopilotBatchId({ store, locationId, market: `Recent · ${key}` });
  const pull = await deps.runPull(locationId, client, { ...ask, offset: Number(place.offset) || 0, maxRequests: Math.max(1, reqs), ...(batchId ? { batchId } : {}) },
    { maxRequestsCap: MAX_REQUESTS_PER_RUN });
  const rows = typeof store.listOutreachPickable === "function"
    ? await store.listOutreachPickable(locationId, { batchId: pull.batchId, limit: 1000 })
    : await store.listOutreachAgents(locationId, { batchId: pull.batchId, status: "new", limit: 1000 });
  const fresh = pickAgentsToImport(rows, { cap: MAX_DAILY_CAP, requireDistress: oa.requireDistress, maxPrice: oa.maxListPrice, distressRule: rules.distressRule,
    propertyTypes: oa.propertyTypes, maxYearBuilt: rules.maxYearBuilt, staleDom: rules.staleDom })
    .filter((r) => r.doc?.hook?.pastListing);
  const used = Number(pull.requestsUsed) || 0;
  const next = Number(pull.nextOffset) || 0;
  return {
    key, batchId: pull.batchId, sig, next, used, rows, fresh,
    stats: { county: key, requestsUsed: used, listings: Number(pull.listingsFetched) || 0, listingsKept: Number(pull.listingsKept) || 0,
      candidates: rows.length, offset: Number(place.offset) || 0, nextOffset: next, totalCount: pull.totalCount ?? null },
    warnings: (pull.warnings || []).filter((w) => /^recent listers/.test(w)).slice(0, 2).map((w) => `${key}: ${w}`),
  };
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
  // The first county's state. Counties in other states are the caller's.
  const state = oa.counties[0].state;
  const counties = oa.counties.filter((c) => c.state === state);
  // A county of rules of its own changes what the read asks for and its place.
  const read = stateRead(oa, counties);
  const sig = read.sig || querySig;
  const cursor = (await store.getJobCursor?.(locationId, PAGES_CURSOR).catch(() => null))?.doc || {};
  const place = cursor.statewide?.query === sig ? cursor.statewide : {};
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
    ...read.query, ...keepTurnkeyFor(oa), statewide: true, state, batchIds, offset, maxRequests: Math.max(1, left),
    counties: counties.map((c) => (read.rules[`${c.county}, ${c.state}`] ? { ...c, rules: read.rules[`${c.county}, ${c.state}`] } : c)),
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
      statewide: { offset: next, total: pull.totalCount ?? null, query: sig, ...(next ? { lapAt: place.lapAt || null } : { lapAt: iso(now) }) },
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
 * `hour` defaults to the saved one (outreachAutopilot.hour, 9am since
 * 2026-10-21 by Matt's ask; the env default 10 until it is set).
 *
 * The tick's decision. Gates: the hour, the toggle, a RentCast key, no run
 * in progress, and the durable cursor at least MIN_GAP_MS old.
 */
export async function maybeStartOutreachSweep({ locationId, client, saved = {}, store = defaultStore, deps = {}, hour = null, now = Date.now() }) {
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  // The hour in Settings (outreachAutopilot.hour), unless the caller names one.
  hour = hour ?? oa.hour;
  const h = workHour(now);
  if (h < hour || h >= hour + RETRY_WINDOW_HOURS) return false;
  if (!oa.enabled) return false;
  if (!isWorkday(now, WORK_TZ, oa.days)) return false;
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
