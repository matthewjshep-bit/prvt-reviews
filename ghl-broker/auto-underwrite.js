// auto-underwrite.js — an offer, start to finish, from one inbound text.
//
// A listing agent texts "you still buying? 1234 NE 8th St, asking 525k". A GHL
// workflow webhooks that message here, and this runs the same five steps the
// operator would run by hand on the New Offer page:
//
//   extracting → read the address (and asking price) out of the message
//   comps      → pull closed sales, keep the ones within half a mile
//   grading    → have Claude grade each comp's condition from its sold photos
//   arv        → derive the ARV from the RENOVATED ones only
//   rehab      → scan the subject's listing photos into a priced scope of work
//   creating   → maximum-offer underwrite (N% ARV − repairs − fee), offer + documents + GHL writeback
//
// Two things this deliberately does NOT do:
//
//   It never sends. The offer lands in History for a human to look at and
//   press Send, behind the CARD_SENDS_ENABLED rail that already exists.
//
//   It never guesses. A run that can't find three renovated comps within half
//   a mile, or can't get enough photos to scan, stops and saves a DRAFT with
//   the reason instead of publishing an offer built on a number nobody chose.
//   See evaluateGates — that function is the whole safety argument.
//
// Job state is in memory, like the enrichment sweep: a restart loses the job
// list but never corrupts anything, because every write is the same idempotent
// create the manual flow uses. The spend guards read from the store instead,
// precisely so a crash loop can't reset them.

import Anthropic from "@anthropic-ai/sdk";
import { pullComps } from "./comps-pull.js";
import { geocodeAddress, atLeast, precisionRank, PRECISION } from "./geocode.js";
import { pullZillowComps, pullZillowActives, filterByUnits, streetKey, mergeFacts } from "./comps-zillow.js";
import { checkSite, fetchBarriers } from "./site-context.js";
import { checksFor, buyerView, checksLines, summarizeChecks } from "./shared/underwrite-checks.js";
import { withAllowance } from "./shared/rehab-checks.js";
import { gradeComps } from "./comps-grade.js";
import { recordError } from "./app-errors.js";
import { fetchZillowPhotos, fetchListingPhotos, fetchZillowFacts, MAX_FACT_LOOKUPS, scanRehabFromPhotos, anthropicErrorToHttp } from "./rehab-scan.js";
import { kindHold, ruralHold } from "./shared/asset-type.js";
import { deriveArv, timeTrend, SIZE_TOLERANCE_PCT } from "./shared/arv.js";
import { scoreComp, similarity, inPool, compareByMatch, milesBetween, markRenovatedByPrice, PRICE_PROXY_MIN_POOL } from "./shared/comp-match.js";
import { seedRoomCounts, applyScanSuggestion, priceScope } from "./shared/rehab-scope.js";
import { rehabBand, heavyCeiling } from "./shared/rehab-catalog.js";
import { fmtMoney, calculateOffers } from "./shared/offer-calc.js";
import { offMarketSignals } from "./shared/off-market.js";
import { leadSourceOf, theirNumberCheck } from "./shared/lead-source.js";
import { buyerCeiling } from "./shared/post-mortem.js";
import { markSides, sameSideFirst, isAcross, acrossLabel } from "./shared/same-side.js";
import { addressKey, completeAddress, sameStreet, sameHouse } from "./shared/us-address.js";
import { effectiveStatus as offerStatusOf, DEAD_STATUSES, priceAgreed } from "./shared/offer-status.js";
import { expandListingLinks } from "./listing-links.js";
import { buildTranscript } from "./enrich.js";
import {
  getContact, createContactNote, addContactTags, removeContactTags,
  updateContact, findOrCreateCustomFieldByKey,
} from "./ghl.js";
import { SUBJECT_PROPERTY_FIELD } from "./enrich.js";
import { learnFacts, recordEvent } from "./contact-record.js";
import { currentFacts } from "./shared/contact-record.js";
import { propertyDossier } from "./shared/contact-record.js";
import { VALUE_HOLD, WORK_HOLD, STRUCTURAL_HOLD } from "./shared/held-underwrites.js";
import { mostRecentlyMentioned } from "./shared/us-address.js";
import { usageOf } from "./shared/ai-cost.js";
import { meterAi } from "./ai-spend.js";

/* ---------- the dials ---------- */

export const UW_RADIUS_MILES = 0.5;        // "under half a mile", as asked
// Thin areas only. When a ring holds fewer than UW_MIN_REHABBED_COMPS usable
// comps the search widens to the next one, and the offer says how far it
// reached. Matt chose this on 2026-09-14 over "never widen", after a Seattle
// house held on a single sale inside half a mile. Each extra ring is another
// Apify pull, so an area with enough comps never pays for one.
// Half a mile, then straight to the last ring. Every ring is a fresh Apify
// search of the WHOLE disc, so a middle rung re-buys the sales the next one
// returns anyway — 2026-09-15, cutting it saves a pull on every widened run.
// One mile at most (Matt, 2026-10-02): the last ring was 1.5 mi, and more than
// half of all runs were reaching it. A thin house now gets a gut check or a
// hold instead of comps from a mile and a half away.
export const UW_RADIUS_LADDER = [0.5, 1];

/**
 * shouldScanPhotos({ arv, theirArv, theirRehab, describedWork, fill }) → boolean
 *
 * Reading up to 40 listing photos is the most expensive thing an underwrite
 * does. With no ARV from the comps AND nothing from the agent to rescue it
 * with, the run is held whatever the photos say — so it is paid for and thrown
 * away. Anything that could still produce a number (an ARV, their value, their
 * repairs, or work they described) scans as before, and the offer form's
 * "fill" always scans: a person is waiting for that scope.
 */
export function shouldScanPhotos({ arv = 0, theirArv = 0, theirRehab = 0, describedWork = false, fill = false } = {}) {
  if (fill) return true;
  return Number(arv) > 0 || Number(theirArv) > 0 || Number(theirRehab) > 0 || Boolean(describedWork);
}
export const UW_MIN_REHABBED_COMPS = 3;    // below this the run holds for review
export const UW_GUT_CHECK_MIN_COMPS = 2;   // …unless it's a gut check (see gradeByPriceProxy)
// An unattended offer never goes above this share of the list price. Kelby
// Schweitzer's 5016 7th Ave NE (2026-09-14) priced at $1,061,750 on a $925,000
// listing — the underwrite never had the list price, so nothing stopped it.
// Matt chose "cap below list"; 90% is the default, `maxOfferPctOfList` in
// Settings overrides it.
export const UW_MAX_PCT_OF_LIST = 90;

// A listing price in whatever shape the actor hands back: a number, a money
// object, or a label ("$925,000", "$1.23M", "925K").
export function moneyFromListing(v) {
  if (v && typeof v === "object") v = v.amount ?? v.value ?? null;
  if (typeof v === "number") return v > 0 ? Math.round(v) : 0;
  const m = String(v || "").replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
  if (!m) return 0;
  const n = Number(m[1]) * (m[2] ? (/m/i.test(m[2]) ? 1_000_000 : 1000) : 1);
  return n > 0 ? Math.round(n) : 0;
}

// { capped, amount, cap } — `amount` is what the offer may be.
export function capToList({ cash = 0, listPrice = 0, pct = UW_MAX_PCT_OF_LIST } = {}) {
  const list = Math.round(Number(listPrice) || 0);
  const share = Number(pct) > 0 ? Number(pct) : UW_MAX_PCT_OF_LIST;
  const amount = Math.round(Number(cash) || 0);
  if (!(list > 0) || !(amount > 0)) return { capped: false, amount, cap: 0 };
  const cap = Math.round((list * share) / 100);
  return amount > cap ? { capped: true, amount: cap, cap } : { capped: false, amount, cap };
}
export const UW_MAX_ARV_COMPS = 4;         // 3–4 comps carry the ARV
export const UW_GRADE_CANDIDATES = 6;      // how many we pay Apify+Claude to grade
// How wide the pool is that the PRICE PROXY ranks. Deliberately looser than the
// comps that end up carrying the ARV, because the two answer different
// questions — see the note above the condition stage in runUnderwrite.
//
// Measured, not guessed: on a live 78-comp pull around a 3/2 1,610 sqft house
// in Lake Forest Park, the tight bands (beds exact, baths ±0.5, sqft ±20%) left
// a pool of FOUR. The proxy needs six to have a top tier, so every run on a
// perfectly ordinary address would have held for review. These bands leave ten.
export const UW_POOL_BEDS_TOLERANCE = 1;
export const UW_POOL_BATHS_TOLERANCE = 1;
export const UW_POOL_SQFT_PCT = 0.30;
// The pool's era band — only knowable once the comps' year built has been
// bought (below); a comp with no year passes, as everywhere. ±15 → ±30 on
// 2026-10-08 (3037 Massey Rd, Everson): the house next door matters more than
// its age, and the ranking already scores age down.
export const UW_POOL_YEAR_TOLERANCE = 30;
// Most similar first (2026-09-16). The pool above is as wide as it was, so
// runs don't hold more often; what changed is who inside it carries the
// number. The price proxy used to rank the WHOLE ring by $/sqft and call the
// top 35% renovated, so the priciest houses nearby — bigger lots, newer,
// better streets — were the ARV evidence, and the similar-but-cheaper
// renovated sale next door lost. The post-mortem of 2026-09-10 found buyers
// pay ≤70% of ARV less repairs and the three dead deals were priced off ARVs
// that were too high. Now the ring is ranked by comp-match.js `similarity`
// (distance leads, then size, beds, baths, era, recency), the proxy judges
// only the UW_SIMILAR_CANDIDATES most similar, and the top UW_PROXY_SHARE of
// THOSE by $/sqft is the renovated evidence.
export const UW_SIMILAR_CANDIDATES = 10;
export const UW_PROXY_SHARE = 0.5;
// Year built is on no Zillow search row. It IS on the detail row — the same
// call the multifamily path already made for unit counts — so the most
// similar UW_ENRICH_CANDIDATES per ring are looked up (one batched detail run,
// billed per address, cached a day per street). 0 switches it off and the run
// prices on the search rows alone, as it did before.
export const UW_ENRICH_CANDIDATES = 20;
export const UW_MIN_SUBJECT_PHOTOS = 8;    // a 3-photo listing is not a scope of work
export const UW_MIN_PHOTOS_DESCRIBED = 4;  // …unless the agent already told us the work
// Pricing on the agent's own numbers when ours are stuck (agentNumbersRescue).
export const UW_AGENT_ARV_MAX_OF_LIST = 1.25;  // their value, never past 125% of list
export const UW_AGENT_REPAIR_CUT = 0.25;       // their repairs cut our scope by at most a quarter
export const UW_LAST_RING_MONTHS = 24;         // the widest ring looks back two years
export const UW_NON_CORE_LIST = 2000000;       // luxury: priced, but not what we're built for
export const UW_REPAIRS_BAND_SLACK = 1.25; // how far past the heavy band is still plausible
export const UW_DEFAULT_DAILY_CAP = 25;
export const MAX_CONCURRENT_PER_LOCATION = 2;

const ARV_CONDITIONS = new Set(["renovated", "updated"]);

// The offer is only as good as the underwrite is honest, so the mode is fixed:
// the maximum-offer model, maoPctOfArv% of ARV − repairs − the assignment fee
// (75% and $30K on the live location). It was "blended", the mean of three
// models, until 2026-09-14: the blend priced every unattended offer $20–52K
// above what a buyer pays, because one of its models is 90% ARV − 2× rehab.
// Matt: "the base offer is 75% of ARV − rehab − $30K, then find their floor
// from there." The counter band's ceiling is the same line at a $10K fee, so
// the bot has $20K of room to say yes in, and no more.
// See UNDERWRITE_MODES in shared/offer-calc.js.
export const UW_MODE = "mao";

export const UW_TAGS = {
  running: process.env.UW_RUNNING_TAG || "uw-running",
  done: process.env.UW_DONE_TAG || "uw-done",
  review: process.env.UW_REVIEW_TAG || "uw-needs-review",
  failed: process.env.UW_FAILED_TAG || "uw-failed",
};
const ALL_UW_TAGS = Object.values(UW_TAGS);

export const AUTO_UNDERWRITE_ENABLED = process.env.AUTO_UNDERWRITE_ENABLED === "true";

// Whether a webhook run publishes an offer or only saves a draft. The broker
// flag is the veto; with it on, a run is LIVE unless the caller opts out.
// It used to be the other way round — the workflow had to send dryRun:"false"
// to go live — and the TIER 1 workflow never did, so every clean underwrite
// landed as a draft with nothing pointing at why. GHL's Custom Data is all
// strings, so the opt-out is read as text: "true", "1", "yes" or "dry".
export function wantsDryRun(raw, enabled = AUTO_UNDERWRITE_ENABLED) {
  if (!enabled) return true;
  if (raw === true) return true;
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "dry";
}

/* ---------- job registry ---------- */

const jobs = new Map();     // jobId -> job
const lanes = new Map();    // locationId -> { running, waiting: [fn] }

