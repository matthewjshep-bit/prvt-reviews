// outreach-scorecard.js — the text scoreboard's nightly read (2026-11-09).
//
// Which first text, follow-up and check-in gets answers, STOPs and houses
// (shared/outreach-scorecard.js has the arithmetic). Once a night in the
// quiet hours, on the 15-minute tick: the sends, their replies and the
// offers they led to are read once, the card is worked out, and it is kept
// on the job cursor ("outreachScorecard", doc.last.card). Reports read the
// kept card; nothing works it out when a page opens, because heavy reads on
// request knocked the broker over on 11-09.
//
// Reads only. It sends nothing, spends nothing (no model, no paid API) and
// changes no text or setting; a text with a bad score stays live until Matt
// changes it. Gated like the nightly audit (maybeRunConversationAudit): the
// cursor is written before the run, a run that died is retried once it is
// stale, and the night's tries are capped. No names, phones or message text
// are logged here.

import { buildOutreachScorecard, sendsFrom, outcomesFrom, templateHash, SCORE_MIN_AGE_DAYS } from "./shared/outreach-scorecard.js";
import { leadSourcesFor, LEAD_EVENT_TYPES } from "./shared/lead-source.js";
import { normalizeOpener, DEFAULT_OPENER_EXAMPLES, DEFAULT_FOLLOW_UP_TEXTS, DEFAULT_CHECK_IN_TEXTS } from "./shared/outreach-opener.js";
import { NUDGE_TEXTS, CHECKIN_TEXTS, CHECKIN_COLD_TEXTS, LISTING_PING_TEXTS, LISTING_PING_COLD_TEXTS, PAST_LISTING_TEXTS, COUNTY_OPENERS } from "./shared/standard-texts.js";
import { OPENING_MOVES } from "./conversation-prompt.js";
import { allEventsSince } from "./contact-events.js";
import { workHour } from "./outreach-sweep.js";
import { store as defaultStore } from "./store.js";

export const CURSOR_NAME = "outreachScorecard";
// 4am Pacific: after the night's jobs, before anyone is texting.
export const SCORECARD_HOUR = 4;
export const RETRY_WINDOW_HOURS = 3;
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const RETRY_GAP_MS = 20 * 60 * 1000;
export const MAX_DAILY_TRIES = 3;
export const STALE_RUN_MS = 30 * 60 * 1000;
// How far back the sends are read: the texts that went in the last four months.
export const WINDOW_DAYS = 120;
// What one night may read, at most.
export const EVENT_CEILING = 100000;

// The sends, what came back, and what the lead-source reader needs.
const SEND_TYPES = ["outreach_sent", "outreach_enrolled", "outreach_nudge_sent", "agent_pulse_texted"];
const OUTCOME_TYPES = ["text_summary", "call_summary", "unsubscribed", "house_mentioned", "referral_mentioned"];
export const SCORECARD_EVENT_TYPES = [...new Set([...SEND_TYPES, ...OUTCOME_TYPES, ...LEAD_EVENT_TYPES])];

const DAY_MS = 86400000;
const iso = (t) => new Date(t).toISOString();
const inFlight = new Set();

/**
 * templateLabels(saved) → { templates: { [hash]: text }, moves: [text] }
 *
 * What a fingerprint reads as on the card: the text itself, from Matt's saved
 * first texts, follow-ups and check-ins and the shipped pools. A text he has
 * since rewritten has no label and shows as "a fixed text (hash)".
 */
export function templateLabels(saved = {}) {
  const opener = normalizeOpener(saved?.outreachAutopilot?.opener);
  const pools = [opener.examples, opener.followUps, opener.checkIns, DEFAULT_OPENER_EXAMPLES, DEFAULT_FOLLOW_UP_TEXTS, DEFAULT_CHECK_IN_TEXTS,
    NUDGE_TEXTS, CHECKIN_TEXTS, CHECKIN_COLD_TEXTS, LISTING_PING_TEXTS, LISTING_PING_COLD_TEXTS, PAST_LISTING_TEXTS, ...Object.values(COUNTY_OPENERS)];
  const templates = {};
  for (const list of pools) {
    for (const t of list || []) {
      const h = templateHash(t);
      if (h && !templates[h]) templates[h] = String(t).length > 110 ? `${String(t).slice(0, 108)}…` : String(t);
    }
  }
  return { templates, moves: [...OPENING_MOVES] };
}

/**
 * runOutreachScorecard({ store, locationId, saved, now }) → the card
 *
 * One read of each: the events since WINDOW_DAYS (plus the month before, so
 * a house can be traced to the text that opened it), the outbox's sent rows,
 * the offer book and the outreach hooks.
 */
