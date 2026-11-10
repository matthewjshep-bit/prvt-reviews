// funnel.js — what actually happened to the offers we sent, and what buyers
// said about the deals we blasted.
//
// THIS MODULE ONLY READS. Nothing here tunes the offer math, the follow-up
// ladder, the buy box, or anything else. It is deliberately a report and not a
// controller: the pass reasons and the counter spreads are the operator's
// evidence for a decision, not an input to one the machine makes. If a future
// change wants to close that loop, it should be an explicit, switchable thing
// somewhere else — not a quiet consequence of a number moving in here.
//
// Pure. Every function takes plain rows and returns plain numbers.

import { effectiveStatus } from "./offer-status.js";
import { wasSent, sentAt } from "./offer-stage.js";
import { PASS_REASONS, PASS_REASON_LABEL, summarizeFeedback, recodePassReason } from "./conversation-ai.js";
import { parseUsAddress } from "./us-address.js";

// The day the reports started counting what happened (2026-11-09): a float
// that went is sent, a queued one isn't, a STOP isn't a reply, an offer sent
// twice is one. The Funnel, Flow, Line and Follow-up pages say so, because
// their numbers moved that day.
export const COUNTING_CHANGED = "2026-11-09";

const round = (v) => Math.round(Number(v) || 0);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const dayKey = (iso) => String(iso || "").slice(0, 10);

/**
 * offerFunnel(rows, { since, until }) → counts, rates and a daily series.
 *
 * Counted from statusHistory, FIRST occurrence of each status — so an offer
 * that went sent → countered → passed counts once in each column. That makes
 * the funnel a set of monotonic questions ("how many ever reached a counter")
 * rather than a snapshot of where things currently sit, which is the thing you
 * actually want when you are asking whether the pitch works.
 *
 * Sent is wasSent (shared/offer-stage.js): a float that went, a send that
 * worked, a sent status or a deal, at the first of those (2026-11-09: a float
 * never counted as sent, so the tab read 76% countered and 483% dead of
 * sent). What they did with it (countered, accepted, passed, gone, no reply,
 * we passed) is counted only on an offer that was sent; a house we passed on
 * without our number ever reaching them is `passedUnsent`, apart.
 *
 * `since`/`until` (epoch ms): each stage counts only when its own time is in
 * the window. Left out, everything counts.
 *
 * An offer with no history at all is counted from its effective status, so a
 * book that predates the ledger still reports something true.
 */
