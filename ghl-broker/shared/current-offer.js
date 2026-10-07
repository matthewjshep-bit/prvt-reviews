// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// current-offer.js — which offer on a house is the one we're working from.
//
// An agent collects offer rows on one house: the first number, a revision
// after a call, an auto-underwrite, a re-quote, a draft nobody sent. Every
// path that acted on "the" offer used to pick one by its own rule — newest
// created, first open, the hot one — and a revision keeps its old createdAt,
// so a re-priced offer sorted below the stale one it replaced.
//
// 13041 SE 208th St, Kent (2026-09-25): five offer rows on one
// house, the thread had been at 400K since August, and when she said "draw
// it up" the bot sent a letter of intent at 416,500 off a July row — the
// only one not marked passed. The deal died on it.
//
// The rule, derived on read (nothing to migrate, like offerHeat):
//
//   1. a draft is never current
//   2. a deal on the house is current
//   3. a row a person pinned is current, until a sibling is SENT after the pin
//   4. otherwise the row whose number moved last: sent, revised, re-quoted,
//      or created — a status change is not a price move
//
// Status never disqualifies: a passed current offer is still our number on
// that house, and its status says where it stands. Everything else on the
// house is superseded, and no machine path acts on a superseded row.
//
// Pure. The broker and the app both read it.

import { parseUsAddress, addressKey } from "./us-address.js";
import { fmtMoney } from "./offer-calc.js";

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : 0; };
const maxOf = (list) => list.reduce((a, b) => (b > a ? b : a), 0);

/* ---------- the house ---------- */

// House number + street, the key sameStreet compares on: "13041 Southeast
// 208th Street, Kent, Washington 98031" and "13041 SE 208th St" are one house.
export function houseKey(address = "") {
  const p = parseUsAddress(address);
  return p.houseNo ? addressKey(`${p.houseNo} ${p.street}`) : addressKey(address);
}

export const isDraftOffer = (o) => Boolean(o) && (o.status === "draft" || (o.draft && !o.status));

/* ---------- when the number last moved ---------- */

export function lastSentAt(o) {
  return maxOf([
    ...(o?.sends || []).map((s) => ms(s?.ts)),
    ...(o?.statusHistory || []).filter((h) => h?.status === "sent").map((h) => ms(h?.ts)),
  ]);
}

/**
 * pricedAt(offer) → ms
 *
 * The last time this row's number was put in front of someone or changed:
 * a send, a revision, a re-quote, or its creation. Status changes don't
 * count — "passed" doesn't make an offer newer.
 */
export function pricedAt(o) {
  return maxOf([
    lastSentAt(o),
    ...(o?.revisions || []).map((r) => ms(r?.ts)),
    ...(o?.requotes || []).map((r) => ms(r?.ts)),
    ms(o?.createdAt),
  ]);
}

const newestFirst = (a, b) => (pricedAt(b) - pricedAt(a)) || (ms(b.createdAt) - ms(a.createdAt)) || String(b.id || "").localeCompare(String(a.id || ""));

/**
 * resolveHouse(rows) → { current, superseded, pinned }
 *
 * `rows` are one contact's offers on one house (any statuses, drafts
 * included — they're set aside). `pinned` is true when a person's pin is
 * what decided it.
 */
export function resolveHouse(rows = []) {
  const live = rows.filter((o) => o && !isDraftOffer(o));
  if (!live.length) return { current: null, superseded: [], pinned: false };
  let current = null;
  let pinned = false;
  const deals = live.filter((o) => o.deal).sort(newestFirst);
  if (deals.length) current = deals[0];
  if (!current) {
    const pin = live.filter((o) => o.pin?.at && !o.pin.off).sort((a, b) => ms(b.pin.at) - ms(a.pin.at))[0];
    if (pin) {
      const at = ms(pin.pin.at);
      if (!live.some((o) => o !== pin && lastSentAt(o) > at)) { current = pin; pinned = true; }
    }
  }
  if (!current) current = [...live].sort(newestFirst)[0];
  // A deal is its own record — a fell-through deal and the re-contract after
  // it are both history — so no deal is ever superseded; the offers beside
  // one are.
  return { current, superseded: live.filter((o) => o !== current && !o.deal), pinned };
}

/* ---------- across a book ---------- */

const groupKey = (o) => `${o?.contactId || ""}|${houseKey(o?.address || "")}`;

