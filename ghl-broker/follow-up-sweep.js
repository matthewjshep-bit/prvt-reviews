// follow-up-sweep.js — the clock. Once a day, per location: who did we speak
// to and never hear back from, and is today the day we say something.
//
// It sends nothing itself. Every nudge it decides on goes through
// startProactive, which means it inherits — rather than reimplements — the
// hands-off tags, the live-deal hold, the "a person is in this thread" check,
// the money guard, quiet hours, the per-contact daily cap, the send gate and
// the outbox. The sweep's only job is deciding WHO and WHICH RUNG.
//
// Two things about the concurrency, both load-bearing:
//
//   The claim is a row in contact_events with a unique dedupe key, written
//   BEFORE the draft is started. Two ticks racing, two processes, a redeploy
//   mid-sweep — the second write is a no-op and that candidate is skipped.
//   The failure mode this chooses is "a crash between claim and draft loses
//   one nudge". The other order costs a duplicate text, which is worse.
//
//   The cursor in job_cursors stops a SCAN, not a send. The nightly enrich
//   sweep keeps its equivalent in memory and can therefore re-run after a
//   redeploy; for enrichment that wastes money, and here it would text people.
//   The dedupe key is still the real defence — the cursor just stops us
//   spending model calls on drafts that would be superseded anyway.

import { OPEN_STATUSES, effectiveStatus, dealIsOver, dealOutreachPaused, outreachPausedReason, pushesToPaper, offerHeat } from "./shared/offer-status.js";
import { paperWent } from "./shared/paper-follows.js";
import { addressKey } from "./shared/us-address.js";
import { sameStreet } from "./shared/us-address.js";
import { supersededIds } from "./shared/current-offer.js";
import {
  dueStep, exhausted, followUpDedupeKey, FOLLOW_UP_KINDS, kindsFor, HOT_MIN_HOURS,
  offerNudgeStart, offerNudgeAnchor, passedStart, threadTimes, CHECKIN_STATUSES, rungsCovered, nudgeTimes,
} from "./shared/follow-up.js";
import { focusOf, focusHolds, machineTexts, spacingHolds, lightTouchDue, pickAside } from "./shared/agent-focus.js";
import { threadHealth } from "./shared/thread-health.js";
import { soundsLikeSecondThoughts } from "./shared/conversation-ai.js";
import { recordEvent } from "./contact-record.js";
import { conversationConfig, startProactive } from "./reply-agent.js";
import { waitingReason } from "./outbox-guard.js";
import { botEventsByContact } from "./bot-hold.js";
import { botHold, holdLine, paceOf, paceScale, MIN_PACE } from "./shared/bot-hold.js";
import { claimDailyRun, closeDailyRun } from "./daily-gate.js";

const DAY_MS = 86400000;
// GHL's burst cap is 100 req / 10s per location; the same pace the enrichment
// sweep keeps. Nothing here is in a hurry.
const PACE_MS = 150;
// How far back the investor scan reads. A blast older than this is not a
// follow-up any more, it is a new conversation.
export const INVESTOR_WINDOW_DAYS = 30;
export const CURSOR_NAME = "followUp";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const FOLLOW_UP_UTC_HOUR = Number(process.env.FOLLOW_UP_SWEEP_UTC_HOUR || 16); // ≈ 8–9am Pacific

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();
const parse = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/* ---------- the job registry ---------- */
// In memory, like the enrichment sweep: a restart loses the job list and
// corrupts nothing, because every durable decision is a contact_events row.

const jobs = new Map();   // locationId -> the current or most recent job

export const getFollowUpJob = (locationId) => jobs.get(locationId) || null;
export function cancelFollowUpSweep(locationId) {
  const job = jobs.get(locationId);
  if (!job || job.status !== "running") return false;
  job.cancelRequested = true;
  return true;
}
export function publicFollowUpJob(job) {
  if (!job) return null;
  const { cancelRequested, ...rest } = job;
  return { ...rest, stopping: Boolean(cancelRequested && job.status === "running") };
}
// For tests: the registry is process-wide.
export function _resetJobs() { jobs.clear(); }

/* ---------- finding candidates ---------- */

/**
 * agentCandidates({ store, locationId, config, now }) → [candidate]
 *
 * Open offers whose status hasn't moved since the earliest rung could have
 * come due. One indexed read (listOffersForFollowUp), then the full doc is
 * consulted per row — the status column narrows, it never decides.
 */
