// settled-by-you.js — a house you settled yourself, by phone or by hand.
//
// Kyle R., 2026-10-05: Matt talked a Bellevue flip through with the agent on
// the phone and gave a back-of-the-napkin $1.17M, then texted it. The house
// never had an address in the app, so to the machine it was still "a house is
// coming": it asked for the address on 10/07 and 10/10, offered to "run comps
// and confirm it", and promised the written offer, and the agent asked what
// the mix-up was. Once a person has priced a house or passed on it, that
// is the answer. The machine stands behind it and stops asking.
//
// A `settled_by_you` event: { by, verdict, amount, house }.
//   by       "call"  the call reader saw it in the transcript (reply-agent.js)
//            "text"  a text a person sent named our number (routes/offers.js)
//            "note"  a call Matt logged by hand on the work pane
//   verdict  "priced" (we gave a number, rough or not) | "passed" (not a fit)
//   house    a few words naming it, as said; the event's address when known
//
// Everything here is pure.

import { addressKey } from "./us-address.js";

export const SETTLED_EVENT = "settled_by_you";
export const SETTLED_VERDICTS = ["priced", "passed"];
// How long a settle stands for the bot. A house that comes back after this
// is a new conversation.
export const SETTLED_DAYS = 60;
// After a settle on a house with no address, a house with no address in
// their next texts is most likely that one, not a new one: no address chase
// and no underwrite by itself for this long.
export const SETTLED_NO_ADDRESS_DAYS = 14;
// Our numbers live in this band; a rehab figure, a day count or a year don't.
const MIN_PRICE = 30000;
const MAX_PRICE = 10000000;

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const clean = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

/**
 * normalizeSettle(raw) → { verdict, amount, house } | null
 * The call reader's field, checked. A "priced" with no number is still
 * priced (Matt gave a range, or the transcript garbled it).
 */
export function normalizeSettle(raw) {
  if (!raw || typeof raw !== "object") return null;
  const verdict = SETTLED_VERDICTS.includes(raw.verdict) ? raw.verdict : "";
  if (!verdict) return null;
  const n = Math.round(Number(raw.amount) || 0);
  const amount = verdict === "priced" && n >= MIN_PRICE && n <= MAX_PRICE ? n : 0;
  return { verdict, amount, house: clean(raw.house, 120) };
}

// The way Matt texts a number: "$1.17M", "1.17m", "450k", "$450,000", and
// the shorthand "$1.17" (millions) or "$450" (thousands).
const PRICE_RX = /\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?\b|\b\d+(?:\.\d+)?\s?[kKmM]\b|\b\d{1,3}(?:,\d{3})+\b/g;
// A figure that is theirs or the work's, not our price for the house.
const NOT_OUR_PRICE_RX = /\b(?:list(?:ed|ing)?(?:\s+price)?|asking|ask|they(?:'re| are)? at|seller(?:'s)?\s+(?:wants?|needs?|at)|rehab|repairs?|work|reno(?:vation)?|arv|after repair|worth|comps?|taxes|rent|budget)\b[^.!?\n]{0,24}$/i;

function priceOf(raw) {
  const s = raw.replace(/[\s,]/g, "");
  const dollar = s.startsWith("$");
  const body = dollar ? s.slice(1) : s;
  const suffix = body.slice(-1).toLowerCase();
  const base = Number(suffix === "k" || suffix === "m" ? body.slice(0, -1) : body);
  if (!Number.isFinite(base)) return 0;
  if (suffix === "k") return Math.round(base * 1e3);
  if (suffix === "m") return Math.round(base * 1e6);
  // Shorthand with a dollar sign: "$1.17" is 1.17M, "$450" is 450K.
  if (dollar && base > 0 && base < 10) return Math.round(base * 1e6);
  if (dollar && base >= 10 && base < 10000) return Math.round(base * 1e3);
  return Math.round(base);
}