/** groupHouses(offers) → Map(groupKey → rows) — one contact, one house. */
export function groupHouses(offers = []) {
  const out = new Map();
  for (const o of offers) {
    if (!o || !String(o.address || "").trim()) continue;
    const k = groupKey(o);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(o);
  }
  return out;
}

/** currentOffers(offers) → [current, …] — one per contact and house. */
export function currentOffers(offers = []) {
  const out = [];
  for (const rows of groupHouses(offers).values()) {
    const { current } = resolveHouse(rows);
    if (current) out.push(current);
  }
  return out;
}

// The street line, loosely, for a hint the model wrote its own way ("13041
// SE 208th"). Six characters or it isn't safe.
const looseStreet = (a) => addressKey(String(a || "").split(",")[0]);

/**
 * currentOfferFor(offers, { contactId, address }) → offer | null
 *
 * The current offer on the house the caller means. A named house is matched
 * on house number + street, then loosely on the street line. No house named:
 * the contact's only house, or null when there are several — a machine
 * doesn't guess between two houses.
 */
export function currentOfferFor(offers = [], { contactId = "", address = "" } = {}) {
  const mine = offers.filter((o) => o && (!contactId || o.contactId === contactId));
  const houses = groupHouses(mine);
  const hint = String(address || "").trim();
  let pick = null;
  if (hint) {
    const key = houseKey(hint);
    const exact = [...houses.entries()].filter(([k]) => k.endsWith(`|${key}`));
    if (exact.length === 1) pick = exact[0][1];
    else if (!exact.length) {
      const h = looseStreet(hint);
      const loose = h.length >= 6
        ? [...houses.values()].filter((rows) => rows.some((o) => { const s = looseStreet(o.address); return s.length >= 6 && (s.includes(h) || h.includes(s)); }))
        : [];
      if (loose.length === 1) pick = loose[0];
    }
  } else if (houses.size === 1) {
    pick = [...houses.values()][0];
  }
  return pick ? resolveHouse(pick).current : null;
}

/**
 * annotateCurrent(offers) → offers, each with
 *   isCurrent      true on the one live row per contact and house
 *   supersededBy   { id, cashAmount, at } on the others (drafts get neither)
 *   currentPinned  true on a current row a person pinned
 *   houseOffers    how many non-draft rows share the house — "current" is
 *                  only worth saying when there is more than one
 *
 * New objects; the inputs are not touched.
 */
export function annotateCurrent(offers = []) {
  const verdict = new Map();
  for (const rows of groupHouses(offers).values()) {
    const { current, superseded, pinned } = resolveHouse(rows);
    if (!current) continue;
    const houseOffers = 1 + superseded.length + rows.filter((o) => o.deal && o !== current).length;
    verdict.set(current, { isCurrent: true, houseOffers, ...(pinned ? { currentPinned: true } : {}) });
    const by = { id: current.id, cashAmount: Number(current.cashAmount) || 0, at: new Date(pricedAt(current) || Date.now()).toISOString() };
    for (const o of superseded) verdict.set(o, { isCurrent: false, supersededBy: by, houseOffers });
  }
  return offers.map((o) => (o && verdict.has(o) ? { ...o, ...verdict.get(o) } : o && !isDraftOffer(o) ? { ...o, isCurrent: false } : o));
}

/** isSuperseded(offer, siblings) — another row on its house is current. */
export function isSuperseded(offer, siblings = []) {
  if (!offer || isDraftOffer(offer)) return false;
  const k = groupKey(offer);
  const rows = [offer, ...siblings.filter((o) => o && o.id !== offer.id && groupKey(o) === k)];
  const { current } = resolveHouse(rows);
  return Boolean(current) && current.id !== offer.id;
}

/* ---------- the number in the thread ---------- */

// Money the way we text it, off one line.
const LINE_MONEY_RX = /\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?\b|\b\d+(?:\.\d+)?\s?[kK]\b|\b\d{1,3}(?:,\d{3})+\b/g;
const toDollars = (m) => {
  const raw = m.replace(/[$,\s]/g, "");
  const k = /k$/i.test(raw);
  const n = Number(k ? raw.slice(0, -1) : raw);
  return Number.isFinite(n) ? Math.round(k ? n * 1000 : n) : 0;
};
export const lineMoney = (text) => [...String(text || "").matchAll(LINE_MONEY_RX)].map((m) => toDollars(m[0])).filter((n) => n > 0);

