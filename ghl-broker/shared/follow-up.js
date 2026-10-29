// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// follow-up.js — the clock. Which nudge is due on a conversation nobody
// answered, and when we stop.
//
// Until this existed the Conversation AI only ever spoke when spoken to (or
// when an underwrite landed). An offer sent five days ago with no reply just
// sat there, and `no_response` was a thing you typed by hand.
//
// One ladder per kind of silence: an offer the agent never answered, a cold
// agent who never wrote back, a pass worth checking on — and on the buyer
// side, ONE follow-up to a buyer who said something about a deal and went
// quiet. Each is a list of DAYS SINCE THE TRIGGER —
// absolute offsets, not gaps between touches. That matters twice: an operator
// can reason about "day 3, day 7, day 14" without doing arithmetic, and a
// sweep that missed a day still fires the day-7 step, once, rather than
// catching up by sending three texts in a row.
//
// Pure. No I/O, no clock of its own — `now` is always passed in.

import { paceScale } from "./bot-hold.js";
import { bankSaleIn } from "./flip-read.js";

export const FOLLOW_UP_KINDS = {
  // The cold cadence. Until this existed the twelve touches after a first
  // text lived in a GHL workflow the app could not see, so "gone quiet" on a
  // cold agent was not a thing the queue could say.
  outreach_nudge: { party: "agent",    trigger: "outreach_sent",   label: "Reached out, no reply" },
  offer_nudge:    { party: "agent",    trigger: "offer_open",      label: "Offer with no reply" },
  // A pass is rarely final: listings sit, sellers soften. Check back in on
  // the offer they turned down — would the seller come closer to our number?
  passed_checkin: { party: "agent",    trigger: "offer_passed",    label: "Passed offer, check back in" },
  // A price is agreed and nothing is on paper. The goal from here is the
  // listing agent writing it up on NWMLS forms for us to sign; this ladder
  // keeps asking, tightly, until they do or go quiet.
  hot_push:       { party: "agent",    trigger: "price_agreed",    label: "Price agreed, push to paper" },
  // A buyer who said something about a deal — a question, "interested",
  // "send me more", a walkthrough — and then went quiet gets one follow-up,
  // counted from their last word. Matt, 2026-10-05: a buyer who never
  // answered a deal (or only opened the package) is not followed up about
  // it; they hear from us about what fits them instead (the pulse). Buck got
  // the blast, a walkthrough invite and "Last check on this one…" about a
  // house he never answered.
  deal_followup:  { party: "investor", trigger: "investor_evaluating", label: "Spoke up on a deal, then went quiet" },
};

// The buyer ladders that ran until 2026-10-05: "Blasted, no reply" and
// "Opened the package, went quiet". Both chased buyers who had said nothing.
// No longer offered or swept; their drafts still render and can be sent or
// dismissed by hand.
export const RETIRED_FOLLOW_UP_KINDS = ["blast_nudge", "dataroom_nudge"];

// The hot push's own floor between texts. A constant, not a setting: it
// ignores the shared gap between texts and the weekly cap on purpose, and this is
// what it keeps instead.
export const HOT_MIN_HOURS = 20;

export const FOLLOW_UP_KIND_KEYS = Object.keys(FOLLOW_UP_KINDS);
export const kindsFor = (party) => FOLLOW_UP_KIND_KEYS.filter((k) => FOLLOW_UP_KINDS[k].party === party);

// What happens when the ladder runs out. "stop" leaves them alone; the agent
// ladder can additionally write down what the silence meant.
export const ON_EXHAUSTED = ["stop", "mark_no_response"];

// Conservative on purpose, and off on purpose. Three touches over two weeks
// is a follow-up; anything tighter is a campaign, and this ships to an
// operator who has not watched it work yet.
// The cold-agent ladder's default until 2026-10-20. Saved settings carry it
// verbatim, so a stored copy reads as "never changed" and gets today's.
export const PREVIOUS_OUTREACH_NUDGE_STEPS = [2, 5, 9, 14, 21, 30];

// The days the cold-agent ladder runs from the first text: a repeat rung
// past this is never reached (ghl-broker/follow-up-sweep.js reads
// outreach_sent this far back), so "every 14 days" ends on day 58.
export const OUTREACH_NUDGE_WINDOW_DAYS = 60;

export const DEFAULT_LADDERS = {
  // A cold agent hears from us on day 2, then a check-in every 14 days until
  // they answer (2026-10-20, Matt: "2 days later … and then check in every 14
  // days after that"). Earlier that day: day 3 and day 10, each its own text;
  // before that six over a month, every one the same text.
  outreach_nudge: { enabled: false, steps: [2], repeatEvery: 14, onExhausted: "stop" },
  // An offer is asked about until the agent answers — yes, no, or a number.
  // The date printed on it is not a deadline: agents answer lapsed offers all
  // the time, so after day 14 the ladder keeps going, once a week — four
  // more times (2026-10-22 audit: the same "our N still stands" went out 3–6
  // times, and an open offer kept its agent out of the "anything else on
  // your desk?" check-in for as long as it ran). Then it's marked no
  // response and the agent check-in asks for their next one.
  offer_nudge:    { enabled: false, steps: [3, 7, 14], repeatEvery: 7, maxRepeats: 4, onExhausted: "mark_no_response" },
  // Every ten days, for four months.
  passed_checkin: { enabled: false, steps: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120], repeatEvery: 0, onExhausted: "stop" },
  // Tight: an agreed price cools fast. It re-anchors on their every reply
  // (follow-up-sweep.js hotCandidates), so these are days since they last
  // spoke, and two with nothing back is a phone call, not a third text.
  hot_push:       { enabled: false, steps: [1, 3, 6, 10], repeatEvery: 0, onExhausted: "stop" },
  // One rung, always: the sweep sends only the first day however many are
  // saved. Never a second ask, never a "last check".
  deal_followup:  { enabled: false, steps: [3], repeatEvery: 0, onExhausted: "stop" },
};

/* ---------- what the bot promised ---------- */

// "Let me run this by my underwriting team today and get back to you with a
// number." Said to eleven agents on 2026-09-14, and for several of them —
// Emily Cressey, Foster, Shawn Filer — nothing ran and nothing came back. A
// promise is a clock like any other: when it is due and nothing went out,
// somebody has to keep it.
export const PROMISE_DUE_HOURS = 4;

// "Can have it over today", "I'll send our written offer over", "I'll get
// our offer in", "I'll have our offer to you" (2026-10-08: the bot said it
// and nothing tracked it). We say it, about the paper; "feel free to send it
// over" asks THEM, and "send it over to my partner" isn't to them.
// "Can you send it over?" asks them, and "so I can get it in front of
// underwriting" is about our numbers, not the paper (2026-10-14 replay: both
// read as a promise of the written offer).
const WE_WILL = String.raw`(?:i'?ll|i\s+will|i\s+can|we'?ll|we\s+will|we\s+can|i'?m\s+going\s+to|we'?re\s+going\s+to|let\s+me|happy\s+to|can)\s+(?:(?!you\b)\w+\s+){0,2}?`;
const THE_PAPER = String.raw`(?:our|the)\s+(?:written\s+|formal\s+|official\s+)?(?:offer|loi|letter(?:\s+of\s+intent)?)`;
const PAPER_PROMISE = [
  new RegExp(String.raw`\b${WE_WILL}(?:send|get|have|shoot)\s+(?:it|that|${THE_PAPER})\s+(?:over|in(?!\s+front)|to\s+you|your\s+way)\b(?!\s+to\s+(?:my|our|the|him|her|them)\b)`, "i"),
  new RegExp(String.raw`\b${WE_WILL}(?:send|get|shoot)\s+over\s+${THE_PAPER}`, "i"),
];

/**
 * detectPromise(text) → "number" | "paper" | "call" | "tour" | "emd" | "answer" | null
 *
 * Whether a reply WE sent commits us to coming back. "number" when it's our
 * numbers ("get back to you with a number", "run it by underwriting", "have a
 * number back to you today"); "paper" when it's the written offer ("can have
 * it over today", "I'll send our offer over"); "call", "tour" and "emd" when
 * it's a call, a time to walk the house, or the earnest money — things only a
 * person keeps (PERSON_PROMISES); "answer" when it's anything else ("let me
 * run that by my partner and get back to you this afternoon").
 */
