// price-scorecard.js — the offer engine's daily scorecard (auto-underwrite v2, 2026-11-04).
//
// Once a day, while the engine prices in the shadow (settings.pricingV2.shadow), this:
//   1. fills in each house's outcome from its offer rows (shared/price-scorecard.js outcomeOf):
//      the number a person stood behind, the seller's counters, a yes or a deal, the sold price;
//   2. looks up what the houses with no offer of ours sold for (one batched Zillow listing read,
//      at most UNPRICED_MAX a day — a few cents);
//   3. posts one line to the Underwrites Slack channel (else Daily): how far the engine is from Matt, and whether
//      grade A has cleared the bars he switches it live on.
// GET /api/offers/automations/pricing/scorecard reads the same card at any time (read-only).
//
// Gated like every daily job (daily-gate.js), cursor "priceScorecard". No names, phones or message
// text are logged here.

import { claimDailyRun, closeDailyRun } from "./daily-gate.js";
import { localHour } from "./promise-sweep.js";
import { fetchZillowListings } from "./rehab-scan.js";
import { streetKey } from "./comps-zillow.js";
import { slackApi } from "./slack-notify.js";
import { normalizeSlack, streamOn } from "./shared/slack-notify.js";
import { outcomeOf, scorecard, scorecardLine, theirReadOf } from "./shared/price-scorecard.js";
import { normalizePricingV2 } from "./shared/price-engine.js";
import { houseKey } from "./shared/current-offer.js";

export const CURSOR_NAME = "priceScorecard";
export const SCORECARD_HOUR = 19; // the evening, after the day's pricing
export const WINDOW_DAYS = 120;
export const UNPRICED_MAX = 40;
const DAY_MS = 86400000;
const inFlight = new Set();
const iso = (t) => new Date(t).toISOString();

/**
 * outcomesFor({ store, locationId, records }) → Map(houseKey → outcome) from the offers on each house.
 * Read-only: full offer docs, because a lean row carries no calc inputs or price watch.
 */
export async function outcomesFor({ store, locationId, records = [] }) {
  const out = new Map();
  if (!records.length) return out;
  const lean = (await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => [])) || [];
  const byKey = new Map();
  for (const r of lean) { const k = houseKey(r.address); if (k) (byKey.get(k) || byKey.set(k, []).get(k)).push(r); }
  for (const rec of records) {
    const rows = byKey.get(rec.houseKey);
    if (!rows?.length) continue;
    const full = (await Promise.all(rows.map((r) => store.getOffer(r.id).catch(() => null)))).filter(Boolean);
    const o = outcomeOf({ address: rec.doc?.address || rows[0].address, offers: full });
    if (o) out.set(rec.houseKey, o);
  }
  return out;
}

// What agents said about a house: the seller's number and their own ARV and rehab.
const THEIR_EVENT_TYPES = ["property_details", "agent_estimate"];

/** buildScorecard({ store, locationId, saved, now, persist }) → the card (and, with persist, the outcomes written back). */
export async function buildScorecard({ store, locationId, saved = {}, now = Date.now(), persist = false, days = WINDOW_DAYS } = {}) {
  const records = (await store.listHousePricing(locationId, { since: iso(now - days * DAY_MS), limit: 5000 }).catch(() => [])) || [];
  const outcomes = await outcomesFor({ store, locationId, records });
  // Their numbers, one read for the whole window (a month before it too: an
  // agent's number often comes before ours).
  const theirEvents = records.length
    ? (await store.listContactEventsSince?.(locationId, iso(now - (days + 30) * DAY_MS), { types: THEIR_EVENT_TYPES, limit: 20000 }).catch(() => [])) || []
    : [];
  // Filed by house once: matching every said number against every priced
  // house parsed records × events addresses on the one thread (2026-11-09).
  const theirByHouse = new Map();
  for (const e of theirEvents) {
    const k = e?.address ? houseKey(e.address) : "";
    if (k) (theirByHouse.get(k) || theirByHouse.set(k, []).get(k)).push(e);
  }
  const docs = [];
  let updated = 0;
  for (const rec of records) {
    const fresh = outcomes.get(rec.houseKey);
    // A sold price found for a house with no offer row stays (outcome.sold from the unpriced read).
    const base = fresh ? { ...fresh, sold: fresh.sold || rec.doc?.outcome?.sold || null } : rec.doc?.outcome || null;
    const address = rec.doc?.address || "";
    const their = theirReadOf({ address, events: theirByHouse.get(houseKey(address)) || [] });
    const said = Object.fromEntries(Object.entries(their).filter(([, v]) => v != null));
    const outcome = Object.keys(said).length ? { ...(base || {}), ...said } : base;
    const doc = { ...rec.doc, outcome, leadSource: rec.doc?.leadSource || fresh?.leadSource || null };
    docs.push(doc);
    if (persist && (fresh || Object.keys(said).length) && JSON.stringify(outcome) !== JSON.stringify(rec.doc?.outcome || null)) {
      await store.upsertHousePricing(locationId, rec.houseKey, doc).catch(() => {});
      updated++;
    }
  }
  const s = normalizePricingV2(saved?.pricingV2);
  return { card: scorecard(docs, { now, days, settings: { maoPct: s.maoPct, minFee: s.minFee } }), updated, records: records.length };
}