let seq = 0;
const newJobId = () => `uw-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function getJob(id) {
  return jobs.get(id) || null;
}

// `contactId` filters BEFORE the cap — on a busy location the reply agent's
// "is one running for this person?" must not lose theirs to the slice.
export function listJobs(locationId, { limit = 25, contactId = null } = {}) {
  return [...jobs.values()]
    .filter((j) => j.locationId === locationId && (!contactId || j.contactId === contactId))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || (job.status !== "running" && job.status !== "queued")) return false;
  job.cancelRequested = true;
  return true;
}

// JSON-safe view for the polling route. `stopping` mirrors the sweep's — a
// cancel lands between stages, so the UI needs to say "finishing up" rather
// than pretend the job already stopped.
export function publicJob(job) {
  if (!job) return null;
  const { cancelRequested, _got, ...rest } = job;
  rest.stopping = Boolean(cancelRequested && (job.status === "running" || job.status === "queued"));
  return rest;
}

// The same run again: same contact, same house, same asking price. The address
// is the RESOLVED one when the first run got that far, so a retry doesn't pay
// to read the conversation twice. Whatever draft the first run left is handed
// over to be replaced, so History ends up with one record per attempt chain.
export function retryArgs(job) {
  return {
    contactId: job.contactId,
    message: job.message || "",
    address: job.address || job.suppliedAddress || "",
    askingPrice: job.askingPrice || job.suppliedAskingPrice || 0,
    dryRun: Boolean(job.dryRun),
    origin: job.origin,
    replaceOfferId: job.offerId || job.replaceOfferId || null,
    anyKind: Boolean(job.anyKind),
    retryOf: job.id,
  };
}

/* ---------- quiet runs (the backtest) ---------- */

// A backtest re-underwrites real houses with the buyer-view checks forced on
// and must leave no trace: no uw-* tag or note on a listing agent's contact,
// no draft, no event, no error row. Reads go through; every write is
// swallowed. The run itself is a fill run (no offer, no draft by design), so
// these only have to catch what a fill run still writes.
export function quietClient(client) {
  return {
    call: (path, opts = {}) => (String(opts?.method || "GET").toUpperCase() === "GET"
      ? client.call(path, opts)
      : Promise.resolve({ quiet: true })),
  };
}
const READ_METHOD = /^(get|list|count|find|search|load|read|has|all)/;
export function quietStore(store) {
  if (!store) return store;
  return new Proxy(store, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      if (READ_METHOD.test(String(prop))) return v.bind(target);
      return async () => ({ id: null, quiet: true });
    },
  });
}

// What a person removed on the draft this run replaces: the checks keep it
// removed rather than putting it back on a retry.
async function declinedFromDraft(store, id) {
  if (!id || typeof store?.getOffer !== "function") return null;
  const prior = await store.getOffer(id).catch(() => null);
  return prior?.draft?.checks?.declined || prior?.snapshot?.checks?.declined || null;
}

// For tests: the registry is process-wide, so a suite that starts jobs needs a
// way back to a clean slate.
export function _resetJobs() {
  jobs.clear();
  lanes.clear();
}

/* ---------- spend guards ---------- */

const dayStartIso = (now = Date.now()) => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

// How many auto-underwrites this location has started today.
//
// Counted from the STORE, not just the in-memory registry, so a broker that
// restarts (or crash-loops on a bad payload) can't hand a misconfigured GHL
// workflow a fresh budget every few minutes. Jobs still in flight, and jobs
// that failed before writing anything, are unioned in from memory by id.
export async function countToday({ store, locationId, now = Date.now() }) {
  const since = dayStartIso(now);
  const ids = new Set();
  for (const j of jobs.values()) {
    if (j.locationId === locationId && String(j.startedAt) >= since) ids.add(j.id);
  }
  const rows = await store.listOffers(locationId, { limit: 200, lean: true }).catch(() => []);
  for (const o of rows) {
    const uw = o?.autoUnderwrite;
    if (uw?.jobId && String(uw.startedAt || o.createdAt || "") >= since) ids.add(uw.jobId);
  }
  return ids.size;
}

// Has this contact already had this address underwritten recently? A chatty
// agent following up on the same listing three times in an afternoon should
// cost one Apify run, not three.
// `ignoreId` is the draft a retry is about to replace — without it, a retry
// finds its own predecessor's draft and "reuses" the run it was asked to redo.
/**
 * findOfferOut({ store, locationId, contactId, address, ignoreId }) → offer | null
 *
 * A live offer on this address, for this agent, that has been SENT or whose
 * price is AGREED — whatever its age. The one thing an unattended run must
 * never do is put a second number on a house the agent already has ours on.
 */
export async function findOfferOut({ store, locationId, contactId, address, ignoreId = null }) {
  const key = addressKey(address);
  if (!key) return null;
  const rows = await store.listOffers(locationId, { contactId, limit: 50, lean: true }).catch(() => []);
  for (const o of rows) {
    if (!o?.id || (ignoreId && o.id === ignoreId) || o.deal) continue;
    if (addressKey(o.address || "") !== key) continue;
    if (DEAD_STATUSES.has(offerStatusOf(o))) continue;
    const sent = (o.sends || []).some((s) => Object.values(s?.results || {}).some((r) => r?.ok));
    if (sent || priceAgreed(o)) return o;
  }
  return null;
}

export async function findRecent({ store, locationId, contactId, address, ignoreId = null, now = Date.now(), windowMs = 24 * 3600 * 1000 }) {
  const key = addressKey(address);
  if (!key) return null;
  const rows = await store.listOffers(locationId, { contactId, limit: 25, lean: true }).catch(() => []);
  for (const o of rows) {
    // Not just our own runs: an offer built by hand counts too. Lisa Shilling
    // (2026-09-15) was sent a hand-priced 425,750 at 2:40pm; the queued run
    // landed at 3:33 and, seeing no auto-underwrite on that offer, made a
    // second one at 472,500 on the same house.
    if (!o?.id) continue;
    if (ignoreId && o.id === ignoreId) continue;
    if (addressKey(o.address || "") !== key) continue;
    const ts = Date.parse(o.createdAt || o.autoUnderwrite.startedAt || "");
    if (Number.isFinite(ts) && now - ts <= windowMs) return o;
  }
  return null;
}

/**
 * paperAlreadyOut(offers, { address, offerId }) → the offer that went out, or null
 *
 * Paper beats a first pass. Once a written offer on a house has gone to the
 * agent, a "rough number, not underwritten yet" text undercuts it — Lisa
 * Shilling got 473k floated an hour after the written 425,750 (2026-09-15).
 * `offerId` is the new offer, excluded from the search.
 */
const LIVE_PAPER = new Set(["sent", "countered", "accepted", "realm_yes", "under_contract"]);
export function paperAlreadyOut(offers = [], { address = "", offerId = null } = {}) {
  const key = addressKey(address);
  if (!key) return null;
  return (offers || []).find((o) => o && o.id !== offerId && addressKey(o.address || "") === key
    && (LIVE_PAPER.has(offerStatusOf(o)) || (Array.isArray(o.sends) && o.sends.length > 0))) || null;
}

/* ---------- the waiting line (past the daily cap) ---------- */

// Durable, in job_cursors, so a redeploy doesn't forget who is waiting. One
// entry per contact per house; three days old and it's dropped — by then the
// conversation has moved on and a person should look.
export const QUEUE_CURSOR = "uwQueue";
export const QUEUE_MAX_DAYS = 3;

const queueKey = (i) => `${i.contactId}|${addressKey(i.address || "") || String(i.message || "").slice(0, 80)}`;

export async function enqueueUnderwrite({ store, locationId, contactId, message = "", address = "", now = Date.now() }) {
  const cur = await store.getJobCursor?.(locationId, QUEUE_CURSOR).catch(() => null);
  const items = Array.isArray(cur?.doc?.items) ? cur.doc.items : [];
  const item = { contactId, message: String(message || "").slice(0, 500), address: String(address || "").slice(0, 200), at: new Date(now).toISOString() };
  const at = items.findIndex((i) => queueKey(i) === queueKey(item));
  if (at < 0) items.push(item);
  await store.setJobCursor?.(locationId, QUEUE_CURSOR, { at: new Date(now).toISOString(), doc: { items } });
  return { position: (at < 0 ? items.length : at + 1), items: items.length };
}

/**
 * drainUnderwriteQueue({ store, locationId, saved, start, now }) → { started, left, dropped }
 *
 * Starts queued underwrites while the day's cap has room, oldest first.
 * `start(item)` is startUnderwrite with the route's deps, injected. A start
 * that hits the cap again stays in line; any other refusal or error drops it
 * (a missing key is not something waiting fixes).
 */
/**
 * underwriteDailyCap(saved) → number (Infinity = no cap)
 *
 * 0 means no cap (Matt, 2026-09-15: "increase the daily cap, dont put a cap"),
 * the way 0 means "any" for the outreach price and year filters. Blank or
 * missing keeps the default.
 */
export function underwriteDailyCap(saved = {}) {
  const raw = saved?.autoUnderwriteDailyCap;
  if (raw === 0 || raw === "0") return Infinity;
  const n = Number(raw);
  return n > 0 ? n : UW_DEFAULT_DAILY_CAP;
}

export async function drainUnderwriteQueue({ store, locationId, saved = {}, start, now = Date.now() }) {
  const cur = await store.getJobCursor?.(locationId, QUEUE_CURSOR).catch(() => null);
  const all = Array.isArray(cur?.doc?.items) ? cur.doc.items : [];
  if (!all.length || typeof start !== "function") return { started: 0, left: all.length, dropped: 0, droppedItems: [] };
  const fresh = all.filter((i) => now - Date.parse(i.at) <= QUEUE_MAX_DAYS * 86400000);
  // What left the line without running, and why — the router writes each one
  // down and puts it on Today. Until 2026-09-29 it was a console line.
  const droppedItems = all.filter((i) => !fresh.includes(i))
    .map((i) => ({ contactId: i.contactId, address: i.address || "", at: i.at, reason: `waited more than ${QUEUE_MAX_DAYS} days past the daily cap` }));
  let dropped = droppedItems.length;
  const cap = underwriteDailyCap(saved);
  let room = cap === Infinity ? Infinity : cap - (await countToday({ store, locationId, now }));
  const left = [];
  let started = 0;
  // One start per agent per pass. Colin Foote, 2026-09-15: 811 NE 66th and
  // 15605 NE 1st sat in line behind the cap; when it lifted, the first
  // started and the second — asked a second later, while that run was still
  // in flight — came back `deduped` (startUnderwrite's per-contact guard),
  // was counted as started, and left the queue without ever running. His
  // Bellevue flip was never priced until someone opened the offer page the
  // next day. A second house from the same agent waits for the next tick,
  // and a deduped answer stays in line rather than counting as a start.
  const startedFor = new Set();
  for (const item of fresh) {
    if (room <= 0 || startedFor.has(item.contactId)) { left.push(item); continue; }
    try {
      const r = await start(item);
      if (r?.skipped && /daily cap/.test(r.skipped)) { left.push(item); room = 0; continue; }
      if (r?.skipped) { dropped++; droppedItems.push({ contactId: item.contactId, address: item.address || "", at: item.at, reason: String(r.skipped).slice(0, 160) }); continue; }
      if (r?.deduped) { left.push(item); continue; }
      started++; room--; startedFor.add(item.contactId);
    } catch (e) {
      dropped++;
      droppedItems.push({ contactId: item.contactId, address: item.address || "", at: item.at, reason: `failed to start: ${String(e?.message || e).slice(0, 120)}` });
    }
  }
  if (started || dropped || left.length !== all.length) {
    await store.setJobCursor?.(locationId, QUEUE_CURSOR, { at: new Date(now).toISOString(), doc: { items: left } });
  }
  return { started, left: left.length, dropped, droppedItems };
}

/* ---------- stage 1: what did the agent actually say? ---------- */

const EXTRACT_SYSTEM =
  "You read inbound text messages sent to a real-estate wholesaler by listing agents, and pull out the one " +
  "property the agent wants an offer on. Rules: " +
  "Return the full street address including city and state when they are recoverable — from the message itself, " +
  "or from earlier messages in the thread when the newest message is a follow-up (\"what about that one?\"). " +
  "Write it as \"street, city, ST ZIP\" with the commas in place, even when the agent didn't use any: the comma " +
  "before the city is what tells everything downstream where the street name ends. " +
  "Return an empty address rather than a guess: a wrong address underwrites a different house and nobody catches it. " +
  "confidence is 'high' only when the street number, street name and city are all explicit somewhere in the thread, " +
  "and the newest message is unambiguously about that property. Use 'medium' when you had to infer which property " +
  "from context, 'low' when you are stitching together fragments. " +
  "askingPrice is the list price in whole dollars if the agent states one ('asking 525k' -> 525000); 0 otherwise — " +
  "do NOT treat an offer amount, a price cut, or a range as the asking price. " +
  "note is one sentence saying what you keyed on.";

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["address", "askingPrice", "confidence", "note"],
  properties: {
    address: { type: "string", description: "Full street address, or empty string if not recoverable" },
    askingPrice: { type: "integer", description: "List price in whole dollars, 0 when not stated" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    note: { type: "string", description: "One sentence on what you keyed on" },
  },
};

export const EXTRACT_MODEL = "claude-sonnet-5";
export async function extractRequest({ message, transcript, aiApiKey }) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });
  const text =
    `NEWEST INBOUND MESSAGE (this is the one to act on):\n"${String(message || "").slice(0, 2000)}"\n\n` +
    (transcript
      ? `EARLIER THREAD (US = our team, THEM = the agent) — context only:\n${String(transcript).slice(-12000)}\n\n`
      : "") +
    "Which property does the agent want an offer on?";

  let response;
  try {
    // Reading an address and a price out of a text is extraction, not
    // judgment: Sonnet at low effort, a fraction of what Opus at the default
    // (high) cost for the same four fields (2026-09-25).
    response = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      system: EXTRACT_SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    });
    meterAi("address_extraction", response, { model: EXTRACT_MODEL });
  } catch (e) {
    throw anthropicErrorToHttp(e);
  }
  if (response.stop_reason === "max_tokens") {
    throw Object.assign(new Error("address extraction was truncated"), { http: 502 });
  }
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("address extraction was declined"), { http: 502 });
  }
  const raw = response.content.find((b) => b.type === "text")?.text || "{}";
  const parsed = JSON.parse(raw);
  return {
    address: String(parsed.address || "").trim(),
    askingPrice: Math.max(0, Number(parsed.askingPrice) || 0),
    confidence: parsed.confidence || "low",
    note: String(parsed.note || "").slice(0, 300),
  };
}

/* ---------- stage 2: the comps that are actually nearby ---------- */

// Score every comp against the subject, backfill any missing distance from the
// coordinates, and keep only what is genuinely inside the radius.
//
// A comp whose distance can't be established is DROPPED, not kept. Everywhere
// else in this codebase an unknown datum is forgiving — the match scorecard
// abstains, the sqft filter keeps the comp — because a human is looking at the
// list. Here nobody is, and "within half a mile" has to mean it.
export function nearbyComps({ compsData, subjectFacts, subjectAddress = "", radiusMiles = UW_RADIUS_MILES, barriers = null, eraGivesWay = false }) {
  const origin = compsData?.subject?.lat != null ? compsData.subject : null;
  // The subject's own prior sale is not a comp for the subject.
  //
  // If the house changed hands inside the comp window it comes back in its own
  // sold search, at distance zero, and — because it is by definition a perfect
  // match on every criterion — sorts straight to the top and anchors the ARV on
  // the very transaction we are trying to value independently of. Caught on a
  // live run, where it was the highest $/sqft "renovated" comp in the set.
  const selfKey = addressKey(subjectAddress);
  const isSelf = (c) =>
    (selfKey && addressKey(c.address || "") === selfKey) ||
    (c.distance != null && c.distance < 0.01);   // ~50 ft: same parcel, different string
  // The era band is the pool's only gate applied here: beds, baths and size
  // were the pull's own bands, and year built only exists once the ring has
  // been enriched. Everything else is ranking, not filtering.
  const era = { bedsTol: Infinity, bathsTol: Infinity, sqftPct: Infinity, yearTol: UW_POOL_YEAR_TOLERANCE };
  // Location before age (2026-10-06): when a ring can't carry an ARV inside
  // the era band, the houses on the subject's side of the main roads come in
  // anyway, still scored down for their age, before the search widens. On
  // 2325 48th Ave SW the band dropped every 2005–2014 sale within 0.4 mi and
  // the run went a mile out for its evidence.
  const keep = (c) => inPool(subjectFacts, c, era).ok || (eraGivesWay && !isAcross(c));
  // Which side of the main roads each comp is on (shared/same-side.js) —
  // measured from the house, read by similarity. No map, no `side`.
  const sideFrom = origin || (subjectFacts?.lat != null ? subjectFacts : null);
  return markSides({ subject: sideFrom, comps: compsData?.comps || [], context: barriers })
    .map((c) => {
      const miles = c.distance == null && origin ? milesBetween(origin, c) : c.distance;
      const withDist = miles == null ? c : { ...c, distance: Math.round(miles * 100) / 100 };
      return { ...withDist, match: scoreComp(subjectFacts, withDist), similarity: similarity(subjectFacts, withDist, { radiusMiles }) };
    })
    .filter((c) => c.distance != null && c.distance <= radiusMiles)
    .filter((c) => !isSelf(c))
    .filter(keep)
    .sort(compareByMatch);
}

/**
 * gradeByPriceProxy(nearby) → { grades, rehabbed, proxy }
 *
 * The price stand-in for "renovated", as one step so the radius ladder can ask
 * "would this ring carry an ARV?" with exactly the logic the run then uses.
 *
 * Two questions, two pools — this is the part worth understanding.
 *
 *   "Where is the top of the local $/sqft distribution?" needs BREADTH.
 *   Ranking is scale-free once you divide by floor area, so a 4-bed two doors
 *   down tells you plenty about what a renovated house fetches here.
 *
 *   "Which comps carry the ARV?" needs TIGHTNESS — the closest matches to this
 *   specific house.
 *
 * Running both off one tight set was the bug: tight enough to defend an ARV is
 * too tight to have a distribution, and the proxy just refused. So the wide
 * pool establishes the renovated tier, and the ARV then takes the best-MATCHING
 * comps from inside that tier — compareByMatch already scores beds, baths,
 * size, era and distance, so the tightening is done by the scorecard rather
 * than by another set of hand-tuned bands.
 */
export function gradeByPriceProxy(nearby = [], { subjectSqft = 0 } = {}) {
  // `nearby` arrives most-similar first (nearbyComps). The proxy judges only
  // the closest UW_SIMILAR_CANDIDATES matches, and the top UW_PROXY_SHARE of
  // those by $/sqft is the renovated evidence — similar first, then price,
  // which is the reverse of what let the priciest house in the ring set the
  // ARV (see the dials).
  // The house's own side of the main roads first (shared/same-side.js): a
  // comp across one comes in only while this side is short of the
  // PRICE_PROXY_MIN_POOL the proxy needs. Without this the proxy's $/sqft
  // tier is exactly where across-the-road new builds win (2325 48th Ave SW).
  const { picked, acrossUsed, sameSide } = sameSideFirst(nearby, { min: PRICE_PROXY_MIN_POOL });
  const candidates = picked.slice(0, UW_SIMILAR_CANDIDATES);
  const acrossLeft = nearby.filter(isAcross).length - acrossUsed;
  const tier = Math.max(UW_MAX_ARV_COMPS, Math.round(candidates.length * UW_PROXY_SHARE));
  let proxy = markRenovatedByPrice(candidates, { take: tier });
  // The gut check. Too few priced sales for a real top tier (under
  // PRICE_PROXY_MIN_POOL) but at least UW_GUT_CHECK_MIN_COMPS: take the best
  // few by $/sqft as the renovated set and say so. Matt chose this on
  // 2026-09-14 — a rough number he can respond with beats a hold on a house
  // with three sales nearby. The gate asks for fewer comps when this fired,
  // and the ARV basis leads with "gut check".
  const priced = candidates.filter((c) => Number(c.price) > 0).length;
  if (!proxy.applied && priced >= UW_GUT_CHECK_MIN_COMPS) {
    const take = Math.min(UW_MIN_REHABBED_COMPS, priced);
    const rough = markRenovatedByPrice(candidates, { take, minPool: UW_GUT_CHECK_MIN_COMPS });
    proxy = { ...rough, gutCheck: true, reason: `gut check: only ${priced} priced comps, top ${take} by $/sqft taken as renovated` };
  }
  const markedRenovated = proxy.comps.filter((c) => ARV_CONDITIONS.has(c.condition));
  // Size-fit first. The pool admits comps ±30% off the subject so the $/sqft
  // tier has breadth, but the ARV gate refuses more than one comp over ±25%
  // (deriveArv's SIZE_TOLERANCE_PCT). Picking purely by match score let two
  // 0.7× houses carry the ARV on 10412 SE 219th St and the run held, when two
  // close-sized renovated comps were right there. So: comps within tolerance
  // carry it whenever there are enough of them; off-size ones only top the set
  // up to the minimum the gate asks for — which keeps them to one or fewer
  // whenever the tier has the evidence to allow it.
  const sqft = Number(subjectSqft) || 0;
  const fits = (c) => !(sqft > 0) || !(Number(c.sqft) > 0) || Math.abs(Number(c.sqft) - sqft) / sqft <= SIZE_TOLERANCE_PCT / 100;
  const ranked = [...markedRenovated].sort((a, b) => Number(isAcross(a)) - Number(isAcross(b)) || compareByMatch(a, b));
  const inSize = ranked.filter(fits);
  const offSize = ranked.filter((c) => !fits(c));
  const need = proxy.gutCheck ? UW_GUT_CHECK_MIN_COMPS : UW_MIN_REHABBED_COMPS;
  const rehabbed = (inSize.length >= need ? inSize : [...inSize, ...offSize.slice(0, need - inSize.length)])
    .slice(0, UW_MAX_ARV_COMPS);
  // Record the grade for EVERY comp the proxy judged, not just the handful
  // that went on to carry the ARV. The tier is usually wider than
  // UW_MAX_ARV_COMPS, so saving only the survivors threw away the verdict on
  // the rest: they came back to the board as "cond?", indistinguishable from
  // comps nothing had ever looked at. Tick one and it would join the ARV
  // ungraded, quietly changing which pool deriveArv values off.
  //
  // Comps OUTSIDE the tier still get nothing, deliberately — being in the
  // bottom two thirds of a $/sqft spread is not evidence that a house is
  // dated, and claiming it would be inventing a fact.
  const grades = Object.fromEntries(
    markedRenovated.map((c) => [c.id, {
      condition: c.condition, confidence: "medium", source: "price", note: proxy.reason,
    }])
  );
  if (nearby.length > candidates.length) {
    proxy = { ...proxy, reason: `most similar ${candidates.length} of ${nearby.length}: ${proxy.reason}` };
  }
  const sides = nearby.some((c) => c.side) ? { sameSide, acrossUsed, acrossLeft } : null;
  return { grades, rehabbed, proxy, sides };
}

/* ---------- the gates ---------- */

/**
 * Everything that has to be true before an unattended run is allowed to
 * publish an offer. Pure — this is the function to read (and to test) if you
 * want to know what the automation will and won't do on its own.
 *
 * Returns { ok, held: [reason] }. `held` is written verbatim into the GHL note,
 * so each reason has to read like something a person would say.
 */
export function evaluateGates({
  extraction, subject, rehabbedComps = [], arv, photosAnalyzed = 0, scan, repairs = 0, proxy = null,
  geocode = null, compsPool = null, compsRadiusMiles = UW_RADIUS_MILES, describedWork = false,
}) {
  const held = [];

  if (!extraction?.address) {
    held.push("no property address in the message");
  } else if (extraction.confidence !== "high") {
    held.push(`the address was read with ${extraction.confidence} confidence — "${extraction.address}"`);
  }

  if (!subject || subject.lat == null) {
    held.push("that address didn't resolve to a property record");
  }
  // Without the subject's floor area, two things quietly go wrong at once: the
  // comp search runs with no size filter, and deriveArv falls back to a plain
  // median with no size adjustment. Seen live — a run pulled comps spanning
  // 730 to 2,690 sqft and produced a confident ARV from them. Neither failure
  // announces itself, so this gate does.
  else if (!(Number(subject.sqft) > 0)) {
    held.push("the subject's square footage is unknown — comps can't be size-matched and the ARV can't be size-adjusted");
  }

  // The geocoder answers even when all it could find was a ZIP code or a town,
  // and says which. Everything downstream — the comp radius, the ARV, the
  // offer — is measured from that point, so a centroid is a review, not a
  // publish. Its own gate rather than part of the chain above: an address
  // nobody could pin usually has an unknown floor area too, and a reviewer
  // should be told both.
  if (geocode && precisionRank(geocode.precision) < PRECISION.street) {
    held.push(
      `"${extraction.address}" could only be placed at the centre of its ` +
      `${geocode.precision === "zip" ? "ZIP code" : "city"} — the comp search is centred on a guess`
    );
  }

  // When the price proxy declined, say THAT rather than "0 renovated comps".
  // The two look identical from the outside and have completely different
  // fixes: one wants a wider net, the other wants someone to look at photos.
  const compsBefore = held.length;
  if (proxy && !proxy.applied) {
    held.push(`${proxy.reason} — not enough nearby sales to tell renovated from tired by price`);
  } else {
    const n = rehabbedComps.length;
    const need = proxy?.gutCheck ? UW_GUT_CHECK_MIN_COMPS : UW_MIN_REHABBED_COMPS;
    if (n < need) {
      held.push(
        `only ${n} renovated/updated comp${n === 1 ? "" : "s"} within ${compsRadiusMiles} mi — ${need} required`
      );
    }
  }

  // Whichever of those two fired, "0 comps" has three completely different
  // causes and the note read identically for all of them: the search was
  // centred on the wrong place, nothing sold near the right one, or plenty did
  // and our own bed/bath/size bands cut every one. The pull already counts what
  // the box held before filtering — say it, so the next question is answerable
  // without paying for another run.
  if (held.length > compsBefore && compsPool && compsPool.pulled != null) {
    held.push(compsPoolReason(compsPool));
  }

  if (!arv) {
    held.push("no ARV could be derived from the comps");
  } else {
    // deriveArv falls back to every comp when it can't find two graded ones.
    // That fallback is right for a human who can see what it did; unattended
    // it is exactly the silent downgrade this whole feature must not make.
    if (!arv.graded) held.push("the ARV fell back to ungraded comps");
    if ((arv.oversized || []).length > 1) {
      held.push(`${arv.oversized.length} of the comps are more than ±25% off the subject's size`);
    }
  }

  // The agent describing the work ("new roof, kitchen and baths, flooring")
  // is half a scope already, so a thinner photo set still carries it.
  const minPhotos = describedWork ? UW_MIN_PHOTOS_DESCRIBED : UW_MIN_SUBJECT_PHOTOS;
  if (!(photosAnalyzed >= minPhotos)) {
    held.push(`only ${photosAnalyzed || 0} listing photo${photosAnalyzed === 1 ? "" : "s"} to scan — ${minPhotos} required for a scope of work`);
  }

  // Scaled for size past 2,500 sqft (heavyCeiling), so a big house isn't held
  // to a small one's ceiling. The slack still applies on top.
  const band = rehabBand(subject?.sqft || 0);
  const heavyTop = heavyCeiling(subject?.sqft || 0);
  if (band && repairs > heavyTop * UW_REPAIRS_BAND_SLACK) {
    const sized = heavyTop !== band.heavy[1] ? ` scaled to ${Number(subject.sqft).toLocaleString("en-US")} sqft` : "";
    held.push(`the scope totals ${fmtMoney(repairs)}, past the heavy band for ${band.label}${sized} (${fmtMoney(heavyTop)})`);
  }

  const foundation = (scan?.areas || []).find((a) => a.area === "foundation_structure");
  if (foundation?.grade === "poor") {
    held.push("the photo scan flagged a possible foundation or structural problem");
  }

  return { ok: held.length === 0, held };
}