// The texts that carry our offer documents. They restate the book's number,
// and since 2026-10-07 they also carry the math behind it — so a reader
// either skips them or reads only what comes before the math (quotedPart).
// Looser than reply-agent's OUR_OFFER_TEXT_RX (no "on" needed): a reader
// skipping one of ours by mistake costs nothing, one misread as a price does.
export const OFFER_DOC_TEXT_RX = /\b(?:here's our (?:revised )?(?:written cash offer|letter of intent)|sending our written offer|please find our (?:letter of intent|written (?:cash )?offer))\b/i;
// Where the math starts in a text of ours: "How we got there: …", "we base
// it on about 69% of …" (shared/offer-breakdown.js mathSentence and the
// offer email's table).
export const MATH_MARKER_RX = /\b(?:how we got (?:there|to (?:the|this|that) number)|how we priced it|we base it on)\b/i;
const quotedPart = (text) => {
  if (!OFFER_DOC_TEXT_RX.test(text)) return text;
  const m = MATH_MARKER_RX.exec(text);
  return m ? text.slice(0, m.index) : text;
};

// The costs we name when we show our work (2026-10-07): "38 to buy and
// resell", "26 of holding", "50 for the work", "500 it's worth fixed up".
// A number named as one of them is the math, not a price on the house.
const COST_AFTER = "to\\s+(?:buy|sell|resell|hold|carry|close)\\b|(?:in|of|for|on)\\s+(?:the\\s+)?(?:lender\\s+)?(?:closing|holding|carry(?:ing)?|commissions?|costs?|profit|margin|rehab|repairs?|work|reno(?:vation)?)\\b|" +
  "closing\\b|holding\\b|carry(?:ing)?\\b|resale\\b|commissions?\\b|costs?\\b|profit\\b|margin\\b|it'?s\\s+worth\\b|worth\\b|all\\s+(?:fixed|done)\\b|" +
  "(?:when|once)\\s+(?:it'?s\\s+)?(?:fixed|done|finished|renovated)\\b";
const COST_BEFORE = "\\bclosing(?:\\s+costs?)?|\\bholding(?:\\s+costs?)?|\\bcarry(?:ing)?(?:\\s+costs?)?|\\bresale(?:\\s+costs?)?|\\bresell(?:ing)?|" +
  "\\bprofit(?:\\s*(?:&|and)\\s*risk)?|\\brisk|\\bmargin|\\b(?:renovation\\s+)?budget|\\bcommissions?|\\bcosts?";

/* ---------- a range topped by our number (2026-10-07) ---------- */

// "the 280s to 295": the top is our number (the book, rounded DOWN to the
// thousand — never above it), the bottom `pct` under it on a round step. The
// bottom is never an offer on its own; the letter only ever goes at the top.
const rangeK = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}`);
export function floatRange(amount, pct = 5) {
  const high = Math.floor((Number(amount) || 0) / 1000) * 1000;
  if (high <= 0) return null;
  const step = high >= 200000 ? 10000 : 5000;
  const low = Math.floor((high * (1 - Math.max(0, Number(pct) || 0) / 100)) / step) * step;
  if (low <= 0 || low >= high) return null;
  return { low, high, step };
}
export function rangeWords(r) {
  if (!r?.low || !r?.high) return "";
  if (r.high >= 1e6) return `${rangeK(r.low)} to ${rangeK(r.high)}`;
  return (r.step || 10000) >= 10000 ? `the ${rangeK(r.low)}s to ${rangeK(r.high)}` : `${rangeK(r.low)} to ${rangeK(r.high)}`;
}

// A money token the way a range is written: "$280,000", "280k", "280", "280s".
const RANGE_TOKEN = "\\$?\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\$?\\d+(?:\\.\\d+)?\\s?[kKmM]?s?";
const RANGE_RXS = [
  new RegExp(`(?:\\bthe\\s+)?(${RANGE_TOKEN})\\s*(?:to|-|\u2013|\u2014|through|thru)\\s*(${RANGE_TOKEN})`, "gi"),
  new RegExp(`\\bbetween\\s+(${RANGE_TOKEN})\\s+and\\s+(${RANGE_TOKEN})`, "gi"),
];
function rangeDollars(tok) {
  const raw = String(tok || "").replace(/[$,\s]/g, "").replace(/s$/i, "");
  const suffix = raw.slice(-1).toLowerCase();
  const n = Number(suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (suffix === "k") return Math.round(n * 1e3);
  if (suffix === "m") return Math.round(n * 1e6);
  if (/,/.test(tok) || n >= 10000) return Math.round(n);
  return n >= 10 && n < 10000 ? Math.round(n * 1000) : 0;
}
/**
 * rangeLows(text) → [{ start, end, low, high }] — where a price range starts:
 * "280k to 295k", "the 280s to 295", "between 280 and 295", "$280,000-$295,000".
 * The bottom of a range is not a price on its own, so the readers skip it.
 */
export function rangeLows(text = "") {
  const t = String(text || "");
  const out = [];
  for (const rx of RANGE_RXS) {
    for (const m of t.matchAll(rx)) {
      const low = rangeDollars(m[1]);
      const high = rangeDollars(m[2]);
      if (low < 10000 || high <= low || high > low * 1.25) continue;
      const start = m.index + m[0].indexOf(m[1]);
      const hiStart = m.index + m[0].lastIndexOf(m[2]);
      out.push({ start, end: start + m[1].length, low, high, hiStart, hiEnd: hiStart + m[2].length });
    }
  }
  return out;
}
const inLow = (lows, i) => lows.some((r) => i >= r.start && i < r.end);

/**
 * liveRange(offer) → { low, high, at } | null — the range we floated on this
 * offer, while its number hasn't moved since (a letter, a revision or a
 * re-quote after it makes the range history).
 */
export function liveRange(o) {
  const r = o?.proactive?.range;
  if (!r?.low || !r?.high || !r.at) return null;
  return ms(r.at) >= pricedAt(o) ? r : null;
}

/**
 * namedInRange({ range, message }) → { amount } | null
 *
 * A number they name inside the range we floated and under its top: "285
 * works", "the low 280s", "they'd do 287,500". At the top is a plain yes to
 * our number; above it is a counter. Neither is this.
 */
export function namedInRange({ range = null, message = "" } = {}) {
  if (!range?.low || !range?.high) return null;
  const t = String(message || "");
  const seen = [];
  for (const m of t.matchAll(/(?<![\d,.$])(\$?\d{1,3}(?:,\d{3})+|\$?\d{2,4}(?:\.\d+)?\s?[kK]?s?)(?![\d,.])/g)) {
    const rest = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (/^\s*(?:days?|weeks?|months?|years?|hours?|mins?|minutes?|am|pm|%|sq|beds?|baths?)\b/i.test(rest) || SHORT_STREET.test(rest)) continue;
    const n = rangeDollars(m[1]);
    if (n >= range.low && n < range.high) seen.push(n);
  }
  return seen.length ? { amount: seen[0] } : null;
}

// The figures behind a price, said beside it: "$507K ARV, $110K in rehab".
// A number named as the ARV, the rehab, the repairs or the work is the math,
// not what we'd pay.
const MATH_AFTER = new RegExp(`^\\s*(?:arv\\b|after[- ]repair|(?:in|of|for)\\s+(?:rehab|repairs?|work)\\b|rehab\\b|repairs?\\b|(?:worth\\s+)?of\\s+work\\b|${COST_AFTER})`, "i");
const MATH_BEFORE = new RegExp(`(?:\\barv|after[- ]repair value|\\brehab|\\brepairs?|\\bwork|${COST_BEFORE})\\s*(?:is|of|at|=|:|around|about|~)?\\s*$`, "i");
const priceMoney = (text) => { const lows = rangeLows(text); return [...String(text || "").matchAll(LINE_MONEY_RX)]
  .filter((m) => !inLow(lows, m.index))
  .filter((m) => !MATH_AFTER.test(text.slice(m.index + m[0].length, m.index + m[0].length + 24))
    && !MATH_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index)))
  .map((m) => toDollars(m[0])).filter((n) => n > 0); };

/**
 * ourComeDown(offer, transcript) → { amount, ts, text } | null
 *
 * The lower number WE put to the agent after the offer's number last moved
 * — "Can we do $65k actually" (Kimberly Pettie, 1510 Maple Lane: the book
 * said 71,075, Matt texted 65k by hand, and three days later the bot told
 * her the offer was "still good, 71k"). Ours only (US lines), after the
 * last send/revision/re-quote, under the book's number and not absurdly
 * under it. The lowest such number wins: it is the one the seller is
 * deciding on.
 */
export function ourComeDown(o, transcript = "") {
  const amount = Number(o?.cashAmount) || 0;
  if (!amount || !transcript) return null;
  const since = pricedAt(o);
  let best = null;
  for (const line of String(transcript).split(/\r?\n/)) {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] US \w+: (.*)$/.exec(line);
    if (!m) continue;
    const ts = Date.parse(`${m[1]}T${m[2]}:00Z`);
    if (!Number.isFinite(ts) || ts < since) continue;
    const text = m[3].trim();
    // A message that carries the offer documents restates the book, not a
    // new number.
    if (OFFER_DOC_TEXT_RX.test(text)) continue;
    // Under the book's number, not absurdly under it, and not the book's
    // own number said the way people text it ("71k" for 71,075).
    // Rounded ("71k" for 71,075) or cut short ("227K" for 227,552) — within
    // one unit of the number as said, and within 1% of it.
    const restated = (n) => {
      let unit = 1000;
      while (n % (unit * 10) === 0 && unit < 1e9) unit *= 10;
      return n % 1000 === 0 && Math.abs(n - amount) < unit && Math.abs(n - amount) <= amount * 0.01;
    };
    const lower = priceMoney(text).filter((n) => n < amount && n >= amount * 0.4 && !restated(n));
    if (!lower.length) continue;
    const n = Math.min(...lower);
    if (!best || n < best.amount) best = { amount: n, ts, text: text.slice(0, 120) };
  }
  return best;
}

/**
 * shorthandPrices(text, reference) → [dollars]
 *
 * A price typed without its thousands: "workable for us at 650", "we can do
 * 650", "650 works". The money readers want a $, a comma group or a k, so
 * this is the sentence that got past them (Jesse, 39811 226th Ave SE,
 * 2026-09-25: the bot agreed to 650 on our 550K offer and nothing saw a
 * number). Only beside a price word, never before a unit, a capitalised
 * street name or a numbered street (first texts of 2026-10-05 saying "your
 * listing at 512 112th Ave NE" were held as $512,000), and only where ×1000 is
 * plausible beside `reference` (our number) — 50K to 5M when there is none.
 */
const SHORT_UNIT = /^\s*(?:[kKmM%]|days?\b|hours?\b|hrs?\b|minutes?\b|mins?\b|weeks?\b|wks?\b|months?\b|years?\b|yrs?\b|am\b|pm\b|sq|beds?\b|baths?\b|st\b|nd\b|rd\b|th\b)/;
const SHORT_STREET = /^\s+(?:(?:n|s|e|w|ne|nw|se|sw)\s+)?\d+(?:st|nd|rd|th)\b/i;
const SHORT_BEFORE_RX = /\b(?:at|to|for|do|of|around|about|pay|paying|offer|go|be|near|meet(?:\s+you)?\s+at|up\s+to)\s+(\d{2,4})(ish)?(?![\d,]|\.\d)/gi;
// Not the tail of "1,304,955" or "$683,750": whole numbers only.
const SHORT_AFTER_RX = /(?<![\d,.$])\b(\d{2,4})(ish)?\s+(?:works|would\s+work|could\s+work|is\s+workable|is\s+doable|as-is|as\s+is|cash|flat|all\s+in)\b/gi;
function shorthandHits(t, reference) {
  const ref = Math.max(0, Number(reference) || 0);
  const plausible = (v) => (ref ? v >= ref * 0.4 && v <= ref * 3 : v >= 50000 && v <= 5e6);
  const hits = [];
  for (const rx of [SHORT_BEFORE_RX, SHORT_AFTER_RX]) {
    for (const m of t.matchAll(rx)) {
      const said = m[1] + (m[2] || "");
      const start = rx === SHORT_BEFORE_RX ? m.index + m[0].length - said.length : m.index;
      const end = start + said.length;
      const rest = rx === SHORT_BEFORE_RX ? t.slice(end, end + 12) : "";
      if (rest && (SHORT_UNIT.test(rest) || SHORT_STREET.test(rest) || /^\s+[A-Z]/.test(rest))) continue;
      const v = Number(m[1]) * 1000;
      if (plausible(v)) hits.push({ v, start, end });
    }
  }
  return hits;
}
export function shorthandPrices(text = "", reference = 0) {
  return [...new Set(shorthandHits(String(text || ""), reference).map((h) => h.v))];
}

// Not a price we'd pay: the list price, their price, and the value or the
// work — or a cost we name when we show our work.
const NOT_OURS_AFTER = new RegExp("^\\s*(?:arv\\b|after[- ]repair|(?:in|of|for)\\s+(?:rehab|repairs?|work)\\b|rehab\\b|repairs?\\b|(?:worth\\s+)?of\\s+work\\b|done\\b|fixed\\b|finished\\b|renovated\\b|retail\\b|once\\b|after\\s+(?:the\\s+)?(?:work|reno|rehab|repairs)|emd\\b|earnest\\b|deposit\\b|is\\s+(?:way\\s+|well\\s+|a\\s+(?:bit|lot)\\s+|too\\s+)?(?:past|over|above|beyond|out\\s+of|more\\s+than|too)|" + COST_AFTER + ")", "i");
const NOT_OURS_BEFORE = new RegExp("(?:\\barv|after[- ]repair value|\\brehab|\\brepairs?|\\bwork|\\blist(?:ed|ing)?(?:\\s+price)?|\\basking(?:\\s+price)?|\\bpriced|\\bon\\s+price|\\bthe\\s+market|\\bworth|\\bvalue|\\b(?:came|come|dropped|reduced|cut|down)\\s+(?:down\\s+)?to|\\breads?\\s+(?:like|as)|" + COST_BEFORE + ")\\s*(?:is|of|at|=|:|around|about|~|for)?\\s*$", "i");

/**
 * pricesWeName(text, reference) → [dollars]
 *
 * The prices a reply of ours puts on the house — "$650k", "650k", and the
 * shorthand "at 650" — but not the ARV, the rehab or the list price said
 * beside them. What the reply gate measures against our own number.
 */
export function pricesWeName(text = "", reference = 0) {
  const t = String(text || "");
  const out = new Set();
  const lows = rangeLows(t);
  const ours = (start, end) => !inLow(lows, start) && !NOT_OURS_AFTER.test(t.slice(end, end + 28)) && !NOT_OURS_BEFORE.test(t.slice(Math.max(0, start - 28), start));
  for (const m of t.matchAll(LINE_MONEY_RX)) {
    if (!ours(m.index, m.index + m[0].length)) continue;
    const n = toDollars(m[0]);
    if (n > 0) out.add(n);
  }
  for (const h of shorthandHits(t, reference)) if (ours(h.start, h.end)) out.add(h.v);
  // A range's top is the price it names ("between 280 and 295" is 295).
  for (const r of lows) if (ours(r.hiStart, r.hiEnd)) out.add(r.high);
  return [...out];
}

/**
 * ourMoveUp(offer, transcript) → { amount, ts, text } | null
 *
 * The other half of ourComeDown: a HIGHER number we put to the agent after
 * the offer's number last moved, that the offer was never revised to. Jesse
 * (2026-09-25): the book said 550K, the bot texted "workable for us at
 * 650", and his "yes I can do that" was released as an acceptance of 550.
 * Whoever typed it, the book and the thread now disagree, and nothing a
 * machine does next — accept, send paper, restate — is safe until a person
 * settles the number (a re-quote or a revision moves pricedAt past it).
 */
export function ourMoveUp(o, transcript = "") {
  const amount = Number(o?.cashAmount) || 0;
  if (!amount || !transcript) return null;
  const since = pricedAt(o);
  const slack = Math.max(1000, amount * 0.005);
  let best = null;
  for (const line of String(transcript).split(/\r?\n/)) {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] US \w+: (.*)$/.exec(line);
    if (!m) continue;
    const ts = Date.parse(`${m[1]}T${m[2]}:00Z`);
    if (!Number.isFinite(ts) || ts < since) continue;
    const text = m[3].trim();
    if (OFFER_DOC_TEXT_RX.test(text)) continue;
    const higher = pricesWeName(text, amount).filter((n) => n > amount + slack && n <= amount * 3);
    if (!higher.length) continue;
    const n = Math.max(...higher);
    if (!best || n > best.amount) best = { amount: n, ts, text: text.slice(0, 120) };
  }
  return best;
}

// A text of ours is about this house when it names its number and street:
// "On 336 SW 15th we'd likely land around 185k". A line that names only the
// street ("the 15th St seller") could be any house on it, and an agent with
// four houses in play gets numbers for all four in one thread.
const DIRECTION = /^(?:n|s|e|w|ne|nw|se|sw|north|south|east|west|northeast|northwest|southeast|southwest)$/i;
function namesHouse(text, address) {
  const p = parseUsAddress(address);
  const word = String(p.street || "").split(/\s+/).find((w) => w && !DIRECTION.test(w.replace(/\./g, "")));
  if (!p.houseNo || !word) return false;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc(p.houseNo)}\\b`).test(text) && new RegExp(`\\b${esc(word)}\\b`, "i").test(text);
}

