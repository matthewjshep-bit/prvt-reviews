// routes/outreach.js — Agent Outreach: pull active MLS listings from RentCast,
// group them by listing agent, score each listing for "fixer-ness" (the best
// one becomes the agent's outreach hook), flag agents already in GHL, and bulk
// import selected agents as GHL contacts (custom fields + tag — the tag fires
// the outreach workflow inside GHL). Mounted at /api/outreach.
//
//   GET  /api/outreach/batches                       saved batches (named pull cohorts)
//   POST /api/outreach/batches                       create a batch
//   POST /api/outreach/batches/:batchId/rename       rename (changes the import tag)
//   DELETE /api/outreach/batches/:batchId            delete batch + its agents/listings
//   GET  /api/outreach/agents                        one batch's agents + request-meter usage
//   GET  /api/outreach/agents/:agentKey/listings     one agent's listings, ranked
//   POST /api/outreach/pull                          fetch + score + persist into a batch
//   POST /api/outreach/import                        bulk import to GHL (dry-run by default)
//   POST /api/outreach/agents/:agentKey/status       skip / unskip
//
// Agents and listings are scoped to a BATCH (a saved, named pull cohort);
// batchId/batch_id defaults to the most recent batch so the cron pull keeps
// working without one. The GHL import tag derives from the batch name.
//
// RentCast is billed per REQUEST (up to 500 listings each, free tier 50/mo),
// so pulls carry a hard request budget and a 24h cache, and every pull is
// recorded to power the month-to-date meter in the UI.

import express from "express";
import { planAgentPulse, startAgentPulse, getAgentPulseJob, previewAgentPulse, startLeaveDrips, getLeaveDripsJob, pulseWorkflows, CURSOR_NAME as AGENT_PULSE_CURSOR } from "../agent-pulse.js";
import { ensureProfile, learnFacts, recordEvent, recordEvents } from "../contact-record.js";
import { store } from "../store.js";
import { mapPool } from "../map-pool.js";
import { scoreListing, medianPricePerSqft, distressSignals, meetsDistressRule, OLD_HOUSE_YEAR, medianIndex } from "../outreach-score.js";
import { zillowUrl } from "../shared/us-address.js";
import { findCounty, listingInCounty } from "../shared/us-counties.js";
import { countyName } from "../shared/outreach-opener.js";
import { isRuralLot, RURAL_LOT_ACRES } from "../shared/asset-type.js";
import { previewProactive, machineRoomToday } from "../reply-agent.js";
import { fetchZillowAgentContacts } from "../rehab-scan.js";
import { streetKey } from "../comps-zillow.js";
import { OUTREACH_FIELDS } from "../field-registry.js";
import { SUBJECT_PROPERTY_FIELD, seedSubjectProperty } from "../enrich.js";
import {
  startOutreachSweep, getOutreachJob, publicOutreachJob, normalizeOutreachAutopilot, workflowIdFrom, MAX_DAILY_CAP, PROPERTY_TYPES,
  CURSOR_NAME as OUTREACH_CURSOR, OUTREACH_SWEEP_HOUR, WORK_TZ, rentcastBudget,
} from "../outreach-sweep.js";
import {
  startOutreachFollowUp, getOutreachFollowUpJob, CURSOR_NAME as FOLLOWUP_CURSOR, OUTREACH_FOLLOWUP_HOUR,
} from "../outreach-followup.js";

// Subject Property is created and seeded here but OWNED by the conversation
// (see its definition in enrich.js) — hence its own list rather than a new
// entry in OUTREACH_FIELDS, which the import rewrites wholesale every time.
const IMPORT_FIELDS = [...OUTREACH_FIELDS, SUBJECT_PROPERTY_FIELD];
import {
  findDuplicateContact, createContact, getContact, updateContact,
  addContactTags, findOrCreateCustomFieldByKey, getLastMessageDate, addContactToWorkflow,
} from "../ghl.js";

const OUTREACH_TAG = process.env.OUTREACH_TAG || "agent-outreach";
const OUTREACH_IMPORTS_ENABLED = process.env.OUTREACH_IMPORTS_ENABLED === "true";
// The agent check-in sends only when the broker may send anything at all.
const PULSE_SENDS_LIVE = process.env.CARD_SENDS_ENABLED === "true";

// Contact custom fields written on import live in the shared registry so the
// Fields Manager can visualize them alongside the offer + enrichment fields.

// How long a "not in GHL" answer from a pull is trusted before it's asked again.
const GHL_RECHECK_DAYS = 7;
// A first text that didn't go is tried again by the next sweeps: this many
// times in all, for this many days.
const FIRST_TEXT_TRIES = 3;
// A hook saved before 2026-10-05 has no priceCut; its score says so instead.
const priceCutOf = (h) => Boolean(h?.priceCut || (Array.isArray(h?.components) && h.components.some((c) => c?.key === "cuts" && Number(c.points) > 0)));
const FIRST_TEXT_RETRY_DAYS = 7;
// A first text with no draft this long after the import was lost to a restart.
const FIRST_TEXT_LOST_AFTER_MS = 2 * 3600 * 1000;

/* ---------- normalization ---------- */

