// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// reply-claims.js — what a reply says we did or will do, read against what's
// true.
//
// The 2026-11-09 audit: after the 10/22 prompt fix the bot still told agents
// "should have something for you today" about houses only Matt prices (about
// 7 a day; half got no number in 72 hours and were then passed on the
// clock), promised 27 calls since 10/23 of which 1 connected, invented a
// partner, a team or an underwriter to check with, said "we connected" when
// no call had happened, and said the offer was emailed when nothing went.
// The prompt says not to. These are the checks that hold the text when it
// does anyway (evaluateReplyGates, ghl-broker/reply-agent.js). Every one only
// adds a hold.
//
// Pure. The facts a gate reads (claimFacts) come from the offer book and the
// contact's timeline, which the broker already loads for the prompt.

import { detectPromise, promisesCall, isConditionalPromise } from "./follow-up.js";
import { callEventConnected } from "./talked-to.js";
import { effectiveStatus, isDraftOnly, isSkeleton } from "./offer-status.js";
import { groupHouses, resolveHouse, houseKey } from "./current-offer.js";
import { sameStreetLoose } from "./us-address.js";

// How far back a call (or a call we promised) counts.
export const CLAIM_WINDOW_DAYS = 14;
const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/* ---------- a number, or a time for it, we don't have ---------- */

// A time a reply hangs on something.
const TIME_WORD = String.raw`(?:today|tonight|shortly|soon|tomorrow|this\s+(?:afternoon|evening|morning|week)|end\s+of\s+(?:the\s+)?(?:day|week)|eod|asap|right\s+away|within\s+the\s+hour|in\s+(?:a\s+bit|an\s+hour|a\s+few\s+hours|a\s+couple\s+(?:of\s+)?hours)|(?:before|by)\s+(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|noon|\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?))\b`;
// A promise verb (the spec's: I'll, will, should have, get back, send).
const PROMISE_VERB = String.raw`(?:i'?ll|i\s+will|we'?ll|we\s+will|will|should\s+have|get\s+back|come\s+back|circle\s+back|send(?:ing)?|text\s+you)\b`;
// What the promise is about: our number or the offer.
const NUMBER_WORD = String.raw`(?:numbers?|figure|offer|price|loi|letter\s+of\s+intent|where\s+we(?:'d|\s+would)?\s+(?:land|be|come\s+out))\b`;
const TIME_RX = new RegExp(String.raw`\b${TIME_WORD}`, "i");
// Words within this many of each other read as one promise.
const NEAR_WORDS = 8;

// Word positions of every match of `source` in a sentence.
function wordsAt(sentence, source) {
  const starts = [...sentence.matchAll(/\S+/g)].map((m) => m.index);
  const at = (i) => { let n = 0; while (n < starts.length && starts[n] <= i) n++; return n - 1; };
  return [...sentence.matchAll(new RegExp(String.raw`\b${source}`, "gi"))].map((m) => at(m.index));
}

/** timeOnANumber(text) → a promise verb, a time word and our number or offer within a few words, in one sentence. */
export function timeOnANumber(text = "") {
  for (const s of String(text || "").split(/(?<=[.!?\n])\s+/)) {
    const times = wordsAt(s, TIME_WORD);
    if (!times.length) continue;
    const verbs = wordsAt(s, PROMISE_VERB);
    const nums = wordsAt(s, NUMBER_WORD);
    if (!verbs.length || !nums.length) continue;
    const near = (a, b) => Math.abs(a - b) <= NEAR_WORDS;
    if (verbs.some((v) => times.some((t) => near(t, v)) && nums.some((n) => near(n, v) || times.some((t) => near(n, t))))) return true;
  }
  return false;
}

// Fed back to the model as the one correction (redraftOnGate), so it is the
// rule itself, short enough to survive the prompt's 200-character clip
// (ghl-broker/conversation-context.js MATT_PRICES_LINE says it in full).
export const NUMBER_TIME_FLAG = "the draft promises a number, or a time for one, on a house with no number yet (priced by hand) — no figure, range, time or \"get back to you\"; ask what the seller would take, or their timing";