/**
 * lastQuoteOnHouse(offer, transcript) → { amount, ts, text } | null
 *
 * The price we last put to the agent on this offer's house — a text of ours
 * that names the house — whatever row it came off, and whoever typed it.
 * The lowest price in that text when it names several.
 */
export function lastQuoteOnHouse(o, transcript = "") {
  const amount = Number(o?.cashAmount) || 0;
  if (!amount || !transcript || !o?.address) return null;
  let last = null;
  for (const line of String(transcript).split(/\r?\n/)) {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] US \w+: (.*)$/.exec(line);
    if (!m) continue;
    const ts = Date.parse(`${m[1]}T${m[2]}:00Z`);
    // An offer letter's text names our number first and the math after it.
    const text = quotedPart(m[3].trim());
    if (!Number.isFinite(ts) || !namesHouse(text, o.address)) continue;
    const prices = pricesWeName(text, amount).filter((n) => n >= amount * 0.4 && n <= amount * 3);
    if (!prices.length) continue;
    if (!last || ts >= last.ts) last = { amount: Math.min(...prices), ts, text: text.slice(0, 120) };
  }
  return last;
}

/**
 * sentNumber(offer) → the number on the offer when it last went out
 *
 * A re-quote or revision after the last send changed the book but not what
 * they saw: the first change after that send says what it was (`from`).
 * Nothing sent: the book.
 */
