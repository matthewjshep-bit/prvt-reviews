// price-watch.js — the list price moved after we priced it.
//
// Lisa Dreyer texted "Price lowered to 675" on 2026-09-14, three weeks after
// the seller passed on our 571k. A seller cutting price is the moment our
// number gets a second look — and we only heard because she happened to text.
//
// Once a day this re-reads the listing for every house we priced, sent,
// countered or had passed on in the last 90 days (one batched Zillow run),
// and remembers what it saw on the offer (`priceWatch`). The first look is the
// baseline; after that:
//
//   a real drop (≥ $5k and ≥ 2%)  → `price_dropped`, and a `price_drop` text:
//                                    "saw it came down to 675 — would the seller
//                                    look at cash closer to ours now?" It may
//                                    restate our number; it never raises it.
//   off the market (sold/pending) → `listing_off_market`, and no text.
//
// Claimed per offer and price, so a second run on the same price never texts.

import { recordEvent } from "./contact-record.js";
import { conversationConfig, startProactive } from "./reply-agent.js";
import { fetchZillowListings } from "./rehab-scan.js";
import { streetKey } from "./comps-zillow.js";
import { addressKey } from "./shared/us-address.js";
import { effectiveStatus } from "./shared/offer-status.js";
import { localHour } from "./promise-sweep.js";

const DAY_MS = 86400000;
export const WATCH_DAYS = 90;
export const WATCH_STATUSES = ["sent", "countered", "passed", "no_response"];
export const MIN_DROP_DOLLARS = 5000;
export const MIN_DROP_PCT = 0.02;
export const CURSOR_NAME = "priceWatch";
export const WATCH_HOUR = 9;          // Pacific, when the agent is at their desk
const MIN_GAP_MS = 20 * 3600 * 1000;

const iso = (ms) => new Date(ms).toISOString();

// { dropped, from, to, pct }
export function evaluateDrop({ from = 0, to = 0 } = {}) {
  const a = Math.round(Number(from) || 0), b = Math.round(Number(to) || 0);
  const gap = a - b;
  const dropped = a > 0 && b > 0 && gap >= Math.max(MIN_DROP_DOLLARS, a * MIN_DROP_PCT);
  return { dropped, from: a, to: b, pct: a > 0 ? Math.round((gap / a) * 1000) / 10 : 0 };
}

// One house can carry several offers to the same agent — a send, then a
// re-underwrite that never went out, then the counter filed on whichever was
// newest. 521 Avenue C (2026-09-24): the text quoted the unsent 522k while
// the agent held 571k in writing, and asked the seller to come toward us a
// day after she'd asked us for 580 — under the new 599,950 list. So the text
// reads the whole book on the house, not the one row the watch picked.
const tsOf = (t) => { const n = Date.parse(t || ""); return Number.isFinite(n) ? n : 0; };
const sentTs = (o) => Math.max(0,
  ...(o?.sends || []).map((s) => tsOf(s?.ts)),
  ...(o?.statusHistory || []).filter((h) => h?.status === "sent").map((h) => tsOf(h?.ts)));

// The number they have from us: the most recently SENT offer on the house.
// Null when nothing went out, and the caller falls back to the book.
export function numberTheyHave(book = []) {
  let best = null;
  for (const o of book) {
    const at = sentTs(o), n = Math.round(Number(o?.cashAmount) || 0);
    if (at && n && (!best || at > best.at)) best = { amount: n, at };
  }
  return best?.amount || null;
}

// The last number their agent asked us for on the house, from the counters
// filed on any of its offers.
export function theirLastAsk(book = []) {
  let best = null;
  for (const o of book) {
    for (const h of o?.statusHistory || []) {
      const n = Math.round(Number(h?.amount) || 0), at = tsOf(h?.ts);
      if (h?.status === "countered" && n && (!best || at > best.at)) best = { amount: n, at };
    }
  }
  return best?.amount || null;
}

// The last list price we saw on the house, whichever offer saw it — the
// watched row changes when a newer offer on the same house gets a status.
export function lastSeenListPrice(book = []) {
  let best = null;
  for (const o of book) {
    const p = Math.round(Number(o?.priceWatch?.listPrice) || 0), at = tsOf(o?.priceWatch?.checkedAt);
    if (p && (!best || at > best.at)) best = { price: p, at };
  }
  return best?.price || null;
}

// Every offer this agent has on the house, the watched one first.
async function houseBook(store, locationId, full) {
  if (typeof store.listOffers !== "function") return [full];
  const rows = await store.listOffers(locationId, { contactId: full.contactId, limit: 200 }).catch(() => []);
  const k = addressKey(full.address);
  return [full, ...rows.filter((o) => o?.id && o.id !== full.id && o.address && addressKey(o.address) === k)];
}

// "FOR_SALE", "ACTIVE", "COMING_SOON" are still in play; anything else isn't.
export const stillForSale = (status) => !status || /for[_\s-]?sale|active|coming[_\s-]?soon/i.test(String(status));

/**
 * runPriceWatch({ client, locationId, saved, store, sendsEnabled, deps, now })
 *   → { watched, checked, dropped, offMarket, texted, results }
 */