const DEAD_FIELDS = ["passed", "wePassed", "unavailable", "noResponse"];
export function offerFunnel(rows = [], { since = -Infinity, until = Infinity } = {}) {
  const c = { created: 0, sent: 0, countered: 0, accepted: 0, passed: 0, wePassed: 0, unavailable: 0, noResponse: 0, open: 0, passedUnsent: 0 };
  const daily = new Map();
  const inWin = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) && t >= since && t < until; };
  const bump = (iso, key) => {
    const d = dayKey(iso);
    if (!d) return;
    if (!daily.has(d)) daily.set(d, { date: d, created: 0, sent: 0, countered: 0, accepted: 0, passed: 0, wePassed: 0, unavailable: 0, noResponse: 0 });
    daily.get(d)[key]++;
  };
  const count = (field, iso) => { if (inWin(iso)) { c[field]++; bump(iso, field); } };
  const FIELD = { countered: "countered", accepted: "accepted", passed: "passed", we_passed: "wePassed", unavailable: "unavailable", no_response: "noResponse" };

  for (const o of rows) {
    if (!o) continue;
    if (effectiveStatus(o) === "draft") continue;   // never left the building
    count("created", o.createdAt);

    const out = wasSent(o);
    if (out) count("sent", new Date(sentAt(o)).toISOString());

    const history = Array.isArray(o.statusHistory) ? o.statusHistory : [];
    const seen = new Set();
    const first = history.length
      ? history.filter((h) => FIELD[h?.status]).map((h) => ({ field: FIELD[h.status], ts: h.ts }))
      : FIELD[effectiveStatus(o)] ? [{ field: FIELD[effectiveStatus(o)], ts: o.statusAt || o.createdAt }] : [];
    // A deal is an acceptance even when nobody wrote the status down.
    if (o.deal) first.push({ field: "accepted", ts: o.deal.createdAt || o.statusAt });
    let unsent = false;
    for (const { field, ts } of first) {
      if (seen.has(field)) continue;
      seen.add(field);
      if (out) count(field, ts);
      else if (DEAD_FIELDS.includes(field) && inWin(ts)) unsent = true;
    }
    if (unsent) c.passedUnsent++;
    // An offer that was sent and hasn't ended is still working.
    if (out && !seen.has("accepted") && !DEAD_FIELDS.some((f) => seen.has(f))) c.open++;
  }

  return {
    ...c,
    rates: {
      sentOfCreated: pct(c.sent, c.created),
      counteredOfSent: pct(c.countered, c.sent),
      acceptedOfSent: pct(c.accepted, c.sent),
      acceptedOfCountered: pct(c.accepted, c.countered),
      deadOfSent: pct(c.passed + c.wePassed + c.unavailable + c.noResponse, c.sent),
    },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * counterSpread(rows) → how far apart we and they actually are.
 *
 * Only possible because the counter amount is stored as a number now. The
 * headline is the median lift: if half your counters come back 4% over, your
 * offers are close and the ceiling has room; if they come back 30% over, the
 * problem is the pitch, not the paperwork.
 *
 * `outcome` is what happened AFTER the counter — the number that says whether
 * your counters are worth taking at all.
 */
export function counterSpread(rows = []) {
  const items = [];
  for (const o of rows) {
    const theirs = round(o?.counter?.amount) || round((o?.statusHistory || []).filter((h) => h?.status === "countered" && h.amount).at(-1)?.amount);
    const ours = round(o?.cashAmount);
    if (!theirs || !ours || theirs <= ours) continue;
    const after = (o.statusHistory || []).filter((h) => ["accepted", "passed", "we_passed", "unavailable", "no_response"].includes(h?.status)).at(-1);
    items.push({
      offerId: o.id, address: o.address || "", ours, theirs,
      liftDollars: theirs - ours, liftPct: Math.round(((theirs - ours) / ours) * 1000) / 10,
      outcome: o.deal ? "accepted" : after?.status || "open",
      band: priceBand(ours),
    });
  }
  const lifts = items.map((i) => i.liftPct).sort((a, b) => a - b);
  const byBand = new Map();
  for (const i of items) {
    if (!byBand.has(i.band)) byBand.set(i.band, []);
    byBand.get(i.band).push(i);
  }
  return {
    n: items.length,
    medianLiftPct: median(lifts),
    meanLiftPct: lifts.length ? Math.round((lifts.reduce((a, b) => a + b, 0) / lifts.length) * 10) / 10 : 0,
    p90LiftPct: quantile(lifts, 0.9),
    medianLiftDollars: median(items.map((i) => i.liftDollars).sort((a, b) => a - b)),
    byPriceBand: [...byBand.entries()].map(([band, list]) => ({
      band, n: list.length, medianLiftPct: median(list.map((i) => i.liftPct).sort((a, b) => a - b)),
      acceptedAfter: list.filter((i) => i.outcome === "accepted").length,
    })).sort((a, b) => a.band.localeCompare(b.band)),
    items: items.sort((a, b) => b.liftPct - a.liftPct),
  };
}

const BAND_SIZE = 50000;
export function priceBand(amount) {
  const n = round(amount);
  if (!n) return "unknown";
  const lo = Math.floor(n / BAND_SIZE) * BAND_SIZE;
  return `${Math.round(lo / 1000)}–${Math.round((lo + BAND_SIZE) / 1000)}k`;
}

function median(sorted = []) {
  if (!sorted.length) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : Math.round(((sorted[m - 1] + sorted[m]) / 2) * 10) / 10;
}
function quantile(sorted = [], q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * passReasons(rows, { by }) → why buyers said no, grouped.
 *
 * Reuses summarizeFeedback per group so the vocabulary, the labels and the
 * sort order are the same ones the Deals page already shows per deal.
 *
 * Deduped on (contactId, offerId, code): one buyer's gripe about one deal is
 * one data point however many places it was written down.
 */
export function passReasons(rows = [], { by = "deal" } = {}) {
  const groups = new Map();
  const seen = new Set();
  for (const o of rows) {
    const deal = o?.deal;
    if (!deal) continue;
    const entries = [
      ...(deal.feedback || []).map((f) => ({ contactId: f.contactId, code: f.code, note: f.note })),
      ...(deal.investors || []).filter((i) => i?.reason?.code).map((i) => ({ contactId: i.contactId, code: i.reason.code, note: i.reason.note })),
    ];
    for (const e0 of entries) {
      if (!e0.code) continue;
      // Recoded before the dedupe, so "busy rd" filed once as area and once
      // as condition is one street complaint, not two.
      const e = recodePassReason(e0);
      const dedupe = `${e.contactId}|${o.id}|${e.code}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const key = groupKey(by, o, e);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, label: key, total: list.length, ...summarizeFeedback(list) }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

/**
 * passThemes(deals, { now, days }) → [{ code, label, count, deals, notes }]
 *
 * Why buyers passed lately, across every deal, by the reason their own words
 * name (recoded, so "busy rd" filed as area counts as the street). One buyer
 * once per reason per deal. The Lessons view's "why buyers passed" card —
 * the running version of the 2026-10-02 read of every thread.
 */
export function passThemes(deals = [], { now = Date.now(), days = 30 } = {}) {
  const since = now - days * 86400000;
  const seen = new Set();
  const by = new Map();
  for (const o of deals) {
    const deal = o?.deal;
    if (!deal) continue;
    const entries = [
      ...(deal.feedback || []).map((f) => ({ contactId: f.contactId, code: f.code, note: f.note, at: f.ts })),
      ...(deal.investors || []).filter((i) => i?.reason?.code).map((i) => ({ contactId: i.contactId, code: i.reason.code, note: i.reason.note, at: i.reason.at || i.updatedAt })),
    ];
    for (const e0 of entries) {
      if (!e0.code) continue;
      const t = Date.parse(e0.at || "");
      if (Number.isFinite(t) && t < since) continue;
      const e = recodePassReason(e0);
      const k = `${e.contactId}|${o.id}|${e.code}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!by.has(e.code)) by.set(e.code, { code: e.code, label: PASS_REASON_LABEL[e.code] || e.code, count: 0, deals: new Set(), notes: [] });
      const g = by.get(e.code);
      g.count++;
      g.deals.add(String(o.address || o.id || "").split(",")[0]);
      if (e.note && g.notes.length < 3) g.notes.push(String(e.note).slice(0, 120));
    }
  }
  return [...by.values()].map((g) => ({ ...g, deals: [...g.deals] })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function groupKey(by, offer, entry) {
  if (by === "buyer") return entry.contactId || "unknown";
  if (by === "priceBand") return priceBand(offer.cashAmount);
  if (by === "area") {
    const p = parseUsAddress(offer.address || "");
    return p?.city || p?.zip || "unknown";
  }
  return offer.address || offer.id || "unknown";
}

/**
 * followUpPerformance(followUpEvents, inboundEvents, { windowDays })
 *   → [{ kind, step, sent, replied, replyRate, medianHoursToReply }]
 *
 * Did the nudges work, and which rung earned its keep. This is the table that
 * tells an operator to shorten a ladder — and they shorten it themselves.
 */
export function followUpPerformance(followUpEvents = [], inboundEvents = [], { windowDays = 5 } = {}) {
  const inboundBy = new Map();
  for (const e of inboundEvents) {
    if (!e?.contactId) continue;
    if (!inboundBy.has(e.contactId)) inboundBy.set(e.contactId, []);
    inboundBy.get(e.contactId).push({ t: Date.parse(e.at), stop: e.stop === true });
  }
  for (const list of inboundBy.values()) list.sort((a, b) => a.t - b.t);

  const rows = new Map();
  for (const e of followUpEvents) {
    const kind = e?.data?.kind;
    const step = Number(e?.data?.step);
    if (!kind || !Number.isFinite(step)) continue;
    const key = `${kind}|${step}`;
    if (!rows.has(key)) rows.set(key, { kind, step, sent: 0, replied: 0, stopped: 0, hours: [] });
    const row = rows.get(key);
    row.sent++;
    const at = Date.parse(e.at);
    const answers = (inboundBy.get(e.contactId) || []).filter((x) => x.t > at && x.t - at <= windowDays * 86400000);
    // A STOP is their answer, but not a reply the nudge earned (2026-11-09),
    // even after a first question: a STOP anywhere in the window is stopped,
    // as Reports → Follow-up and the text scoreboard count it.
    if (answers.some((x) => x.stop)) row.stopped++;
    else if (answers.length) { row.replied++; row.hours.push(Math.round((answers[0].t - at) / 3600000)); }
  }
  return [...rows.values()]
    .map(({ hours, ...r }) => ({ ...r, replyRate: pct(r.replied, r.sent), stopRate: pct(r.stopped, r.sent), medianHoursToReply: median(hours.sort((a, b) => a - b)) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.step - b.step);
}

/**
 * followUpsFromOutbox(rows) → [{ contactId, at, data: { kind, step } }]
 *
 * The follow-up table's sends, from the outbox rows that went (the reply
 * draft ledger), not from `follow_up_sent`: that is the sweep's claim,
 * written before a draft exists, so a held or dropped nudge counted as sent
 * (2026-11-09). A ladder rung (a machine text with a step) that was sent and
 * wasn't a reply to them.
 */
export function followUpsFromOutbox(rows = []) {
  return (rows || [])
    .filter((d) => d?.status === "sent" && d.contactId && !d.hasInbound && !String(d.inbound || "").trim()
      && d.outbound?.kind && Number.isFinite(Number(d.outbound.step)) && d.outbound.step !== null && (d.sentAt || d.createdAt))
    .map((d) => ({ contactId: d.contactId, at: d.sentAt || d.createdAt, data: { kind: d.outbound.kind, step: Number(d.outbound.step) } }));
}

export { PASS_REASONS, PASS_REASON_LABEL };