export async function agentCandidates({ store, locationId, config, now = Date.now() }) {
  const pb = config?.parties?.agent;
  const ladder = pb?.followUp?.ladders?.offer_nudge;
  if (!pb?.followUp?.enabled || !ladder?.enabled || !ladder.steps?.length) return [];
  const hotLadderOn = Boolean(pb.followUp.ladders?.hot_push?.enabled);
  const earliest = Math.min(...ladder.steps);
  // MIN_PACE: someone you asked to hear from more (shared/bot-hold.js) has
  // their first rung at half its day, so their offer is a candidate sooner.
  const rows = await followUpRows(store, locationId, { statuses: [...OPEN_STATUSES], before: iso(now - earliest * MIN_PACE * DAY_MS) });

  // One nudge per PROPERTY. The book holds duplicates — the same house
  // underwritten twice for one agent, or offered to a co-listing agent — and
  // each copy used to earn its own text. Every offer on the location is read
  // (not just the ones due), because the sibling that matters is usually the
  // newer one, sent too recently to be due itself.
  const everyOffer = typeof store.listOffers === "function"
    ? await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => null)
    : null;
  const byProperty = new Map();
  for (const o of everyOffer || rows) {
    const k = propertyKeyOf(o);
    if (!k) continue;
    if (!byProperty.has(k)) byProperty.set(k, []);
    byProperty.get(k).push(o);
  }

  // Only an agent's current offer on a house is asked about (shared/
  // current-offer.js) — an older row's number is one the house moved past.
  const replaced = supersededIds(everyOffer || rows);
  const out = [];
  for (const o of rows) {
    if (!o?.contactId || !o.address) continue;
    if (replaced.has(o.id)) continue;
    if (o.deal) continue;                                  // it became a deal; not our business
    if (!OPEN_STATUSES.has(effectiveStatus(o))) continue;  // the mirror was stale
    if (!isTheOfferToAskAbout(o, byProperty.get(propertyKeyOf(o)) || [])) continue;
    // A price is agreed: the hot push has it, and two ladders would be two
    // texts about one house. Hot on "presenting" alone stays here until a yes.
    if (hotLadderOn && pushesToPaper(o)) continue;
    // Its expiry date is not checked: the offer stands until they answer, and
    // asking about it is the follow-up, not a re-offer.
    // Nothing went out on it yet — no letter, no number floated — so there is
    // nothing to follow up: "we sent you an offer" would be false, and a
    // priced offer waiting to be floated is the float timer's. A number
    // floated by text is followed up from when it was floated.
    const onPaper = paperWent(o);
    const floatedAt = o.proactive?.realmCheckAt || o.proactive?.takeCheckAt || null;
    if (!onPaper && !floatedAt && effectiveStatus(o) === "new") continue;
    // Count from the last time we actually put it in front of them.
    const startedAt = onPaper ? offerNudgeStart(o) : (floatedAt || offerNudgeStart(o));
    if (!startedAt) continue;
    out.push({
      kind: "offer_nudge", party: "agent", contactId: o.contactId, subjectId: o.id,
      offerId: o.id, address: o.address, startedAt,
      sentSteps: (o.followUps || []).filter((f) => f?.kind === "offer_nudge").map((f) => f.step),
      ladder,
    });
  }
  return out;
}

const propertyKeyOf = (o) => (o?.address ? addressKey(o.address) : "");

// Every offer in these statuses, a page at a time. The reads used to stop at
// the oldest 200 (400 for check-ins) with superseded rows counting against
// them, so as the book grew the NEWEST offers — a fresh yes among them — were
// the ones never asked about.
export const FOLLOW_UP_PAGE = 500;
// The most texts one run starts. A constant, like the reply reserve.
export const MAX_STARTS_PER_RUN = 150;
export const FOLLOW_UP_MAX_ROWS = 5000;
export async function followUpRows(store, locationId, { statuses, before = null, since = null } = {}) {
  const seen = new Map();
  for (let offset = 0; offset < FOLLOW_UP_MAX_ROWS; offset += FOLLOW_UP_PAGE) {
    const page = await store.listOffersForFollowUp(locationId, { statuses, before, since, limit: FOLLOW_UP_PAGE, offset }).catch(() => []);
    for (const o of page || []) if (o?.id && !seen.has(o.id)) seen.set(o.id, o);
    if (!page || page.length < FOLLOW_UP_PAGE) break;
  }
  return [...seen.values()];
}

// The ids some newer row on the same house replaced, off the whole book. A
// book that can't be read replaces nothing — the sweep behaves as before.
async function replacedOffers(store, locationId) {
  if (typeof store.listOffers !== "function") return new Set();
  const all = await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => null);
  return all ? supersededIds(all) : new Set();
}

// When we last put this offer in front of anyone — the thing "newer" means.
const lastActivityOf = (o) => {
  const sent = (o?.sends || []).map((s) => s?.ts).filter(Boolean).sort().at(-1);
  return Date.parse(sent || o?.statusAt || o?.createdAt || "") || 0;
};

// In flight: priced, sent or countered, or a draft still being worked.
const IN_FLIGHT = new Set([...OPEN_STATUSES, "draft"]);

/**
 * isTheOfferToAskAbout(offer, siblings) → boolean
 *
 * `siblings` is every offer on the same property, this one included. A
 * property that became a deal on any offer is not followed up at all; past
 * that, only the most recently active in-flight offer is — an older copy
 * would ask about a number the newer offer already replaced.
 */
export function isTheOfferToAskAbout(offer, siblings = []) {
  const others = siblings.filter((s) => s && s.id !== offer.id);
  if (others.some((s) => s.deal)) return false;
  const mine = lastActivityOf(offer);
  return !others.some((s) => IN_FLIGHT.has(effectiveStatus(s)) &&
    (lastActivityOf(s) > mine || (lastActivityOf(s) === mine && String(s.id) > String(offer.id))));
}

/**
 * passedCandidates({ store, locationId, config, now }) → [candidate]
 *
 * Offers the agent passed on, counted from when they passed — and offers
 * that went quiet (no_response), counted from when they were marked so. Every
 * ten days by default: has anything changed, would the seller come closer to
 * our number? Expired offers still count — the number is the conversation,
 * and it's ours to restate. A deal, a withdrawal on our side, or a status
 * that moved on (they countered after all) ends it.
 *
 * no_response joined 2026-09-29: it is revivable (a counter brings it back)
 * but nothing ever asked, so every offer the timers marked quiet was done.
 */