const normEmail = (s) => {
  const e = String(s || "").trim().toLowerCase();
  return e.includes("@") ? e : "";
};
// Last 10 digits — strips country code and formatting.
const normPhone = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};
// The same person on Zillow's page as on RentCast's listing: the same last name.
const lastNameOf = (s) => String(s || "").toLowerCase().replace(/[^a-z\s'-]/g, " ").trim().split(/\s+/).filter(Boolean).at(-1) || "";
export const sameLastName = (a, b) => Boolean(lastNameOf(a)) && lastNameOf(a) === lastNameOf(b);

const slug = (s) =>
  String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function agentIdentity(listing) {
  const a = listing.listingAgent || {};
  const email = normEmail(a.email);
  const phone = normPhone(a.phone);
  const name = String(a.name || "").trim();
  const office = String(listing.listingOffice?.name || "").trim();
  const agentKey = email ? `e:${email}` : phone ? `p:${phone}` : name ? `n:${slug(name)}|${slug(office)}` : null;
  return { agentKey, email, phone, name, office };
}

const listingKey = (l) => {
  if (l.mlsName && l.mlsNumber) return `${l.mlsName}:${l.mlsNumber}`;
  return `a:${slug(l.formattedAddress || `${l.addressLine1} ${l.city} ${l.state} ${l.zipCode}`)}`;
};

const splitName = (name) => {
  const parts = String(name || "").trim().split(/\s+/);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
};

// GHL stores phones as E.164 — send +1XXXXXXXXXX, not bare digits.
const e164 = (phone) => (phone ? `+1${normPhone(phone)}` : "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a GHL call on 429 (2s, then 4s). Other errors propagate.
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.status !== 429 || attempt >= 2) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

/* ---------- RentCast ---------- */

// Overridable so tests can point at a local mock instead of spending real
// free-tier requests.
// Where a county's houses actually are, by county FIPS: a circle over the
// population centre rather than the county's geometric middle (King's is in
// the Cascades). Counties not listed fall back to the whole-county circle.
export const METRO_CIRCLES = {
  "53033": { lat: 47.53, lng: -122.22, radiusMi: 16 },   // King: Seattle, Bellevue, Renton, Kent, Shoreline, Federal Way's north edge
  "53053": { lat: 47.16, lng: -122.40, radiusMi: 13 },   // Pierce: Tacoma, Lakewood, University Place, Puyallup, Spanaway, Graham, Bonney Lake
  "53061": { lat: 47.95, lng: -122.18, radiusMi: 14 },   // Snohomish: Everett, Lynnwood, Marysville, Lake Stevens, Mill Creek, Monroe
  "53035": { lat: 47.60, lng: -122.65, radiusMi: 12 },   // Kitsap: Bremerton, Silverdale, Port Orchard, Poulsbo
  "53067": { lat: 47.02, lng: -122.87, radiusMi: 12 },   // Thurston: Olympia, Lacey, Tumwater
  "53063": { lat: 47.66, lng: -117.35, radiusMi: 14 },   // Spokane: Spokane, Spokane Valley, Liberty Lake
};

const RENTCAST_BASE = process.env.RENTCAST_BASE_URL || "https://api.rentcast.io/v1";

// A 500-listing page of a whole county can take RentCast well past 15s
// (2026-09-15: the 10am King pull timed out and no outreach went out).
// 2026-09-17: 60s wasn't enough either — a filtered whole-county circle takes
// RentCast about a minute (King came back just under, Pierce timed out twice
// in a row). The sweep is a background job with nobody waiting on it.
const RENTCAST_TIMEOUT_MS = Number(process.env.RENTCAST_TIMEOUT_MS || 150000);
const RENTCAST_RETRY_MS = Number(process.env.RENTCAST_RETRY_MS || 3000);

// One page of sale listings. Bare array in practice; tolerate a wrapper.
// A timeout, a dropped connection, a 429 or a 5xx is tried once more; a
// refusal (bad key, bad query) is not.
async function rentcastPage(apiKey, params) {
  for (let attempt = 0; ; attempt++) {
    // The second try asks for less: no total count (a count is a second scan
    // of the whole circle) and a shorter page. RentCast's own gateway gave up
    // (504) on the full Pierce query three times running on 2026-09-17.
    const light = attempt > 0;
    const limit = light ? 200 : 500;
    const { includeTotalCount, ...rest } = params;
    const qs = new URLSearchParams({ status: "Active", limit: String(limit), ...(light ? rest : params) });
    try {
      const r = await fetch(`${RENTCAST_BASE}/listings/sale?${qs}`, {
        headers: { "X-Api-Key": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(RENTCAST_TIMEOUT_MS),
      });
      if (!r.ok) {
        const detail = (await r.text()).slice(0, 300);
        throw Object.assign(new Error(`RentCast ${r.status}`), { http: 502, detail, retryable: r.status === 429 || r.status >= 500 });
      }
      const data = await r.json();
      // X-Total-Count arrives when includeTotalCount=true: how many listings
      // match in all, so the sweep knows how many pages a county has.
      const header = r.headers.get("x-total-count");
      const total = header != null && header !== "" && Number.isFinite(Number(header)) ? Number(header) : null;
      return { listings: Array.isArray(data) ? data : data.listings || [], total, limit };
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      const retryable = e?.retryable || timedOut || e?.name === "TypeError";
      if (retryable && attempt < 1) { await sleep(RENTCAST_RETRY_MS); continue; }
      if (timedOut) throw Object.assign(new Error(`RentCast didn't answer in ${Math.round(RENTCAST_TIMEOUT_MS / 1000)}s (tried twice)`), { http: 504 });
      throw e;
    }
  }
}
export { rentcastPage as _rentcastPage };

// `firstTouch({ locationId, client, contactId, hook, name })` is injected by
// the broker: it starts the Conversation AI's cold open for one imported
// agent. The import never sends anything itself — the draft lands in the
// outbox like any other outbound, and goes on its own only if outreach_open
// is on the allowlist. Absent (tests), the import just tags.
export default function createOutreachRouter({ resolveLocation, firstTouch = null }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("outreach error:", code, err.message, err.detail || "");
    res.status(code).json({ error: err.message, detail: err.detail });
  };

  // 24h pull cache: params → raw listings. A cache hit costs 0 RentCast requests.
  const pullCache = new Map();
  const PULL_TTL = 24 * 3600 * 1000;
  const PULL_CACHE_MAX_LISTINGS = 40000;
  // A ZIP needs this many priced listings in a statewide read to be its own
  // market for "cheap"; a thinner one is measured against its county.
  const STATEWIDE_ZIP_MEDIAN_MIN = 15;

  async function getSettings(locationId) {
    return (await store.getOfferSettings(locationId)) || {};
  }

  /* ---------- batches ---------- */

  const sanitizeTag = (s) =>
    String(s || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  // Stable GHL tag for a batch, derived from its name: batch "Queen Anne
  // fixers" → "agent-outreach-queen-anne-fixers". Same tag across every import
  // session from the batch.
  const batchTagFor = (batch) => sanitizeTag(`${OUTREACH_TAG}-${batch.name}`) || OUTREACH_TAG;

  const shortDate = () => new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  // "98119, 98109 · Aug 4"  /  "King County, WA · Aug 4"  /  "Seattle, WA · Aug 4"
  function autoBatchName({ zips, county, city, state }) {
    const market = zips?.length
      ? zips.slice(0, 3).join(", ") + (zips.length > 3 ? ` +${zips.length - 3}` : "")
      : [county || city, state].filter(Boolean).join(", ") || "Pull";
    return `${market} · ${shortDate()}`;
  }

  // Resolve the batch a request operates on: explicit id must exist (404);
  // otherwise the most recent batch; otherwise create one when createName is
  // given (the pull path — keeps the batchless cron POST working), else null.
  async function resolveBatch(locationId, batchId, { createName = null } = {}) {
    if (batchId) {
      const b = await store.getOutreachBatch(locationId, String(batchId));
      if (!b) throw Object.assign(new Error("unknown batch"), { http: 404 });
      return b;
    }
    const [latest] = await store.listOutreachBatches(locationId);
    if (latest) return latest;
    if (createName) return store.createOutreachBatch(locationId, { name: createName, autoNamed: true });
    return null;
  }

  /* ---------- pull ---------- */

  // Resolve pull targets from the request body, falling back to the location's
  // saved defaults so a future Render Cron can POST with just location_id.
  // The Pull button's ceiling. The daily sweep passes its own (a paid plan's
  // month spread over the workdays left); a person pressing Pull keeps ten.
  const PULL_BUTTON_MAX_REQUESTS = 10;

  function pullParams(body, settings, maxRequestsCap = PULL_BUTTON_MAX_REQUESTS) {
    const zips = (Array.isArray(body.zipCodes) ? body.zipCodes.join(",") : String(body.zipCodes || settings.outreachZips || ""))
      .split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z));
    const county = String(body.county ?? settings.outreachCounty ?? "").trim();
    const city = String(body.city ?? settings.outreachCity ?? "").trim();
    const state = String(body.state ?? settings.outreachState ?? "").trim().toUpperCase();
    // RentCast ranges are "min:max" with * for open (daysOld "45:*" = listed
    // at least 45 days ago). A bare number is a MAXIMUM — it keeps fresh
    // listings and drops the stalest, the opposite of what distress wants.
    const daysOldRaw = String(body.daysOld ?? "").trim();
    const daysOld = /^(\d{1,3}|\*):(\d{1,3}|\*)$/.test(daysOldRaw)
      ? daysOldRaw
      : Math.min(365, Math.max(1, parseInt(body.daysOld, 10) || parseInt(settings.outreachDaysOld, 10) || 180));
    // One type, or several joined with "|" — each matched to RentCast's spelling.
    const propertyType = String(body.propertyType || "").split("|")
      .map((t) => PROPERTY_TYPES.find((p) => p.toLowerCase() === t.trim().toLowerCase()))
      .filter(Boolean).join("|");
    const yearBuiltRaw = String(body.yearBuilt ?? "").trim();
    const yearBuilt = /^(\d{4}|\*):(\d{4}|\*)$/.test(yearBuiltRaw) ? yearBuiltRaw : "";
    // Where to start in the result list — the sweep walks a county page by
    // page across days instead of re-reading page one.
    const offset = Math.max(0, parseInt(body.offset, 10) || 0);
    // County pulls cover a whole market in 500-listing pages, so they get a
    // higher request ceiling and a bigger default than zip/city pulls.
    const maxRequests = Math.min(maxRequestsCap, Math.max(1, parseInt(body.maxRequests, 10) || (county && !zips.length ? 5 : 3)));
    // Post-fetch filters (applied to the cohort, not the RentCast query —
    // RentCast can't filter on price or days-on-market server-side).
    // distressOnly keeps listings with ANY distress signal (stale ≥ staleDom
    // days, price-cut history, or ≤90% of median $/sqft) — OR semantics, the
    // signals are alternatives. Defaults ON so the batchless cron POST pulls
    // distressed cohorts. priceBandPct additionally trims to ±N% of the
    // pull's median price.
    const priceBandPct = Math.min(75, Math.max(0, parseInt(body.priceBandPct, 10) || 0));
    const distressOnly = body.distressOnly !== false;
    const staleDom = Math.min(365, Math.max(1, parseInt(body.staleDom, 10) || 45));
    // Newer builds are never fixers — maxYearBuilt drops anything built after
    // it. Listings with no yearBuilt are KEPT (RentCast omits it on plenty of
    // older homes; dropping them would cost real leads) and counted in the
    // warning so the omission is visible.
    const rawMaxYear = parseInt(body.maxYearBuilt ?? settings.outreachMaxYearBuilt, 10);
    const maxYearBuilt = rawMaxYear >= 1800 && rawMaxYear <= 2100 ? rawMaxYear : 0;
    // A price ceiling — asked of RentCast (price=*:N) and checked again after.
    const rawMaxPrice = Math.round(Number(body.maxPrice));
    const maxPrice = Number.isFinite(rawMaxPrice) && rawMaxPrice > 0 ? rawMaxPrice : 0;
    // "any" (stale, cut, or cheap), "cut-or-cheap", or "cut-or-old": the
    // sweep's pages are all stale by query, so there it takes a price cut or
    // an older house (a cheap $/sqft found finished houses in slow towns).
    const distressRule = ["cut-or-cheap", "cut-or-old"].includes(body.distressRule) ? body.distressRule : "any";
    return { zips, county, city, state, daysOld, propertyType, yearBuilt, offset, maxRequests, priceBandPct, distressOnly, staleDom, maxYearBuilt, maxPrice, distressRule };
  }

  // The Zillow phone lookup for one sweep pull: on or off, how many, and the
  // Apify token — `budget.left` is shared by every county the pull files.
  function zillowFor(settings) {
    const z = normalizeOutreachAutopilot(settings.outreachAutopilot).zillowLookup;
    return z.enabled ? { enabled: true, token: String(settings.apifyToken || "").trim(), budget: { left: z.perRun } } : null;
  }

  /**
   * fetchListings({ locationId, apiKey, targets, common, startOffset, maxRequests, paging, warnings })
   *   → { listings, requestsUsed, cached, nextOffset, totalCount }
   *
   * The RentCast pages for `targets`, from `startOffset`, within the request
   * budget — or the cached copy of the same read.
   */
  async function fetchListings({ locationId, apiKey, targets, common, startOffset, maxRequests, paging, warnings }) {
    const cacheKey = `${locationId}|${JSON.stringify({ targets, common, startOffset, maxRequests: paging ? maxRequests : null })}`;
    let listings;
    let requestsUsed = 0;
    let cached = false;
    // Where the NEXT page starts (0 = this market is read to the end) and how
    // many listings match in all. Reported for the last target pulled.
    let nextOffset = 0;
    let totalCount = null;
    const hit = pullCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < PULL_TTL) {
      listings = hit.listings;
      nextOffset = hit.nextOffset || 0;
      totalCount = hit.totalCount ?? null;
      cached = true;
    } else {
      listings = [];
      let budgetLeft = maxRequests;
      for (const [i, target] of targets.entries()) {
        let offset = i === 0 ? startOffset : 0;
        let moreAvailable = false;
        while (budgetLeft > 0) {
          budgetLeft--;
          requestsUsed++;
          const { listings: page, total, limit: pageLimit } = await rentcastPage(apiKey, { ...common, ...target, ...(offset ? { offset: String(offset) } : {}) });
          listings.push(...page);
          if (total != null) totalCount = total;
          moreAvailable = total != null ? offset + page.length < total && page.length > 0 : page.length >= (pageLimit || 500);
          offset += page.length;
          if (!moreAvailable) break; // last page for this target
        }
        nextOffset = moreAvailable ? offset : 0;
        if (moreAvailable && budgetLeft <= 0) {
          // Paging (the sweep) expects to stop mid-market and resume tomorrow.
          if (!paging) warnings.push(`request budget (${maxRequests}) ran out mid-market — results are truncated; raise max requests to get the rest`);
          break;
        }
        if (budgetLeft <= 0 && targets.indexOf(target) < targets.length - 1) {
          warnings.push(`request budget (${maxRequests}) exhausted before all zips were pulled — narrow the market or raise maxRequests`);
          break;
        }
      }
      if (listings.length) {
        pullCache.set(cacheKey, { ts: Date.now(), listings, nextOffset, totalCount });
        // At most 20 reads, and a ceiling on what they hold all together: one
        // statewide read alone can be tens of thousands of listings.
        let held = 0;
        for (const v of pullCache.values()) held += v.listings.length;
        while (pullCache.size > 1 && (pullCache.size > 20 || held > PULL_CACHE_MAX_LISTINGS)) {
          const [oldest, v] = pullCache.entries().next().value;
          held -= v.listings.length;
          pullCache.delete(oldest);
        }
      }
    }

    return { listings, requestsUsed, cached, nextOffset, totalCount };
  }

  /**
   * ingestCohort({ locationId, client, batch, listings, params, medianFor, warnings })
   *   → { pool, agentRows, agentsNew, medianPpsf, medianPrice }
   *
   * Everything after the fetch: the cohort's medians, the filters, the agents
   * and their best listing, phones we already hold, GHL matches — saved into
   * `batch`. `medianFor(listing)` is the $/sqft a listing is measured against;
   * without it, the pull's own median (a county or zip pull is one market).
   */
  async function ingestCohort({ locationId, client, batch, listings, params, medianFor = null, warnings }) {
    const { maxPrice, maxYearBuilt, distressOnly, distressRule, staleDom, priceBandPct, sweep = false, zillow = null, propertyType = "" } = params;
    const isDistressed = (sig) => meetsDistressRule(sig, distressRule);
    // Cohort medians come from the FULL pull (pre-filter) so they describe the
    // market, not the filtered slice.
    const medianPpsf = medianPricePerSqft(listings);
    // What each listing's $/sqft is measured against: the pull's own median,
    // or (statewide) its ZIP's or county's.
    const ppsfOf = medianFor || (() => medianPpsf);
    const prices = listings.map((l) => Number(l.price)).filter((p) => p > 0).sort((a, b) => a - b);
    const medianPrice = prices.length
      ? prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : 0;

    let pool = listings;
    if (maxPrice) {
      // RentCast was asked already; this catches a listing with no price, or
      // a cached page read before the cap existed.
      const before = pool.length;
      pool = pool.filter((l) => Number(l.price) > 0 && Number(l.price) <= maxPrice);
      warnings.push(`price cap ($${maxPrice.toLocaleString()}) kept ${pool.length} of ${before}`);
    }
    if (maxYearBuilt) {
      const before = pool.length;
      let unknownYear = 0;
      pool = pool.filter((l) => {
        const y = Number(l.yearBuilt) || 0;
        if (!y) { unknownYear++; return true; }
        return y <= maxYearBuilt;
      });
      warnings.push(
        `year built filter (${maxYearBuilt} or older) kept ${pool.length} of ${before}` +
        (unknownYear ? ` — ${unknownYear} with no year built were kept` : "")
      );
    }
    // The types asked for, checked on each listing: RentCast was asked
    // already, but a cached page can predate the setting (Matt, 2026-10-08:
    // no manufactured homes). A listing with no type is kept.
    if (propertyType) {
      const want = new Set(String(propertyType).split("|").map((t) => t.trim().toLowerCase()).filter(Boolean));
      const before = pool.length;
      pool = pool.filter((l) => !l.propertyType || want.has(String(l.propertyType).toLowerCase()));
      if (pool.length < before) warnings.push(`property type filter (${String(propertyType).replace(/\|/g, ", ")}) kept ${pool.length} of ${before}`);
    }
    // Rural: two acres or more (Matt, 2026-10-08) — harder to comp, and our
    // buyers don't want it, so it is never a reason to text an agent. RentCast
    // gives the lot in square feet; a listing with no lot on record is kept.
    {
      const before = pool.length;
      pool = pool.filter((l) => !isRuralLot(l.lotSize));
      if (pool.length < before) warnings.push(`rural filter (under ${RURAL_LOT_ACRES} acres) kept ${pool.length} of ${before}`);
    }
    if (distressOnly) {
      const before = pool.length;
      const medianWord = medianFor ? "its ZIP's (or county's) $/sqft median" : `$${Math.round(medianPpsf)}/sqft median`;
      pool = pool.filter((l) => isDistressed(distressSignals(l, { medianPpsf: ppsfOf(l), staleDom })));
      warnings.push(
        distressRule === "cut-or-old"
          ? `distress filter (price cut, or built before ${OLD_HOUSE_YEAR}) kept ${pool.length} of ${before}`
          : distressRule === "cut-or-cheap"
            ? `distress filter (price cut, or ≤90% of ${medianWord}) kept ${pool.length} of ${before}`
            : `distress filter (${staleDom}+ DOM, price cut, or ≤90% of ${medianWord}) kept ${pool.length} of ${before}`
      );
    }
    if (priceBandPct && medianPrice) {
      const lo = medianPrice * (1 - priceBandPct / 100);
      const hi = medianPrice * (1 + priceBandPct / 100);
      const before = pool.length;
      pool = pool.filter((l) => Number(l.price) >= lo && Number(l.price) <= hi);
      warnings.push(`price band ±${priceBandPct}% of $${Math.round(medianPrice).toLocaleString()} median kept ${pool.length} of ${before}`);
    }

    // Group the FULL pull by agent — filters decide which agents qualify and
    // which listing becomes the hook, but activity counts (listingCount) must
    // reflect the agent's whole book of business in this market.
    const qualifying = new Set(pool);
    const byAgent = new Map();
    let droppedNoAgent = 0;
    for (const l of listings) {
      const idc = agentIdentity(l);
      if (!idc.agentKey) { droppedNoAgent++; continue; }
      const { score, components } = scoreListing(l, { medianPpsf: ppsfOf(l) });
      const { stale, cut, cheap, old } = distressSignals(l, { medianPpsf: ppsfOf(l), staleDom });
      const key = listingKey(l);
      const address = l.formattedAddress || [l.addressLine1, l.city, l.state, l.zipCode].filter(Boolean).join(", ");
      const docListing = {
        address, city: l.city, state: l.state, zip: l.zipCode, county: l.county || "",
        price: l.price, daysOnMarket: l.daysOnMarket, listedDate: l.listedDate,
        yearBuilt: l.yearBuilt, sqft: l.squareFootage, propertyType: l.propertyType,
        beds: l.bedrooms ?? null, baths: l.bathrooms ?? null, lotSize: l.lotSize ?? null,
        mlsName: l.mlsName, mlsNumber: l.mlsNumber, score, components,
        distress: { stale, cut, cheap, old }, qualifies: qualifying.has(l),
      };
      const g = byAgent.get(idc.agentKey) || { identity: idc, listings: [] };
      // Prefer the richest identity seen (a later listing may add email/phone).
      g.identity = {
        agentKey: idc.agentKey,
        email: g.identity.email || idc.email,
        phone: g.identity.phone || idc.phone,
        name: g.identity.name || idc.name,
        office: g.identity.office || idc.office,
      };
      g.listings.push({ listingKey: key, ...docListing });
      byAgent.set(idc.agentKey, g);
    }
    if (droppedNoAgent) warnings.push(`${droppedNoAgent} listing(s) had no agent identity and were skipped`);

    // Merge with stored rows (preserve ghl match + import status), then check
    // GHL for the agents we haven't matched yet. An agent joins the batch only
    // when at least one of their listings survived the filters; the hook is
    // their best-scoring qualifying listing, while listingCount/listingRows
    // cover their full book so activity stays visible.
    const agentRows = [];
    const listingRows = [];
    let agentsNew = 0;
    let agentsExcluded = 0;
    for (const [agentKey, g] of byAgent) {
      const qual = g.listings.filter((x) => x.qualifies);
      if (!qual.length) { agentsExcluded++; continue; }
      const stored = await store.getOutreachAgent(locationId, batch.id, agentKey);
      if (!stored) agentsNew++;
      const officePhone = normPhone(
        listings.find((l) => agentIdentity(l).agentKey === agentKey)?.listingOffice?.phone
      );
      const hook = qual.slice().sort((a, b) => b.score - a.score)[0];
      for (const { listingKey: lk, ...docListing } of g.listings)
        listingRows.push({ listingKey: lk, agentKey, doc: docListing });
      agentRows.push({
        agentKey,
        stored,
        doc: {
          name: g.identity.name, ...splitName(g.identity.name),
          phone: g.identity.phone, email: g.identity.email,
          brokerage: g.identity.office, officePhone,
          ghl: stored?.doc?.ghl || { contactId: null, matchedBy: null, checkedAt: null },
          hook: {
            listingKey: hook.listingKey, address: hook.address, price: hook.price,
            // The county is what the first text names (shared/outreach-opener.js).
            county: hook.county || "", city: hook.city || "",
            // What the first text may notice about the house (shared/outreach-opener.js houseDetails).
            sqft: hook.sqft ?? null, beds: hook.beds ?? null, lotSize: hook.lotSize ?? null, priceCut: Boolean(hook.distress?.cut),
            dom: hook.daysOnMarket, propertyType: hook.propertyType, yearBuilt: hook.yearBuilt,
            score: hook.score, components: hook.components,
          },
          listingCount: g.listings.length,
          // Only listings that passed the filters count — a distressed listing
          // over the price cap is not a reason to text this agent.
          distressedCount: qual.filter((x) => isDistressed(x.distress)).length,
          distressRule,
          ...(maxPrice ? { maxPrice } : {}),
        },
      });
    }
    if (agentsExcluded)
      warnings.push(`${agentsExcluded} agent(s) had no qualifying listing and were excluded`);

    // An agent this pull has no phone for may be one we already have a phone
    // for — the same agent key in another pull, or the same name at the same
    // office. A name two agents in this pull share can't be told apart, and
    // the office's own phone is never used: a text to the front desk is not a
    // text to the agent.
    const noPhone = agentRows.filter((r) => !r.doc.phone);
    if (noPhone.length && typeof store.findOutreachPhones === "function") {
      const nameOffice = (d) => `${String(d.name || "").trim().toLowerCase()}|${String(d.brokerage || "").trim().toLowerCase()}`;
      const inPull = new Map();
      for (const r of agentRows) inPull.set(nameOffice(r.doc), (inPull.get(nameOffice(r.doc)) || 0) + 1);
      const found = await store.findOutreachPhones(locationId, {
        agentKeys: noPhone.map((r) => r.agentKey),
        nameOffices: [...new Set(noPhone.filter((r) => r.doc.name).map((r) => nameOffice(r.doc)))],
      }).catch(() => []);
      const byKey = new Map();
      const byName = new Map();
      for (const f of found) {
        if (!byKey.has(f.agentKey)) byKey.set(f.agentKey, f.phone);
        if (!byName.has(f.nameOffice)) byName.set(f.nameOffice, new Set());
        byName.get(f.nameOffice).add(f.phone);
      }
      let filled = 0;
      for (const r of noPhone) {
        const own = byKey.get(r.agentKey);
        const named = byName.get(nameOffice(r.doc));
        if (own) { r.doc.phone = own; r.doc.phoneFrom = "another pull"; filled++; }
        else if (r.doc.name && inPull.get(nameOffice(r.doc)) === 1 && named?.size === 1) {
          r.doc.phone = [...named][0]; r.doc.phoneFrom = "name and office"; filled++;
        }
      }
      if (filled) warnings.push(`${filled} agent(s) with no phone on these listings got the phone we already had for them`);
    }

    // Still no phone: the agent's own listing on Zillow (2026-10-02,
    // outreachAutopilot.zillowLookup, off by default, the sweep's pulls only).
    // A phone is taken only when Zillow's agent has our agent's last name.
    if (zillow?.enabled && zillow.token && zillow.budget?.left > 0) {
      const need = agentRows.filter((r) => !r.doc.phone && r.doc.name && r.doc.hook?.address).slice(0, zillow.budget.left);
      if (need.length) {
        zillow.budget.left -= need.length;
        try {
          const found = await fetchZillowAgentContacts(need.map((r) => r.doc.hook.address), zillow.token);
          let got = 0;
          for (const r of need) {
            const z = found.get(streetKey(r.doc.hook.address));
            const phone = normPhone(z?.phone);
            if (!phone || !sameLastName(r.doc.name, z.name)) continue;
            r.doc.phone = phone;
            r.doc.phoneFrom = "zillow";
            if (!r.doc.email && normEmail(z.email)) r.doc.email = normEmail(z.email);
            got++;
          }
          warnings.push(`Zillow had a phone for ${got} of ${need.length} agent(s) with none`);
        } catch (e) { warnings.push(`Zillow agent lookup: ${String(e?.message || e).slice(0, 120)}`); }
      }
    }

    // GHL is asked about an agent once a week, not every pull — a ten-county
    // run would otherwise make thousands of lookups — and never about one we
    // have no phone for, who can't be texted anyway. The import asks again,
    // one at a time, before it creates anyone.
    const recheckMs = GHL_RECHECK_DAYS * 86400000;
    const unchecked = agentRows.filter((r) => !r.doc.ghl.contactId && r.stored?.status !== "imported" && r.doc.phone
      && !(r.doc.ghl.checkedAt && Date.now() - Date.parse(r.doc.ghl.checkedAt) < recheckMs));
    await mapPool(unchecked, 3, async (r) => {
      try {
        const match = await withRetry(() =>
          findDuplicateContact(client, locationId, { email: r.doc.email, phone: r.doc.phone })
        );
        r.doc.ghl = {
          contactId: match?.id || null,
          matchedBy: match?.matchedBy || null,
          checkedAt: new Date().toISOString(),
        };
      } catch (e) {
        warnings.push(`GHL check failed for ${r.doc.name || r.agentKey}: ${e.message}`);
      }
    });

    // Last message activity for every agent that has a GHL contact (matched or
    // already imported) — shown in the UI so recently-touched agents stand out.
    // Needs conversations.readonly; a 401/403 means the scope isn't granted.
    let convScopeMissing = false;
    // The sweep's pulls (every county, every workday) refresh it weekly, like
    // the GHL match; a pull from the button refreshes it every time.
    const withContact = agentRows.filter((r) => (r.doc.ghl.contactId || r.stored?.contactId)
      && !(sweep && r.doc.ghl.activityCheckedAt && Date.now() - Date.parse(r.doc.ghl.activityCheckedAt) < recheckMs));
    await mapPool(withContact, 3, async (r) => {
      if (convScopeMissing) return;
      try {
        const lm = await withRetry(() =>
          getLastMessageDate(client, locationId, r.doc.ghl.contactId || r.stored.contactId)
        );
        r.doc.ghl.lastMessageAt = lm?.at || null;
        r.doc.ghl.lastMessageDirection = lm?.direction || null;
        r.doc.ghl.activityCheckedAt = new Date().toISOString();
      } catch (e) {
        if (e.status === 401 || e.status === 403) convScopeMissing = true;
      }
    });
    if (convScopeMissing)
      warnings.push("last-message dates unavailable — add the conversations.readonly scope to the GHL private integration");

    await store.upsertOutreachListings(locationId, batch.id, listingRows);
    await store.upsertOutreachAgents(locationId, batch.id, agentRows.map(({ agentKey, doc }) => ({ agentKey, doc })));
    return { pool, agentRows, agentsNew, medianPpsf, medianPrice };
  }

  /**
   * runStatewidePull(locationId, client, body, settings, maxRequestsCap) → result
   *
   * The sweep's read of a whole state (2026-10-02): one RentCast query by
   * `state`, paged from `body.offset`, each listing filed under the county it
   * names when that county is on `body.counties`, the rest dropped. Each
   * county is ingested into its own batch (`body.batchIds["King, WA"]`) and
   * every listing is measured against its ZIP's or county's $/sqft median.
   * One pull record carries the requests, so the meter counts them once.
   */
  async function runStatewidePull(locationId, client, body, settings, maxRequestsCap) {
    const apiKey = String(settings.rentcastApiKey || "").trim();
    const p = pullParams({ ...body, zipCodes: "", county: "", city: "" }, settings, maxRequestsCap);
    const state = String(body.state || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) throw Object.assign(new Error("a statewide pull needs a state"), { http: 400 });
    const counties = (Array.isArray(body.counties) ? body.counties : [])
      .map((c) => ({ key: `${c.county}, ${c.state || state}`, meta: findCounty(c.county, c.state || state), batchId: body.batchIds?.[`${c.county}, ${c.state || state}`] }))
      .filter((c) => c.meta && c.batchId && (c.meta.state || state) === state);
    if (!counties.length) throw Object.assign(new Error("a statewide pull needs its counties and their batches"), { http: 400 });

    const warnings = [];
    const common = {
      daysOld: String(p.daysOld), ...(p.propertyType ? { propertyType: p.propertyType } : {}), ...(p.yearBuilt ? { yearBuilt: p.yearBuilt } : {}),
      ...(p.maxPrice ? { price: `*:${p.maxPrice}` } : {}),
      includeTotalCount: "true",
    };
    const { listings, requestsUsed, cached, nextOffset, totalCount } = await fetchListings({
      locationId, apiKey, targets: [{ state }], common, startOffset: p.offset, maxRequests: p.maxRequests, paging: true, warnings,
    });

    // File each listing under its county; the rest of the state isn't ours.
    const filed = new Map(counties.map((c) => [c.key, []]));
    const countyOf = new Map();
    let outside = 0;
    for (const l of listings) {
      const c = counties.find((x) => listingInCounty(l, x.meta));
      if (!c) { outside++; continue; }
      filed.get(c.key).push(l);
      countyOf.set(l, c.key);
    }
    if (outside) warnings.push(`${outside} of ${listings.length} listings were outside the chosen counties`);
    const inside = listings.filter((l) => countyOf.has(l));
    const medianFor = medianIndex(inside, { min: STATEWIDE_ZIP_MEDIAN_MIN, countyOf: (l) => countyOf.get(l) });

    const out = [];
    const zillow = zillowFor(settings);
    for (const c of counties) {
      const batch = await store.getOutreachBatch(locationId, String(c.batchId));
      if (!batch) { warnings.push(`${c.key}: no batch to file into`); continue; }
      const mine = filed.get(c.key);
      if (!mine.length) { out.push({ key: c.key, batchId: batch.id, batchName: batch.name, listingsFetched: 0, listingsKept: 0, agentsTotal: 0, agentsNew: 0 }); continue; }
      const w = [];
      const r = await ingestCohort({
        locationId, client, batch, listings: mine, warnings: w, medianFor,
        params: { maxPrice: p.maxPrice, maxYearBuilt: p.maxYearBuilt, distressOnly: p.distressOnly, distressRule: p.distressRule,
          staleDom: p.staleDom, priceBandPct: 0, sweep: true, zillow, propertyType: p.propertyType },
      });
      warnings.push(...w.filter((x) => !/kept \d+ of/.test(x)).map((x) => `${c.key}: ${x}`));
      out.push({ key: c.key, batchId: batch.id, batchName: batch.name, listingsFetched: mine.length, listingsKept: r.pool.length,
        agentsTotal: r.agentRows.length, agentsNew: r.agentsNew });
    }

    await store.recordOutreachPull(locationId, {
      batchId: null,
      params: { state, counties: counties.map((c) => c.key), daysOld: p.daysOld, propertyType: p.propertyType, yearBuilt: p.yearBuilt,
        offset: p.offset, maxRequests: p.maxRequests, maxYearBuilt: p.maxYearBuilt, maxPrice: p.maxPrice, distressRule: p.distressRule },
      requestsUsed, cached, listingsFetched: listings.length, listingsKept: out.reduce((s, c) => s + c.listingsKept, 0),
      agentsTotal: out.reduce((s, c) => s + c.agentsTotal, 0), agentsNew: out.reduce((s, c) => s + c.agentsNew, 0),
      counties: out,
    });
    return {
      ok: true, cached, requestsUsed, offset: p.offset, nextOffset, totalCount,
      listingsFetched: listings.length, listingsInside: inside.length, counties: out, warnings,
    };
  }

  async function runPull(locationId, client, body, { maxRequestsCap = PULL_BUTTON_MAX_REQUESTS } = {}) {
    const settings = await getSettings(locationId);
    const apiKey = String(settings.rentcastApiKey || "").trim();
    if (!apiKey) throw Object.assign(new Error("RentCast API key not configured — add it in Settings"), { http: 400 });
    if (body.statewide === true) return runStatewidePull(locationId, client, body, settings, maxRequestsCap);

    const { zips, county, city, state, daysOld, propertyType, yearBuilt, offset: startOffset, maxRequests, priceBandPct, distressOnly, staleDom, maxYearBuilt, maxPrice, distressRule } =
      pullParams(body, settings, maxRequestsCap);
    // Precedence: zips (one query each) → county (one circular query around
    // the county centroid, post-filtered to the county line) → city/state.
    // RentCast has no county search, but every listing it returns carries its
    // county, so a bounding circle + exact filter is equivalent.
    let countyMeta = null;
    if (!zips.length && county) {
      if (!state) throw Object.assign(new Error("county pulls need a state — set the state field"), { http: 400 });
      countyMeta = findCounty(county, state);
      if (!countyMeta)
        throw Object.assign(new Error(`unknown county "${county}" in ${state} — check the spelling`), { http: 400 });
    }
    // The sweep asks for the county's metro circle instead (body.metro): the
    // whole-county circle reaches deep into the neighbours, RentCast doesn't
    // return nearest-first, and on 2026-09-17 the first 400 listings of the
    // Pierce circle were all King County — two requests for nothing, on a
    // query heavy enough that RentCast's gateway 504'd on it. The county-line
    // filter below still applies; the hand-made Pull keeps the whole county.
    const circle = (body.metro === true || body.metro === "true") && countyMeta && METRO_CIRCLES[countyMeta.geoid]
      ? METRO_CIRCLES[countyMeta.geoid]
      : countyMeta ? { lat: countyMeta.lat, lng: countyMeta.lng, radiusMi: countyMeta.radiusMi } : null;
    const targets = zips.length
      ? zips.map((z) => ({ zipCode: z }))
      : countyMeta
        ? [{ latitude: String(circle.lat), longitude: String(circle.lng), radius: String(circle.radiusMi) }]
        : city && state
          ? [{ city, state }]
          : null;
    if (!targets) throw Object.assign(new Error("no market configured — set zip codes, a county, or city/state"), { http: 400 });

    // Every pull lands in a batch: explicit batchId, else most recent, else a
    // fresh auto-named one. An untouched auto-named empty batch adopts this
    // pull's market · date name.
    const nameParts = { zips, county: countyMeta?.name, city, state };
    const batch = await resolveBatch(locationId, body.batchId, {
      createName: autoBatchName(nameParts),
    });
    if (batch.autoNamed) {
      const existing = await store.listOutreachAgents(locationId, { batchId: batch.id, limit: 1 });
      if (!existing.length) {
        batch.name = autoBatchName(nameParts);
        await store.renameOutreachBatch(locationId, batch.id, batch.name, { autoNamed: true });
      }
    }

    const warnings = [];
    const common = {
      daysOld: String(daysOld), ...(propertyType ? { propertyType } : {}), ...(yearBuilt ? { yearBuilt } : {}),
      ...(maxPrice ? { price: `*:${maxPrice}` } : {}),
      includeTotalCount: "true",
    };
    const paging = startOffset > 0 || body.offset != null;

    const { listings: fetched, requestsUsed, cached, nextOffset, totalCount } =
      await fetchListings({ locationId, apiKey, targets, common, startOffset, maxRequests, paging, warnings });
    let listings = fetched;

    // The circle over-covers by design — trim to the actual county line using
    // the county each listing carries. Runs on cached pulls too (the cache
    // stores the raw circle).
    if (countyMeta) {
      const before = listings.length;
      const raw = listings;
      listings = listings.filter((l) => listingInCounty(l, countyMeta));
      warnings.push(`county filter kept ${listings.length} of ${before} circle listings inside ${countyMeta.name}`);
      // Nearly nothing inside the county we centred on is a labelling problem,
      // not a market: say what the listings called themselves.
      if (before >= 20 && listings.length < before * 0.05) {
        const seen = new Map();
        for (const l of raw) { const k = `${l.county || "?"}/${l.stateFips || ""}${l.countyFips || ""}/${l.state || "?"}`; seen.set(k, (seen.get(k) || 0) + 1); }
        const top = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}×${n}`).join(", ");
        warnings.push(`county labels seen (county/fips/state): ${top} — wanted ${countyMeta.name} ${countyMeta.geoid}`);
      }
    }

    const { pool, agentRows, agentsNew, medianPpsf, medianPrice } = await ingestCohort({
      locationId, client, batch, listings, warnings,
      params: { maxPrice, maxYearBuilt, distressOnly, distressRule, staleDom, priceBandPct, propertyType, sweep: body.metro === true || body.metro === "true",
        zillow: body.metro === true || body.metro === "true" ? zillowFor(settings) : null },
    });
    await store.recordOutreachPull(locationId, {
      batchId: batch.id,
      params: { targets, ...(countyMeta ? { county: countyMeta.name } : {}), daysOld, propertyType, yearBuilt, offset: startOffset, maxRequests, priceBandPct, distressOnly, staleDom, maxYearBuilt, maxPrice, distressRule },
      requestsUsed, cached, listingsFetched: listings.length, listingsKept: pool.length,
      agentsTotal: agentRows.length, agentsNew, medianPpsf: Math.round(medianPpsf),
      medianPrice: Math.round(medianPrice),
    });

    return {
      ok: true, cached, requestsUsed,
      offset: startOffset, nextOffset, totalCount,
      batchId: batch.id, batchName: batch.name,
      listingsFetched: listings.length, listingsKept: pool.length,
      medianPrice: Math.round(medianPrice),
      agentsTotal: agentRows.length, agentsNew,
      warnings,
    };
  }

  router.post("/pull", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      res.json(await runPull(locationId, client, req.body || {}));
    } catch (err) { fail(res, err); }
  });

  /* ---------- batches CRUD ---------- */

  router.get("/batches", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const batches = (await store.listOutreachBatches(locationId)).map((b) => ({ ...b, tag: batchTagFor(b) }));
      res.json({ batches });
    } catch (err) { fail(res, err); }
  });

  router.post("/batches", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const name = String(req.body?.name || "").trim().slice(0, 80);
      // Unnamed batches stay autoNamed so the first pull renames them to
      // "market · date"; an explicit name sticks.
      const batch = await store.createOutreachBatch(locationId, {
        name: name || `New batch · ${shortDate()}`,
        autoNamed: !name,
      });
      res.json({ ok: true, batch: { ...batch, tag: batchTagFor(batch) } });
    } catch (err) { fail(res, err); }
  });

  router.post("/batches/:batchId/rename", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const name = String(req.body?.name || "").trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: "name required" });
      const ok = await store.renameOutreachBatch(locationId, req.params.batchId, name);
      if (!ok) return res.status(404).json({ error: "unknown batch" });
      const batch = await store.getOutreachBatch(locationId, req.params.batchId);
      res.json({ ok: true, batch: { ...batch, tag: batchTagFor(batch) } });
    } catch (err) { fail(res, err); }
  });

  router.delete("/batches/:batchId", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const batch = await store.getOutreachBatch(locationId, req.params.batchId);
      if (!batch) return res.status(404).json({ error: "unknown batch" });
      const { removedAgents } = await store.deleteOutreachBatch(locationId, batch.id);
      res.json({ ok: true, removedAgents });
    } catch (err) { fail(res, err); }
  });

  /* ---------- list ---------- */

  router.get("/agents", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const settings = await getSettings(locationId);
      const enabled = Boolean(String(settings.rentcastApiKey || "").trim());

      // Scope to one batch (explicit or most recent). No batches yet → empty list.
      const batch = await resolveBatch(locationId, String(req.query.batch_id || "") || null);
      const rows = batch
        ? await store.listOutreachAgents(locationId, {
            batchId: batch.id,
            status: String(req.query.status || "") || null,
          })
        : [];

      // Join saved offers onto agents: an offer counts as "theirs" when its
      // property matches one of the agent's listings (street-level compare) or
      // it's attached to the agent's GHL contact.
      const normStreet = (s) => String(s || "").split(",")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
      const offers = await store.listOffers(locationId, { limit: 500 });
      const offersByStreet = new Map();
      for (const o of offers) {
        const k = normStreet(o.address);
        if (!k) continue;
        if (!offersByStreet.has(k)) offersByStreet.set(k, []);
        offersByStreet.get(k).push(o);
      }
      const offersByContact = new Map();
      for (const o of offers) {
        if (!o.contactId) continue;
        if (!offersByContact.has(o.contactId)) offersByContact.set(o.contactId, []);
        offersByContact.get(o.contactId).push(o);
      }
      const listingStreetsByAgent = new Map();
      const batchListings = batch ? await store.listAllOutreachListings(locationId, { batchId: batch.id }) : [];
      for (const l of batchListings) {
        const k = normStreet(l.doc?.address);
        if (!k) continue;
        if (!listingStreetsByAgent.has(l.agentKey)) listingStreetsByAgent.set(l.agentKey, new Set());
        listingStreetsByAgent.get(l.agentKey).add(k);
      }

      const agents = rows.map((r) => {
        const matched = new Map();
        for (const street of listingStreetsByAgent.get(r.agentKey) || [])
          for (const o of offersByStreet.get(street) || []) matched.set(o.id, o);
        const cid = r.contactId || r.doc?.ghl?.contactId;
        for (const o of offersByContact.get(cid) || []) matched.set(o.id, o);
        const agentOffers = [...matched.values()]
          .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
          .slice(0, 5)
          .map((o) => ({ id: o.id, address: o.address, cashAmount: o.cashAmount, createdAt: o.createdAt }));
        return {
          agentKey: r.agentKey, status: r.status, contactId: r.contactId,
          importedAt: r.importedAt, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
          ...r.doc,
          offers: agentOffers,
        };
      });

      // RentCast requests used this billing month, against the plan in Settings.
      const budget = await rentcastBudget({ store, locationId, saved: settings });
      const pulls = await store.listOutreachPulls(locationId, { limit: 1 });

      res.json({
        enabled, agents, tag: OUTREACH_TAG, importsEnabled: OUTREACH_IMPORTS_ENABLED,
        batch: batch ? { id: batch.id, name: batch.name, tag: batchTagFor(batch) } : null,
        usage: { requestsThisMonth: budget.used, budget: budget.budget, since: budget.since, lastPullAt: pulls[0]?.createdAt || null },
      });
    } catch (err) { fail(res, err); }
  });

  router.get("/agents/:agentKey/listings", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const batch = await resolveBatch(locationId, String(req.query.batch_id || "") || null);
      if (!batch) return res.json({ listings: [] });
      const rows = await store.listOutreachListings(locationId, { batchId: batch.id, agentKey: req.params.agentKey });
      const listings = rows
        .map((r) => ({ listingKey: r.listingKey, ...r.doc }))
        .sort((a, b) => (b.score || 0) - (a.score || 0));
      res.json({ listings });
    } catch (err) { fail(res, err); }
  });

  /* ---------- import ---------- */

  const firstEmail = (raw) =>
    String(raw || "").split(/[;,\s]+/).map((s) => s.trim()).find((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) || "";

  /**
   * openFirstText({ locationId, client, contactId, hook, ref, tries }) → { jobId } | { skipped }
   *
   * The app's first text to an agent the import just created. A contact we
   * created and then couldn't text would never be picked again (they're in
   * GHL now), so a text that doesn't happen — refused up front, or the draft
   * failing or held on its lane — is written down as outreach_open_skipped,
   * with the hook, and the next sweep tries them again (retryFirstTexts).
   */
  async function openFirstText({ locationId, client, contactId, hook = {}, ref = null, tries = 0 }) {
    const skip = (reason) => recordEvent({
      store, locationId, contactId, party: "agent", type: "outreach_open_skipped", source: "outreach",
      address: hook.address || "", ref, dedupeKey: `outreach_open_skipped:${contactId}:${tries + 1}`,
      data: { reason: String(reason || "").slice(0, 200), hook, tries: tries + 1 },
    }).catch(() => {});
    try {
      const r = await firstTouch({ locationId, client, contactId, hook,
        onSettled: (job) => { if (job?.status === "error" || (job?.status === "held" && !job.draftId)) skip(job.error || job.heldReason || job.status); } });
      if (r?.skipped) { await skip(r.skipped); return { skipped: r.skipped }; }
      return { jobId: r?.job?.id || null };
    } catch (e) {
      await skip(e.message);
      return { skipped: e.message };
    }
  }

  /**
   * retryFirstTexts({ locationId, client, limit, now }) → { retried, opened, results }
   *
   * Agents whose first text didn't happen (outreach_open_skipped in the last
   * FIRST_TEXT_RETRY_DAYS, or created to text and left with no draft at all,
   * no outreach_sent since), tried again, at most
   * FIRST_TEXT_TRIES times each and `limit` a run. The sweep runs this
   * before it pulls anyone new.
   */
  async function retryFirstTexts({ locationId, client, limit = Infinity, now = Date.now(), dryRun = false, minAgeMs = FIRST_TEXT_LOST_AFTER_MS, autopilotSince = null }) {
    if (typeof firstTouch !== "function" || !(limit > 0)) return { retried: 0, opened: 0, results: [] };
    // The agent's row in the batch it was imported from: the hook there knows
    // the house (year, size, lot, cut), the import event only its address.
    const rowsByBatch = new Map();
    const rowFor = async (batchId, contactId) => {
      if (!batchId) return null;
      if (!rowsByBatch.has(batchId)) {
        rowsByBatch.set(batchId, await store.listOutreachAgents(locationId, { batchId, status: "imported", limit: 5000 }).catch(() => []));
      }
      return (rowsByBatch.get(batchId) || []).find((r) => r.contactId === contactId) || null;
    };
    const since = new Date(now - FIRST_TEXT_RETRY_DAYS * 86400000).toISOString();
    const events = await store.listContactEventsSince(locationId, since, { types: ["outreach_open_skipped", "outreach_sent", "outreach_enrolled", "import"], limit: 5000 }).catch(() => []);
    const byContact = new Map();
    for (const e of events) {
      if (!e?.contactId) continue;
      if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
      byContact.get(e.contactId).push(e);
    }
    const results = [];
    for (const [contactId, list] of byContact) {
      if (results.length >= limit) break;
      if (list.some((e) => e.type === "outreach_sent" || e.type === "outreach_enrolled")) continue;
      const skips = list.filter((e) => e.type === "outreach_open_skipped").sort((x, y) => String(x.at).localeCompare(String(y.at)));
      if (skips.length >= FIRST_TEXT_TRIES) continue;
      if (skips.length) {
        const last = skips.at(-1);
        if (dryRun) { results.push({ contactId, would: "retry", address: last.data?.hook?.address || "" }); continue; }
        const r = await openFirstText({ locationId, client, contactId, hook: last.data?.hook || {}, ref: last.ref || null, tries: skips.length });
        results.push({ contactId, ...r });
        continue;
      }
      // Lost, not refused: a deploy restarted the broker while the first text
      // was still queued in memory, so nothing was written down. A contact the
      // app created to text, hours ago, with no draft of any kind.
      // `autopilotSince` (by hand only): imports into an Autopilot batch since
      // then count as app-made too — the ones written before the import
      // started recording openWith (2026-10-05).
      const appMade = (e) => e.data?.openWith === "app"
        || (autopilotSince && String(e.at) >= String(autopilotSince) && /^Autopilot · /.test(String(e.data?.batchName || "")));
      const made = list.find((e) => e.type === "import" && e.data?.action === "created" && appMade(e)
        && now - Date.parse(e.at) >= minAgeMs);
      if (!made) continue;
      const drafts = await store.listReplyDrafts(locationId, { contactId, limit: 1 }).catch(() => null);
      if (!Array.isArray(drafts) || drafts.length) continue;
      const row = await rowFor(made.data?.batchId, contactId);
      const h = row?.doc?.hook || {};
      const hook = { ...(made.data?.hook || {}), ...(h.address ? { address: h.address, price: h.price || null, dom: h.dom || null } : {}),
        county: countyName(h.county, made.data?.county, String(made.data?.batchName || "").replace(/^Autopilot · /, "")),
        city: h.city || "", brokerage: row?.doc?.brokerage || "", yearBuilt: h.yearBuilt || null, beds: h.beds || null, sqft: h.sqft || null,
        lotSize: h.lotSize || null, priceCut: priceCutOf(h), listingCount: Number(row?.doc?.listingCount) || 0 };
      if (dryRun) { results.push({ contactId, lost: true, would: "send", address: hook.address || "", county: hook.county }); continue; }
      const r = await openFirstText({ locationId, client, contactId, ref: made.ref || null, tries: 0, hook });
      results.push({ contactId, lost: true, ...r });
    }
    return { retried: results.length, opened: results.filter((r) => r.jobId).length, results };
  }

  /**
   * importAgents({ locationId, client, agentKeys, applyTag, batchId, sessionSuffix, dryRun, openWith })
   *
   * The import, callable without a request so the daily sweep can run it.
   * `openWith: "app"` asks the Conversation AI for the first text after a
   * live import (instead of, or as well as, the GHL trigger tag).
   * `enrollWorkflowId` puts each contact the import CREATED into that GHL
   * workflow and records `outreach_enrolled` (the follow-up sweep's clock).
   * A contact that already existed is never enrolled: it has a history, and
   * it may already be mid-workflow — GHL gives no way to ask.
   * `county` ("King, WA") stands in for a row whose hook predates the
   * listing's own county.
   */
  async function importAgents({ locationId, client, agentKeys = [], applyTag = true, batchId = null, sessionSuffix = "", dryRun = true, openWith = null, enrollWorkflowId = null, newOnly = false, createLimit = 0, county = "" }) {
      agentKeys = Array.isArray(agentKeys) ? agentKeys.slice(0, MAX_DAILY_CAP) : [];
      if (!agentKeys.length) throw Object.assign(new Error("agentKeys required"), { http: 400 });
      const batch = await resolveBatch(locationId, batchId);
      if (!batch) throw Object.assign(new Error("no batch — pull listings first"), { http: 400 });
      // Batch tag (e.g. "agent-outreach-queen-anne-fixers") — applied to every
      // contact regardless of applyTag, so the batch can be targeted in GHL
      // later (manual automation triggers). Derived from the batch name, so
      // it's stable across import sessions from the same batch.
      const batchTag = batchTagFor(batch);
      // Session tag — batch tag + a caller-supplied suffix (the UI defaults it
      // to date+time), unique per import click so same-day imports from one
      // batch stay individually targetable in GHL. Empty suffix = no session tag.
      sessionSuffix = sanitizeTag(sessionSuffix);
      const sessionTag = sessionSuffix ? sanitizeTag(`${batchTag}-${sessionSuffix}`) : null;
      // Live only when explicitly requested AND enabled server-side — same
      // double gate as offer sends (CARD_SENDS_ENABLED).
      dryRun = dryRun !== false || !OUTREACH_IMPORTS_ENABLED;

      const warnings = [];
      // Resolve custom-field ids once per batch (created on first use).
      let fieldIds = null;
      if (!dryRun) {
        fieldIds = {};
        for (const f of IMPORT_FIELDS) {
          fieldIds[f.key] = await withRetry(() =>
            findOrCreateCustomFieldByKey(client, locationId, f.key, f.name, f.dataType,
              { siblingKey: f.folderSibling })
          );
        }
      }

      const importOne = async (agentKey) => {
        try {
          const row = await store.getOutreachAgent(locationId, batch.id, agentKey);
          if (!row) return { agentKey, ok: false, error: "unknown agent" };
          if (row.status === "imported")
            return { agentKey, ok: true, alreadyImported: true, contactId: row.contactId };
          // Listing feeds sometimes carry two addresses in one field
          // ("sold@x.com;alicia@x.com"), which GHL rejects with a 422 and the
          // agent is lost. Use the first one that looks like an email.
          const a = { ...row.doc, email: firstEmail(row.doc?.email) };

          // Authoritative dedupe re-check at import time.
          await sleep(150);
          const match = await withRetry(() =>
            findDuplicateContact(client, locationId, { email: a.email, phone: a.phone })
          );

          // New-only (the daily sweep): an agent already in GHL is skipped, not
          // updated. They may be in the first-text workflow now, or have been
          // through it, and GHL gives no way to ask — so being in GHL at all
          // rules them out. The match is saved on the row so the next pick
          // doesn't spend a lookup on them again.
          if (newOnly && match) {
            const ghl = { ...(a.ghl || {}), contactId: match.id, matchedBy: match.matchedBy, checkedAt: new Date().toISOString() };
            await store.upsertOutreachAgents(locationId, batch.id, [{ agentKey, doc: { ...a, ghl } }])
              .catch((e) => warnings.push(`${agentKey}: saving GHL match: ${e.message}`));
            return { agentKey, ok: true, name: a.name, skipped: "already in GHL", contactId: match.id, matchedBy: match.matchedBy };
          }

          if (dryRun) {
            return {
              agentKey, ok: true, dryRun: true,
              name: a.name,
              ...(match ? { wouldUpdate: true, contactId: match.id, matchedBy: match.matchedBy } : { wouldCreate: true }),
              tagWouldApply: applyTag,
              wouldEnroll: Boolean(enrollWorkflowId) && !match,
            };
          }

          let contactId;
          let action;
          // Kept in scope past this block: the custom-field write below needs to
          // know what the contact already had, so a re-import can't undo a
          // Subject Property the conversation has since moved on.
          let existing = null;
          if (match) {
            contactId = match.id;
            action = "updated";
            // Fill blanks only — never clobber an existing name/phone/email.
            existing = await withRetry(() => getContact(client, contactId));
            const patch = {};
            if (!existing.phone && a.phone) patch.phone = e164(a.phone);
            if (!existing.email && a.email) patch.email = a.email;
            if (!existing.firstName && !existing.lastName && a.name) {
              patch.firstName = a.firstName;
              patch.lastName = a.lastName;
            }
            if (Object.keys(patch).length) await withRetry(() => updateContact(client, contactId, patch));
          } else {
            action = "created";
            contactId = await withRetry(() =>
              createContact(client, locationId, {
                firstName: a.firstName || a.name || "Agent",
                lastName: a.lastName || "",
                ...(a.phone ? { phone: e164(a.phone) } : {}),
                ...(a.email ? { email: a.email } : {}),
                source: "agent-outreach",
              })
            );
          }
          if (!contactId) throw new Error("no contact id returned");

          const hook = a.hook || {};
          const values = {
            // Street portion only — "1911 9th Ave W, Seattle, WA 98119" → "1911 9th Ave W"
            short_hand_property_address: String(hook.address || "").split(",")[0].trim(),
            hook_address: hook.address || "",
            hook_price: hook.price || "",
            hook_dom: hook.dom || "",
            hook_url: hook.address ? zillowUrl(hook.address) || "" : "",
            brokerage: a.brokerage || "",
          };

          // Seeded, not set — see seedSubjectProperty. `existing` is null on
          // the create path, so a brand-new contact always gets the hook
          // address; a re-import leaves a subject the conversation has moved on.
          const seeded = seedSubjectProperty({
            contact: existing,
            fieldId: fieldIds[SUBJECT_PROPERTY_FIELD.key],
            hookAddress: hook.address,
          });
          if (seeded) values[SUBJECT_PROPERTY_FIELD.key] = seeded;

          const customFields = IMPORT_FIELDS
            .filter((f) => values[f.key] !== "" && values[f.key] != null)
            .map((f) => ({ id: fieldIds[f.key], value: values[f.key] }));
          if (customFields.length) await withRetry(() => updateContact(client, contactId, { customFields }));

          // Batch + session tags always; the trigger tag only when requested
          // (it fires the GHL texting workflow).
          await withRetry(() =>
            addContactTags(client, contactId, [
              batchTag,
              ...(sessionTag ? [sessionTag] : []),
              ...(applyTag ? [OUTREACH_TAG] : []),
            ])
          );
          const tagged = applyTag;

          // The record: a new agent, where we found them, and what we seeded.
          try {
            const at = new Date().toISOString();
            await ensureProfile({ store, locationId, contactId, party: "agent", name: a.name || null, phone: a.phone ? e164(a.phone) : null, email: a.email || null });
            const facts = [];
            if (a.brokerage) facts.push({ key: "brokerage", value: a.brokerage, source: "import", at, ref: batch.id });
            if (seeded) facts.push({ key: "subject_property", value: seeded, source: "import", at, ref: batch.id });
            if (facts.length) await learnFacts({ store, locationId, contactId, party: "agent", facts });
            await recordEvents({ store, locationId, contactId, party: "agent", events: [
              { type: "import", at, address: hook.address || "", source: "import", ref: `${batch.id}:${contactId}`,
                data: { action, batchId: batch.id, batchName: batch.name || "", hook: { address: hook.address || "", price: hook.price || null, dom: hook.dom || null },
                  ...(openWith === "app" ? { openWith: "app", county: countyName(hook.county, county) } : {}) } },
              ...[batchTag, ...(sessionTag ? [sessionTag] : []), ...(applyTag ? [OUTREACH_TAG] : [])].map((tag) => ({ type: "tag_added", at, source: "import", ref: batch.id, data: { tag } })),
            ] });
          } catch (e) { warnings.push(`${agentKey}: record: ${e.message}`); }

          await store.setOutreachAgentStatus(locationId, batch.id, agentKey, {
            status: "imported", contactId, importedAt: new Date().toISOString(),
          });

          // The first text, from the app. Only for a contact we CREATED: an
          // agent already in GHL has a thread, and a cold open on top of it
          // is the bot forgetting who it's talking to.
          let opened = null;
          if (openWith === "app" && typeof firstTouch === "function" && action === "created") {
            opened = await openFirstText({ locationId, client, contactId, ref: batch.id,
              hook: { address: hook.address || "", price: hook.price || null, dom: hook.dom || null,
                county: countyName(hook.county, county), city: hook.city || "", brokerage: a.brokerage || "",
                yearBuilt: hook.yearBuilt || null, beds: hook.beds || null, sqft: hook.sqft || null, lotSize: hook.lotSize || null,
                priceCut: priceCutOf(hook), listingCount: Number(a.listingCount) || 0 } });
            if (opened.skipped) warnings.push(`${agentKey}: first text: ${opened.skipped}`);
          }
          let enrolled = null;
          if (enrollWorkflowId && action !== "created") {
            enrolled = { skipped: "already in GHL" };
          } else if (enrollWorkflowId) {
            try {
              await withRetry(() => addContactToWorkflow(client, contactId, enrollWorkflowId));
              enrolled = { workflowId: enrollWorkflowId };
              await recordEvent({
                store, locationId, contactId, party: "agent", type: "outreach_enrolled", source: "import",
                address: hook.address || "", ref: batch.id, dedupeKey: `outreach_enrolled:first:${contactId}`,
                data: { kind: "first", workflowId: enrollWorkflowId, batchId: batch.id },
              });
            } catch (e) {
              enrolled = { error: e.message };
              warnings.push(`${agentKey}: workflow: ${e.message}`);
            }
          }
          return { agentKey, ok: true, name: a.name, action, contactId, tagged, ...(opened ? { opened } : {}), ...(enrolled ? { enrolled } : {}) };
        } catch (e) {
          warnings.push(`${agentKey}: ${e.message}`);
          return { agentKey, ok: false, error: e.message };
        }
      };

      let results;
      if (newOnly) {
        // One at a time, so the day's number is exact: stop the moment
        // `createLimit` brand-new contacts exist (or would, on a dry run).
        results = [];
        const limit = createLimit > 0 ? createLimit : agentKeys.length;
        let made = 0;
        for (const agentKey of agentKeys) {
          if (made >= limit) break;
          const r = await importOne(agentKey);
          results.push(r);
          if (r.action === "created" || r.wouldCreate) made++;
        }
      } else {
        results = await mapPool(agentKeys, 2, importOne);
      }

      return {
        ok: true, dryRun, importsEnabled: OUTREACH_IMPORTS_ENABLED, tag: OUTREACH_TAG,
        skippedExisting: results.filter((r) => r.skipped === "already in GHL").length,
        batchTag, sessionTag, batchId: batch.id,
        results,
        imported: results.filter((r) => r.ok && r.action).length,
        opened: results.filter((r) => r.opened?.jobId).length,
        enrolled: results.filter((r) => r.enrolled?.workflowId).length,
        warnings,
      };
  }

  router.post("/import", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const b = req.body || {};
      res.json(await importAgents({
        locationId, client, agentKeys: b.agentKeys, applyTag: b.applyTag !== false, batchId: b.batchId || null,
        sessionSuffix: b.sessionTag, dryRun: b.dryRun, openWith: b.openWith === "app" ? "app" : null,
        enrollWorkflowId: workflowIdFrom(b.enrollWorkflowId) || null,
      }));
    } catch (err) { fail(res, err); }
  });

  /* ---------- clear (reset a batch before a re-filtered pull) ---------- */

  // Remove a batch's non-imported agents (and their listings) so the next
  // pull into it starts fresh — pulls only ever add/update, so tightening
  // filters would otherwise leave stale agents. Imported agents are kept.
  router.post("/clear", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const batch = await resolveBatch(locationId, req.body?.batchId);
      if (!batch) return res.json({ ok: true, removed: 0 });
      const removed = await store.clearOutreachAgents(locationId, batch.id);
      res.json({ ok: true, removed });
    } catch (err) { fail(res, err); }
  });

  /* ---------- skip / unskip ---------- */

  router.post("/agents/:agentKey/status", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const status = String(req.body?.status || "");
      if (!["skipped", "new"].includes(status))
        return res.status(400).json({ error: 'status must be "skipped" or "new"' });
      const batch = await resolveBatch(locationId, req.body?.batchId);
      if (!batch) return res.status(404).json({ error: "unknown agent" });
      const row = await store.getOutreachAgent(locationId, batch.id, req.params.agentKey);
      if (!row) return res.status(404).json({ error: "unknown agent" });
      if (row.status === "imported")
        return res.status(400).json({ error: "imported agents can't change status" });
      await store.setOutreachAgentStatus(locationId, batch.id, req.params.agentKey, { status });
      res.json({ ok: true, status });
    } catch (err) { fail(res, err); }
  });

  /* ---------- autopilot: the daily sweep, read and run by hand ---------- */

  // Before the Zillow lookup is switched on: run it on a few agents we have no
  // phone for and say what Zillow's rows carried — field names and yes/no,
  // never a name or a number. Spends one Apify run (a fraction of a cent).
  router.post("/zillow-agents/preview", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const settings = await getSettings(locationId);
      const token = String(settings.apifyToken || "").trim();
      if (!token) return res.status(400).json({ error: "no Apify token in Settings" });
      const limit = Math.min(5, Math.max(1, parseInt(req.body?.limit, 10) || 3));
      const rows = [];
      for (const b of (await store.listOutreachBatches(locationId)).filter((x) => /^autopilot\b/i.test(x.name))) {
        for (const r of await store.listOutreachAgents(locationId, { batchId: b.id, status: "new", limit: 500 })) {
          if (!r.doc?.phone && r.doc?.name && r.doc?.hook?.address) rows.push(r);
          if (rows.length >= limit) break;
        }
        if (rows.length >= limit) break;
      }
      if (!rows.length) return res.json({ ok: true, checked: 0, results: [] });
      const found = await fetchZillowAgentContacts(rows.map((r) => r.doc.hook.address), token);
      res.json({ ok: true, checked: rows.length, results: rows.map((r) => {
        const z = found.get(streetKey(r.doc.hook.address));
        return { foundListing: Boolean(z), fields: z?.fields || [], hasName: Boolean(z?.name), sameName: Boolean(z && sameLastName(r.doc.name, z.name)), hasPhone: Boolean(z?.phone), hasEmail: Boolean(z?.email) };
      }) });
    } catch (err) { fail(res, err); }
  });

  router.get("/autopilot", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const cursor = await store.getJobCursor?.(locationId, OUTREACH_CURSOR).catch(() => null);
      const followCursor = await store.getJobCursor?.(locationId, FOLLOWUP_CURSOR).catch(() => null);
      res.json({
        followUp: {
          hour: OUTREACH_FOLLOWUP_HOUR, tz: WORK_TZ,
          lastRunAt: followCursor?.at || null,
          job: getOutreachFollowUpJob(locationId),
        },
        ok: true,
        settings: normalizeOutreachAutopilot(saved.outreachAutopilot),
        importsEnabled: OUTREACH_IMPORTS_ENABLED,
        hasKey: Boolean(String(saved.rentcastApiKey || "").trim()),
        firstTouchOn: Boolean(saved.conversationAi?.parties?.agent?.outreach?.enabled),
        // This billing month's RentCast requests: used, the plan, what a run may spend.
        budget: await rentcastBudget({ store, locationId, saved }).catch(() => null),
        hour: OUTREACH_SWEEP_HOUR, tz: WORK_TZ,
        lastRunAt: cursor?.at || null,
        job: publicOutreachJob(getOutreachJob(locationId)),
        // What the cursor remembers when the job in memory is gone: the run
        // in progress (if any), the last finished run, and today's tries.
        run: cursor?.doc?.run || null,
        last: cursor?.doc?.last || null,
        tries: Number(cursor?.doc?.tries) || 0,
        failed: Boolean(cursor?.doc?.failed),
        error: cursor?.doc?.error || null,
      });
    } catch (err) { fail(res, err); }
  });

  // Body: { dryRun }. dryRun true = pull (a cache hit is free), pick, and say
  // who WOULD be imported; nothing is written to GHL. The pull itself still
  // happens, so a dry run on a cold cache costs RentCast requests.
  router.post("/autopilot/run", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const dryRun = req.body?.dryRun !== false;
      const job = startOutreachSweep({
        locationId, client, saved, store, dryRun, trigger: "manual",
        deps: router.sweepDeps,
      });
      res.status(202).json({ ok: true, job: publicOutreachJob(job) });
    } catch (err) { fail(res, err); }
  });

  // Body: { dryRun = true, autopilotSince, minAgeMinutes }. First texts that
  // didn't go (refused, or lost to a restart), tried again now rather than at
  // the next sweep. A dry run lists who; nothing is drafted.
  router.post("/autopilot/first-texts/retry", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const b = req.body || {};
      const since = b.autopilotSince && Number.isFinite(Date.parse(b.autopilotSince)) ? new Date(b.autopilotSince).toISOString() : null;
      const age = Number.isFinite(Number(b.minAgeMinutes)) ? Math.max(0, Number(b.minAgeMinutes)) * 60000 : FIRST_TEXT_LOST_AFTER_MS;
      const r = await retryFirstTexts({ locationId, client, dryRun: b.dryRun !== false, autopilotSince: since, minAgeMs: age,
        limit: Math.max(1, Math.min(MAX_DAILY_CAP, Math.round(Number(b.limit)) || MAX_DAILY_CAP)) });
      res.json({ ok: true, dryRun: b.dryRun !== false, ...r });
    } catch (err) { fail(res, err); }
  });

  // Body: { dryRun }. The follow-up by hand: who is due, who wrote back, and
  // (live) into the follow-up workflow. Dry by default.
  // The agent check-in (agent-pulse.js, shared/agent-pulse.js): who it would
  // text today and why, what it did last, and whether it's on. Writes nothing.
  router.get("/pulse", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const plan = await planAgentPulse({ locationId, saved, store, workflows: await pulseWorkflows(client, locationId) });
      const cursor = await store.getJobCursor?.(locationId, AGENT_PULSE_CURSOR).catch(() => null);
      res.json({
        ok: true, settings: plan.settings, counts: plan.counts, claimedToday: plan.claimedToday, seats: plan.seats, truncated: plan.truncated,
        picks: plan.picks.map((p) => ({ contactId: p.contactId, name: p.name, segment: p.segment, reason: p.reason, address: p.subject?.address || "", subject: p.subject })),
        sendsEnabled: PULSE_SENDS_LIVE, tz: WORK_TZ,
        // The GHL drips it replaces (the tier nurture), and the one-time
        // clean-up that takes everyone out of them.
        drips: plan.drips || [], leaveDrips: getLeaveDripsJob(locationId),
        job: getAgentPulseJob(locationId),
        lastRunAt: cursor?.at || null, last: cursor?.doc?.last || null, run: cursor?.doc?.run || null,
        tries: Number(cursor?.doc?.tries) || 0, failed: Boolean(cursor?.doc?.failed), error: cursor?.doc?.error || null,
      });
    } catch (err) { fail(res, err); }
  });

  // Body: { dryRun, limit }. A dry run (the default) picks and reports; it
  // claims nobody and drafts nothing.
  router.post("/pulse/run", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const dryRun = req.body?.dryRun !== false;
      const limit = req.body?.limit != null ? Number(req.body.limit) : null;
      const job = startAgentPulse({
        client, locationId, saved, store, sendsEnabled: PULSE_SENDS_LIVE, trigger: "manual", dryRun, limit,
        deps: router.conversationDepsFor?.({ locationId, client, saved }) || {},
      });
      res.json({ ok: true, job });
    } catch (err) { fail(res, err); }
  });

  // Body: { limit } (1–5, default 3). The next check-ins as the drafter
  // would write them now — no claim, no draft row, nothing sent. One model
  // call each.
  router.post("/pulse/preview", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const r = await previewAgentPulse({ client, locationId, saved, store, limit: req.body?.limit ?? 3 });
      res.json({ ok: true, ...r });
    } catch (err) { fail(res, err); }
  });

  /**
   * previewFirstTexts({ locationId, client, saved, limit, preview }) → { previews }
   *
   * What the app's first text WOULD say to agents the sweep could pick next:
   * one from each autopilot county in turn, drafted the way the live text is
   * (their county, Matt's examples, the carrier rule, the gates), then
   * dropped. Nothing is imported, saved or sent.
   */
  async function previewFirstTexts({ locationId, client, saved, limit = 3, preview = previewProactive }) {
    const n = Math.max(1, Math.min(8, Math.round(Number(limit)) || 3));
    const batches = ((await store.listOutreachBatches(locationId).catch(() => [])) || [])
      .filter((b) => /^Autopilot · /.test(String(b?.name || "")));
    const pools = [];
    for (const b of batches) {
      const rows = typeof store.listOutreachPickable === "function"
        ? await store.listOutreachPickable(locationId, { batchId: b.id, limit: n })
        : await store.listOutreachAgents(locationId, { batchId: b.id, status: "new", limit: n });
      const market = String(b.name).replace(/^Autopilot · /, "");
      if (rows.length) pools.push(rows.map((r) => ({ r, market })));
    }
    const line = [];
    for (let i = 0; line.length < n && pools.some((p) => p[i]); i++) for (const p of pools) if (p[i] && line.length < n) line.push(p[i]);
    const previews = [];
    for (const [i, { r, market }] of line.entries()) {
      const hook = r.doc?.hook || {};
      const county = countyName(hook.county, market);
      const out = await preview({
        client, locationId, saved, store, contactId: "", kind: "outreach_open", name: r.doc?.name || "",
        subject: { address: hook.address || "", hookPrice: hook.price || 0, hookDom: hook.dom || 0, brokerage: r.doc?.brokerage || "", county, city: hook.city || "", variant: i,
          house: { ...hook, priceCut: priceCutOf(hook), listingCount: Number(r.doc?.listingCount) || 0 } },
      }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
      previews.push({ agentKey: r.agentKey, name: r.doc?.name || "", street: String(hook.address || "").split(",")[0], county,
        reply: out?.reply || "", chars: String(out?.reply || "").length, held: Boolean(out?.held), flags: out?.flags || [], skipped: out?.skipped || "" });
    }
    return { previews };
  }
  router.previewFirstTexts = previewFirstTexts;

  // Body: { limit }. The first text to new agents, read before it goes.
  router.post("/opener/preview", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await getSettings(locationId);
      res.json({ ok: true, ...(await previewFirstTexts({ locationId, client, saved, limit: req.body?.limit ?? 3 })) });
    } catch (err) { fail(res, err); }
  });

  // The clean-up's progress (and which drips), without running the planner.
  router.get("/pulse/leave-drips", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      res.json({ ok: true, job: getLeaveDripsJob(locationId) });
    } catch (err) { fail(res, err); }
  });

  // Body: { dryRun }. Everyone tagged tier-2/tier-3, out of the drips the
  // check-in replaces. A dry run (the default) only counts; live needs the
  // check-in on. Progress on GET /pulse → leaveDrips.
  router.post("/pulse/leave-drips", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const job = startLeaveDrips({ client, locationId, saved, store, dryRun: req.body?.dryRun !== false });
      res.status(202).json({ ok: true, job });
    } catch (err) { fail(res, err); }
  });

  router.post("/autopilot/followup/run", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = await getSettings(locationId);
      const job = startOutreachFollowUp({ locationId, client, saved, store, dryRun: req.body?.dryRun !== false, trigger: "manual" });
      res.status(202).json({ ok: true, job });
    } catch (err) { fail(res, err); }
  });

  // For the daily outreach sweep (outreach-sweep.js): the same pull and
  // import the buttons run, without a request.
  router.runPull = (locationId, client, body = {}, opts = {}) => runPull(locationId, client, body, opts);
  router.importAgents = importAgents;
  router.retryFirstTexts = retryFirstTexts;
  // What the daily sweep (outreach-sweep.js) is handed, from the tick and
  // from Run now alike.
  router.sweepDeps = {
    runPull: (...args) => router.runPull(...args), importAgents, retryFirstTexts,
    firstTextRoom: ({ locationId, saved }) => machineRoomToday({ store, locationId, saved }),
  };
  router.resolveBatch = resolveBatch;

  return router;
}
