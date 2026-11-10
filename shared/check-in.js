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
// Pure. ghl-broker/reply-agent.js runProactive routes; shared/agent-pulse.js
// evaluateAgent waits; shared/standard-texts.js picks.

import { repeatsUs, groupsOf, ourLastTexts, AI_COMPLAINT_RX, ONCE_LAST, ONCE_DAYS, PRIOR_MAX } from "./voice.js";
import { isTapback, isAutoReply, cadenceRequest, ourCheckBack } from "./brush-offs.js";
import { checkInRequested, detectLeadTiming } from "./follow-up.js";
import { isPlainNo } from "./conversation-audit.js";
import { openerVariant } from "./outreach-opener.js";

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
 * `context`: { offers (this contact's), agentTagged, repeatTouches, aiComplaintDays }.
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

  return { theirLast, laterUntil, ourLast, autoOnly, autoAt, aiComplaint, homeowner, retracted, subjectKind: subject?.kind || null };
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
