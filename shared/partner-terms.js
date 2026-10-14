// partner-terms.js — an agent offering to work together, on terms.
//
// 2026-10-14, reading 2,014 threads: about 17 agents offered us a working
// relationship and the bot answered "keep me in mind". They asked whether we
// do list-backs, offered to be our buyer's agent or needed a buyer agency
// agreement first, asked about a referral, finder's or buyer broker fee, sent
// deals to a wholesaler's list, or said they buy themselves. These are the
// best relationships we have, and the terms are Matt's to answer: the reply
// is held for him, with a Desk row that names what they offered
// (shared/call-list.js call_partner_terms).
//
// A backstop beside the model, not in its schema: the reply's JSON format is
// part of the cached prompt, and a new intent re-writes the cache for every
// draft. Their words, never ours — a reaction quoting our text ("Liked
// “…referrals coming…”") is stripped first.
//
// Pure.

// Strongest first: what the row leads with when they said more than one.
export const PARTNER_TERMS_KINDS = ["list_back", "buyer_agent", "referral_fee", "co_wholesale", "investor_buyer"];

export const PARTNER_TERMS_LABEL = {
  list_back: "asked about a list-back",
  buyer_agent: "offered to be our buyer's agent",
  referral_fee: "asked about a referral fee or a commission",
  co_wholesale: "offered to work deals together",
  investor_buyer: "said they buy",
};

const NOT = "(?<!\\b(?:can'?t|cannot|won'?t|not|don'?t want to|do not want to|unable to|couldn'?t)\\s(?:\\w+\\s)?)";
const AGENT = "buyer'?s?'?\\s+(?:agent|broker|rep(?:resentative)?)";

const PATTERNS = {
  list_back: [
    "list[\\s-]?backs?",
    "list(?:ing)?\\s+(?:it\\s+)?back\\s+with\\s+(?:me|us|you)",
    "back[\\s-]?end\\s+listing",
    // The relist once it's done, never the seller's own relist.
    "relist\\s+agreement",
    "relist(?:ing)?\\s+(?:the\\s+property\\s+|it\\s+)?(?:once|when|after)\\s+(?:it'?s\\s+|you'?re\\s+)?(?:flipped|done|finished|fixed|complete)",
    "\\d(?:\\.\\d)?\\s?%\\s+on\\s+the\\s+relist",
    "(?:help\\s+you|love\\s+to|happy\\s+to|i'?d|i\\s+can|i\\s+could)\\s+(?:help\\s+(?:you\\s+)?)?(?:with\\s+(?:a|the)\\s+\\w+\\s+and\\s+)?list\\s+it(?:\\s+(?:for\\s+you|after|when|once))?",
    "list(?:ed)?\\s+(?:it\\s+)?for\\s+you(?:\\s+guys)?\\s+(?:when|once|after)",
    "(?:one|an?)\\s+agent\\s+or\\s+(?:several|multiple|a\\s+few|many)",
    "who\\s+do\\s+you\\s+(?:use\\s+to\\s+)?(?:list|sell)\\s+your\\s+(?:flips|resales?)",
  ],
  buyer_agent: [
    `${NOT}(?:represent|rep)\\s+you(?!r)`,
    // "with me representing you", "I will be representing you?" — never
    // "an agent representing you should…" or "anyone representing you".
    "(?:me|us|our\\s+team|i(?:'ll|\\s+will|\\s+would|\\s+can|\\s+could)?\\s+be)\\s+representing\\s+you(?!r)",
    `(?:be|act\\s+as|serve\\s+as|considered)\\s+your\\s+${AGENT}`,
    "buyer'?s?'?\\s+(?:agency|brokerage|broker|representation)\\s+(?:agreement|form|contract)",
    "buyer\\s+agency(?!\\s+commission)",
  ],
  referral_fee: [
    "finder'?s?\\s+fees?",
    "referral\\s+fees?",
    "(?:pay|paying|offer|offering)\\s+(?:a\\s+|for\\s+)?referrals?",
    "how\\s+do\\s+you\\s+handle\\s+referrals",
    "looking\\s+for\\s+referrals",
  ],
  co_wholesale: [
    "(?:my|our)\\s+(?:wholesale|wholesaler|wholesaling|dispo)\\s+(?:partners?|contacts?|clients?|list|buyers?|team)",
    "dispo\\s+partner",
    "i'?m\\s+(?:also\\s+)?a\\s+wholesaler",
    "deal\\s+(?:community|club|group)",
    "jv\\b|joint\\s+venture|co[\\s-]?wholesal\\w*",
    "split\\s+the\\s+(?:fee|assignment|spread)",
  ],
  investor_buyer: [
    "(?:i|we)\\s+(?:can|could|would|will)\\s+pay\\s+(?:a|an|the|you\\s+a)?\\s*\\$?\\d+(?:\\.\\d+)?\\s?k?\\s+(?:assignment|finder)",
    "pay\\s+(?:an?\\s+)?assignment\\s+fee",
    "(?:we|i)\\s+(?:also\\s+)?buy\\s+\\d+\\s+(?:to|-)\\s+\\d+\\s+(?:a|per)\\s+(?:month|year)",
    "i\\s+(?:also\\s+)?(?:flip|invest\\s+in|buy)\\s+(?:houses|homes|properties|fixers)",
    "(?:been\\s+wanting|want(?:ing)?|looking)\\s+to\\s+(?:take\\s+on|do)\\s+a\\s+flip",
    "add\\s+me\\s+to\\s+your\\s+(?:buyers?|investor|cash\\s+buyer)s?\\s+list",
  ],
};