export async function passedCandidates({ store, locationId, config, now = Date.now() }) {
  const pb = config?.parties?.agent;
  const ladder = pb?.followUp?.ladders?.passed_checkin;
  if (!pb?.followUp?.enabled || !ladder?.enabled || !ladder.steps?.length) return [];
  const earliest = Math.min(...ladder.steps);
  const rows = await followUpRows(store, locationId, { statuses: [...CHECKIN_STATUSES], before: iso(now - earliest * MIN_PACE * DAY_MS) });
  const replaced = await replacedOffers(store, locationId);
  // The price watch writes these when the listing goes pending or sells, and
  // when it comes back. A check-in asking whether the seller has softened is
  // pointless while it's off the market; a relisted house is the best moment
  // there is (2026-09-29: off-market used to be forever).
  const marketEvents = typeof store.listContactEventsSince === "function"
    ? await store.listContactEventsSince(locationId, iso(now - 200 * DAY_MS), { types: ["listing_off_market", "listing_back_on_market"], limit: 5000 }).catch(() => [])
    : [];
  const relistOn = Boolean(pb.followUp.relist);
  const out = [];
  for (const o of rows) {
    if (!o?.contactId || !o.address || o.deal) continue;
    if (replaced.has(o.id)) continue;       // a row the house moved past
    if (!CHECKIN_STATUSES.has(effectiveStatus(o))) continue;
    const passedAt = passedStart(o);
    if (!passedAt) continue;
    const key = propertyKeyOf(o);
    const mine = marketEvents.filter((e) => (e.offerId === o.id || (key && e.address && addressKey(e.address) === key)) && String(e.at) > String(passedAt));
    const lastOff = mine.filter((e) => e.type === "listing_off_market").map((e) => e.at).sort().at(-1) || null;
    const lastBack = mine.filter((e) => e.type === "listing_back_on_market").map((e) => e.at).sort().at(-1) || null;
    const gone = lastOff && !(lastBack && String(lastBack) > String(lastOff)) ? lastOff : null;
    // Back on the market, with the switch on: the check-ins start again from
    // the relist, under a subject id of their own so the new rungs get fresh
    // claims. Without it, the old ladder simply resumes.
    const relisted = relistOn && !gone && lastBack ? lastBack : null;
    const startedAt = relisted || passedAt;
    out.push({
      kind: "passed_checkin", party: "agent", contactId: o.contactId,
      subjectId: relisted ? `${o.id}@relist-${String(relisted).slice(0, 10)}` : o.id,
      offerId: o.id, address: o.address, startedAt, offMarketAt: gone, relisted: Boolean(relisted),
      quiet: effectiveStatus(o) === "no_response",
      sentSteps: (o.followUps || []).filter((f) => f?.kind === "passed_checkin" && (!relisted || String(f.at || "") > String(relisted))).map((f) => f.step),
      ladder,
    });
  }
  return out;
}

/**
 * hotCandidates({ store, locationId, config, now }) → [candidate]
 *
 * Open offers with an agreed price and no deal (shared/offer-status.js
 * pushesToPaper — a yes, not just warmth). The ladder counts from the later
 * of when it went hot and when THEY last wrote: a reply is the agent working it, so the push starts over from
 * there, with a subject id that carries the anchor day so the restarted
 * rungs get fresh claims. Rungs sent before the anchor belong to the old one.
 */
// The first status check after the seller wavered, in days from their text.
export const WAVERING_FIRST_DAYS = 7;
export async function hotCandidates({ store, locationId, config, now = Date.now() }) {
  const pb = config?.parties?.agent;
  const ladder = pb?.followUp?.ladders?.hot_push;
  if (!pb?.followUp?.enabled || !ladder?.enabled || !ladder.steps?.length) return [];
  const rows = await followUpRows(store, locationId, { statuses: [...OPEN_STATUSES], before: iso(now) });
  const replaced = await replacedOffers(store, locationId);
  const out = [];
  for (const o of rows) {
    if (!o?.contactId || !o.address || o.deal) continue;
    // A hot flag on a superseded row (13041 SE 208th St's July row was
    // flagged "writing it up") must not push a write-up at its number.
    if (replaced.has(o.id)) continue;
    if (!OPEN_STATUSES.has(effectiveStatus(o)) || !pushesToPaper(o)) continue;
    const heat = offerHeat(o);
    const hotAt = heat?.at || o.counterBand?.acceptedAt || o.realm?.ts || o.statusAt || o.createdAt;
    if (!hotAt) continue;
    const drafts = await store.listReplyDrafts(locationId, { contactId: o.contactId, limit: 20 }).catch(() => []);
    const ins = drafts.filter((d) => d.inbound).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const lastIn = ins[0]?.createdAt || "";
    const anchor = lastIn > hotAt ? lastIn : hotAt;
    // "Seller is having second thoughts" (831 NW 52nd, 2026-09-27): no more
    // pushes to paper. Matt, 2026-10-04: keep checking in, professionally —
    // a week after they said it, then on the ladder's weekly repeat.
    const wavering = Boolean(ins[0] && lastIn >= hotAt && soundsLikeSecondThoughts(ins[0].inbound));
    out.push({
      kind: "hot_push", party: "agent", contactId: o.contactId, subjectId: `${o.id}@${String(anchor).slice(0, 10)}`,
      offerId: o.id, address: o.address, startedAt: anchor,
      sentSteps: (o.followUps || []).filter((f) => f?.kind === "hot_push" && String(f.at || "") > anchor).map((f) => f.step),
      ladder: wavering ? { ...ladder, steps: [WAVERING_FIRST_DAYS] } : ladder,
      ...(wavering ? { wavering: true } : {}),
    });
  }
  return out;
}