/**
 * ourNumberInText(text) → whole dollars, or 0
 *
 * The number a person's own text gave for a house: "$1.17M is what im seeing
 * on my end". Not a question ("are they at 550k?"), not their price, the
 * rehab or the ARV, and not two different numbers (a person reads those).
 */
export function ourNumberInText(text = "") {
  const found = new Set();
  // A sentence ends at a stop followed by a space: "$1.17M" is one number.
  for (const sentence of String(text || "").split(/(?<=[.!?])\s+|\n+/)) {
    if (/\?\s*$/.test(sentence)) continue;
    for (const m of sentence.matchAll(PRICE_RX)) {
      if (NOT_OUR_PRICE_RX.test(sentence.slice(0, m.index))) continue;
      const n = priceOf(m[0]);
      if (n >= MIN_PRICE && n <= MAX_PRICE) found.add(n);
    }
  }
  return found.size === 1 ? [...found][0] : 0;
}

// A person saying the house isn't for us: "not a fit", "we'll pass".
const PASS_RX = /\bnot (?:a (?:good )?fit|for us|going to work|gonna work|our (?:kind|type|lane))\b|\b(?:we(?:'ll| will)?|i(?:'ll| will)?|going to|gonna|have to|gotta|need to) pass\b|\bdoesn'?t (?:work|pencil|make sense) for us\b|\bcan'?t make (?:it|the numbers) work\b|\bno go\b/i;

/** ourPassInText(text) → the matched words, or "" */
export function ourPassInText(text = "") {
  const m = String(text || "").match(PASS_RX);
  return m ? m[0] : "";
}

/**
 * settlesFrom(events, { now }) → [{ at, by, verdict, amount, house, address }]
 * newest first, one per house, inside SETTLED_DAYS.
 */