export function detectPromise(text = "") {
  const t = String(text || "");
  const number = [
    /\b(?:number|numbers|figure|offer)\b[^.?!]{0,40}\bback\s+to\s+you\b/i,
    /\b(?:get|come|circle)\s+back\s+(?:to\s+you\s+)?with\s+(?:a|an|the|our)\s+(?:\w+\s+)?(?:number|figure|offer|price)\b/i,
    /\b(?:run|re-?run|running)\s+(?:it|this|that|the\s+(?:numbers|address)|(?:[\w-]+\s+){0,3}[\w-]+)\s+(?:by|past|through)\s+(?:my\s+|our\s+|the\s+)?underwriting\b/i,
    /\bnumbers?\s+re-?run\b/i,
    // "I'll come back to you today with a number", "will have a number for
    // you this afternoon" (2026-10-14: read as a bare "answer").
    /\b(?:get|come|circle)\s+back\s+to\s+you\b[^.?!]{0,30}?\bwith\s+(?:a|an|the|our)\s+(?:\w+\s+)?(?:number|figure|offer|price)\b/i,
    /\b(?:have|get)\s+(?:a|our|the)\s+(?:\w+\s+)?(?:number|numbers|figure)\s+(?:back\s+)?(?:to|for)\s+you\b/i,
    // The words the prompts use since 2026-10-15: "I'll text you the number
    // by 3", "…and text you where we'd land".
    /\btext\s+you\s+(?:back\s+)?(?:where\s+we(?:'d|\s+would|'ll)?\s+(?:land|be|come\s+out)|(?:the|our|a)\s+(?:\w+\s+)?(?:number|figure|price))\b/i,
  ];
  if (number.some((re) => re.test(t))) return "number";
  // "…and get back to you with where we'd land", "let me run it and get back
  // to you": our numbers — unless it's a partner's call, which is an answer
  // the owner gives (isDeflection, the answer box).
  const ours = [
    /\b(?:get|come|circle)\s+back\s+(?:to\s+you\s+)?[^.?!]{0,30}?\bwith\s+where\s+we(?:'d|\s+would|'ll|\s+will)?\s+(?:land|be|stand|come\s+out)\b/i,
    /\b(?:run|re-?run|running)\s+(?:it|this|that|them|those|the\s+numbers|those\s+numbers|numbers)\s+(?:today\s+|now\s+)?(?:and|&)\s+(?:i'?ll\s+|we'?ll\s+)?(?:get|come|circle)\s+back\b/i,
  ];
  if (!/\bpartner\b/i.test(t) && ours.some((re) => re.test(t))) return "number";
  if (PAPER_PROMISE.some((re) => re.test(t))) return "paper";
  // A call, a time to walk it, the earnest money (2026-10-15: 37 of the 58
  // negotiations we dropped were a promise not kept, and these were the ones
  // nothing tracked). "…give you a call if it makes sense" promises nothing.
  if (!isConditionalPromise(t)) {
    if (CALL_PROMISE.some((re) => re.test(t))) return "call";
    if (TOUR_PROMISE.some((re) => re.test(t))) return "tour";
    if (EMD_PROMISE.some((re) => re.test(t))) return "emd";
  }
  if (/\b(?:get|come|circle)\s+back\s+to\s+you\b|\bback\s+to\s+you\s+(?:today|this\s+afternoon|tonight|tomorrow|later)\b/i.test(t)) return "answer";
  return null;
}

