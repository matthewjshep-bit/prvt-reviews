// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// line.js — the line, measured: what each station makes against its target,
// how long work waits between stations, and what the line lets fall off it.
//
// Matt, 2026-09-29: run it "like a manufacturing process", with "no leakage".
// Flow (flow.js) says what moved in a window, the Board says where everything
// sits, and the Funnel says what became of the offers. None of them says
// whether the line is keeping pace, where work waits longest, or what fell
// off with nothing scheduled. This does, from the same rows and the same
// rules that schedule the work: a leak is counted by the code that would
// have scheduled it (next-follow-up.js, the two pulse planners, the Today
// deal rows), so the Line and the machine can never disagree about it.
//
// THIS MODULE ONLY READS, like funnel.js. The pricing block puts the
// all-in % buyers actually paid beside the offer setting; it never moves the
// setting. Pure: every row and `now` are passed in.

import { effectiveStatus, OPEN_STATUSES } from "./offer-status.js";
import { offMarketStats, funnelBy } from "./off-market.js";
import { normalizeAsset } from "./asset-type.js";

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const round1 = (v) => Math.round(v * 10) / 10;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/* ---------- targets ---------- */

// The Agent Method's numbers (10 offers a day, 120 offers to a contract,
// ~$15K a deal, 2 deals a month) and the greenhouse's two clocks.
export const LINE_TARGET_DEFAULTS = {
  newAgentsPerDay: 10,
  offersPerDay: 10,
  offersPerContract: 120,
  dealsPerMonth: 2,
  feePerDeal: 15000,
  agentTouchDays: 21,
  buyerTouchDays: 30,
};

/** normalizeLineTargets(v) → every target, a whole number in its range. */
export function normalizeLineTargets(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const n = (x, d, lo, hi) => { const k = Math.round(Number(x)); return x == null || x === "" || !Number.isFinite(k) ? d : Math.min(hi, Math.max(lo, k)); };
  const d = LINE_TARGET_DEFAULTS;
  return {
    newAgentsPerDay: n(o.newAgentsPerDay, d.newAgentsPerDay, 0, 500),
    offersPerDay: n(o.offersPerDay, d.offersPerDay, 0, 200),
    offersPerContract: n(o.offersPerContract, d.offersPerContract, 1, 2000),
    dealsPerMonth: n(o.dealsPerMonth, d.dealsPerMonth, 0, 100),
    feePerDeal: n(o.feePerDeal, d.feePerDeal, 0, 500000),
    agentTouchDays: n(o.agentTouchDays, d.agentTouchDays, 1, 365),
    buyerTouchDays: n(o.buyerTouchDays, d.buyerTouchDays, 1, 365),
  };
}

/* ---------- stations ---------- */

// Which Flow stage carries a target, and at what rate.
const STAGE_TARGET = {
  first_text: (t) => ({ perDay: t.newAgentsPerDay, words: `${t.newAgentsPerDay} a day` }),
  offered: (t) => ({ perDay: t.offersPerDay, words: `${t.offersPerDay} a day` }),
  contract: (t) => ({ perDay: t.dealsPerMonth / 30, words: `${t.dealsPerMonth} a month` }),
  closed: (t) => ({ perDay: t.dealsPerMonth / 30, words: `${t.dealsPerMonth} a month` }),
};

/**
 * lineStations({ week, month, targets }) → [{ key, side, label, week, month, perDay, target, pace }]
 *
 * `week` and `month` are buildFlow() stages for the last 7 and 30 days.
 * `pace` is the month's rate over the target's (1 = on target), for the
 * stations that have one.
 */
export function lineStations({ week = [], month = [], targets = LINE_TARGET_DEFAULTS } = {}) {
  const t = normalizeLineTargets(targets);
  const w = new Map(week.map((s) => [s.key, s]));
  return month.map((s) => {
    const perDay = round1(s.count / 30);
    const target = STAGE_TARGET[s.key]?.(t) || null;
    return {
      key: s.key, side: s.side, label: s.label, hint: s.hint || "",
      week: w.get(s.key)?.count ?? 0, month: s.count, machine: s.machine, conversion: s.conversion ?? null,
      perDay, target: target ? { perDay: round1(target.perDay * 100) / 100, words: target.words } : null,
      pace: target && target.perDay > 0 ? Math.round((s.count / 30 / target.perDay) * 100) / 100 : null,
    };
  });
}

/**
 * methodMath({ month, targets }) → what the Agent Method says 30 days of
 * offers should have made, beside what they did.
 */
