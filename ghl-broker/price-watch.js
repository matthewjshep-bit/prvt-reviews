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
//   back on the market             → `listing_back_on_market` (2026-09-29):
//                                    off-market is no longer forever, and a
//                                    relisted house is the best moment there is
//                                    (followUp.relist starts its check-ins over).
//
// Claimed per offer and price, so a second run on the same price never texts.
// A drop found while their text (or your own draft) is waiting in the outbox
// is kept on the offer (`priceWatch.dropOwed`) and texted on a later run —
// measured from where it started, because the baseline moves every run.
//
// A drop that still sits at or above what their agent last asked us for is
// recorded and not texted (521 Avenue C, 2026-09-24): she had asked us for
// 580 the day before the list came down to 599,950, so the seller had moved
// toward their own agent, not toward us, and "would they come closer to
// ours?" told her we hadn't read the thread.

import { recordEvent } from "./contact-record.js";
import { conversationConfig, startProactive } from "./reply-agent.js";
import { fetchZillowListings } from "./rehab-scan.js";
import { streetKey } from "./comps-zillow.js";
import { addressKey } from "./shared/us-address.js";
import { effectiveStatus } from "./shared/offer-status.js";
import { supersededIds, pricedAt, houseKey } from "./shared/current-offer.js";
import { localHour } from "./promise-sweep.js";
import { followUpRows } from "./follow-up-sweep.js";
import { waitingReason } from "./outbox-guard.js";
import { claimDailyRun, closeDailyRun } from "./daily-gate.js";

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

const tsOf = (t) => { const n = Date.parse(t || ""); return Number.isFinite(n) ? n : 0; };

// The last number their agent asked us for on the house: the newest counter
// with an amount, on any of the agent's offers there (a counter can be filed
// on a row the house has since moved past). Null when they never named one.
export function theirLastAsk(rows = []) {
  let best = null;
  for (const o of rows) {
    for (const h of o?.statusHistory || []) {
      const n = Math.round(Number(h?.amount) || 0), at = tsOf(h?.ts);
      if (h?.status === "countered" && n > 0 && (!best || at > best.at)) best = { amount: n, at };
    }
  }
  return best?.amount || null;
}

// The last list price any of these offers saw, by when it was seen. Null
// when none has looked yet.
export function lastSeenListPrice(rows = []) {
  let best = null;
  for (const o of rows) {
    const p = Math.round(Number(o?.priceWatch?.listPrice) || 0), at = tsOf(o?.priceWatch?.checkedAt);
    if (p > 0 && (!best || at > best.at)) best = { price: p, at };
  }
  return best?.price || null;
}

// "FOR_SALE", "ACTIVE", "COMING_SOON" are still in play; anything else isn't.
export const stillForSale = (status) => !status || /for[_\s-]?sale|active|coming[_\s-]?soon/i.test(String(status));

/**
 * runPriceWatch({ client, locationId, saved, store, sendsEnabled, deps, now })
 *   → { watched, checked, dropped, offMarket, texted, results }
 */