export function sentNumber(o) {
  const book = Math.round(Number(o?.cashAmount) || 0);
  const sent = lastSentAt(o);
  if (!sent) return book;
  const after = [...(o?.revisions || []), ...(o?.requotes || [])]
    .filter((r) => (ms(r?.ts) ?? 0) > sent && Number(r?.from) > 0)
    .sort((a, b) => (ms(a.ts) ?? 0) - (ms(b.ts) ?? 0));
  return after.length ? Math.round(Number(after[0].from)) : book;
}

/**
 * holdNumber({ offer, transcript }) → { amount, text, from } | null
 *
 * "Hold our number" on a counter (the Desk, 2026-10-02). Their counter is
 * above ours and Matt stands where we are: the number said is the lowest we
 * have put to them on this house — the book, a lower number we texted since
 * (ourComeDown), or the last quote that named the house — never above any of
 * them (never-above-what-we-sent). The text names that one number and no
 * other; a text that would read as more is not offered at all.
 */
export function holdNumber({ offer = null, transcript = "" } = {}) {
  const book = sentNumber(offer);
  if (!book) return null;
  const down = ourComeDown(offer, transcript);
  const last = lastQuoteOnHouse(offer, transcript);
  const amount = Math.min(...[book, down?.amount, last?.amount].map((n) => Math.round(Number(n) || 0)).filter((n) => n > 0));
  const where = String(offer.address || "").split(",")[0].trim() || "the house";
  const text = `Appreciate you working it. On ${where} we're going to hold at $${amount.toLocaleString("en-US")}: that's where the numbers work for us. If the seller can get there, we're ready to go.`;
  if (pricesWeName(text, amount).some((n) => n > amount)) return null;
  const from = down && amount === Math.round(down.amount) ? "come_down" : last && amount === Math.round(last.amount) && amount !== book ? "last_quote" : "book";
  return { amount, text, from };
}