export function methodMath({ month = [], targets = LINE_TARGET_DEFAULTS } = {}) {
  const t = normalizeLineTargets(targets);
  const count = (k) => month.find((s) => s.key === k)?.count || 0;
  const offers = count("offered");
  return {
    offers30: offers, contracts30: count("contract"),
    expectedContracts: round1(offers / t.offersPerContract),
    offersForTarget: t.dealsPerMonth * t.offersPerContract,
    feeAtTarget: t.dealsPerMonth * t.feePerDeal,
  };
}

/* ---------- cycle times ---------- */

export const CYCLE_HOPS = [
  { key: "out", label: "Priced → in front of the agent" },
  { key: "answer", label: "In front of them → their first answer" },
  { key: "agree", label: "In front of them → a price agreed" },
  { key: "contract", label: "Price agreed → under contract" },
  { key: "blast", label: "Under contract → first wave" },
  { key: "buyer", label: "Under contract → buyer committed" },
  { key: "close", label: "Under contract → assigned or closed" },
];

// The 90th percentile: the slowest tenth starts here (nearest rank).
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};
// The middle value, or the middle of the two: with four deals, the lower
// middle alone read 72.5% where the median was 73.7%.
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const firstStatus = (o, statuses) => (o.statusHistory || []).filter((h) => statuses.includes(h?.status)).map((h) => ms(h.ts)).filter((t) => t != null).sort((a, b) => a - b)[0] ?? null;
const stageAt = (deal, stages) => (deal?.stageHistory || []).filter((h) => stages.includes(h?.stage)).map((h) => ms(h.ts)).filter((t) => t != null).sort((a, b) => a - b)[0] ?? null;

/**
 * cycleTimes(offers, { now, days }) → [{ key, label, n, medianDays, p90Days }]
 *
 * How long work waits between stations, over the hops that FINISHED in the
 * last `days` (a cohort by completion, so a slow hop still counts the day it
 * lands, and an unfinished one isn't guessed at).
 */
export function cycleTimes(offers = [], { now = Date.now(), days = 30 } = {}) {
  const from = now - days * DAY_MS;
  const spans = Object.fromEntries(CYCLE_HOPS.map((h) => [h.key, []]));
  const add = (key, a, b) => { if (a != null && b != null && b >= a && b >= from && b <= now) spans[key].push((b - a) / DAY_MS); };
  for (const o of offers) {
    if (!o || effectiveStatus(o) === "draft") continue;
    const priced = ms(o.createdAt);
    const sent = (o.sends || []).map((s) => ms(s?.ts)).filter((t) => t != null).sort((a, b) => a - b)[0] ?? null;
    const floated = [ms(o.proactive?.realmCheckAt), ms(o.proactive?.takeCheckAt)].filter((t) => t != null).sort((a, b) => a - b)[0] ?? null;
    const out = [sent, floated].filter((t) => t != null).sort((a, b) => a - b)[0] ?? null;
    add("out", priced, out);
    const answered = firstStatus(o, ["countered", "accepted", "passed"]);
    add("answer", out, answered);
    const agreed = ms(o.agreed?.at) ?? firstStatus(o, ["accepted"]);
    add("agree", out, agreed);
    const deal = o.deal || null;
    const contract = deal ? ms(deal.createdAt) ?? stageAt(deal, ["under_contract"]) : null;
    add("contract", agreed, contract);
    if (deal) {
      const firstWave = (deal.blasts || []).map((b) => ms(b?.at)).filter((t) => t != null).sort((a, b) => a - b)[0] ?? null;
      add("blast", contract, firstWave);
      add("buyer", contract, stageAt(deal, ["buyer_found"]));
      add("close", contract, stageAt(deal, ["assigned", "closed"]));
    }
  }
  return CYCLE_HOPS.map((h) => {
    const xs = spans[h.key];
    return { ...h, n: xs.length, medianDays: xs.length ? round1(median(xs)) : null, p90Days: xs.length ? round1(quantile(xs, 0.9)) : null };
  });
}

/* ---------- leaks ---------- */

// A machine clock that should have fired and didn't: past due by more than a
// day and a sweep (the daily sweep runs once, so a day late is a missed run).
export const MISSED_AFTER_HOURS = 26;
const LEAK_ROWS = 40;