// Kinds that are about one of our offers: the offer rides into the draft
// and the offer remembers its own rungs.
const OFFER_KINDS = new Set(["offer_nudge", "passed_checkin", "hot_push"]);
// "one text a morning — the push to paper went to them first"
const KIND_WORD = { hot_push: "the push to paper", offer_nudge: "the nudge on their live offer", passed_checkin: "a check-in", outreach_nudge: "a follow-up" };
// A passed offer's check-in isn't ended by them texting us about something
// else — only paused while a conversation is actually live.
const CHECKIN_QUIET_HOURS = 72;

/**
 * outreachCandidates({ store, locationId, config, now }) → [candidate]
 *
 * Cold agents: the app sent a first text (outreach_sent) and nothing has
 * come back. One ladder per contact, counted from the first text. An offer
 * on anything of theirs, a realm-yes, or a deal ends it — they are a warm
 * conversation now, and the offer ladder takes over. Replies end it the
 * usual way (runSweep reads the draft rows for an agent's inbound).
 */
export const OUTREACH_WINDOW_DAYS = 60;
export async function outreachCandidates({ store, locationId, config, now = Date.now() }) {
  const pb = config?.parties?.agent;
  const ladder = pb?.followUp?.ladders?.outreach_nudge;
  if (!pb?.followUp?.enabled || !ladder?.enabled || !ladder.steps?.length) return [];

  const since = iso(now - OUTREACH_WINDOW_DAYS * DAY_MS);
  const events = await store.listContactEventsSince(locationId, since, {
    types: ["outreach_sent", "follow_up_sent", "offer_sent", "realm_yes", "deal_promoted", "text_summary", "call_summary"],
    limit: 5000,
  }).catch(() => []);

  const byContact = new Map();
  for (const e of events) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }

  const out = [];
  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const opened = list.filter((e) => e.type === "outreach_sent").at(-1);
    if (!opened) continue;
    const after = (t) => list.some((e) => e.type === t && String(e.at) > String(opened.at));
    if (after("offer_sent") || after("realm_yes") || after("deal_promoted")) continue;
    const lastInboundAt = list.filter((e) => e.type === "text_summary" || e.type === "call_summary").at(-1)?.at || null;
    const lastTouchAt = list.filter((e) => e.type === "follow_up_sent" && e.data?.kind === "outreach_nudge").at(-1)?.at || null;
    out.push({
      kind: "outreach_nudge", party: "agent", contactId, subjectId: contactId,
      offerId: null, address: opened.address || "", startedAt: opened.at, county: opened.data?.county || "",
      sentSteps: list.filter((e) => e.type === "follow_up_sent" && e.data?.kind === "outreach_nudge").map((e) => Number(e.data?.step)),
      lastInboundAt, lastTouchAt,
      ladder,
    });
  }
  return out;
}

/**
 * investorCandidates({ store, locationId, config, now }) → [candidate]
 *
 * One location-wide event read, grouped by contact. A blast or a dataroom open
 * with nothing from them since is a candidate; a pass or a commitment ends it.
 * When both apply to the same buyer the dataroom ladder wins — somebody who
 * opened the package is a warmer thing to write to than somebody who didn't.
 */
export async function investorCandidates({ store, locationId, config, now = Date.now() }) {
  const pb = config?.parties?.investor;
  if (!pb?.followUp?.enabled) return [];
  const ladders = pb.followUp.ladders || {};
  const live = kindsFor("investor").filter((k) => ladders[k]?.enabled && ladders[k].steps?.length);
  if (!live.length) return [];

  const since = iso(now - INVESTOR_WINDOW_DAYS * DAY_MS);
  const events = await store.listContactEventsSince(locationId, since, {
    types: ["blast_sent", "dataroom_viewed", "investor_passed", "investor_committed", "investor_evaluating",
            "follow_up_sent", "text_summary", "call_summary"],
    limit: 5000,
  }).catch(() => []);

  const byContact = new Map();
  for (const e of events) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }

  const out = [];
  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    // Anything they said, or any outcome we already have, ends the ladder.
    const lastInboundAt = list.filter((e) => e.type === "text_summary" || e.type === "call_summary").at(-1)?.at || null;
    const settled = list.some((e) => e.type === "investor_passed" || e.type === "investor_committed");
    if (settled) continue;
    const lastTouchAt = list.filter((e) => e.type === "follow_up_sent").at(-1)?.at || null;

    // The trigger: the newest open/blast, dataroom first.
    const trigger = ["dataroom_nudge", "blast_nudge"]
      .filter((k) => live.includes(k))
      .map((kind) => {
        const type = FOLLOW_UP_KINDS[kind].trigger;
        // A nudge is a text. A deal we emailed to a buyer with no phone
        // (dispo-autopilot.js blastChannel) has no text to follow it with.
        const ev = list.filter((e) => e.type === type && !(type === "blast_sent" && e.data?.channel === "email")).at(-1);
        return ev ? { kind, ev } : null;
      })
      .find(Boolean);
    if (!trigger) continue;

    const { kind, ev } = trigger;
    out.push({
      kind, party: "investor", contactId, subjectId: ev.offerId || ev.address || contactId,
      offerId: ev.offerId || null, address: ev.address || "", startedAt: ev.at,
      sentSteps: list.filter((e) => e.type === "follow_up_sent" && e.data?.kind === kind).map((e) => Number(e.data?.step)),
      lastInboundAt, lastTouchAt,
      ...(kind === "dataroom_nudge" ? { viewedAt: ev.at } : { blastedAt: ev.at }),
      ladder: ladders[kind],
    });
  }
  return out;
}

/* ---------- the sweep ---------- */

/**
 * startFollowUpSweep({ client, locationId, saved, store, sendsEnabled, now, deps, trigger })
 *   → job
 *
 * Returns synchronously; the work runs on its own. `deps.startProactive` and
 * `deps.setOfferStatus` are injected so the whole thing is exercisable offline.
 */
