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

import { parseUsAddress, addressKey, sameStreetLoose, oneAgentsHouse } from "./us-address.js";
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

/**
 * rowOnHouse(rows, { address, exceptId }) → offer | null
 *
 * The one row a house keeps in the offer editor (2026-10-23): the editor
 * saves as you type, so a "New offer" on a house that already has a row —
 * a draft, an offer that went out, a held auto-underwrite — opens that row
 * instead of starting a second. `rows` are one agent's offers (or the
 * contactless drafts). Its current offer, else its newest draft.
 *
 * The house number + street, give or take the suffix: the GHL shorthand
 * field writes "4410 N Mullen" for "4410 N Mullen St". A street with no
 * house number names no house, and a deal is left to the Deals tab.
 */
export function rowOnHouse(rows = [], { address = "", exceptId = null } = {}) {
  const key = houseKey(address);
  if (!key || !parseUsAddress(address).houseNo || !/^\s*\d/.test(String(address))) return null;
  const same = (rows || []).filter((o) => {
    if (!o || o.id === exceptId || o.deal) return false;
    const at = o.address || o.calc?.inputs?.address || o.draft?.inputs?.address || "";
    return houseKey(at) === key || sameStreetLoose(at, address) || oneAgentsHouse(at, address);
  });
  if (!same.length) return null;
  const touched = (o) => ms(o.updatedAt) || ms(o.createdAt);
  return resolveHouse(same).current || [...same].sort((a, b) => touched(b) - touched(a))[0];
}

/**
 * foldHouses(offers) → [{ top, older }]
 *
 * One agent's offers as the houses they are, for a list a person reads
 * (Matt, 2026-10-26: "one offer per address" — Kimberly's pane listed
 * "12201 Champion Dr" and "12201 Champion Dr SW" as two drafts). `top` is
 * the house's current offer, else its newest draft; `older` is everything
 * else on it, newest first. Houses keep the order they first appear in.
 * Spellings fold by oneAgentsHouse, so it is for one contact's rows; the
 * machines keep groupHouses. A row with no address is its own house.
 */
export function foldHouses(offers = []) {
  const groups = [];
  for (const o of offers || []) {
    if (!o) continue;
    const at = String(o.address || "").trim();
    const g = at && groups.find((x) => x.contactId === (o.contactId || "") && x.rows.some((r) => oneAgentsHouse(r.address, at)));
    if (g) g.rows.push(o);
    else groups.push({ contactId: o.contactId || "", rows: [o] });
  }
  const touched = (o) => ms(o.updatedAt) || ms(o.createdAt);
  return groups.map(({ rows }) => {
    const top = resolveHouse(rows).current || [...rows].sort((a, b) => touched(b) - touched(a))[0];
    const older = rows.filter((o) => o !== top).sort((a, b) => (pricedAt(b) || touched(b)) - (pricedAt(a) || touched(a)));
    return { top, older };
  });
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
 * houseRowFor(offers, { contactId, address }) → offer | null
 *
 * currentOfferFor, and when the house has no live row, its newest held
 * draft: what an agent says about a house the app hasn't priced yet still
 * lands on it (1538 NW 61st St, 2026-10-19: the only row was a draft waiting
 * for comps when the agent sent the paperwork to sign).
 */
export function houseRowFor(offers = [], { contactId = "", address = "" } = {}) {
  const live = currentOfferFor(offers, { contactId, address });
  if (live) return live;
  const held = (offers || []).filter((o) => o && isDraftOffer(o) && (!contactId || o.contactId === contactId));
  const houses = groupHouses(held);
  const hint = String(address || "").trim();
  let rows = null;
  if (hint) {
    const key = houseKey(hint);
    const exact = [...houses.entries()].filter(([k]) => k.endsWith(`|${key}`));
    if (exact.length === 1) rows = exact[0][1];
  } else if (houses.size === 1) {
    rows = [...houses.values()][0];
  }
  // A house with a live row elsewhere in the book is that row's, not a draft's.
  if (!rows || (!hint && (offers || []).some((o) => o && !isDraftOffer(o) && (!contactId || o.contactId === contactId)))) return null;
  return [...rows].sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0] || null;
}