/**
 * offerLeaks(offers, { now }) → { nothing, missed, waitingOnYou, rows }
 *
 * `offers` carry `nextFollowUp` (ghl-broker/next-follow-up.js) and the
 * current-offer verdict. Only the current row on a house counts.
 *   nothing       an open offer with nothing scheduled (nextFollowUp "none")
 *   missed        a clock that should have fired more than a day ago
 *   waitingOnYou  a held reply, an accepted offer to promote, a float the
 *                 timer gave up on: not lost, but stopped until you act
 * Deliberate stops (opted out, stopped by you, we passed, off market) are
 * not leaks. A passed offer whose check-ins finished is not either: its
 * agent belongs to the agent check-in from there.
 */
export function offerLeaks(offers = [], { now = Date.now() } = {}) {
  const out = { nothing: 0, missed: 0, waitingOnYou: 0, rows: [] };
  const row = (o, n, leak) => { if (out.rows.length < LEAK_ROWS) out.rows.push({ leak, offerId: o.id, contactId: o.contactId || null, address: o.address || "", status: effectiveStatus(o), kind: n.kind, label: n.label, reason: n.reason || "", at: n.at || null }); };
  for (const o of offers) {
    const n = o?.nextFollowUp;
    if (!n || o.supersededBy || o.isCurrent === false || o.status === "draft" || o.deal) continue;
    const status = effectiveStatus(o);
    if (n.kind === "none") {
      if (OPEN_STATUSES.has(status)) { out.nothing++; row(o, n, "nothing"); }
      continue;
    }
    if (n.kind === "reply_owed" || (n.kind === "float" && n.who === "you") || (n.kind === "deal" && n.who === "you")) {
      out.waitingOnYou++; row(o, n, "waiting_on_you");
      continue;
    }
    const at = ms(n.at);
    if (at != null && at < now - MISSED_AFTER_HOURS * HOUR_MS && n.kind !== "stopped") { out.missed++; row(o, n, "missed"); }
  }
  return out;
}

/**
 * agentLeaks(plan) → { due, dueNoSeat, dueWhileOff, coldDropped, freshListings, coverage }
 *
 * `plan` is planAgentPulse(): its counts, and whether the check-in is on.
 * Due agents the pulse can't seat today, or would text if it were on, are
 * the agent side's leak; coverage is the share of agents who have written
 * back that were touched inside the check-in's cadence.
 */