// What only a person keeps (2026-10-15): a call, a time to walk the house,
// the earnest money. They're tracked on Today (shared/promise-owed.js
// owedPersonPromises, a call as a call_owed row), never by the machine's
// "still working on it" text or the promise driver.
export const PERSON_PROMISES = new Set(["call", "tour", "emd"]);
const WE_SAY = String.raw`(?:i'?ll|i\s+will|we'?ll|we\s+will|let\s+me|i'?m\s+going\s+to|we'?re\s+going\s+to|i\s+can|matt\s+will|he'?ll)`;
const CALL_PROMISE = [
  new RegExp(String.raw`\b${WE_SAY}\s+(?:\w+\s+){0,2}?(?:give\s+you\s+a\s+(?:quick\s+)?(?:call|ring|buzz)|call\s+you(?:\s+back)?|ring\s+you)\b`, "i"),
  /\b(?:call|ring)\s+you\s+(?:back\s+)?(?:tomorrow|today|tonight|this\s+(?:afternoon|evening|morning|week)|in\s+(?:a\s+bit|an\s+hour|a\s+few))\b/i,
  // What the prompts say to do with terms: "let's go over the terms on a quick call".
  /\b(?:i'?ll|we'?ll|let'?s|let\s+me|happy\s+to|i\s+can|we\s+can)\s+(?:go\s+over|walk\s+(?:you\s+)?through|talk\s+(?:it\s+|that\s+|this\s+)?(?:over|through))\b[^.?!]{0,40}\bon\s+a\s+(?:quick\s+)?(?:phone\s+)?call\b/i,
];
const TOUR_PROMISE = [
  new RegExp(String.raw`\b${WE_SAY}\s+(?:\w+\s+){0,2}?(?:get\s+(?:back\s+to\s+)?you\s+(?:a\s+)?(?:time|times|day)\s+to\s+(?:walk|see|tour|look\s+at)|(?:come|get)\s+back\s+(?:to\s+you\s+)?(?:with|on)\s+(?:a\s+)?(?:time|times|day)\b|(?:set\s+up|schedule|book|line\s+up)\s+(?:a\s+)?(?:time\s+to\s+(?:walk|see|tour)|walk-?through|showing|tour))`, "i"),
];
const EMD_PROMISE = [
  new RegExp(String.raw`\b${WE_SAY}\s+(?:\w+\s+){0,3}?(?:send|get|wire|deliver|drop\s+off|have)\s+(?:\w+\s+){0,2}?(?:earnest(?:\s+money)?|emd|deposit)\b`, "i"),
  /\b(?:earnest(?:\s+money)?|emd|deposit)\b[^.?!]{0,30}\b(?:i'?ll|we'?ll|i\s+will|we\s+will)\s+(?:send|wire|get|deliver)\b/i,
];

/**
 * isConditionalPromise(text) → boolean
 *
 * "I'll run it by underwriting and circle back if it pencils out", "…and
 * see if we can get back to you with an offer": a look we promised, not a
 * number. Still a promise for the sweep's same-day clock, but nothing we
 * owe a week later (shared/promise-owed.js).
 */
export function isConditionalPromise(text = "") {
  return /\b(?:circle\s+back|get\s+back(?:\s+to\s+you)?|reach\s+(?:back\s+)?out|follow\s+up|give\s+you\s+a\s+(?:quick\s+)?call|come\s+back(?:\s+to\s+you)?)\s+if\b|\bif\s+it\s+(?:pencils|makes\s+sense|looks\s+like\s+a\s+fit|(?:'s|is)\s+a\s+fit|works\s+for\s+us)\b|\bsee\s+if\s+(?:we\s+can|it\s+(?:pencils|works|makes\s+sense))\b|\bif\s+(?:they|the\s+sellers?|she|he|you)\s+(?:\w+\s+){0,3}?(?:come|get)\s+back\b/i.test(String(text || ""));
}

/**
 * isDeflection(text) → boolean
 *
 * An owed ANSWER that names a partner or "checking": the bot was asked
 * something it had no answer for and said it would find out. The owner's
 * answer (Today's answer box) is what keeps it, and what stops the next one.
 */
export function isDeflection(text = "") {
  const t = String(text || "");
  if (detectPromise(t) !== "answer") return false;
  return /\b(?:my|our)\s+(?:business\s+)?partner(?:'s)?\b|\bcheck\s+(?:on\s+that|with|into)\b|\bfind\s+out\b|\bnot\s+something\s+I\s+want\s+to\s+guess\b/i.test(t);
}

/**
 * questionIn(inbound) → string
 * The question they asked: the last sentence ending in "?", else the whole
 * message, clipped.
 */
export function questionIn(inbound = "") {
  const t = String(inbound || "").replace(/\s+/g, " ").trim();
  const asked = t.split(/(?<=[.!?])\s+/).filter((x) => x.trim().endsWith("?")).at(-1);
  return (asked || t).trim().slice(0, 240);
}

/* ---------- when they said to check back ---------- */

// "I'll check back in when I get into the office this Wednesday" (Tyler
// Anderson, 2026-09-14). They named the day; nothing remembered it. A check-in
// they asked for is the warmest follow-up there is.
const CHECKIN_CUE = /\b(?:check(?:ing)?\s+(?:back|in)|circle\s+back|touch\s+base|reach\s+(?:back\s+)?out|follow\s+up|get\s+back\s+to\s+you|let\s+you\s+know|back\s+in\s+(?:town|the\s+office)|in(?:to)?\s+the\s+office|hit\s+you\s+up|text\s+you|talk\s+(?:then|soon))\b/i;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// 17:00 UTC ≈ 10am Pacific, the morning after the day they named.
const morningOf = (ms) => { const d = new Date(ms); d.setUTCHours(17, 0, 0, 0); return d.toISOString(); };

/**
 * checkInRequested(text, now) → { dueAt, phrase } | null
 *
 * Only when the message says they'll come back to us (a check-in cue) AND
 * names when: a weekday, tomorrow, next week, a few weeks, a month. Due the
 * morning after the day they named, so it lands after they had their chance.
 */
export function checkInRequested(text = "", now = Date.now()) {
  const t = String(text || "");
  if (!CHECKIN_CUE.test(t)) return null;
  return timeNamed(t, now);
}

/**
 * timeNamed(text, now) → { dueAt, phrase } | null
 *
 * The when, on its own: a weekday, tomorrow, next week, a few weeks, a month.
 * Due the morning after, so it lands after they had their chance.
 */
export function timeNamed(text = "", now = Date.now()) {
  const t = String(text || "");
  const day =/\b(?:this\s+|next\s+|on\s+)?(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\b/i.exec(t);
  if (day) {
    const want = WEEKDAYS.indexOf(day[1].toLowerCase().slice(0, 3));
    let add = (want - new Date(now).getUTCDay() + 7) % 7;
    if (add === 0) add = 7;
    return { dueAt: morningOf(now + (add + 1) * DAY_MS), phrase: day[0].trim() };
  }
  if (/\btomorrow\b/i.test(t)) return { dueAt: morningOf(now + 2 * DAY_MS), phrase: "tomorrow" };
  if (/\bnext\s+week\b/i.test(t)) return { dueAt: morningOf(now + 8 * DAY_MS), phrase: "next week" };
  const weeks = /\b(?:a\s+)?(?:few|couple(?:\s+of)?|2|two|3|three)\s+weeks?\b/i.exec(t);
  if (weeks) return { dueAt: morningOf(now + 15 * DAY_MS), phrase: weeks[0].trim() };
  if (/\b(?:a|next)\s+month\b/i.test(t)) return { dueAt: morningOf(now + 31 * DAY_MS), phrase: "a month" };
  return null;
}

/* ---------- a lead, and when it'll be ready ---------- */

// 2026-10-14: 17 agents told us WHEN a lead would be ready ("relisting in
// springtime", "should know by end of the month", "coming closer to Nov 1")
// and 31 named one, and every one got the generic 14-day "anything distressed
// or off-market?" text instead of one on the right day naming the lead.
// checkInRequested only heard "check back" plus a day or a week.
//
// detectLeadTiming hears the lead (a short sale, a relist, one coming up, an
// expiring listing) and the time (next week, end of the month, spring, about
// a year), and only books when both are in the same stretch of words.
// Precision over recall: a miss is the generic check-in, as before; a false
// hit is a text about a house that doesn't exist.

// The furthest out a lead is booked: thirteen months. Past that, nothing.
export const LEAD_MAX_DAYS = 395;
// A lead check-in held back (an open offer had them) is dropped this long
// after its day: by then it's the conversation's, not a clock's.
export const LEAD_STALE_DAYS = 30;
// They spoke in the run-up to its day: the lead is in the conversation, and a
// check-in on top of it is the machine talking over itself.
export const LEAD_QUIET_DAYS = 14;

const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RX = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;
const NUM_RX = String.raw`((?:a\s+)?(?:few|couple(?:\s+of)?)|\d{1,2}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, few: 3, couple: 2 };
const numOf = (s) => { const k = String(s || "").toLowerCase().replace(/^a\s+/, "").replace(/\s+of$/, ""); return /^\d+$/.test(k) ? Number(k) : NUM_WORDS[k] || 0; };
const WEEKDAY_FULL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// The calendar day it is in Seattle, as a UTC midnight.
function todayOf(now) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(now)).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
const ymd = (day) => { const d = new Date(day); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
const lastDayOf = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
function addMonths(day, n) {
  const [y, m, d] = ymd(day);
  return Date.UTC(y, m + n, Math.min(d, lastDayOf(y, m + n)));
}
// The next time this month and day come round (today counts).
function nextDate(today, month, date) {
  const [y] = ymd(today);
  const d = Date.UTC(y, month, Math.min(date, lastDayOf(y, month)));
  return d >= today ? d : Date.UTC(y + 1, month, Math.min(date, lastDayOf(y + 1, month)));
}
const SEASONS = { spring: [2, 15], summer: [5, 15], fall: [8, 15], autumn: [8, 15], winter: [11, 15] };

// Each says when, from a match: { day, how } — `how` "by" (a deadline: we ask
// a couple of days after), "after" (the day after), or "" (that day).
// `low` marks the vague ones. A `when` of null drops the match.
const TIME_RULES = [
  { rx: /\btomorrow\b/gi, when: (m, t) => ({ day: t + DAY_MS }) },
  { rx: /\b(?:later\s+)?this\s+week\b/gi, when: (m, t) => ({ day: t + Math.max(1, (5 - new Date(t).getUTCDay() + 7) % 7) * DAY_MS }) },
  { rx: /\b(?:early\s+|later\s+)?next\s+week\b/gi, when: (m, t) => ({ day: t + 7 * DAY_MS }) },
  { rx: /\b(this|next)\s+weekend\b/gi, when: (m, t) => ({ day: t + (((6 - new Date(t).getUTCDay() + 7) % 7 || 7) + (/next/i.test(m[1]) ? 7 : 0)) * DAY_MS }) },
  { rx: /\bnext\s+month\b/gi, when: (m, t) => { const [y, mo] = ymd(t); return { day: Date.UTC(y, mo + 1, 10) }; } },
  // "in a few weeks", "in the next 30 days", "within a couple of months",
  // "not for about a year", "for 6 months then relisting".
  { rx: new RegExp(String.raw`\b(in|within|for|over|another|after)\s+(?:the\s+)?(?:next\s+|coming\s+)?(?:about\s+|around\s+|roughly\s+|maybe\s+|another\s+)?${NUM_RX}\s+(days?|weeks?|months?|years?)\b`, "gi"),
    when: (m, t, text) => {
      const pre = text.slice(Math.max(0, m.index - 6), m.index);
      const post = text.slice(m.index + m[0].length, m.index + m[0].length + 14);
      // "for six months" is how long, not when — unless it's "not for" or "…then".
      if (/^for$/i.test(m[1]) && !/\bnot\s+$/i.test(pre) && !/^\s*,?\s*(?:and\s+)?then\b/i.test(post)) return null;
      return spanFrom(t, numOf(m[2]), m[3]);
    } },
  { rx: new RegExp(String.raw`\bnext\s+${NUM_RX}\s+(days?|weeks?|months?)\b`, "gi"), when: (m, t) => spanFrom(t, numOf(m[1]), m[2]) },
  { rx: /\b(?:within|in|over)\s+(?:the\s+)?(?:next|coming)\s+(week|month)(\s+or\s+two)?\b/gi, when: (m, t) => spanFrom(t, m[2] ? 2 : 1, m[1]) },
  // "the bank said it takes 30-45 days": the short end.
  { rx: /\btakes?\s+(?:about\s+|around\s+)?(\d{1,2})(?:\s*(?:-|to)\s*\d{1,2})?\s+(days|weeks|months)\b/gi, when: (m, t) => spanFrom(t, Number(m[1]), m[2]) },
  { rx: new RegExp(String.raw`\b${NUM_RX}\s+(weeks?|months?)\s+(?:out|from\s+now)\b`, "gi"), when: (m, t) => spanFrom(t, numOf(m[1]), m[2]) },
  { rx: /\b(?:about|around|roughly|maybe)\s+a\s+year\b/gi, when: (m, t) => ({ day: addMonths(t, 12) }) },
  { rx: /\b(?:by\s+)?(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?(week|month|year)\b/gi,
    when: (m, t) => {
      const [y, mo] = ymd(t);
      const unit = m[1].toLowerCase();
      if (unit === "week") return { day: t + ((5 - new Date(t).getUTCDay() + 7) % 7) * DAY_MS, how: "by" };
      if (unit === "month") return { day: Date.UTC(y, mo, lastDayOf(y, mo)), how: "by" };
      return { day: Date.UTC(y, 11, 31), how: "by" };
    } },
  { rx: /\b(?:by\s+)?(?:the\s+)?end\s+of\s+next\s+month\b/gi, when: (m, t) => { const [y, mo] = ymd(t); return { day: Date.UTC(y, mo + 1, lastDayOf(y, mo + 1)), how: "by" }; } },
  { rx: /\b(?:first|beginning|start)\s+of\s+(?:the\s+|next\s+)month\b/gi, when: (m, t) => { const [y, mo] = ymd(t); return { day: Date.UTC(y, mo + 1, 1) }; } },
  { rx: /\bafter\s+the\s+holidays\b|\b(?:first|beginning|start)\s+of\s+(?:the|next)\s+year\b|\b(?:after|in)\s+(?:the\s+)?new\s+year\b|\bnext\s+year\b/gi,
    when: (m, t) => ({ day: nextDate(t, 0, /next\s+year/i.test(m[0]) ? 15 : 5) }) },
  { rx: /\bafter\s+thanksgiving\b/gi, when: (m, t) => { const [y] = ymd(t); const nov1 = new Date(Date.UTC(y, 10, 1)).getUTCDay(); const tg = Date.UTC(y, 10, 1 + ((4 - nov1 + 7) % 7) + 21); return { day: (tg >= t ? tg : tg + 364 * DAY_MS) + 4 * DAY_MS }; } },
  { rx: /\bafter\s+christmas\b/gi, when: (m, t) => ({ day: nextDate(t, 11, 28) }) },
  // "relisting in springtime", "until spring", "next summer", "early fall".
  { rx: /\b(in\s+the|in|by|until|till|this|next|the|around|after|before|early|late|mid)[-\s]+(?:(early|late|mid)[-\s]+)?(spring|summer|fall|autumn|winter)(?:time)?\b|\b(spring|summer|winter)time\b/gi,
    when: (m, t) => {
      const season = (m[3] || m[4]).toLowerCase();
      const pre = String(m[1] || "").toLowerCase();
      const [mo, d] = SEASONS[season];
      let day = nextDate(t, mo, d);
      // In the season already ("this summer" in July): soon, not next year.
      if (day - t > 290 * DAY_MS && pre !== "next") day = t + 14 * DAY_MS;
      const shade = String(m[2] || (/^(early|late|mid)$/.test(pre) ? pre : "")).toLowerCase();
      if (shade === "early") day -= 14 * DAY_MS;
      if (shade === "late") day += 45 * DAY_MS;
      return { day, how: pre === "by" ? "by" : ["until", "till", "after"].includes(pre) ? "after" : "" };
    } },
  // "by end of October", "in March", "early November", "Nov 1", "after October 21st".
  { rx: new RegExp(String.raw`\b(?:(by|in|after|until|till|around|before|early|mid|late|(?:the\s+)?end\s+of|(?:the\s+)?(?:beginning|start|first|middle|first\s+week)\s+of)[-\s]+(?:the\s+)?)?${MONTH_RX}(?:\s+(\d{1,2})(?:st|nd|rd|th)?\b)?`, "gi"),
    when: (m, t) => {
      const pre = String(m[1] || "").toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ");
      const mo = MONTH_KEYS.indexOf(m[2].toLowerCase().slice(0, 3));
      const date = m[3] ? Number(m[3]) : 0;
      if (mo < 0 || date > 31) return null;
      // "may", "march": a word first. Only a month with a date or a lead-in.
      if (!pre && !date) return null;
      const how = pre === "by" || pre === "end of" ? "by" : ["after", "until", "till"].includes(pre) ? "after" : "";
      const [y, cur] = ymd(t);
      let day;
      if (date) day = nextDate(t, mo, date);
      else {
        const anchor = pre === "end of" || pre === "by" ? lastDayOf(y, mo)
          : pre === "early" || /^(beginning|start|first)/.test(pre) ? 5
          : pre === "mid" || pre === "middle of" ? 15
          : pre === "late" ? 25
          : pre === "after" ? lastDayOf(y, mo)
          : 1;
        day = mo === cur ? Math.max(Date.UTC(y, mo, anchor), t + 3 * DAY_MS) : nextDate(t, mo, anchor);
      }
      // Most of a year away is a month that's gone: "listed in September".
      if (day - t > 300 * DAY_MS) return null;
      return { day, how };
    } },
  { rx: /\b(by|on|after|until|till|around|before)\s+(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/gi,
    when: (m, t) => {
      const mo = Number(m[2]) - 1, date = Number(m[3]);
      if (mo < 0 || mo > 11 || date < 1 || date > 31) return null;
      const day = nextDate(t, mo, date);
      if (day - t > 300 * DAY_MS) return null;
      const pre = m[1].toLowerCase();
      return { day, how: pre === "by" ? "by" : ["after", "until", "till"].includes(pre) ? "after" : "" };
    } },
  { rx: /\b(by|on|after|until|till|around)\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/gi,
    when: (m, t) => {
      const date = Number(m[2]);
      if (date < 1 || date > 31) return null;
      const [y, mo, d] = ymd(t);
      const day = date >= d ? Date.UTC(y, mo, Math.min(date, lastDayOf(y, mo))) : Date.UTC(y, mo + 1, Math.min(date, lastDayOf(y, mo + 1)));
      const pre = m[1].toLowerCase();
      return { day, how: pre === "by" ? "by" : ["after", "until", "till"].includes(pre) ? "after" : "" };
    } },
  // "by Tuesday", "after Monday", "goes live Thursday". The short forms only
  // with a lead-in ("sat on the market" isn't Saturday).
  { rx: /\b(?:(by|on|after|until|till|this|next|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thurs?|fri|sat)\b/gi,
    when: (m, t) => {
      const name = m[2].toLowerCase();
      const pre = String(m[1] || "").toLowerCase();
      if (!WEEKDAY_FULL.includes(name) && !pre) return null;
      const want = WEEKDAY_FULL.findIndex((w) => w.startsWith(name.slice(0, 3)));
      let add = (want - new Date(t).getUTCDay() + 7) % 7;
      if (add === 0) add = 7;
      return { day: t + add * DAY_MS, how: pre === "by" ? "by" : ["after", "until", "till"].includes(pre) ? "after" : "" };
    } },
  // The vague ones: a couple of weeks out, at low confidence.
  { rx: /\b(soon|shortly|in\s+the\s+near\s+future|any\s+day\s+now)\b/gi,
    when: (m, t, text) => {
      const pre = text.slice(Math.max(0, m.index - 12), m.index);
      if (/\b(?:as|talk|chat|speak|see|hear\s+from\s+you)\s+$/i.test(pre)) return null;
      return { day: t + 14 * DAY_MS, low: true };
    } },
];

function spanFrom(today, n, unit) {
  if (!(n > 0)) return null;
  const u = String(unit).toLowerCase();
  if (u.startsWith("day")) return { day: today + n * DAY_MS };
  if (u.startsWith("week")) return { day: today + n * 7 * DAY_MS };
  if (u.startsWith("month")) return { day: addMonths(today, n) };
  return { day: addMonths(today, 12 * n) };
}

// What the lead is, in words the check-in can use. Earlier rows win when two
// sit beside the same time ("taken off market, relisting in spring" is the
// relist). `by` marks a lead whose time is a deadline — the expiry, the
// answer they're waiting on — so we ask a couple of days after it.
const HOUSE_WORD = /\b(?:house|home|property|seller|owner|bank|lender|condition|inspection|listing|probate|court|repairs|tenants?|fixer)\b/i;
const LEAD_CUES = [
  { rx: /\bprobate\b/i, what: "the probate" },
  { rx: /\b(?:an?|the|this|that)\s+estate\b(?!\s+(?:agent|market|industry|business|license))|\bestate\s+(?:sale|house|property|home|listing)\b/i, what: "the estate" },
  { rx: /\bhoarder\b/i, what: "the hoarder house" },
  { rx: /\b(?:pre-?)?foreclos\w*/i, what: "the foreclosure" },
  { rx: /\b(?:listing|it|we|we're|agreement|contract)\s+(?:\w+\s+){0,2}?expir(?:es|ing|e)\b|\bexpir(?:es|ing|e)\s+(?:next|this|on|in|by|end|at\s+the\s+end)\b|\bexpir\w*\s+listing\b/i, what: "the listing expiring", by: true },
  // Ahead of us, not behind: "relisting", "will go back on", never "relisted" or "went back on".
  { rx: /\bre-?\s?list(?:ing|s)?\b(?!\s+(?:w\/?|with)\.?\s+(?:someone|somebody|another|a\s+different))|\b(?:go|going|goes|put|putting|come|coming|be|bring|bringing)\s+(?:it\s+)?back\s+on\b/i, what: "relisting it" },
  { rx: /\b(?:pull|pulling|take|taking|taken)\s+(?:it\s+)?off\s+(?:of\s+)?(?:the\s+)?market\b|\bpull(?:ing)?\s+it\b|\bwithdraw(?:ing)?\b/i, what: "the listing they may pull" },
  { rx: /\b(?:one|something|another|a\s+(?:house|home|property|listing|fixer|flip|few))\s+(?:\w+\s+){0,2}?coming\s+(?:up|soon|down|on|out|available)\b|\bhave\s+(?:one|something)\s+(?:for\s+you\s+)?(?:soon|shortly|coming)\b|\bhave\s+(?:one|something|another)\s+(?:\w+\s+){0,2}?(?:listed|to\s+list|hitting)\b/i, what: "the one coming up" },
  { rx: /\bsomething\s+(?:\w+\s+)?(?:on|hitting|to)\s+the\s+market\b/i, what: "the one coming on the market" },
  { rx: /\b(?:list|listing)\s+(?:it|this|that|her|his|their|the\s+(?:house|home|property|place))\b|\b(?:going|plan(?:ning)?|getting\s+ready|about|preparing|ready)\s+to\s+list\b|\b(?:will|'ll|gonna|should|going\s+to)\s+(?:be\s+)?list(?:ing|ed)?\b|\b(?:is|are|'s|'re|am|'m)\s+listing\b(?!\s+(?:agent|price|photos|is|was))|\b(?:hit|hits|hitting)\s+(?:the\s+)?(?:market|mls)\b|\b(?:come|comes|coming|go|goes|going)\s+(?:on|to|onto)\s+(?:the\s+)?(?:market|mls)\b|\bgo(?:es|ing)?\s+live\b|\blisting\s+(?:goes|will|should|is\s+going)\b/i, what: "the listing" },
  { rx: /\boff[\s-]?market\b|\bpocket\s+listing\b|\bunlisted\b|\bnot\s+(?:yet\s+)?(?:listed|on\s+the\s+market)\b|\bpre[\s-]?market\b/i, what: (m) => (/unlisted/i.test(m[0]) ? "the unlisted house" : "the off-market one") },
  { rx: /\b(?:a|an|another|one|some|couple|few)\s+(?:\w+\s+)?(?:fixers?|fixer[\s-]uppers?|flips?|investor\s+specials?|handyman\s+specials?|tear[\s-]?downs?|project\s+(?:house|home|property))\b/i, what: "the fixer" },
  { rx: /\btenants?\b[^.!?]{0,30}\b(?:mov(?:e|es|ing)|vacat(?:e|es|ing)|leav(?:e|es|ing)|lease\s+(?:is\s+)?(?:up|ends?|ending))\b|\blease\s+(?:is\s+)?(?:up|ends?|ending)\b|\bvacant\s+(?:by|after|in)\b/i, what: "the tenant moving out" },
  { rx: /\bclean(?:ed|ing)?[\s-]?out\b|\bclear(?:ed|ing)?\s+(?:it\s+)?out\b/i, what: "the clean-out" },
  { rx: /\b(?:sellers?|owners?|clients?|family|heirs?)\b[^.!?]{0,25}?\b(?:decid\w*|thinking|consider\w*|on\s+the\s+fence|wants?\s+(?:it\s+)?(?:to\s+)?sell|wants?\s+(?:to\s+)?(?:get\s+)?it\s+sold|need\w*\s+to\s+sell|ready\s+to\s+sell|undecided|might\s+sell|may\s+sell|plan\w*\s+to\s+sell|letting\s+it\s+go)\b/i, what: "the seller's plans" },
  { rx: /\b(?:should|will|'ll|hope\s+to|hoping\s+to|going\s+to|gonna)\s+(?:\w+\s+)?(?:know|hear(?:\s+back)?|find\s+out|have\s+(?:an?\s+)?(?:answer|update|decision))\b/i, what: "what they find out", by: true, needsHouse: true },
  { rx: /(?<!\bwanted\s+to\s)(?<!\bjust\s)\bcheck(?:ing)?\s+back\b|\bcheck\s+in\s+(?:with\s+me\s+)?(?:again|in|after|around|next)\b|\breach\s+(?:back\s+)?out\b|\bcircle\s+back\b|\btouch\s+base\b|\bfollow\s+up\s+(?:with\s+me\s+)?(?:in|after|next)\b|\bhit\s+me\s+(?:back\s+)?up\b|\b(?:free|available)\s+to\s+(?:talk|chat|connect)\b|\btalk\s+(?:more\s+)?(?:after|then|next)\b|\b(?:ask|try)\s+me\s+again\b/i, what: "", checkBack: true },
];
// How far apart (characters) the lead and its time may sit.
const LEAD_NEAR = 70;

/**
 * detectLeadTiming(text, now, { checkBack }) → { when, what, phrase, said, confidence } | null
 *
 * An agent telling us when a lead will be ready. `when` is the check-in's
 * ISO time (10am Pacific): the day they named, a couple of days after a
 * deadline ("should know by", "expires"), the day after an "after", and never
 * sooner than two days out. The earliest one wins ("if it doesn't sell by end
 * of October she'll pull it until spring" is asked about in November).
 * `what` names the lead ("the probate"), or "" when they only said to
 * check back. `checkBack: false` hears only the lead words — for a call
 * transcript with our side in it too.
 */
export function detectLeadTiming(text = "", now = Date.now(), { checkBack = true } = {}) {
  const t = String(text || "").replace(/[’‘]/g, "'");
  if (!t.trim()) return null;
  // A tapback quotes OUR text back ("Liked “I'll check back next week”"): not theirs.
  if (/^\s*(?:liked|loved|disliked|emphasi[sz]ed|laughed\s+at|questioned|removed\s+.{1,8}\s+from|\S{1,4}\s+to)\s+[“"]/i.test(t)) return null;
  const today = todayOf(now);
  const cues = [];
  for (const c of LEAD_CUES) {
    if (c.checkBack && !checkBack) continue;
    if (c.needsHouse && !HOUSE_WORD.test(t)) continue;
    const rx = new RegExp(c.rx.source, "gi");
    for (const m of t.matchAll(rx)) {
      // A cue about our offer ("your offer expires") is not their lead, and
      // nor is what they think WE could do ("if you fixed it up and relisted").
      if (/\b(?:your|our)\s+offer\b/i.test(t.slice(Math.max(0, m.index - 14), m.index + m[0].length))) continue;
      if (/\b(?:if\s+you|you\s+(?:could|would|can|'d|might|fix\w*|flip\w*|bought|buy))\b[^.!?]{0,40}$/i.test(t.slice(Math.max(0, m.index - 60), m.index))) continue;
      cues.push({ start: m.index, end: m.index + m[0].length, rank: LEAD_CUES.indexOf(c), cue: c, m });
    }
  }
  if (!cues.length) return null;

  let best = null;
  for (const rule of TIME_RULES) {
    const rx = new RegExp(rule.rx.source, "gi");
    for (const m of t.matchAll(rx)) {
      const start = m.index, end = m.index + m[0].length;
      // Something that already happened: "last spring", "since March", "a few weeks ago".
      if (/\b(?:last|since|past|this\s+past|back\s+in)\s+$/i.test(t.slice(Math.max(0, start - 16), start))) continue;
      if (/^\s*(?:ago|back|(?:of\s+)?last\s+year|of\s+\d{4}|,?\s*\d{4})\b/i.test(t.slice(end, end + 16))) continue;
      // A house closing is a deal on paper, not a lead ("closing soon", "close tomorrow").
      if (/\bclos(?:e|es|ed|ing)\s+(?:\w+\s+)?$/i.test(t.slice(Math.max(0, start - 20), start))) continue;
      const w = rule.when(m, today, t);
      if (!w) continue;
      // A lead in the same sentence: "...decided to go on market! I'll send
      // what I find this week" is two things. The sentence before may still
      // name it better ("heading to probate. We should know next week").
      const between = (c) => (c.end <= start ? t.slice(c.end, start) : c.start >= end ? t.slice(end, c.start) : "");
      const close = cues.filter((c) => between(c).length <= LEAD_NEAR);
      if (!close.some((c) => !/[!?]|\.\s/.test(between(c)))) continue;
      const nearby = close.filter((c) => !/[!?]/.test(between(c))).sort((a, b) => a.rank - b.rank);
      const near = nearby[0];
      // "I'll circle back shortly" is no date at all.
      if (w.low && near.cue.checkBack) continue;
      // A short sale or a bank-owned house isn't a lead we chase (Matt,
      // 2026-10-29: out of the buy box), whatever its date.
      const lo = Math.min(start, near.start), hi = Math.max(end, near.end);
      const sentence = t.slice(Math.max(0, t.slice(0, lo).search(/[^.!?\n]*$/)), hi + t.slice(hi).search(/[.!?\n]|$/));
      if (bankSaleIn(sentence)) continue;
      let day = w.day;
      if (w.how === "by" || nearby.some((c) => c.cue.by)) day += 2 * DAY_MS;
      else if (w.how === "after") day += DAY_MS;
      if (day - today < 2 * DAY_MS) day = Math.max(day, today) + DAY_MS;
      // Never on a weekend: Monday.
      const dow = new Date(day).getUTCDay();
      if (dow === 6) day += 2 * DAY_MS; else if (dow === 0) day += DAY_MS;
      if (day - today > LEAD_MAX_DAYS * DAY_MS) continue;
      if (best && best.day <= day) continue;
      const what = typeof near.cue.what === "function" ? near.cue.what(near.m) : near.cue.what;
      const from = Math.max(0, Math.min(start, near.start)), to = Math.max(end, near.end);
      const said = sentenceAround(t, from, to);
      best = { day, what, phrase: m[0].trim(), said, confidence: w.low ? "low" : "high" };
    }
  }
  if (!best) return null;
  return { when: morningOf(best.day), what: best.what, phrase: best.phrase, said: best.said, confidence: best.confidence };
}

// The sentence (or two) a match sits in, clipped.
function sentenceAround(t, from, to) {
  const before = t.slice(0, from).search(/[^.!?\n]*$/);
  const tail = t.slice(to).search(/[.!?\n]/);
  return t.slice(before < 0 ? 0 : before, tail < 0 ? t.length : to + tail + 1).replace(/\s+/g, " ").trim().slice(0, 200);
}

// A lead check-in this close stands in for the "nobody answered them" net
// under a held reply (reply-agent.js, the nightly audit); one further out
// leaves that net in place — "relisting in spring" is no reason to leave a
// held reply unanswered till March.
export const LEAD_NET_DAYS = 7;

/** leadIsTheNet(event, now) → true for any check-in request but a lead more than LEAD_NET_DAYS out. */
export function leadIsTheNet(e, now = Date.now()) {
  if (e?.data?.kind !== "lead") return true;
  return (ms(e.data?.dueAt) ?? 0) - now <= LEAD_NET_DAYS * DAY_MS;
}

/**
 * leadCheckInAnswered(req, events) → boolean
 *
 * They spoke in the run-up to the lead's day (or since it was booked, when
 * that's sooner): the conversation has the lead. A text about something else
 * in November doesn't settle a lead that's due in March.
 */
export function leadCheckInAnswered(req, events = []) {
  const due = ms(req?.data?.dueAt) ?? ms(req?.at) ?? 0;
  const from = Math.max(ms(req?.at) ?? 0, due - LEAD_QUIET_DAYS * DAY_MS);
  return (events || []).some((e) => (e?.type === "text_summary" || e?.type === "call_summary") && (ms(e.at) ?? 0) > from);
}

/**
 * leadCheckInPending(events, now) → the lead's checkin_requested event | null
 *
 * The newest lead an agent told us about, not yet asked about, not settled by
 * the conversation, and not long past its day. It has its own track: a newer
 * "unanswered" or "this Wednesday" check-in doesn't replace it.
 */
export function leadCheckInPending(events = [], now = Date.now()) {
  const byTime = [...(events || [])].filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const req = byTime.filter((e) => e.type === "checkin_requested" && e.data?.kind === "lead").at(-1);
  if (!req) return null;
  if (byTime.some((e) => e.type === "checkin_sent" && e.data?.requestAt === req.at)) return null;
  const due = ms(req.data?.dueAt);
  if (due == null || now - due > LEAD_STALE_DAYS * DAY_MS) return null;
  if (leadCheckInAnswered(req, byTime)) return null;
  return req;
}

/**
 * takingItToSeller(text, now) → { dueAt, phrase } | null
 *
 * The agent is taking our number to the seller and will come back: Julie
 * Nutley's "I will run it by them ... I will share with them and get back
 * with you" (2026-09-15). Nothing for a person to decide, so the bot can say
 * thanks. If they don't come back, a check-in goes two mornings later.
 */
const TO_SELLER_RX = /\b(?:run|take|bring|present|share|show|send|pass)\s+(?:it|this|that|the\s+(?:number|offer))?\s*(?:by|to|with|past|along\s+to)\s+(?:them|him|her|my\s+(?:sellers?|clients?)|the\s+(?:sellers?|owners?|clients?))\b/i;
const COME_BACK_RX = /\b(?:get|circle|come)\s+back\s+(?:to|with)\s+you\b|\blet\s+you\s+know\s+what\s+(?:they|he|she)\b|\bsee\s+what\s+(?:they|he|she)\s+(?:say|think)/i;
export function takingItToSeller(text = "", now = Date.now()) {
  const t = String(text || "");
  if (!TO_SELLER_RX.test(t) && !(COME_BACK_RX.test(t) && /\b(?:sellers?|owners?|them|clients?)\b/i.test(t))) return null;
  const when = timeNamed(t, now);
  return { dueAt: when?.dueAt || morningOf(now + 2 * DAY_MS), phrase: when?.phrase || "hearing back from the seller" };
}

/**
 * unansweredCheckIn(now) → { dueAt, phrase }
 *
 * Nothing went out. An agent texted us, the draft was held for a person, and
 * the thread's next move belongs to nobody: Thomas Rinow, 2026-09-15, gave us
 * the seller's number ("that are willing to go to 670") on a live offer and
 * heard nothing back, then emailed the next morning to close it out himself.
 *
 * The outbox is where a held draft waits, but an outbox row is not a clock.
 * This is the clock: two mornings on, the check-in sweep comes back to them
 * unless they (or a person here) spoke first.
 */
export const UNANSWERED_CHECKIN_DAYS = 2;
export function unansweredCheckIn(now = Date.now()) {
  return { dueAt: morningOf(now + UNANSWERED_CHECKIN_DAYS * DAY_MS), phrase: "" };
}

// The next morning's opening, for a clock the nightly audit sets at dusk.
export const nextMorning = (now = Date.now()) => morningOf(now + DAY_MS);

/**
 * addressPending({ intent, propertyAddress, message, now }) → { hint, firstDueAt, phrase } | null
 *
 * They told us a property is coming and the message carries no address:
 * Alexandria Goforth's "I will likely have one in Spanaway soon" (2026-09-15).
 * `hint` is their words, so the chase can refer to it the way they did; a time
 * they named ("in a few weeks") is when the first check-in lands.
 */
export const ADDRESS_PENDING_INTENTS = new Set(["new_property", "deal_available"]);
export function addressPending({ intent = "", propertyAddress = "", message = "", now = Date.now() } = {}) {
  if (!ADDRESS_PENDING_INTENTS.has(intent) || String(propertyAddress || "").trim()) return null;
  const hint = String(message || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!hint) return null;
  const when = timeNamed(hint, now);
  return { hint, firstDueAt: when?.dueAt || null, phrase: when?.phrase || "" };
}

/**
 * offersToSendDeals(text) → boolean
 *
 * The agent offered to be a source: "You got an email I can send properties
 * to?" (Karamveer Tiwana), "I'll keep you in mind for any fixers" (Greg
 * Devey), "I'll keep an eye on some more properties" (Christian Simonson).
 */
export function offersToSendDeals(text = "") {
  const t = String(text || "");
  return /\b(?:email|number|address)\s+(?:i\s+can|to)\s+send\b/i.test(t)
    || /\b(?:send|forward|pass)\s+(?:you\s+|them\s+|along\s+)?(?:some\s+|any\s+|more\s+)?(?:properties|deals|listings|fixers|leads)\b/i.test(t)
    || /\bkeep\s+(?:you|an\s+eye(?:\s+out)?)\b[^.?!]{0,40}\b(?:fixers?|deals?|properties|listings|in\s+mind)\b/i.test(t)
    || /\bfirst\s+look\b|\boff[\s-]?market\b/i.test(t);
}

export const MAX_LADDER_STEPS = 12;
export const MAX_STEP_DAY = 120;
export const MAX_REPEAT_DAYS = 60;
// A ladder's repeats, at most (maxRepeats).
export const MAX_REPEATS = 52;

/**
 * repeatsSent({ steps, sentSteps }) → how many repeat rungs (past the last
 * configured day) have gone.
 */
export function repeatsSent({ steps = [], sentSteps = [] } = {}) {
  const last = Math.max(0, ...normalizeSteps(steps));
  return new Set((sentSteps || []).map((x) => Math.round(Number(x))).filter((x) => Number.isFinite(x) && x > last)).size;
}

// Every rung the ladder has reached by `now`, plus the next one: the
// configured days, then — for a repeating ladder — one more every
// `repeatEvery` days after the last. A repeat rung's step is its day offset
// like any other, so its dedupe key is as stable as a configured one.
// `unit` is a paced day (shared/bot-hold.js): the rungs keep their numbers,
// only the time to each one stretches or shrinks.
function rungsThrough(ladder, repeatEvery, started, now, unit = DAY_MS) {
  const every = Math.round(Number(repeatEvery) || 0);
  if (!(every > 0) || !ladder.length) return ladder;
  const out = [...ladder];
  const daysIn = Math.floor((now - started) / unit);
  for (let d = ladder[ladder.length - 1] + every; d <= daysIn + every; d += every) out.push(d);
  return out;
}

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/**
 * normalizeSteps(v) → [day]
 *
 * Whole days, in range, sorted, deduped, capped. A saved ladder is never
 * trusted: the same coercion runs on the console and on the broker.
 */
export function normalizeSteps(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,\s]+/);
  const out = [];
  for (const x of raw) {
    const n = Math.round(Number(String(x).trim()));
    if (!Number.isFinite(n) || n < 1 || n > MAX_STEP_DAY) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b).slice(0, MAX_LADDER_STEPS);
}

/**
 * dueStep({ steps, startedAt, sentSteps, lastInboundAt, lastTouchAt, now,
 *           stopOnAnyInbound, minHoursBetween, repeatEvery, pace })
 *   → { due: true, step, dayOffset } | { due: false, reason }
 *
 * `pace` (shared/bot-hold.js): 2 checks in half as often, 0.5 twice as
 * often. It scales the time to each rung; the gap between texts only ever
 * grows with it.
 *
 * `step` is the day offset itself, so it is stable if the operator reorders
 * or inserts a rung: step 7 means "the day-7 touch" forever, and a ladder
 * edited mid-conversation cannot re-send a touch already made.
 *
 * `reason` is in the operator's words — it goes on the sweep's result row so
 * "why didn't it follow up?" is a lookup rather than a guess.
 */
export function dueStep({
  steps = [], startedAt, sentSteps = [], lastInboundAt = null, lastTouchAt = null,
  now = Date.now(), stopOnAnyInbound = true, minHoursBetween = 0, repeatEvery = 0, pace = 1,
} = {}) {
  const configured = normalizeSteps(steps);
  if (!configured.length) return { due: false, reason: "no ladder" };
  const started = ms(startedAt);
  if (started == null) return { due: false, reason: "nothing to count from" };
  const { rung, floor } = paceScale(pace);
  const unit = DAY_MS * rung;
  const ladder = rungsThrough(configured, repeatEvery, started, now, unit);

  // They answered. That is the whole point of the ladder and it ends here —
  // whatever they said, a person or the reply agent is now in a conversation,
  // and a scheduled nudge on top of it is the bot talking over itself.
  const inbound = ms(lastInboundAt);
  if (stopOnAnyInbound && inbound != null && inbound > started) {
    return { due: false, reason: "they replied" };
  }

  const done = new Set(sentSteps.map((s) => Math.round(Number(s))).filter(Number.isFinite));
  // The rung we would be sending TODAY: the highest one whose day has passed,
  // whether or not it was sent. Two things fall out of that, both deliberate:
  //
  //   A sweep that was down for a fortnight comes back and sends one message
  //   rather than working through the backlog into somebody's phone.
  //
  //   And a rung is never fired in arrears. If the day-14 touch has gone and
  //   the day-7 one was skipped — they were on a live deal that week, the
  //   sweep stood aside — day 7 does not come back round on day 20. Same rule
  //   protects an operator who inserts a day-1 rung into a ladder mid-flight:
  //   it applies to the next conversation, not retroactively to this one.
  const overdue = ladder.filter((d) => started + d * unit <= now);
  const pick = overdue.length ? overdue[overdue.length - 1] : null;
  if (pick == null || done.has(pick)) {
    const next = ladder.find((d) => !done.has(d) && started + d * unit > now);
    return { due: false, reason: next == null ? "ladder finished" : `day ${next} hasn't come round yet` };
  }

  const touched = ms(lastTouchAt);
  if (minHoursBetween > 0 && touched != null && now - touched < minHoursBetween * floor * 3600000) {
    const hrs = Math.round((now - touched) / 3600000);
    return { due: false, reason: `we texted them ${hrs}h ago — too soon` };
  }
  return { due: true, step: pick, dayOffset: pick };
}

/**
 * exhausted({ steps, sentSteps, startedAt, now }) → boolean
 *
 * True once the last rung's day has passed. Note it does NOT require every
 * rung to have been sent: a ladder whose middle step was skipped (they were
 * on a live deal that week) is still over when its last day goes by.
 */
export function exhausted({ steps = [], sentSteps = [], startedAt, now = Date.now(), repeatEvery = 0, pace = 1 } = {}) {
  // A repeating ladder never runs out: it asks until they answer.
  if (Math.round(Number(repeatEvery) || 0) > 0) return false;
  const ladder = normalizeSteps(steps);
  if (!ladder.length) return false;
  const started = ms(startedAt);
  if (started == null) return false;
  const last = ladder[ladder.length - 1];
  if (started + last * DAY_MS * paceScale(pace).rung > now) return false;
  return !dueStep({ steps: ladder, startedAt, sentSteps, now, stopOnAnyInbound: false, pace }).due;
}

/**
 * nextRungAt({ steps, repeatEvery, startedAt, sentSteps, now }) → { at, step, due } | null
 *
 * The same ladder dueStep reads, asked the other way round: not "is a rung
 * due now" but "which rung is next, and on what day". `due` means the rung's
 * day has passed and it hasn't gone — the next sweep sends it. null when the
 * ladder is finished. Inbound, the gap between texts and the weekly cap are
 * the caller's (they aren't a property of the ladder).
 */
export function nextRungAt({ steps = [], repeatEvery = 0, startedAt, sentSteps = [], now = Date.now(), pace = 1 } = {}) {
  const configured = normalizeSteps(steps);
  const started = ms(startedAt);
  if (!configured.length || started == null) return null;
  const unit = DAY_MS * paceScale(pace).rung;
  // Far enough ahead that a repeating ladder always has a rung after `now`.
  const every = Math.round(Number(repeatEvery) || 0);
  const ladder = rungsThrough(configured, every, started, now + Math.max(every, 1) * unit, unit);
  const done = new Set(sentSteps.map((s) => Math.round(Number(s))).filter(Number.isFinite));
  const overdue = ladder.filter((d) => started + d * unit <= now);
  const pick = overdue.at(-1);
  if (pick != null && !done.has(pick)) return { at: new Date(started + pick * unit).toISOString(), step: pick, due: true };
  const next = ladder.find((d) => !done.has(d) && started + d * unit > now);
  return next == null ? null : { at: new Date(started + next * unit).toISOString(), step: next, due: false };
}

/**
 * rungsCovered({ steps, repeatEvery, startedAt, texts, pace }) → [step]
 *
 * A nudge some other path already sent on this offer — the nightly audit's
 * "floated, never heard back", a Float pressed by hand — is that day's rung.
 * The Auburn listing agent, 2026-09-19/21: the audit asked about Auburn on day 3 and
 * the sweep asked again two days later, because only the sweep's own rungs
 * were counted. `texts` are when those nudges went (ms or ISO). A text
 * before the first rung's day is the first rung.
 */
export function rungsCovered({ steps = [], repeatEvery = 0, startedAt, texts = [], pace = 1 } = {}) {
  const configured = normalizeSteps(steps);
  const started = ms(startedAt);
  if (!configured.length || started == null) return [];
  const unit = DAY_MS * paceScale(pace).rung;
  const out = new Set();
  for (const t of texts || []) {
    const at = typeof t === "number" ? t : ms(t);
    if (at == null || at < started) continue;
    const reached = rungsThrough(configured, repeatEvery, started, at, unit).filter((d) => started + d * unit <= at).at(-1);
    out.add(reached ?? configured[0]);
  }
  return [...out].sort((a, b) => a - b);
}

/** nudgeTimes(drafts, offerId) → [ISO] — when a nudge on this offer went out, or is queued to. */
export function nudgeTimes(drafts = [], offerId = "") {
  if (!offerId) return [];
  return (drafts || [])
    .filter((d) => d?.outbound?.kind === "offer_nudge" && d.outbound.offerId === offerId && ["sent", "scheduled", "sending"].includes(d.status))
    .map((d) => (d.status === "sent" ? d.sentAt || d.updatedAt || d.createdAt : d.sendAt || d.createdAt))
    .filter(Boolean);
}

/* ---------- where each offer ladder counts from ---------- */
// The sweep (ghl-broker/follow-up-sweep.js) and the Offers tab's "Next
// follow-up" column (shared/next-follow-up.js) both read these, so the day
// the column promises is the day the sweep acts.

const latest = (xs) => xs.filter(Boolean).sort().at(-1) || null;

/** An open offer: from the last time we put it in front of them. */
export function offerNudgeStart(offer) {
  return latest((offer?.sends || []).map((s) => s?.ts)) || offer?.statusAt || offer?.createdAt || null;
}

/**
 * threadTimes(drafts) → { lastInboundAt, lastHandledAt, lastMachineTouchAt, heldSince, scheduled }
 *
 * One contact's reply drafts, read for the clocks. A draft row exists for
 * every inbound, so this is who spoke last and whether it was dealt with:
 *
 *   lastHandledAt       our last text out (a reply counts as much as a nudge),
 *                       or an inbound we chose to leave — "ok thanks" is
 *                       dismissed or skipped, not owed
 *   lastMachineTouchAt  our last machine-started text (the gap between texts)
 *   heldSince           their newest text, when its reply is held for a person
 *   scheduled           replies queued to send, soonest first
 */
export function threadTimes(drafts = []) {
  const list = (drafts || []).filter(Boolean);
  const inbound = list.filter((d) => String(d.inbound || "").trim());
  const newestIn = [...inbound].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))).at(-1) || null;
  return {
    lastInboundAt: latest(inbound.map((d) => d.createdAt)),
    lastHandledAt: latest([
      ...list.filter((d) => d.status === "sent").map((d) => d.sentAt || d.updatedAt || d.createdAt),
      ...inbound.filter((d) => d.status === "dismissed" || d.status === "skipped").map((d) => d.createdAt),
    ]),
    lastMachineTouchAt: latest(list.filter((d) => d.outbound?.kind && d.status === "sent").map((d) => d.updatedAt || d.createdAt)),
    heldSince: newestIn?.status === "draft" ? newestIn.createdAt : null,
    scheduled: list.filter((d) => (d.status === "scheduled" || d.status === "sending") && d.sendAt)
      .sort((a, b) => String(a.sendAt).localeCompare(String(b.sendAt))),
  };
}