/**
 * agentNumbersRescue({ held, theirArv, theirRehab, ourArv, repairs, listPrice, sqft })
 *   → { value, fix, capped, basis } | null
 *
 * On 2026-09-14 twelve of nineteen underwrites held, most on numbers we
 * couldn't make — zero priced comps in Shoreline, a $3M-reno HOA house, a scope
 * past the band — while the agent had already told us what it's worth and what
 * it needs. Those agents were promised a number and got nothing.
 *
 * When EVERY hold is one the agent's numbers answer, price on theirs, bounded:
 *   comps / ARV / size holds  → their value, capped at 125% of the list price
 *                               (no list price, no rescue — nothing to cap to)
 *   repair band / photo holds → their repairs, but never cutting our own
 *                               scope by more than a quarter, and still inside
 *                               the band
 * Anything else — an unsure address, a ZIP centroid, a structural flag — still
 * holds. The offer this makes is marked `agent_numbers`: it floats as a rough
 * number off their figures, and the paper never sends itself. Pure.
 */
// The buyer-view checks reach the rescue too (2026-10-02): an agent's value
// is still held to what similar houses list for today (`ceiling`), still
// takes the street cut (`cutPct`, negative), and the repairs never land under
// the scope the checks completed (`repairFloor`). All optional; absent means
// the checks didn't run.
export function agentNumbersRescue({
  held = [], theirArv = 0, theirRehab = 0, ourArv = 0, repairs = 0, listPrice = 0, sqft = 0,
  ceiling = 0, cutPct = 0, repairFloor = 0,
} = {}) {
  if (!held.length || !(theirArv > 0 || theirRehab > 0)) return null;
  // The patterns live with the triage (shared/held-underwrites.js) so the
  // nightly sweep asks the agent for exactly what this rescue can use.
  const VALUE = VALUE_HOLD;
  const WORK = WORK_HOLD;
  let needValue = false;
  let needRepairs = false;
  for (const h of held) {
    if (VALUE.test(h)) needValue = true;
    else if (WORK.test(h)) needRepairs = true;
    else return null;
  }
  let value = Math.round(Number(ourArv) || 0);
  let capped = false;
  if (needValue) {
    if (!(theirArv > 0) || !(listPrice > 0)) return null;
    const cap = Math.round(listPrice * UW_AGENT_ARV_MAX_OF_LIST);
    capped = theirArv > cap;
    value = Math.min(Math.round(theirArv), cap);
  }
  let listings = false;
  let streetCut = false;
  if (needValue) {
    if (Number(ceiling) > 0 && value > ceiling) { value = Math.round(ceiling); listings = true; }
    if (Number(cutPct) < 0) { value = Math.round(value * (1 + Number(cutPct) / 100) / 1000) * 1000; streetCut = true; }
  }
  if (!(value > 0)) return null;
  let fix = Math.round(Number(repairs) || 0);
  if (needRepairs) {
    if (!(theirRehab > 0)) return null;
    fix = Math.max(Math.round(theirRehab), Math.round(fix * (1 - UW_AGENT_REPAIR_CUT)), Math.round(Number(repairFloor) || 0));
    if (sqft > 0 && fix > heavyCeiling(sqft) * UW_REPAIRS_BAND_SLACK) return null;
  } else if (theirRehab > 0 && !(fix > 0)) {
    fix = Math.round(theirRehab);
  }
  const k = (n) => `${Math.round(n / 1000)}k`;
  const used = [
    needValue ? `their ${k(value)} value${capped ? " (held near the list price)" : ""}${listings ? " (held to today's listings)" : ""}${streetCut ? " (less the street)" : ""}` : "",
    needRepairs ? `their ${k(theirRehab)} repairs` : "",
  ].filter(Boolean).join(" and ");
  return { value, fix, capped, basis: `priced on the agent's numbers — ${used} — because ${String(held[0]).split(" — ")[0]}` };
}

/* ---------- a rough number instead of a hold (2026-10-08) ---------- */

// The bot tells an agent "I'll get you a number", the run holds on something
// only WE are missing — the square footage, a thin photo set, thin comps, a
// scope past the band — and the agent hears nothing until the nightly sweep
// retires the house. Matt (2026-10-08): price a rough first pass instead,
// float it as a range that says it's rough, ask for their read, and let
// their numbers re-run it.
//
// What only a person can settle still holds: no address, an address read
// with less than high confidence, a ZIP or city centroid, no property record,
// no ARV at all. Kind and rural holds never reach this (they stop the run
// before the comps). On by default: it sends nothing by itself — the float
// is still the realm check's own switches and gates.
export const roughNumbersOn = (saved) => saved?.roughNumbers?.enabled !== false;

// A hold the rough number may go past. Everything else is a real hold.
const ROUGH_NEVER = /no ARV|address was read with|could only be placed at the centre|couldn't locate|didn't resolve to a property record|no property address|^dry run|AUTO_UNDERWRITE_ENABLED|^stopped early/i;
const PHOTO_HOLD = /listing photos? to scan/i;
export function roughable(reason = "") {
  const s = String(reason || "");
  if (ROUGH_NEVER.test(s)) return false;
  return VALUE_HOLD.test(s) || WORK_HOLD.test(s) || STRUCTURAL_HOLD.test(s);
}

// What the work probably is, from what the agent said and the listing's
// words, else from how far under the ARV it's listed. Unknown is medium.
const HEAVY_WORDS = /\bgut\b|full (remodel|rehab|renovation)|down to the studs|tear ?down|fire|smoke damage|foundation|structural|\bmold\b|everything|major|heavy|uninhabitable|condemned|hoard/i;
const LIGHT_WORDS = /cosmetic|paint|carpet|light (work|rehab|updates?)|minor|just (needs|dated)|lipstick|refresh/i;
export function roughTier({ said = "", listPrice = 0, arv = 0 } = {}) {
  const t = String(said || "");
  if (HEAVY_WORDS.test(t)) return "heavy";
  if (LIGHT_WORDS.test(t)) return "light";
  const list = Number(listPrice) || 0;
  const value = Number(arv) || 0;
  if (list > 0 && value > 0) {
    const r = list / value;
    if (r <= 0.6) return "heavy";
    if (r <= 0.8) return "medium";
    return "light";
  }
  return "medium";
}

// The top of the tier's band for the house size (the heavy top scales past
// 2,500 sqft, as the gate's does). Rough means budget high, not low.
export function tierRepairs(sqft, tier = "medium") {
  const band = rehabBand(sqft);
  if (!band) return 0;
  if (tier === "heavy") return heavyCeiling(sqft);
  return (band[tier] || band.medium)[1];
}

// The subject's size when nobody had it: the middle of the comps' sizes.
export function medianSqft(comps = []) {
  const xs = (comps || []).map((c) => Number(c?.sqft) || 0).filter((v) => v > 0).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const m = xs.length >> 1;
  return Math.round(xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2);
}