/**
 * numberTimeFlags(reply, { numberUnpriced }) → [flag] | []
 *
 * On a house nobody has priced (numberUnpriced): a reply that promises our
 * number (detectPromise "number", "should have something for you today"), the
 * written offer by a time, or puts a time word beside a promise verb and our
 * number or offer. A house whose number went out may say when.
 */
export function numberTimeFlags(reply = "", { numberUnpriced = false } = {}) {
  const t = String(reply || "");
  if (!numberUnpriced || !t.trim()) return [];
  const what = detectPromise(t);
  const hit = what === "number" || (what === "paper" && TIME_RX.test(t)) || timeOnANumber(t);
  return hit ? [NUMBER_TIME_FLAG] : [];
}

/* ---------- a second call promise ---------- */

// Held for Matt, never rewritten (redraftOnGate reads it): the agent is
// waiting on a call, and only he can make it.
export const CALL_OWED_FLAG = "we already promised them a call that didn't happen — call them before the bot promises another";
// "I'll be calling you shortly", "calling you in a bit" — said without a "will".
const CALLING_SOON_RX = /\b(?:calling|ringing)\s+you\s+(?:shortly|soon|in\s+a\s+(?:bit|few|minute|sec))\b|\b(?:call|ring)\s+you\s+(?:back\s+)?(?:shortly|soon|in\s+a\s+(?:bit|few|minute|sec))\b/i;

/** callPromiseFlags(reply, { callOwedUnkept }) → [CALL_OWED_FLAG] | [] */
export function callPromiseFlags(reply = "", { callOwedUnkept = false } = {}) {
  const t = String(reply || "");
  if (!callOwedUnkept || !t.trim()) return [];
  const promised = promisesCall(t) || (CALLING_SOON_RX.test(t) && !isConditionalPromise(t));
  return promised ? [CALL_OWED_FLAG] : [];
}

/* ---------- people who don't exist ---------- */

// First person only: their partner, their team, the seller's partner are real.
const INVENTED = [
  /\b(?:my|our)\s+(?:business\s+)?partners?\b/i,
  /\b(?:my|our)\s+(?:underwriting\s+|acquisitions?\s+)?team\b/i,
  /\bunderwriting\s+team\b/i,
  /\b(?:my|our)\s+underwriters?\b/i,
  /\bour\s+underwriting\s+(?:re-?ran|came\s+back)\b/i,
  /(?<!\byou\s+and\s+)\bthe\s+team\b(?!\s+(?:at|from|over|on\s+(?:your|their))\b)/i,
  /\b(?:confirm|check|verify)\s+(?:that\s+|it\s+|this\s+)?internally\b/i,
];

/** inventsSomeone(reply) → the words, when a reply has us check with a partner, a team or an underwriter we don't have; else "". */
export function inventsSomeone(reply = "") {
  const t = String(reply || "");
  for (const re of INVENTED) {
    const m = t.match(re);
    if (m) return m[0];
  }
  return "";
}

/** inventedPeopleFlags(reply) → [flag] | [] */
export function inventedPeopleFlags(reply = "") {
  const said = inventsSomeone(reply);
  return said ? [`the draft says "${said}" — there's no partner, team or underwriter to check with; say it as yourself`] : [];
}

/* ---------- a call that didn't happen ---------- */