export async function runPriceWatch({ client, locationId, saved = {}, store, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const out = { watched: 0, checked: 0, dropped: 0, offMarket: 0, backOnMarket: 0, texted: 0, results: [] };
  const token = String(saved?.apifyToken || "").trim();
  if (!token) return { ...out, skipped: "no Apify token" };
  const config = conversationConfig(saved || {});
  if (!config.enabled) return { ...out, skipped: "Conversation AI is off" };

  // Only the window it watches, all of it: the read used to take the oldest
  // 300 rows of all time and then keep the last 90 days, so as the book grew
  // the houses it was meant to watch were the ones it never read.
  // A number floated by text and never sent is watched too, with the switch.
  const watchFloated = Boolean(config.parties?.agent?.followUp?.watchFloated);
  const statuses = watchFloated ? [...WATCH_STATUSES, "new"] : WATCH_STATUSES;
  const rows = await followUpRows(store, locationId, { statuses, since: iso(now - WATCH_DAYS * DAY_MS) });
  // One watch per house, on the agent's current offer there (shared/
  // current-offer.js): the price-drop text quotes its number, and a row the
  // house moved past would quote one we've left. Across agents, the row whose
  // number moved last.
  const book = typeof store.listOffers === "function" ? await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => null) : null;
  const replaced = book ? supersededIds(book) : new Set();
  const byHouse = new Map();
  for (const o of rows) {
    if (!o?.id || !o.address || !o.contactId || o.deal || replaced.has(o.id)) continue;
    if (!statuses.includes(effectiveStatus(o))) continue;
    if (effectiveStatus(o) === "new" && !o.proactive?.realmCheckAt) continue;   // nothing of ours in front of them yet
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
    // The agent's other offers on this house. Only the current one is
    // watched, but the others still carry what they asked us for, and the
    // list prices they saw before this one became current.
    const k = houseKey(full.address);
    const siblings = (book || []).filter((o) => o?.id && o.id !== full.id && o.contactId === full.contactId && o.address && houseKey(o.address) === k);
    // A drop we still owe them is measured from where it started.
    let from = Math.round(Number(seen.dropOwed?.from ?? seen.listPrice ?? full.askingPrice ?? full.calc?.inputs?.askingPrice) || 0);
    // A row that only just became current has never looked, and its asking
    // price can be older than the list another of the agent's offers here saw
    // since. Start from the lower of the two, so a drop already seen on the
    // house isn't news a second time. Never higher than before.
    if (from > 0 && seen.dropOwed?.from == null && seen.listPrice == null && siblings.length) {
      const fulls = await Promise.all(siblings.slice(0, 10).map((o) => store.getOffer(o.id).catch(() => null)));
      const saw = lastSeenListPrice(fulls.filter(Boolean));
      if (saw && saw < from) from = saw;
    }
    const to = Math.round(Number(hit.listPrice) || 0);
    const onMarket = stillForSale(hit.status);
    const back = onMarket && seen.offMarketAt ? seen.offMarketAt : null;
    const { offMarketAt: _off, ...rest } = seen;
    full.priceWatch = { ...(onMarket ? rest : seen), listPrice: to || from || null, status: hit.status || null, checkedAt: iso(now),
      ...(onMarket ? {} : { offMarketAt: seen.offMarketAt || iso(now) }),
      ...(back ? { backOnMarketAt: iso(now) } : {}) };
    await store.updateOffer(full.id, full).catch(() => {});

    if (back) {
      out.backOnMarket++;
      await recordEvent({ store, locationId, contactId: full.contactId, party: "agent", type: "listing_back_on_market", at: iso(now),
        address: full.address, offerId: full.id, source: "sweep", dedupeKey: `listing_back_on_market:${full.id}:${String(back).slice(0, 10)}`,
        data: { status: hit.status || null, listPrice: to || null, offMarketAt: back } });
      out.results.push({ offerId: full.id, address: full.address, status: "back_on_market", listing: hit.status });
    }

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
    if (!drop.dropped) {
      // The price came back up past the drop we owed: nothing to say now.
      if (seen.dropOwed) { const { dropOwed: _d, ...pw } = full.priceWatch; full.priceWatch = pw; await store.updateOffer(full.id, full).catch(() => {}); }
      continue;
    }
    out.dropped++;
    // Their agent already asked us for no more than the new list: the seller
    // came down to meet their own agent, not us, and there's nothing to ask.
    // Written down, never texted, and not kept for later.
    const theirAsk = theirLastAsk([full, ...siblings]);
    const askedUnder = Boolean(theirAsk && theirAsk <= to);
    const waiting = askedUnder ? null : await waitingReason({ store, locationId, contactId: full.contactId });
    if (waiting) {
      full.priceWatch = { ...full.priceWatch, dropOwed: { from, to, at: seen.dropOwed?.at || iso(now) } };
      await store.updateOffer(full.id, full).catch(() => {});
      out.results.push({ offerId: full.id, address: full.address, status: "dropped", from, to, reason: `kept for later: ${waiting}` });
      continue;
    }
    if (seen.dropOwed) { const { dropOwed: _d, ...pw } = full.priceWatch; full.priceWatch = pw; await store.updateOffer(full.id, full).catch(() => {}); }
    const claim = await recordEvent({ store, locationId, contactId: full.contactId, party: "agent", type: "price_dropped", at: iso(now),
      address: full.address, offerId: full.id, source: "sweep", dedupeKey: `price_dropped:${full.id}:${to}`,
      data: { from, to, pct: drop.pct, ourNumber: Math.round(Number(full.cashAmount) || 0), ...(theirAsk ? { theirAsk } : {}) } });
    if (!claim.inserted) continue;
    if (askedUnder) {
      out.results.push({ offerId: full.id, address: full.address, status: "dropped", from, to,
        reason: `no text: they already asked ${theirAsk}, under the new list` });
      continue;
    }
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
const inFlight = new Set();
export async function maybeRunPriceWatch({ client, locationId, saved = {}, store, sendsEnabled = false, deps = {}, now = Date.now() }) {
  // Once a day in the working day; a run a deploy killed comes back that
  // afternoon instead of losing the day (daily-gate.js).
  const gate = await claimDailyRun({ store, locationId, cursorName: CURSOR_NAME, now, hourNow: localHour(now), startHour: WATCH_HOUR,
    windowHours: 17 - WATCH_HOUR, running: inFlight.has(locationId), minGapMs: MIN_GAP_MS });
  if (!gate.go) return null;
  inFlight.add(locationId);
  let r = null, error = null;
  try {
    r = await runPriceWatch({ client, locationId, saved, store, sendsEnabled, deps, now });
    return r;
  } catch (e) {
    error = String(e?.message || e);
    throw e;
  } finally {
    inFlight.delete(locationId);
    await closeDailyRun({ store, locationId, cursorName: CURSOR_NAME, failed: Boolean(error), error,
      last: r ? { watched: r.watched, checked: r.checked, dropped: r.dropped, offMarket: r.offMarket, backOnMarket: r.backOnMarket, texted: r.texted, skipped: r.skipped || null, error: r.error || null } : null });
  }
}
