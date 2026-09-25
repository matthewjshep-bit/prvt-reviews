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
 *
 * New objects; the inputs are not touched.
 */
export function annotateCurrent(offers = []) {
  const verdict = new Map();
  for (const rows of groupHouses(offers).values()) {
    const { current, superseded, pinned } = resolveHouse(rows);
    if (!current) continue;
    verdict.set(current, { isCurrent: true, ...(pinned ? { currentPinned: true } : {}) });
    const by = { id: current.id, cashAmount: Number(current.cashAmount) || 0, at: new Date(pricedAt(current) || Date.now()).toISOString() };
    for (const o of superseded) verdict.set(o, { isCurrent: false, supersededBy: by });
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
export const lineMoney = (text) => [...String(text || "").matchAll(LINE_MONEY_RX)].map((m) => {
  const raw = m[0].replace(/[$,\s]/g, "");
  const k = /k$/i.test(raw);
  const n = Number(k ? raw.slice(0, -1) : raw);
  return Number.isFinite(n) ? Math.round(k ? n * 1000 : n) : 0;
}).filter((n) => n > 0);

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
    if (/\bhere's our (revised )?(written cash offer|letter of intent)\b/i.test(text)) continue;
    // Under the book's number, not absurdly under it, and not the book's
    // own number said the way people text it ("71k" for 71,075).
    const restated = (n) => {
      let unit = 1000;
      while (n % (unit * 10) === 0 && unit < 1e9) unit *= 10;
      return n % 1000 === 0 && Math.abs(n - amount) <= unit / 2 && Math.abs(n - amount) <= amount * 0.01;
    };
    const lower = lineMoney(text).filter((n) => n < amount && n >= amount * 0.4 && !restated(n));
    if (!lower.length) continue;
    const n = Math.min(...lower);
    if (!best || n < best.amount) best = { amount: n, ts, text: text.slice(0, 120) };
  }
  return best;
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