/**
 * walkedAwayFrom(offers, { contactId, address }) → that house's current offer
 * when we passed on it ("we_passed") or it's gone ("unavailable"), else null.
 * Nothing the machine starts about such a house goes to the agent (Matt,
 * 2026-10-19, 3037 Massey Rd: "we need to make sure we are not reaching out
 * on an offer we passed"). A text with no address names no house: null.
 */
export function walkedAwayFrom(offers = [], { contactId = "", address = "" } = {}) {
  if (!String(address || "").trim()) return null;
  const o = currentOfferFor(offers || [], { contactId, address });
  return o && !o.deal && WALKED_AWAY.has(o.status) ? o : null;
}
const WALKED_AWAY = new Set(["we_passed", "unavailable"]);

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
// Their number, said back to them (2026-11-09): "the seller's bottom is 450",
// "their number is 450", "he's hoping for 450", and figures that are no price
// on the house at all: the HOA, the rent, the taxes, what they owe, a
// Zestimate or an appraisal. A their-word is required before "bottom" or
// "number": "our bottom line is 400" is ours. Read on the rough numbers only
// (roughHits), so a figure the money gate already caught stays caught.
const THEIRS_BEFORE = "\\b(?:their|his|her|the\\s+sellers?'?s?|sellers?'?s?|the\\s+owners?'?s?|owners?'?s?)\\s+(?:bottom(?:\\s+line)?|floor|number|price|ask(?:ing)?|target|net)|" +
  "\\b(?:they(?:'re|\\s+are)?|he(?:'s|\\s+is)?|she(?:'s|\\s+is)?|(?:the\\s+)?sellers?(?:\\s+(?:is|are))?)\\s+hoping\\s+(?:to\\s+get|for)|" +
  "\\bzestimate|\\bapprais(?:ed|al)|\\bassessed|\\bhoa(?:\\s+dues)?|\\bdues|\\brent|\\btax(?:es)?|\\bpayoff|\\bowes?|\\bowed|\\bmortgage|\\bloan";
const THEIRS_BEFORE_RX = new RegExp("(?:" + THEIRS_BEFORE + ")\\s*(?:is|of|at|=|:|around|about|~|for)?\\s*$", "i");

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
// Rough numbers (2026-11-09). "We'd probably come in near 515ish", "our
// number is 400", "probably 450", "the mid 400s", "the 450 range": the bot's
// rough floats, which the readers above never saw, so neither did the money
// gate nor never-raise. A band reads as its BOTTOM third: "low 400s" is 400K,
// "mid" 433K, "high" or "upper" 466K. Each hit passes the not-ours words below
// (the seller's bottom, the list, the HOA, the work) before it counts, so a
// their-price phrasing that trips goes there, never into a looser rule.
const ROUGH_CUE_RX = /\b(?:is|likely|probably|land(?:ing)?(?:\s+(?:at|around|near|in\s+at))?|number\s+is|come\s+in\s+at|around)\s+(\d{2,4})(?![\d,]|\.\d|\s?[kKmM]\b|'?s\b)/gi;
const ROUGH_ISH_RX = /(?<![\w,.$])\$?(\d{2,4})\s?([kK])?ish\b/g;
const ROUGH_BAND_RX = /\b(low|mid|high|upper)[\s-]+\$?(\d{2,4})[kK]?'?s\b/gi;
const ROUGH_RANGE_RX = /(?<![\w,.$])\$?(\d{2,4})\s?([kK])?\s+(?:range|or\s+so)\b/gi;
const YEAR = /^(?:19|20)\d\d$/;
function roughHits(t) {
  const hits = [];
  for (const m of t.matchAll(ROUGH_CUE_RX)) {
    const start = m.index + m[0].length - m[1].length;
    const end = start + m[1].length;
    const rest = t.slice(end, end + 12);
    if (YEAR.test(m[1]) || SHORT_UNIT.test(rest) || SHORT_STREET.test(rest) || /^\s+[A-Z]/.test(rest)) continue;
    hits.push({ v: Number(m[1]) * 1000, start, end });
  }
  for (const rx of [ROUGH_ISH_RX, ROUGH_RANGE_RX]) {
    for (const m of t.matchAll(rx)) {
      const start = m.index + m[0].indexOf(m[1]);
      hits.push({ v: Number(m[1]) * 1000, start, end: m.index + m[0].length });
    }
  }
  for (const m of t.matchAll(ROUGH_BAND_RX)) {
    const n = Number(m[2]);
    const width = n % 100 === 0 ? 100 : n % 10 === 0 ? 10 : 1;
    const step = { low: 0, mid: Math.floor(width / 3), high: Math.floor((2 * width) / 3), upper: Math.floor((2 * width) / 3) }[m[1].toLowerCase()];
    const start = m.index + m[0].indexOf(m[2], m[1].length);
    hits.push({ v: (n + step) * 1000, start, end: m.index + m[0].length });
  }
  return hits.filter((h) => notTheirs(t, h.start, h.end));
}
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
  for (const h of roughHits(t)) if (plausible(h.v)) hits.push(h);
  return hits;
}
export function shorthandPrices(text = "", reference = 0) {
  return [...new Set(shorthandHits(String(text || ""), reference).map((h) => h.v))];
}

