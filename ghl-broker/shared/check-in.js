// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// check-in.js — when a check-in waits, and which of the fixed texts it says.
//
// Matt, 2026-11-09: check-ins have to sound like him texting someone he
// knows. The audit read the sent log: 63 word-for-word repeats in 60 days (34
// on 11-09, two STOPs within minutes); 1,319 of 4,915 bot check-ins went
// right after a no, a "later" or a house they gave us; 56 went to homeowners;
// 25 threads where we said we'd back off and texted anyway; and the canned
// "I'm an assistant on Matt's team" went out in 9 threads. Every recurring
// check-in now reads the thread first and asks:
//
//   1 has only an auto-reply answered this number in 90 days?   wait 90 days
//   2 did they ask whether this is a bot?                       Matt's, no machine text for 30 days
//   3 is it a homeowner's thread on an agent check-in?          never
//   4 was their last word a plain no?                           wait until day 30
//   5 did they (or we) say when to come back?                   wait until then
//   6 did our last text take our number back?                   Matt's
//
// The critical kinds (a live number, a date they set, a walkthrough) are
// never held back by 4 or 5: those are about something open. They still get
// 1, 2, 3 and 6 and the no-repeat rule.
//
//   checkInPack(transcript, subject, context, now)   what the thread says, dated
//   routeCheckIn(pack, kind, settings, opts)          send | skip | matt
//   pickVariant(pool, prior, seed, touch, opts)       a fixed text that repeats nothing
//   checkInWait(ledger, { lastInboundAt, now })       the skip the agent check-in waits on
//   goesBySaid(text, { first, ours })                 the name a person goes by
//
// And the one real thing a check-in names (the composer, below): the pack's
// dated hooks, composeRoute (off | shadow | model | control | skip),
// namesAHouse and checkInFlags (a check-in never names a house from before),
// and checkInReport.
//
// Pure. ghl-broker/reply-agent.js runProactive routes; shared/agent-pulse.js
// evaluateAgent waits; shared/standard-texts.js picks.