// A commission only when they ask us about it: "would you be waiving buyer
// broker commission?", "are you willing to do 3% on your end for me?". Said
// as a fact of the deal ("410k with no buyer agent commission", "remove the
// buyer's agent compensation") it's the offer's terms, not theirs to us.
const ASKED = {
  referral_fee: [
    `${AGENT}\\s+(?:fee|commission|compensation|comp|incentive)s?`,
    "buyers?'?\\s+agents?'?\\s+(?:fee|commission|compensation|comp)s?",
    "buyer'?s?'?\\s+commission",
    "commission\\s+(?:to|for)\\s+(?:the\\s+)?buyer'?s?\\s+(?:side|agent)",
    "(?:you|your|u)\\b[^.!?]{0,40}\\bcommission|\\bcommission\\b[^.!?]{0,40}\\b(?:you|your|u)\\b",
  ],
};

const rx = (list, flags = "i") => new RegExp(list.map((p) => `\\b(?:${p})`).join("|"), flags);
const RX = Object.fromEntries(Object.entries(PATTERNS).map(([k, list]) => [k, rx(list)]));
const ASKED_RX = Object.fromEntries(Object.entries(ASKED).map(([k, list]) => [k, rx(list, "gi")]));

// "a wholesale deal … happy to work together on a different deal": the
// together only counts beside the wholesale.
const TOGETHER_RX = /\b(?:work|working|partner|team)\s+(?:together|up|with\s+you)\b/i;
const WHOLESALE_RX = /\bwholesal\w*/i;
const NOT_WHOLESALE_RX = /\bnot\s+a\s+wholesale|\b(?:enough|greedy|no|hate)\s+wholesalers?\b|\bwith\s+a\s+wholesaler\b/i;

// An iMessage reaction quotes OUR text: "Liked “…”", "👍 to “…”", "Reacted 💪 to “…”".
const REACTION_RX = /(?:\b(?:Liked|Loved|Laughed at|Emphasi[sz]ed|Disliked|Questioned|Le gustó|Le encantó)|\bReacted\s*\S*\s*to|\S{1,4}\s*to)\s*“[^”]*”/gu;

const EMAIL_RX = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_RX = /\+?1?[\s.-]?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const URL_RX = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