/**
 * soldForUnpriced({ store, locationId, saved, now, deps }) → { checked, sold }
 * Houses the engine priced that never got an offer row: what did they sell for? Checked at most
 * once a week each, UNPRICED_MAX a day, oldest check first.
 */
export async function soldForUnpriced({ store, locationId, saved = {}, now = Date.now(), deps = {} } = {}) {
  const token = String(saved?.apifyToken || "").trim();
  const fetchListings = deps.fetchListings || fetchZillowListings;
  if (!token && !deps.fetchListings) return { checked: 0, sold: 0, skipped: "no Apify token" };
  const records = (await store.listHousePricing(locationId, { since: iso(now - WINDOW_DAYS * DAY_MS), limit: 5000 }).catch(() => [])) || [];
  const due = records
    .filter((r) => !r.doc?.outcome?.offerIds?.length && !r.doc?.outcome?.sold && r.doc?.address)
    .filter((r) => !r.doc?.soldCheckedAt || now - Date.parse(r.doc.soldCheckedAt) > 7 * DAY_MS)
    .sort((a, b) => String(a.doc?.soldCheckedAt || "").localeCompare(String(b.doc?.soldCheckedAt || "")))
    .slice(0, UNPRICED_MAX);
  if (!due.length) return { checked: 0, sold: 0 };
  const hits = await fetchListings(due.map((r) => r.doc.address), token);
  let sold = 0;
  for (const r of due) {
    const hit = hits?.get?.(streetKey(r.doc.address));
    const price = Math.round(Number(hit?.lastSoldPrice) || 0);
    const at = hit?.lastSoldDate || null;
    const after = price > 0 && at && at >= String(r.doc.firstAt || r.doc.v2?.at || "").slice(0, 10);
    const doc = { ...r.doc, soldCheckedAt: iso(now), ...(after ? { outcome: { ...(r.doc.outcome || {}), sold: { price, at } } } : {}) };
    if (after) sold++;
    await store.upsertHousePricing(locationId, r.houseKey, doc).catch(() => {});
  }
  return { checked: due.length, sold };
}

/**
 * storedScorecard({ store, locationId }) → { card, records, at } | null — the evening run's card, as it was saved.
 */
export async function storedScorecard({ store, locationId }) {
  const c = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const last = c?.doc?.last;
  return last?.card ? { card: last.card, records: Number(last.records) || 0, at: last.card.generatedAt || c.at || null } : null;
}

/** maybeRunPriceScorecard({ store, locationId, saved, now, deps }) → the day's run, or null. */
export async function maybeRunPriceScorecard({ store, locationId, saved = {}, now = Date.now(), deps = {} } = {}) {
  if (!normalizePricingV2(saved?.pricingV2).shadow) return null;
  const gate = await claimDailyRun({ store, locationId, cursorName: CURSOR_NAME, now, hourNow: localHour(now), startHour: SCORECARD_HOUR,
    windowHours: 3, running: inFlight.has(locationId) });
  if (!gate.go) return null;
  inFlight.add(locationId);
  let last = null, error = null;
  try {
    const unpriced = await soldForUnpriced({ store, locationId, saved, now, deps }).catch((e) => ({ error: String(e?.message || e).slice(0, 120) }));
    const { card, updated, records } = await buildScorecard({ store, locationId, saved, now, persist: true });
    const token = String(saved?.slackBotToken || "").trim();
    // The Underwrites channel when it's on, else Daily; nothing when Slack is off.
    const cfg = normalizeSlack(saved?.slack);
    const channel = streamOn(cfg, "underwrites") ? cfg.channels.underwrites : streamOn(cfg, "daily") ? cfg.channels.daily : null;
    let posted = false;
    if (token && channel) {
      const post = deps.slackApi || slackApi;
      await post(token, "chat.postMessage", { channel, text: scorecardLine(card) }).then(() => { posted = true; }).catch(() => {});
    }
    last = { records, updated, unpriced, posted, total: { n: card.total.n, withMatt: card.total.withMatt, arvGap: card.total.arvGap, walkVsMatt: card.total.walkVsMatt }, readyA: card.ready.A.ready,
      // The whole card: Lessons reads this one rather than working it out on open (2026-11-09).
      card };
    return { ...last, card };
  } catch (e) {
    error = String(e?.message || e);
    return null;
  } finally {
    inFlight.delete(locationId);
    await closeDailyRun({ store, locationId, cursorName: CURSOR_NAME, last, failed: Boolean(error), error });
  }
}
