// offers-list.js — what GET /api/offers?activity=1&next=1 adds to the rows,
// read lightly, and the minute it is kept for.
//
// Opening the Offers page (Matt's main page) used to read the location's 4,000
// newest reply drafts whole — prompt context and all, ~10KB each — on the one
// broker that also takes GHL's webhooks. The two columns it feeds (last
// activity, next follow-up) touch a dozen fields of each draft. They now read
// those fields only (store.listReplyDraftActivity), over the window the next
// follow-up already reads (NEXT_WINDOW_DAYS), and the whole answer is kept for
// a minute per location, dropped the moment any offer is written
// (store.js offerWriteGeneration). The answer is the same: see
// offers-list.test.mjs.

import { LAST_ACTIVITY_TYPES, lastActivityFromEvents, mergeDraftActivity, mergeGhlActivity } from "./shared/last-activity.js";
import { floatSentIndex } from "./shared/paper-follows.js";
import { attachNextFollowUps, attachNextFollowUpsFor, NEXT_WINDOW_DAYS } from "./next-follow-up.js";

const DAY_MS = 86400000;
// The same ceiling the whole-draft read had.
export const OFFER_LIST_DRAFT_LIMIT = 4000;
export const OFFERS_LIST_CACHE_MS = 60000;

/**
 * readOfferListDrafts({ store, locationId, now }) → trimmed drafts, newest first
 *
 * The drafts both columns read: the next follow-up's window, trimmed. A store
 * without the trimmed read (a test's stub) gets whole drafts over the same window.
 */
export async function readOfferListDrafts({ store, locationId, now = Date.now(), limit = OFFER_LIST_DRAFT_LIMIT }) {
  const since = new Date(now - NEXT_WINDOW_DAYS * DAY_MS).toISOString();
  return typeof store.listReplyDraftActivity === "function"
    ? store.listReplyDraftActivity(locationId, { since, limit })
    : store.listReplyDrafts(locationId, { since, limit });
}

/**
 * attachOfferListColumns({ store, locationId, offers, activity, next, contactId,
 *   ghlLastMessages, now }) → offers
 *
 * Each row gains `lastActivity` and `floatedAt` (activity) and `nextFollowUp`
 * (next). One location-wide read of each kind, never a read per row. A read
 * that fails leaves a column saying less, never the table down.
 */
export async function attachOfferListColumns({
  store, locationId, offers = [], activity = false, next = false, contactId = null,
  ghlLastMessages = async () => new Map(), now = Date.now(),
}) {
  // One person's next follow-up (the work pane) reads that person only.
  const nextForOne = next && Boolean(contactId) && !activity;
  // Both columns read the reply drafts; one read serves both.
  const drafts = activity || (next && !nextForOne)
    ? await readOfferListDrafts({ store, locationId, now }).catch(() => [])
    : null;
  if (activity) {
    const rows = await store.lastContactActivity(locationId, { types: LAST_ACTIVITY_TYPES }).catch(() => []);
    const seen = mergeDraftActivity(lastActivityFromEvents(rows), drafts);
    // Threads the app never recorded (GHL inbox, workflows, before the
    // contact record) come from GHL's own last-message date.
    const ghl = await Promise.resolve().then(() => ghlLastMessages()).catch(() => new Map());
    mergeGhlActivity(seen, ghl, [...new Set(offers.map((o) => o?.contactId).filter(Boolean))]);
    for (const o of offers) if (o?.contactId) o.lastActivity = seen.get(o.contactId) || null;
    // When our number was floated by text (the Offers "Not sent" tab says
    // "Floated 5d ago"): a sent realm_check draft, not a field on the offer.
    const floats = floatSentIndex(drafts);
    for (const o of offers) if (o?.id) o.floatedAt = floats.get(o.id) || null;
  }
  // When each offer is next followed up, and with what
  // (shared/next-follow-up.js). Opt-in, like activity.
  if (next) {
    const saved = (await store.getOfferSettings(locationId).catch(() => null)) || {};
    await (nextForOne
      ? attachNextFollowUpsFor({ store, locationId, saved, contactId, offers, now })
      : attachNextFollowUps({ store, locationId, saved, offers, drafts, now })).catch((e) => {
      console.error(`offers: next follow-up failed loc=${locationId}:`, e?.message);
    });
  }
  return offers;
}

/**
 * createOffersListCache({ ttlMs, generation, clock }) → { remember, clear }
 *
 * remember(key, compute) → compute()'s answer, kept `ttlMs` while
 * generation() — store.js offerWriteGeneration — hasn't moved. Two loads at
 * once share one compute: a burst of reloads is one read. A compute that
 * throws is not kept.
 */
export function createOffersListCache({ ttlMs = OFFERS_LIST_CACHE_MS, generation = () => 0, clock = () => Date.now() } = {}) {
  const kept = new Map(); // key → { gen, at, value }
  const running = new Map(); // key → { gen, promise }
  return {
    async remember(key, compute) {
      const gen = generation();
      const hit = kept.get(key);
      if (hit && hit.gen === gen && clock() - hit.at < ttlMs) return hit.value;
      const flight = running.get(key);
      if (flight && flight.gen === gen) return flight.promise;
      const at = clock();
      const promise = Promise.resolve().then(compute);
      running.set(key, { gen, promise });
      try {
        const value = await promise;
        // Kept under the generation it began at: a write during the read
        // leaves it stale on arrival.
        kept.set(key, { gen, at, value });
        return value;
      } finally {
        if (running.get(key)?.promise === promise) running.delete(key);
      }
    },
    clear() { kept.clear(); running.clear(); },
  };
}
