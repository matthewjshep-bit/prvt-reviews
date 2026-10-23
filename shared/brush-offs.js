// brush-offs.js — what an agent tells us about how (and whether) to keep in
// touch, read off their own words.
//
// 2026-10-14, reading 2,014 real threads: agents told us how often to check
// in and we kept the 14-day clock anyway — "check in no more than every 2–3
// months" (we said we'd back off, then texted a month later), "feel free to
// check back in a couple months" (texted three weeks later, and again two
// weeks after), "you are on my email list so you don't need to check in",
// "I have enough wholesalers in my database". The address chase kept asking
// after "please don't keep asking me" and "you can see them when they're on
// the market". And a brokerage's auto-responder ("You've reached Redfin, but
// we use a different number for texting", the eXp desk's menu) read as the
// agent writing back: a text waiting on Matt, a check-in they asked for.
//
//   cadenceRequest(text)   → { days, why, checkBack } | null
//   refusesAddress(text)   → why | null
//   notAHouse(text)        → true when the thing coming is land
//   isAutoReply(text)      → true for a machine's text, not a person's
//   autoReplyNumber(text)  → the other number an auto-reply says to text
//
// Pure. Precision over recall: a miss leaves things as they were; a false
// hit quiets an agent who wanted to hear from us.

import { isPlainNo } from "./conversation-audit.js";

const DAY_MS = 86400000;
// The longest an agent's own cadence holds the check-in off, and the least.
export const CADENCE_MIN_DAYS = 30;
export const CADENCE_MAX_DAYS = 180;
// "Every two or three months" → the middle of it: 75 days.
const MONTH_DAYS = 30;

const clean = (t) => String(t || "").replace(/[​﻿]/g, "").replace(/[’‘]/g, "'").replace(/[–—]/g, "-");

// A tapback quotes OUR words ("Liked “I'll check back in a couple months”"):
// never theirs to read.
const REACTION_RX = /^\s*(?:[\u{1F44D}\u{1F44E}\u{2764}\u{1F602}\u{203C}\u{2753}\u{1F60D}\u{1F64F}]️?|Liked|Loved|Laughed at|Emphasized|Disliked|Questioned|Le gustó|Reacted\s+\S+)\s*(?:to\s*)?[“"']/u;
export const isTapback = (text) => REACTION_RX.test(clean(text));

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, couple: 2, "couple of": 2, few: 3, several: 4, other: 2 };
const count = (w) => {
  const k = String(w || "").toLowerCase().replace(/\s+/g, " ").replace(/^a /, "").trim();
  return /^\d+$/.test(k) ? Number(k) : NUM_WORDS[k] ?? null;
};
const days = (months) => Math.min(CADENCE_MAX_DAYS, Math.max(CADENCE_MIN_DAYS, Math.round(months * MONTH_DAYS)));