export async function runOutreachScorecard({ store = defaultStore, locationId, saved = {}, now = Date.now() }) {
  const since = iso(now - (WINDOW_DAYS + 30) * DAY_MS);
  const [eventsRead, ledger, offers, hooks] = await Promise.all([
    allEventsSince(store, locationId, since, { types: SCORECARD_EVENT_TYPES }, { ceiling: EVENT_CEILING }),
    typeof store.listReplyDraftLedger === "function"
      ? store.listReplyDraftLedger(locationId, { status: "sent", since, limit: 50000 }).catch(() => [])
      : store.listReplyDrafts(locationId, { status: "sent", since, limit: 20000 }).catch(() => []),
    store.listOffers(locationId, { limit: 5000, lean: true }).catch(() => []),
    typeof store.listOutreachHooks === "function" ? store.listOutreachHooks(locationId).catch(() => []) : [],
  ]);
  const events = eventsRead.events || [];
  const leads = leadSourcesFor({ offers, hooks, events });
  const annotated = offers.map((o) => (leads.has(o.id) ? { ...o, leadSource: leads.get(o.id) } : o));
  const from = now - WINDOW_DAYS * DAY_MS;
  const sends = sendsFrom({ events, ledger }).filter((s) => s.at >= from);
  const card = buildOutreachScorecard({ sends, ...outcomesFrom({ events, offers: annotated }), now, labels: templateLabels(saved) });
  return { ...card, windowDays: WINDOW_DAYS, truncated: Boolean(eventsRead.truncated) };
}

/**
 * maybeRunOutreachScorecard({ store, locationId, saved, now, deps }) → the run's summary, or null
 *
 * The tick's decision: once a night in SCORECARD_HOUR (Pacific), a failed or
 * vanished run retried through the next hours, never twice a night. The
 * cursor is written before the run.
 */
export async function maybeRunOutreachScorecard({ store = defaultStore, locationId, saved = {}, now = Date.now(), deps = {} }) {
  const h = workHour(now);
  if (h < SCORECARD_HOUR || h >= SCORECARD_HOUR + RETRY_WINDOW_HOURS) return null;
  if (inFlight.has(locationId)) return null;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const doc = cursor?.doc || {};
  const dailyAt = doc.lastDaily ? Date.parse(doc.lastDaily) : null;
  const ranToday = dailyAt != null && now - dailyAt < MIN_GAP_MS;
  const stale = doc.run?.startedAt && now - Date.parse(doc.run.startedAt) > STALE_RUN_MS;
  let tries = 1;
  if (ranToday) {
    const triedSoFar = Number(doc.tries) || 1;
    if (!(doc.failed || stale) || triedSoFar >= MAX_DAILY_TRIES || now - dailyAt < RETRY_GAP_MS) return null;
    tries = triedSoFar + 1;
  } else if (h !== SCORECARD_HOUR) {
    return null;
  }
  const run = { startedAt: iso(now) };
  // The claim, before any read: a second broker or the next tick sees it.
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { tries, lastDaily: iso(now), run, last: doc.last || null, ...(stale ? { staleRun: doc.run } : {}) } }).catch(() => {});
  inFlight.add(locationId);
  const build = deps.build || runOutreachScorecard;
  try {
    const card = await build({ store, locationId, saved, now });
    const last = { at: iso(now), finishedAt: iso(Date.now()), status: "done", card };
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { tries, lastDaily: iso(now), run: null, last, failed: false, error: null } }).catch(() => {});
    return { ran: true, sends: SCORE_KINDS_TOTAL(card), truncated: Boolean(card.truncated) };
  } catch (e) {
    const error = String(e?.message || e).slice(0, 300);
    // The last good card stays for the pages; the failure is on the cursor for the Line.
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { tries, lastDaily: iso(now), run: null, last: { ...(doc.last || {}), status: "error", error, at: iso(now) }, failed: true, error } }).catch(() => {});
    return { ran: false, error };
  } finally {
    inFlight.delete(locationId);
  }
}

const SCORE_KINDS_TOTAL = (card) => Object.values(card?.kinds || {}).reduce((a, k) => a + (Number(k?.n) || 0) + (Number(k?.young) || 0), 0);

/** storedOutreachScorecard({ store, locationId }) → { card, at, status, error } | null — what the pages show. */
export async function storedOutreachScorecard({ store = defaultStore, locationId }) {
  const c = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const last = c?.doc?.last;
  if (!last) return null;
  return { card: last.card || null, at: last.finishedAt || last.at || c.at || null, status: last.status || null, error: last.error || null, minAgeDays: SCORE_MIN_AGE_DAYS };
}

/** _resetInFlight() — tests. */
export function _resetInFlight() { inFlight.clear(); }