/**
 * roughNumber({ held, arv, sqft, repairs, said, listPrice }) → { fix, tier, repairsSource, reasons } | null
 *
 * Every hold one the rough number may go past, an ARV, and a size: the
 * repairs to price on. A thin photo set (or none scanned) budgets the top of
 * the condition tier, never under what the scan did find; otherwise the scope
 * as scanned, uncapped. Pure.
 */
export function roughNumber({ held = [], arv = 0, sqft = 0, repairs = 0, said = "", listPrice = 0 } = {}) {
  if (!held.length || !(Number(arv) > 0) || !(Number(sqft) > 0)) return null;
  if (!held.every(roughable)) return null;
  let fix = Math.round(Number(repairs) || 0);
  let tier = null;
  let repairsSource = "scan";
  if (held.some((h) => PHOTO_HOLD.test(String(h))) || !(fix > 0)) {
    tier = roughTier({ said, listPrice, arv });
    fix = Math.max(fix, tierRepairs(sqft, tier));
    repairsSource = "tier";
  }
  if (!(fix > 0)) return null;
  return { fix, tier, repairsSource, reasons: [...held] };
}

/**
 * Why the comps came up short, in the terms of whoever has to fix it. Pure.
 *
 * "0 comps" has three unrelated causes and they used to read identically:
 *
 *   the scrape returned nothing   → an empty box, or a search that didn't work
 *   it returned rows we can't read → Zillow changed shape; a code fix
 *   it returned usable rows we cut → the bands, or the radius
 *
 * `rows` is null for the county-record source, which has no scrape to count,
 * so that path keeps the wording it always had.
 */
export function compsPoolReason({ rows = null, pulled = 0, kept = 0, radiusMiles = UW_RADIUS_MILES } = {}) {
  const radius = `${radiusMiles} mi`;
  if (pulled > 0) {
    return `${pulled} sold home${pulled === 1 ? "" : "s"} in the search box, ` +
      `${kept ?? 0} of them inside ${radius} and within the bed/bath/size bands`;
  }
  if (rows == null) return `nothing sold within ${radius} of that point in the last 12 months`;
  if (rows === 0) {
    return `the Zillow sold search returned nothing at all for that box — either nothing sold ` +
      `within ${radius} in the last 12 months, or the search itself didn't run`;
  }
  return `Zillow returned ${rows} sold row${rows === 1 ? "" : "s"} for that box and not one carried a ` +
    `usable price and position — that is a scrape problem, not a quiet neighbourhood`;
}

/**
 * Which address the run works from, given what was typed and what the
 * geocoder made of it. Pure.
 *
 * Adopts the geocoder's canonical form only when it actually resolved to a
 * street or a parcel — a ZIP centroid has no address to canonicalise to — and
 * only when it says something the typed one didn't. `typedAddress` is empty
 * when nothing changed, so nothing downstream reports a rewrite that never
 * happened.
 */
export function addressToWorkFrom(typed, geo) {
  const same = { address: typed, typedAddress: "" };
  if (!atLeast(geo, "street") || !geo.matched) return same;
  if (addressKey(geo.matched) === addressKey(typed)) return same;
  return { address: geo.matched, typedAddress: typed };
}

/* ---------- the Subject Property field ---------- */

// One resolver, so a run that creates the field can't file it somewhere the
// import wouldn't have.
const subjectPropertyFieldId = (client, locationId) =>
  findOrCreateCustomFieldByKey(
    client, locationId,
    SUBJECT_PROPERTY_FIELD.key, SUBJECT_PROPERTY_FIELD.name, SUBJECT_PROPERTY_FIELD.dataType,
    { siblingKey: SUBJECT_PROPERTY_FIELD.folderSibling }
  );

/**
 * addressSourceFor({ linked, suppliedAddress, refereed }) → "link" | "thread" | "standing"
 *
 * Pure. Which answer the run works from. A listing link in the message is the
 * newest thing the agent sent and names the house outright, so the thread
 * referee never overrules it — not even when the link agrees with the
 * workflow. On 2026-09-29 an agent texted a Zillow link to 835 SW 355th
 * Ct, the workflow said the same house, and the referee (reading an older
 * mention of 8228 24th St Ct W in the thread) sent the run to Tacoma instead.
 */
export function addressSourceFor({ linked = null, suppliedAddress = "", refereed = null } = {}) {
  if (linked && addressKey(linked.address) !== addressKey(suppliedAddress)) return "link";
  if (linked) return "standing";
  if (refereed?.moved) return "thread";
  return "standing";
}

/**
 * refereeAddress({ standing, recent, transcript }) → { address, moved } | null
 *
 * Pure. `standing` is the address a field or workflow handed us; `recent`
 * is every address the record has seen this agent raise; `transcript` is
 * the newest slice of the thread. The candidate mentioned LAST in the
 * thread is the answer. `moved` is true when that is a different property
 * from the standing one — the case where trusting the field would have
 * underwritten the wrong house. No candidate in the thread → null, and the
 * caller keeps the standing answer.
 */
export function refereeAddress({ standing = "", recent = [], transcript = "" } = {}) {
  const pick = mostRecentlyMentioned(transcript, [standing, ...recent].filter(Boolean));
  if (!pick) return null;
  return { address: pick.address, moved: Boolean(standing) && addressKey(pick.address) !== addressKey(standing) };
}

// The contact's current Subject Property, off a contact record we already have.
// Needs the field's id, which is created on demand like every other app field.
async function readSubjectProperty(client, locationId, contact, { store = null, contactId = "" } = {}) {
  // The record first: the aim the app filed outranks the GHL field, which
  // is a copy of it (and can lag a write, or drift by key).
  if (store?.getContactProfile && contactId) {
    try {
      const aim = currentFacts((await store.getContactProfile(locationId, contactId))?.facts || {}).subject_property;
      if (aim) return String(aim).trim();
    } catch { /* fall through to the field */ }
  }
  if (!contact) return "";
  try {
    const id = await subjectPropertyFieldId(client, locationId);
    return String((contact.customFields || []).find((f) => f.id === id)?.value ?? "").trim();
  } catch {
    return "";   // the field not existing yet is not an error, it's day one
  }
}

// Point Subject Property at what this run actually underwrote.
//
// Closes the loop: an agent who raises a new address in conversation gets the
// field updated by the run itself, so the NEXT trigger — and anyone reading the
// contact in GHL — sees the house we're actually working. Non-fatal; a run is
// not worth failing over a field write.
async function writeSubjectProperty(client, locationId, contactId, address, warnings, { store = null, jobId = null, from = "" } = {}) {
  try {
    const id = await subjectPropertyFieldId(client, locationId);
    await updateContact(client, contactId, { customFields: [{ id, value: address }] });
  } catch (e) {
    warnings.push(`subject property: ${e.message}`);
  }
  // The record: the aim moved, and the run that moved it.
  if (store) {
    const at = new Date().toISOString();
    await learnFacts({ store, locationId, contactId, party: "agent", facts: [{ key: "subject_property", value: address, source: "offer", at, ref: jobId }] });
    await recordEvent({ store, locationId, contactId, party: "agent", type: "subject_property_set", at, address, source: "offer", ref: jobId, data: { from } });
  }
}

/* ---------- GHL writeback ---------- */

const contactName = (c) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.name || c?.contactName || "";

// Move the contact from whatever uw-* tag it wears to this one. Without the
// removal a contact ends up permanently tagged uw-running and every GHL filter
// built on these tags quietly stops meaning anything.
async function setTag(client, contactId, tag, warnings) {
  try {
    const stale = ALL_UW_TAGS.filter((t) => t !== tag);
    if (stale.length) await removeContactTags(client, contactId, stale).catch(() => {});
    await addContactTags(client, contactId, [tag]);
  } catch (e) {
    warnings.push(`tag ${tag}: ${e.message}`);
  }
}

async function note(client, contactId, body, warnings) {
  try {
    // GHL wants { body }, not a bare string — a string serializes to a JSON
    // string and the API rejects it as malformed. It fails into `warnings`
    // rather than loudly, which is exactly why this survived until a live run:
    // the tags landed, the notes never did.
    await createContactNote(client, contactId, { body });
  } catch (e) {
    warnings.push(`note: ${e.message}`);
  }
}

/* ---------- the pipeline ---------- */

/**
 * startUnderwrite(...) — validates, enqueues, returns the job immediately.
 * The caller (the webhook route) answers GHL right away; everything below
 * happens on the lane.
 *
 * deps.createOffer is offers.js's createOfferFromRequest, injected so an
 * automated offer travels the identical code path as a hand-built one.
 */
export async function startUnderwrite({
  client, locationId, saved, store, contactId, message, address, askingPrice, dryRun, deps, origin = "workflow", fill = false,
  queueIfCapped = false, replaceOfferId = null, retryOf = null, anyKind = false,
  // The buyer-view checks (shared/underwrite-checks.js): `forceChecks` runs
  // them whatever the saved switch says (the backtest); `declined` is what a
  // person removed on the editor; `quiet` is the backtest's no-trace mode.
  forceChecks = false, declined = null, quiet = false,
}) {
  if (quiet) {
    fill = true;
    client = quietClient(client);
    store = quietStore(store);
    deps = { ...(deps || {}), onHeld: undefined, onOfferCreated: undefined, createOffer: undefined };
  }
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  if (!aiApiKey) throw Object.assign(new Error("Anthropic API key required (Settings)"), { http: 400 });
  const compsApiKey = String(saved?.compsApiKey || saved?.rentcastApiKey || "").trim();
  // Zillow is the default comps source and needs no RealEstateAPI key at all —
  // Apify covers both the sold-comp search and the subject's listing.
  if (saved?.compsSource === "realestateapi" && !compsApiKey) {
    throw Object.assign(new Error("RealEstateAPI key required (Settings) — or switch the comps source to Zillow"), { http: 400 });
  }
  const apifyToken = String(saved?.apifyToken || "").trim();
  if (!apifyToken) throw Object.assign(new Error("Apify token required (Settings) for comps and listing photos"), { http: 400 });

  // One run at a time per contact per house. The stored-offer dedupe
  // (findRecent) only sees a run once it has FINISHED, and a run takes
  // minutes — an agent who texts the address twice meanwhile would otherwise
  // pay for two. A job with no address yet may be this house, so it counts.
  if (!fill && contactId) {
    const want = addressKey(String(address || ""));
    const inFlight = [...jobs.values()].find((j) => j.locationId === locationId && j.contactId === contactId && !j.fill
      && (j.status === "queued" || j.status === "running")
      && (!want || !(j.address || j.suppliedAddress) || addressKey(j.address || j.suppliedAddress) === want));
    if (inFlight) return { deduped: true, job: inFlight };
  }

  const cap = underwriteDailyCap(saved);
  const usedToday = cap === Infinity ? 0 : await countToday({ store, locationId });
  if (usedToday >= cap) {
    // From the conversation, an address past the cap waits in line instead
    // of being dropped: the agent was told we're running it, and the broker
    // tick starts it the moment the cap resets.
    if (queueIfCapped && contactId) {
      const q = await enqueueUnderwrite({ store, locationId, contactId, message, address });
      return { queued: true, position: q.position, reason: `daily cap reached (${usedToday}/${cap})`, job: null };
    }
    return { skipped: `daily cap reached (${usedToday}/${cap})`, job: null };
  }

  const job = {
    id: newJobId(),
    locationId,
    contactId,
    contactName: "",
    status: "queued",
    phase: "queued",
    message: String(message || "").slice(0, 500),
    // An address handed over by the GHL workflow. When the conversation bot has
    // already confirmed the property with the agent, that capture is better
    // evidence than anything a one-shot extraction can produce from the same
    // thread — and skipping the extraction saves a Claude call and removes a
    // failure mode. Blank falls back to reading the conversation.
    suppliedAddress: String(address || "").trim().slice(0, 200),
    suppliedAskingPrice: Math.max(0, Number(askingPrice) || 0),
    // "workflow" when GHL fired this; "operator" when a person pressed the
    // Auto-underwrite button on the offer form with an address they typed.
    origin: origin === "operator" ? "operator" : "workflow",
    // FILL: the offer form asked. The run does all the same work and hands
    // the workspace back on the job (`snapshot`) for the form to take in
    // place — it creates no offer and no draft, because the record it
    // belongs to is the one open on the operator's screen.
    fill: Boolean(fill),
    // ANY KIND: a person pressed "Underwrite anyway" on a not-single-family
    // hold. The run skips that one hold and nothing else — every other gate
    // and dedupe still applies, and it makes the offer like any other run.
    anyKind: Boolean(anyKind),
    forceChecks: Boolean(forceChecks),
    quiet: Boolean(quiet),
    declined: declined && typeof declined === "object" ? declined : null,
    // What the checks did (the summary kept on the offer) and the numbers
    // before them — a backtest reads both off one run.
    checks: null,
    checksBefore: null,
    snapshot: null,
    address: "",
    askingPrice: null,
    addressSource: null,
    compsSource: null,
    conditionSource: null,
    dryRun: Boolean(dryRun),
    arv: null,
    arvBasis: "",
    repairs: null,
    cashAmount: null,
    compsUsed: [],
    photosAnalyzed: 0,
    offerId: null,
    offerUrl: null,
    held: [],
    warnings: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    // Set once the contact has been tagged uw-running, so every exit path
    // knows whether it owes the contact a terminal tag.
    announced: false,
    cancelRequested: false,
    retryOf: retryOf ? String(retryOf) : null,
    // The draft an earlier attempt left. This run overwrites it (held or
    // failed again) or deletes it (an offer landed) instead of adding another.
    replaceOfferId: replaceOfferId ? String(replaceOfferId) : null,
    // What each stage has loaded so far, so a run that dies at comps still
    // leaves the address, listing facts and anything else it paid for. Kept
    // off the polled view — see publicJob.
    _got: {},
  };
  jobs.set(job.id, job);

  runOnLane(locationId, () =>
    runUnderwrite(job, { client, locationId, saved, store, aiApiKey, compsApiKey, apifyToken, deps })
      .then(async () => {
        // A stop is a deliberate act by someone who is looking at the screen,
        // so it clears the uw-* tags outright rather than leaving a
        // needs-review nag behind. It still leaves a note: the agent's text is
        // sitting unanswered either way, and that is worth a trace.
        if (job.status === "canceled" && job.announced) {
          await removeContactTags(client, contactId, ALL_UW_TAGS).catch(() => {});
          await note(client, contactId,
            `Auto-underwrite stopped for ${job.address || "an unidentified property"} before it finished. Nothing was created.`,
            job.warnings);
        }
      })
      .catch(async (e) => {
        job.status = "error";
        job.error = String(e?.message || e).slice(0, 300);
        job.finishedAt = new Date().toISOString();
        await recordError(store, { locationId, area: "underwrite", err: e, context: { contactId, jobId: job.id, stage: job.stage } });
        // A timeout or a provider refusal still leaves work behind — the
        // resolved address, the listing's facts, maybe the comps. Save it as a
        // draft so "Review" opens the form on what loaded rather than nothing.
        let draftSaved = false;
        try {
          draftSaved = await saveLoadedDraft(job, { client, locationId, store });
        } catch (err) {
          job.warnings.push(`couldn't save what loaded: ${String(err?.message || err).slice(0, 120)}`);
        }
        // A run that dies mid-flight must not leave the contact wearing
        // uw-running forever — that tag is what GHL filters are built on, and
        // a stuck one quietly poisons every one of them. Say what broke, too:
        // otherwise an agent's text just vanishes and nobody finds out until
        // they follow up.
        if (job.announced) {
          await setTag(client, contactId, UW_TAGS.failed, job.warnings);
          await note(client, contactId,
            `Auto-underwrite failed for ${job.address || "an unidentified property"} — ${job.error}\n\n` +
            (draftSaved
              ? `What loaded before it stopped is saved as a draft — open it from History, or press Retry there.`
              : `Nothing was created. The agent's message is still in the thread above; underwrite it by hand, ` +
                `or fix the cause and retry it from History.`),
            job.warnings);
        }
      })
  );

  return { skipped: null, job };
}

