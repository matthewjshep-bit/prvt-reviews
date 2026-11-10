// ai-spend.js — every Claude call, counted by day and feature.
//
// The reply drafts carry their own usage (shared/ai-cost.js), but on
// 2026-09-30 the drafts report said about $8 a day while the bill said more:
// the photo scans (up to 40 photos each), comp grading, enrichment, dispo
// ranking and the coach were never metered. This is the ledger for all of
// them. One job_cursors row ("aiSpend", location "_all") holds per-day
// totals by feature for the last 60 days — small, and readable from both
// store backends without a new table.
//
// Metering never throws and never blocks the call it measures: a meter that
// is not started (tests, scripts) only logs; a write that fails is dropped.
// Writes queue behind each other in this process, so two calls finishing in
// the same tick both count.

import { usageOf } from "./shared/ai-cost.js";

export const SPEND_CURSOR = "aiSpend";
export const SPEND_LOCATION = "_all";
const KEEP_DAYS = 60;

const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/** addSpend(doc, { feature, usage, day }) → a new doc with the call added. */
export function addSpend(doc = {}, { feature, usage = {}, day }) {
  const days = { ...(doc?.days || {}) };
  const today = { ...(days[day] || {}) };
  const was = today[feature] || { calls: 0, input: 0, output: 0, usd: 0 };
  const input = (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite5m) || 0) + (Number(usage.cacheWrite1h) || 0);
  // A call on a model the cost table can't price adds $0 and is counted, so
  // the day's total says it is short rather than looking whole.
  const unpriced = (Number(was.unpriced) || 0) + (usage.costUsd == null ? 1 : 0);
  today[feature] = {
    calls: was.calls + 1,
    input: was.input + input,
    output: was.output + (Number(usage.output) || 0),
    usd: round6(was.usd + (Number(usage.costUsd) || 0)),
    ...(unpriced ? { unpriced } : {}),
  };
  days[day] = today;
  const keep = Object.keys(days).sort().slice(-KEEP_DAYS);
  return { days: Object.fromEntries(keep.map((k) => [k, days[k]])) };
}

/** spendReport(doc, { days, now }) → { totalUsd, byDay, byFeature } over the last `days` days. */
export function spendReport(doc = {}, { days = 7, now = Date.now() } = {}) {
  const from = new Date(now - (days - 1) * 86400000).toISOString().slice(0, 10);
  const byFeature = new Map();
  const byDay = [];
  for (const [day, feats] of Object.entries(doc?.days || {}).sort()) {
    if (day < from) continue;
    let usd = 0;
    for (const [feature, f] of Object.entries(feats)) {
      usd += f.usd;
      const t = byFeature.get(feature) || { feature, calls: 0, usd: 0 };
      t.calls += f.calls; t.usd = round6(t.usd + f.usd);
      byFeature.set(feature, t);
    }
    byDay.push({ day, usd: round6(usd), features: feats });
  }
  const list = [...byFeature.values()].sort((a, b) => b.usd - a.usd);
  return { totalUsd: round6(list.reduce((s, f) => s + f.usd, 0)), byDay, byFeature: list };
}

/**
 * yesterdaySpend(doc, { now }) → { day, usd, calls, unpriced, top } | null
 *
 * The ledger's day before today (UTC, the ledger's own clock), for the
 * morning Slack post: its dollars, its calls, how many had no price, and the
 * two features that cost the most.
 */
export function yesterdaySpend(doc = {}, { now = Date.now() } = {}) {
  const day = new Date(now - 86400000).toISOString().slice(0, 10);
  const feats = doc?.days?.[day];
  if (!feats || !Object.keys(feats).length) return null;
  let usd = 0, calls = 0, unpriced = 0;
  for (const f of Object.values(feats)) { usd += Number(f.usd) || 0; calls += Number(f.calls) || 0; unpriced += Number(f.unpriced) || 0; }
  const top = Object.entries(feats).map(([feature, f]) => ({ feature, usd: round6(f.usd) })).sort((a, b) => b.usd - a.usd).slice(0, 2);
  return { day, usd: round6(usd), calls, unpriced, top };
}

/** readYesterdaySpend(store, { now }) → yesterdaySpend of the stored ledger, or null. */
export async function readYesterdaySpend(store, { now = Date.now() } = {}) {
  const cur = await store?.getJobCursor?.(SPEND_LOCATION, SPEND_CURSOR).catch(() => null);
  return yesterdaySpend(cur?.doc || {}, { now });
}

let sink = null;
let queue = Promise.resolve();
// A model with no price says so once a day, not once a call.
const unpricedWarned = new Set();
export function _resetUnpricedWarnings() { unpricedWarned.clear(); }

/** Called once by the broker at boot. Until then metering only logs. */
export function startAiSpendMeter({ store }) { sink = store || null; }
// For tests: wait for queued writes, then detach.
export async function _stopAiSpendMeter() { await queue; sink = null; }

/**
 * meterAi(feature, response, { model, batched }) → usage row
 *
 * Log one call and add it to the day's ledger. `response` is the SDK's
 * message; a missing one is ignored.
 */
export function meterAi(feature, response, { model = "", batched = false } = {}) {
  if (!response) return null;
  let u;
  try { u = usageOf(response, { model, batched }); } catch { return null; }
  console.log(`ai usage: ${feature} ${u.model} in=${u.input} cache=${u.cacheRead} out=${u.output} $${u.costUsd}`);
  const day = new Date().toISOString().slice(0, 10);
  if (u.costUsd == null && !unpricedWarned.has(`${day}|${u.model}`)) {
    unpricedWarned.add(`${day}|${u.model}`);
    console.warn(`ai spend: no price for ${u.model || "an unnamed model"}; its calls count as $0 today. Add it to shared/ai-cost.js PRICES.`);
  }
  const store = sink;
  if (store && typeof store.getJobCursor === "function") {
    queue = queue.then(async () => {
      const cur = await store.getJobCursor(SPEND_LOCATION, SPEND_CURSOR).catch(() => null);
      const doc = addSpend(cur?.doc || {}, { feature, usage: u, day });
      await store.setJobCursor(SPEND_LOCATION, SPEND_CURSOR, { doc });
    }).catch(() => {});
  }
  return u;
}

/** readSpend(store, { days }) → spendReport of the stored ledger. */
export async function readSpend(store, { days = 7, now = Date.now() } = {}) {
  const cur = await store.getJobCursor(SPEND_LOCATION, SPEND_CURSOR).catch(() => null);
  return spendReport(cur?.doc || {}, { days, now });
}