/**
 * machineRaise(offer, transcript) → { amount, ts, text } | null
 *
 * The offer's number is above the last price we put to the agent on its
 * house, and no person has stood behind the higher number since. 336 SW
 * 15th St, Chehalis (2026-09-25): we had quoted 185k, a fresh underwrite
 * landed at 192,250 when the agent said the floors were new, and the bot
 * texted "update before you talk to him: we can go around 192k" — seven
 * thousand against ourselves, nobody having asked. A machine never raises
 * our own number; a person does (pin, revise, re-quote, send, or a row
 * they made or published after that text).
 */
export function machineRaise(o, transcript = "") {
  const amount = Number(o?.cashAmount) || 0;
  const q = lastQuoteOnHouse(o, transcript);
  if (!q || amount <= q.amount + Math.max(1000, amount * 0.005)) return null;
  const uw = o.autoUnderwrite;
  const personMade = !uw || uw.publishedAt;
  const settled = maxOf([
    lastSentAt(o),
    ...(o.revisions || []).map((r) => ms(r?.ts)),
    ...(o.requotes || []).map((r) => ms(r?.ts)),
    o.pin?.at && !o.pin.off ? ms(o.pin.at) : 0,
    personMade ? maxOf([ms(o.createdAt), ms(uw?.publishedAt)]) : 0,
  ]);
  return settled > q.ts ? null : q;
}

