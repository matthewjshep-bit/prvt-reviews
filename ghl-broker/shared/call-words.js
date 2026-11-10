// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// call-words.js — the bot never books, asks for or promises a call.
//
// Matt, 2026-11-10: "I think the bot actually booking calls has not been
// helpful. It's up to me to really call the agent so let's not have those
// scheduled calls." The audit behind it: since 10/23 the bot promised 27
// calls and 1 connected; since 10/15 it offered or confirmed 24 call slots
// and 4 connected. His pick (the audit's option a): the bot never promises,
// asks for or books a call and never names a time to talk. Where a call
// would help it says "Call me whenever, or text here.", and when someone
// asks for a call or names a time Matt gets one Slack ping (a `call_wanted`
// event, shared/slack-notify.js) and decides whether and when to call.
//
// Whatever the saved settings say:
//   - the calendar booking (shared/booking.js) is retired: no free slots are
//     read, no time is offered, nothing is booked (BOOKING_RETIRED);
//   - the call ask on an agent's first answer is retired (CALL_ASK_RETIRED);
//   - the prompts say "call me whenever" where they used to promise a call
//     (NO_CALL_RULE is fixed beside the saved playbook, so it can't drift);
//   - and, because a prompt-only rule has failed before (the 2026-11-09
//     audit), a machine text that promises, asks for or schedules a call, or
//     offers a time to talk, is held by evaluateReplyGates (callWordsFlags)
//     and written once more, told why.
//
// Pure.

export const BOOKING_RETIRED = true;
export const CALL_ASK_RETIRED = true;

// The one thing the bot says where it used to promise a call. In Matt's
// first person, no time, nothing he has to keep.
export const CALL_INVITE = "Call me whenever, or text here.";

// Fixed beside the saved playbook (ghl-broker/conversation-prompt.js), every
// party, every reply. It outranks a saved playbook line that says otherwise.
export const NO_CALL_RULE =
  "CALLS (this outranks any playbook line that says otherwise): you never promise a call, ask for one, book one or name a " +
  "time to talk. No \"I'll call you\", \"let me give you a quick call\", \"let's hop on a call\", \"what time works\", \"does " +
  "Thursday at 2 work\", \"talk at 3\", and never a calendar time. Answer what you can in the text. Where talking would " +
  `help, or they ask for a call or name a time, say they can call you whenever: "${CALL_INVITE}" Whether and when you ` +
  "call them is decided outside this conversation.";

// What they asked for that only Matt answers (shared/desk.js CALL_INTENTS).
export const CALL_WANTED_INTENTS = Object.freeze(["wants_call", "scheduling", "wants_walkthrough"]);
export const CALL_WANTED_EVENT = "call_wanted";

/* ---------- the words ---------- */