// Not a price we'd pay: the list price, their price, and the value or the
// work — or a cost we name when we show our work.
const NOT_OURS_AFTER = new RegExp("^\\s*(?:arv\\b|after[- ]repair|(?:in|of|for)\\s+(?:rehab|repairs?|work)\\b|rehab\\b|repairs?\\b|(?:worth\\s+)?of\\s+work\\b|done\\b|fixed\\b|finished\\b|renovated\\b|retail\\b|once\\b|after\\s+(?:the\\s+)?(?:work|reno|rehab|repairs)|emd\\b|earnest\\b|deposit\\b|is\\s+(?:way\\s+|well\\s+|a\\s+(?:bit|lot)\\s+|too\\s+)?(?:past|over|above|beyond|out\\s+of|more\\s+than|too)|" + COST_AFTER + ")", "i");
const NOT_OURS_BEFORE = new RegExp("(?:\\barv|after[- ]repair value|\\brehab|\\brepairs?|\\bwork|\\blist(?:ed|ing)?(?:\\s+price)?|\\basking(?:\\s+price)?|\\bpriced|\\bon\\s+price|\\bthe\\s+market|\\bworth|\\bvalue|\\b(?:came|come|dropped|reduced|cut|down)\\s+(?:down\\s+)?to|\\breads?\\s+(?:like|as)|" + COST_BEFORE + ")\\s*(?:is|of|at|=|:|around|about|~|for)?\\s*$", "i");
// Is the rough number at [start, end) a price we'd pay, by the words around
// it? The not-ours words above, and their number said back to them.
function notTheirs(t, start, end) {
  const before = t.slice(Math.max(0, start - 28), start);
  return !NOT_OURS_AFTER.test(t.slice(end, end + 28)) && !NOT_OURS_BEFORE.test(before) && !THEIRS_BEFORE_RX.test(before);
}

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

