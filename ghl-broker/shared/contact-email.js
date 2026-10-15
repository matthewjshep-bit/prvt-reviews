// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// contact-email.js — an email address someone texts us, and buyers who want
// deals by email.
//
// Until 2026-10-15 an address texted to us was used once, for the send it came
// with (reply-agent.js emailRequest → send_offer emailTo), and then forgotten:
// GHL's email field never heard of it, so the next email went to the old
// address or nowhere. And a buyer with a phone always got a deal by text, even
// one who asked for email (several buyers, 2026-10-15).
//
// Pure. The GHL write, the duplicate check and the record are in
// ghl-broker/contact-email.js.

const EMAIL_RX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const clean = (e) => String(e || "").trim().replace(/[.,;:)]+$/, "").toLowerCase();

/** A plain, single address, or "". */
export function validEmail(v) {
  const e = clean(v);
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) && !e.includes("..") ? e : "";
}

/**
 * emailsIn(text) → { to: [address], cc: [address] }
 *
 * Every address in a message, lower-cased, in order. Anything after "cc" or
 * "copy" is copied, not theirs (the same split reply-agent.js emailRequest
 * makes for the documents).
 */
export function emailsIn(text = "") {
  const [head, ...tail] = String(text || "").split(/\bcc\b|\bcopy\b/i);
  const pick = (s) => [...new Set((String(s).match(EMAIL_RX) || []).map(validEmail).filter(Boolean))];
  const to = pick(head);
  const cc = pick(tail.join(" ")).filter((e) => !to.includes(e));
  return { to, cc };
}

// Someone else's address: "send it to my TC at …", "her email is …". Read in
// the words just before the address.
const OTHER_RX = new RegExp(
  "\\b(my|our|her|his|their|the)\\s+(tc|transaction coordinator|coordinator|assistant|admin|partner|business partner|wife|husband|spouse|" +
  "broker|managing broker|office|team|colleague|co-?agent|co-?lister|lender|loan officer|attorney|lawyer|escrow|title|bookkeeper|" +
  "son|daughter|mom|dad|brother|sister|associate|manager)\\b|\\b(her|his|their)\\s+e-?mail\\b|\\bcc\\b",
  "i",
);
// Plainly their own: "my email is …", "email me at …", "use this one".
const THEIRS_RX = /\b(my|personal|new|best|preferred|updated|work)\s+e-?mail\b|\be-?mail\s+me\b|\b(reach|contact|send)\s+me\b|\bme\s+at\b|\b(use|try)\s+(this|that)\b|\bhere'?s\s+my\b|\bmy\s+(new\s+)?address\b|\bi'?m\s+at\b/i;
// Nothing but the address (and a thank-you): they're answering "what's your email?".
const BARE_RX = /^[\s"'“”]*(?:it'?s\s+)?(\S+@\S+?)[\s.!,"'“”]*(?:thanks?|thank you|thx|ty)?[\s.!]*$/i;

/**
 * emailOwner(message, email) → "theirs" | "other" | "unclear"
 *
 * Whose address this is, from the words they put round it. Someone else's
 * wins: an agent's TC is not the agent.
 */
export function emailOwner(message = "", email = "") {
  const text = String(message || "");
  const at = email ? text.toLowerCase().indexOf(String(email).toLowerCase()) : -1;
  const before = at >= 0 ? text.slice(Math.max(0, at - 80), at) : text;
  // The clause the address sits in: back to the last sentence break.
  const clause = before.split(/[.!?\n]/).pop();
  if (OTHER_RX.test(clause)) return "other";
  if (THEIRS_RX.test(clause) || BARE_RX.test(text)) return "theirs";
  return "unclear";
}

/**
 * emailSaveFor({ message, current, isCall }) → { action, email, owner, why }
 *
 * What to do with an address they texted, against the one GHL has:
 *   "set"      GHL has none: theirs or unclear, it's the only address we have.
 *   "replace"  GHL has a different one and they said this one is theirs.
 *   "ask"      GHL has a different one and they didn't say whose: Today.
 *   "none"     nothing to do (no address, the same one, someone else's, a call).
 *
 * A call is never read: a spoken address comes back from the transcriber
 * as "john at gmail dot com", or wrong.
 */
export function emailSaveFor({ message = "", current = "", isCall = false } = {}) {
  if (isCall) return { action: "none", email: "", owner: "", why: "a call" };
  const { to } = emailsIn(message);
  if (!to.length) return { action: "none", email: "", owner: "", why: "no address" };
  const email = to[0];
  const cur = validEmail(current);
  if (cur === email) return { action: "none", email, owner: "", why: "already on file" };
  const owner = emailOwner(message, email);
  if (owner === "other") return { action: "none", email, owner, why: "someone else's address" };
  // Two addresses and nothing saying which: theirs to pick.
  if (to.length > 1 && owner !== "theirs") return { action: "ask", email, owner, why: "more than one address" };
  if (!cur) return { action: "set", email, owner, why: "none on file" };
  if (owner === "theirs") return { action: "replace", email, owner, why: "they said it's theirs" };
  return { action: "ask", email, owner, why: "a different one is on file" };
}

/* ---------- deals by email ---------- */

// The GHL tag that mirrors the record's `deals_by` fact, so a list or a
// workflow can see who wants deals by email. Read back only when the record
// has no answer (record first, GHL fills the gaps).
export const DEALS_BY_EMAIL_TAG = "dispo-deals-by-email";

const NOT_EMAIL_RX = /\b(don'?t|do not|no|stop|never|rather not)\s+(send\s+(me\s+)?)?e-?mails?\b|\bnot\s+(by|over|via)\s+e-?mail\b|\btext\s+(is|works)\s+(better|best|fine|easier)\b/i;
const WANTS_EMAIL_RX = new RegExp([
  "\\be-?mail\\s+(me|it|them|those|that|this|deals|the\\s+(deal|details|info|package|numbers|photos|pics|address))\\b",
  "\\b(send|shoot|forward|put|drop)\\b[^.?!]{0,40}\\b(to|on|in|by|via|over)\\s+(my\\s+)?e-?mail\\b",
  "\\b(prefer|rather|better|easier|best)\\b[^.?!]{0,30}\\be-?mail\\b",
  "\\be-?mail\\s+(is|works)\\s+(better|best|easier|great|good)\\b",
  "\\b(by|via|over)\\s+e-?mail\\b",
  "\\binstead\\s+of\\s+text",
].join("|"), "i");

/**
 * wantsDealsByEmail(message) → boolean
 *
 * A buyer asking for deals, or this deal, by email: "email me the details",
 * "send it to my email", "I prefer email", "by email please". A no to email
 * ("don't email me", "text is better") is not.
 */
export function wantsDealsByEmail(message = "") {
  const t = String(message || "");
  if (!t.trim() || NOT_EMAIL_RX.test(t)) return false;
  return WANTS_EMAIL_RX.test(t);
}

/**
 * dealsByOf(inv) → "email" | "text" | ""
 *
 * How a buyer wants deals: the record's `deals_by` (doc.record, the
 * investor row) first, then the GHL tag, then no answer.
 */
export function dealsByOf(inv = {}) {
  const fact = String(inv?.dealsBy || inv?.record?.deals_by || "").toLowerCase();
  if (fact === "email" || fact === "text") return fact;
  const tags = (inv?.tags || []).map((t) => String(t || "").toLowerCase());
  return tags.includes(DEALS_BY_EMAIL_TAG) ? "email" : "";
}
