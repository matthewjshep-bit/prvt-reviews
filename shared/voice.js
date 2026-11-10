// voice.js — one voice check for every text and email the machine sends.
//
// Matt, 2026-11-09: check-ins have to read like him, not like AI. The audit
// read the sent log against his own texts: the fixed templates said "desk"
// or "radar" in 40% of texts (Matt 0.9%), "any fixers" in 35% (4.1%), "on or
// off market" in 31% (0.9%), "circling back" in 16% (0.5%), and ran a median
// of 140 characters against his 89. Fixed texts preceded 47 of 61 agent
// opt-outs after a check-in, and our first reply asked again for "other
// fixers" right after our first text had. Until now each prompt carried its
// own banned list and only two outputs were checked after they were written.
//
// So every machine text passes this one check: at draft time (the reply
// agent's gates), at queue time (the agent emails), and once more as it
// leaves by itself (sendReplyDraft), against the live thread. A hard flag
// on a machine text holds it; a person pressing Send is never blocked, and
// Matt's own saved texts are flagged on the page, never dropped or rewritten
// (`machine: false` makes every flag soft).
//
// Pure. The later check-in branches import VOICE_RULE, TELLS, repeatsUs,
// openerKey, AI_COMPLAINT_RX and SENSITIVE_RX from here.

import { QUALIFY_ASK_RX } from "./flip-read.js";

/**
 * VOICE_RULE — the one paragraph every machine prompt carries in place of its
 * own list (checkins-design 3.1).
 */
export const VOICE_RULE =
  "HOW MATT TEXTS SOMEONE HE KNOWS (this outranks every TONE or PERSONALITY line for this message): " +
  "short and plain, the way he'd text a colleague between showings. One or two sentences, most under 140 characters, never over 200. " +
  "One real thing, then one question, and the question ends the text. Contractions and fragments are fine; lowercase is fine. " +
  "Their first name at most once, and not always first: sometimes open on the thing, sometimes on the question. " +
  "Never a dash of any kind, an exclamation mark, an emoji, a sign-off, a link, or a dollar sign. " +
  "Never these, in any wording: just checking in, checking in, touching base, circling back, following up, reaching out, " +
  "hope you're doing well, hope all is well, I'd love, we'd love, always happy to, happy to take a look, I'm all ears, " +
  "send it my way, keep me in mind, don't hesitate, feel free, quick question, just wanted to, value-add, TLC, I'm local, " +
  "always looking for the next project.";

/**
 * TELLS — [key, rx, level]: phrases and marks that give a machine away, in
 * any message. "hard" holds a machine text; "soft" is counted, never blocks.
 */