/** theirWords(text) → the text without our quoted words, links, phones or emails. */
export function theirWords(text = "") {
  return String(text || "").replace(REACTION_RX, " ").replace(URL_RX, " ").replace(EMAIL_RX, " ").replace(PHONE_RX, " ").replace(/\s+/g, " ").trim();
}

// Where the sentence around a match starts and ends.
function sentenceBounds(text, index, length) {
  const starts = [...text.slice(0, index).matchAll(/[.!?]\s+/g)];
  const from = starts.length ? starts.at(-1).index + starts.at(-1)[0].length : 0;
  const end = text.slice(index + length).search(/[.!?](?:\s|$)/);
  return { from, to: end < 0 ? text.length : index + length + end + 1 };
}
const sentenceOf = (text, index, length) => { const { from, to } = sentenceBounds(text, index, length); return text.slice(from, to).trim(); };

// The sentence the match sits in, cut to `max` around it.
function phraseAround(text, index, length, max = 120) {
  const { from, to } = sentenceBounds(text, index, length);
  let s = text.slice(from, to).trim();
  if (s.length > max) {
    const at = index - from;
    const lo = Math.max(0, Math.min(at - 40, s.length - max));
    s = `${lo > 0 ? "…" : ""}${s.slice(lo, lo + max - 2).trim()}…`;
  }
  return s;
}

/**
 * partnerTerms(text) → { kind, phrase, kinds, addToBuyers } | null
 *
 *   kind         the strongest kind they offered (PARTNER_TERMS_KINDS order)
 *   phrase       their sentence that says it, ≤120 chars, no phone/email/link
 *   kinds        every kind heard, strongest first
 *   addToBuyers  they said they buy: the row says "add to the buyer list"
 */
export function partnerTerms(text = "") {
  const words = theirWords(text);
  if (!words) return null;
  const hits = [];
  for (const kind of PARTNER_TERMS_KINDS) {
    let m = words.match(RX[kind]);
    if (!m && ASKED_RX[kind]) m = [...words.matchAll(ASKED_RX[kind])].find((x) => sentenceOf(words, x.index, x[0].length).endsWith("?")) || null;
    if (!m && kind === "co_wholesale" && WHOLESALE_RX.test(words) && !NOT_WHOLESALE_RX.test(words)) m = words.match(TOGETHER_RX);
    if (m) hits.push({ kind, m });
  }
  if (!hits.length) return null;
  const lead = hits[0];
  return {
    kind: lead.kind,
    phrase: phraseAround(words, lead.m.index, lead.m[0].length),
    kinds: hits.map((h) => h.kind),
    addToBuyers: hits.some((h) => h.kind === "investor_buyer"),
  };
}

// What the held draft is told (the reply's user context, not the cached
// prompt): answer what they offered, in plain words, and leave the terms to
// Matt — he sends it.
const LINE_ASK = {
  list_back: "they asked whether we give the listing back (a list-back) when we resell",
  buyer_agent: "they offered to represent us as our buyer's agent, or need a buyer agency agreement first",
  referral_fee: "they asked about a referral, finder's or buyer broker fee, or a commission from us",
  co_wholesale: "they offered to work deals together (their wholesale or deal list)",
  investor_buyer: "they said they buy houses themselves, or would pay an assignment fee",
};

/** partnerTermsLine(terms) → one instruction for the draft, or "". */
export function partnerTermsLine(terms) {
  if (!terms?.kind || !LINE_ASK[terms.kind]) return "";
  return `PARTNER TERMS: ${LINE_ASK[terms.kind]} ("${terms.phrase}"). Answer that offer directly and warmly: name what they offered, ` +
    "say you'd like to work together that way and that you'll call to go over how you'd set it up. Never \"keep me in mind\", " +
    "\"keep us on the list\" or only an address request, never \"let me check with my partner\", and never agree to a fee, a " +
    "percentage or an agreement in the text. A person reads this one before it goes.";
}