export function agentLeaks(plan = null) {
  const c = plan?.counts;
  if (!c) return null;
  const due = Object.values(c.due || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const on = Boolean(plan.settings?.enabled);
  return {
    enabled: on, due, dueNoSeat: on ? Number(c.dueNoSeat) || 0 : 0, dueWhileOff: on ? 0 : due,
    freshListings: Number(c.due?.fresh_listing) || 0, coldDropped: Number(c.coldDropped) || 0,
    coverage: { touched: Number(c.coverage?.touched) || 0, pool: Number(c.coverage?.pool) || 0, pct: pct(Number(c.coverage?.touched) || 0, Number(c.coverage?.pool) || 0) },
  };
}

/**
 * buyerLeaks(plan, targets) → { eligible, dueNoSeat, dueWhileOff, passWorkdays, passTooLong, coverage }
 *
 * `plan` is planBuyerPulse(). Reachable buyers are those with a phone and no
 * block; in cadence, the reachable ones not due a check-in now.
 */
export function buyerLeaks(plan = null, targets = LINE_TARGET_DEFAULTS) {
  const c = plan?.counts;
  if (!c) return null;
  const t = normalizeLineTargets(targets);
  const on = Boolean(plan.settings?.enabled);
  const eligible = Number(c.eligible) || 0;
  const seats = Array.isArray(plan.picks) ? plan.picks.length : 0;
  const reachable = Math.max(0, (Number(c.pool) || 0) - (Number(c.noPhone) || 0) - (Number(c.blocked) || 0));
  const passWorkdays = c.passWorkdays ?? null;
  return {
    enabled: on, eligible,
    dueNoSeat: on ? Math.max(0, eligible - seats) : 0, dueWhileOff: on ? 0 : eligible,
    // Five workdays to seven days: how long one pass through the pool takes
    // against how often each buyer should hear from us.
    passWorkdays, passTooLong: passWorkdays != null && passWorkdays * 7 / 5 > t.buyerTouchDays,
    coverage: { inCadence: Math.max(0, reachable - eligible), reachable, pct: pct(Math.max(0, reachable - eligible), reachable) },
  };
}

// The Today deal rows that mean a live deal isn't moving toward a buyer.
// A closing date or a checklist item is a leak once it's overdue ("now"),
// not while it's merely coming up.
export const DEAL_LEAK_KINDS = ["deal_no_buyers", "blast_no_opens", "deal_interest_stalled", "deal_no_dataroom", "stage_lag", "closing_soon", "closing_task_due"];
const ONLY_WHEN_OVERDUE = new Set(["closing_soon", "closing_task_due"]);

/** dealLeaks(actions) → { total, byKind, rows } — from buildPipeline().actions. */
export function dealLeaks(actions = []) {
  const rows = (actions || []).filter((a) => DEAL_LEAK_KINDS.includes(a?.kind) && (!ONLY_WHEN_OVERDUE.has(a.kind) || a.severity === "now"));
  const byKind = {};
  for (const a of rows) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  return { total: rows.length, byKind, rows: rows.slice(0, LEAK_ROWS).map((a) => ({ kind: a.kind, offerId: a.offerId || null, address: a.address || "", title: a.title || "", severity: a.severity || "" })) };
}

/**
 * leakTotal(leaks) → one number for the Today strip: what fell off with
 * nothing scheduled. Not what waits on you, and not the backlog: an agent or
 * buyer queued behind today's check-in seats is scheduled, just late. With a
 * check-in switched off, everyone it would reach is a leak.
 */
export function leakTotal(leaks = {}) {
  return (leaks.offers?.nothing || 0) + (leaks.offers?.missed || 0)
    + (leaks.agents?.dueWhileOff || 0) + (leaks.buyers?.dueWhileOff || 0)
    + (leaks.deals?.total || 0);
}

/** backlogTotal(leaks) → agents and buyers due a check-in, queued behind today's seats. */
export function backlogTotal(leaks = {}) {
  return (leaks.agents?.dueNoSeat || 0) + (leaks.buyers?.dueNoSeat || 0);
}

/* ---------- the switchboard ---------- */

// The durable jobs (job_cursors), by cursor name. `every` is how often a
// healthy one runs: "day" (a daily window), "workday", or "tick".
export const LINE_JOBS = {
  followUp: { label: "Follow-up sweep", every: "day" },
  outreach: { label: "Outreach autopilot (county pull)", every: "day" },
  outreachFollowUp: { label: "Outreach 14-day follow-up", every: "day" },
  agentPulse: { label: "Agent check-in", every: "workday" },
  buyerPulse: { label: "Buyer check-in", every: "workday" },
  dispo: { label: "Buyer waves", every: "day" },
  investorBookSync: { label: "Buyer book sync", every: "day" },
  priceWatch: { label: "Price watch", every: "day" },
  tierCheck: { label: "Tier check", every: "day" },
  enrichNightly: { label: "Nightly enrich", every: "day" },
  conversationAudit: { label: "Nightly audit", every: "day" },
  daytimeDriver: { label: "Daytime pass", every: "day" },
  coach: { label: "Nightly coach", every: "day" },
  calls: { label: "Call sweep", every: "tick" },
  uwQueue: { label: "Underwrite queue", every: "tick" },
  ghlMirror: { label: "GHL mirror", every: "tick" },
};

/**
 * lineJobs(cursors, { now }) → [{ name, label, every, lastRunAt, hoursAgo, failed, error, tries }]
 *
 * One row per known job, from its cursor. A job that never ran has no row
 * in the table and says so. Whether a quiet job is switched off is the
 * Autopilot page's to say; this only reports what ran.
 */
export function lineJobs(cursors = [], { now = Date.now() } = {}) {
  const by = new Map((cursors || []).map((c) => [c.name, c]));
  return Object.entries(LINE_JOBS).map(([name, j]) => {
    const c = by.get(name);
    const d = c?.doc || {};
    const last = d.last && typeof d.last === "object" ? d.last : {};
    const lastRunAt = last.finishedAt || last.at || d.lastDaily || d.run?.startedAt || c?.at || null;
    const t = ms(lastRunAt);
    return {
      name, label: j.label, every: j.every, lastRunAt,
      hoursAgo: t != null ? round1((now - t) / HOUR_MS) : null,
      failed: d.failed === true || last.status === "error",
      error: String(last.error || d.error || "").slice(0, 200),
      tries: Number(d.tries) || 0,
      never: !c,
    };
  });
}

/** errorsByArea(errors) → [{ area, n, count, lastAt, message }] — app_errors grouped, busiest first. */
export function errorsByArea(errors = []) {
  const m = new Map();
  for (const e of errors || []) {
    const area = String(e?.area || "other");
    const g = m.get(area) || { area, n: 0, count: 0, lastAt: "", message: "" };
    g.n++;
    g.count += Number(e.count) || 1;
    const at = String(e.lastAt || e.at || "");
    if (at > g.lastAt) { g.lastAt = at; g.message = String(e.message || "").slice(0, 200); }
    m.set(area, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));
}

/* ---------- pricing, read-only ---------- */

/**
 * realizedPricing({ scorecards, settings }) → { setting, sold, died, rows }
 *
 * What buyers paid, all-in (price + fee + repairs) as a share of ARV, on the
 * deals that sold (a buyer found, assigned, closed) and the deals that died —
 * beside the offer setting (maoPctOfArv). Offers are priced so buyers are
 * shown the setting's share all-in; the post-mortem (2026-09-10) found the
 * deals that sold sat near 70% and the ones that died asked 74–82%. This is
 * that evidence, kept current. It changes nothing.
 */
export function realizedPricing({ scorecards = [], settings = {} } = {}) {
  const rows = (scorecards || []).filter((s) => s && Number.isFinite(Number(s.allInPctOfArv)) && Number(s.arv) > 0)
    .map((s) => ({ offerId: s.offerId || null, street: s.street || String(s.address || "").split(",")[0], outcome: s.outcome, allInPct: round1(Number(s.allInPctOfArv)) }));
  const sold = rows.filter((r) => ["closed", "assigned", "buyer_found"].includes(r.outcome));
  const died = rows.filter((r) => r.outcome === "fell_through");
  const side = (xs) => ({ n: xs.length, medianPct: xs.length ? round1(median(xs.map((r) => r.allInPct))) : null });
  const setting = Number(settings?.maoPctOfArv) || null;
  const s = side(sold); const d = side(died);
  return {
    setting, sold: s, died: d,
    // Points between what the setting shows buyers and what the sold deals paid.
    gapToSold: setting != null && s.medianPct != null ? round1(setting - s.medianPct) : null,
    rows: [...sold, ...died].sort((a, b) => a.allInPct - b.allInPct),
  };
}

/* ---------- the whole line ---------- */

/**
 * buildLine({ week, month, offers, actions, agentPlan, buyerPlan, cursors, errors, scorecards, settings, targets, now })
 *   → { targets, stations, method, cycle, leaks, leakTotal, backlog, coverage, jobs, errors, pricing, sources }
 */
export function buildLine({
  week = [], month = [], offers = [], actions = [], agentPlan = null, buyerPlan = null,
  cursors = [], errors = [], scorecards = [], settings = {}, targets = null, now = Date.now(),
} = {}) {
  const t = normalizeLineTargets(targets ?? settings?.lineTargets);
  const leaks = {
    offers: offerLeaks(offers, { now }),
    agents: agentLeaks(agentPlan),
    buyers: buyerLeaks(buyerPlan, t),
    deals: dealLeaks(actions),
  };
  return {
    generatedAt: new Date(now).toISOString(),
    targets: t,
    stations: lineStations({ week, month, targets: t }),
    method: methodMath({ month, targets: t }),
    cycle: cycleTimes(offers, { now, days: 30 }),
    leaks, leakTotal: leakTotal(leaks), backlog: backlogTotal(leaks),
    coverage: { agents: leaks.agents?.coverage || null, buyers: leaks.buyers?.coverage || null },
    jobs: lineJobs(cursors, { now }),
    errors: errorsByArea(errors),
    pricing: realizedPricing({ scorecards, settings }),
    // Off-market vs listed (shared/off-market.js): our best deals, counted
    // station by station — the last 90 days and all time.
    sources: { days90: offMarketStats(offers, { now, days: 90 }), allTime: offMarketStats(offers, { now }) },
    // Single family vs everything else (Matt, 2026-10-01: focus on SFR).
    // A house Zillow never typed is its own column, not guessed into a side.
    kinds: { days90: kindStats(offers, { now, days: 90 }), allTime: kindStats(offers, { now }) },
  };
}

/** kindStats(offers, { now, days }) → { sfr, other, untyped } — the funnel by kind of house (shared/asset-type.js). */
export function kindStats(offers = [], { now = Date.now(), days = null } = {}) {
  const sideOf = (o) => { const t = normalizeAsset(o.asset)?.type; return !t ? "untyped" : t === "sfr" ? "sfr" : "other"; };
  return funnelBy(offers, sideOf, { now, days, sides: ["sfr", "other", "untyped"] });
}