/* ---------- one voice: the machine never talks over a waiting reply ---------- */

// Every kind of text the machine starts on its own (ghl-broker/reply-agent.js
// OUTBOUND_KINDS, less the answer a person types on Today). One of these may
// replace an older one nobody sent: the next nudge standing in for the last
// is still one voice. Anything else in the outbox answers THEM or is a
// person's own: a reply to their text, your answer to a question the bot
// couldn't field, your hand-written check-in, the walkthrough ask, a queued
// deal text.
export const MACHINE_STARTED_KINDS = new Set([
  "outreach_open", "outreach_nudge", "outreach_email", "checkin_email", "take_check", "realm_check", "offer_nudge", "counter_nudge", "take_ask", "kind_pass", "pass_note",
  "hot_push", "passed_checkin", "promise_due", "price_drop", "checkin_due", "address_chase",
  "blast_nudge", "dataroom_nudge", "deal_followup", "buyer_pulse", "agent_pulse", "showing_reminder", "showing_followup", "second_look",
  "gatekeeper_email", "gatekeeper_text", "gatekeeper_checkin"]);

// A draft that answers something they sent. Reply rows carry no outbound
// kind — a photo-only text has an empty `inbound`, so the kind decides.
export const answersInbound = (d) => !d?.outbound?.kind || Boolean(String(d?.inbound || "").trim());