export function startFollowUpSweep({ client, locationId, saved, store, sendsEnabled = false, now = Date.now(), deps = {}, trigger = "manual", dryRun = false, onDone = null, scope = null }) {
  const existing = jobs.get(locationId);
  if (existing?.status === "running") {
    throw Object.assign(new Error("a follow-up sweep is already running for this location"), { http: 409 });
  }
  const job = {
    id: `fu-${Date.now().toString(36)}`, locationId, trigger, dryRun,
    status: "running", phase: "collecting", ...(scope?.offerId ? { scope: { offerId: scope.offerId } } : {}),
    startedAt: iso(now), finishedAt: null,
    considered: 0, due: 0, started: 0, skipped: 0, exhaustedCount: 0, errors: 0,
    results: [], error: null, cancelRequested: false,
  };
  jobs.set(locationId, job);
  runSweep(job, { client, locationId, saved, store, sendsEnabled, now, deps, scope }).catch((e) => {
    job.status = "error";
    job.error = String(e?.message || e).slice(0, 300);
    job.finishedAt = new Date().toISOString();
  }).finally(() => onDone?.(job));
  return job;
}

async function runSweep(job, ctx) {
  const { client, locationId, saved, store, sendsEnabled, now, deps, scope = null } = ctx;
  const config = conversationConfig(saved);
  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;
  // Injectable so a test suite isn't paced at GHL's rate limit.
  const pace = Number.isFinite(deps.paceMs) ? deps.paceMs : PACE_MS;

  const push = (row) => {
    job.results.push(row);
    if (job.results.length > 200) job.results.shift();
  };

  // One house at a time (shared/agent-focus.js). The Auburn listing agent, 2026-09-21:
  // a check-in on a house they'd passed on in August went out instead of the
  // nudge on their live offer — both were due, and the later draft won. So a
  // passed house of an agent with a live offer elsewhere is read BEFORE the
  // nudges: if its check-in is due it is held, unclaimed, and rides on the
  // live offer's nudge as one line (at most once a month). A book that can't
  // be read has no focus, and the sweep behaves as before.
  const book = typeof store.listOffers === "function"
    ? await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => null)
    : null;
  const offersOf = new Map();
  for (const o of book || []) {
    if (!o?.contactId) continue;
    if (!offersOf.has(o.contactId)) offersOf.set(o.contactId, []);
    offersOf.get(o.contactId).push(o);
  }
  const focusCache = new Map();
  const focusFor = (contactId) => {
    if (!focusCache.has(contactId)) focusCache.set(contactId, focusOf(offersOf.get(contactId) || [], { contactId }));
    return focusCache.get(contactId);
  };
  const riding = [];
  const onTheirOwn = [];
  for (const c of await passedCandidates({ store, locationId, config, now })) {
    const why = focusHolds({ kind: c.kind, address: c.address, focus: focusFor(c.contactId) });
    if (why) riding.push({ ...c, rides: why });
    else onTheirOwn.push(c);
  }

  // One deal's buyers only (Today's "Nudge them" on a blast nobody opened):
  // its own blasts by offer id, or a GHL workflow's by street. Nothing else
  // rides along — before 2026-10-02 the button ran the whole morning's sweep.
  const forThisDeal = (c) => c.party === "investor"
    && (c.offerId === scope.offerId || (!c.offerId && scope.address && c.address && sameStreet(c.address, scope.address)));
  // An agreed price first: if the run's quota binds, the push to paper is
  // the text that must not wait.
  const candidates = scope?.offerId ? (await investorCandidates({ store, locationId, config, now })).filter(forThisDeal) : [
    ...(await hotCandidates({ store, locationId, config, now })),
    ...riding,
    // Two live offers due the same morning: the house they're on goes first.
    ...(await agentCandidates({ store, locationId, config, now }))
      .sort((a, b) => Number(focusFor(b.contactId)?.id === b.offerId) - Number(focusFor(a.contactId)?.id === a.offerId)),
    ...onTheirOwn,
    ...(await outreachCandidates({ store, locationId, config, now })),
    ...(await investorCandidates({ store, locationId, config, now })),
  ];
  job.considered = candidates.length;
  job.phase = "nudging";
  // Who you stopped the bot on (shared/bot-hold.js), in one read with no
  // time window. A read that fails fails the run: a sweep that can't tell
  // who is stopped doesn't text anyone.
  const stops = await botEventsByContact({ store, locationId });

  // How many nudges an investor has had this run. An agent's week is read
  // off what actually went out (spacingHolds, below) — this count only ever
  // saw the morning's run, so 9/19, 9/21 and 9/23 were each "the first".
  const weekCount = new Map();
  // One text a morning per agent: the first to get here goes — the push to
  // paper, then the live offer's nudge — and the rest wait for another day.
  const startedFor = new Map();
  // Passed houses whose check-in is due and rides on the live offer's nudge.
  const asides = new Map();
  // Blasts sent by a GHL workflow carry only an address, so an investor
  // candidate is matched to its deal by street when there's no offer id.
  let dealList = null;

  for (const c of candidates) {
    if (job.cancelRequested) break;
    const pb = config.parties[c.party];
    const fu = pb.followUp;

    // Stopped or paused: the rung isn't claimed, so it goes after Resume,
    // and an offer isn't marked "no response" while you hold the thread.
    const hold = botHold({ events: stops.get(c.contactId) || [], offerId: c.offerId || null, now });
    if (hold.held) {
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "skipped", reason: holdLine(hold) });
      continue;
    }

    if (c.party === "investor") {
      let offer = c.offerId && typeof store.getOffer === "function" ? await store.getOffer(c.offerId).catch(() => null) : null;
      if (!offer && c.address) {
        dealList ??= await (store.listDeals ? store.listDeals(locationId, { limit: 200 }) : Promise.resolve([])).catch(() => []);
        offer = dealList.find((o) => sameStreet(o?.address, c.address)) || null;
      }
      // A deal that closed, fell through or was assigned is over: no follow-up to anyone.
      if (dealIsOver(offer?.deal)) {
        job.skipped++;
        push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "skipped", reason: `the deal is ${offer.deal.stage.replace("_", " ")}` });
        continue;
      }
      // A deal that found its buyer is not nudged to anyone else.

      const mine = (offer?.deal?.investors || []).find((i) => i.contactId === c.contactId);
      // Committed elsewhere, or soft-committed: nudging another buyer about it
      // is putting it in front of them again. The buyer it is held for still
      // hears from us.
      const paused = dealOutreachPaused(offer?.deal);
      if (paused && paused.contactId !== c.contactId) {
        job.skipped++;
        push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "skipped",
          reason: outreachPausedReason(paused, offer?.address) });
        continue;
      }
    }

    // An agent candidate's inbound isn't on the event stream — a draft row
    // exists for every inbound, so one indexed read answers it.
    let lastInboundAt = c.lastInboundAt ?? null;
    let lastTouchAt = c.lastTouchAt ?? null;
    let lastHandledAt = null;
    let agentDrafts = [];
    if (c.party === "agent") {
      try {
        const rows = await store.listReplyDrafts(locationId, { contactId: c.contactId, limit: 20 });
        agentDrafts = rows;
        const times = threadTimes(rows);
        const fromDrafts = times.lastInboundAt;
        const touched = times.lastMachineTouchAt;
        lastHandledAt = times.lastHandledAt;
        // A cold agent's candidate row already carries the event stream's
        // answer; whichever source saw them most recently wins.
        lastInboundAt = [lastInboundAt, fromDrafts].filter(Boolean).sort().at(-1) || null;
        lastTouchAt = [lastTouchAt, touched].filter(Boolean).sort().at(-1) || null;
      } catch { /* no drafts to read is not a reason to skip a nudge */ }
    }

    // They answered, we answered, it went quiet: the open offer is asked
    // about again, counted from our last word (shared/follow-up.js
    // offerNudgeAnchor). The anchor day rides in the subject id, as the hot
    // push does, so the new rungs get fresh claims. This is the machine
    // starting something by itself, so it asks the brake — except for the
    // "two unanswered" stop, which the plain offer ladder never had either:
    // it asks once a week until they answer.
    let reanchored = false;
    if (c.kind === "offer_nudge") {
      const a = offerNudgeAnchor({ startedAt: c.startedAt, lastInboundAt, lastHandledAt });
      if (a.reanchored) {
        const timeline = typeof store.listContactEvents === "function"
          ? await store.listContactEvents(locationId, c.contactId, { limit: 300 }).catch(() => []) : [];
        const offer = await store.getOffer(c.offerId).catch(() => null);
        const health = threadHealth({ offer, drafts: agentDrafts, events: timeline, now });
        if (!health.drive && health.reason !== "two_unanswered") {
          job.skipped++;
          push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "skipped", reason: `${health.reason}: ${health.detail}` });
          continue;
        }
        const anchorDay = String(a.startedAt).slice(0, 10);
        c.startedAt = a.startedAt;
        c.subjectId = `${c.offerId}@${anchorDay}`;
        c.sentSteps = (offer?.followUps || []).filter((f) => f?.kind === "offer_nudge" && String(f.at || "") > a.startedAt).map((f) => f.step);
        reanchored = true;
      }
    }
    if (c.kind === "passed_checkin" && c.offMarketAt) {
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "skipped", reason: "the listing went off the market" });
      continue;
    }

    // The hot push is the machine pressing: it asks the brake first
    // (shared/thread-health.js). Two pushes with nothing back, an annoyed
    // agent, a thread you stopped or picked up: it stands down, and Today
    // says the next move is a call.
    if (c.kind === "hot_push") {
      const [rows, timeline, offer] = await Promise.all([
        store.listReplyDrafts(locationId, { contactId: c.contactId, limit: 20 }).catch(() => []),
        typeof store.listContactEvents === "function" ? store.listContactEvents(locationId, c.contactId, { limit: 300 }).catch(() => []) : [],
        store.getOffer(c.offerId).catch(() => null),
      ]);
      const health = threadHealth({ offer, drafts: rows, events: timeline, now });
      // Past the ladder, or wavering, the push is a weekly status check, not
      // a third ask for paper: two texts with nothing back don't stop it, and
      // a seller's cold feet ("second thoughts", read as a no) doesn't either.
      // Annoyed, opted out, stopped, a person's, a live deal: still stop.
      const lastRung = Math.max(...(c.ladder.steps || [0]));
      const weekly = Number(c.ladder.repeatEvery) > 0 && (c.wavering || now >= (Date.parse(c.startedAt) || now) + lastRung * 86400000);
      const softStop = health.reason === "two_unanswered" || (c.wavering && health.reason === "rejected");
      if (!health.drive && !(weekly && softStop)) {
        job.skipped++;
        push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "skipped", reason: `${health.reason}: ${health.detail}` });
        continue;
      }
    }
    if (c.kind === "passed_checkin" && lastInboundAt && now - Date.parse(lastInboundAt) < CHECKIN_QUIET_HOURS * 3600000) {
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "skipped", reason: "we're talking to them right now" });
      continue;
    }
    // Check in less / more for this person (shared/bot-hold.js).
    const pace = paceOf({ events: stops.get(c.contactId) || [] }).factor;
    // A nudge another path sent on this offer — the nightly audit's
    // "floated, never heard back", a Float pressed by hand — is that day's
    // rung, or the sweep asks the same thing again two days later.
    if (c.kind === "offer_nudge") {
      const covered = rungsCovered({ steps: c.ladder.steps, repeatEvery: c.ladder.repeatEvery, startedAt: c.startedAt, texts: nudgeTimes(agentDrafts, c.offerId), pace });
      if (covered.length) c.sentSteps = [...new Set([...c.sentSteps, ...covered])];
    }
    const d = dueStep({
      steps: c.ladder.steps, startedAt: c.startedAt, sentSteps: c.sentSteps,
      lastInboundAt, lastTouchAt, now, pace,
      // The hot push re-anchors on their reply instead of stopping on it,
      // and keeps its own floor between texts.
      stopOnAnyInbound: c.kind === "passed_checkin" || c.kind === "hot_push" || reanchored ? false : fu.stopOnAnyInbound,
      minHoursBetween: c.kind === "hot_push" ? HOT_MIN_HOURS : fu.minHoursBetween,
      repeatEvery: c.ladder.repeatEvery,
    });

    if (!d.due) {
      // The ladder is over. Write down what the silence meant — but only when
      // we actually said something into it. A ladder that only ever produced
      // drafts nobody sent proves nothing about the agent.
      if (c.kind === "offer_nudge" && c.ladder.onExhausted === "mark_no_response" && c.sentSteps.length
          && exhausted({ steps: c.ladder.steps, sentSteps: c.sentSteps, startedAt: c.startedAt, now, repeatEvery: c.ladder.repeatEvery, pace })) {
        if (!job.dryRun && typeof deps.setOfferStatus === "function") {
          const r = await deps.setOfferStatus({
            contactId: c.contactId, addressHint: c.address, status: "no_response",
            note: `no reply after ${c.sentSteps.length} follow-up${c.sentSteps.length === 1 ? "" : "s"}`,
          }).catch((e) => ({ ok: false, reason: e.message }));
          if (r?.ok) job.exhaustedCount++;
          push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "exhausted", reason: r?.ok ? "marked no response" : r?.reason });
        } else {
          job.exhaustedCount++;
          push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "exhausted", reason: "would mark no response" });
        }
        continue;
      }
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "skipped", reason: d.reason });
      continue;
    }

    // Due, but it rides on the live offer's nudge: held, not claimed, and
    // picked up below if that nudge goes this morning.
    if (c.rides) {
      if (!asides.has(c.contactId)) asides.set(c.contactId, []);
      asides.get(c.contactId).push({ ...c, step: d.step });
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "skipped", reason: c.rides });
      continue;
    }

    job.due++;
    if (c.party === "agent" && startedFor.has(c.contactId)) {
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "skipped", reason: `one text a morning — ${startedFor.get(c.contactId)} went to them first` });
      continue;
    }
    const already = weekCount.get(c.contactId) || 0;
    // Three days apart and two a week, off what actually went out (shared/
    // agent-focus.js). An agreed price is not held up by either.
    const spaced = c.party === "agent"
      ? spacingHolds({ kind: c.kind, sent: machineTexts(agentDrafts), now, minHours: fu.minHoursBetween, perWeek: fu.maxPerContactPerWeek, floor: paceScale(pace).floor })
      : (c.kind !== "hot_push" && already >= fu.maxPerContactPerWeek ? "they've had enough from us this week" : null);
    if (spaced) {
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "skipped", reason: spaced });
      continue;
    }
    // A passed house rides on this nudge as one line, at most once a month.
    const aside = c.kind === "offer_nudge" && asides.has(c.contactId) && lightTouchDue({ offers: offersOf.get(c.contactId) || [], now })
      ? pickAside(asides.get(c.contactId)) : null;

    // A backlog never goes out as a burst (reading the whole book can
    // surface one): past the run's quota, the rest go on the next runs. A
    // ladder fires only its latest due rung, never the ones it missed.
    if (job.started >= MAX_STARTS_PER_RUN) {
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "skipped", reason: `today's ${MAX_STARTS_PER_RUN} follow-ups are out — this one goes on the next run` });
      continue;
    }

    // One voice at a time: their text (or your own draft) waiting in the
    // outbox holds the nudge, and the rung is not spent on it — it goes on a
    // later run, once that row is dealt with.
    const waiting = await waitingReason({ store, locationId, contactId: c.contactId, hold: false });   // asked at the top of the loop
    if (waiting) {
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "skipped", reason: waiting });
      continue;
    }

    if (job.dryRun) {
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "would send", ...(aside ? { aside: aside.address } : {}) });
      if (c.party === "agent") startedFor.set(c.contactId, KIND_WORD[c.kind] || c.kind);
      continue;
    }

    // Claim first. See the header: the unique dedupe key is the whole
    // concurrency story, and a lost race must cost a nudge, never a duplicate.
    const claim = await recordEvent({
      store, locationId, contactId: c.contactId, party: c.party, type: "follow_up_sent",
      at: iso(now), address: c.address, offerId: c.offerId, source: "conversation",
      ref: `${c.kind}:${c.subjectId}:${d.step}`,
      dedupeKey: followUpDedupeKey({ kind: c.kind, subjectId: c.subjectId, step: d.step }),
      data: { kind: c.kind, step: d.step, dayOffset: d.dayOffset, ladder: c.ladder.steps },
    });
    if (!claim.inserted) {
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "skipped", reason: "already claimed" });
      continue;
    }

    try {
      const offer = c.offerId ? await store.getOffer(c.offerId).catch(() => null) : null;
      const r = await start({
        client, locationId, saved, store, contactId: c.contactId, kind: c.kind,
        offer: OFFER_KINDS.has(c.kind) ? offer : null,
        subject: { address: c.address, step: d.step, steps: c.ladder.steps, repeatEvery: c.ladder.repeatEvery || 0,
                   viewedAt: c.viewedAt || null, blastedAt: c.blastedAt || null, lastTouchAt, relisted: Boolean(c.relisted),
                   ...(c.county ? { county: c.county } : {}),
                   ...(c.wavering ? { wavering: true } : {}),
                   ...(aside ? { aside: { address: aside.address, quiet: Boolean(aside.quiet) } } : {}) },
        sendsEnabled, deps,
      });
      if (r?.skipped) {
        job.skipped++;
        push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "skipped", reason: r.skipped });
      } else {
        job.started++;
        // The push to paper keeps its own floor and never counts against the
        // week's nudges (it goes first, so it would otherwise crowd them out).
        if (c.kind !== "hot_push") weekCount.set(c.contactId, already + 1);
        if (c.party === "agent") startedFor.set(c.contactId, KIND_WORD[c.kind] || c.kind);
        // The offer remembers its own rungs so History can show them without
        // reading the timeline. The event is still the authority.
        if (OFFER_KINDS.has(c.kind) && c.offerId) {
          const full = await store.getOffer(c.offerId).catch(() => null);
          if (full) {
            full.followUps = [...(full.followUps || []), { kind: c.kind, step: d.step, at: iso(now), jobId: r?.job?.id || null }];
            await store.updateOffer(full.id, full).catch(() => {});
          }
        }
        push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "started", jobId: r?.job?.id || null, ...(aside ? { aside: aside.address } : {}) });
        // The passed house's rung went out on the nudge: claimed now, so its
        // ladder moves on and the month before the next mention starts here.
        if (aside) {
          const folded = await recordEvent({
            store, locationId, contactId: c.contactId, party: "agent", type: "follow_up_sent",
            at: iso(now), address: aside.address, offerId: aside.offerId, source: "conversation",
            ref: `passed_checkin:${aside.subjectId}:${aside.step}`,
            dedupeKey: followUpDedupeKey({ kind: "passed_checkin", subjectId: aside.subjectId, step: aside.step }),
            data: { kind: "passed_checkin", step: aside.step, ladder: aside.ladder.steps, aside: true, on: c.offerId },
          });
          if (folded.inserted) {
            const full = await store.getOffer(aside.offerId).catch(() => null);
            if (full) {
              full.followUps = [...(full.followUps || []), { kind: "passed_checkin", step: aside.step, at: iso(now), jobId: r?.job?.id || null, aside: true }];
              await store.updateOffer(full.id, full).catch(() => {});
            }
            push({ contactId: c.contactId, address: aside.address, kind: "passed_checkin", step: aside.step, status: "started", reason: `one line on the nudge about ${c.address}`, jobId: r?.job?.id || null });
          }
        }
      }
    } catch (e) {
      // One contact's failure is not the sweep's. A credential that would fail
      // identically for everyone is marked fatal by its thrower and rethrown.
      if (e?.fatal) throw e;
      job.errors++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "error", reason: String(e?.message || e).slice(0, 160) });
    }
    if (pace > 0) await sleep(pace);
  }

  job.status = job.cancelRequested ? "canceled" : "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
}