export function settlesFrom(events = [], { now = Date.now() } = {}) {
  const out = [];
  const seen = new Set();
  const list = (events || []).filter((e) => e?.type === SETTLED_EVENT && SETTLED_VERDICTS.includes(e.data?.verdict))
    .filter((e) => { const t = ms(e.at); return t != null && now - t <= SETTLED_DAYS * DAY_MS && t <= now + 60000; })
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  for (const e of list) {
    const address = clean(e.address, 200);
    const key = address ? `a:${addressKey(address)}` : `h:${clean(e.data?.house, 120).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ at: e.at, by: e.data?.by || "", verdict: e.data.verdict, amount: Math.round(Number(e.data?.amount) || 0), house: clean(e.data?.house, 120), address });
  }
  return out;
}

/** The newest settle on a house the app has no address for, inside `days`. */
export function settledWithoutAddress(settles = [], { now = Date.now(), days = SETTLED_NO_ADDRESS_DAYS } = {}) {
  return (settles || []).find((s) => !s.address && now - (ms(s.at) ?? 0) <= days * DAY_MS) || null;
}

const fmt = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const BY_WORDS = { call: "on the phone", text: "by text", note: "on a call" };
const day = (at) => new Date(at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });

/** One settle, in the words the prompt and the Desk use. */
export function settleLine(s) {
  // The house in their own words, when that's all we have (the hint an
  // address_pending kept).
  const what = s.address || (s.house.length > 40 ? `the house they told us about ("${s.house}")` : s.house) || "the house they brought us";
  const how = BY_WORDS[s.by] || "himself";
  if (s.verdict === "passed") return `${what}: Matt talked it through with them ${how} on ${day(s.at)} and passed. It is not a fit; that is settled.`;
  return `${what}${s.address ? "" : " (no address on file, and none needed)"}: Matt gave them ${s.amount ? fmt(s.amount) : "our number"} ${how} on ${day(s.at)}` +
    `${s.by === "call" || s.by === "note" ? ", a back-of-the-napkin number from talking it through" : ""}. That IS our number on it.`;
}

/**
 * settledContextText(settles) → the prompt block, or ""
 */
export function settledContextText(settles = []) {
  if (!settles?.length) return "";
  return "HOUSES MATT SETTLED HIMSELF (his decision. It stands, and it outranks any note below that says otherwise):\n" +
    settles.slice(0, 4).map((s) => `- ${settleLine(s)}`).join("\n") + "\n" +
    "On a settled house, never ask for its address, photos or details, never offer to run comps, confirm, firm up or re-run the number, " +
    "and never promise numbers or paper on it. If they ask where it stands, his number stands as he gave it; the only open question is " +
    "whether the seller will take it. A house he passed on is passed: be gracious and ask about their next one. Notes that say to get " +
    "its address or run comps are out of date.";
}

// A text that goes back over a settled house: asks for the address or the
// details, or offers to price it again.
const ASKS_AGAIN_RX = /\b(?:what(?:'s| is) the (?:address|addy)|send (?:me |us )?(?:over )?(?:the |that )?(?:address|addy)|(?:need|get|have|grab) the (?:actual |exact |full )?(?:address|addy)|address (?:when|so|and)\b|the address\b[^.?!]{0,40}\?)|\b(?:run(?:ning)?|pull(?:ing)?) (?:the )?comps\b|\bcomps on (?:our|my) end\b|\bconfirm (?:it|that|the (?:number|price|offer))\b|\bfirm (?:it|that|the number) up\b|\b(?:run|re-?run|crunch) the numbers\b|\bsharpen (?:the|our) (?:pencil|number)\b/i;

/** asksAboutSettled(reply) → the matched words, or "" */
export function asksAboutSettled(reply = "") {
  const m = String(reply || "").match(ASKS_AGAIN_RX);
  return m ? m[0] : "";
}

/**
 * settleHoldsUnderwrite({ settles, propertyAddress, now }) → why, or ""
 *
 * The underwrite does not start by itself on a house you settled: the same
 * address, or no address at all while a settle on an address-less house is
 * fresh (they're talking about that one). A new address on a house you
 * didn't settle runs as before.
 */
export function settleHoldsUnderwrite({ settles = [], propertyAddress = "", now = Date.now() } = {}) {
  const addr = clean(propertyAddress, 200);
  if (addr) {
    const key = addressKey(addr);
    const same = (settles || []).find((s) => s.address && addressKey(s.address) === key);
    if (same) return `you settled ${same.address} yourself on ${day(same.at)}`;
    return "";
  }
  const loose = settledWithoutAddress(settles, { now });
  return loose ? `you settled ${loose.house || "the house they brought"} yourself on ${day(loose.at)}` : "";
}

// Machine texts that are only ever about a house's address, a promise on it,
// or a check-in we owed on it: none of them goes once a person settled a house
// that has no address.
export const SETTLE_STOPS_KINDS = new Set(["address_chase", "promise_due"]);

/**
 * settleStopsMachineText({ kind, subject, address, settles, now }) → why, or ""
 *
 * `address` is the house the text is about (the offer's, or the subject's).
 * A house you passed on gets nothing more from the machine; a house with no
 * address you settled gets no chase, no promise text and no promise check-in.
 */
export function settleStopsMachineText({ kind = "", subject = null, address = "", settles = [], now = Date.now() } = {}) {
  const about = clean(address || subject?.address, 200);
  if (about) {
    const key = addressKey(about);
    const passed = (settles || []).find((s) => s.verdict === "passed" && s.address && addressKey(s.address) === key);
    return passed ? `you passed on ${passed.address} yourself on ${day(passed.at)}` : "";
  }
  const loose = settledWithoutAddress(settles, { now, days: SETTLED_DAYS });
  if (!loose) return "";
  const promiseCheckIn = kind === "checkin_due" && subject?.sourceKind === "promise";
  if (SETTLE_STOPS_KINDS.has(kind) || promiseCheckIn) {
    return `you settled ${loose.house || "the house they brought"} yourself on ${day(loose.at)} — nothing to chase`;
  }
  return "";
}