const kText = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}K`);

/**
 * paperCheck({ offer, offers, transcript }) → { ok, reason, comeDown?, current? }
 *
 * May the machine put this offer's number on paper? No when another row on
 * the house is current (`offers` given), and no when we texted a lower number
 * after this one last moved. The reason names both numbers so the row on
 * Today reads on its own.
 */
export function paperCheck({ offer = null, offers = null, transcript = "" } = {}) {
  if (!offer) return { ok: false, reason: "no offer to send" };
  if (Array.isArray(offers) && isSuperseded(offer, offers)) {
    const cur = resolveHouse(offers.filter((o) => o && groupKey(o) === groupKey(offer)).concat(offers.some((o) => o?.id === offer.id) ? [] : [offer])).current;
    return { ok: false, current: cur, reason: `this isn't the current offer on ${offer.address || "the house"} — ${fmtMoney(Number(cur?.cashAmount) || 0)} is` };
  }
  const down = ourComeDown(offer, transcript);
  if (down) {
    return {
      ok: false, comeDown: down,
      reason: `we texted ${kText(down.amount)} on ${new Date(down.ts).toISOString().slice(0, 10)} after this offer's ${fmtMoney(Number(offer.cashAmount) || 0)} — re-quote it at ${kText(down.amount)} before any paper goes out`,
    };
  }
  // A higher number is never re-quoted to by a button: that is a person
  // deciding to pay more, so there is no comeDown for the app to offer.
  const up = ourMoveUp(offer, transcript);
  if (up) {
    return {
      ok: false, moveUp: up,
      reason: `we texted ${kText(up.amount)} on ${new Date(up.ts).toISOString().slice(0, 10)} after this offer's ${fmtMoney(Number(offer.cashAmount) || 0)} — a person has to settle the number before any paper goes out`,
    };
  }
  // A machine's row came in above what the agent last heard from us on this
  // house: the paper would be a raise nobody decided on. Re-quoting down to
  // the number they have is the button; going up is a pin or a revision.
  const raise = machineRaise(offer, transcript);
  if (raise) {
    return {
      ok: false, comeDown: raise,
      reason: `we last texted ${kText(raise.amount)} on ${new Date(raise.ts).toISOString().slice(0, 10)} and this offer came in above it at ${fmtMoney(Number(offer.cashAmount) || 0)} — re-quote it at ${kText(raise.amount)}, or a person decides to go up`,
    };
  }
  return { ok: true, reason: "" };
}

/**
 * paperHeldNow(offer) → { at, reason, amount } | null
 *
 * The machine held this offer's paper (sendOfferDocs / the reply gate) and
 * nothing has moved its number since. A re-price or a send after the hold
 * makes it moot.
 */
export function paperHeldNow(offer) {
  const h = offer?.paperHeld;
  if (!h?.at) return null;
  return ms(h.at) >= pricedAt(offer) ? h : null;
}

/** supersededIds(offers) → Set of ids some other row on their house replaced. */
export function supersededIds(offers = []) {
  const out = new Set();
  for (const rows of groupHouses(offers).values()) {
    for (const o of resolveHouse(rows).superseded) if (o?.id) out.add(o.id);
  }
  return out;
}