/**
 * maybeStartFollowUpSweep({ client, locationId, saved, store, sendsEnabled, utcHour, now })
 *   → boolean
 *
 * Called from the broker's 15-minute tick. Four gates and a durable cursor —
 * the cursor is written BEFORE the sweep runs, so a crash mid-sweep does not
 * re-spend model calls the same hour.
 */
export async function maybeStartFollowUpSweep({ client, locationId, saved, store, sendsEnabled = false, utcHour = FOLLOW_UP_UTC_HOUR, now = Date.now(), deps = {} }) {
  const h = new Date(now).getUTCHours();
  if (h < utcHour || h >= utcHour + DAILY_WINDOW_HOURS) return false;
  if (!String(saved?.aiApiKey || "").trim()) return false;
  const config = conversationConfig(saved);
  if (!config.enabled) return false;
  const anyLadder = ["agent", "investor"].some((p) => {
    const fu = config.parties[p]?.followUp;
    return fu?.enabled && Object.values(fu.ladders || {}).some((l) => l.enabled && l.steps?.length);
  });
  if (!anyLadder) return false;
  // Once a day, and back again the same morning if a deploy killed it
  // (daily-gate.js). A finished day never runs twice.
  const gate = await claimDailyRun({ store, locationId, cursorName: CURSOR_NAME, now, hourNow: h, startHour: utcHour,
    windowHours: DAILY_WINDOW_HOURS, running: jobs.get(locationId)?.status === "running" });
  if (!gate.go) return false;
  startFollowUpSweep({ client, locationId, saved, store, sendsEnabled, now, deps, trigger: "daily",
    onDone: (job) => closeDailyRun({ store, locationId, cursorName: CURSOR_NAME, failed: job.status === "error", error: job.error,
      last: { id: job.id, status: job.status, considered: job.considered, due: job.due, started: job.started, skipped: job.skipped, errors: job.errors, finishedAt: job.finishedAt } }) });
  return true;
}
// The morning's window for the sweep, from its hour.
export const DAILY_WINDOW_HOURS = 3;
