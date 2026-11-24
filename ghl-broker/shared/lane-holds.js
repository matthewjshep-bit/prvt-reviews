// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// lane-holds.js — two replies to an agent that wait for Matt instead of going.
//
// The 2026-11-23 audit read six months of agent threads. Two kinds of reply
// cost us houses the agent was handing us:
//
//   lane decline  "That's outside our lane… not land development." One of
//                 those went to an agent whose land became a ~$4M contract
//                 only because Matt followed up by hand (R7 / neg-8). Land,
//                 a lot, a teardown, a multi-unit or a development site is
//                 Matt's to look at (single-family focus 10-01: non-SFR is
//                 held for him; luxury lots: he prices every one). The bot
//                 never says no to one.
//   close-out     "Keep me in mind if anything rougher comes up", "sounds
//                 lighter than what we usually go for", sent to a text that
//                 named a house, an address, a link, a price or the work it
//                 needs (R11). One agent answered "use better AI". A text
//                 that says the house is turnkey or cosmetic still gets the
//                 pass (Matt, 2026-10-16 / 10-22): that is the rule working.
//
// Pure. evaluateReplyGates (ghl-broker/reply-agent.js) reads the flags; a
// lane decline is never rewritten (redraftOnGate) and lands in Needs Matt
// as an answer only he has (shared/needs-matt.js). Every check only adds a
// hold.

import { saysWePass, namesAPrice } from "./promise-owed.js";
import { ourReplyPasses, flipRead, saysTurnkey, saysCosmeticOnly, workBudgetIn } from "./flip-read.js";
import { housesInText } from "./mentioned-houses.js";
import { saysTurnkey as saysNotAFlip } from "./held-underwrites.js";

/* ---------- land, lots, teardowns, multi-unit, development ---------- */