// We talked: needs a call that connected.
const TALKED = [
  /\bdid\s+connect\b|\b(?:we|we'?ve|finally)\s+connected\b/i,
  /\bI\s+spoke\s+(?:with|to)\b/i,
  /\bspoke\s+(?:with|to)\s+(?:the\s+)?(?:owner|seller)s?\b/i,
  // "As we discussed" or "per our conversation" can be a text thread; these can't.
  /\b(?:like|as)\s+we\s+(?:talked|spoke)\b/i,
  /\bper\s+our\s+(?:phone\s+)?call\b/i,
];
// We tried: needs any call either way, connected or not.
const TRIED = [
  /\bI\s+(?:called|tried\s+(?:calling|to\s+call|you))\b/i,
  /\bsorry\s+(?:I|we)\s+missed\s+you\b/i,
];

/**
 * claimsContact(reply, { connectedCallRecently, callTriedRecently }) → the words, or ""
 *
 * "We connected", "I spoke with the seller", "like we talked about" need a
 * call that connected in the last CLAIM_WINDOW_DAYS; "I called", "sorry I
 * missed you" need a call either way. "Sorry I missed your call" is theirs.
 */
export function claimsContact(reply = "", { connectedCallRecently = true, callTriedRecently = connectedCallRecently } = {}) {
  const t = String(reply || "");
  if (!connectedCallRecently) for (const re of TALKED) { const m = t.match(re); if (m) return m[0]; }
  if (!callTriedRecently) for (const re of TRIED) { const m = t.match(re); if (m) return m[0]; }
  return "";
}

/** contactClaimFlags(reply, inputs) → [flag] | [] */
export function contactClaimFlags(reply = "", inputs = {}) {
  const said = claimsContact(reply, inputs);
  return said ? [`the draft says "${said}" — no call with them on record in the last ${CLAIM_WINDOW_DAYS} days; never claim a call or a talk that didn't happen`] : [];
}

/* ---------- a send that didn't happen ---------- */

// A reply that says an email has gone: "emailed it", "sent it to x@example.com",
// "it went to …@…", "check your inbox". Future tense ("I'll email it") is fine.
export const CLAIMS_EMAIL_RX = /\b(just |already )?e-?mailed\b|\b(sent|went|resent|forwarded)\b[^.?!]{0,60}\b(to\s+\S+@\S+|by e-?mail|via e-?mail|to your e-?mail|to your inbox)|\bcheck your (inbox|e-?mail|spam)\b/i;
const THE_PAPER = String.raw`(?:the|our)\s+(?:written\s+|formal\s+|official\s+)?(?:offer|letter(?:\s+of\s+intent)?|loi)`;
// "Sent our offer over", "just sent the LOI", "sent over the letter".
const SENT_OFFER_RX = new RegExp(String.raw`\b(?:(?:just|already)\s+sent\s+(?:you\s+)?(?:over\s+)?${THE_PAPER}|sent\s+(?:you\s+)?${THE_PAPER}\s+over|sent\s+over\s+${THE_PAPER})\b`, "i");

/**
 * claimsSentOffer(reply, { offerWentOut, sendOfferDone }) → the words, or ""
 *
 * The reply says the offer went over, or was emailed, and nothing did:
 * no written offer on that house before (offerWentOut) and no send_offer
 * in this run (sendOfferDone). Defaults read as "it went", so a caller that
 * doesn't know flags nothing.
 */
export function claimsSentOffer(reply = "", { offerWentOut = true, sendOfferDone = false } = {}) {
  const t = String(reply || "");
  if (offerWentOut || sendOfferDone || !t.trim()) return "";
  const m = t.match(SENT_OFFER_RX) || t.match(CLAIMS_EMAIL_RX);
  return m ? m[0].trim() : "";
}

/** sentOfferFlags(reply, inputs) → [flag] | [] */
export function sentOfferFlags(reply = "", inputs = {}) {
  const said = claimsSentOffer(reply, inputs);
  return said ? [`the draft says "${said}" — nothing went out on it; never say it was sent or emailed unless it was`] : [];
}

/* ---------- the facts a gate reads ---------- */

// The written offer went (or a person marked it so).
const PAPER_STATUSES = new Set(["sent", "countered", "no_response", "accepted"]);
const paperWent = (o) => (o?.sends || []).some((s) => s?.ts && (!s.results || Object.values(s.results).some((r) => r?.ok)));
/** offerPapered(offer) → the written offer went out on it. */
export const offerPapered = (o) => Boolean(o) && (paperWent(o) || Boolean(o.deal) || PAPER_STATUSES.has(effectiveStatus(o)));
/** numberWentOut(offer) → our number reached them: the written offer, a float that left, or the engine's live number. */
export const numberWentOut = (o) => offerPapered(o) || Boolean(o?.floatSentAt) || Boolean(o?.pricing?.live);

const CALL_PROMISE_TYPES = new Set(["promise_made", "promise_owed", "call_owed"]);
const callPromised = (e) => {
  if (!CALL_PROMISE_TYPES.has(e?.type)) return false;
  if (e.type === "call_owed") return true;
  const d = e.data || {};
  if (d.what !== "call" && d.kind !== "call") return false;
  return d.conditional !== true && !(d.text && isConditionalPromise(d.text));
};

/**
 * claimFacts({ offers, events, mattPrices, now }) → { mattPrices, houses, connectedCallAt, callAt, owedCallSince }
 *
 *   houses         one per house: { address, out, papered, unpriced }. Unpriced: a
 *                  draft or unsent row with no number on it, nothing of ours went
 *                  out on it (no send, no float that left, no live engine number),
 *                  and priced by hand (mattPrices, or a draft-only, skeleton or
 *                  engine-held draft). A row with a number is priced, sent or not:
 *                  the float that carries it may say when.
 *   connectedCallAt the newest call that connected (callEventConnected), in the window
 *   callAt         the newest call either way (a call_summary or a call_attempt)
 *   owedCallSince  the oldest call we promised in the window with no connected call
 *                  and no dismissal since
 */
export function claimFacts({ offers = [], events = [], mattPrices = false, now = Date.now(), windowDays = CLAIM_WINDOW_DAYS } = {}) {
  const houses = [];
  for (const rows of groupHouses((offers || []).filter((o) => o && String(o.address || "").trim())).values()) {
    const newest = [...rows].sort((a, b) => (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0))[0];
    const subject = resolveHouse(rows).current || newest;
    const out = rows.some(numberWentOut);
    const status = effectiveStatus(subject);
    houses.push({
      address: subject.address,
      out,
      papered: rows.some(offerPapered),
      unpriced: !out && (status === "draft" || status === "new") && !(Number(subject.cashAmount) > 0)
        && (Boolean(mattPrices) || isDraftOnly(subject) || isSkeleton(subject)),
    });
  }
  const floor = now - windowDays * DAY_MS;
  const evs = (events || []).filter((e) => e && (ms(e.at) ?? -Infinity) >= floor && (ms(e.at) ?? Infinity) <= now)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let connectedCallAt = null, callAt = null, owedCallSince = null;
  for (const e of evs) {
    if (callEventConnected(e)) connectedCallAt = e.at;
    if (e.type === "call_summary" || e.type === "call_attempt") callAt = e.at;
  }
  for (const p of evs.filter(callPromised)) {
    const later = evs.filter((e) => String(e.at) > String(p.at));
    if (later.some((e) => callEventConnected(e) || (e.type === "promise_kept" && e.data?.by === "dismissed"))) continue;
    owedCallSince = p.at;
    break;
  }
  return { mattPrices: Boolean(mattPrices), houses, connectedCallAt, callAt, owedCallSince };
}

const sameHouse = (a, b) => {
  const ka = houseKey(a), kb = houseKey(b);
  return (ka && ka === kb) || sameStreetLoose(a, b);
};

/**
 * claimGateInputs(facts, { address }) → { numberUnpriced, callOwedUnkept, connectedCallRecently, callTriedRecently, offerWentOut }
 *
 * The gate's inputs for a reply about `address`. A house we have no row for
 * is priced by hand when Matt prices them. With no house named, unpriced only
 * when nothing of theirs has a number out. No facts: nothing new is flagged.
 */
export function claimGateInputs(facts = null, { address = "" } = {}) {
  if (!facts) return { numberUnpriced: false, callOwedUnkept: false, connectedCallRecently: true, callTriedRecently: true, offerWentOut: true };
  const houses = facts.houses || [];
  const a = String(address || "").trim();
  const house = a ? houses.find((h) => sameHouse(h.address, a)) : null;
  const numberUnpriced = a
    ? (house ? house.unpriced : Boolean(facts.mattPrices))
    : !houses.some((h) => h.out) && (Boolean(facts.mattPrices) || houses.some((h) => h.unpriced));
  return {
    numberUnpriced,
    callOwedUnkept: Boolean(facts.owedCallSince),
    connectedCallRecently: Boolean(facts.connectedCallAt),
    callTriedRecently: Boolean(facts.callAt || facts.connectedCallAt),
    offerWentOut: a ? Boolean(house?.papered) : houses.some((h) => h.papered),
  };
}
