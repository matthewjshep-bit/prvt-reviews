// contact-card.js — Matt's contact card (a .vcf) goes out in its own text,
// right after a reply, when it makes sense (Matt, 2026-10-09: "share this
// proactively in our agent outreach, when people ask or if an initial deal
// doesn't work, saying to save my contact info and I'll be in touch").
//
// Two moments, nothing else:
//   asked  they asked who we are or how to reach us ("what's your email",
//          "who is this", "send me your info"). Anyone, agent or buyer.
//   pass   an agent's house didn't work: they said no to our number, or we
//          told them it isn't our kind of house. Once per contact, ever: the
//          card says "save me, I'll be in touch", and that is said once.
// Never on a cold first text: an attachment in a cold text is what the
// carriers block (30007), and a stranger has no reason to save us yet.
//
// The card itself lives in settings (conversationAi.contactCard.vcard) and
// is served by the broker at /card/<token>, with the headers that keep its
// file name on the phone. Pure.

export const CONTACT_CARD_DEFAULTS = Object.freeze({
  enabled: false,
  vcard: "",
  // The secret in the public link (/card/<token>). Minted by the broker the
  // first time a card is saved; the normaliser only keeps a well-formed one.
  token: "",
  fileName: "contact.vcf",
  onAsk: true,
  onPass: true,
  askText: "Here's my contact card so you have it.",
  passText: "Here's my contact card. Save it and I'll be in touch when the next one comes up.",
  // A second ask inside this many days gets no second card.
  askRepeatDays: 7,
});

export const VCARD_MAX = 20000;
const TOKEN_RE = /^[a-f0-9]{24,64}$/;

const str = (v, max) => String(v == null ? "" : v).replace(/\r\n/g, "\n").trim().slice(0, max);
const bool = (v, def) => (v == null ? def : v === true || v === "true" || v === 1 || v === "1");

// A vCard is BEGIN:VCARD … END:VCARD. Anything else is not saved.
export function isVcard(text = "") {
  const t = String(text || "").trim();
  return /^BEGIN:VCARD\b/i.test(t) && /\bEND:VCARD$/i.test(t);
}

// The file name the phone shows. Letters, digits, spaces, dashes and
// underscores, always ending .vcf.
export function cardFileName(name = "") {
  const base = String(name || "").replace(/\.vcf$/i, "").replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${base || "contact"}.vcf`;
}

export function normalizeContactCard(src = {}) {
  const c = src && typeof src === "object" ? src : {};
  const D = CONTACT_CARD_DEFAULTS;
  const raw = str(c.vcard, VCARD_MAX);
  const vcard = isVcard(raw) ? raw : "";
  const days = Number(c.askRepeatDays);
  return {
    enabled: bool(c.enabled, D.enabled),
    vcard,
    token: TOKEN_RE.test(String(c.token || "")) ? String(c.token) : "",
    fileName: cardFileName(c.fileName || D.fileName),
    onAsk: bool(c.onAsk, D.onAsk),
    onPass: bool(c.onPass, D.onPass),
    askText: str(c.askText, 300) || D.askText,
    passText: str(c.passText, 300) || D.passText,
    askRepeatDays: Number.isFinite(days) ? Math.min(90, Math.max(0, Math.round(days))) : D.askRepeatDays,
  };
}

// Ready to send: switched on, a card, and a link to serve it from.
export function cardReady(card) {
  return Boolean(card?.enabled && card.vcard && card.token);
}

export function cardPath(token) {
  return `/card/${token}`;
}

// "what's your email", "who is this", "send me your info", "do you have a
// website". An ask, not a mention: "I got your email" is not one. "Your
// number" alone is a price in this business ("what's your number on it"),
// so a number counts only as a phone, cell or a way to reach us.
const ASK_LEAD = String.raw`(?:what(?:'s|s|\s+is|\s+are)|(?:can|could|may)\s+i\s+(?:get|have)|send\s+me|send|text\s+me|give\s+me|share|need)\s+(?:your|ur)\s+`;
const CONTACT_WORDS = String.raw`(?:e-?mail(?:\s+address)?|website|web\s+site|contact(?:\s+(?:info|information|card|details))?|info|information|details|card|business\s+card|name|full\s+name|last\s+name|company(?:\s+name)?|cell(?:\s+(?:phone|number))?|phone(?:\s+number)?|direct\s+(?:line|number))`;
const ASKS = [
  new RegExp(String.raw`\b${ASK_LEAD}${CONTACT_WORDS}\b`, "i"),
  /\bwho\s*(?:is|'s|s)\s+this\b/i,
  /\bwho\s+(?:am\s+i|are\s+you)\s+(?:talking|speaking|texting|chatting)\b/i,
  /\b(?:what|which)\s+(?:company|brokerage|outfit)\s+(?:are\s+you|is\s+this|you\s+with)\b/i,
  /\b(?:best|good)\s+(?:number|way|email)\s+to\s+(?:reach|call|contact|text|get\s+(?:a\s+)?hold\s+of)\s+you\b/i,
  /\bnumber\s+(?:to|i\s+can)\s+(?:call|reach|text)\s+you\b/i,
  /\b(?:do|does)\s+(?:you|your\s+company)\s+have\s+a\s+(?:website|web\s+site|card|business\s+card)\b/i,
  /\bhow\s+(?:can|do|should)\s+i\s+(?:reach|contact|get\s+(?:a\s+)?hold\s+of)\s+you\b/i,
];

export function asksForContact(message = "") {
  const t = String(message || "").replace(/[’‘]/g, "'");
  if (!t.trim()) return false;
  return ASKS.some((rx) => rx.test(t));
}

// An agent's house that didn't work, as the saved draft records it.
export function passMoment(draft = {}) {
  if ((draft.party || "agent") !== "agent") return "";
  if (draft.intent === "rejection") return "they passed";
  if (draft.outbound?.kind === "kind_pass") return "we passed";
  if (draft.notOurKind) return "not our kind of house";
  if (draft.qualify?.stage === "pass") return "we passed";
  return "";
}

/**
 * cardMoment({ card, draft, body, sentCards, now }) → { send, why, text }
 *
 * Whether the text that just went should be followed by the card. `body` is
 * what went (a person may have rewritten the draft); `sentCards` is the
 * contact's earlier contact_card_sent events ({ at }), any order.
 */
export function cardMoment({ card, draft = {}, body = "", sentCards = [], now = Date.now() } = {}) {
  const no = (why) => ({ send: false, why, text: "" });
  if (!cardReady(card)) return no("off");
  if (draft.channel === "email") return no("an email, not a text");
  if (draft.outbound?.kind === "outreach_open" || draft.outbound?.kind === "blast_open") return no("a cold text");
  if (!String(body || "").trim()) return no("nothing went");
  const last = sentCards.reduce((m, e) => Math.max(m, Date.parse(e?.at) || 0), 0);
  // A text that just went from a machine-started kind has no inbound; only
  // their own words can ask.
  if (card.onAsk && asksForContact(draft.inbound)) {
    if (last && now - last < card.askRepeatDays * 86400000) return no("sent them the card recently");
    return { send: true, why: "they asked", text: card.askText };
  }
  const pass = card.onPass ? passMoment(draft) : "";
  if (pass) {
    if (last) return no("they already have the card");
    return { send: true, why: pass, text: card.passText };
  }
  return no("not a moment for it");
}