import { repeatsUs, groupsOf, ourLastTexts, AI_COMPLAINT_RX, SENSITIVE_RX, ONCE_LAST, ONCE_DAYS, PRIOR_MAX } from "./voice.js";
import { isTapback, isAutoReply, cadenceRequest, ourCheckBack } from "./brush-offs.js";
import { checkInRequested, detectLeadTiming } from "./follow-up.js";
import { isPlainNo } from "./conversation-audit.js";
import { openerVariant } from "./outreach-opener.js";
import { streetMentions } from "./mentioned-houses.js";
import { parseUsAddress } from "./us-address.js";
import { WA_CITY_COORDS } from "./wa-city-coords.js";

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const iso = (t) => new Date(t).toISOString();
const clamp = (x, d, lo, hi) => { const n = Math.round(Number(x)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/* ---------- settings (conversationAi.checkIns) ---------- */

// These only hold a text back or reword it, so they ship on (Matt's "one
// real detail, not boilerplate" rule, 2026-11-09). shared/conversation-ai.js
// normalises them inside the checkIns block.
export const CHECK_IN_ROUTE_DEFAULTS = Object.freeze({ noRepeat: true, repeatTouches: 6, respectLastWord: true, afterNoDays: 30, aiComplaintDays: 30 });
export function normalizeCheckInRoute(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const D = CHECK_IN_ROUTE_DEFAULTS;
  const bool = (x, d) => (x == null ? d : x === true || x === "true" || x === 1 || x === "1");
  return {
    noRepeat: bool(o.noRepeat, D.noRepeat),
    repeatTouches: clamp(o.repeatTouches, D.repeatTouches, 2, 12),
    respectLastWord: bool(o.respectLastWord, D.respectLastWord),
    afterNoDays: clamp(o.afterNoDays, D.afterNoDays, 7, 120),
    aiComplaintDays: clamp(o.aiComplaintDays, D.aiComplaintDays, 7, 120),
  };
}

/* ---------- which kinds ---------- */

// Something open, or a date they set: never held back by a no or a "later".
export const CRITICAL_CHECK_IN_KINDS = new Set(["offer_nudge", "hot_push", "counter_nudge", "second_look", "promise_due", "price_drop",
  "address_chase", "deal_followup", "showing_reminder", "showing_followup"]);
// The recurring check-ins: the whole route.
export const ROUTINE_CHECK_IN_KINDS = new Set(["agent_pulse", "outreach_nudge", "passed_checkin", "checkin_due", "buyer_pulse"]);
// A check-in they asked for on a date, a lead with its day, or the net under
// their unanswered text is about something they set.
const CRITICAL_CHECKIN_DUE = new Set(["date", "lead", "unanswered"]);

/** isCriticalCheckIn(kind, sourceKind) → true for a kind about something open or a date they set. */
export function isCriticalCheckIn(kind = "", sourceKind = "") {
  if (CRITICAL_CHECK_IN_KINDS.has(kind)) return true;
  return kind === "checkin_due" && CRITICAL_CHECKIN_DUE.has(String(sourceKind || "date"));
}
/** routesCheckIn(kind) → whether runProactive reads the thread for this kind before writing it. */
export const routesCheckIn = (kind = "") => ROUTINE_CHECK_IN_KINDS.has(kind) || CRITICAL_CHECK_IN_KINDS.has(kind);

/* ---------- the thread, read ---------- */

const LINE_RX = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\]\s+(US|THEM)\s+([a-z]+)\b(?:[^:\n]*:\s?(.*))?$/i;
function linesOf(transcript = "") {
  const out = [];
  for (const raw of String(transcript || "").split("\n")) {
    const m = LINE_RX.exec(raw.trim());
    if (!m) continue;
    out.push({ at: `${m[1]}T${m[2]}:00.000Z`, who: m[3].toUpperCase(), channel: m[4].toLowerCase(), text: String(m[5] || "").trim() });
  }
  return out;
}

// "Not interested" said short and plain is a no, like "no thanks".
const NOT_INTERESTED_RX = /^\s*(?:no[\s,.!]*)?(?:i'?m\s+|we'?re\s+)?not\s+interested\b[\s,.!]*(?:thanks?|thank\s+you|sorry)?[\s.!]*$/i;
const plainNo = (t) => isPlainNo(t) || (String(t || "").length <= 60 && NOT_INTERESTED_RX.test(String(t || "")));
// A house in their words: a number and a street word.
const HOUSE_RX = /\b\d{2,6}\s+(?:[nsew]{1,2}\s+)?(?:\w+\s+){0,3}?(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|blvd|cir|circle|ter|terrace|hwy|loop|pkwy)\b/i;
// Our first text asked a homeowner about their own house, not an agent about
// a listing (the June seller texts).
const HOMEOWNER_ASK_RX = /\b(?:do|did)\s+you\s+(?:still\s+)?own\b|\bare\s+you\s+the\s+(?:home\s*|property\s+)?owner\b|\b(?:your|ur)\s+(?:house|home|property|place)\b|\b(?:consider|thought\s+about|interested\s+in)\s+selling\b|\bwould\s+you\s+(?:ever\s+)?sell\b/i;
const LISTING_WORD_RX = /\blist(?:ing|ed)\b|\bmls\b|\bseller\b|\byour\s+client\b/i;

const SAID_LATER_LINES = 3;
const LATER_LOOKBACK_DAYS = 200;

// When their words (or ours) say to come back, measured from when they were said.
function laterFromTheirs(text, at) {
  const t0 = ms(at);
  if (t0 == null || !String(text || "").trim()) return null;
  const dates = [];
  const asked = checkInRequested(text, t0);
  if (asked?.dueAt) dates.push({ until: asked.dueAt, phrase: asked.phrase });
  // A "check back" with no lead in it ("check back after the holidays"): a
  // lead's own day is its own check-in, never the regular one's wait.
  const back = detectLeadTiming(text, t0);
  if (back?.when && !back.what) dates.push({ until: back.when, phrase: back.phrase });
  const cadence = cadenceRequest(text);
  if (cadence?.days) dates.push({ until: iso(t0 + cadence.days * DAY_MS), phrase: cadence.phrase || cadence.why });
  return dates.sort((a, b) => String(b.until).localeCompare(String(a.until)))[0] || null;
}

/**
 * checkInPack(transcript, subject, context, now) → what the thread says, every item dated
 *
 *   theirLast   { text, at, daysAgo, read: no|later|auto|ai_complaint|house|question|other }
 *               their newest text or email, past tapbacks and auto-replies
 *               (an auto-reply only when nothing else of theirs is there)
 *   laterUntil  { until, phrase, by: "them" | "us" } when they, or we, said to come back
 *   ourLast     our last `repeatTouches` texts and emails, newest first, any clock
 *   autoOnly    every text from them in 90 days is an auto-reply
 *   aiComplaint { text, at, until } their line asking whether this is a bot, in `aiComplaintDays`
 *   homeowner   our first text asked about their own house, and no agent tag
 *   retracted   { offerId, address, at } our number went and we passed within a day, and silence since
 *
 * and the one real thing a check-in may name (oneThings, below): `lead`,
 * `question`, `call`, `theirWords`, `personal`, `theirNo`, `quotes`,
 * `buyCity`, `areas`, `lastSummary`, and `hooks`, ranked, hooks[0] first.
 *
 * `context`: { offers (this contact's), agentTagged, repeatTouches, aiComplaintDays }
 * and for the composer { party, calls (call_summary events), facts (the
 * contact record's), quotes (an investor read's), personal, spent (hook keys
 * we already used), newerThan, afterNoDays }.
 */
export const AUTO_ONLY_DAYS = 90;
export const RETRACTED_HOURS = 24;
export const RETRACTED_STANDS_DAYS = 120;
export function checkInPack(transcript = "", subject = {}, context = {}, now = Date.now()) {
  const s = normalizeCheckInRoute(context);
  const lines = linesOf(transcript);
  const theirs = lines.filter((l) => l.who === "THEM");
  const words = theirs.filter((l) => (l.channel === "sms" || l.channel === "email") && l.text && !isTapback(l.text));
  const person = words.filter((l) => !isAutoReply(l.text));
  const daysAgo = (at) => Math.max(0, Math.floor((now - (ms(at) ?? now)) / DAY_MS));

  // Their last word, read.
  let theirLast = null;
  const last = person.at(-1) || null;
  if (last) {
    const later = laterFromTheirs(last.text, last.at);
    const read = AI_COMPLAINT_RX.test(last.text) ? "ai_complaint"
      : plainNo(last.text) ? "no"
      : later && ms(later.until) > ms(last.at) ? "later"
      : HOUSE_RX.test(last.text) ? "house"
      : /\?\s*$/.test(last.text) ? "question"
      : "other";
    theirLast = { text: last.text.slice(0, 300), at: last.at, daysAgo: daysAgo(last.at), read, channel: last.channel };
  } else if (words.length) {
    const a = words.at(-1);
    theirLast = { text: a.text.slice(0, 300), at: a.at, daysAgo: daysAgo(a.at), read: "auto", channel: a.channel };
  }

  // When to come back: their last few lines, and our own last texts ("I'll
  // check back after the new year"), each read from when it was said.
  let laterUntil = null;
  const keep = (l, by) => {
    if (!l || ms(l.until) == null || ms(l.until) <= now) return;
    if (!laterUntil || String(l.until) > String(laterUntil.until)) laterUntil = { ...l, by };
  };
  for (const l of person.slice(-SAID_LATER_LINES)) {
    if (now - (ms(l.at) ?? 0) > LATER_LOOKBACK_DAYS * DAY_MS) continue;
    keep(laterFromTheirs(l.text, l.at), "them");
  }
  const ourLast = ourLastTexts(transcript, { limit: s.repeatTouches });
  for (const o of ourLast) {
    const t0 = ms(o.at);
    if (t0 == null || now - t0 > LATER_LOOKBACK_DAYS * DAY_MS) continue;
    const back = ourCheckBack(o.text, t0);
    if (back?.dueAt) keep({ until: back.dueAt, phrase: back.phrase }, "us");
  }

  // Only an auto-reply has answered this number in 90 days. A call from them
  // is a person, and so is an email of theirs that isn't one (an agent whose
  // phone answers every text for her, and who writes back by email).
  const recent = theirs.filter((l) => now - (ms(l.at) ?? 0) <= AUTO_ONLY_DAYS * DAY_MS);
  const recentTexts = recent.filter((l) => l.channel === "sms" && l.text && !isTapback(l.text));
  const wroteByEmail = recent.some((l) => l.channel === "email" && l.text && !isAutoReply(l.text));
  const autoOnly = recentTexts.length > 0 && recentTexts.every((l) => isAutoReply(l.text)) && !recent.some((l) => l.channel === "call") && !wroteByEmail;
  const autoAt = autoOnly ? recentTexts.at(-1).at : null;

  // They asked whether this is a bot (a person did: an auto-reply's own
  // "this is an automated message" is not them asking).
  const complaint = [...person].reverse().find((l) => AI_COMPLAINT_RX.test(l.text) && now - (ms(l.at) ?? 0) <= s.aiComplaintDays * DAY_MS) || null;
  const aiComplaint = complaint ? { text: complaint.text.slice(0, 200), at: complaint.at, until: iso((ms(complaint.at) ?? now) + s.aiComplaintDays * DAY_MS) } : null;

  // A homeowner's thread: our first text asked about their own house.
  const firstOurs = lines.find((l) => l.who === "US" && l.text && (l.channel === "sms" || l.channel === "email"));
  const homeowner = Boolean(firstOurs && HOMEOWNER_ASK_RX.test(firstOurs.text) && !LISTING_WORD_RX.test(firstOurs.text) && !context.agentTagged);

  // Our number went, and we took it back within a day; nothing from them since.
  let retracted = null;
  const heardSince = (t) => person.some((l) => (ms(l.at) ?? 0) > t) || theirs.some((l) => l.channel === "call" && (ms(l.at) ?? 0) > t);
  for (const o of context.offers || []) {
    if (!o || o.status !== "we_passed") continue;
    const passedAt = ms(o.statusAt);
    const sentAt = [o.floatSentAt, ...(o.sends || []).map((x) => x?.ts || x?.at)].map(ms).filter((t) => t != null).sort((a, b) => a - b)[0];
    if (passedAt == null || sentAt == null || passedAt < sentAt || passedAt - sentAt > RETRACTED_HOURS * HOUR_MS) continue;
    if (now - passedAt > RETRACTED_STANDS_DAYS * DAY_MS || heardSince(passedAt)) continue;
    if (!retracted || passedAt > ms(retracted.at)) retracted = { offerId: o.id || null, address: String(o.address || ""), at: iso(passedAt) };
  }

  return { theirLast, laterUntil, ourLast, autoOnly, autoAt, aiComplaint, homeowner, retracted, subjectKind: subject?.kind || null,
    ...oneThings({ lines, theirLast, ourLast, subject, context, now }) };
}

/* ---------- the route ---------- */

const day = (v) => String(v || "").slice(0, 10);

/**
 * routeCheckIn(pack, kind, settings, { party, sourceKind, now }) → { route, why, until, key?, permanent? }
 *
 * `route`: "send", "skip" (nothing goes; the timeline says why and until
 * when, and the Desk never sees it) or "matt" (nothing goes by itself; the
 * text waits for Matt, once). First match wins. `settings` is
 * conversationAi.checkIns.
 */
export function routeCheckIn(pack = {}, kind = "", settings = {}, { party = "agent", sourceKind = "", now = Date.now() } = {}) {
  const s = normalizeCheckInRoute(settings);
  const critical = isCriticalCheckIn(kind, sourceKind);
  const send = { route: "send", why: "", until: null };
  if (!pack || !routesCheckIn(kind)) return send;
  if (s.respectLastWord && pack.autoOnly) {
    return { route: "skip", why: "only an auto-reply has answered this number in 90 days", until: iso(now + AUTO_ONLY_DAYS * DAY_MS) };
  }
  if (pack.aiComplaint) {
    return { route: "matt", why: `they asked if this is a bot on ${day(pack.aiComplaint.at)}: no machine text for ${s.aiComplaintDays} days`,
      until: pack.aiComplaint.until, key: `ai:${pack.aiComplaint.at}` };
  }
  if (s.respectLastWord && party === "agent" && pack.homeowner && !critical) {
    return { route: "skip", why: "a homeowner, not an agent", until: null, permanent: true };
  }
  const t = pack.theirLast;
  if (s.respectLastWord && !critical && t?.read === "no" && t.daysAgo < s.afterNoDays) {
    return { route: "skip", why: `they said no on ${day(t.at)}`, until: iso((ms(t.at) ?? now) + s.afterNoDays * DAY_MS) };
  }
  const later = pack.laterUntil;
  if (s.respectLastWord && !critical && later && ms(later.until) > now) {
    const said = later.by === "us" ? "we said we'd check back" : "they said to check back";
    return { route: "skip", why: `${said}${later.phrase ? ` (${String(later.phrase).slice(0, 40)})` : ""}`, until: later.until };
  }
  if (party === "agent" && pack.retracted) {
    const street = String(pack.retracted.address || "").split(",")[0].trim();
    return { route: "matt", why: `our last text took our number back${street ? ` on ${street}` : ""} and they haven't written since`,
      until: iso(now + s.afterNoDays * DAY_MS), key: `retracted:${pack.retracted.offerId || street}` };
  }
  return send;
}

/**
 * checkInWait(ledger, { lastInboundAt, now }) → { until, why, permanent } | null
 *
 * The newest `checkin_skipped` still standing: written after their last word,
 * and its date not reached (a homeowner's never ends). A word from them since
 * lifts it; the next check-in reads the thread again.
 */
export function checkInWait(ledger = [], { lastInboundAt = null, now = Date.now() } = {}) {
  const since = ms(lastInboundAt);
  let best = null;
  for (const e of ledger || []) {
    if (e?.type !== "checkin_skipped") continue;
    const at = ms(e.at);
    if (at == null || (since != null && at <= since)) continue;
    const why = String(e.data?.why || "the check-in waits").slice(0, 160);
    if (e.data?.permanent) return { until: null, why, permanent: true };
    const until = ms(e.data?.until);
    if (until == null || until <= now) continue;
    if (!best || until > ms(best.until)) best = { until: iso(until), why, permanent: false };
  }
  return best;
}

/* ---------- the fixed texts: one that repeats nothing ---------- */

const plainOf = (s) => String(s || "").toLowerCase().replace(/^\s*(?:hi|hey|hello)\b[\s,]*/, "").replace(/[^a-z0-9]+/g, " ").trim();
const textOf = (p) => (typeof p === "string" ? p : String(p?.text || ""));

/**
 * spentGroups(prior, now) → the ONCE_GROUPS our last three texts (this month) used.
 */
export function spentGroups(prior = [], now = Date.now()) {
  const recent = (prior || []).slice(0, ONCE_LAST).filter((p) => {
    const at = ms(typeof p === "string" ? null : p?.at);
    return at == null || now - at <= ONCE_DAYS * DAY_MS;
  });
  return new Set(recent.flatMap((p) => groupsOf(textOf(p))));
}

/**
 * repeatsAny(text, prior) → "" | why
 *
 * shared/voice.js repeatsUs over our last six, and the same words as any
 * text further back than that.
 */
export function repeatsAny(text = "", prior = []) {
  const list = (prior || []).filter((p) => textOf(p).trim());
  const near = repeatsUs(text, list.slice(0, PRIOR_MAX));
  if (near) return near;
  const body = plainOf(text);
  return list.slice(PRIOR_MAX).some((p) => plainOf(textOf(p)) === body) ? "the same text we already sent them" : "";
}

/**
 * pickVariant(pool, prior, seed, touch, { fill, noRepeat, now }) → { text, index, template } | null
 *
 * Which fixed text a check-in says. It starts at (openerVariant(seed, n) +
 * touch) % n, where `touch` is this person's own count of that check-in (never
 * their place in today's run), and walks past any text that repeats one of
 * ours (`prior`, newest first) or spends a "once" phrase one of our last
 * three used. `fill` turns a template into the text ("" when it can't be
 * filled). With nothing left that passes, the first one that fills, for the
 * voice gate to hold; null when none fills.
 */
export function pickVariant(pool = [], prior = [], seed = "", touch = 0, { fill = (t) => t, noRepeat = true, now = Date.now() } = {}) {
  const n = (pool || []).length;
  if (!n) return null;
  const base = typeof seed === "number" ? Math.abs(Math.round(seed)) : openerVariant(seed, n);
  const start = (base + Math.max(0, Math.round(Number(touch) || 0))) % n;
  const spent = noRepeat ? spentGroups(prior, now) : new Set();
  let first = null;
  for (let i = 0; i < n; i++) {
    const index = (start + i) % n;
    const text = fill(pool[index]);
    if (!text) continue;
    const pick = { text, index, template: pool[index] };
    if (!first) first = pick;
    if (!noRepeat) return pick;
    if (repeatsAny(text, prior)) continue;
    if (groupsOf(text).some((g) => spent.has(g))) continue;
    return pick;
  }
  return first;
}

/* ---------- they asked whether this is a bot ---------- */

export const BOT_ASK_REASON = "they asked if this is a bot";
export const BOT_ASK_FLAG = `${BOT_ASK_REASON}: yours to answer in your own words, the bot never does`;
// What else in the same text would make it an opt-out after all. Wide on
// purpose: this only decides whether the model's own opt-out read stands, so
// anything past the bare question leaves it standing.
const LEAVE_ALONE_RX = /\b(?:stop|remove|unsubscribe|leave\s+(?:me|us)\s+alone|lose\s+(?:my|this)\s+number|take\s+me\s+off|wrong\s+number|no\s+more|do\s*n[o']?t\s+(?:text|contact|message|call)|quit\s+(?:texting|messaging)|not\s+interested|go\s+away|(?:f+|fuck|piss|back|buzz)\s*off|f\W{0,3}k\s+off|harass\w*|spam(?:ming|mer)?|block(?:ed|ing)?|report(?:ed|ing)?)\b/i;

/** asksIfBot(text) → true when they ask whether this is a bot or AI, or say it sounds like one. */
export const asksIfBot = (text = "") => AI_COMPLAINT_RX.test(String(text || ""));

/**
 * onlyAsksIfBot(text) → true when the text asks whether this is a bot and
 * says nothing that would make it an opt-out ("are you a bot?", "is this AI
 * lol"). The model reading one of these as an opt-out is overruled: it is a
 * question for Matt, never a reason to tag them do-not-text.
 */
export function onlyAsksIfBot(text = "") {
  const t = String(text || "").replace(/[’‘]/g, "'");
  if (!AI_COMPLAINT_RX.test(t)) return false;
  return !LEAVE_ALONE_RX.test(t.replace(AI_COMPLAINT_RX, " "));
}

/** botAskFlags({ asked }) → the gate's hold for a reply to "are you a bot?". */
export const botAskFlags = ({ asked = false } = {}) => (asked ? [BOT_ASK_FLAG] : []);

/* ---------- the name they go by ---------- */

const NOT_A_NAME = new Set(["thanks", "thank", "thx", "ty", "best", "cheers", "regards", "sincerely", "sent", "sorry", "ok", "okay", "yes", "yep",
  "no", "nope", "sure", "great", "perfect", "sounds", "cool", "awesome", "later", "talk", "soon", "back", "anytime", "tomorrow", "today", "tonight",
  "asap", "when", "then", "now", "please", "pls", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "realtor", "broker",
  "agent", "team", "the", "and", "matt", "matthew", "maybe", "again", "first", "after", "before", "directly", "instead", "here",
  "if", "whenever", "sometime", "this", "next", "around", "about", "quick", "my", "at", "on", "in", "or", "so"]);
const nameWord = (w) => {
  const s = String(w || "").trim();
  if (!/^[A-Z][a-z'’-]{1,14}$/.test(s)) return "";
  return NOT_A_NAME.has(s.toLowerCase()) ? "" : s;
};
// "Call me Kate" opens a sentence as often as not: the verbs take either case,
// the name must be capitalised.
const CALL_ME_RX = /\b(?:[Pp]lease\s+)?(?:[Cc]all|[Tt]ext)\s+me\s+([A-Z][a-z'’-]{1,14})\b(?!\s+(?:at|on|back|tomorrow|later|when))|\b(?:I|i)\s+go\s+by\s+([A-Z][a-z'’-]{1,14})\b|\b(?:[Gg]oes|[Gg]o)\s+by\s+([A-Z][a-z'’-]{1,14})\s*(?:[.!,]|$)/;
// Their name alone on the text's last line, or after a dash or a tilde.
const SIGN_OFF_RX = /(?:\n\s*|\s[-–—~]\s*|^[-–—~]\s*|\s~)([A-Z][a-z'’-]{1,14})\s*[.!]?\s*$/;

/**
 * goesBySaid(text, { first, ours }) → the name they go by | ""
 *
 * "call me Kate", "I go by Kate", or a text signed with a short form of their
 * GHL first name ("…\nKate" from Katherine: shorter, and the same first two
 * letters, not the same name). Never our own name: "Thanks, Matt" is them
 * talking to us. A town after a dash ("- Kirkland.") or a teammate signing
 * from her phone ("Kevin" on Kristin's) is not a short form of hers.
 */
export function goesBySaid(text = "", { first = "", ours = "" } = {}) {
  const t = String(text || "").replace(/[’‘]/g, "'").trim();
  if (!t) return "";
  const me = String(ours || "").trim().split(/\s+/)[0].toLowerCase();
  const own = String(first || "").trim();
  const ok = (n) => n && n.toLowerCase() !== me && n.toLowerCase() !== own.toLowerCase() ? n : "";
  const said = CALL_ME_RX.exec(t);
  const named = said ? nameWord(said[1] || said[2] || said[3]) : "";
  if (named) return ok(named);
  if (!own) return "";
  const signed = SIGN_OFF_RX.exec(t);
  const sig = signed ? nameWord(signed[1]) : "";
  if (!sig || sig.length >= own.length || sig.slice(0, 2).toLowerCase() !== own.slice(0, 2).toLowerCase()) return "";
  return ok(sig);
}

/** goesByOf(facts) → the newest goes_by on the contact record | "". */
export function goesByOf(facts = {}) {
  const list = Array.isArray(facts?.goes_by) ? facts.goes_by : [];
  const newest = [...list].sort((a, b) => String(a?.at || "").localeCompare(String(b?.at || ""))).at(-1);
  return String(newest?.value || "").trim();
}

/* ---------- the one real thing (the composer) ---------- */
//
// Matt, 2026-11-09: "check-ins need to sound more personable and not AI".
// Agents answered the model's one-off texts 55.4% of the time and the fixed
// ones 27.9%; 1,845 details they had shared sat unused. So a check-in may be
// written around ONE real thing they gave us. And the same night (~22:05):
// "make sure the checkins dont reference past properties, that gets
// confusing and annoying too". The one thing is never a house: no address,
// no street, no "the place you called about", no listing we texted about, no
// passed house, no old offer, no deal we did together (not even by town),
// and for a buyer no deal we sent them. It is their own words about their
// market or plans, a detail they shared, a question they asked us, the topic
// of a call, or a lead they said is coming ("any word on the one you said
// was coming up?"). With nothing like that, the check-in waits.

// conversationAi.checkIns, the composer's keys. `composer` is new automation
// and ships "off"; "shadow" writes the model's check-in beside the fixed one
// and sends only the fixed one; "on" lets the model write it for the share
// of contacts in `composerShare` (by contact id, so an agent stays in one
// arm), the rest the control. `skipEmpty` (with the composer on only): a
// check-in with nothing real to name waits `skipDays` instead of sending a
// general line. `personal`: a detail they shared may be the one thing.
export const CHECK_IN_COMPOSER_DEFAULTS = Object.freeze({ composer: "off", composerShare: 100, skipEmpty: true, skipDays: 14, personal: true });
export const COMPOSER_MODES = Object.freeze(["off", "shadow", "on"]);
export function normalizeCheckInComposer(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const D = CHECK_IN_COMPOSER_DEFAULTS;
  const bool = (x, d) => (x == null ? d : x === true || x === "true" || x === 1 || x === "1");
  return {
    composer: COMPOSER_MODES.includes(o.composer) ? o.composer : D.composer,
    composerShare: clamp(o.composerShare, D.composerShare, 0, 100),
    skipEmpty: bool(o.skipEmpty, D.skipEmpty),
    skipDays: clamp(o.skipDays, D.skipDays, 7, 60),
    personal: bool(o.personal, D.personal),
  };
}

// How long each kind of thing stays news. Something from June never reads as
// new in November: past these, it isn't the one thing.
export const CALL_HOOK_DAYS = 45;
export const QUESTION_HOOK_DAYS = 30;
export const WORDS_HOOK_DAYS = 45;
export const PERSONAL_HOOK_DAYS = 60;
export const SUMMARY_FACT_DAYS = 60;
// An undated lead ("I may have one coming up"): asked about at the next
// regular check-in, never sooner than LEAD_WAIT_DAYS after they said it, and
// dropped after LEAD_HOOK_DAYS.
export const LEAD_HOOK_DAYS = 60;
export const LEAD_WAIT_DAYS = 14;
// An investor's own words from their read (shared/investor-read.js quotes).
export const QUOTE_HOOK_DAYS = 180;

/* -- a house, from before -- */

// "1412 Pine", "88 NE 12th": a house number in front of a name.
const NUMBERED_RX = /\b\d{2,6}\s+(?:[NSEW]{1,2}\.?\s+)?(?:[A-Z][a-z'’-]+|\d{1,3}(?:st|nd|rd|th))\b/;
// A pointer to one from before: "the place you called about", "the house we
// sent you", "the deal we did", "that last one".
const HOUSE_HINT_RX = /\b(?:the|that|this|your|our)\s+(?:last\s+|old\s+|other\s+)?(?:place|house|home|property|listing|deal|lot)\s+(?:(?:you|we|i)\s+(?:called|texted|talked|asked|wrote|emailed|sent|mentioned|passed|priced|offered|looked|closed|did|bought|showed|listed|posted|had|sold))\b|\bthat\s+last\s+one\b|\b(?:the|that)\s+(?:last\s+)?one\s+(?:you|we|i)\s+(?:called|texted|emailed|sent|passed|priced|offered|closed|did|bought|showed|listed|had|sold)\b/i;
// "the house on Oak", "the one on 5th": case matters (on the market isn't a street).
// Not a day or a month ("one on Monday").
const HOUSE_ON_RX = /\b(?:house|place|home|property|listing|lot|one)\s+(?:over\s+)?on\s+(?!(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|(?:January|February|March|April|May|June|July|August|September|October|November|December)\b)(?:[A-Z][a-z'’-]+|\d{1,3}(?:st|nd|rd|th))\b/;

/**
 * namesAHouse(text) → the words that name one | ""
 *
 * Whether a text names or points at a house: a street ("Elm St", "5th Ave
 * in Kent"), a house number before a name ("1412 Pine"), or a pointer to
 * one from before ("the place you called about", "the house on Oak", "the
 * deal we did together"). A town alone is not a house: "anything around
 * Kentwood?" is fine. A check-in that names one is held (checkInFlags).
 */
export function namesAHouse(text = "") {
  const t = String(text || "").replace(/[’‘]/g, "'");
  if (!t.trim()) return "";
  const st = streetMentions(t)[0]?.address;
  if (st) return st;
  const m = NUMBERED_RX.exec(t) || HOUSE_HINT_RX.exec(t) || HOUSE_ON_RX.exec(t);
  return m ? m[0].trim() : "";
}

// "163rd" of "11435 163rd Avenue Southeast"; never a direction.
const DIRECTION_WORD_RX = /^(?:n|s|e|w|ne|nw|se|sw|north|south|east|west|northeast|northwest|southeast|southwest)\.?$/i;
/**
 * namesBookHouse(text, addresses) → the words that name one of them | ""
 *
 * Whether a text names a house we've had with them by its number or its
 * street's own word ("1412", "Tamsin", "163rd"), without the suffix
 * namesAHouse needs. A street word that is also a town ("Auburn" of Auburn
 * Way) is their area, not the house; a word is matched as the street
 * writes it, so "the main thing" is never Main St. A town of more than one
 * word, and the town each house is in, are read as towns first: "anything
 * around Lake Stevens?" never names a house on Lake Something Rd (the cold
 * ladder names the town of the listing we first texted about).
 */
const TOWN_PHRASES = Object.keys(WA_CITY_COORDS).filter((k) => k.includes("-")).map((k) => k.split("-"));
export function namesBookHouse(text = "", addresses = []) {
  if (!String(text || "").trim()) return "";
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownTowns = (addresses || []).map((a) => String(parseUsAddress(String(a || "")).city || "").trim().split(/[\s-]+/).filter(Boolean)).filter((w) => w.length);
  let t = String(text || "");
  for (const words of [...TOWN_PHRASES, ...ownTowns]) t = t.replace(new RegExp(`\\b${words.map(esc).join("[\\s-]+")}\\b`, "gi"), " ");
  for (const a of addresses || []) {
    const { houseNo, street } = parseUsAddress(String(a || ""));
    if (houseNo && houseNo.length >= 3 && new RegExp(`\\b${esc(houseNo)}\\b`).test(t)) return houseNo;
    const core = String(street || "").split(/\s+/).find((w) => w && !DIRECTION_WORD_RX.test(w)) || "";
    if (core.length < 3) continue;
    if (/^\d/.test(core)) { if (new RegExp(`\\b${esc(core)}\\b`, "i").test(t)) return core; continue; }
    const word = core.charAt(0).toUpperCase() + core.slice(1).toLowerCase();
    if (WA_CITY_COORDS[word.toLowerCase()]) continue;
    if (new RegExp(`\\b${esc(word)}\\b`).test(t)) return word;
  }
  return "";
}

// The sentences of a text that name no house: a call's topic, never its house.
const sentencesOf = (s) => String(s || "").replace(/\s+/g, " ").split(/(?<=[.?!;])\s+/).map((x) => x.trim()).filter(Boolean);
export const withoutHouses = (text = "") => sentencesOf(text).filter((x) => !namesAHouse(x)).join(" ");

// A personal detail about someone else's life (their seller's divorce, a
// client's move, a tenant) is never the warm line; nor anything sensitive.
const SOMEONE_ELSE_RX = /\b(?:sellers?|clients?|tenants?|buyers?|(?:home)?owners?|landlords?|heirs?|renters?)\b/i;
// "ok", "thanks", "sounds good": nothing to pick up.
const ACK_RX = /^\s*(?:ok(?:ay)?|k|kk|thanks?(?: you)?|thx|ty|sounds good|got it|will do|yes|yep|yeah|yup|sure|no problem|np|cool|great|perfect|nice|awesome|you too|same to you|appreciate (?:it|you))\b[\s.!,]*(?:thanks?|thank you|matt)?[\s.!]*$/i;
// A proper noun past the start of a sentence: the word a check-in about it
// would say ("the Maui trip" → Maui). Not a month, a day or a name of ours.
const NOT_AN_ANCHOR = new Set(["i", "matt", "mls", "ok", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "thanks", "hi", "hey", "zillow", "redfin",
  "christmas", "thanksgiving", "easter", "realtor", "ai"]);
export function anchorOf(text = "", { skip = [] } = {}) {
  const no = new Set([...NOT_AN_ANCHOR, ...(skip || []).map((x) => String(x || "").toLowerCase()).filter(Boolean)]);
  for (const s of sentencesOf(text)) {
    const words = s.split(/\s+/).map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z'’]+$/g, "")).filter(Boolean);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/['’]s$/, "");
      if (/^[A-Z][a-z]{2,}$/.test(w) && !no.has(w.toLowerCase())) return w;
    }
  }
  return "";
}

const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const keyOf = (kind, at, text = "") => `${kind}:${String(at || "").slice(0, 10)}${text ? `:${clip(text, 24).toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}`;

/**
 * oneThings({ lines, theirLast, ourLast, subject, context, now }) → the
 * composer's part of the pack: each thing dated, none naming a house, and
 * `hooks`, ranked; hooks[0] is THE ONE THING.
 *
 *   agents     lead › question › call › their words › personal › their old no
 *   investors  their words (deal talk) › their quotes › where they bought › personal
 *
 * `context.spent`: hook keys one of our check-ins already used (the texted
 * events' checkIn.key), never used twice. `context.newerThan`: only what is
 * newer than that (the weekly deal-source check-in: something new since
 * last week, or nothing).
 */
function oneThings({ lines = [], theirLast = null, ourLast = [], subject = {}, context = {}, now = Date.now() } = {}) {
  const party = context.party === "investor" ? "investor" : "agent";
  const c = normalizeCheckInComposer(context.composer || { personal: context.personal });
  const s = normalizeCheckInRoute(context);
  const spent = new Set(context.spent || []);
  const newer = ms(context.newerThan);
  const daysAgo = (at) => Math.max(0, Math.floor((now - (ms(at) ?? now)) / DAY_MS));
  const within = (at, days) => { const t = ms(at); return t != null && t <= now + HOUR_MS && now - t <= days * DAY_MS; };
  const skipNames = [String(subject?.first || ""), String(context.first || "")];

  // Their last words, worth picking up: a person, not a no, not "are you a
  // bot?", not an "ok", and no house in it.
  let question = null;
  let theirWords = null;
  const lastWords = lines.filter((l) => (l.channel === "sms" || l.channel === "email") && l.text && !isTapback(l.text)).at(-1) || null;
  const t = theirLast;
  if (t && !["no", "auto", "ai_complaint", "house"].includes(t.read) && !namesAHouse(t.text) && !ACK_RX.test(t.text) && t.text.length >= 12) {
    if (t.read === "question" && lastWords?.who === "THEM" && within(t.at, QUESTION_HOOK_DAYS)) {
      question = { text: clip(t.text, 240), at: t.at, daysAgo: daysAgo(t.at) };
    } else if (within(t.at, WORDS_HOOK_DAYS)) {
      theirWords = { text: clip(t.text, 240), at: t.at, daysAgo: daysAgo(t.at), channel: t.channel || "sms" };
    }
  }
  const theirNo = t?.read === "no" && t.daysAgo >= s.afterNoDays ? { text: clip(t.text, 120), at: t.at, daysAgo: t.daysAgo } : null;

  // The newest call we really had, by its topic: the sentences of its
  // summary that name no house.
  let call = null;
  const calls = [...(context.calls || [])].filter((e) => e && (!e.type || e.type === "call_summary"))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  for (const e of calls) {
    const d = e.data || {};
    if (!within(e.at, CALL_HOOK_DAYS)) break;
    if (d.transcribed === false || d.missed || d.tooShort) continue;
    const topic = withoutHouses(String(d.summary || "").replace(/^\(.*\)$/, ""));
    if (topic.length >= 12) { call = { line: clip(topic, 240), at: e.at, daysAgo: daysAgo(e.at) }; break; }
  }

  // A lead they said is coming: the undated one the agent check-in carries
  // (shared/agent-pulse.js agentPulseSubject), or the one a dated check-in
  // is about. Never its address.
  let lead = null;
  const L = subject?.lead || context.lead || null;
  if (L) {
    const at = L.at || L.toldAt || null;
    const fresh = L.undated ? within(at, LEAD_HOOK_DAYS) : true;
    const what = namesAHouse(L.what) ? "" : clip(L.what, 80);
    const said = namesAHouse(L.said) ? "" : clip(L.said, 200);
    if (fresh) lead = { what, said, at, daysAgo: at ? daysAgo(at) : null, undated: Boolean(L.undated) };
  }

  // A detail they shared about themselves, under 60 days old, nothing
  // sensitive and nothing about someone else (a seller's surgery is never
  // a check-in's warm line).
  let personal = null;
  if (c.personal) {
    const list = [...(context.facts?.personal_details || [])].sort((a, b) => String(b?.at || "").localeCompare(String(a?.at || "")));
    for (const f of list) {
      const v = clip(f?.value, 160);
      if (!v || !within(f?.at, PERSONAL_HOOK_DAYS)) continue;
      if (SENSITIVE_RX.test(v) || SOMEONE_ELSE_RX.test(v) || namesAHouse(v)) continue;
      personal = { what: v, at: f.at, daysAgo: daysAgo(f.at) };
      break;
    }
  }
  // Background, dated: what we last talked about (only when it's recent) and
  // the areas they work.
  const sum = [...(context.facts?.last_convo_summary || [])].sort((a, b) => String(b?.at || "").localeCompare(String(a?.at || "")))[0];
  const lastSummary = sum && within(sum.at, SUMMARY_FACT_DAYS) && !namesAHouse(sum.value) ? { text: clip(sum.value, 200), daysAgo: daysAgo(sum.at) } : null;
  const areas = [...new Set((context.facts?.agent_market_area || []).map((f) => clip(f?.value, 40)).filter(Boolean))].slice(0, 3);

  // An investor's own words from their read, newest first, under six months.
  const quotes = party === "investor"
    ? [...(context.quotes || [])].filter((q) => q?.text && within(q.at, QUOTE_HOOK_DAYS) && !namesAHouse(q.text))
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 2)
      .map((q) => ({ text: clip(q.text, 200), at: q.at, daysAgo: daysAgo(q.at) }))
    : [];
  const buyCity = party === "investor" ? clip(subject?.lastBuyCity, 40) : "";

  const hooks = [];
  const add = (h) => {
    if (!h) return;
    if (spent.has(h.key)) return;
    if (newer != null && h.kind !== "lead" && (ms(h.at) ?? 0) <= newer) return;
    hooks.push(h);
  };
  const dayWord = (n) => (n == null ? "a while back" : n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`);
  const words = theirWords && { kind: party === "investor" ? "deal_talk" : "their_words", key: keyOf("their_words", theirWords.at), at: theirWords.at, daysAgo: theirWords.daysAgo,
    line: `what they told us ${dayWord(theirWords.daysAgo)}, in their words: "${theirWords.text}"`, anchor: anchorOf(theirWords.text, { skip: skipNames }), from: theirWords.channel === "email" ? "their email" : "their text" };
  const personalHook = personal && { kind: "personal", key: keyOf("personal", personal.at, personal.what), at: personal.at, daysAgo: personal.daysAgo,
    line: `something they told us about themselves ${dayWord(personal.daysAgo)}: ${personal.what}`, anchor: anchorOf(personal.what, { skip: skipNames }), from: "our notes" };
  if (party === "agent") {
    if (lead) add({ kind: "lead", key: keyOf("lead", lead.at), at: lead.at, daysAgo: lead.daysAgo,
      line: `they told us ${dayWord(lead.daysAgo)} that one might be coming up${lead.what ? ` (${lead.what})` : ""}. Ask about it without any address or street: "any word on the one you said was coming up?"`,
      anchor: "", from: "their text" });
    if (question) add({ kind: "question", key: keyOf("question", question.at), at: question.at, daysAgo: question.daysAgo,
      line: `they asked us ${dayWord(question.daysAgo)} and never got a real answer: "${question.text}"`, anchor: "", from: "their text" });
    if (call) add({ kind: "call", key: keyOf("call", call.at), at: call.at, daysAgo: call.daysAgo,
      line: `on a call ${dayWord(call.daysAgo)}: ${call.line}`, anchor: anchorOf(call.line, { skip: skipNames }), from: "a call" });
    add(words);
    add(personalHook);
    if (theirNo) add({ kind: "their_no", key: keyOf("their_no", theirNo.at), at: theirNo.at, daysAgo: theirNo.daysAgo,
      line: `${dayWord(theirNo.daysAgo)} they told us nothing was in the works`, anchor: "", from: "their text" });
  } else {
    add(words);
    for (const q of quotes) add({ kind: "quotes", key: keyOf("quotes", q.at, q.text), at: q.at, daysAgo: q.daysAgo,
      line: `in their own words, ${dayWord(q.daysAgo)}: "${q.text}"`, anchor: anchorOf(q.text, { skip: skipNames }), from: "their read" });
    if (buyCity) add({ kind: "purchase_city", key: `purchase_city:${buyCity.toLowerCase()}`, at: null, daysAgo: null,
      line: `public records show they bought around ${buyCity} lately: name the town as where they buy, never the house`, anchor: buyCity, from: "public records" });
    add(personalHook);
  }
  return { lead, question, call, theirWords, personal, theirNo, quotes, buyCity, areas, lastSummary, hooks };
}

/* -- which check-ins the composer writes -- */

const LISTING_PULSE_REASONS = new Set(["fresh_listing", "off_market_listing"]);
/**
 * composes(kind, { sourceKind, reason, forMatt }) → whether the composer
 * writes this check-in: the agent check-in (not a fresh listing of theirs,
 * which is the listing ping, nor the thank-you after a close, nor Matt's 15),
 * the check-ins they asked for (not the net under a text of theirs we never
 * answered, which picks their own words back up), and the buyer pulse.
 */
export function composes(kind = "", { sourceKind = "", reason = "", forMatt = false } = {}) {
  if (kind === "agent_pulse") return !forMatt && !LISTING_PULSE_REASONS.has(reason) && reason !== "deal_thanks";
  if (kind === "checkin_due") return sourceKind !== "unanswered";
  return kind === "buyer_pulse";
}

/**
 * strictNoHouse(kind, outbound) → true for a check-in that may never name a
 * house, a street or an address from before (Matt, 2026-11-09 ~22:05): the
 * agent check-in (but the listing ping about a listing they just posted),
 * the check-ins they asked for (but the one picking up a text of theirs we
 * never answered), the buyer pulse, a check-in after a house we passed on
 * (but one back on the market), and the cold ladder's rungs past day 2.
 */
export function strictNoHouse(kind = "", outbound = {}) {
  const o = outbound || {};
  if (kind === "agent_pulse") return !LISTING_PULSE_REASONS.has(o.reason) && !o.listing?.focus;
  if (kind === "checkin_due") return o.sourceKind !== "unanswered";
  if (kind === "buyer_pulse") return true;
  if (kind === "passed_checkin") return !o.relisted;
  if (kind === "outreach_nudge") return Boolean(o.repeats) && !Number(o.stepIndex);
  return false;
}

/** composerArm(contactId, share) → "model" for the share of contacts the model writes for, "control" for the rest. */
export const composerArm = (contactId = "", share = 100) => (openerVariant(String(contactId || ""), 100) < clamp(share, 100, 0, 100) ? "model" : "control");

/**
 * composeRoute({ pack, kind, sourceKind, reason, forMatt, settings, contactId, now }) → { mode, arm, hook, why?, until? }
 *
 *   off       the composer is off, or this check-in isn't one it writes: as today
 *   shadow    today's text goes; the model's is written beside it, unsent
 *   control   the contact is in the control arm: today's text, stamped
 *   model     the model writes it from hooks[0] (a dated check-in they asked
 *             for is written whether or not there's a hook)
 *   fallback  the model's arm with nothing to name and skipEmpty off: today's text
 *   skip      the model's arm with nothing to name: waits `skipDays` (a week
 *             for the weekly deal-source check-in), never on the Desk
 *
 * `settings` is conversationAi.checkIns.
 */
export function composeRoute({ pack = {}, kind = "", sourceKind = "", reason = "", forMatt = false, settings = {}, contactId = "", now = Date.now() } = {}) {
  const s = normalizeCheckInComposer(settings);
  if (s.composer === "off" || !composes(kind, { sourceKind, reason, forMatt })) return { mode: "off" };
  const hook = (pack?.hooks || [])[0] || null;
  const critical = isCriticalCheckIn(kind, sourceKind);
  if (s.composer === "shadow") return { mode: "shadow", arm: "shadow", hook, critical };
  const arm = composerArm(contactId, s.composerShare);
  if (arm === "control") return { mode: "control", arm, hook, critical };
  if (hook || (kind === "checkin_due" && critical)) return { mode: "model", arm, hook, critical };
  if (s.skipEmpty && !critical) {
    const days = kind === "checkin_due" && sourceKind === "source" ? 7 : s.skipDays;
    return { mode: "skip", arm, hook: null, critical, why: sourceKind === "source" ? "nothing new since last week's check-in" : "nothing real to say", until: iso(now + days * DAY_MS) };
  }
  return { mode: "fallback", arm, hook: null, critical };
}

/** checkInStamp(route) → what the draft and its texted event carry: the arm, the hook and where the detail came from. */
export function checkInStamp(route = {}) {
  if (!route || route.mode === "off" || !route.arm) return null;
  const h = route.hook || null;
  return { arm: route.arm, hook: h?.kind || null, detailKind: h?.from || null, key: h?.key || null };
}

/**
 * openingIndex({ touch, contactId, ourLast }) → 0 | 1 | 2
 *
 * Which way the model opens (ghl-broker/conversation-prompt.js OPENINGS):
 * on the thing, on their name and the thing, or on the question. By the
 * contact's own count of check-ins, and never the shape our last text had
 * (two texts running that open on their name read like a mail merge).
 */
export function openingIndex({ touch = 0, contactId = "", ourLast = [] } = {}) {
  let i = (openerVariant(String(contactId || ""), 3) + Math.max(0, Math.round(Number(touch) || 0))) % 3;
  const last = String((ourLast || [])[0]?.text ?? (ourLast || [])[0] ?? "");
  const onName = /^\s*(?:hi |hey |hello )?[A-Z][a-z'’-]+,/.test(last);
  if (onName && i === 1) i = 2;
  return i;
}

/** nothingToSay(draft) → true when the model declined: no text, and "nothing real (or new) to say". */
export const nothingToSay = (draft) => !String(draft?.reply || "").trim() && /\bnothing (?:real|new) to say\b/i.test(String(draft?.humanReason || ""));

// How Matt sounds checking in, for the composed prompt (ghl-broker/
// conversation-prompt.js CHECKIN_VOICE): invented lines in the shape his own
// answered texts take, never a real thread's words, and none names a house.
// The voice, never the words: a check-in that copies one is held.
// One question each: the voice check holds two (shared/voice.js), so an
// example with two would teach the model a shape that never sends.
export const CHECK_IN_VOICE_EXAMPLES = Object.freeze([
  "hope the trip was a good one. anything new come up while you were out?",
  "you said spring is when your sellers start moving. seeing any of that yet?",
  "sounds like the new team has you slammed. anything rough land on your end lately?",
  "any word on the one you said was coming up?",
  "how's Kentwood treating you this fall, any older ones sitting that the sellers are tired of?",
]);
export const BUYER_VOICE_EXAMPLES = Object.freeze([
  "got you down for heavy rehab flips around Kentwood. still right?",
  "you said you were done with rentals for a while. still the case, or open to one again?",
  "still looking north of the lake, or has that moved?",
]);

/**
 * checkInFlags({ text, hook }) → [flag]
 *
 * A check-in that names a house from before is held: any street, address or
 * pointer to one (namesAHouse), even a deal we closed together (Matt,
 * 2026-11-09). A model check-in written around a hook with a plain anchor
 * word (their town, the trip) has to say it; otherwise it isn't about the
 * one thing. runProactive writes it once more, then drops it.
 */
export function checkInFlags({ text = "", hook = null } = {}) {
  const out = [];
  const house = namesAHouse(text);
  if (house) out.push(`named a house (${clip(house, 40)}): a check-in never names a house, a street or an address from before`);
  const a = String(hook?.anchor || "").trim();
  if (a && String(text || "").trim() && !new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(String(text))) {
    out.push(`doesn't say the one thing (${a}): name it, or leave the text empty`);
  }
  // A voice example said back word for word (the lead line is the one we mean them to use).
  // (The same words or the same sentence; opening alike is fine.)
  const copied = [...CHECK_IN_VOICE_EXAMPLES, ...BUYER_VOICE_EXAMPLES].filter((x) => !/said was coming up/.test(x));
  const copies = (list) => { const r = repeatsUs(text, list); return r && !/^opens like/.test(r) ? r : ""; };
  if (hook && String(text || "").trim() && (copies(copied.slice(0, PRIOR_MAX)) || copies(copied.slice(PRIOR_MAX)))) {
    out.push("copied a voice example: say it in its own words");
  }
  return out;
}

/**
 * spentHookKeys(events) → the one things our check-ins already said
 *
 * From agent_pulse_texted and pulse_texted rows: only a text the model wrote
 * around its hook said it. The shadow's text never went, and the control's
 * was today's fixed line, so the hook stamped on those is still unused.
 */
export function spentHookKeys(events = []) {
  return (events || []).filter((e) => (e?.type === "agent_pulse_texted" || e?.type === "pulse_texted") && e.data?.checkIn?.arm === "model" && e.data.checkIn.key)
    .map((e) => String(e.data.checkIn.key));
}

/**
 * checkInReport(events, { days, now }) → { days, arms, hooks, skips }
 *
 * What the check-ins did: per arm (model, control, shadow, and "none" for
 * the ones before the composer), how many went, how many got a reply within
 * a week and how many an opt-out; per hook kind the same, for the texts
 * the model wrote around it (a control or shadow text carries the hook it
 * could have used, but never said it); and why the ones that waited,
 * waited. `events` are agent_pulse_texted, pulse_texted, checkin_skipped,
 * text_summary and unsubscribed rows. Counts only.
 */
export const CHECK_IN_REPORT_TYPES = Object.freeze(["agent_pulse_texted", "pulse_texted", "checkin_skipped", "text_summary", "unsubscribed"]);
export function checkInReport(events = [], { days = 30, now = Date.now() } = {}) {
  const since = now - Math.max(1, Number(days) || 30) * DAY_MS;
  const replies = new Map();
  const stops = new Map();
  for (const e of events || []) {
    if (!e?.contactId) continue;
    if (e.type === "text_summary" && e.data?.inbound) (replies.get(e.contactId) || replies.set(e.contactId, []).get(e.contactId)).push(ms(e.at) ?? 0);
    if (e.type === "unsubscribed") (stops.get(e.contactId) || stops.set(e.contactId, []).get(e.contactId)).push(ms(e.at) ?? 0);
  }
  const after = (map, id, t) => (map.get(id) || []).some((x) => x > t && x - t <= 7 * DAY_MS);
  const arms = {};
  const hooks = {};
  const skips = {};
  const bump = (o, k, f) => { o[k] ||= { sent: 0, replied: 0, stops: 0 }; o[k][f]++; };
  for (const e of events || []) {
    const t = ms(e?.at);
    if (t == null || t < since || t > now) continue;
    if (e.type === "checkin_skipped") { const w = clip(e.data?.why, 60) || "waited"; skips[w] = (skips[w] || 0) + 1; continue; }
    if (e.type !== "agent_pulse_texted" && e.type !== "pulse_texted") continue;
    const ci = e.data?.checkIn || null;
    const arm = ci?.arm || "none";
    const hook = arm !== "model" ? "" : ci?.hook || "none";
    bump(arms, arm, "sent");
    if (hook) bump(hooks, hook, "sent");
    if (after(replies, e.contactId, t)) { arms[arm].replied++; if (hook) hooks[hook].replied++; }
    if (after(stops, e.contactId, t)) { arms[arm].stops++; if (hook) hooks[hook].stops++; }
  }
  const rate = (o) => { for (const v of Object.values(o)) v.replyRate = v.sent ? Math.round((v.replied / v.sent) * 1000) / 10 : 0; return o; };
  return { days: Math.max(1, Number(days) || 30), arms: rate(arms), hooks: rate(hooks), skips };
}