const OWN_DRAFT_WORD = { check_in: "check-in", partner_answer: "answer", showing_ask: "walkthrough ask", blast_open: "deal text" };

/**
 * blockingDraft(open, { continues }) → draft | null
 *
 * `open` is one contact's outbox. The row a machine-started text would talk
 * over: waiting (draft or scheduled), not the machine's own, and not the
 * reply this text carries on from — the re-quote that answers their numbers,
 * the check-in that is the net under a held reply. Until 2026-09-29 every
 * machine text superseded whatever was waiting, so a question held for a
 * person left Today and a canned check-in went out in its place.
 */
// Texts that are service to a buyer who booked a time, not outreach: a deal
// text queued for them (it can wait days for their week — shared/buyer-touch.js)
// doesn't hold these up, and they never replace it.
export const SERVICE_KINDS = new Set(["showing_reminder", "showing_followup"]);

export function blockingDraft(open = [], { continues = null, kind = null, now = Date.now() } = {}) {
  return (open || []).find((d) => d && (d.status === "draft" || d.status === "scheduled")
    && d.id !== continues && !MACHINE_STARTED_KINDS.has(d.outbound?.kind)
    && !(SERVICE_KINDS.has(kind) && d.status === "scheduled" && d.outbound?.kind === "blast_open")
    && !(kind === "agent_pulse" && staleHeld(d, now))) || null;
}