// Two at a time per location. Apify runs take ~90s each and cost credits;
// letting a busy morning fan out twenty of them at once is how you find out
// what your Apify plan's ceiling is.
function runOnLane(locationId, fn) {
  const lane = lanes.get(locationId) || { running: 0, waiting: [] };
  lanes.set(locationId, lane);
  const next = () => {
    lane.running--;
    const queued = lane.waiting.shift();
    if (queued) {
      lane.running++;
      queued().then(next, next);
    }
  };
  if (lane.running < MAX_CONCURRENT_PER_LOCATION) {
    lane.running++;
    fn().then(next, next);
  } else {
    lane.waiting.push(fn);
  }
}

const canceled = (job) => {
  if (!job.cancelRequested) return false;
  job.status = "canceled";
  job.finishedAt = new Date().toISOString();
  return true;
};

async function runUnderwrite(job, ctx) {
  const { client, locationId, saved, store, aiApiKey, compsApiKey, apifyToken, deps } = ctx;
  const compsSource = saved?.compsSource === "realestateapi" ? "realestateapi" : "zillow";
  const compsCondition = saved?.compsCondition === "ai" ? "ai" : "price";
  const warnings = job.warnings;
  const got = job._got || (job._got = {});
  job.status = "running";

  let contact = null;
  try {
    contact = await getContact(client, job.contactId);
    job.contactName = contactName(contact);
  } catch { /* the name is decoration; the id is what matters */ }

  /* --- 1. the address --- */
  job.phase = "extracting";
  if (canceled(job)) return;

  // Two ways in, and the cheap one is also the better one.
  //
  // When the GHL workflow supplies an address, the conversation bot has already
  // confirmed the property with the agent across several turns — a much
  // stronger signal than one model call re-reading the same thread, and it
  // costs nothing. When it doesn't (an Inbound Message trigger, or a bot field
  // that hadn't been written yet when the workflow fired), fall back to reading
  // the conversation. The fallback is why an empty `address` is not an error.
  // Where the address comes from, cheapest and most trustworthy first:
  //
  //   1. the workflow body — the bot confirmed it with the agent this minute
  //   2. the Subject Property field — the standing answer to "which house is
  //      this agent talking to us about", seeded from the hook at import and
  //      kept current by the AI sweep and by runs like this one
  //   3. the conversation itself — a model call, and the only one that can be
  //      wrong, which is why it alone is gated on high confidence
  const fieldAddress = job.suppliedAddress ? "" : await readSubjectProperty(client, locationId, contact, { store, contactId: job.contactId });

  // …but the conversation is the referee. A workflow field or a Subject
  // Property can be stale — set on Monday's house while Tuesday's thread is
  // about a different one — and until now a set field was trusted with high
  // confidence and the thread never read. So: when we have a standing
  // answer, read the newest slice of the thread anyway and let whichever
  // candidate was mentioned LAST win. Candidates are the standing answer and
  // every address the record has seen this agent raise. Nothing mentioned in
  // the thread at all → the standing answer holds, as before.
  // A listing link in the message names the house outright — it is the
  // newest thing the agent sent, so it outranks a standing field. The last
  // link wins when there are several. See listing-links.js.
  // A person pointing at one house — typed into the form, or "Underwrite
  // anyway" on its row — has named it. Nothing below overrules them: on
  // 2026-10-02 the referee would have taken Karamveer Tiwana's 13348 32nd Ave
  // S row to 21902 29th Ave South, which the thread had moved on to, and
  // written that house over the row's held draft.
  const pinned = job.origin === "operator" || job.anyKind;
  let linked = null;
  if (!pinned && job.message) {
    const x = await expandListingLinks(job.message).catch(() => ({ links: [] }));
    linked = x.links?.length ? x.links[x.links.length - 1] : null;
  }

  let standing = job.suppliedAddress || fieldAddress || "";
  let refereed = null;
  // An address a person just typed into the form is the answer, full stop.
  // The referee exists for fields that can go stale; nothing is staler than
  // a thread overruling the operator who is looking at the house right now.
  if (standing && !pinned) {
    let recentText = "";
    try {
      const t = await buildTranscript(client, locationId, job.contactId, {
        maxConversations: 1, maxPagesPerConvo: 1, maxMessages: 40, maxChars: 8000, maxCallTranscripts: 0,
      });
      recentText = t.text || "";
    } catch { /* no thread to read — the standing answer holds */ }
    let recent = [];
    try {
      recent = (await store.listContactEvents?.(locationId, job.contactId, { limit: 60 }) || [])
        .filter((e) => e?.address && ["subject_property_set", "property_details", "agent_estimate", "offer_sent", "offer_revised"].includes(e.type))
        .map((e) => e.address);
    } catch { recent = []; }
    refereed = refereeAddress({ standing, recent, transcript: recentText });
  }

  let extraction;
  const from = addressSourceFor({ linked, suppliedAddress: job.suppliedAddress || "", refereed });
  if (from === "link") {
    extraction = {
      address: linked.address,
      askingPrice: job.suppliedAskingPrice,
      confidence: "high",
      note: `Address read from the ${linked.source} link in the message.`,
      source: "listing_link",
    };
    if (standing && addressKey(standing) !== addressKey(linked.address)) {
      warnings.push(`the message's ${linked.source} link is for ${linked.address}, not ${standing} — went with the link`);
    }
  } else if (from === "thread") {
    extraction = {
      address: refereed.address,
      askingPrice: 0,
      confidence: "high",
      note: `The thread moved on: the ${job.suppliedAddress ? "workflow" : "Subject Property"} said ${standing}, but the newest messages are about ${refereed.address}.`,
      source: "thread",
    };
    warnings.push(`subject property was stale: ${standing} → ${refereed.address}`);
  } else if (job.suppliedAddress) {
    extraction = job.origin === "operator"
      ? {
        address: job.suppliedAddress,
        askingPrice: job.suppliedAskingPrice,
        confidence: "high",
        note: "Address typed into the offer form by the operator.",
        source: "operator",
      }
      : job.anyKind
      ? {
        address: job.suppliedAddress,
        askingPrice: job.suppliedAskingPrice,
        confidence: "high",
        note: "The house on the held row \"Underwrite anyway\" was pressed on.",
        source: "anyway",
      }
      : {
        address: job.suppliedAddress,
        askingPrice: job.suppliedAskingPrice,
        confidence: "high",
        note: "Address supplied by the GHL workflow — already confirmed with the agent in conversation.",
        source: "workflow",
      };
  } else if (fieldAddress) {
    extraction = {
      address: fieldAddress,
      askingPrice: job.suppliedAskingPrice,
      confidence: "high",
      note: "Address from the contact's Subject Property field.",
      source: "subject_property",
    };
  } else {
    let transcript = "";
    try {
      const t = await buildTranscript(client, locationId, job.contactId, {
        maxConversations: 2, maxPagesPerConvo: 1, maxMessages: 40, maxChars: 12000, maxCallTranscripts: 0,
      });
      transcript = t.text || "";
    } catch { /* missing conversations.readonly — the message alone usually carries the address */ }
    // Their words about how it's being sold ("pocket listing", "not listed
    // yet"), for the off-market mark on the offer this run lands.
    job.offMarketCue = offMarketSignals({ message: job.message, transcript });

    extraction = { ...(await extractRequest({ message: job.message, transcript, aiApiKey })), source: "conversation" };
    // An asking price named in the workflow still wins: it comes off a field
    // the bot wrote, not off a sentence the model had to parse.
    if (job.suppliedAskingPrice) extraction.askingPrice = job.suppliedAskingPrice;
  }
  job.address = extraction.address;
  job.askingPrice = extraction.askingPrice || null;
  job.extractionNote = extraction.note;
  job.addressSource = extraction.source;
  got.extraction = extraction;

  if (!extraction.address) {
    return finishHeld(job, ctx, { extraction, held: ["no property address in the message"], partial: {} });
  }

  // Resolve the address BEFORE anything is looked up with it, and work from
  // the address that resolved.
  //
  // An agent texts "2614 S 54th" — no "St", which is how people write. That
  // string then went to Zillow for the listing, to the comp search for a
  // centre, onto the contact record and into the letter. Here it is resolved
  // once, and when it comes back as a real parcel the canonical form is what
  // the rest of the run uses: Zillow matches more listings with it, the
  // documents print it, and the duplicate check compares like with like. The
  // typed form is kept beside it, because the operator asked about that one.
  //
  // Below street precision nothing is adopted — a ZIP centroid has no address
  // to canonicalise to, and the gate at the end holds the run for review.
  // A street-only line ("34418 54th Ave S") is finished from what we already
  // know about this agent — the listing we texted them about, their Subject
  // Property, their city, their outreach batch's county — before it goes to
  // the geocoder, which would otherwise place it anywhere in the country or
  // nowhere at all (three "couldn't locate" holds on 2026-09-16, all
  // shorthand from agents who write like people). The bare line is tried last.
  let resolved = null;
  {
    const variants = completeAddress(extraction.address, {
      candidates: [fieldAddress, ...(await knownAddressesFor({ store, locationId, contactId: job.contactId }))],
      city: contact?.city || "", state: contact?.state || "", county: countyFromTags(contact?.tags),
    });
    for (const v of variants) {
      resolved = await geocodeAddress(v);
      if (resolved) {
        if (v !== extraction.address) {
          warnings.push(`address completed: "${extraction.address}" → "${v}"`);
          extraction.address = v;
          extraction.note = `${extraction.note || ""} Completed to "${v}" from what the contact record already knew.`.trim();
        }
        break;
      }
    }
  }
  const chosen = addressToWorkFrom(extraction.address, resolved);
  extraction.address = chosen.address;
  if (chosen.typedAddress) {
    extraction.typedAddress = chosen.typedAddress;
    job.typedAddress = chosen.typedAddress;
  }
  job.address = extraction.address;

  // Announce only once we know what we're working on — a note that says
  // "started" with no address is noise on the contact record.
  await setTag(client, job.contactId, UW_TAGS.running, warnings);
  await note(client, job.contactId,
    `Auto-underwrite started for ${extraction.address}` +
    (extraction.typedAddress ? ` (resolved from "${extraction.typedAddress}")` : "") +
    (extraction.source === "conversation" ? " (read from the conversation)" : "") + "." +
    (extraction.askingPrice ? ` Asking ${fmtMoney(extraction.askingPrice)}.` : ""),
    warnings);
  // From here on the contact wears a uw-* tag, so any exit — including a crash
  // — owes it a terminal one. See the catch in startUnderwrite.
  job.announced = true;

  // Only when this run knows better than the field does. Re-writing the same
  // value would churn the contact's audit trail for nothing.
  if (extraction.source !== "subject_property" && addressKey(extraction.address) !== addressKey(fieldAddress)) {
    await writeSubjectProperty(client, locationId, job.contactId, extraction.address, warnings, { store, jobId: job.id, from: fieldAddress || "" });
  }

  // A house we have already put a number in front of this agent on is not
  // re-priced by the machine, however old that number is. Heather Vandyken
  // (2026-09-16): the seller had accepted our August 825; a fresh run on
  // 2026-09-15 floated 795 "after the latest look", and the deal was lost
  // from there. Only a person, replacing the offer on purpose, re-runs it.
  const out = job.fill ? null : await findOfferOut({ store, locationId, contactId: job.contactId, address: extraction.address, ignoreId: job.replaceOfferId });
  if (out) {
    job.status = "done";
    job.phase = "";
    job.offerId = out.id;
    job.offerUrl = out.pdfUrl || null;
    job.cashAmount = out.cashAmount ?? null;
    job.duplicateOf = out.id;
    job.finishedAt = new Date().toISOString();
    await setTag(client, job.contactId, UW_TAGS.done, warnings);
    await note(client, job.contactId,
      `Our ${fmtMoney(out.cashAmount || 0)} on ${extraction.address} is already in front of this agent${priceAgreed(out) ? ` and agreed` : ""} — not re-priced. Replace the offer yourself if the number should change.`,
      warnings);
    return;
  }
  // A fill run is a person asking for numbers on the form in front of them;
  // pointing them at yesterday's offer is not an answer to that.
  const dupe = job.fill ? null : await findRecent({
    store, locationId, contactId: job.contactId, address: extraction.address, ignoreId: job.replaceOfferId,
  });
  if (dupe) {
    job.status = "done";
    job.phase = "";
    job.offerId = dupe.id;
    job.offerUrl = dupe.pdfUrl || null;
    job.cashAmount = dupe.cashAmount ?? null;
    job.duplicateOf = dupe.id;
    job.finishedAt = new Date().toISOString();
    await setTag(client, job.contactId, UW_TAGS.done, warnings);
    await note(client, job.contactId,
      `Already underwrote ${extraction.address} for this agent in the last 24 hours — reusing that offer instead of running again.`,
      warnings);
    return;
  }

  /* --- 2. the subject --- */
  job.phase = "subject";
  if (canceled(job)) return;

  // The subject's Zillow listing is fetched ONCE, here, and used twice: its
  // facts (beds/baths/sqft/year) shape the comp search, and its photos are the
  // scope of work. It used to be pulled down in the rehab stage, after the
  // comps had already been searched with whatever the comps provider thought
  // the subject was — which is backwards when Zillow is the comps source too.
  let photos = [];
  let photosCount = 0;
  let listing = null;
  let facts = null;
  try {
    let foundAs;
    ({ photos, photosCount, listing, facts, foundAs } = await fetchZillowPhotos(extraction.address, apifyToken, { matched: resolved?.matched }));
    if (foundAs) warnings.push(`Zillow listing found as "${foundAs}"`);
    // The list price rides along on the listing; the offer is capped against it.
    const listed = moneyFromListing(listing?.listPrice);
    if (listed) job.listPrice = listed;
  } catch (e) {
    warnings.push(`Zillow listing: ${e.message}`);
    if (compsApiKey) {
      // MLS Detail is the other way in, for accounts carrying that add-on.
      try {
        ({ photos, photosCount, listing } = await fetchListingPhotos(extraction.address, compsApiKey));
      } catch (e2) {
        warnings.push(`MLS photos: ${e2.message}`);
      }
    }
  }
  job.photosAnalyzed = photos.length;
  got.listing = listing;
  got.photosCount = photosCount;
  if (!photos.length) {
    warnings.push(`no listing photos for ${extraction.address} — the scope of work can't be scanned`);
  }

  // Not our kind of house (shared/asset-type.js kindHold). Matt, 2026-10-01:
  // single-family houses only for now. A mobile home, a townhouse, a condo, a
  // multi-family or land is held here — before the comps and the photo scan
  // are paid for — as a person's call on Today. "Underwrite anyway" there
  // starts an anyKind run, and a run from the editor is a fill run; both skip
  // this.
  //
  // Rural (shared/asset-type.js ruralHold). Matt, 2026-10-08: two acres or
  // more is harder to comp and our buyers don't want it. Held at the same
  // point, and the held sweep passes it and tells the agent (held-underwrites.js).
  const kindHeld = job.fill || job.anyKind ? "" : kindHold(facts?.homeType, saved?.focusKinds) || ruralHold(facts?.lotSqft);
  if (kindHeld) {
    const subjectOnly = {
      lat: resolved?.lat ?? null, lng: resolved?.lng ?? null,
      beds: facts?.beds ?? null, baths: facts?.baths ?? null, sqft: facts?.sqft ?? null, yearBuilt: facts?.yearBuilt ?? null,
      lotSqft: facts?.lotSqft ?? null, homeType: facts?.homeType ?? null, units: facts?.units ?? null,
      stories: null, subdivision: null, material: null,
    };
    got.subject = subjectOnly;
    return finishHeld(job, ctx, { extraction, held: [kindHeld], partial: {
      compsData: null, subject: subjectOnly, subjectSqft: Number(facts?.sqft) || 0, grades: {}, rehabbed: null, arv: null, rehabState: null, scope: [], repairs: null,
    } });
  }

  /* --- 3. comps --- */
  job.phase = "comps";
  job.compsSource = compsSource;
  if (canceled(job)) return;

  let compsData;
  let subject;
  let geocode = null;
  let compsRadiusMiles = UW_RADIUS_MILES;
  // Same side of the main roads (shared/same-side.js): the map, and whether
  // the ring's own era band had to give way to keep the comps close.
  let barriersPromise = Promise.resolve(null);
  let barriers = null;
  let eraGivesWay = false;
  const startBarriers = (point, radiusMiles) => (deps?.fetchBarriers || fetchBarriers)({ subject: point, radiusMiles })
    .then((r) => {
      if (!r?.context) warnings.push(`street map: ${String(r?.error || "unavailable").slice(0, 160)} — side of the main roads not checked`);
      return r?.context || null;
    })
    .catch((e) => { warnings.push(`street map: ${String(e?.message || e).slice(0, 160)} — side of the main roads not checked`); return null; });
  if (compsSource === "zillow") {
    // Zillow search has no notion of a subject property, so we own that record:
    // coordinates from a free geocode, facts from the listing above.
    const geo = resolved;
    if (!geo) {
      throw Object.assign(new Error(`couldn't locate ${extraction.address} on the map`), { http: 404 });
    }
    // A centroid can sit a mile from the house, so the run continues — the
    // comps are still pulled, graded and priced, which is the expensive part
    // and the part a reviewer wants to see — but the gate below refuses to
    // publish an offer measured from a guess. See evaluateGates.
    geocode = geo;
    if (precisionRank(geo.precision) < PRECISION.street) {
      warnings.push(
        `${extraction.address} only resolved to its ${geo.precision === "zip" ? "ZIP code" : "city"} — ` +
        `comps are centred on ${geo.matched || "an approximate point"}`
      );
    }
    subject = {
      lat: geo.lat, lng: geo.lng,
      beds: facts?.beds ?? null, baths: facts?.baths ?? null,
      sqft: facts?.sqft ?? null, yearBuilt: facts?.yearBuilt ?? null,
      lotSqft: facts?.lotSqft ?? null,
      homeType: facts?.homeType ?? null,
      units: facts?.units ?? null,
      stories: null, subdivision: null, material: null,
    };
    got.subject = subject;
    // The main roads around the house (same-side check), fetched under the
    // comps pull — free, cached a day, and a map that won't load is a line on
    // the note: the comps then carry no side and rank as before.
    barriersPromise = startBarriers(geo, UW_RADIUS_LADDER[UW_RADIUS_LADDER.length - 1]);
    // The facts a search row doesn't carry — year built, lot, and for a
    // multifamily the unit count — bought for the most similar comps in the
    // ring with one batched detail lookup (fetchZillowFacts), cached across
    // rings so a widened search only pays for new rows. A triplex is still
    // comped against triplexes: its units come off the same rows.
    const factsCache = new Map();
    const enrichLimit = Number.isFinite(deps?.enrichCandidates) ? deps.enrichCandidates : UW_ENRICH_CANDIDATES;
    const enrichRing = async (data, radiusMiles) => {
      const comps = data.comps || [];
      const multi = subject.homeType === "MULTI_FAMILY" && subject.units > 0;
      const limit = multi ? MAX_FACT_LOOKUPS : enrichLimit;
      if (limit > 0 && comps.length) {
        const sided = barriers ? markSides({ subject, comps, context: barriers }) : comps;
        const ranked = multi ? comps : [...sided]
          .map((c) => ({ c, s: similarity(subject, { ...c, distance: c.distance ?? milesBetween(data.subject || {}, c) }, { radiusMiles }).score ?? -1 }))
          .sort((a, b) => b.s - a.s).map((x) => x.c);
        const need = ranked.slice(0, limit).filter((c) => !factsCache.has(streetKey(c.address)));
        if (need.length) {
          try {
            const found = await fetchZillowFacts(need.map((c) => c.address), apifyToken);
            for (const c of need) factsCache.set(streetKey(c.address), found.get(streetKey(c.address)) ?? null);
          } catch (e) {
            if (!warnings.some((w) => w.startsWith("comp facts"))) warnings.push(`comp facts (year built, lot): ${e.message}`);
          }
        }
      }
      const enriched = mergeFacts(comps, factsCache);
      if (!multi) return { ...data, comps: enriched };
      const f = filterByUnits(enriched, subject.units);
      return { ...data, comps: f.comps, units: { subject: subject.units, matched: f.matched, dropped: f.dropped, unknown: f.unknown, keptUnknown: f.keptUnknown } };
    };
    const pullAt = async (radiusMiles) => enrichRing(await pullZillowComps({
      apifyToken,
      lat: geo.lat, lng: geo.lng,
      beds: subject.beds || 0, baths: subject.baths || 0, sqft: subject.sqft || 0,
      radiusMiles,
      // The widest ring is where thin markets (luxury, rural, manufactured)
      // end up; two years of sales there beats a hold.
      monthsBack: radiusMiles >= UW_RADIUS_LADDER[UW_RADIUS_LADDER.length - 1] ? UW_LAST_RING_MONTHS : 12,
      // Pool bands, not ARV bands. Everything that survives is still ranked by
      // the match scorecard, so the closest matches float to the top on their
      // own — this only decides what gets to be ranked at all.
      bedTolerance: UW_POOL_BEDS_TOLERANCE,
      bathTolerance: UW_POOL_BATHS_TOLERANCE,
      sqftPct: UW_POOL_SQFT_PCT,
      // Comp like for like: a condo is valued against condos. Null when the
      // listing didn't say, which falls back to excluding the types that are
      // wrong for a house.
      homeType: subject.homeType,
      subject,
    }), radiusMiles);
    // Half a mile first; wider only when that ring can't carry an ARV. "Usable"
    // is what the condition step will actually have to work with: comps the
    // price proxy calls renovated, or — for AI grading, which is priced per
    // comp and so runs once, on the final ring — comps inside the ring at all.
    const lastRing = UW_RADIUS_LADDER[UW_RADIUS_LADDER.length - 1];
    for (const radius of UW_RADIUS_LADDER) {
      if (canceled(job)) return;
      compsRadiusMiles = radius;
      // The pull starts first and the map is awaited under it. The no-op catch
      // only stops a failed pull from counting as unhandled while the map is
      // still loading; `await pulled` below still throws it to the run.
      const pulled = pullAt(radius);
      pulled.catch(() => {});
      barriers = await barriersPromise;
      compsData = await pulled;
      // A full proxy stops the ladder; a gut check doesn't — it's what the
      // last ring settles for, not a reason to skip looking wider. Inside a
      // ring the era band gives way first (same-side houses outside it come
      // in, scored down for age): location before age, 2026-10-06.
      const usableAt = (giveWay) => {
        const ring = nearbyComps({
          compsData, subjectFacts: { ...subject, distance: undefined, saleDate: undefined },
          subjectAddress: extraction.address, radiusMiles: radius, barriers, eraGivesWay: giveWay,
        });
        const graded = compsCondition === "price" ? gradeByPriceProxy(ring, { subjectSqft: subject.sqft }) : null;
        return { ring, graded, usable: graded ? (graded.proxy.gutCheck ? 0 : graded.rehabbed.length) : ring.length };
      };
      let at = usableAt(false);
      eraGivesWay = false;
      if (at.usable < UW_MIN_REHABBED_COMPS && subject.yearBuilt) {
        const relaxed = usableAt(true);
        // A ring the era band emptied takes the same-side houses even when
        // they only make a gut check — a rough number off the sales next door
        // beats a hold (3037 Massey Rd, Everson, 2026-10-08: four 3/2s nearby,
        // all thrown out for being newer, and the agent heard "comps are thin").
        const gutOnly = (x) => Boolean(x.graded?.proxy?.gutCheck);
        const rescues = relaxed.usable >= UW_MIN_REHABBED_COMPS ||
          (at.usable === 0 && !gutOnly(at) && gutOnly(relaxed));
        if (relaxed.ring.length > at.ring.length && rescues) {
          warnings.push(`only ${at.ring.length} comp${at.ring.length === 1 ? "" : "s"} within ${radius} mi built inside ±${UW_POOL_YEAR_TOLERANCE} years — kept the search close and let in same-side houses outside that band`);
          at = relaxed;
          eraGivesWay = true;
        }
      }
      if (at.usable >= UW_MIN_REHABBED_COMPS || radius === lastRing) break;
      const found = at.graded ? at.graded.proxy.pool : at.ring.length;
      warnings.push(`only ${found} close match${found === 1 ? "" : "es"} within ${radius} mi — widened the search`);
    }
    if (compsData?.units) {
      const u = compsData.units;
      warnings.push(`comped as a ${u.subject}-unit: ${u.matched} confirmed match${u.matched === 1 ? "" : "es"}` +
        (u.dropped ? `, ${u.dropped} with a different unit count dropped` : "") +
        (u.keptUnknown && u.unknown ? `, ${u.unknown} unconfirmed kept (too few confirmed)` : ""));
    }
  } else {
    // widen:false is the point. The ladder in comps-pull.js is right for a
    // human who is told it fired; unattended, silently reaching five miles out
    // for comps would produce an ARV nobody agreed to.
    compsData = await pullComps({
      apiKey: compsApiKey,
      address: extraction.address,
      months: 12,
      widen: false,
    });
    // County records beat a scraped listing for the subject's own facts.
    subject = { ...(compsData.subject || {}) };
    if (subject.lat != null) barriers = await startBarriers(subject, UW_RADIUS_LADDER[UW_RADIUS_LADDER.length - 1]);
    for (const k of ["beds", "baths", "sqft", "yearBuilt", "homeType"]) {
      if (subject[k] == null && facts?.[k] != null) subject[k] = facts[k];
    }
  }
  // The side goes on the pulled comps themselves too, so the board the editor
  // opens on says "across Trosper Rd SW" where the run saw it — and says the
  // map didn't load when it didn't.
  if (compsData) {
    const sideFrom = compsData.subject?.lat != null ? compsData.subject : subject;
    compsData = { ...compsData,
      comps: markSides({ subject: sideFrom, comps: compsData.comps || [], context: barriers }),
      sides: barriers ? { status: "ok" } : { status: "unavailable" } };
  }
  const subjectFacts = { ...subject, distance: undefined, saleDate: undefined };
  const nearby = nearbyComps({ compsData, subjectFacts, subjectAddress: extraction.address, radiusMiles: compsRadiusMiles, barriers, eraGivesWay });
  job.compsRadiusMiles = compsRadiusMiles;
  Object.assign(got, { subject, compsData, nearby });

  // No size on the listing: a rough number takes the comps' middle size
  // (roughNumber, below) rather than holding. The search already ran with no
  // size band; this only gives the ARV and the repair budget a size to work
  // to, and the offer says where it came from.
  const roughOn = !job.fill && roughNumbersOn(saved);
  let sqftSource = Number(subject?.sqft) > 0 ? "listing" : null;
  let sqftFilled = 0;
  if (roughOn && subject && subject.lat != null && !(Number(subject.sqft) > 0)) {
    sqftFilled = medianSqft(nearby.length ? nearby : compsData?.comps || []);
    if (sqftFilled > 0) {
      subject.sqft = sqftFilled;
      sqftSource = "comps";
      warnings.push(`square footage unknown — used the comps' middle size, ${sqftFilled.toLocaleString("en-US")} sqft, for a rough number`);
    }
  }

  // The buyer-view checks' two lookups start here and run under the grading
  // and the photo scan: the street (OpenStreetMap, free, ~2 s) and today's
  // listings (one more Zillow pull, ~$0.15). Either one failing is a line on
  // the note, never a hold — the run prices without it.
  const checks = checksFor(saved, { force: job.forceChecks });
  const point = facts?.point || (subject?.lat != null ? { lat: subject.lat, lng: subject.lng } : null);
  const sitePromise = checks?.site.enabled && point
    ? (deps?.checkSite || checkSite)({
        subject: { ...point, address: extraction.address, precision: facts?.point ? "address" : (geocode?.precision || "address") },
        // Most similar first: the ARV comps come from the top handful, and the
        // street check measures only the first dozen (one small box).
        comps: [...nearby].sort((a, b) => (b.similarity?.score ?? -1) - (a.similarity?.score ?? -1))
          .map((c) => ({ id: c.id, lat: c.lat, lng: c.lng, address: c.address })),
        t: checks.site,
      }).catch((e) => ({ status: "unavailable", subject: { flags: {}, nearest: null }, comps: {}, error: String(e?.message || e) }))
    : Promise.resolve(null);
  const activesPromise = checks?.actives.enabled && compsSource === "zillow" && point
    ? (deps?.pullActives || pullZillowActives)({
        apifyToken, lat: point.lat, lng: point.lng, radiusMiles: checks.actives.radiusMiles,
        beds: Number(subject.beds) || 0, baths: Number(subject.baths) || 0, sqft: Number(subject.sqft) || 0,
        homeType: subject.homeType || null, includePending: checks.actives.includePending,
      }).then((r) => r?.listings || []).catch((e) => { warnings.push(`listings: ${String(e?.message || e).slice(0, 160)}`); return null; })
    : Promise.resolve(undefined);

  /* --- 4. condition --- */
  job.phase = "grading";
  job.conditionSource = compsCondition;
  if (canceled(job)) return;

  let grades = {};
  let rehabbed = [];
  let proxy = null;
  if (compsCondition === "price") {
    // Two questions, two pools — this is the part worth understanding.
    //
    //   "Where is the top of the local $/sqft distribution?" needs BREADTH.
    //   Ranking is scale-free once you divide by floor area, so a 4-bed two
    //   doors down tells you plenty about what a renovated house fetches here.
    //
    //   "Which comps carry the ARV?" needs TIGHTNESS — the closest matches to
    //   this specific house.
    //
    // Running both off one tight set was the bug: tight enough to defend an
    // ARV is too tight to have a distribution, and the proxy just refused. So
    // the wide pool establishes the renovated tier, and the ARV then takes the
    // best-MATCHING comps from inside that tier — compareByMatch already
    // scores beds, baths, size, era and distance, so the tightening is done by
    // the scorecard rather than by another set of hand-tuned bands.
    let sides;
    ({ grades, rehabbed, proxy, sides } = gradeByPriceProxy(nearby, { subjectSqft: subject.sqft }));
    if (sides?.acrossUsed) {
      warnings.push(`only ${sides.sameSide} comp${sides.sameSide === 1 ? "" : "s"} on this side of the main roads — ${sides.acrossUsed} from across ${sides.acrossUsed === 1 ? "one" : "them"} judged too`);
    }
  } else {
    const candidates = nearby.slice(0, UW_GRADE_CANDIDATES);
    if (candidates.length) {
      try {
        const out = await gradeComps({
          subjectAddress: extraction.address,
          comps: candidates.map((c) => ({
            id: c.id, address: c.address, price: c.price, sqft: c.sqft,
            beds: c.beds, baths: c.baths, saleDate: c.saleDate,
          })),
          aiApiKey,
          apifyToken,
        });
        grades = Object.fromEntries(
          Object.entries(out.grades || {}).map(([id, g]) => [id, { ...g, source: "ai" }])
        );
        for (const f of out.failed || []) warnings.push(`comp ${f.id}: ${f.reason}`);
      } catch (e) {
        throw anthropicErrorToHttp(e);
      }
    }
    rehabbed = candidates
      .filter((c) => ARV_CONDITIONS.has(grades[c.id]?.condition))
      .slice(0, UW_MAX_ARV_COMPS);
  }

  job.compsUsed = rehabbed.map((c) => ({
    address: c.address, price: c.price, sqft: c.sqft, distance: c.distance,
    saleDate: c.saleDate, condition: grades[c.id]?.condition || null,
    similarity: c.similarity?.score ?? null, yearBuilt: c.yearBuilt ?? null,
  }));
  Object.assign(got, { grades, rehabbed });
  // The read-out that tunes the dials: how similar the evidence was, and how
  // much of the ring got its facts. Informational — never a hold.
  if (rehabbed.length) {
    const sims = rehabbed.map((c) => c.similarity?.score).filter((v) => v != null);
    const withYear = nearby.filter((c) => c.yearBuilt).length;
    const across = nearby.filter(isAcross).length;
    warnings.push(`comps: ${nearby.length} in the ring, ${withYear} with a year built` +
      (barriers ? `, ${across} across a main road` : "") +
      (sims.length ? `, ARV set match ${Math.round(sims.reduce((t, v) => t + v, 0) / sims.length)}` : ""));
  }

  /* --- 5. ARV --- */
  job.phase = "arv";
  if (canceled(job)) return;

  const subjectSqft = Number(subject.sqft) || 0;
  // The time trend comes off the WHOLE ring — the four ARV comps are too few
  // to say which way the market moved — and each sale is brought to today
  // before the median. The comps carry their similarity, so the median leans
  // on the closest matches.
  const arvComps = rehabbed.map((c) => ({ ...c, condition: grades[c.id]?.condition }));
  const ringTrend = timeTrend(nearby);
  let arv = rehabbed.length
    ? deriveArv({
        comps: arvComps,
        subjectSqft,
        subjectYearBuilt: Number(subject.yearBuilt) || 0,
        adjustments: [],
        trend: ringTrend,
      })
    : null;
  // A widened search is said out loud wherever the ARV's basis is shown —
  // the note, the offer, the editor — so nobody reads a one-mile ARV as a
  // half-mile one. A function, because the buyer-view checks derive the ARV
  // again and the prefixes must survive that.
  const acrossInArv = rehabbed.filter(isAcross);
  const withPrefixes = (a) => {
    if (a && compsRadiusMiles > UW_RADIUS_MILES) a.basis = `${a.basis} — comps widened to ${compsRadiusMiles} mi`;
    if (a && acrossInArv.length) a.basis = `${a.basis} — ${acrossInArv.length} ${acrossLabel(acrossInArv[0])}${acrossInArv.length > 1 ? " or another main road" : ""}`;
    if (a && proxy?.gutCheck) a.basis = `gut check on ${rehabbed.length} comps — ${a.basis}`;
    return a;
  };
  withPrefixes(arv);
  job.arv = arv?.arv ?? null;
  job.arvBasis = arv?.basis || "";
  got.arv = arv;

  /* --- what the agent told us (read before the scope, so it can be skipped) --- */
  // Their value and repairs (for the rescue below), and whether they described
  // the work (for the photo gate).
  const contactEvents = job.contactId && typeof store?.listContactEvents === "function"
    ? await store.listContactEvents(locationId, job.contactId, { limit: 200 }).catch(() => [])
    : [];
  const dossier = propertyDossier(contactEvents || [], extraction.address);
  const theirArv = Math.round(Number(dossier?.have?.arv?.value) || 0);
  const theirRehab = Math.round(Number(dossier?.have?.rehab?.value) || 0);
  // Same street-level match as the dossier: the thread's spelling of the
  // address rarely carries the ZIP the listing record does.
  const describedWork = (contactEvents || []).some((e) => e?.type === "property_details" && e.address
    && (addressKey(e.address) === addressKey(extraction.address) || sameHouse(e.address, extraction.address)));

  /* --- 6. rehab --- */
  job.phase = "rehab";
  if (canceled(job)) return;

  const beds = Number(subject.beds) || 0;
  const baths = Number(subject.baths) || 0;
  const sqft = subjectSqft;
  const yearBuilt = Number(subject.yearBuilt) || 0;

  let scan = null;
  let rehabState = seedRoomCounts(undefined, { beds, baths });
  let repairs = 0;
  let scope = [];
  got.rehabState = rehabState;
  if (photos.length && shouldScanPhotos({ arv: arv?.arv || 0, theirArv, theirRehab, describedWork, fill: job.fill })) {
    try {
      scan = await (deps?.scanPhotos || scanRehabFromPhotos)({
        photos, listing,
        subject: { beds: beds || null, baths: baths || null, sqft: sqft || null, yearBuilt: yearBuilt || null },
        aiApiKey,
      });
      rehabState = applyScanSuggestion(rehabState, scan, { photosAnalyzed: photos.length });
      const priced = priceScope(rehabState, sqft);
      scope = priced.lines;
      repairs = priced.total;
      Object.assign(got, { rehabState, scope, repairs });
    } catch (e) {
      throw anthropicErrorToHttp(e);
    }
  }

  /* --- the buyer's view (shared/underwrite-checks.js) --- */
  // The same house a buyer will price: its street, its size on the record,
  // what the comps have that it doesn't, what similar houses list for today,
  // and the scope a buyer would budget. Off unless switched on (or forced by
  // a backtest). Nothing here holds a run: a lookup that failed is a line on
  // the note, and the scope never goes past the heavy band.
  let checksSummary = null;
  let checksContext = null;
  if (checks) {
    const [site, actives] = await Promise.all([sitePromise, activesPromise]);
    if (site?.status === "unavailable") warnings.push(`street not checked${site.error ? ` (${String(site.error).slice(0, 80)})` : ""}`);
    const declined = job.declined || await declinedFromDraft(store, job.replaceOfferId);
    const view = buyerView({
      checks, address: extraction.address,
      subject: { sqft: subject.sqft, beds: subject.beds, baths: subject.baths, yearBuilt: subject.yearBuilt, lotSqft: subject.lotSqft },
      house: facts?.house || null, remarks: listing?.remarks || "",
      comps: arvComps, sqft: subjectSqft, trend: ringTrend,
      site, actives, areas: scan ? rehabState.aiResult?.areas || [] : [], contents: scan ? rehabState.aiResult?.contents || "none" : "none",
      rehabState: scan ? rehabState : null, declined,
    });
    if (view) {
      job.checksBefore = { arv: arv?.arv ?? null, repairs };
      if (view.arv) {
        arv = withPrefixes(view.arv);
        job.arv = arv.arv;
        job.arvBasis = arv.basis || "";
        got.arv = arv;
      }
      if (view.rehab?.rows?.length) {
        rehabState = withAllowance(rehabState, view.rehab.rows);
        const priced = priceScope(rehabState, sqft);
        scope = priced.lines;
        repairs = priced.total;
        Object.assign(got, { rehabState, scope, repairs });
      }
      checksSummary = view.summary;
      job.checks = view.summary;
      got.checks = view.summary;
    }
    // What the editor needs to rebuild the same lines when a person opens
    // this run: the street report, today's listings, the listing's words and
    // what was removed before.
    checksContext = {
      site: site || null, actives: Array.isArray(actives) ? actives : undefined,
      listing: listing ? { remarks: listing.remarks || "", status: listing.status || null } : null,
      declined: view?.summary?.declined || null,
    };
  }

  /* --- the gates --- */
  const gate = evaluateGates({
    extraction, subject, rehabbedComps: rehabbed, arv, describedWork,
    photosAnalyzed: scan ? photos.length : 0, scan, repairs, proxy, geocode, compsRadiusMiles,
    compsPool: { rows: compsData?.rows ?? null, pulled: compsData?.pulled ?? null, kept: nearby.length, radiusMiles: compsRadiusMiles },
  });

  const partial = {
    compsData, subject, subjectSqft: sqft, nearby, grades, rehabbed,
    arv, rehabState, scope, repairs, listing, photosCount, checks: checksSummary, checksContext,
  };

  if (job.fill) {
    job.snapshot = buildSnapshot({
      extraction, partial,
      contact: { id: job.contactId, name: job.contactName || "", phone: "", email: "" },
    });
    job.held = gate.ok ? [] : gate.held;
    job.status = "done";
    job.phase = "";
    job.repairs = repairs;
    job.finishedAt = new Date().toISOString();
    await setTag(client, job.contactId, UW_TAGS.done, warnings);
    await note(client, job.contactId,
      `Auto-underwrite from the offer form for ${extraction.address}: ARV ${fmtMoney(arv?.arv || 0)}` +
      (job.arvBasis ? ` (${job.arvBasis})` : "") + `, repairs ${fmtMoney(repairs)} from ${job.photosAnalyzed} listing photos.` +
      (gate.ok ? "" : ` Flagged: ${gate.held.join("; ")}.`),
      warnings);
    return;
  }

  // Our numbers are stuck, but the agent gave us theirs: price on them,
  // bounded, and say so everywhere the number shows (agentNumbersRescue).
  let arvForOffer = arv?.arv || 0;
  // The cap for their value is any list price we know — the listing's, the
  // one the sweep or the workflow handed over, or the one in the message.
  // With only `job.listPrice` a rescue on a house with no live listing (Helen
  // Hendricks' park home, 2026-09-15) had nothing to bound against and never ran.
  const rescueCap = job.listPrice || job.suppliedAskingPrice || (Number(extraction.askingPrice) || 0);
  const rescued = gate.ok ? null : agentNumbersRescue({
    held: gate.held, theirArv, theirRehab, ourArv: arvForOffer, repairs, listPrice: rescueCap, sqft,
    ceiling: checksSummary?.cap?.status === "ok" ? checksSummary.cap.amount : 0,
    cutPct: (checksSummary?.arv?.adjustments || []).filter((a) => a.pct < 0).reduce((t, a) => t + a.pct, 0),
    repairFloor: checksSummary?.rehab?.after || 0,
  });
  if (rescued) {
    arvForOffer = rescued.value;
    repairs = rescued.fix;
    job.arvBasis = rescued.basis;
    // A held reason on the job is what makes the conversation float this as a
    // rough number off their figures rather than lead with it confidently.
    job.agentNumbers = true;
    warnings.push(rescued.basis);
  }
  // Still held, and nothing of theirs to price on: a rough first pass on
  // what we have, when every hold is one it may go past (roughNumber). A size
  // taken from the comps makes the number rough even when nothing else held.
  const sqftHeld = "the subject's square footage is unknown — comps can't be size-matched and the ARV can't be size-adjusted";
  const said = [dossier?.have?.condition?.value, dossier?.have?.workNeeded?.value, listing?.remarks].filter(Boolean).join(" ");
  let rough = null;
  if (roughOn && !rescued) {
    if (!gate.ok) rough = roughNumber({ held: gate.held, arv: arvForOffer, sqft, repairs, said, listPrice: rescueCap });
    else if (sqftFilled) rough = { fix: repairs, tier: null, repairsSource: "scan", reasons: [] };
    if (rough && sqftFilled) rough.reasons = [`${sqftHeld.split(" — ")[0]} — priced on the comps' middle size, ${sqftFilled.toLocaleString("en-US")} sqft`, ...rough.reasons];
    if (rough && !(rough.fix > 0)) rough = null;
  }
  if (rough) {
    repairs = rough.fix;
    job.arvBasis = `rough first pass — ${String(rough.reasons[0] || "").split(" — ")[0]}${job.arvBasis ? ` — ${job.arvBasis}` : ""}`;
    job.rough = true;
    warnings.push(`rough number: ${rough.reasons.map((r) => String(r).split(" — ")[0]).join("; ")}` +
      (rough.repairsSource === "tier" ? ` — repairs budgeted at the top of the ${rough.tier} band, ${fmtMoney(rough.fix)}` : ""));
  }
  // Held after all: a size the comps lent is not a size we know — say so.
  const heldReasons = sqftFilled && !gate.ok ? [sqftHeld, ...gate.held] : gate.held;
  // Manufactured homes and luxury listings are priced, but aren't the core.
  const nonCore = String(subject?.homeType || "").toUpperCase() === "MANUFACTURED" || (job.listPrice || 0) >= UW_NON_CORE_LIST;
  const cleared = (gate.ok && !sqftFilled) || Boolean(rescued) || Boolean(rough);

  if (!cleared || job.dryRun || !AUTO_UNDERWRITE_ENABLED) {
    const held = cleared
      ? [AUTO_UNDERWRITE_ENABLED ? "dry run — nothing was published" : "AUTO_UNDERWRITE_ENABLED is not set on the broker"]
      : heldReasons;
    return finishHeld(job, ctx, { extraction, held, partial, cleared });
  }

  /* --- 6. create --- */
  job.phase = "creating";
  if (canceled(job)) return;
  if (typeof deps?.createOffer !== "function") {
    throw new Error("auto-underwrite was wired without a createOffer dependency");
  }

  // Never above a share of the list price. The list price is the Zillow
  // listing's, else an asking price the agent's text named (a number the
  // workflow or a counter supplied is the seller's floor, not a list price).
  const listForCap = job.listPrice || (extraction.source === "conversation" ? Number(extraction.askingPrice) || 0 : 0);
  const pctOfList = Number(saved?.maxOfferPctOfList) > 0 ? Number(saved.maxOfferPctOfList) : UW_MAX_PCT_OF_LIST;
  let listCap = { capped: false, amount: 0, cap: 0 };
  if (listForCap > 0) {
    try {
      const expected = calculateOffers(
        { address: extraction.address, arv: arvForOffer, repairs, askingPrice: listForCap, priceOverride: 0 },
        { ...(saved || {}), underwriteMode: UW_MODE },
      ).offers.cash.amount;
      listCap = capToList({ cash: expected, listPrice: listForCap, pct: pctOfList });
      if (listCap.capped) {
        warnings.push(`our number (${fmtMoney(expected)}) was over ${pctOfList}% of the ${fmtMoney(listForCap)} list price — capped at ${fmtMoney(listCap.cap)}`);
        job.listCapped = { listPrice: listForCap, pct: pctOfList, cap: listCap.cap, uncapped: Math.round(expected) };
      }
    } catch (e) {
      warnings.push(`list-price cap not checked: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  const result = await deps.createOffer({
    locationId,
    client,
    body: {
      contactId: job.contactId,
      inputs: {
        address: extraction.address,
        arv: arvForOffer,
        repairs,
        askingPrice: listForCap || extraction.askingPrice || 0,
        ...(listCap.capped ? { priceOverride: listCap.cap } : {}),
      },
      settings: { ...(saved || {}), underwriteMode: UW_MODE },
      scope,
      snapshot: buildSnapshot({
        extraction,
        partial,
        contact: { id: job.contactId, name: job.contactName || "", phone: "", email: "" },
      }),
    },
  });

  const offer = result.offer;
  offer.autoUnderwrite = {
    ...auditTrail(job, extraction, rescued || rough ? { ok: false } : gate),
    ...(rescued ? { basis: "agent_numbers", rescuedFrom: gate.held.slice(0, 4) } : {}),
    // A rough first pass: priced, floated as a range that says so, never paper
    // on its own (shared/paper-follows.js), re-run on their numbers.
    ...(rough ? { basis: "rough", rough: rough.reasons.slice(0, 6), numberConfidence: "low",
      ...(sqftSource ? { sqftSource } : {}), repairsSource: rough.repairsSource, ...(rough.tier ? { repairsTier: rough.tier } : {}) } : {}),
    ...(nonCore ? { nonCore: true } : {}),
  };
  // Off-market (shared/off-market.js): the agent said so, or Zillow shows it
  // coming soon or not listed. Our best deals — marked the moment they land.
  // A mark you set by hand is never overwritten.
  // How the house came to us (shared/lead-source.js): the listing we opened
  // with, or one the agent brought — what the Desk's call row keys on.
  const hooks = job.contactId && typeof store?.listOutreachHooks === "function"
    ? await store.listOutreachHooks(locationId, { contactId: job.contactId }).catch(() => [])
    : [];
  const lead = job.contactId ? leadSourceOf({ offer: { contactId: job.contactId, address: offer.address || extraction.address, createdAt: new Date().toISOString() }, hooks, events: contactEvents || [] }) : null;
  if (lead) offer.autoUnderwrite.leadSource = lead.source;
  // A house the agent brought: does the seller's own number leave our fee
  // under what a flipper pays? A flag for the Desk's call, never a send.
  if (lead?.source === "agent_brought") {
    const ceiling = buyerCeiling({ offer: { ...offer, arv: offer.calc?.inputs?.arv, repairs: offer.calc?.inputs?.repairs }, settings: saved || {}, fee: 0 });
    const check = ceiling.computable ? theirNumberCheck({ seller: extraction.askingPrice || job.askingPrice, ceiling: ceiling.noFee }) : null;
    if (check) offer.autoUnderwrite.theirNumber = check;
  }
  const offSignal = job.offMarketCue || offMarketSignals({ listing: got.listing, agentBrought: lead?.source === "agent_brought" });
  if (offSignal && offer.offMarket?.by !== "you") offer.offMarket = { ...offSignal, by: "machine", at: new Date().toISOString() };
  await store.updateOffer(offer.id, offer).catch(() => {});
  if (rescued) job.held = [rescued.basis];
  // A held reason on the job is what makes the conversation float it as rough.
  if (rough) job.held = [job.arvBasis];

  job.status = "done";
  job.phase = "";
  job.offerId = offer.id;
  job.offerUrl = offer.pdfUrl || null;
  job.cashAmount = offer.cashAmount ?? null;
  job.repairs = repairs;
  job.finishedAt = new Date().toISOString();
  warnings.push(...(result.warnings || []));
  // The retry landed a real offer; the draft the failed attempt left is now
  // a stale copy of the same house sitting beside it in History.
  if (job.replaceOfferId && job.replaceOfferId !== offer.id) {
    try {
      const prior = await store.getOffer?.(job.replaceOfferId);
      if (prior?.status === "draft" && prior.locationId === locationId) await store.deleteOffer(prior.id || job.replaceOfferId);
    } catch (e) {
      warnings.push(`old draft not removed: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  await setTag(client, job.contactId, UW_TAGS.done, warnings);
  await note(client, job.contactId, doneNote(job, rescued ? { ...(arv || {}), arv: arvForOffer } : arv, repairs), warnings);

  // Numbers are back: the Conversation AI may float them to the agent as a
  // soft number before the formal offer goes. Wired by the route; a failure
  // here is a warning on the run, never a failed underwrite.
  if (typeof deps?.onOfferCreated === "function") {
    try { await deps.onOfferCreated({ offer, job }); }
    catch (e) { warnings.push(`realm check: ${String(e?.message || e).slice(0, 120)}`); }
  }
}

// Every full address the contact record already ties to this agent: the
// listing hook at import, the outreach text, subject-property writes, their
// own property details. Any of these on the same street line as a shorthand
// address IS that address.
async function knownAddressesFor({ store, locationId, contactId }) {
  if (!contactId || typeof store?.listContactEvents !== "function") return [];
  try {
    const events = await store.listContactEvents(locationId, contactId, { limit: 300 });
    return [...new Set(events.map((e) => String(e?.address || "").trim()).filter((a) => a && /,/.test(a)))];
  } catch { return []; }
}

// "agent-outreach-autopilot-king-wa" / "agent-outreach-pierce-county-wa-aug-18" → "King" / "Pierce".
export function countyFromTags(tags = []) {
  for (const t of tags || []) {
    const m = String(t).toLowerCase().match(/^agent-outreach-(?:autopilot-)?([a-z]+)(?:-county)?-wa\b/);
    if (m) return m[1][0].toUpperCase() + m[1].slice(1);
  }
  return "";
}

/**
 * restartVanishedUnderwrites({ store, locationId, start, now }) → { checked, restarted, rows }
 *
 * A run lives in memory. A redeploy in the middle of one — Boots Swan's
 * 3925 SW 317th, 2026-09-16 12:56 PT, three deploys between 12:55 and
 * 12:58 — kills it with no terminal note, no draft, no tag change: the
 * agent's text just vanishes. The reply draft still says "underwrite
 * started", so this tick-time check reads those (last 12h, older than 20
 * minutes), and where nothing exists for that agent on that street — no
 * offer, no held draft, no job in memory — starts it again, once
 * (claimed as uw_restart:{draftId} on the timeline).
 */
export const VANISHED_MIN_AGE_MS = 20 * 60 * 1000;
export const VANISHED_MAX_AGE_MS = 12 * 3600 * 1000;
export async function restartVanishedUnderwrites({ store, locationId, start, now = Date.now() }) {
  const out = { checked: 0, restarted: 0, rows: [] };
  if (typeof start !== "function" || typeof store?.listReplyDrafts !== "function") return out;
  const since = new Date(now - VANISHED_MAX_AGE_MS).toISOString();
  const drafts = await store.listReplyDrafts(locationId, { since, limit: 500 }).catch(() => []);
  const started = drafts.filter((d) => d?.contactId && d.propertyAddress
    && (d.actions || []).some((a) => a?.type === "start_underwrite" && a.status === "done")
    && now - (Date.parse(d.createdAt || "") || now) >= VANISHED_MIN_AGE_MS);
  if (!started.length) return out;
  const offers = await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []);
  const seen = new Set();
  for (const d of started) {
    const key = `${d.contactId}|${addressKey(String(d.propertyAddress).split(",")[0])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.checked++;
    const inMemory = [...jobs.values()].some((j) => j.locationId === locationId && j.contactId === d.contactId
      && (j.status === "queued" || j.status === "running" || (j.address && sameStreet(j.address, d.propertyAddress))));
    if (inMemory) continue;
    const anyRow = offers.some((o) => o?.contactId === d.contactId && o.address && sameStreet(o.address, d.propertyAddress));
    if (anyRow) continue;
    const claim = await recordEvent({
      store, locationId, contactId: d.contactId, party: "agent", type: "uw_restart", at: new Date(now).toISOString(),
      address: d.propertyAddress, source: "sweep", dedupeKey: `uw_restart:${d.id}`, data: { draftId: d.id, why: "the run started and left nothing behind" },
    }).catch(() => ({ inserted: false }));
    if (!claim.inserted) continue;
    const row = { contactId: d.contactId, contactName: d.contactName || "", address: d.propertyAddress, draftId: d.id, status: "restarted", reason: "" };
    out.rows.push(row);
    try {
      const r = await start({ contactId: d.contactId, message: String(d.inbound || "").slice(0, 500), address: d.propertyAddress });
      if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; } else out.restarted++;
    } catch (e) { row.status = "error"; row.reason = String(e?.message || e).slice(0, 160); }
  }
  return out;
}

/* ---------- holding for review ---------- */

// A held run is not a failed one. Everything expensive has already been paid
// for — the comps, the grades, the photo scan — so it is saved as a DRAFT in
// exactly the shape the New Offer page restores from. Opening it lands the
// operator mid-form with the work done; the review is "tick two more comps",
// not "start over".
async function finishHeld(job, ctx, { extraction, held, partial, cleared = false }) {
  const { client } = ctx;
  const warnings = job.warnings;
  const saved = await saveDraft(job, ctx, { extraction, held, partial, cleared });

  job.status = "held";
  job.phase = "";
  job.held = held;
  job.offerId = saved.id;
  job.arv = partial.arv?.arv ?? null;
  job.repairs = partial.repairs ?? null;
  job.finishedAt = new Date().toISOString();

  if (job.contactId) {
    await setTag(client, job.contactId, UW_TAGS.review, warnings);
    await note(client, job.contactId, heldNote(job, held), warnings);
  }

  // Held, and an agent may be waiting on the number this run was for. The
  // route decides what to do about that (promise-driver.js: ask for their
  // numbers now rather than at the nightly sweep). A failure here is a
  // warning on the run, never a failed underwrite.
  if (typeof ctx.deps?.onHeld === "function") {
    try { await ctx.deps.onHeld({ offer: saved, job }); }
    catch (e) { warnings.push(`held hook: ${String(e?.message || e).slice(0, 120)}`); }
  }
}

// A run that THREW — a timeout, a provider refusal — keeps whatever the stages
// before it loaded. Same draft shape as a hold, so the form restores it the
// same way; the job itself stays "error" so the strip still reads as a failure.
// Returns whether a draft was written: with no address there is nothing to
// open, and a fill run's record is the form on the operator's screen.
export async function saveLoadedDraft(job, ctx) {
  const got = job._got || {};
  if (job.fill || !got.extraction?.address) return false;
  const subject = got.subject || null;
  const partial = {
    compsData: got.compsData || null,
    subject,
    subjectSqft: Number(subject?.sqft) || 0,
    nearby: got.nearby || [],
    grades: got.grades || {},
    rehabbed: got.rehabbed || [],
    arv: got.arv || null,
    rehabState: got.rehabState || null,
    scope: got.scope || [],
    repairs: got.repairs ?? 0,
    listing: got.listing || null,
    photosCount: got.photosCount || 0,
  };
  const saved = await saveDraft(job, ctx, {
    extraction: got.extraction, held: [`stopped early — ${job.error || "the run failed"}`], partial,
  });
  job.offerId = saved.id;
  job.arv = partial.arv?.arv ?? null;
  job.repairs = partial.repairs || null;
  return true;
}

// Writes the review draft. A retry OVERWRITES the draft its predecessor left
// (keeping that record's id and createdAt) rather than stacking a second copy
// of the same house in History — but only while it is still a draft: once a
// person has turned it into an offer, it is theirs, and this writes a new one.
async function saveDraft(job, ctx, { extraction, held, partial, cleared = false }) {
  const { locationId, store } = ctx;
  const draft = {
    ...buildSnapshot({
      extraction, partial,
      contact: { id: job.contactId, name: job.contactName || "", phone: "", email: "" },
    }),
    cashPreview: null,
  };
  const record = {
    locationId,
    status: "draft",
    contactId: job.contactId,
    contactName: job.contactName,
    address: extraction.address || "",
    cashAmount: null,
    draft,
    checks: summarizeChecks(draft),
    autoUnderwrite: { ...auditTrail(job, extraction, { ok: cleared, held }), held },
    updatedAt: new Date().toISOString(),
  };
  if (job.replaceOfferId) {
    const prior = await store.getOffer?.(job.replaceOfferId).catch(() => null);
    if (prior && prior.status === "draft" && prior.locationId === locationId) {
      const doc = { ...prior, ...record, id: prior.id || job.replaceOfferId, createdAt: prior.createdAt };
      await store.updateOffer(doc.id, doc);
      return doc;
    }
  }
  return store.createOffer(record);
}

/* ---------- shapes ---------- */

// The New Offer workspace, exactly as CompsPane and RehabPane report it
// upward. Getting this shape wrong doesn't error — it silently opens to an
// empty comps board and drops the comps out of the comps PDF, which is the
// one failure you'd only notice with an agent on the phone.
function buildSnapshot({ extraction, partial, contact = null }) {
  const { compsData, subject, subjectSqft, grades, rehabbed, arv, rehabState, scope, repairs, checks = null, checksContext = null } = partial;
  const cx = checksContext || {};
  const center = subject?.lat != null ? { lat: subject.lat, lng: subject.lng } : null;
  return {
    // What the buyer-view checks did to this house (shared/underwrite-checks.js),
    // and what a person removed — read back on a retry so a removal sticks.
    checks,
    mode: "existing",
    // The agent this was underwritten for. Without it the editor opens on an
    // empty Seller contact and cannot create the offer — the one step a review
    // exists to finish.
    contact,
    inputs: {
      address: extraction.address,
      arv: arv?.arv ?? 0,
      repairs: repairs ?? 0,
      askingPrice: extraction.askingPrice || 0,
    },
    subjectSqft: subjectSqft || "",
    subjectInfo: subject || null,
    scope: scope || [],
    underwriteMode: UW_MODE,
    rehab: rehabState ? {
      ...rehabState,
      ...(cx.listing ? { listing: cx.listing } : {}),
      ...(cx.declined ? { allowanceDeclined: cx.declined.rehab || [] } : {}),
    } : null,
    comps: {
      // CompsPane keeps the resolved map centre on `subject` and the provider's
      // property record on `info` — not the other way round.
      result: compsData ? { ...compsData, subject: center, info: subject || null, loadedFor: extraction.address } : null,
      selected: (rehabbed || []).map((c) => c.id),
      manual: [],
      captured: [],
      // Nothing is dismissed: the comps that didn't carry the ARV were ranked
      // below the ones that did, not rejected. They stay on the board so a
      // review can tick one without pulling again.
      dismissed: [],
      months: 12,
      beds: subject?.beds ?? "",
      baths: subject?.baths ?? "",
      grades: grades || {},
      // The auto adjustments the checks applied (street, garage, lot), as the
      // Comps pane's chips — source "auto", so the pane shows them as the
      // machine's and a person can take one off.
      adjustments: arv?.adjustments || [],
      arvBase: arv?.base ?? null,
      arvBasis: arv?.basis || "",
      // The buyer-view checks' lookups and removals, so the Comps pane
      // rebuilds the same lines without paying for them again.
      ...(cx.site ? { site: cx.site } : {}),
      ...(cx.actives !== undefined ? { activesList: cx.actives } : {}),
      ...(cx.declined ? { checksDeclined: { arv: cx.declined.arv || [], cap: Boolean(cx.declined.cap) } } : {}),
    },
  };
}

// Stamped onto whatever the run produced. This is what countToday and
// findRecent read, and what tells you six weeks later that a number came from
// a robot at 6am rather than from someone looking at the house.
//
// Scalars only, deliberately: it is carried on the LEAN offer row (see
// OFFER_LIST_FIELDS in shared/offer-status.js) so the spend guards can be
// answered without reading every offer document in full. The comps that
// carried the ARV are already in the snapshot — they don't need a third copy.
function auditTrail(job, extraction, gate) {
  return {
    jobId: job.id,
    startedAt: job.startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: job.dryRun,
    message: String(job.message || "").slice(0, 200),
    address: extraction.address,
    confidence: extraction.confidence,
    addressSource: extraction.source || "conversation",
    extractionNote: extraction.note,
    mode: UW_MODE,
    compsSource: job.compsSource,
    compsRadiusMiles: job.compsRadiusMiles ?? UW_RADIUS_MILES,
    conditionSource: job.conditionSource,
    compsUsedCount: job.compsUsed.length,
    photosAnalyzed: job.photosAnalyzed,
    arvBasis: job.arvBasis,
    passed: Boolean(gate?.ok),
  };
}

/* ---------- the notes a human reads ---------- */

function doneNote(job, arv, repairs) {
  const comps = job.compsUsed
    .map((c) => `  • ${c.address} — ${fmtMoney(c.price)}${c.sqft ? `, ${c.sqft.toLocaleString()} sqft` : ""}, ${c.distance} mi, ${c.condition}`)
    .join("\n");
  return [
    `Auto-underwrite complete for ${job.address}.`,
    ``,
    `Cash offer: ${fmtMoney(job.cashAmount || 0)} (maximum-offer rule: % of ARV − repairs − fee)`,
    `ARV ${fmtMoney(arv?.arv || 0)} — ${job.arvBasis}`,
    `Repairs ${fmtMoney(repairs)} from ${job.photosAnalyzed} listing photos`,
    ...checksBlock(job),
    ``,
    `Comps used:`,
    comps || "  (none)",
    ``,
    job.offerUrl ? `Offer document: ${job.offerUrl}` : "",
    ``,
    `Nothing has been sent — review it in History and send when you're happy.`,
  ].filter((l) => l !== null).join("\n");
}

function heldNote(job, held) {
  // The warnings are the half of the story the gates can't tell. A gate says
  // "0 listing photos"; the warning beside it says "Zillow lookup failed
  // (Apify 402)", which is the difference between a house with no pictures and
  // an account out of credits. They were collected and then shown to nobody.
  const warnings = (job.warnings || []).slice(0, 6);
  return [
    `Auto-underwrite held for review — ${job.address || "no address found"}.`,
    ``,
    `Why:`,
    ...held.map((h) => `  • ${h}`),
    ...(warnings.length ? [``, `What went wrong along the way:`, ...warnings.map((w) => `  • ${w}`)] : []),
    ``,
    job.arv ? `ARV so far: ${fmtMoney(job.arv)} (${job.arvBasis})` : "",
    job.repairs ? `Scope so far: ${fmtMoney(job.repairs)} from ${job.photosAnalyzed} photos` : "",
    ...checksBlock(job),
    ``,
    `The work done so far is saved as a draft — open it in the app and it picks up where this stopped.`,
  ].filter(Boolean).join("\n");
}

// What the buyer-view checks did, as note lines. Empty when they didn't run.
function checksBlock(job) {
  const lines = checksLines(job.checks);
  if (!lines.length) return [];
  const before = job.checksBefore;
  const moved = before && (before.arv !== job.arv || before.repairs !== job.repairs)
    ? [`  (before the checks: ARV ${fmtMoney(before.arv || 0)}, repairs ${fmtMoney(before.repairs || 0)})`] : [];
  return ["", "Buyer-view checks:", ...lines.map((l) => `  • ${l}`), ...moved];
}