// Words that make a time about US getting in touch, not about the house.
const CONTACT_CUE = /\b(?:check(?:ing)?\s+(?:in|back)|circle\s+back|touch\s+base|reach(?:ing)?\s+(?:back\s+)?out|follow(?:ing)?\s+up|hear\s+from|contact(?:ing)?|text(?:ing)?|ping(?:ing)?|call(?:ing)?|hit\s+me\s+up)\b/i;
// "every 2-3 months", "no more than every couple of months", "once every
// few months", "every other month", "every quarter".
const INTERVAL_RX = /\b(?:every|once\s+(?:every|in))\s+(?:(\d+)\s*(?:-|to|or)\s*(\d+)|(a\s+couple(?:\s+of)?|couple(?:\s+of)?|a\s+few|few|several|other|two|three|four|six|\d+))?\s*(months?|quarters?)\b/i;
const MONTHLY_RX = /\b(?:once\s+a\s+month|every\s+month|monthly)\b/i;
const QUARTERLY_RX = /\bquarterly\b/i;
// "check back in a couple months", "feel free to reach out in a few months".
const CHECK_BACK_RX = /\b(?:check(?:ing)?\s+(?:back|in)|circle\s+back|touch\s+base|reach\s+(?:back\s+)?out|follow\s+up|try\s+(?:me\s+)?again|hit\s+me\s+up|text\s+me|talk)\b[^.?!]{0,25}?\b(?:in|after)\s+(?:about\s+|another\s+|a\s+good\s+)?(a\s+couple(?:\s+of)?|couple(?:\s+of)?|a\s+few|few|several|two|three|four|six|\d+)\s+months?\b/i;
// They have us, and say they'll send what they have.
const ON_MY_LIST_RX = /\byou(?:'re|\s+are)\s+(?:already\s+)?on\s+my\s+(?:email\s+|e-mail\s+|mailing\s+|investor\s+|buyers?\s+|distribution\s+)?list\b/i;
const NO_NEED_RX = /\b(?:(?:do\s*n[o']?t|no)\s+need\s+(?:for\s+you\s+)?to|you\s+do\s*n[o']?t\s+have\s+to|no\s+need\s+to)\s+(?:keep\s+)?(?:check(?:ing)?\s+(?:in|back)|reach(?:ing)?\s+out|follow(?:ing)?\s+up|text(?:ing)?\s+me)\b/i;
// A no to us as a kind of buyer, said plainly.
const BRUSH_OFF = [
  [/\benough\s+wholesalers\b/i, "said they have enough wholesalers"],
  [/\btoo\s+(?:far\s+)?apart\b[^.?!]{0,40}\b(?:remain|stay|keep)\s+in\s+(?:contact|touch)\b/i, "said we're too far apart to stay in touch"],
  [/\b(?:not\s+interested\s+in|do\s*n[o']?t|does\s*n[o']?t|wo\s*n[o']?t|never)\s+(?:work(?:ing)?|deal(?:ing)?)\s+with\s+wholesalers\b/i, "said they don't work with wholesalers"],
  [/\bpocket\s+listings?\b[^.?!]{0,30}\billegal\b|\billegal\b[^.?!]{0,30}\bpocket\s+listings?\b/i, "said pocket listings are illegal"],
];
export const CADENCE_DAYS = { brushOff: 120, noNeed: 90, couple: 60, few: 90, monthly: 30, quarterly: 90 };

/**
 * cadenceRequest(text) → { days, why, checkBack, phrase? } | null
 *
 * How long they asked us to leave them be, in days (30–180):
 *   "every 2–3 months" 75 · "check back in a couple (of) months" 60 ·
 *   "a few months" 90 · "once a month" / "monthly" 30 · "quarterly" 90 ·
 *   "you're on my email list" / "don't need to check in" 90 ·
 *   "enough wholesalers" / "too far apart to remain in contact" /
 *   "don't work with wholesalers" / "pocket listings are illegal" 120.
 * `checkBack` is a "check back in N months": a dated check-in at that
 * distance as well as the cadence. A month on its own ("check back next
 * month") is a date, not a cadence: shared/follow-up.js timeNamed reads it.
 */
export function cadenceRequest(text = "") {
  const t = clean(text);
  if (!t.trim() || isTapback(t)) return null;
  const cue = CONTACT_CUE.test(t);
  const iv = INTERVAL_RX.exec(t);
  if (iv && cue) {
    const unit = /^quarter/i.test(iv[4]) ? 3 : 1;
    const n = iv[1] ? (Number(iv[1]) + Number(iv[2])) / 2 : iv[3] ? count(iv[3]) : 1;
    if (n) return { days: days(n * unit), why: `asked for a check-in ${iv[0].trim().toLowerCase()}`, checkBack: false };
  }
  const back = CHECK_BACK_RX.exec(t);
  if (back) {
    const n = count(back[1]);
    const phrase = `${back[1].toLowerCase().replace(/\s+/g, " ")} months`;
    if (n && n >= 2) return { days: days(n), why: `asked us to check back in ${phrase}`, checkBack: true, phrase };
  }
  if (cue && MONTHLY_RX.test(t)) return { days: CADENCE_DAYS.monthly, why: "asked for a check-in once a month", checkBack: false };
  if (cue && QUARTERLY_RX.test(t)) return { days: CADENCE_DAYS.quarterly, why: "asked for a check-in quarterly", checkBack: false };
  for (const [rx, why] of BRUSH_OFF) if (rx.test(t)) return { days: CADENCE_DAYS.brushOff, why, checkBack: false };
  if (NO_NEED_RX.test(t)) return { days: CADENCE_DAYS.noNeed, why: "said we don't need to check in", checkBack: false };
  if (ON_MY_LIST_RX.test(t)) return { days: CADENCE_DAYS.noNeed, why: "said we're on their list", checkBack: false };
  return null;
}

/**
 * cadenceDays(facts) → days | 0
 *
 * The cadence on the contact record (fact `checkinEvery`, the newest wins).
 */
export function cadenceDays(facts) {
  const list = Array.isArray(facts?.checkinEvery) ? facts.checkinEvery : [];
  const newest = [...list].sort((a, b) => String(a?.at || "").localeCompare(String(b?.at || ""))).at(-1);
  const n = Math.round(Number(newest?.value));
  return Number.isFinite(n) && n > 0 ? Math.min(CADENCE_MAX_DAYS * 2, n) : 0;
}

// A check-in they asked for stands 45 days from when they asked, or two
// weeks past the day it was due, whichever is later: "check back in a
// couple months" is still theirs at day 60.
export const CHECKIN_REQUEST_DAYS = 45;
const msOf = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
export function requestStands(req, now = Date.now()) {
  const at = msOf(req?.at);
  if (at == null) return false;
  const due = msOf(req?.data?.dueAt);
  return now < Math.max(at + CHECKIN_REQUEST_DAYS * DAY_MS, due != null ? due + 14 * DAY_MS : 0);
}

/* ---------- the address chase ---------- */

const DONT_ASK_RX = /\b(?:please\s+)?(?:do\s*n[o']?t|stop|quit)\s+(?:keep\s+|keeping\s+)?(?:asking|bugging|pestering|chasing)\b/i;
const SEE_IT_LISTED_RX = /\b(?:you(?:'ll|\s+will|\s+can)?|can)\s+see\s+(?:it|them|the\s+(?:address|listing)s?)\s+(?:when|once|after)\b/i;
const UNTIL_LISTED_RX = /\b(?:until|till|before)\s+(?:it|they)\s+(?:lists?|is\s+listed|are\s+listed|goes?\s+live|hits?\s+(?:the\s+)?(?:market|mls)|(?:is|are)\s+(?:live|on\s+the\s+market))\b/i;
const CANT_SHARE_RX = /\b(?:can\s*(?:'|no)?t|cannot|unable\s+to|not\s+(?:allowed|able|at\s+liberty)\s+to)\s+(?:give|share|send|disclose|release|provide)\s+(?:you\s+|out\s+)?(?:the\s+|that\s+|an?\s+)?(?:address(?:es)?|that|it|them|this|location)\b/i;
const NO_POCKET_RX = /\bnot\s+allowed\s+to\s+do\s+pocket\s+listings?\b/i;
const LET_YOU_KNOW_RX = /\bi(?:'ll|\s+will)\s+(?:definitely\s+|for\s+sure\s+|absolutely\s+)?(?:let\s+you\s+know|tell\s+you|reach\s+out|send\s+it|text\s+you)\s+(?:when|once|as\s+soon\s+as)\b/i;
const NO_LEAD_RX = /^\s*(?:no|nope|nah|not\s+yet|no\s+updates?(?:\s+yet)?|nothing\s+yet)\b/i;
const SURE_RX = /\b(?:definitely|for\s+sure|absolutely)\b/i;

/**
 * refusesAddress(text) → why | null
 *
 * Their answer to "what's the address?" is no: "Please don't keep asking
 * me", "No, you can see them when they're on the market", "I cannot give the
 * address until it lists", "Can't share that sorry", a bare "No" or "Not
 * yet", "No, he's out of the country, I'll tell you when he does". The chase
 * stops; the check-in has them from here. A no that goes on with a lead ("Not
 * yet. I do have a duplex coming up…") is not one.
 */
export function refusesAddress(text = "") {
  const t = clean(text).trim();
  if (!t || isTapback(t)) return null;
  if (DONT_ASK_RX.test(t)) return "they asked us to stop asking";
  if (SEE_IT_LISTED_RX.test(t) || UNTIL_LISTED_RX.test(t) || NO_POCKET_RX.test(t)) return "they'll share it when it's listed";
  if (CANT_SHARE_RX.test(t)) return "they can't share the address";
  if (LET_YOU_KNOW_RX.test(t) && (NO_LEAD_RX.test(t) || SURE_RX.test(t))) return "they'll tell us when it's ready";
  if (isPlainNo(t)) return "they said no";
  return null;
}

// What's coming is a piece of land, not a house: we buy houses that need
// work, so there is no address to chase ("I still have a vacant lot").
const LAND_RX = /\b(?:vacant|raw|bare|empty)\s+(?:land|lots?|parcels?|acreage)\b|\bland\s+listing\b|\bbuildable\s+lots?\b/i;
// "An older home and two vacant lots" is a house too; "build a home" on a lot is not.
const HOUSE_RX = /\b(?:house|fixer|rambler|duplex|triplex|condo|townhouse|bed(?:room)?s?|baths?)\b|(?<!\b(?:build|put|place)\s+(?:\w+\s+){0,2})\bhomes?\b/i;
export function notAHouse(text = "") {
  const t = clean(text);
  return LAND_RX.test(t) && !HOUSE_RX.test(t.replace(LAND_RX, " "));
}

/* ---------- auto-replies ---------- */

const AUTO_RX = [
  // Redfin: "You've reached Redfin, but we actually use a different number for texting".
  /\byou(?:'ve|\s+have)\s+reached\s+[^.?!]{0,40}\b(?:but|we|please|this\s+number)\b/i,
  /\b(?:this|my|our)\s+(?:number|line|phone)\s+(?:does\s*n[o']?t|do(?:es)?\s+not|can\s*(?:'|no)?t|cannot|is\s+(?:not\s+)?(?:un)?able\s+to|is\s+not\s+able\s+to)\s+(?:accept|receive|get|support|respond\s+to)\s+(?:text|sms)/i,
  /\b(?:use|uses)\s+a\s+different\s+number\s+for\s+text/i,
  /\bthis\s+is\s+an?\s+(?:automated|automatic|auto[-\s]?generated)\b|\b(?:automated|automatic|auto[-\s]?generated)\s+(?:message|reply|response|text)\b|\bauto[-\s]?(?:reply|response|responder)\s*:/i,
  // eXp: "thank you for contacting the eXpert Care Desk at eXp Realty", "Thank you for messaging eXp Realty".
  /\bthank\s+you\s+for\s+(?:contacting|messaging|texting)\s+(?:the\s+)?(?:[\w-]+\s+){0,4}(?:desk|realty|team|office|support|brokerage|group)\b/i,
  /\bpress\s+\d\s+for\b/i,
  /\bwill\s+be\s+with\s+you\s+(?:in\s+just\s+a\s+moment|in\s+a\s+moment|shortly)\b/i,
  /^\s*thank\s+you\s+for\s+your\s+message[,.!]?\s+we(?:'ll|\s+will)\s+(?:get\s+back|respond|be\s+in\s+touch|reply)\b/i,
  // A brokerage's SMS opt-in confirmation, a CRM's marketing text.
  /\breply\s+["“”']?stop["“”']?\s+to\s+(?:unsubscribe|stop|opt[\s-]?out|end)\b|\bthank\s+you\s+for\s+opting\s+in\b|\bmsg\s*(?:&|and)\s*data\s+rates\b|\bmessage\s+(?:&|and)\s+data\s+rates\s+may\s+apply\b/i,
  // Out of office, the way a responder says it (not "was out of the office yesterday").
  /^\s*(?:auto[-\s]?reply:?\s*)?(?:hi[,!]?\s+)?(?:i\s+am|i'm)\s+(?:currently\s+)?(?:out\s+of\s+(?:the\s+)?office|away\s+from\s+(?:the\s+)?office|on\s+vacation)\b[^.?!]{0,80}\b(?:until|through|returning|return\s+on|back\s+on|limited\s+access)\b/i,
  /\bout\s+of\s+office\s*(?:reply|message|:)/i,
  // An office's catch-all (2026-10-22, held as "couldn't place"): "One of our
  // agents will get back with you soon", "You've reached the front desk of …".
  /\bone\s+of\s+our\s+(?:agents|team\s+members|associates|staff)\s+will\s+(?:get\s+back|be\s+in\s+touch|reach\s+out|respond|follow\s+up)\b/i,
  /\byou(?:'ve|\s+have)\s+reached\s+the\s+(?:front\s+desk|main\s+(?:line|office)|office)\s+(?:of|at|for)\b/i,
  // iPhone's Driving Focus.
  /\bdo\s+not\s+disturb\b[^.?!]{0,40}\b(?:driving|turned\s+on)\b|\bi'll\s+see\s+your\s+message\s+when\s+i\s+get\b/i,
];

/**
 * isAutoReply(text) → boolean
 *
 * A machine answered, not the agent: Redfin's "different number for texting",
 * the eXp desk's menu and "will be with you in just a moment", "Thank you for
 * your message, we will get back to you shortly", an out-of-office, a
 * brokerage's SMS opt-in confirmation, Driving Focus. It is not their reply:
 * nothing to answer, nothing waiting on Matt, no check-in they asked for, and
 * the check-in's count of unanswered texts doesn't reset.
 */
export function isAutoReply(text = "") {
  const t = clean(text);
  if (!t.trim() || isTapback(t)) return false;
  return AUTO_RX.some((rx) => rx.test(t));
}

const PHONE_RX = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
/**
 * autoReplyNumber(text) → "(206) 555-0100" | null
 *
 * The number an auto-reply says texts go to instead ("we use a different
 * number for texting - (206) …"). Only from an auto-reply, and only when it
 * says to text somewhere else.
 */
export function autoReplyNumber(text = "") {
  const t = clean(text);
  if (!isAutoReply(t)) return null;
  if (!/\b(?:different|other|another|new)\s+number\b|\btext\s+(?:us|me)\s+(?:at|on)\b|\bfor\s+texting\b|\bdoes\s*n[o']?t\s+(?:accept|receive)\b|\bdo(?:es)?\s+not\s+(?:accept|receive)\b|\bcan\s*(?:'|no)?t\s+(?:accept|receive)\b/i.test(t)) return null;
  const m = PHONE_RX.exec(t);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : null;
}

// The morning (10am PT) `d` days on: when a "check back in a couple months"
// check-in is due, the same hour the other dated check-ins land.
export const cadenceDueAt = (now, d) => { const x = new Date(now + d * DAY_MS); x.setUTCHours(17, 0, 0, 0); return x.toISOString(); };
