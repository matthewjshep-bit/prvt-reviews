// buyer-reply.js — what a reply to a buyer may say about a deal, read before
// it sends.
//
// The 2026-11-23 buyer audit (dispo-4, -6, -8, -11, -13): every walkthrough
// and assignment came from fast, concrete follow-through, and the machine
// lost buyers on promises and wrong answers:
//   - "pulling the package together now" went 23 hours before the link came,
//     when the deal had a package the whole time; "still waiting on the
//     park" was said three times over two days;
//   - a buyer asked a plain question (the address, the lot, beds and baths,
//     is it still available) and got the package link, or a call offer,
//     instead of the answer;
//   - "got the email, but these go out by text" went a month after deals by
//     email went live;
//   - "when can I see it?" got "I'll line it up with the agent" with no
//     window or access on the deal, and nobody lined anything up.
//
// These read the reply, their words and the deal row the bot was shown
// (ghl-broker/conversation-context.js buildInvestorContext). Each one only
// ever holds a reply for Matt: none of them lets anything send.
//
// Pure.

import { sameStreet } from "./us-address.js";

const street = (a) => String(a || "").split(",")[0].trim();

/* ---------- the package: photos, comps, the scope ---------- */

// What the package link carries (the dataroom: photos, comps, the scope).
const PACKAGE_NOUN = String.raw`(?:package|photos?|pics?|pictures?|comps|comparables|scope(?:\s+of\s+work)?|data\s?room|video|walk-?through\s+video)`;
// Words that hand it over or offer it, a little before the noun.
const PACKAGE_VERB = String.raw`(?:send(?:ing)?|text(?:ing)?|shoot(?:ing)?|shar(?:e|ing)|get(?:ting)?\s+you|grab(?:bing)?|pull(?:ing)?|put(?:ting)?\s+(?:it\s+|them\s+|those\s+)?together|attach(?:ed|ing)?|here'?s|here\s+are|want|forward(?:ing)?|drop(?:ping)?|link)`;
const OFFERS_PACKAGE_RX = [
  new RegExp(String.raw`\b${PACKAGE_VERB}\b[^.?!\n]{0,40}?\b(${PACKAGE_NOUN})\b`, "i"),
  new RegExp(String.raw`\b(${PACKAGE_NOUN})\b[^.?!\n]{0,30}?\b(?:coming|on\s+the\s+way|headed\s+your\s+way|to\s+follow|attached|below|in\s+a\s+(?:bit|sec|minute|few))\b`, "i"),
];

/**
 * offersPackage(reply) → "photos" | "package" | "comps" | … | null
 *
 * The reply hands over or offers what the package link carries: "here are
 * the photos", "want the package?", "pulling the comps together", "photos
 * coming your way". Saying the comps support a price is not an offer.
 */
export function offersPackage(reply = "") {
  const t = String(reply || "");
  for (const rx of OFFERS_PACKAGE_RX) {
    const m = rx.exec(t);
    if (m) return m[1].toLowerCase().replace(/\s+/g, " ");
  }
  return null;
}

/* ---------- promises the app can't keep ---------- */