const KINDS = String.raw`(?:(?:vacant|raw|bare)\s+)?(?:land(?:\s+development)?|lots?|teardowns?|tear[\s-]?downs?|development(?:\s+(?:deals?|sites?|projects?))?|multi[\s-]?(?:family|units?)|duplex(?:es)?|triplex(?:es)?|four[\s-]?plex(?:es)?|fourplex(?:es)?|plexes|apartments?|new\s+construction|builds?|subdivisions?)`;
const LANE_DECLINE = [
  // "outside our lane", "not my lane", "out of our wheelhouse"
  /\b(?:outside(?:\s+of)?|not(?:\s+really)?(?:\s+in)?|isn'?t(?:\s+really)?(?:\s+in)?|out\s+of)\s+(?:our|my)\s+(?:lane|wheelhouse|niche|buy\s*box|wheel\s*house)\b/i,
  /\b(?:our|my)\s+lane\b[^.?!]{0,20}\b(?:isn'?t|is\s+not|not)\b/i,
  // "we don't do land", "not doing teardowns", "aren't buying lots"
  new RegExp(String.raw`\b(?:we|i)\s+(?:don'?t|do\s+not|can'?t|cannot|aren'?t|are\s+not|am\s+not|'?re\s+not|won'?t)\s+(?:really\s+)?(?:do(?:ing)?|buy(?:ing)?|take\s+on|touch|go\s+after|pursue|look\s+at|get\s+into)\s+(?:any\s+|much\s+)?${KINDS}\b`, "i"),
  new RegExp(String.raw`\bnot\s+(?:doing|buying|taking\s+on|into)\s+(?:any\s+)?${KINDS}\b`, "i"),
  // "not land development", "not a teardown buyer", "not a land buyer"
  new RegExp(String.raw`\bnot\s+(?:a\s+|an\s+)?${KINDS}(?:\s+(?:buyers?|investors?|guys?|people|folks))?\b(?!\s+(?:on|in|at|of|near|next|by)\b)`, "i"),
  new RegExp(String.raw`\b${KINDS}\s+(?:isn'?t|aren'?t|is\s+not|are\s+not)\s+(?:really\s+)?(?:our|my|what\s+(?:we|i))\b`, "i"),
  // "we only buy single-family", "we stick to houses"
  /\b(?:we|i)\s+(?:only|just|mainly|mostly|strictly)\s+(?:do|buy|focus\s+on|stick\s+(?:to|with)|go\s+after)\s+(?:single[\s-]family|sfrs?|houses|homes)\b/i,
  /\b(?:we(?:'re|\s+are)|i'?m)\s+not\s+(?:a\s+|an\s+)?(?:land\s+)?(?:developers?|builders?|land\s+buyers?)\b/i,
];

/** declinesLane(reply) → the words, when our reply turns down land, a lot, a teardown, a multi-unit or a development site; else "". */
export function declinesLane(reply = "") {
  const t = String(reply || "");
  for (const re of LANE_DECLINE) {
    const m = t.match(re);
    if (m) return m[0].trim();
  }
  return "";
}

// What they offered, in their words. "A lot of work" and "lot size" are not lots, and "where
// would you land" is not land.
// Acreage alone is not one: most listings say what the house sits on.
const LANE_OFFER = [
  ["land", /\b(?:vacant|raw|bare|buildable|developable|the|some|this|that)\s+land\b|\bland\s+(?:deal|parcel|for\s+sale|opportunity|development|only|value|play)\b/i],
  ["a lot", /\b(?:vacant|empty|raw|bare|buildable|open|double|platted|separate|extra|adjacent)\s+lots?\b|\b(?:two|three|four|five|several|a\s+few|\d+)\s+lots\b|\blots?\s+(?:for\s+sale|next\s+door|behind)\b|\bthe\s+lot\s+(?:is|next|behind|alone)\b|\bshort[\s-]?plat\b|\bsubdivid\w*/i],
  ["a teardown", /\btear[\s-]?downs?\b|\bknock[\s-]?downs?\b|\bscraper\b|\b(?:a|it'?s\s+a|basically\s+a)\s+scrape\b|\bland\s+value\b/i],
  ["a multi-unit", /\bmulti[\s-]?(?:family|units?)\b|\bduplex(?:es)?\b|\btriplex(?:es)?\b|\bfour[\s-]?plex(?:es)?\b|\b\d+[\s-]?plex\b|\b\d{1,3}[\s-]units?\b|\bapartment\s+(?:building|complex)\b|\bmixed[\s-]use\b/i],
  ["a development site", /\bdevelopment\s+(?:site|opportunity|potential|parcel|deal|project|land)\b|\bdevelopable\b|\bdevelopers?\b|\bassemblage\b|\bzoned\s+(?:for\s+)?(?:multi|townho|commercial)|\bcottage\s+(?:housing|site)\b|\btownhome\s+site\b|\bbuild\s+(?:\d+|two|three|four|several)\s+(?:homes|houses|units|townhomes)\b/i],
  // Seattle's zoning codes, in capitals.
  ["a development site", /\b(?:LR[123]|NR[123]|RSL|MR)\b/],
];

/** offersLane(inbound) → what they offered ("land", "a lot", "a teardown", "a multi-unit", "a development site"), or "". */
export function offersLane(inbound = "") {
  const t = String(inbound || "");
  for (const [what, re] of LANE_OFFER) if (re.test(t)) return what;
  return "";
}

// Fed to the hold, never to a rewrite: Matt looks at it.
export const LANE_HOLD_FLAG = "the draft turns down land, a lot, a teardown, a multi-unit or a development site — never the bot's no; Matt looks at those himself";
export const LANE_HOLD_RX = /^the draft turns down land, a lot, a teardown/;

/**
 * laneHoldFlags({ reply, inbound }) → [LANE_HOLD_FLAG] | []
 *
 * Our reply says land, lots, teardowns, multi-units or development aren't
 * our lane; or their text offers one and our reply passes on it.
 */
export function laneHoldFlags({ reply = "", inbound = "" } = {}) {
  const r = String(reply || "");
  if (!r.trim()) return [];
  if (declinesLane(r)) return [LANE_HOLD_FLAG];
  if (offersLane(inbound) && (ourReplyPasses(r) || saysWePass(r))) return [LANE_HOLD_FLAG];
  return [];
}

/* ---------- the canned close-out on a house they handed us ---------- */

// Our brush-offs, canned (shared/flip-read.js QUALIFY_PASSES, QUALIFY_CLOSED,
// reply-agent.js NOT_OUR_KIND_REPLY) or the model's own.
const CLOSE_OUT = [
  /\bkeep\s+(?:me|us)\s+in\s+mind\b/i,
  /\banything\s+rougher\b|\bgot\s+anything\s+rougher\b|\brougher\s+(?:comes\s+up|on\s+your\s+end|in\s+the\s+pipeline)\b/i,
  /\blighter\s+than\s+(?:what\s+)?(?:we|i)\s+(?:usually\s+)?go\s+for\b/i,
  /\btoo\s+(?:clean|nice|finished|turnkey)\s+for\s+(?:me|us)\b|\bsounds?\s+(?:a\s+bit\s+)?too\s+(?:clean|nice|finished)\b/i,
  /\bnot\s+(?:quite\s+)?distressed\s+enough\b|\bmore\s+finished\s+than\s+(?:I|we)\s+go\s+for\b|\bin\s+good\s+shape\s+already\b/i,
];

/** closesOut(reply) → the words, when our reply is a brush-off close; else "". */
export function closesOut(reply = "") {
  const t = String(reply || "");
  for (const re of CLOSE_OUT) {
    const m = t.match(re);
    if (m) return m[0].trim();
  }
  return "";
}

// "In great shape", "excellent condition": the agent's word that it's done.
const FINE_SHAPE_RX = /\b(?:great|excellent|perfect|immaculate|pristine|beautiful|amazing|mint)\s+(?:shape|condition)\b/i;
/** saysItsDone(text) → the agent told us the house needs nothing, or only cosmetics. */
export function saysItsDone(text = "") {
  const t = String(text || "");
  return saysTurnkey(t) || saysNotAFlip(t) || FINE_SHAPE_RX.test(t) || saysCosmeticOnly(t, { agentRehab: workBudgetIn(t) });
}

const LINK_RX = /https?:\/\/|\bwww\.|\bredf\.in\b|\bzillow\b|\bredfin\b|\brealtor\.com\b|\bmatrix\.\w+|\bnwmls\b|\bmls\s*#?\s*\d{5,}/i;

/**
 * namesTheHouse(inbound, { address }) → what their text gave us ("another
 * house", "a link", "an address", "a price", "the work it needs"), or "".
 *
 * A text that says the house is turnkey or cosmetic gives us its answer:
 * only another house or a link counts then.
 */
export function namesTheHouse(inbound = "", { address = "" } = {}) {
  const t = String(inbound || "");
  if (!t.trim()) return "";
  if (address && housesInText({ message: t, except: [address] }).some((h) => !h.needsAddress)) return "another house";
  if (LINK_RX.test(t)) return "a link";
  const agentRehab = workBudgetIn(t);
  if (saysItsDone(t)) return "";
  if (housesInText({ message: t }).some((h) => !h.needsAddress)) return "an address";
  if (namesAPrice(t)) return "a price";
  const read = flipRead(t, { agentRehab });
  if (agentRehab > 0 || read.strong.length || read.major.length) return "the work it needs";
  return "";
}

export const CLOSE_OUT_RX = /^the draft brushes off a house they handed us/;

/**
 * closeOutFlags({ reply, inbound, address }) → [flag] | []
 *
 * A brush-off close ("keep me in mind", "sounds lighter than what we go
 * for") to a text that named a house, an address, a link, a price or the
 * work: held. The rewrite asks for the address or the details instead.
 */
export function closeOutFlags({ reply = "", inbound = "", address = "" } = {}) {
  const said = closesOut(reply);
  if (!said) return [];
  const gave = namesTheHouse(inbound, { address });
  return gave ? [`the draft brushes off a house they handed us ("${said}") — their text gave ${gave}; ask for the address or the details instead, never a canned close`] : [];
}