// A draft held a week, or a text queued long ago whose send time has passed,
// is forgotten business: it stays on the Desk for you, but it no longer
// speaks for the agent. Until 2026-10-14 a held reply of any age kept the
// agent check-in away for good (shared/agent-pulse.js agentOwner).
export const STALE_HELD_DAYS = 7;
/** staleHeld(draft, now) → true for an open draft written STALE_HELD_DAYS ago that isn't still going out. */
export function staleHeld(d, now = Date.now()) {
  if (!d || (d.status !== "draft" && d.status !== "scheduled")) return false;
  if (d.status === "scheduled" && (ms(d.sendAt) ?? 0) > now) return false;
  const t = ms(d.createdAt);
  return t != null && now - t >= STALE_HELD_DAYS * DAY_MS;
}

/**
 * supersededBy(open, { kind, now }) → the open drafts a new machine text replaces
 *
 * All of them, except a deal text queued for a buyer (it waits for their
 * week) and, for the agent check-in, a stale held row — the check-in goes
 * out past it, and it stays on the Desk for you.
 */
export function supersededBy(open = [], { kind = null, now = Date.now() } = {}) {
  return (open || []).filter((d) => d && d.outbound?.kind !== "blast_open"
    && !(kind === "agent_pulse" && staleHeld(d, now) && !MACHINE_STARTED_KINDS.has(d.outbound?.kind)));
}