// Ours, putting us on the hook.
const WE = String.raw`(?:i'?ll|i\s+will|we'?ll|we\s+will|let\s+me|lemme|i'?m\s+going\s+to|i'?m\s+gonna|i\s+can|we\s+can|happy\s+to|i'?ll\s+(?:try\s+(?:and|to)|get)|i'?m)`;
// Things nobody built for the bot to send: a breakdown of the comps, a bid,
// a repair estimate, the inspection, the disclosures.
const MADE_THING = String.raw`(?:breakdown|break\s+down|analysis|spreadsheet|line[-\s]item|itemi[sz]ed|bid|estimate|quote|inspection(?:\s+report)?|appraisal|survey|disclosures?|title\s+report|floor\s?plan|rent\s+roll|utility\s+bills?|permits?\s+history)`;
// Someone else whose answer we'd be waiting on.
const THIRD_PARTY = String.raw`(?:(?:the|their|his|her|my|our)\s+)?(?:listing\s+agent|seller'?s?\s+agent|agent|seller|owner|park|hoa|landlord|tenant|city|county|title|escrow|lender|inspector|contractor|management|manager|property\s+manager|builder|neighbou?r|utility|pud|surveyor)`;
const UNDELIVERABLE_RX = [
  { what: "something only you can make", rx: new RegExp(String.raw`\b${WE}\s+(?:\w+\s+){0,3}?(?:send|email|e-mail|get|put\s+together|pull\s+together|work\s+up|write\s+up|forward|have|run|draw\s+up|share)\b[^.?!\n]{0,40}?\b${MADE_THING}\b`, "i") },
  { what: "an answer from someone else", rx: new RegExp(String.raw`\b${WE}\s+(?:\w+\s+){0,2}?(?:check|ask|confirm|verify|find\s+out|hear\s+back|follow\s+up|run\s+it\s+by|touch\s+base|circle\s+back|get\s+(?:an\s+)?answer|get\s+clarity|double[-\s]check)\b[^.?!\n]{0,30}?\b(?:with|from|by)\s+${THIRD_PARTY}\b`, "i") },
  { what: "an answer from someone else", rx: new RegExp(String.raw`\b(?:waiting\s+(?:on|for|to\s+hear(?:\s+back)?\s+from)|hear(?:ing)?\s+back\s+from|once\s+i\s+hear\s+(?:back\s+)?from)\s+${THIRD_PARTY}\b`, "i") },
  { what: "an answer you'd have to go find", rx: /\b(?:let\s+me|lemme|i'?ll|i\s+will|i'?m\s+going\s+to)\s+(?:go\s+)?(?:find\s+out|look\s+into\s+(?:it|that|this)|dig\s+into\s+(?:it|that|this)|get\s+back\s+to\s+you\s+on\s+(?:that|this|it))\b/i },
  { what: "a contact the app doesn't add", rx: /\b(?:i'?ll|i\s+will|let\s+me|happy\s+to|i\s+can|we\s+can|we'?ll)\s+(?:also\s+)?(?:add|text|loop\s+in|reach\s+out\s+to|contact|send\s+(?:it|this|them|the\s+\w+)\s+(?:to|over\s+to))\s+(?:your(?!\s+(?:e-?mail|number|info|address|cell|phone))|him|her|them\s+(?:directly|too|as\s+well)|them\b)/i },
];

/**
 * undeliverablePromise(reply) → { what, phrase } | null
 *
 * A promise of something the app can't send by itself: a comp breakdown or
 * a repair bid, an answer from the agent, the seller or the park, a "let me
 * find out", a partner we'd add. Those are Matt's; the reply waits for him
 * instead of making the promise.
 */
export function undeliverablePromise(reply = "") {
  const t = String(reply || "");
  for (const { what, rx } of UNDELIVERABLE_RX) {
    const m = rx.exec(t);
    if (m) return { what, phrase: m[0].trim().slice(0, 80) };
  }
  return null;
}

/* ---------- a status line said twice ---------- */

const STATUS_RX = /\bstill\s+(?:waiting|working\s+on|checking|chasing|trying\s+to|no\s+(?:word|update|answer))\b|\bno\s+(?:update|word|news|answer)\s+yet\b|\bhaven'?t\s+heard\s+(?:back|anything)\b|\bwaiting\s+(?:on|to\s+hear|for)\s+(?:the|an?|their|his|her|word|news)\b/i;

/** statusLine(text) → true when it tells them we're still waiting on something. */
export const statusLine = (text = "") => STATUS_RX.test(String(text || ""));

export const STATUS_REPEAT_DAYS = 14;

/**
 * repeatsStatus(reply, prior, { now }) → the earlier status text | null
 *
 * `prior` is our texts to them ({ text, at }, any order). The reply says
 * we're still waiting on something and we already said one in the last two
 * weeks: a second "still waiting" is Matt's to send, or to settle.
 */
export function repeatsStatus(reply = "", prior = [], { now = Date.now() } = {}) {
  if (!statusLine(reply)) return null;
  const since = now - STATUS_REPEAT_DAYS * 86400000;
  const hit = (prior || []).find((p) => {
    const at = Date.parse(p?.at || "");
    return statusLine(p?.text) && (!Number.isFinite(at) || at >= since);
  });
  return hit ? String(hit.text).slice(0, 80) : null;
}

/* ---------- deals by email are live ---------- */

const TEXT_ONLY_RX = /\b(?:these|deals|they|it|everything|we|i)\s+(?:only\s+|all\s+)?(?:go(?:es)?\s+out|send|are\s+sent|get\s+sent|come)\s+(?:out\s+)?(?:only\s+)?(?:by|via|over|through)\s+text\b|\b(?:by|via|over)\s+text\s+only\b|\btext\s+only\b|\bonly\s+(?:send\s+\w+\s+)?(?:by|via|over|through)\s+text\b|\b(?:don'?t|do\s+not|can'?t)\s+(?:do|send)\s+(?:deals\s+(?:by|over|via)\s+)?e-?mails?\b|\bnot\s+(?:by|over|via)\s+e-?mail\b/i;

