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
import { supersededIds, pricedAt } from "./shared/current-offer.js";
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
  // One watch per house, on the agent's current offer there (shared/
  // current-offer.js): the price-drop text quotes its number, and a row the
  // house moved past would quote one we've left. Across agents, the row whose
  // number moved last.
  const book = typeof store.listOffers === "function" ? await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => null) : null;
  const replaced = book ? supersededIds(book) : new Set();
  const byHouse = new Map();
  for (const o of rows) {
    if (!o?.id || !o.address || !o.contactId || o.deal || replaced.has(o.id)) continue;
    const t = Date.parse(o.statusAt || o.createdAt || "");
    if (!(t >= now - WATCH_DAYS * DAY_MS)) continue;
    const k = addressKey(o.address);
    const prev = byHouse.get(k);
    if (!prev || pricedAt(o) > pricedAt(prev)) byHouse.set(k, o);
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
    const seen = full.priceWatch || {};
    const from = Math.round(Number(seen.listPrice ?? full.askingPrice ?? full.calc?.inputs?.askingPrice) || 0);
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
    const claim = await recordEvent({ store, locationId, contactId: full.contactId, party: "agent", type: "price_dropped", at: iso(now),
      address: full.address, offerId: full.id, source: "sweep", dedupeKey: `price_dropped:${full.id}:${to}`,
      data: { from, to, pct: drop.pct, ourNumber: Math.round(Number(full.cashAmount) || 0) } });
    if (!claim.inserted) continue;
    const r = await start({
      client, locationId, saved, store, contactId: full.contactId, kind: "price_drop", offer: full,
      subject: { address: full.address, from, to, status: effectiveStatus(full) }, sendsEnabled, deps,
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