// What the house is worth fixed up, in our words: "842k fixed up", "comps
// closer to 842k", "ARV around 842k". The value only — never the work, the
// list price or a cost.
const VALUE_AFTER = /^\s*(?:arv\b|after[- ]repairs?\b|(?:once\s+)?(?:it'?s\s+)?(?:fixed(?:\s+up)?|done|finished|renovated|updated|remodeled|flipped)\b|retail\b|(?:on\s+)?resale\b)/i;
const VALUE_BEFORE = /(?:\barv|after[- ]repair value|\bworth|\bvalued?|\bcomps?\b[^.!?\d$]{0,24}|\bresale|\bretail|\bsells?\s+for|\bsold\s+(?:for|at))\s*(?:is|of|at|=|:|around|about|~|closer\s+to|more\s+like|near|for|in\s+the)?\s*$/i;

/**
 * valuesWeName(text, reference) → [dollars]
 *
 * The values a reply of ours puts on the house fixed up. The reply gate
 * holds one above what the agent told us it's worth (15426 Stone Ave N,
 * 2026-10-16: "650–680 fixed up" answered with "we're actually seeing comps
 * closer to 842k fixed up"). `reference` steers the shorthand ("closer to
 * 842") the way pricesWeName's does. Pure.
 */
export function valuesWeName(text = "", reference = 0) {
  const t = String(text || "");
  const out = new Set();
  const value = (start, end) => VALUE_AFTER.test(t.slice(end, end + 28)) || VALUE_BEFORE.test(t.slice(Math.max(0, start - 40), start));
  for (const m of t.matchAll(LINE_MONEY_RX)) {
    if (!value(m.index, m.index + m[0].length)) continue;
    const n = toDollars(m[0]);
    if (n > 0) out.add(n);
  }
  for (const h of shorthandHits(t, reference)) if (value(h.start, h.end)) out.add(h.v);
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

// Some house, ours or not: "1450 Marlow", "336 SW 15th", "40 Ash Ct". A
// house number then a capitalised name, a numbered street, or a street word
// with its suffix. Reading a line as about SOME house is the safe mistake:
// the price in it is then nobody's.
const ANY_HOUSE_RX = new RegExp("(?<![\\d,.$])\\b\\d{2,6}\\s+(?:(?:[NSEW]|NE|NW|SE|SW|North|South|East|West)\\.?\\s+)?(?:\\d{1,3}(?:st|nd|rd|th)\\b|[A-Z][a-z]{2,})" +
  "|(?<![\\d,.$])\\b\\d{2,6}\\s+[a-z]{3,}\\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|pl|place|way|blvd|loop|cir|circle|ter|terrace|pkwy|trl|trail|hwy)\\b");
const streetWordOf = (address) => String(parseUsAddress(address).street || "").split(/\s+/).find((w) => w && !DIRECTION.test(w.replace(/\./g, ""))) || "";
const wordIn = (text, w) => w.length >= 3 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
const CLOSED_STATUSES = new Set(["we_passed", "passed", "unavailable", "expired", "withdrawn", "no_response"]);
// When a row stopped being a house in play, or 0 (open, or no time on it).
function closedAt(r) {
  if (!CLOSED_STATUSES.has(r?.status)) return 0;
  return maxOf([...(r.statusHistory || []).filter((h) => h?.status === r.status).map((h) => ms(h.ts)), ms(r.statusAt)]);
}

/**
 * quotesOnHouse(offer, transcript, { offers }) → [{ amount, ts, text, low? }], oldest first
 *
 * Every price we put to the agent on this offer's house, whatever row it
 * came off and whoever typed it: a text of ours that names the house, and
 * (2026-11-09) one that names a price but no house at all — "we'd likely
 * come in near 515ish" — when `offers` (the agent's book) says it can
 * only have been this one: the agent had no other house in play when it
 * went, or the nearest line before it that named a house (theirs or ours)
 * named this one. 102 of 166 bot floats from September to November named no
 * house number, and never-raise and never-cut saw none of them. A line that
 * names another house, or some house we can't place, is nobody's. Without
 * the book only the texts that name the house count, as before. `low` is
 * the bottom of a range the text floated ("between 280k and 295k").
 */
function quotesOnHouse(o, transcript = "", { offers = null } = {}) {
  const amount = Number(o?.cashAmount) || 0;
  if (!amount || !transcript || !o?.address) return [];
  const book = Array.isArray(offers) ? offers.filter((r) => r && String(r.address || "").trim() && (!o.contactId || !r.contactId || r.contactId === o.contactId)) : null;
  const key = houseKey(o.address);
  const onThis = (r) => r.id === o.id || houseKey(r.address) === key || oneAgentsHouse(r.address, o.address);
  const others = (book || []).filter((r) => !onThis(r));
  const mine = streetWordOf(o.address).toLowerCase();
  const otherWords = [...new Set(others.map((r) => streetWordOf(r.address)).filter((w) => w && w.toLowerCase() !== mine))];
  const about = (text) => {
    if (namesHouse(text, o.address)) return "this";
    if (others.some((r) => namesHouse(text, r.address)) || ANY_HOUSE_RX.test(text) || otherWords.some((w) => wordIn(text, w))) return "other";
    return "none";
  };
  // No other house of the agent's was in play at `ts` (drafts count: a house
  // we were still pricing is a house the text could be about). This house's
  // own rows needn't date from then: a re-run replaces the row a float came off.
  const onlyHouseThen = (ts) => Boolean(book) && !others.some((r) => (!ms(r.createdAt) || ms(r.createdAt) <= ts) && !(closedAt(r) && closedAt(r) < ts));
  const out = [];
  let lastNamed = "none";
  for (const line of String(transcript).split(/\r?\n/)) {
    const any = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] (US|THEM) \w+(?: TRANSCRIPT)?:? ?(.*)$/.exec(line);
    if (!any) continue;
    const ts = Date.parse(`${any[1]}T${any[2]}:00Z`);
    if (!Number.isFinite(ts)) continue;
    const ours = any[3] === "US" && /^\[[^\]]+\] US \w+: /.test(line);
    // An offer letter's text names our number first and the math after it.
    const text = ours ? quotedPart(any[4].trim()) : any[4].trim();
    const house = about(text);
    if (ours) {
      const prices = pricesWeName(text, amount).filter((n) => n >= amount * 0.4 && n <= amount * 3);
      const counts = house === "this" || (house === "none" && book && (onlyHouseThen(ts) || lastNamed === "this"));
      if (prices.length && counts) {
        const q = Math.min(...prices);
        // A range we floated ("between 280 and 295"): its bottom is ours to
        // say too, so the gate never reads 285 after it as a cut.
        const low = Math.min(q, ...rangeLows(text).filter((r) => Math.round(r.high) === Math.round(q)).map((r) => Math.round(r.low)));
        out.push({ amount: q, ts, text: text.slice(0, 120), ...(low < q ? { low } : {}) });
      }
    }
    if (house !== "none") lastNamed = house;
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * lastQuoteOnHouse(offer, transcript, { offers }) → { amount, ts, text } | null
 *
 * The price we last put to the agent on this offer's house (quotesOnHouse).
 * The lowest price in that text when it names several.
 */
export function lastQuoteOnHouse(o, transcript = "", { offers = null } = {}) {
  return quotesOnHouse(o, transcript, { offers }).at(-1) || null;
}

/**
 * typedAboveBook({ offer, transcript, offers, events }) → { typed, book, ts, line } | null
 *
 * Matt's own last typed number on the house (a text of ours that lines up
 * with a `hand_reply` on the timeline) is above what a machine hold would say
 * (2026-11-05: he texted a round number above the book; days later the bot
 * held at the book's odd number, under it). The machine doesn't hold under his word; the line is
 * the why on Needs Matt. Moot when a person brought the offer down to that
 * number after his text.
 */
export function typedAboveBook({ offer = null, transcript = "", offers = null, events = [] } = {}) {
  const book = sentNumber(offer);
  if (!book || !transcript) return null;
  const typedAt = (events || []).filter((e) => e?.type === "hand_reply" && (!e.contactId || !offer.contactId || e.contactId === offer.contactId))
    .map((e) => ms(e.at)).filter(Boolean);
  if (!typedAt.length) return null;
  // A transcript line is stamped to the minute; the event to the second.
  const byHand = (ts) => typedAt.some((t) => t >= ts - 60000 && t < ts + 120000);
  const q = quotesOnHouse(offer, transcript, { offers }).filter((x) => byHand(x.ts)).at(-1);
  if (!q) return null;
  const hold = holdAmount({ offer, transcript, offers });
  if (!hold || q.amount <= hold.raw + Math.max(1000, hold.raw * 0.005)) return null;
  if (settledSince(offer) > q.ts && Number(offer.cashAmount) <= hold.raw + Math.max(1000, hold.raw * 0.005)) return null;
  const where = String(offer.address || "").split(",")[0].trim() || "the house";
  return { typed: q.amount, book: hold.raw, ts: q.ts, line: `you texted ${kText(q.amount)} on ${where}; the offer says ${hold.raw.toLocaleString("en-US")}` };
}

/**
 * personPricedAt(offer) → ms, or 0
 *
 * When a person last put their own number on this row: one they made by hand
 * (or sent), published, pinned, revised by hand, or approved. A machine's row,
 * re-quote or counter-band move is not a person's number.
 */
const MACHINE_MOVES = new Set(["requote", "counter_band", "walkaway"]);
export function personPricedAt(o) {
  if (!o) return 0;
  const uw = o.autoUnderwrite;
  return maxOf([
    !uw ? maxOf([ms(o.createdAt), lastSentAt(o)]) : 0,
    ms(uw?.publishedAt),
    o.pin?.at && !o.pin.off ? ms(o.pin.at) : 0,
    ...(o.revisions || []).filter((r) => !MACHINE_MOVES.has(r?.by)).map((r) => ms(r?.ts)),
    Number(o.approved?.amount) > 0 ? ms(o.approved.at) : 0,
  ]);
}

/**
 * otherAgentsNumber({ offer, offers, now, days }) → { amount, contactId, id, at } | null
 *
 * Two agents on one house hear one number (2026-11-07: the machine floated
 * about 305 to one agent while Matt had given the other about 290). The
 * newest number a person put on the same house for ANOTHER agent in the last
 * `days`, when ours is not within slack of it; null when they match, or no
 * person priced it for anyone else. The house is matched on number + street.
 */
export function otherAgentsNumber({ offer = null, offers = [], now = Date.now(), days = 14 } = {}) {
  const amount = Math.round(Number(offer?.cashAmount) || 0);
  const key = offer?.address ? houseKey(offer.address) : "";
  if (!amount || !key || !parseUsAddress(offer.address).houseNo) return null;
  const since = now - days * 86400000;
  const theirs = (offers || [])
    .filter((r) => r && r.id !== offer.id && r.contactId && r.contactId !== offer.contactId && !r.deal && !isDraftOffer(r)
      && Number(r.cashAmount) > 0 && houseKey(r.address || "") === key)
    .map((r) => ({ r, at: personPricedAt(r) }))
    .filter((x) => x.at >= since)
    .sort((a, b) => b.at - a.at)[0];
  if (!theirs) return null;
  const n = Math.round(Number(theirs.r.cashAmount));
  if (Math.abs(n - amount) <= Math.max(1000, n * 0.005)) return null;
  return { amount: n, contactId: theirs.r.contactId, id: theirs.r.id || null, at: new Date(theirs.at).toISOString() };
}

/**
 * awaitingReprice(offer) → boolean
 *
 * A number the old machine priced that no one has stood behind (2026-11-09):
 * an open row the auto-underwrite made, never sent, never floated, not
 * published, pinned, revised by hand or approved, and not the offer engine's
 * own (`pricing.live`, or `autoUnderwrite.basis: "engine"` on a lean row).
 * In engine mode it is being re-priced: the bot says there's no number yet,
 * and nothing floats it. 3 of the first 5 numbers floated after engine mode
 * came off such rows, with $4.5k to $50k of rehab. Whether the thread
 * already carries its number is the caller's to check (lastQuoteOnHouse).
 */
export function awaitingReprice(o) {
  if (!o || isDraftOffer(o) || o.deal || !(Number(o.cashAmount) > 0)) return false;
  if (o.status && o.status !== "new") return false;
  const uw = o.autoUnderwrite;
  if (!uw || uw.publishedAt || uw.basis === "engine" || o.pricing?.live) return false;
  if (lastSentAt(o) || o.floatSentAt || (o.pin?.at && !o.pin.off) || Number(o.approved?.amount) > 0) return false;
  return !(o.revisions || []).some((r) => !MACHINE_MOVES.has(r?.by));
}

/**
 * quoteGateFlags({ reply, intent, quotes }) → [flag]
 *
 * The reply gate's two number checks on the house a draft is about
 * (2026-11-09). `quotes` = { lastOnHouse: { amount, ts, low? }, sellerNumber,
 * personBehindChange, street }:
 *   - a price above or below the last one we texted on the house, when no
 *     person stood behind the book's number since (machineRaise/machineCut,
 *     for the reply bot). A counter's number above it is the band's to weigh.
 *   - a price above the seller's own number on the house (their words, a
 *     house_mentioned ask, their counter; never the list price or a payoff).
 *     Matt, 2026-11-09: "the machine never offers more than the seller said
 *     they'd take" (2026-11-06: ours 49K over their number, and the agent said yes).
 * Pure; only ever adds holds.
 */
export function quoteGateFlags({ reply = "", intent = "", quotes = null } = {}) {
  if (!quotes || !String(reply || "").trim()) return [];
  const flags = [];
  const last = Math.round(Number(quotes.lastOnHouse?.amount) || 0);
  const seller = Math.round(Number(quotes.sellerNumber) || 0);
  const where = String(quotes.street || "").trim() || "the house";
  const named = pricesWeName(reply, last || seller);
  if (last > 0 && !quotes.personBehindChange) {
    const slack = Math.max(1000, last * 0.005);
    // The bottom of a range we floated is no cut.
    const floor = Math.min(last, Math.round(Number(quotes.lastOnHouse?.low) || last));
    const up = intent === "counter" ? [] : named.filter((n) => n > last + slack && n <= last * 3);
    const down = named.filter((n) => n < floor - slack && n >= last * 0.4);
    if (up.length) flags.push(`the draft says ${up.map((n) => fmtMoney(n)).join(", ")}, above the ${kText(last)} we last texted on ${where} — the machine never raises our own number; a person decides to go up`);
    if (down.length) flags.push(`the draft says ${down.map((n) => fmtMoney(n)).join(", ")}, below the ${kText(last)} we last texted on ${where} — the machine never takes our number back; a person decides to go down`);
  }
  if (seller > 0 && named.some((n) => n > seller)) flags.push(`the seller's number on ${where} is ${kText(seller)}: we never offer above it`);
  return flags;
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

// The lowest number we have put to them on the house: the book as it went
// out, a lower number we texted since, or the last quote that named it.
function holdAmount({ offer = null, transcript = "", offers = null } = {}) {
  const book = sentNumber(offer);
  if (!book) return null;
  const down = ourComeDown(offer, transcript);
  const last = lastQuoteOnHouse(offer, transcript, { offers });
  const raw = Math.min(...[book, down?.amount, last?.amount].map((n) => Math.round(Number(n) || 0)).filter((n) => n > 0));
  return { raw, book, down, last };
}

/**
 * holdNumber({ offer, transcript, offers, events }) → { amount, text, from } | null
 *
 * "Hold our number" on a counter (the Desk, 2026-10-02). Their counter is
 * above ours and Matt stands where we are: the number said is the lowest we
 * have put to them on this house — the book, a lower number we texted since
 * (ourComeDown), or the last quote that named the house — never above any of
 * them (never-above-what-we-sent). The text names that one number and no
 * other; a text that would read as more is not offered at all.
 *
 * 2026-11-09: never under a number Matt typed himself on the house
 * (typedAboveBook, with the timeline's `events`): null, and that line is
 * Needs Matt's why. And the number is said rounded DOWN to the thousand
 * ("hold at 418,000", not 418,640), inside machineCut's slack: an odd book
 * number read as machine-made.
 */
export function holdNumber({ offer = null, transcript = "", offers = null, events = [] } = {}) {
  const h = holdAmount({ offer, transcript, offers });
  if (!h) return null;
  if (typedAboveBook({ offer, transcript, offers, events })) return null;
  const { raw, book, down, last } = h;
  const amount = raw >= 10000 ? Math.floor(raw / 1000) * 1000 : raw;
  const where = String(offer.address || "").split(",")[0].trim() || "the house";
  const text = `Appreciate you working it. On ${where} we're going to hold at $${amount.toLocaleString("en-US")}: that's where the numbers work for us. If the seller can get there, we're ready to go.`;
  if (pricesWeName(text, amount).some((n) => n > amount)) return null;
  const from = down && raw === Math.round(down.amount) ? "come_down" : last && raw === Math.round(last.amount) && raw !== book ? "last_quote" : "book";
  return { amount, text, from };
}

/**
 * machineRaise(offer, transcript, { offers }) → { amount, ts, text } | null
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
export function machineRaise(o, transcript = "", { offers = null } = {}) {
  const amount = Number(o?.cashAmount) || 0;
  const q = lastQuoteOnHouse(o, transcript, { offers });
  if (!q || amount <= q.amount + Math.max(1000, amount * 0.005)) return null;
  return settledSince(o) > q.ts ? null : q;
}

/**
 * machineCut(offer, transcript) → { amount, ts, text } | null
 *
 * The mirror of machineRaise: the offer's number is BELOW the last price we
 * put to the agent on its house, and no person has stood behind the lower
 * number since. 2026-10-09, reading every house an agent brought us: a
 * re-run that came back under what we had already floated (571K → 522K,
 * 400K → 214K on a wrong ARV) soured agents who were sending us houses. A
 * machine never takes back its own number either; a person does.
 */
export function machineCut(o, transcript = "", { offers = null } = {}) {
  const amount = Number(o?.cashAmount) || 0;
  const q = lastQuoteOnHouse(o, transcript, { offers });
  if (!q || amount >= q.amount - Math.max(1000, q.amount * 0.005)) return null;
  return settledSince(o) > q.ts ? null : q;
}

// When a person last stood behind the offer's own number: a send, a
// revision or re-quote, a pin, or a row they made or published.
export const personSettledAt = (o) => (o ? settledSince(o) : 0);
function settledSince(o) {
  const uw = o.autoUnderwrite;
  const personMade = !uw || uw.publishedAt;
  return maxOf([
    lastSentAt(o),
    ...(o.revisions || []).map((r) => ms(r?.ts)),
    ...(o.requotes || []).map((r) => ms(r?.ts)),
    o.pin?.at && !o.pin.off ? ms(o.pin.at) : 0,
    personMade ? maxOf([ms(o.createdAt), ms(uw?.publishedAt)]) : 0,
  ]);
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
  const book = Array.isArray(offers) ? offers : null;
  const raise = machineRaise(offer, transcript, { offers: book });
  if (raise) {
    return {
      ok: false, comeDown: raise,
      reason: `we last texted ${kText(raise.amount)} on ${new Date(raise.ts).toISOString().slice(0, 10)} and this offer came in above it at ${fmtMoney(Number(offer.cashAmount) || 0)} — re-quote it at ${kText(raise.amount)}, or a person decides to go up`,
    };
  }
  // …and below it: paper under what they last heard would take our number
  // back, which only a person does.
  const cut = machineCut(offer, transcript, { offers: book });
  if (cut) {
    return {
      ok: false, cut,
      reason: `we last texted ${kText(cut.amount)} on ${new Date(cut.ts).toISOString().slice(0, 10)} and this offer came in below it at ${fmtMoney(Number(offer.cashAmount) || 0)} — a person decides whether to take our number back`,
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
