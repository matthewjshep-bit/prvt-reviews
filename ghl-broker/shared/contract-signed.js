// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// contract-signed.js — did the agent just tell us it's signed?
//
// The line stopped here (2026-10-02 review): an agent texts "we're mutual!"
// or "seller signed, fully executed" and nothing in the app notices — the
// offer stays "sent", no deal is made, no buyers hear about it, until Matt
// opens the offers console and promotes it by hand. This reads the words;
// the reply agent puts a "Promote it to a deal" hand-off on Today. Promoting
// stays a person's tap (ASK_ONLY_ACTIONS): one sentence is not a contract.
//
// Pure. Their words only — on a call, only the THEM lines.

// It's done: signed by everyone, mutual, executed, under contract.
const SIGNED_RX = /\b(?:fully|mutually)\s+(?:executed|signed|ratified)\b|\bwe(?:'re| are)\s+(?:all\s+)?signed\b|\bauthentisign\s+(?:is\s+)?(?:complete|completed|done|finished)\b|\bwe(?:'re| are| have)\s+(?:mutual|under contract)\b|\b(?:it'?s|its|is|we'?re|are|now)\s+mutual\b|\bmutual(?:\s+acceptance)?\s+(?:is\s+)?(?:done|reached|achieved|today|now)\b|\bhave mutual\b|\b(?:seller|sellers|everyone|all parties|both parties)\s+(?:has\s+|have\s+)?(?:signed|counter-?signed|executed)\b|\bcounter-?signed\b|\bdocu-?sign\s+(?:is\s+)?(?:complete|completed|done|finished)\b|\b(?:psa|purchase (?:and sale )?agreement|contract|offer)\s+(?:is\s+|has been\s+|was\s+)?(?:signed|executed|ratified)\b|\b(?:officially|now)\s+under contract\b/i;
// …but not when they're talking about it happening, or it not happening.
const NOT_YET_RX = /\b(?:not|n't|never|yet to|still need(?:s)?|waiting (?:on|for)|once|when|if|after|before|will|going to|gonna|should|hope|hoping|plan(?:ning)? to|about to|ready to|need(?:s)? to)\b[^.!?\n]{0,40}\b(?:sign|signed|mutual|executed|counter-?sign|under contract|docu-?sign)/i;

// …and not someone else's contract, a counter, or the listing's own paperwork
// (review, 2026-10-02: "the seller signed another offer" read as signed).
const NOT_OURS_RX = /\b(?:another|other|someone else|somebody else|different|backup|back-up|second position|listing agreement|disclosures?|counter(?![\s-]*signed)(?:-?offers?)?|addend(?:um|a)|extension|inspection response)\b/i;
// Said to us about ours: "your offer", "our contract", "the PSA we sent".
export const OURS_RX = /\b(?:your|our)\s+(?:offer|psa|contract|purchase|loi|letter|paper(?:work)?)\b|\bwith (?:you|y'all|your buyer)\b/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");

/** themLines(transcript) → the other side's words from a call ("THEM: …" lines). */
export function themLines(transcript = "") {
  return String(transcript || "").split(/\r?\n/).filter((l) => /^THEM:/i.test(l.trim())).map((l) => l.replace(/^\s*THEM:\s*/i, "")).join("\n");
}

/**
 * closingDateIn(text, now) → "yyyy-mm-dd" | null
 *
 * "closing 10/24", "close on Oct 24th", "closing date of November 3" — the
 * next such date on or after today (a date already past this year is next
 * year's).
 */
export function closingDateIn(text = "", now = Date.now()) {
  const t = String(text || "");
  const today = new Date(now);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  // Every "close/closing …" in the text, first real date wins ("closing costs
  // split 50/50, close 10/24" is the 24th, not the costs).
  for (const near of t.matchAll(/\bclos(?:e|es|ing)(?:\s+date)?(?:\s+(?:is|of|on|by|for|set for|scheduled for))?\s*(?:on\s+)?([^.!?,\n]{0,24})/gi)) {
    const s = near[1];
    let m, mo, d, y = null;
    if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s))) { mo = +m[1]; d = +m[2]; if (m[3]) y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; }
    else if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(s))) { mo = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1; d = +m[2]; }
    else continue;
    const explicitYear = y != null;
    if (y == null) {
      y = today.getUTCFullYear();
      if (Date.UTC(y, mo - 1, d) < todayUtc) y++;
    }
    // A real day (no 2/30), and not one already gone.
    const when = new Date(Date.UTC(y, mo - 1, d));
    if (when.getUTCMonth() !== mo - 1 || when.getUTCDate() !== d) continue;
    if (explicitYear && when.getTime() < todayUtc) continue;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

/**
 * signedContractIn(text, { now }) → { signed: boolean, closingDate?: "yyyy-mm-dd" }
 *
 * True on "fully executed", "we're mutual", "seller signed", "DocuSign
 * completed", "we're under contract". False on a question, and on the
 * future or the negative ("once it's signed", "not signed yet", "will sign
 * tonight") — sentence by sentence, so "Seller signed! Closing 10/24." reads.
 */
export function signedContractIn(text = "", { now = Date.now() } = {}) {
  const t = String(text || "");
  const sentences = t.split(/(?<=[.!?\n])\s+/).map((x) => x.trim()).filter(Boolean);
  // "Authentisign should have sent you the fully executed contract" is the
  // paper on its way to us, not a signature still to come (9311 12th Pl SE,
  // 2026-10-04): the delivery words don't count as "not yet".
  const delivery = (s) => s.replace(/\b(?:should|will|would)\s+have\s+(?:sent|emailed|forwarded|delivered|gotten|received)\b|\bwill\s+(?:send|forward|email)\b/gi, "");
  const hit = sentences.find((s) => !/\?\s*$/.test(s) && SIGNED_RX.test(s) && !NOT_YET_RX.test(delivery(s)) && !NOT_OURS_RX.test(s));
  if (!hit) return { signed: false };
  // Something else in the message says it went to someone else.
  if (sentences.some((s) => /\b(?:another|someone else|somebody else|other buyer|other offer|backup)\b/i.test(s))) return { signed: false };
  const closingDate = closingDateIn(t, now);
  return { signed: true, ours: OURS_RX.test(t), ...(closingDate ? { closingDate } : {}) };
}