export const TELLS = [
  ["a dash", /[—–]|\s-\s/, "hard"],
  ["an exclamation mark", /!/, "hard"],
  ["an emoji", /\p{Extended_Pictographic}/u, "hard"],
  ["hope you're doing well", /\bhope (?:this (?:\w+ )?finds you|you(?:'re| are)(?: doing)? well|all is well|you(?:'re| are) having)\b/i, "hard"],
  ["reach out", /\breach(?:ing|ed)? out\b/i, "hard"],
  ["touch base", /\btouch(?:ing)? base\b/i, "hard"],
  ["checking in", /\bcheck(?:ing)?[- ]in\b/i, "hard"],
  ["following up", /\bfollow(?:ing)?[- ]up\b/i, "hard"],
  ["circling back", /\bcircl(?:e|ing) back\b/i, "hard"],
  ["I'd love", /\b(?:i|we)(?:'d| would) love\b|\bwould love\b/i, "hard"],
  ["happy to", /\balways happy to\b|\bhappy to (?:help|take a look|answer)\b/i, "hard"],
  ["keep me in mind", /\bkeep (?:me|us) in mind\b/i, "hard"],
  ["I'm here if", /\bI'?m (?:here|around) if\b/i, "hard"],
  ["send it my way", /\bsend (?:it|them|those|anything|any) (?:\w+ )?my way\b/i, "hard"],
  ["I'm all ears", /\bI'?m all ears\b/i, "hard"],
  ["don't hesitate", /\bdon'?t hesitate\b/i, "hard"],
  ["feel free", /\bfeel free\b/i, "hard"],
  ["at your convenience", /\bat your (?:earliest )?convenience\b/i, "hard"],
  ["rest assured", /\brest assured\b/i, "hard"],
  ["quick question", /\bquick question\b/i, "hard"],
  ["just wanted to", /\bjust wanted to\b/i, "hard"],
  ["please find", /\bplease find\b/i, "hard"],
  ["value-add", /\bvalue[- ]add\b/i, "hard"],
  ["TLC", /\bTLC\b/, "hard"],
  ["friendly neighborhood", /\bfriendly neighbou?rhood\b/i, "hard"],
  ["in the best way", /\bin the best way\b/i, "hard"],
  ["I'm local", /\bI'?m local\b/i, "hard"],
  ["next project house", /\bnext project house\b/i, "hard"],
  ["always looking", /\balways (?:looking|on the hunt)\b/i, "hard"],
  ["I'm an assistant", /\bI'?m an? (?:\w+ )?assistant\b/i, "hard"],
  ["my partner will", /\bmy partner will\b/i, "hard"],
  ["our team will", /\bour team will\b/i, "hard"],
  ["came across your listing", /\bcame across your listing\b/i, "soft"],
  ["corporate words", /\b(?:leverage|synergy|solutions?|streamline|value proposition|win-win|kindly|at this time|moving forward|going forward)\b/i, "soft"],
];

// In a text only: carriers read money and links as an ad, and the phone
// system signs the first text itself.
const SMS_TELLS = [
  ["a dollar sign", /\$/],
  ["a link", /https?:\/\/|\bwww\./i],
  ["a sign-off", /(?:^|[\n.?!,]\s*|\s[-–—~]\s*)(?:(?:thanks|thank you|thx|best|cheers|regards|talk soon)[,!.]?\s*)?(?:[-–—~]\s*)?(?:matt|matthew)(?:\s+shepherd)?\s*[.!]?\s*$/i],
];

// The stock opener Matt's own texts never start with (HUMAN in
// ghl-broker/conversation-prompt.js bans them for replies too).
const STOCK_OPENER_RX = /^\s*(?:got it|understood|perfect|appreciate it|good to know|sounds good|noted)\b/i;
// "Hi," with no name after it.
const BARE_GREETING_RX = /^\s*(?:hi|hey|hello)\s*[,.!]/i;
// A blank nobody filled.
const LEFTOVER_RX = /\{\{?[a-z_. ]+\}?\}|\[(?:name|first(?: name)?|address|street|town|city)\]/i;

/**
 * ONCE_GROUPS — Matt's own phrases: fine once, a tell on repeat. Hard only
 * when one of our last three texts (inside a month) used the same group.
 */
export const ONCE_GROUPS = [
  ["desk/radar/plate", /\b(?:desk|radar|on your plate|cross(?:ed|es)? your path)\b/i],
  ["on or off market", /\bon or off[- ]?market\b|\blisted or (?:not|off[- ]?market)\b|\bon the market or off\b/i],
  ["off-market", /\boff[- ]market\b/i],
  // Not "a rough number": a float's own words are no ask.
  ["ugly/rough", /\bugl(?:y|ier|iest)\b|\brough(?:er|est)?\b(?! (?:number|idea|estimate|figure|guess|read|ballpark))/i],
  ["fixers", /\bfixers?\b/i],
  ["rather not fix", /\brather (?:not fix|skip the repairs)\b|\bwon'?t want to (?:fix|update)\b|\bwithout (?:fixing|doing the repairs)\b/i],
  ["estates/rentals", /\bestates?\b|\brentals?\b/i],
  ["retail buyers", /\bretail buyers\b/i],
  ["buyer-pulse apology", /\bsorry (?:they|those|it) (?:weren'?t|wasn'?t|didn'?t)\b|\bsent you a couple(?: of)? deals\b/i],
];
export const ONCE_LAST = 3;
export const ONCE_DAYS = 30;
export const PRIOR_MAX = 6;

// How long a machine text may run. A check-in over 200 characters reads like
// a form (Matt's median is 89); a text to someone who has never written
// back is held to the first text's 160 (outreach-opener.js OPENER_MAX_CHARS);
// a check-in email's body (greeting and signature aside) stays under 120,
// Matt's 11-02 "under 100 characters" with a little room.
export const CHECK_IN_SMS_MAX = 200;
export const COLD_SMS_MAX = 160;
export const CHECK_IN_EMAIL_BODY_MAX = 120;

// Kinds the machine starts to someone who has never written back.
export const COLD_KINDS = new Set(["outreach_open", "outreach_nudge", "day_two", "cold_ladder", "agent_checkin_cold", "agent_listing_cold"]);
// Check-ins and nudges: a short text with one ask.
export const CHECK_IN_KINDS = new Set(["agent_pulse", "agent_checkin", "agent_listing", "checkin_due", "buyer_pulse", "passed_checkin",
  "address_chase", "offer_nudge", "blast_nudge", "dataroom_nudge"]);
// Answers to what they sent: no question count, no length, no spent phrases
// (they may well have used the word themselves), and "Hey, yeah" is how Matt
// answers.
export const REPLY_KINDS = new Set(["reply", "qualify_ask", "canned"]);
// Texts about a time already set (a walkthrough tomorrow): the same words
// every time are the point, so they are never read as repeating us.
export const EVENT_KINDS = new Set(["showing_reminder", "showing_followup"]);
// The texts that ask an agent or a buyer for something with nothing in
// front of them (check-ins, nudges, the agent emails): where a phrase our
// last three texts used is spent. A text about an offer or a deal may say
// "rough number" or "rental" as often as the house needs.
export const ASK_KINDS = new Set([...COLD_KINDS, ...CHECK_IN_KINDS, "outreach_email", "checkin_email", "passed_checkin", "second_look",
  "gatekeeper_text", "gatekeeper_email", "gatekeeper_checkin", ""]);

// What the later check-in branches steer by: their complaint that we sound
// like a bot, and the news a check-in must never be breezy about. Never bare
// "AI": an agent signs as "A.I." or writes "AI" for their initials.
export const AI_COMPLAINT_RX = /\bare (?:you|u) (?:a |an )?(?:bot|robot|real person|human|ai)\b|\bis this (?:an? )?(?:ai|bot|robot|automated|real person)\b|\buse better ai\b|\bchat ?gpt\b|\bautomated (?:text|message|response)s?\b|\btotally ai\b|\bthis is ai\b/i;
export const SENSITIVE_RX = /\b(?:surgery|hospital|cancer|chemo|passed away|funeral|died|death in the family|divorc(?:e|ing)|separat(?:ed|ion)|bankrupt(?:cy)?|foreclos(?:ure|ing)|behind on (?:payments|the mortgage)|lawsuit|sued|attorney|probate court|custody)\b/i;

const norm = (s) => String(s || "").replace(/[‘’]/g, "'").replace(/[“”]/g, "\"");
const bodyOf = (s) => norm(s).toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["the", "and", "any", "for", "you", "your", "that", "this", "with", "are", "was", "but", "not", "got", "have", "has", "its", "it's", "hey", "matt", "here", "again"]);
// The words a sentence says, less the little ones and the proper nouns
// (their name, their town, a street): two check-ins to Brenda about Kentwood
// share those without repeating each other.
const words = (s) => norm(s).split(/[^A-Za-z0-9']+/).filter(Boolean)
  .filter((w, i) => !(i > 0 && /^[A-Z]/.test(w)))
  .map((w) => w.toLowerCase())
  .filter((w) => w.length >= 3 && !STOP.has(w));
const sentences = (s) => norm(s).split(/(?<=[.?!])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

/**
 * openerKey(text) → "any older houses"
 *
 * How a text opens, past the greeting and their name: its first three
 * words. Two texts in a row that open alike read like a mail merge.
 */
export function openerKey(text = "") {
  const t = norm(text).toLowerCase().trim()
    .replace(/^(?:hi|hey|hello)\b[\s,]*/, "")
    .replace(/^[a-z'’-]+,\s*/, "");
  return bodyOf(t).split(" ").filter(Boolean).slice(0, 3).join(" ");
}

// The prior texts, newest first, as { text, at }.
function priorList(prior) {
  return (Array.isArray(prior) ? prior : [])
    .map((p) => (typeof p === "string" ? { text: p, at: null } : { text: String(p?.text || ""), at: p?.at || null }))
    .filter((p) => p.text.trim())
    .slice(0, PRIOR_MAX);
}

/**
 * repeatsUs(text, prior) → "" | why it repeats us
 *
 * `prior` is our last texts to them, newest first (strings or { text, at }).
 * The same body as one of them; a sentence sharing 70% or more of its words
 * with one of ours; or the same first three words as either of our last two.
 */
export function repeatsUs(text = "", prior = []) {
  const list = priorList(prior);
  if (!String(text || "").trim() || !list.length) return "";
  const body = bodyOf(text);
  if (list.some((p) => bodyOf(p.text) === body)) return "the same text we already sent them";
  for (const s of sentences(text)) {
    const a = new Set(words(s));
    if (a.size < 4) continue;
    for (const p of list) {
      for (const ps of sentences(p.text)) {
        const b = new Set(words(ps));
        if (b.size < 4) continue;
        const shared = [...a].filter((w) => b.has(w)).length;
        if (shared / a.size >= 0.7) return `a sentence we already sent them ("${ps.slice(0, 60)}")`;
      }
    }
  }
  const key = openerKey(text);
  if (key.split(" ").length >= 3 && list.slice(0, 2).some((p) => openerKey(p.text) === key)) return `opens like our last text ("${key}")`;
  return "";
}

/** groupsOf(text) → the ONCE_GROUPS keys a text uses. */
export function groupsOf(text = "") {
  const t = norm(text);
  return ONCE_GROUPS.filter(([, rx]) => rx.test(t)).map(([k]) => k);
}

/**
 * emailCore(email) → the body of an email without its greeting, sign-off,
 * opt-out line or postal address: what the length check counts.
 */
export function emailCore(email = "") {
  const paras = norm(email).replace(/\r\n/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const [i, p] of paras.entries()) {
    if (i === 0 && /^(?:hi|hey|hello)\b[^\n]{0,40},?$/i.test(p)) continue;
    // The signature: our name alone on its line, after a thanks or not.
    if (/^(?:(?:thanks|thank you|best|cheers|regards|talk soon)[,.!]?\s*\n\s*)?matt(?:hew)?(?:\s+shepherd)?[ \t]*(?:\n|$)/i.test(p)) break;
    if (/\bif you'?d rather I didn'?t email\b/i.test(p)) break;
    out.push(p);
  }
  return out.join("\n\n");
}

const toMs = (at) => {
  const t = Date.parse(at || "");
  return Number.isFinite(t) ? t : null;
};
// "Matt again" at the start of two texts running is a template; so is the
// same first name opening both.
const opensOnName = (t) => /^\s*(?:hi |hey |hello )?[A-Z][a-z'’-]+,/.test(norm(t));

/**
 * voiceFlags({ text, channel, kind, prior, machine, now }) → [{ key, level }]
 *
 * What gives a text away as a machine's. `kind` decides the length and the
 * question count ("reply" for an answer to what they sent, "qualify_ask"
 * for our two-part gut check, "day_two" for the one follow-up that may say
 * "circling back"). `prior` is our last texts to them, newest first.
 * `machine: false` (Matt's own saved texts, a person's Send) makes every
 * flag soft: shown, never blocking.
 */
export function voiceFlags({ text = "", channel = "sms", kind = "", prior = [], machine = true, now = Date.now() } = {}) {
  const raw = norm(text);
  if (!raw.trim()) return [];
  const sms = channel !== "email";
  const reply = REPLY_KINDS.has(kind);
  // Emails are compared body to body, without their frames.
  const list = priorList(prior).map((p) => (sms ? p : { ...p, text: emailCore(p.text) || p.text }));
  const flags = [];
  const add = (key, level = "hard") => { if (!flags.some((f) => f.key === key)) flags.push({ key, level }); };
  // An email is judged on its body: the greeting, the signature, the opt-out
  // line and a postal address are the frame, not the voice.
  const t = sms ? raw : emailCore(raw) || raw;

  for (const [key, rx, level] of TELLS) {
    if (!rx.test(t)) continue;
    // The one day-2 text that names their house may say it (34% replies, no
    // STOPs), once per person.
    if (key === "circling back" && kind === "day_two" && !list.some((p) => rx.test(norm(p.text)))) continue;
    add(key, level);
  }
  if (sms) for (const [key, rx] of SMS_TELLS) if (rx.test(t)) add(key);
  if (STOCK_OPENER_RX.test(t)) add(`a stock opener ("${t.trim().match(STOCK_OPENER_RX)[0].trim()}")`);
  if (!reply && BARE_GREETING_RX.test(t)) add("a greeting with no name");
  if (LEFTOVER_RX.test(t)) add("a blank nobody filled");

  if (!reply) {
    const q = (t.match(/\?/g) || []).length;
    if (sms && q > 1 && kind !== "qualify_ask" && !QUALIFY_ASK_RX.test(t)) add("two questions");
    const n = t.trim().length;
    if (sms && COLD_KINDS.has(kind) && n > COLD_SMS_MAX) add(`${n} characters, over ${COLD_SMS_MAX} for someone who hasn't written back`);
    else if (sms && CHECK_IN_KINDS.has(kind) && n > CHECK_IN_SMS_MAX) add(`${n} characters, over ${CHECK_IN_SMS_MAX} for a check-in`);
    if (!sms && kind === "checkin_email" && n > CHECK_IN_EMAIL_BODY_MAX) add(`a ${n}-character body, over ${CHECK_IN_EMAIL_BODY_MAX} for a check-in email`);
    // A phrase one of our last three texts (this month) already used on them.
    const recent = list.slice(0, ONCE_LAST).filter((p) => {
      const at = toMs(p.at);
      return at == null || now - at <= ONCE_DAYS * 86400000;
    });
    const spent = new Set(ASK_KINDS.has(kind) ? recent.flatMap((p) => groupsOf(p.text)) : []);
    for (const g of groupsOf(t)) if (spent.has(g)) add(`"${g}" again (one of our last ${ONCE_LAST} texts said it)`);
    if (list[0] && opensOnName(t) && opensOnName(list[0].text) && openerKey(t) !== openerKey(list[0].text)) add("opens on their name two texts running", "soft");
  }
  const again = EVENT_KINDS.has(kind) ? "" : repeatsUs(t, list);
  if (again) add(`repeats us: ${again}`);
  return machine ? flags : flags.map((f) => ({ ...f, level: "soft" }));
}

/** hardVoiceKeys(flags) → the keys of the hard flags. */
export const hardVoiceKeys = (flags = []) => (flags || []).filter((f) => f?.level === "hard").map((f) => f.key);

/** voiceLine(keys) → "reads like a machine: a dash, two questions" — the gate's and the hold's words. */
export const voiceLine = (keys = []) => `reads like a machine: ${keys.join(", ")}`;
export const VOICE_LINE_RX = /^(?:held: )?reads like a machine: /;

/**
 * ourLastTexts(transcript, { limit }) → [{ text, at, channel }], newest first
 *
 * Our side of the thread ("[2026-11-09 17:02] US sms: …"), texts and emails,
 * not calls: what the repeat and spent-phrase checks read.
 */
export function ourLastTexts(transcript = "", { limit = PRIOR_MAX } = {}) {
  const out = [];
  for (const line of String(transcript || "").split("\n")) {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\]\s+US\s+(sms|email|text)\b[^:]*:\s?(.*)$/i.exec(line);
    if (!m || !m[4].trim()) continue;
    out.push({ text: m[4].trim(), at: `${m[1]}T${m[2]}:00Z`, channel: m[3].toLowerCase() === "email" ? "email" : "sms" });
  }
  return out.reverse().slice(0, limit);
}

// What a saved instruction or rule teaches the bot to say: the lines it
// quotes, word for word, and two claims Matt has ruled out (we fund with a
// hard money loan, and the bot is Matt, never an assistant).
// A single quote only counts as one when it isn't an apostrophe ("it's").
const QUOTED_RX = /"([^"\n]{6,220})"|(?<![A-Za-z])'([^'\n]{6,220})'(?![A-Za-z])|“([^”\n]{6,220})”/g;
const NEGATED_RX = /\b(?:never|don'?t|do not|no|not|avoid|instead of)\b/i;
const IDENTITY_RX = /\b(?:acquisitions|dispositions) assistant\b|\bI'?m an? (?:\w+ )?assistant\b|\bmy partner will\b|\bour team will\b/i;

/**
 * savedTextFlags(text) → string[]
 *
 * Flags for something Matt saved for the bot (an instruction, a rule, an
 * example): the voice check on each line it quotes, a cash claim outside a
 * "never", and an assistant or partner the bot isn't. Shown on the page
 * beside his text; nothing of his is ever changed or dropped.
 */
export function savedTextFlags(text = "") {
  const t = norm(text);
  const out = [];
  for (const m of t.matchAll(QUOTED_RX)) {
    const line = m[1] || m[2] || m[3] || "";
    if (!/\s/.test(line.trim())) continue;
    const keys = voiceFlags({ text: line, kind: "reply" }).filter((f) => f.level === "hard").map((f) => f.key);
    for (const k of keys) out.push(`"${line.slice(0, 50)}${line.length > 50 ? "…" : ""}": ${k}`);
  }
  for (const s of sentences(t.replace(QUOTED_RX, " "))) {
    if (/\bcash\b/i.test(s) && !NEGATED_RX.test(s)) out.push(`says "cash": we fund with a hard money loan`);
    if (IDENTITY_RX.test(s) && !NEGATED_RX.test(s)) out.push(`"${s.match(IDENTITY_RX)[0]}": the bot is you, first person`);
  }
  return [...new Set(out)];
}