/** saysTextOnly(reply) → true when it tells a buyer deals only go out by text. */
export const saysTextOnly = (reply = "") => TEXT_ONLY_RX.test(String(reply || ""));

/* ---------- their literal question, from the deal record ---------- */

// A sentence that asks: a question mark, or a question word at its start.
const ASKS_RX = /\?\s*$|^\s*(?:what|what'?s|how|is|are|does|do|did|when|where|any|can|could|got|has|have|was|whats)\b/i;
const sentences = (t) => String(t || "").split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

// What a buyer asks before deciding, and where the deal row holds it.
export const BUYER_FACTS = Object.freeze([
  { key: "address", label: "the address", rx: /\baddress\b|\bwhere\s+(?:is|exactly\s+is)\s+(?:it|this|that|the\s+(?:house|property|place|lot))\b|\bwhat\s+street\b|\bcross\s+streets?\b/i },
  { key: "beds", label: "beds and baths", rx: /\bhow\s+many\s+(?:bed|bath|br\b|bd\b)|\b(?:bed|bedroom)s?\s*(?:\/|and|&)\s*(?:bath|bathroom)s?\b|\bbd\s*\/\s*ba\b|\b(?:beds?|baths?|bedrooms?|bathrooms?)\s*\?/i },
  { key: "sqft", label: "the square footage", rx: /\bsq(?:uare)?\.?\s*f(?:ee)?t\b|\bsqft\b|\bsquare\s+footage\b|\bhow\s+big\s+is\s+(?:the\s+)?(?:house|home|place|it)\b/i },
  { key: "lot", label: "the lot size", rx: /\blot\s+(?:size|sqft|square|dimensions?)\b|\bhow\s+big\s+is\s+the\s+lot\b|\bsize\s+of\s+the\s+lot\b|\bhow\s+many\s+acres\b|\bacreage\b/i },
  { key: "year", label: "the year it was built", rx: /\byear\s+built\b|\bwhat\s+year\b|\bwhen\s+was\s+(?:it|the\s+house)\s+built\b|\bhow\s+old\s+is\s+(?:it|the\s+house)\b/i },
  { key: "available", label: "whether it's still available", rx: /\bstill\s+(?:available|on|there|for\s+sale|open|have\s+it)\b|\bis\s+it\s+(?:available|gone|sold|taken)\b|\bdid\s+it\s+sell\b|\bstill\s+got\s+it\b/i },
  { key: "basement", label: "the basement", rx: /\bbasement\b|\bceiling\s+height\b/i },
  { key: "alley", label: "alley access", rx: /\balley\b/i },
  { key: "garage", label: "the garage or parking", rx: /\bgarage\b|\bparking\b|\bdriveway\b/i },
  { key: "sewer", label: "septic or sewer", rx: /\bseptic\b|\bsewer\b/i },
  { key: "zoning", label: "the zoning", rx: /\bzon(?:ed|ing)\b/i },
  { key: "occupancy", label: "whether it's vacant", rx: /\bvacant\b|\boccupied\b|\btenants?\b|\bsomeone\s+living\b|\banyone\s+(?:living|live)\b/i },
]);

/** factsAsked(text) → [{ key, label }] the questions in their words, in the list's order. */
export function factsAsked(text = "") {
  const asks = sentences(text).filter((s) => ASKS_RX.test(s));
  if (!asks.length) return [];
  return BUYER_FACTS.filter((f) => asks.some((s) => f.rx.test(s))).map(({ key, label }) => ({ key, label }));
}

const factText = (deal) => (deal?.facts || []).join(" ").toLowerCase();

/**
 * factOnFile(key, deal) → true when the deal row the bot was shown answers it.
 *
 * `deal` is a buildInvestorContext deal row: address, size ({ beds, baths,
 * sqft, year, lotSqft, zoning }), facts (septic, garage, the street, an
 * easement), occupancy, stage. Whether it's available is always known: the
 * row is a live deal, or the bot was told it's gone.
 */
export function factOnFile(key, deal = null) {
  if (!deal) return false;
  const size = deal.size || {};
  const facts = factText(deal);
  switch (key) {
    case "address": return /^\s*\d/.test(String(deal.address || ""));
    case "beds": return Number(size.beds) > 0;
    case "sqft": return Number(size.sqft) > 0;
    case "lot": return Number(size.lotSqft) > 0 || Boolean(deal.lot);
    case "year": return Number(size.year) > 1500;
    case "available": return true;
    case "basement": return /basement/.test(facts);
    case "alley": return /alley/.test(facts);
    case "garage": return /garage|parking|driveway/.test(facts);
    case "sewer": return /septic|sewer/.test(facts);
    case "zoning": return Boolean(String(size.zoning || "").trim()) || /zon/.test(facts) || /zoned/.test(String(deal.lot || ""));
    case "occupancy": return Boolean(deal.occupancy);
    default: return false;
  }
}

/* ---------- when can I see it ---------- */

const WALK_ASK_RX = [
  /\bwhen\s+(?:can|could|would)\s+(?:i|we|my\s+\w+)\s+(?:see|get\s+in(?:to)?|walk|tour|look\s+at|go\s+(?:see|look|by|through)|check\s+(?:it|out))\b/i,
  /\b(?:can|could)\s+(?:i|we)\s+(?:see|get\s+in(?:to)?|walk|tour|go\s+(?:see|through)|check\s+out)\s+(?:it|inside|the\s+(?:inside|house|place|property|home))\b/i,
  /\b(?:how|when)\s+(?:do|can|could|would)\s+(?:i|we)\s+(?:get\s+in(?:side)?|see\s+(?:it|inside)|access)\b|\b(?:can|could)\s+(?:i|we)\s+get\s+in(?:side)?\b/i,
  /\b(?:walk|tour|see|look\s+at)\s+(?:it|the\s+(?:house|place|property|inside))\s+(?:on\s+)?(?:today|tonight|tomorrow|this\s+(?:week|weekend|morning|afternoon|evening)|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)\b/i,
  /\b(?:any|is\s+there)\s+(?:access|showings?|walk-?throughs?)\b|\bwhen\s+(?:is|are)\s+(?:the\s+)?(?:showings?|walk-?throughs?|open\s+house)\b|\blockbox\b/i,
];

/** walkAsk(text) → true when they ask when or how they can see the house. */
export const walkAsk = (text = "") => WALK_ASK_RX.some((rx) => rx.test(String(text || "")));

/* ---------- the gate ---------- */

// Flags a rewrite can't fix: the reply waits whatever it says, so the
// redraft (reply-agent.js redraftOnGate) is not spent on them.
export const FACT_NOT_ON_FILE = "the deal record doesn't have it";
export const NO_WALK_ON_FILE = "no walkthrough window or access is on the deal";
export const SITUATION_FLAG_RX = new RegExp(`${FACT_NOT_ON_FILE}|${NO_WALK_ON_FILE}`);

/**
 * buyerReplyFlags({ reply, inbound, deal, prior, mattSent, now }) → string[]
 *
 *   reply     the draft's words
 *   inbound   their words since our last text
 *   deal      the deal row the reply is about (buildInvestorContext), or null
 *   prior     our texts to them, { text, at }
 *   mattSent  { minutesAgo } when Matt sent them photos or a link by hand in
 *             the last two hours (reply-agent.js handLines), else null
 *
 * Every flag holds the reply for Matt; none lets anything send.
 */
export function buyerReplyFlags({ reply = "", inbound = "", deal = null, prior = [], mattSent = null, now = Date.now() } = {}) {
  const flags = [];
  const text = String(reply || "");
  if (!text.trim()) return flags;
  const where = street(deal?.address) || "the house";
  const promise = undeliverablePromise(text);
  if (promise) flags.push(`the draft promises ${promise.what} ("${promise.phrase}") — the app can't send that, so it's yours to answer`);
  const pkg = offersPackage(text);
  if (pkg && mattSent) {
    flags.push(`you sent them photos or a link ${mattSent.minutesAgo} minutes ago — the bot doesn't send the ${pkg} again`);
  } else if (pkg && deal && !deal.packageReady) {
    flags.push(`the draft offers the ${pkg} on ${where} and there's no package built for it — build it on the deal, or answer yourself`);
  }
  const again = repeatsStatus(text, prior, { now });
  if (again) flags.push(`the draft says we're still waiting a second time (we already said "${again}") — yours to send or settle`);
  if (saysTextOnly(text)) flags.push("the draft says deals only go out by text — deals go by email too; turn on Deals by email for them instead");
  if (deal) {
    const missing = factsAsked(inbound).filter((f) => !factOnFile(f.key, deal));
    if (missing.length) flags.push(`they asked ${missing.map((f) => f.label).join(" and ")} on ${where} and ${FACT_NOT_ON_FILE} — answer it yourself`);
    if (walkAsk(inbound) && !deal.walkOnFile) flags.push(`they asked when they can see ${where} and ${NO_WALK_ON_FILE} — set it, or answer yourself`);
  }
  return flags;
}

/**
 * dealRowFor(deals, address) → the deal row a reply is about, or null
 *
 * `deals` is buildInvestorContext's { linked, matching }. The house the
 * draft names, else the only deal they're on.
 */
export function dealRowFor(deals = null, address = "") {
  const linked = deals?.linked || [];
  const all = [...linked, ...(deals?.matching || [])];
  if (address) {
    const named = all.find((d) => d?.address && sameStreet(d.address, address));
    if (named) return named;
  }
  return linked.length === 1 ? linked[0] : null;
}

/* ---------- Matt in the thread ---------- */

// The bot stands aside in a buyer thread Matt texted or called in the last
// hour (the 2026-11-23 buyer audit, dispo-11: "pulling those photos together
// now" went 55 minutes after Matt sent the photo link, past the 45-minute
// stand-aside), and never sends photos or a link he sent in the last two.
export const BUYER_HUMAN_ACTIVE_MIN = 60;
export const BUYER_HAND_LINK_MIN = 120;
const HAND_LINK_RX = /https?:\/\/|www\.|\b(?:photos?|pics?|pictures?|package|video|link)\b/i;

// The package text the app sends itself (ghl-broker/dataroom.js
// inviteMessage): "Hi Dana, here's the package on 1820 Alder Way …". Not
// Matt's hand, so it neither makes the bot stand aside nor stops a link.
export const PACKAGE_INVITE_RX = /^(?:hi\s+[^,\n]{1,40},\s+)?here'?s\s+the\s+package\s+on\b/i;

/** handSentLink(text) → true when a text of Matt's carried a link or photos. */
export const handSentLink = (text = "") => HAND_LINK_RX.test(String(text || ""));

/* ---------- a partner they want deals sent to ---------- */

// The 2026-11-23 buyer audit (dispo-13): a buyer gave their partner's email
// in August and the partner still had no deals in November; the bot said
// "these go out by text". Matt adds them; nothing texts or adds a stranger.
const PARTNER_REL = String.raw`(?:business\s+partner|investor\s+partner|partners?|wife|husband|spouse|acquisitions?\s+(?:manager|guy|person|lead|director|team|specialist)|dispo(?:sitions?)?\s+(?:manager|guy|person|lead)|associate|colleague|assistant|teammate|son|daughter|brother|sister)`;
const REL_RX = new RegExp(String.raw`\b(?:my|our)\s+(${PARTNER_REL})\b`, "i");
const NAME_AFTER_RX = /^\s*,?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/;
const NOT_A_NAME = new Set("Thanks Thank Please He She They Also And But We I Too Is Was Will Would Can Could On In At If So".split(" "));
// They want deals to reach that person.
const SEND_THEM_RX = /\b(?:send|sending|add|include|cc|copy|loop\s+in|forward|text|email|e-mail|reach\s+out\s+to|contact|put\s+(?:him|her|them)\s+on|on\s+(?:the|your)\s+list)\b/i;
const EMAIL_IN_RX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_IN_RX = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

/**
 * buyerReferral(text) → { name, relation, email, phone } | null
 *
 * A buyer naming someone on their side who should get our deals: "send it
 * to my partner Jo too", "add my acquisitions manager". Checking with a
 * partner ("I'll run it by my partner") is not one.
 */
export function buyerReferral(text = "") {
  for (const s of sentences(text)) {
    const m = REL_RX.exec(s);
    if (!m) continue;
    const email = (s.match(EMAIL_IN_RX) || [])[0] || "";
    const phone = (s.match(PHONE_IN_RX) || [])[0] || "";
    if (!SEND_THEM_RX.test(s) && !email && !phone) continue;
    if (/\b(?:run\s+it\s+by|check\s+with|talk\s+(?:it\s+over\s+)?with|ask)\s+(?:my|our)\b/i.test(s) && !email && !phone) continue;
    const after = NAME_AFTER_RX.exec(s.slice(m.index + m[0].length));
    const name = after && !NOT_A_NAME.has(after[1].split(" ")[0]) ? after[1] : "";
    return { name, relation: m[1].toLowerCase().replace(/\s+/g, " "), email, phone };
  }
  return null;
}
