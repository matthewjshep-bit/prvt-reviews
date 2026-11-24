// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// underwrite-retry.js — a house whose underwrite died on a provider's error
// is underwritten again, once, not passed (2026-11-23 audit, AH-2).
//
// From 11-11 to 11-18 the Apify key was rejected and every auto-underwrite
// stopped early. Each saved a "stopped early" draft with no number. The
// Today timer's one retry (today-timers.js retry_underwrite) worked from the
// in-memory runs — gone after a redeploy — and only on a network failure,
// never a rejected key. After the key was fixed, 14 of 15 such houses were
// never re-run, and the Needs Matt clock passed others we never priced.
//
// Now the timer also reads the stopped-early draft rows from the book, and a
// rejected-key failure is retried once the key check (key-health.js) says
// that provider's key is good again. Once per row (`autoUnderwrite.retriedAt`).
// Never on a house that already has a number of ours or Matt's: a hand-priced
// row, a later row, anything sent, or a pass (same-house-two-spellings,
// never-raise-our-number). Until it has been retried, the Needs Matt clock
// leaves the card alone. Pure.

import { AUTH_FAILURE, providerHealthy } from "./machine-health.js";
import { effectiveStatus, isAiGenerated } from "./offer-status.js";
import { lastSentAt } from "./current-offer.js";
import { pricedByHand } from "./underwrite-model.js";
import { sameHouse, oneAgentsHouse } from "./us-address.js";

// A failure that was the network's or the model's, not the house's: worth one
// more try. A scan cut short at the token limit says "try again" itself.
// (Moved here from shared/pipeline.js, which imports it.)
export const RETRYABLE_ERROR = /timed?\s?out|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|socket hang up|\b50[0234]\b|\b429\b|rate.?limit|overloaded|output truncated/i;
export const STOPPED_EARLY = /^stopped early\s*[—–-]\s*/i;
// A stopped-early row older than this is left to Matt: the agent has moved on.
export const RETRY_MAX_AGE_DAYS = 21;
// At most this many book rows retried in one pass (the daily cap still rules).
export const RETRY_PER_PASS = 5;

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/** providerOf(text) → "apify" | "anthropic" | null — whose key a failure names. */
export function providerOf(text = "") {
  const t = String(text);
  if (/apify|zillow/i.test(t)) return "apify";
  if (/anthropic|claude|authentication_error|x-api-key/i.test(t)) return "anthropic";
  return null;
}

/** underwriteFailure(text) → { auth, transient, provider } | null — a provider's failure, or not one at all. */
export function underwriteFailure(text = "") {
  const t = String(text || "");
  const auth = AUTH_FAILURE.test(t);
  const transient = !auth && RETRYABLE_ERROR.test(t);
  if (!auth && !transient) return null;
  return { auth, transient, provider: providerOf(t) };
}

/**
 * retryableNow(failure, keyHealth) → boolean
 *
 * A network failure, any time. A rejected key, only once the key check's
 * last read of that provider's key came back good — and never one whose
 * provider can't be told from the words.
 */
export function retryableNow(failure, keyHealth = {}) {
  if (!failure) return false;
  if (failure.transient) return true;
  return Boolean(failure.provider) && providerHealthy(keyHealth, failure.provider);
}

/** stoppedEarlyOn(offer) → { auth, transient, provider, error } | null — a draft whose run died on a provider. */
export function stoppedEarlyOn(offer = null) {
  if (!offer || effectiveStatus(offer) !== "draft" || offer.deal) return null;
  const held = String((offer.autoUnderwrite?.held || [])[0] || "");
  if (!STOPPED_EARLY.test(held)) return null;
  const error = held.replace(STOPPED_EARLY, "");
  const f = underwriteFailure(error);
  return f ? { ...f, error: error.slice(0, 200) } : null;
}

/** waitsOnRetry(offer) → true while a stopped-early draft hasn't had its one retry: the pass clock leaves it be. */
export function waitsOnRetry(offer = null) {
  return Boolean(stoppedEarlyOn(offer)) && !offer.autoUnderwrite?.retriedAt;
}

const sent = (o) => Boolean(lastSentAt(o) || o?.floatSentAt || (o?.sends || []).length);
const PASSED = new Set(["we_passed", "passed"]);

/**
 * houseSettled(row, offers) → why the house is already someone's number, or ""
 *
 * Any other row on the same house — any agent, either spelling — that Matt
 * made or priced by hand, came after this one, went out, or was passed. The
 * row itself must still be an unpriced, unsent draft.
 */
export function houseSettled(row = {}, offers = []) {
  if (Number(row?.cashAmount) > 0) return "this draft has a number";
  if (sent(row)) return "something went out on this draft";
  const born = ms(row.createdAt) ?? 0;
  for (const o of offers || []) {
    if (!o?.id || o.id === row.id || !o.address || o.locationId && row.locationId && o.locationId !== row.locationId) continue;
    const same = sameHouse(o.address, row.address) || (o.contactId && o.contactId === row.contactId && oneAgentsHouse(o.address, row.address));
    if (!same) continue;
    if (!isAiGenerated(o) || pricedByHand(o)) return "a row priced by hand on this house";
    if (sent(o)) return "a number went out on this house";
    if (Number(o.cashAmount) > 0) return "a priced row on this house";
    if (PASSED.has(effectiveStatus(o))) return "the house was passed";
    if ((ms(o.createdAt) ?? 0) > born) return "a later row on this house";
  }
  return "";
}

/**
 * storedRetries(offers, { keyHealth, now }) → [{ offerId, contactId, address, askingPrice, failure }]
 *
 * The book's stopped-early drafts the timer runs again now: not yet retried,
 * young enough, retryable now (retryableNow), and on a house nobody has a
 * number for (houseSettled). Oldest first, RETRY_PER_PASS at most.
 */
export function storedRetries(offers = [], { keyHealth = {}, now = Date.now(), max = RETRY_PER_PASS } = {}) {
  const out = [];
  const rows = (offers || []).filter((o) => o?.id && o.contactId && o.address)
    .sort((a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0));
  for (const o of rows) {
    if (out.length >= max) break;
    const failure = stoppedEarlyOn(o);
    if (!failure || o.autoUnderwrite?.retriedAt) continue;
    if (now - (ms(o.createdAt) ?? 0) > RETRY_MAX_AGE_DAYS * DAY_MS) continue;
    if (!retryableNow(failure, keyHealth)) continue;
    if (houseSettled(o, offers)) continue;
    out.push({ offerId: o.id, contactId: o.contactId, address: o.address, askingPrice: 0, failure });
  }
  return out;
}