const WEEKDAY = String.raw`(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thurs?|fri)`;
const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)`;
// A day or a clock time someone could be held to.
const WHEN = String.raw`(?:${WEEKDAY}|tomorrow|today|tonight|this\s+(?:morning|afternoon|evening)|noon|${CLOCK}|at\s+\d{1,2}(?::\d{2})?)`;
// "a call", "a quick call", "a quick 5-minute call", "a phone call".
const A_CALL = String.raw`(?:a\s+|the\s+)?(?:(?:quick|short|brief)\s+)?(?:\d+[- ]?min(?:ute)?s?\s+)?(?:phone\s+|zoom\s+)?call`;
// Words of ours that put us on the hook.
const WE = String.raw`(?:i'?ll|i\s+will|we'?ll|we\s+will|let\s+me|lemme|i'?m\s+going\s+to|i'?m\s+gonna|we'?re\s+going\s+to|i\s+can|we\s+can|i\s+could|i'?d\s+like\s+to|i\s+want\s+to|happy\s+to|i'?ll\s+try\s+(?:and|to))`;

// Every party: a call from us, a call we ask for, a time to talk.
const PROMISE_RX = [
  // "I'll call you", "let me give you a quick call", "I'll give you a ring", "I can call you tomorrow", "happy to hop on"
  new RegExp(String.raw`\b${WE}\s+(?:\w+\s+){0,3}?(?:give\s+you\s+${A_CALL}|give\s+you\s+a\s+(?:quick\s+)?(?:ring|buzz)|(?:call|ring|phone)\s+you\b|be\s+(?:calling|ringing)\s+you\b|hop\s+on|jump\s+on|get\s+on\s+the\s+phone)`, "i"),
  // "…and give you a call if it makes sense", "can I give you a call?"
  new RegExp(String.raw`\bgive\s+you\s+(?:${A_CALL}\b|a\s+(?:quick\s+)?(?:ring|buzz)\b)`, "i"),
  // "Will call you back", the GHL missed-call text-back.
  /\bwill\s+call\s+(?:you\s+)?back\b/i,
  // "calling you shortly", "call you back tomorrow", "call you at 3".
  new RegExp(String.raw`\b(?:calling|ringing)\s+you\s+(?:shortly|soon|back|later|now|tomorrow|today|in\s+a\s+(?:bit|few|minute|sec))\b|\b(?:call|ring)\s+you\s+(?:back\s+)?(?:shortly|soon|later|then|tomorrow|today|tonight|this\s+(?:morning|afternoon|evening|week)|in\s+(?:a\s+(?:bit|few|minute|sec)|an\s+hour)|at\s+\d|on\s+${WEEKDAY}|${WEEKDAY})`, "i"),
  // "talk at 3", "talk tomorrow", "talk then", "chat Thursday".
  new RegExp(String.raw`\b(?:talk|chat|speak)\s+(?:to\s+you\s+|with\s+you\s+)?(?:at\s+\d|then\b|tomorrow|tonight|this\s+(?:morning|afternoon|evening)|on\s+${WEEKDAY}|${WEEKDAY}\b|in\s+(?:a\s+bit|an\s+hour|a\s+few))`, "i"),
  // "let's hop on a call", "jump on a quick call", "set up a call", "find a time to talk".
  new RegExp(String.raw`\b(?:hop|jump|get)\s+on\s+${A_CALL}\b`, "i"),
  new RegExp(String.raw`\b(?:set\s+up|schedule|book|line\s+up|arrange|find)\s+(?:${A_CALL}\b|a\s+(?:good\s+)?time\s+(?:for\s+${A_CALL}\b|to\s+(?:talk|chat|connect|speak|call)))`, "i"),
  // "let's talk", "can we chat tomorrow?"
  /\blet'?s\s+(?:talk|chat|connect|speak|hop\s+on|jump\s+on|get\s+on\s+(?:a|the)\s|set\s+up|schedule)/i,
  /\b(?:can|could|shall|should)\s+we\s+(?:talk|chat|connect|speak|hop\s+on|jump\s+on|get\s+on|do\s+a\s+(?:quick\s+)?call|set\s+up)\b/i,
  // "do you have time for a quick call", "got a minute to talk", "would a quick call work", "worth a quick call?"
  new RegExp(String.raw`\b(?:time|minutes?|a\s+(?:sec|second|minute))\s+(?:for\s+${A_CALL}\b|to\s+(?:talk|chat|connect|speak|hop\s+on|jump\s+on))`, "i"),
  new RegExp(String.raw`\b(?:would|could|does|how\s+about|what\s+about|open\s+to|up\s+for|worth)\s+${A_CALL}\b`, "i"),
  new RegExp(String.raw`\b(?:(?:quick|short|brief)\s+)?(?:\d+[- ]?min(?:ute)?s?\s+)?(?:quick\s+|phone\s+)call\s+(?:this\s+week|today|tomorrow|later|sometime|soon)\b`, "i"),
  // "go over the terms on a quick call", "walk you through it by phone".
  /\b(?:go\s+over|walk\s+(?:you\s+|them\s+)?through|talk\s+(?:it|that|this|them)?\s*(?:over|through)|discuss|sort\s+(?:it|that|this)\s+out|cover|explain|chat\s+about|run\s+through)\b[^.?!\n]{0,40}\b(?:on|by|over)\s+(?:a\s+|the\s+)?(?:quick\s+|short\s+)?(?:phone(?:\s+call)?|call)\b/i,
  // "call me at 3", "give me a call tomorrow": a time for them to keep.
  new RegExp(String.raw`\b(?:call|ring)\s+me\s+(?:back\s+)?(?:at\s+\d|tomorrow|tonight|this\s+(?:morning|afternoon|evening)|on\s+${WEEKDAY}|${WEEKDAY}\b)|\bgive\s+me\s+a\s+(?:quick\s+)?(?:call|ring)\s+(?:at\s+\d|tomorrow|tonight|this\s+(?:morning|afternoon|evening)|on\s+${WEEKDAY}|${WEEKDAY}\b)`, "i"),
  // "when's a good time to call?", "are you free for a quick call?"
  /\bgood\s+time\s+(?:to|for\s+(?:a|the))\s+(?:call|talk|chat|connect|speak|reach\s+you)\b/i,
  new RegExp(String.raw`\b(?:are|r)\s+you\s+(?:free|around|available)\s+(?:to\s+(?:talk|chat|connect|speak|hop|jump)|for\s+${A_CALL}\b)`, "i"),
];

// An agent may never be offered a time at all (COMMITMENTS: no showing,
// inspection or call time). A buyer may be invited to a deal's walkthrough
// window (Matt, 2026-09-29), so for a buyer these hold only beside a call.
const TIME_RX = [
  /\bwhat\s+(?:time|day|times|days)\s+(?:works|work|would\s+work|is\s+good|is\s+best|suits)\b/i,
  /\bwhen\s+(?:works|would\s+work|is\s+good|is\s+a\s+good\s+time|are\s+you\s+(?:free|around|available))\b|\bwhen'?s\s+(?:a\s+)?good\s+(?:time|day)\b/i,
  new RegExp(String.raw`\b(?:are|r)\s+you\s+(?:free|around|available)\s+(?:on\s+)?${WHEN}`, "i"),
  new RegExp(String.raw`\bI'?m\s+(?:free|around|available|open)\s+(?:on\s+)?(?:${WHEN}|after\s+\d|before\s+\d|all\s+day)`, "i"),
  new RegExp(String.raw`\b(?:how\s+about|how'?s|what\s+about)\s+(?:\w+\s+)?${WHEN}\b[^.?!\n]{0,20}\?`, "i"),
  new RegExp(String.raw`\b(?:does|would|will|is)\s+(?:\w+\s+){0,2}?${WHEN}\b[^.?!\n]{0,30}\b(?:work|works|good|ok|okay|suit|better|free)\b[^.?!\n]{0,30}\?`, "i"),
];
// A call in the same text, for a buyer's time words.
const CALL_WORD_RX = /\b(?:call|calls|calling|phone|talk|chat|speak|ring)\b/i;

// What they said, quoted back: their words, not a promise of ours.
const unquoted = (s) => String(s || "").replace(/"[^"\n]{1,200}"|“[^”\n]{1,200}”/g, " ");

/**
 * promisesACall(text, { party }) → the words, when a text of ours promises,
 * asks for or schedules a call, or offers a time to talk; else "".
 *
 * Never "call me whenever", "call or text anytime", "feel free to call",
 * "talk soon", or their own words in quotes. `party` "investor" lets a time
 * stand on its own (a deal's walkthrough window); beside a call it holds.
 */
export function promisesACall(text = "", { party = "agent" } = {}) {
  const t = unquoted(text);
  if (!t.trim()) return "";
  for (const re of PROMISE_RX) {
    const m = t.match(re);
    if (m) return m[0].trim();
  }
  if (party === "investor" && !CALL_WORD_RX.test(t)) return "";
  for (const re of TIME_RX) {
    const m = t.match(re);
    if (m) return m[0].trim();
  }
  return "";
}

// The start of the flag: the redraft reads it (ghl-broker/reply-agent.js
// redraftOnGate) and the Desk shows it. Short enough for the prompt's clip.
export const CALL_WORDS_FLAG_HEAD = "the draft promises, asks for or sets a time for a call";
export const CALL_WORDS_FLAG_RX = /^the draft promises, asks for or sets a time for a call\b/;
const clipWords = (s, n = 48) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** callWordsFlags(reply, { party }) → [flag] | [] — only ever adds a hold. */
export function callWordsFlags(reply = "", { party = "agent" } = {}) {
  const said = promisesACall(reply, { party });
  return said
    ? [`${CALL_WORDS_FLAG_HEAD} ("${clipWords(said)}") — never promise or set up a call or a time to talk; say "${CALL_INVITE}"`]
    : [];
}

/* ---------- what they said ---------- */

// "don't call me", "no calls please", "stop calling": not a call they want.
const NO_CALLS_RX = /\b(?:don'?t|do\s+not|never|stop|no|please\s+don'?t)\s+(?:\w+\s+)?(?:call|calls|calling|ring|phone)\b|\btext\s+only\b/i;
const ASKS_RX = [
  /\b(?:call|ring|phone)\s+me\b/i,
  /\bgive\s+me\s+a\s+(?:quick\s+)?(?:call|ring|buzz)\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:give\s+me\s+a\s+(?:quick\s+)?)?(?:call|ring|phone)\b/i,
  /\b(?:can|could|shall|should)\s+we\s+(?:talk|chat|speak|hop\s+on|jump\s+on|connect|get\s+on)\b/i,
  new RegExp(String.raw`\b(?:hop|jump|get)\s+on\s+${A_CALL}\b`, "i"),
  /\blet'?s\s+(?:talk|chat|connect|speak|hop\s+on|jump\s+on)\b/i,
  new RegExp(String.raw`\b(?:quick|short|brief)\s+(?:phone\s+)?call\b|\bphone\s+call\b|\b(?:time|minutes?)\s+(?:for\s+${A_CALL}\b|to\s+(?:talk|chat))`, "i"),
  new RegExp(String.raw`\b(?:free|around|available)\s+(?:to\s+(?:talk|chat)|for\s+${A_CALL}\b)`, "i"),
  /\b(?:i'?ll|i\s+will|let\s+me)\s+(?:\w+\s+){0,2}?(?:call|ring)\s+(?:you|u)\b/i,
  /\bwhat(?:'s|\s+is)\s+(?:a\s+)?good\s+(?:number|time)\s+to\s+(?:call|reach)\b/i,
];

/** asksForACall(text) → their words ask for a call or a time to talk. "Don't call me" doesn't. */
export function asksForACall(text = "") {
  const t = String(text || "");
  if (!t.trim() || NO_CALLS_RX.test(t)) return false;
  return ASKS_RX.some((re) => re.test(t));
}

const DAY_WORD = String.raw`(?:(?:this|next)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|(?:later\s+)?today|tonight|(?:this|next)\s+week|this\s+(?:morning|afternoon|evening)|morning|afternoon|evening|noon`;
const TIME_WORD = String.raw`(?:(?:at|around|after|before|by)\s+\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?|\d{1,2}(?::\d{2})?\s*(?:am|pm))`;
const SPAN_RX = new RegExp(String.raw`\b(?:${DAY_WORD}|${TIME_WORD})\b(?:(?:\s*,?\s*|\s+(?:or|and|to)\s+)(?:${DAY_WORD}|${TIME_WORD})\b)*`, "i");

/**
 * namedTime(text) → the day or time they named ("Thursday at 2", "after 3pm
 * tomorrow"), at most 40 characters, or "". Only the time words, never the
 * rest of what they wrote.
 */
export function namedTime(text = "") {
  const m = String(text || "").match(SPAN_RX);
  if (!m) return "";
  const t = m[0].replace(/\s+/g, " ").trim();
  return t.length > 40 ? t.slice(0, 40).trim() : t;
}

/**
 * callWanted({ party, intent, message }) → { intent, wants, when } | null
 *
 * An agent or a buyer whose text asks for a call or a walkthrough, or names
 * a time to talk: the intent the reply read, or their own words asking for
 * a call. `wants` is "walkthrough" or "call"; `when` is namedTime's.
 */
export function callWanted({ party = "", intent = "", message = "" } = {}) {
  if (party !== "agent" && party !== "investor") return null;
  const byIntent = CALL_WANTED_INTENTS.includes(intent);
  if (!byIntent && !asksForACall(message)) return null;
  if (NO_CALLS_RX.test(String(message || "")) && !byIntent) return null;
  return { intent: byIntent ? intent : "wants_call", wants: intent === "wants_walkthrough" ? "walkthrough" : "call", when: namedTime(message) };
}