/** Why the machine stood down, in the words a skipped row shows. */
export function blockingReason(d) {
  if (answersInbound(d)) return "their text is waiting on you — the machine won't talk over it";
  return `your ${OWN_DRAFT_WORD[d?.outbound?.kind] || String(d?.outbound?.kind || "draft").replace(/_/g, " ")} to them is waiting in the outbox`;
}

/**
 * offerNudgeAnchor({ startedAt, lastInboundAt, lastHandledAt })
 *   → { startedAt, reanchored, waitingOnUs }
 *
 * They answered, it was dealt with, and it went quiet: the offer is still
 * open and still ours to ask about, counted from when it was dealt with.
 * Until 2026-09-29 the ladder ended at their first reply ("they replied") and
 * a sent or countered offer could sit with no clock at all. If THEIR text is
 * the last word and nobody has dealt with it, nothing is anchored — that is a
 * reply we owe, not a follow-up.
 */
export function offerNudgeAnchor({ startedAt, lastInboundAt = null, lastHandledAt = null } = {}) {
  const inbound = ms(lastInboundAt);
  const start = ms(startedAt);
  if (inbound == null || start == null || inbound <= start) return { startedAt, reanchored: false, waitingOnUs: false };
  const handled = ms(lastHandledAt);
  if (handled == null || handled < inbound) return { startedAt, reanchored: false, waitingOnUs: true };
  return { startedAt: new Date(handled).toISOString(), reanchored: true, waitingOnUs: false };
}