export async function runPriceWatch({ client, locationId, saved = {}, store, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const out = { watched: 0, checked: 0, dropped: 0, offMarket: 0, texted: 0, results: [] };
  const token = String(saved?.apifyToken || "").trim();
  if (!token) return { ...out, skipped: "no Apify token" };
  const config = conversationConfig(saved || {});
  if (!config.enabled) return { ...out, skipped: "Conversation AI is off" };

  const rows = await store.listOffersForFollowUp(locationId, { statuses: WATCH_STATUSES, limit: 300 }).catch(() => []);
  // The newest offer per house: two copies of one listing are one watch.
  const byHouse = new Map();
  for (const o of rows) {
    if (!o?.id || !o.address || !o.contactId || o.deal) continue;
    const t = Date.parse(o.statusAt || o.createdAt || "");
    if (!(t >= now - WATCH_DAYS * DAY_MS)) continue;
    const k = addressKey(o.address);
    const prev = byHouse.get(k);
    if (!prev || t > Date.parse(prev.statusAt || prev.createdAt || "")) byHouse.set(k, o);
  }
  const watch = [...byHouse.values()]
    .sort((a, b) => String(a.priceWatch?.checkedAt || "").localeCompare(String(b.priceWatch?.checkedAt || "")))
    .slice(0, 40);
  out.watched = watch.length;
  if (!watch.length) return out;

  const lookup = typeof deps.fetchListings === "function" ? deps.fetchListings : fetchZillowListings;
  const found = await lookup(watch.map((o) => o.address), token).catch((e) => { out.error = String(e?.message || e).slice(0, 160); return new Map(); });
  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;

  for (const lean of watch) {
    const hit = found.get(streetKey(lean.address));
    if (!hit) continue;
    const full = await store.getOffer(lean.id).catch(() => null);
    if (!full) continue;
    out.checked++;
    const book = await houseBook(store, locationId, full);
    const seen = full.priceWatch || {};
    const from = Math.round(Number(lastSeenListPrice(book) ?? full.askingPrice ?? full.calc?.inputs?.askingPrice) || 0);
    const to = Math.round(Number(hit.listPrice) || 0);
    const onMarket = stillForSale(hit.status);
    full.priceWatch = { ...seen, listPrice: to || from || null, status: hit.status || null, checkedAt: iso(now),
      ...(onMarket ? {} : { offMarketAt: seen.offMarketAt || iso(now) }) };
    await store.updateOffer(full.id, full).catch(() => {});

    if (!onMarket) {
      if (!seen.offMarketAt) {
        out.offMarket++;
        await recordEvent({ store, locationId, contactId: full.contactId, party: "agent", type: "listing_off_market", at: iso(now),
          address: full.address, offerId: full.id, source: "sweep", dedupeKey: `listing_off_market:${full.id}`,
          data: { status: hit.status || null, lastListPrice: from || null } });
        out.results.push({ offerId: full.id, address: full.address, status: "off_market", listing: hit.status });
      }
      continue;
    }
    const drop = evaluateDrop({ from, to });
    if (!drop.dropped) continue;
    out.dropped++;
    const ours = numberTheyHave(book) || Math.round(Number(full.cashAmount) || 0);
    const theirAsk = theirLastAsk(book);
    const claim = await recordEvent({ store, locationId, contactId: full.contactId, party: "agent", type: "price_dropped", at: iso(now),
      address: full.address, offerId: full.id, source: "sweep", dedupeKey: `price_dropped:${full.id}:${to}`,
      data: { from, to, pct: drop.pct, ourNumber: ours, ...(theirAsk ? { theirAsk } : {}) } });
    if (!claim.inserted) continue;
    // Their agent already asked us for less than the new list: the seller
    // came down to meet their own agent, not us. Nothing to ask.
    if (theirAsk && theirAsk <= to) {
      out.results.push({ offerId: full.id, address: full.address, status: "dropped", from, to,
        reason: `no text: they already asked ${theirAsk}, under the new list` });
      continue;
    }
    const r = await start({
      client, locationId, saved, store, contactId: full.contactId, kind: "price_drop", offer: full,
      subject: { address: full.address, from, to, ours, status: effectiveStatus(full) }, sendsEnabled, deps,
    }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
    if (r?.skipped) out.results.push({ offerId: full.id, address: full.address, status: "dropped", from, to, reason: `no text: ${r.skipped}` });
    else { out.texted++; out.results.push({ offerId: full.id, address: full.address, status: "dropped", from, to, jobId: r?.job?.id || null }); }
  }
  return out;
}

/**
 * maybeRunPriceWatch(...) → result | null
 *
 * Once a day, from the watch hour on, with a durable cursor so a restart
 * doesn't pay for a second Zillow run.
 */
export async function maybeRunPriceWatch({ client, locationId, saved = {}, store, sendsEnabled = false, deps = {}, now = Date.now() }) {
  if (localHour(now) < WATCH_HOUR || localHour(now) >= 17) return null;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  if (cursor?.at && now - Date.parse(cursor.at) < MIN_GAP_MS) return null;
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: {} }).catch(() => {});
  return runPriceWatch({ client, locationId, saved, store, sendsEnabled, deps, now });
}