// The dead statuses a check-in brings back: their pass, and a number that
// went out and never got a word back (shared/offer-status.js REVIVABLE_STATUSES).
export const CHECKIN_STATUSES = new Set(["passed", "no_response"]);

/** A passed or gone-quiet offer: from when it was marked so. */
export function passedStart(offer) {
  const status = offer?.status;
  return latest((offer?.statusHistory || []).filter((h) => h?.status === status).map((h) => h.ts))
    || offer?.statusAt || offer?.createdAt || null;
}

/**
 * followUpDedupeKey({ kind, subjectId, step }) → string
 *
 * The contact_events unique key, and therefore the claim. Two ticks racing on
 * the same rung write the same key, and the unique index makes the second one
 * a no-op. This is the whole concurrency story — there is no lock.
 */
export function followUpDedupeKey({ kind, subjectId, step }) {
  return `followup:${kind}:${String(subjectId || "none")}:${Math.round(Number(step) || 0)}`;
}

/**
 * stepLabel(step, steps) → "step 2 of 3"
 * What the outbox row says. Position, not day, because that is how a person
 * reads a follow-up they are about to approve.
 */
export function stepLabel(step, steps = []) {
  const ladder = normalizeSteps(steps);
  const n = Math.round(Number(step));
  const i = ladder.indexOf(n);
  if (i >= 0) return `step ${i + 1} of ${ladder.length}`;
  // A repeat rung, past the configured days.
  return ladder.length && n > ladder[ladder.length - 1] ? `still asking (day ${n})` : "";
}
