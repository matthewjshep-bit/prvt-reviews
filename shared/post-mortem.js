// post-mortem.js — why a deal we had under contract died, and what that
// should change about the next offer.
//
// A fell-through deal is the most expensive lesson the business buys: an
// agent relationship spent, a week of buyers' attention spent, and a house
// we now can't re-offer on. Today it leaves behind one free-text line. This
// module reads everything the deal left — the numbers we underwrote at, the
// price we contracted at, what every buyer said, what the agent said while
// we negotiated — and turns it into two things: a scorecard per deal that
// is the same arithmetic every time, and a set of lessons across deals that
// name a change and show the evidence for it.
//
// THIS MODULE ONLY READS. Like funnel.js it is a report, not a controller:
// a recommendation here carries a `suggestedSettings` object the operator
// can apply with a click, and nothing applies it for them. The buyer
// ceiling it computes is a readout beside the offer, never a clamp on it.
//
// Pure. Threads, events and the AI's reading come in as plain data.

import { calculateOffers, effectiveSettings } from "./offer-calc.js";
import { PASS_REASONS, PASS_REASON_LABEL, normalizePassReason, summarizeFeedback } from "./conversation-ai.js";
import { parseThread, PASS_RE } from "./deal-feedback.js";
import { offerEvents, EVENT_LABEL } from "./contact-record.js";

const DAY_MS = 86400000;
const round = (v) => Math.round(Number(v) || 0);
const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const pct = (n, d, digits = 1) => (d > 0 ? Math.round((n / d) * 100 * 10 ** digits) / 10 ** digits : null);
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const finite = (xs) => xs.filter((x) => Number.isFinite(x));
export const median = (xs = []) => {
  const s = finite(xs).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 100) / 100;
};
const money = (n) => `$${round(n).toLocaleString("en-US")}`;
const kText = (n) => `${Math.round(round(n) / 1000)}k`;
const streetOf = (a) => String(a || "").split(",")[0].trim();

/* ---------- vocabulary: why a deal fell through ---------- */

// The buyer-side codes map onto PASS_REASONS so a post-mortem can be
// suggested from what the buyers already said; the rest are the contract
// dying for reasons no buyer had a say in.
export const FELL_THROUGH_CODES = [
  "buyers_passed_price", "buyers_passed_rehab", "buyers_passed_area", "no_buyer_response",
  "inspection", "seller_backed_out", "title_or_financing", "other",
];
export const FELL_THROUGH_LABEL = {
  buyers_passed_price: "Buyers passed on price",
  buyers_passed_rehab: "Buyers doubted the rehab / condition",
  buyers_passed_area: "Buyers don't want the area",
  no_buyer_response: "No buyer engaged",
  inspection: "Inspection / feasibility",
  seller_backed_out: "Seller backed out",
  title_or_financing: "Title or financing",
  other: "Other",
};
export function normalizeFellThroughCode(v) {
  const raw = String(v || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return FELL_THROUGH_CODES.includes(raw) ? raw : "";
}
// The code the buyers' own pass reasons point at. `byCode` is the
// summarizeFeedback shape, sorted by count; the top house-related reason wins.
export function codeFromPassReasons(byCode = []) {
  const GROUP = { price: "buyers_passed_price", rehab_scope: "buyers_passed_rehab", condition: "buyers_passed_rehab", area: "buyers_passed_area" };
  const totals = new Map();
  for (const r of byCode || []) { const g = GROUP[r?.code]; if (g) totals.set(g, (totals.get(g) || 0) + (Number(r.count) || 0)); }
  if (!totals.size) return (byCode || []).length ? "other" : "no_buyer_response";
  // Ties go to the reason about the HOUSE we can fix next time: rehab, then price, then area.
  const order = ["buyers_passed_rehab", "buyers_passed_price", "buyers_passed_area"];
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0][0];
}

/* ---------- the buyer ceiling ---------- */

/**
 * buyerCeiling({ offer, settings, fee, pct }) → {
 *   computable, reason, source, arv, repairs, pct, fee,
 *   noFee,     // pct% of ARV − repairs: the most a flipper pays in total
 *   withFee,   // that minus our fee: the most the CONTRACT price can be
 *   note,      // a caveat worth printing ("no repair estimate")
 * }
 *
 * The classic 70% rule, run through our own calculator's "mao" mode so it
 * moves with the settings the operator tunes. Same source discipline as
 * auto-accept.js: the offer's frozen settings snapshot first, the location's
 * current settings only when there is no snapshot, and ARV read explicitly so
 * an asking price can never stand in for it.
 */
export function buyerCeiling({ offer = {}, settings = {}, fee, pct: pctOverride } = {}) {
  const no = (reason) => ({ computable: false, reason, source: "", arv: 0, repairs: 0, pct: 0, fee: 0, noFee: 0, withFee: 0, note: "" });
  const arv = round(offer.arv ?? offer.calc?.inputs?.arv);
  const repairs = Math.max(0, round(offer.repairs ?? offer.calc?.inputs?.repairs));
  if (!(arv > 0)) return no("no ARV on this offer");
  const snapshot = offer.calc?.settings;
  const source = snapshot ? "offer_snapshot" : "location_settings";
  const base = { ...(snapshot || effectiveSettings(settings)) };
  delete base.conversationAi;
  const usePct = Number.isFinite(Number(pctOverride)) && Number(pctOverride) > 0 ? Number(pctOverride) : num(base.maoPctOfArv, 70);
  const useFee = Number.isFinite(Number(fee)) ? Math.max(0, round(fee)) : Math.max(0, round(offer.deal?.assignmentFee) || round(base.wholesaleFee));
  let noFee = 0;
  try {
    const calc = calculateOffers(
      { address: offer.address || "", arv, repairs, askingPrice: 0, priceOverride: 0 },
      { ...base, underwriteMode: "mao", maoPctOfArv: usePct, wholesaleFee: 0, precisionJitter: false },
    );
    noFee = round(calc.offers?.cash?.amount);
  } catch (e) {
    return no(`the numbers wouldn't compute: ${e.message}`);
  }
  return {
    computable: true, reason: "", source, arv, repairs, pct: usePct, fee: useFee,
    noFee, withFee: Math.max(0, noFee - useFee),
    note: repairs > 0 ? "" : "no repair estimate — every dollar of rehab comes straight off this line",
  };
}

/* ---------- per-deal scorecard ---------- */

const TERMINAL = new Set(["closed", "fell_through"]);
const outcomeOf = (deal) => {
  if (!deal) return "no_deal";
  if (deal.stage === "fell_through") return "fell_through";
  if (["closed", "assigned", "buyer_found"].includes(deal.stage)) return deal.stage;
  return "live";
};
const stageAt = (deal, stage) => (deal?.stageHistory || []).find((s) => s?.stage === stage)?.ts || null;

// Every coded reason a buyer gave on this deal, one per (buyer, code).
function codedReasonsFor(deal = {}, feedback = null) {
  const seen = new Set();
  const rows = [];
  const add = (contactId, r) => {
    const n = normalizePassReason(r);
    if (!n) return;
    const key = `${contactId || "?"}|${n.code}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ contactId: contactId || "", code: n.code, note: n.note });
  };
  for (const inv of deal.investors || []) if (inv?.reason) add(inv.contactId, inv.reason);
  for (const f of deal.feedback || []) if (f?.code) add(f.contactId, f);
  for (const o of feedback?.objections || []) for (const b of o.buyers || []) add(b.contactId, { code: o.code, note: b.note || b.quote || "" });
  return rows;
}

/**
 * dealScorecard({ offer, settings, feedback, events, now }) → the same
 * arithmetic on every deal. `feedback` is the buildFeedbackPackage output
 * when a thread read has happened, else null — the counts then come off the
 * deal record's investor statuses, which is a coarser but honest read.
 */
export function dealScorecard({ offer = {}, settings = {}, feedback = null, events = [], now = Date.now() } = {}) {
  const deal = offer.deal || null;
  const outcome = outcomeOf(deal);
  const arv = round(offer.arv ?? offer.calc?.inputs?.arv);
  const repairs = round(offer.repairs ?? offer.calc?.inputs?.repairs);
  const contractPrice = round(deal?.contractPrice) || round(offer.cashAmount);
  const assignmentFee = round(deal?.assignmentFee);
  const buyerPrice = contractPrice + assignmentFee;

  const cash = offer.calc?.offers?.cash || {};
  const revisions = Array.isArray(offer.revisions) ? offer.revisions.filter((r) => r?.ts) : [];
  const firstOffer = round(revisions[0]?.from) || round(offer.cashAmount);
  const finalOffer = round(offer.cashAmount);
  const counter = round(offer.counter?.amount) || round((offer.statusHistory || []).filter((h) => h?.status === "countered" && h.amount).at(-1)?.amount) || null;
  const underwrite = {
    mode: cash.mode || offer.calc?.settings?.underwriteMode || offer.snapshot?.underwriteMode || "",
    systemAmount: round(cash.systemAmount ?? cash.amount) || finalOffer,
    overridden: Boolean(cash.overridden),
    firstOffer, finalOffer, revisions: revisions.length,
    climb: contractPrice - firstOffer, climbPct: pct(contractPrice - firstOffer, firstOffer),
    counter, counterLift: counter ? counter - firstOffer : null,
  };

  const ceiling = buyerCeiling({ offer, settings, fee: assignmentFee || undefined });
  const gap = ceiling.computable ? buyerPrice - ceiling.noFee : null;

  // Time: how long we held it, and how fast the market answered.
  const since = ms(deal?.createdAt) ?? ms(stageAt(deal, "under_contract")) ?? ms(offer.statusAt) ?? null;
  const ended = ms(deal?.stage && TERMINAL.has(deal.stage) ? stageAt(deal, deal.stage) : null);
  const buyersRows = feedback?.buyers || [];
  const repliedAts = finite(buyersRows.map((b) => ms(b.repliedAt)));
  const passAts = finite([
    ...buyersRows.filter((b) => b.passed).map((b) => ms(b.repliedAt)),
    ...events.filter((e) => e?.type === "investor_passed").map((e) => ms(e.at)),
    ...(deal?.investors || []).filter((i) => i?.status === "passed").map((i) => ms(i.reason?.at || i.updatedAt)),
  ]).filter((t) => since == null || t >= since);   // a status stamped before the deal began is a stale record, not a fast market
  const daysFrom = (t) => (since != null && t != null ? Math.round(((t - since) / DAY_MS) * 10) / 10 : null);
  const days = {
    underContract: since != null ? Math.round(((ended ?? now) - since) / DAY_MS) : null,
    toFirstReply: repliedAts.length ? daysFrom(Math.min(...repliedAts)) : null,
    toFirstPass: passAts.length ? daysFrom(Math.min(...passAts)) : null,
  };

  // Buyers: the package when we have one, the record when we don't.
  const investors = deal?.investors || [];
  const f = feedback?.funnel || null;
  const contacted = f ? f.contacted : investors.length;
  const replied = f ? f.replied : investors.filter((i) => i?.status && i.status !== "sent").length;
  const passed = f ? f.passed : investors.filter((i) => i?.status === "passed").length;
  const committed = f ? f.committed : investors.filter((i) => i?.status === "committed").length;
  const silent = f ? f.silent : Math.max(0, contacted - replied);
  const coded = codedReasonsFor(deal || {}, feedback);
  const askedAmounts = finite((feedback?.askedFor || []).map((a) => round(a.amount))).filter((a) => a > 0);
  const buyers = {
    contacted, replied, passed, silent, committed,
    replyRate: pct(replied, contacted), passRate: pct(passed, contacted),
    codedReasons: summarizeFeedback(coded).byCode,
    askedFor: { n: askedAmounts.length, min: askedAmounts.length ? Math.min(...askedAmounts) : null, median: median(askedAmounts), max: askedAmounts.length ? Math.max(...askedAmounts) : null },
    source: f ? "threads" : "record",
  };

  const fellThroughCode = normalizeFellThroughCode(deal?.fellThroughCode)
    || (outcome === "fell_through" ? codeFromPassReasons(buyers.codedReasons) : "");

  return {
    offerId: offer.id || null, address: offer.address || "", street: streetOf(offer.address),
    stage: deal?.stage || null, outcome,
    fellThroughReason: String(deal?.fellThroughReason || ""), fellThroughCode, fellThroughCodeLabel: FELL_THROUGH_LABEL[fellThroughCode] || "",
    arv, repairs, rehabPctOfArv: pct(repairs, arv),
    contractPrice, assignmentFee, buyerPrice,
    cpPctOfArv: pct(contractPrice, arv), buyerPctOfArv: pct(buyerPrice, arv),
    // What the buyer's whole outlay would be as a share of ARV — the number
    // the 70% rule is actually about.
    allInPctOfArv: pct(buyerPrice + repairs, arv),
    underwrite, ceiling,
    gap, gapPctOfArv: gap != null ? pct(gap, arv) : null, overCeiling: gap != null && gap > 0,
    days, buyers,
  };
}

/* ---------- the post-mortem itself ---------- */

const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?\b|\b\d+(?:\.\d+)?\s?[kK]\b|\b\d(?:\.\d+)?\s?[mM]\b|\b\d{1,3}(?:,\d{3})+\b/g;
export function amountsIn(text = "") {
  const out = [];
  for (const m of String(text || "").matchAll(MONEY_RE)) {
    const t = m[0].replace(/[$,\s]/g, "");
    const suffix = t.slice(-1).toLowerCase();
    const base = Number(suffix === "k" || suffix === "m" ? t.slice(0, -1) : t);
    if (!Number.isFinite(base)) continue;
    const n = Math.round(suffix === "k" ? base * 1e3 : suffix === "m" ? base * 1e6 : base);
    if (n >= 10000) out.push(n);
  }
  return out;
}
// "$1.85" in an agent's text about a two-million-dollar house means 1.85M.
// Only when the house is worth millions and the figure is a bare decimal.
function readAgentAmounts(text, arv) {
  const found = amountsIn(text);
  if (arv >= 1e6) {
    for (const m of String(text || "").matchAll(/\$\s?(\d\.\d{1,3})\b(?!\s?[kKmM])/g)) found.push(Math.round(Number(m[1]) * 1e6));
  }
  return [...new Set(found)];
}

const ANALYSIS_WHO = ["agent", "buyer", "us"];
/**
 * normalizeAnalysis(a) → the AI's (or a person's) reading, trimmed to the
 * shape the page renders, or null when there is nothing usable in it.
 */
export function normalizeAnalysis(a) {
  if (!a || typeof a !== "object") return null;
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const list = (v, n, each) => (Array.isArray(v) ? v : []).map((x) => str(x, each)).filter(Boolean).slice(0, n);
  const rootCauses = (Array.isArray(a.rootCauses) ? a.rootCauses : []).map((rc) => {
    const code = normalizeFellThroughCode(rc?.code) || (PASS_REASONS.includes(rc?.code) ? rc.code : "");
    if (!code) return null;
    const weight = Math.min(1, Math.max(0, num(rc.weight, 0)));
    const evidence = (Array.isArray(rc.evidence) ? rc.evidence : []).map((e) => ({
      who: ANALYSIS_WHO.includes(e?.who) ? e.who : "buyer", quote: str(e?.quote, 400), at: str(e?.at, 40),
    })).filter((e) => e.quote).slice(0, 8);
    return { code, label: FELL_THROUGH_LABEL[code] || PASS_REASON_LABEL[code] || code, weight, summary: str(rc.summary, 400), evidence };
  }).filter(Boolean).slice(0, 8);
  const concessions = (Array.isArray(a.agentSide?.concessions) ? a.agentSide.concessions : []).map((c) => ({
    at: str(c?.at, 40), from: round(c?.from) || null, to: round(c?.to) || null, why: str(c?.why, 300),
  })).filter((c) => c.why || c.to).slice(0, 10);
  const out = {
    rootCauses,
    agentSide: { narrative: str(a.agentSide?.narrative, 2000), concessions, backOutResponse: str(a.agentSide?.backOutResponse, 600) },
    buyerSide: { narrative: str(a.buyerSide?.narrative, 2000), whatTheyNeeded: str(a.buyerSide?.whatTheyNeeded, 600) },
    whatWouldHaveSold: { price: round(a.whatWouldHaveSold?.price) || null, basis: str(a.whatWouldHaveSold?.basis, 600) },
    lessons: list(a.lessons, 10, 400),
    offerProcessChanges: list(a.offerProcessChanges, 10, 400),
    by: str(a.by, 40) || "ai",
  };
  const empty = !out.rootCauses.length && !out.agentSide.narrative && !out.buyerSide.narrative && !out.lessons.length;
  return empty ? null : out;
}

/**
 * buildPostMortem({ offer, settings, feedback, agentThread, events, analysis, now })
 *
 *   feedback     buildFeedbackPackage output | null
 *   agentThread  the listing agent's transcript as enrich.js builds it
 *   events       contact_events rows for this offer (blast_sent etc.)
 *   analysis     the AI's structured reading | a person's | null
 */
export function buildPostMortem({ offer = {}, settings = {}, feedback = null, agentThread = "", events = [], analysis = null, now = Date.now() } = {}) {
  if (!offer?.id) throw new Error("buildPostMortem needs an offer");
  const deal = offer.deal || {};
  const scorecard = dealScorecard({ offer, settings, feedback, events, now });

  // Buyers, in their words: one quote per pass, the coded reason beside it.
  const quotes = [];
  for (const o of feedback?.objections || []) {
    for (const b of o.buyers || []) {
      if (!b.quote && !b.note) continue;
      quotes.push({ who: "buyer", name: b.name || b.shortName || "A buyer", contactId: b.contactId || "", code: o.code, label: o.label || PASS_REASON_LABEL[o.code] || o.code, at: b.at || null, text: String(b.quote || b.note).slice(0, 400), fromCall: Boolean(b.fromCall) });
    }
  }
  for (const inv of deal.investors || []) {
    if (inv?.status !== "passed" || !inv.reason?.note) continue;
    if (quotes.some((q) => q.contactId === inv.contactId)) continue;
    const n = normalizePassReason(inv.reason);
    quotes.push({ who: "buyer", name: inv.name || "A buyer", contactId: inv.contactId, code: n?.code || "other", label: PASS_REASON_LABEL[n?.code] || "Other", at: inv.reason.at || inv.updatedAt || null, text: n?.note || "", fromCall: false });
  }

  // The negotiation: every line on either side that carried a number or a
  // no, inside the offer's life. The agent's numbers are what we were told;
  // ours are what we conceded.
  // The store stamps createdAt with "now" on an import, so the deal's own
  // dates bound the window too — whichever is earliest.
  const start = Math.min(...finite([ms(offer.createdAt), ms(deal.createdAt), ms((deal.stageHistory || [])[0]?.ts)]).concat([Infinity])) - 7 * DAY_MS;
  const end = (ms(deal.stage && TERMINAL.has(deal.stage) ? stageAt(deal, deal.stage) : null) ?? now) + 7 * DAY_MS;
  const exchange = [];
  for (const l of parseThread(agentThread)) {
    const at = ms(l.at);
    if (at == null || at < start || at > end) continue;
    if (l.channel !== "sms" && l.channel !== "email") {
      // A call: keep the lines that name money or a no.
      for (const t of l.transcript || []) {
        const amounts = readAgentAmounts(t.text, scorecard.arv);
        if (!amounts.length && !PASS_RE.test(t.text)) continue;
        exchange.push({ at: l.at, who: l.dir === "US" ? "us" : "agent", channel: "call", text: String(t.text).trim().slice(0, 400), amounts });
      }
      continue;
    }
    const body = String(l.body || "").trim();
    if (!body) continue;
    const amounts = readAgentAmounts(body, scorecard.arv);
    if (!amounts.length && !PASS_RE.test(body)) continue;
    exchange.push({ at: l.at, who: l.dir === "US" ? "us" : "agent", channel: l.channel, text: body.slice(0, 500), amounts });
  }
  exchange.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const trimmed = exchange.slice(0, 60);
  // Did the contract price come out of the agent's mouth before we agreed to
  // it? A seller's break-even, adopted as our number, is its own lesson.
  const cp = scorecard.contractPrice;
  // The FIRST mention of that number on the thread decides: an agent relaying
  // "they'll do 430" after we countered at 430 is our number coming back, not
  // theirs going first.
  const named = trimmed.find((x) => x.amounts.some((a) => Math.abs(a - cp) <= Math.max(1000, cp * 0.01)));
  const sellerNamedPrice = Boolean(named) && named.who === "agent" && (ms(deal.createdAt) == null || (ms(named.at) ?? 0) <= (ms(deal.createdAt) ?? 0) + DAY_MS);
  const negotiation = {
    firstOffer: scorecard.underwrite.firstOffer, finalOffer: scorecard.underwrite.finalOffer,
    revisions: (offer.revisions || []).filter((r) => r?.ts).map((r) => ({ ts: r.ts, from: round(r.from), to: round(r.to) })),
    counter: scorecard.underwrite.counter, contractPrice: cp, climb: scorecard.underwrite.climb,
    sellerNamedPrice, sellerNamedAt: sellerNamedPrice ? named.at : null,
    exchange: trimmed,
  };

  // What happened, in order — the offer's own events plus the store's.
  const seen = new Set();
  const timeline = [];
  const push = (e) => {
    const key = `${e.type}|${e.at}|${e.contactId || ""}`;
    if (seen.has(key) || !e.at) return;
    seen.add(key);
    timeline.push({ at: e.at, type: e.type, label: EVENT_LABEL[e.type] || e.type.replace(/_/g, " "), who: e.party || "", contactId: e.contactId || "", data: e.data || {} });
  };
  for (const e of offerEvents(offer)) push(e);
  const counts = {};
  for (const e of events) {
    if (!e?.type) continue;
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (["blast_sent", "dataroom_sent"].includes(e.type)) continue;   // counted, not listed — a blast is hundreds of rows
    push(e);
  }
  timeline.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    offerId: offer.id, address: offer.address || "", street: streetOf(offer.address),
    agent: { name: offer.contactName || "", contactId: offer.contactId || null },
    stage: deal.stage || null,
    scorecard,
    reasons: {
      code: scorecard.fellThroughCode, label: scorecard.fellThroughCodeLabel, text: scorecard.fellThroughReason,
      coded: scorecard.buyers.codedReasons, quotes: quotes.slice(0, 30),
    },
    negotiation,
    timeline: timeline.slice(-80),
    eventCounts: counts,
    analysis: normalizeAnalysis(analysis),
    sources: {
      agentThreadChars: String(agentThread || "").length,
      buyerThreads: (feedback?.buyers || []).length,
      feedbackGeneratedAt: feedback?.generatedAt || null,
      events: events.length,
    },
  };
}

/* ---------- lessons across deals ---------- */

const METRICS = [
  { key: "buyerPctOfArv", label: "Buyer price as % of ARV", unit: "%", failedHigher: true },
  { key: "allInPctOfArv", label: "Buyer price + repairs as % of ARV", unit: "%", failedHigher: true },
  { key: "gapPctOfArv", label: "Over the buyer ceiling, % of ARV", unit: "%", failedHigher: true },
  { key: "rehabPctOfArv", label: "Rehab as % of ARV", unit: "%", failedHigher: false },
  { key: "underwrite.climbPct", label: "Climb from first offer to contract", unit: "%", failedHigher: true },
  { key: "buyers.replyRate", label: "Buyers who replied", unit: "%", failedHigher: false },
  { key: "buyers.passRate", label: "Buyers who passed", unit: "%", failedHigher: true },
  { key: "days.toFirstPass", label: "Days to the first pass", unit: "d", failedHigher: false },
];
const get = (o, path) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), o);

/**
 * lessons({ postMortems, controls, settings }) → { sample, metrics, recommendations, digest, current }
 *
 *   postMortems  buildPostMortem outputs (the deals that died)
 *   controls     dealScorecard outputs for deals that sold or found a buyer
 *   settings     the location's current settings, for "change X from A to B"
 *
 * Every recommendation is gated on evidence from these rows and says which
 * rows. One with `suggestedSettings` is a settings delta the operator can
 * apply; one with `negotiationRule` is a line for the negotiating table.
 */
export function lessons({ postMortems = [], controls = [], settings = {}, now = Date.now() } = {}) {
  const s = effectiveSettings(settings);
  const failed = postMortems.map((pm) => pm?.scorecard).filter(Boolean);
  const ctrl = controls.filter(Boolean);
  const name = (sc) => sc.street || sc.address || sc.offerId;
  const pctS = (v) => (v == null ? "—" : `${Math.round(v * 10) / 10}%`);

  const metrics = METRICS.map((m) => {
    const fv = finite(failed.map((x) => get(x, m.key)));
    const cv = finite(ctrl.map((x) => get(x, m.key)));
    const fm = median(fv); const cm = median(cv);
    const separates = fm != null && cm != null && (m.failedHigher ? fm > cm : fm < cm);
    return { key: m.key, label: m.label, unit: m.unit, failed: { n: fv.length, values: fv, median: fm }, controls: { n: cv.length, values: cv, median: cm }, separates };
  });

  const recs = [];
  const over = failed.filter((x) => x.overCeiling);
  const ctrlUnder = ctrl.filter((x) => x.gapPctOfArv != null && x.gapPctOfArv <= 1.5);

  // 1. The line itself.
  if (over.length) {
    const allFailedOver = over.length === failed.filter((x) => x.gap != null).length;
    const allCtrlAt = ctrl.length > 0 && ctrlUnder.length === ctrl.filter((x) => x.gap != null).length;
    recs.push({
      id: "ceiling_rule", kind: "negotiation",
      title: `Contract price + fee must sit at or under ${s.maoPctOfArv}% of ARV minus repairs`,
      confidence: allFailedOver && allCtrlAt ? "high" : allFailedOver || allCtrlAt ? "medium" : "low",
      evidence: [
        ...over.map((x) => `${name(x)}: buyers were asked ${money(x.buyerPrice)} against a ceiling of ${money(x.ceiling.noFee)} — ${money(x.gap)} over (${pctS(x.gapPctOfArv)} of ARV); ${x.buyers.passed} of ${x.buyers.contacted} passed`),
        ...ctrlUnder.map((x) => `${name(x)} (${x.outcome.replace(/_/g, " ")}): asked ${money(x.buyerPrice)} against ${money(x.ceiling.noFee)} — at the line`),
      ],
      suggestedSettings: null,
      negotiationRule: `Before any counter, compute ${s.maoPctOfArv}% × ARV − repairs. Contract price + our fee never crosses it; if the seller can't get there, the answer is no, not a smaller fee.`,
    });
  }

  // 2. The model that produced the number.
  const wrongMode = failed.filter((x) => x.overCeiling && x.underwrite.mode && x.underwrite.mode !== "mao");
  if (wrongMode.length && s.underwriteMode !== "mao") {
    recs.push({
      id: "underwrite_mode", kind: "settings",
      title: `Underwrite with the 70% rule ("mao"), not "${s.underwriteMode}"`,
      confidence: wrongMode.length >= 2 ? "high" : "medium",
      evidence: wrongMode.map((x) => `${name(x)}: "${x.underwrite.mode}" priced it at ${money(x.underwrite.systemAmount)} (${pctS(pct(x.underwrite.systemAmount, x.arv))} of ARV); a flipper's line was ${money(x.ceiling.withFee)} for the contract`),
      suggestedSettings: { underwriteMode: "mao" },
      negotiationRule: null,
    });
  }

  // 3. Where the line actually is, from the deals that sold.
  const ctrlAllIn = finite(ctrl.map((x) => x.allInPctOfArv));
  const ctrlLine = median(ctrlAllIn);
  if (ctrlLine != null && s.maoPctOfArv > Math.floor(ctrlLine) + 0.4) {
    const to = Math.floor(ctrlLine);
    recs.push({
      id: "mao_pct", kind: "settings",
      title: `Set the buyer line at ${to}% of ARV (currently ${s.maoPctOfArv}%)`,
      confidence: ctrlAllIn.length >= 2 ? "medium" : "low",
      evidence: [
        ...ctrl.map((x) => `${name(x)} (${x.outcome.replace(/_/g, " ")}): buyer paid ${money(x.buyerPrice)} + ${money(x.repairs)} rehab = ${pctS(x.allInPctOfArv)} of ARV`),
        ...failed.map((x) => `${name(x)} (fell through): ${pctS(x.allInPctOfArv)} of ARV all-in`),
      ],
      suggestedSettings: { maoPctOfArv: to },
      negotiationRule: null,
    });
  }

  // 4. The fee we plan for versus the fee we take.
  const feesTaken = finite([...ctrl, ...failed].map((x) => x.assignmentFee)).filter((f) => f > 0);
  const feeMedian = median(feesTaken);
  if (feeMedian != null && s.wholesaleFee > feeMedian * 1.5) {
    const to = Math.round(feeMedian / 1000) * 1000;
    recs.push({
      id: "fee_reality", kind: "settings",
      title: `Underwrite at the fee we actually take (${money(to)}), not ${money(s.wholesaleFee)}`,
      confidence: feesTaken.length >= 3 ? "medium" : "low",
      evidence: [
        `Fees on the deals we've contracted: ${[...ctrl, ...failed].filter((x) => x.assignmentFee > 0).map((x) => `${name(x)} ${money(x.assignmentFee)}`).join(", ")}`,
        `A ${money(s.wholesaleFee)} fee in the model pushes every offer ${money(s.wholesaleFee - to)} under the line and then gets negotiated away on the contract.`,
      ],
      suggestedSettings: { wholesaleFee: to },
      negotiationRule: null,
    });
  }

  // 5. Rehab the buyers didn't believe.
  const rehabDoubt = failed.filter((x) => x.fellThroughCode === "buyers_passed_rehab" || x.buyers.codedReasons.some((r) => ["rehab_scope", "condition"].includes(r.code)));
  if (rehabDoubt.length) {
    const ctrlRehab = median(finite(ctrl.map((x) => x.rehabPctOfArv)));
    recs.push({
      id: "rehab_floor", kind: "process",
      title: "Second-source the rehab number before a deal is promoted",
      confidence: rehabDoubt.length >= 2 ? "high" : "medium",
      evidence: rehabDoubt.map((x) => {
        const n = x.buyers.codedReasons.filter((r) => ["rehab_scope", "condition"].includes(r.code)).reduce((t, r) => t + r.count, 0);
        return `${name(x)}: rehab ${money(x.repairs)} = ${pctS(x.rehabPctOfArv)} of ARV${ctrlRehab != null ? ` (deals that sold: ${pctS(ctrlRehab)})` : ""}; ${n} buyer${n === 1 ? "" : "s"} said the rehab was wrong`;
      }),
      suggestedSettings: null,
      negotiationRule: "A rehab under 8% of ARV on a distressed listing is a claim, not an estimate. Walk it or get a contractor's number before the number goes to buyers.",
    });
  }

  // 6. Revising upward past the line.
  const climbed = failed.filter((x) => x.underwrite.climb > 0 && x.overCeiling);
  if (climbed.length) {
    recs.push({
      id: "no_climbing", kind: "negotiation",
      title: "Revisions move toward the ceiling, never past it",
      confidence: "medium",
      evidence: climbed.map((x) => `${name(x)}: first offer ${money(x.underwrite.firstOffer)} → contract ${money(x.contractPrice)} (+${money(x.underwrite.climb)}, ${x.underwrite.revisions} revision${x.underwrite.revisions === 1 ? "" : "s"}); the ceiling for the contract was ${money(x.ceiling.withFee)}`),
      suggestedSettings: null,
      negotiationRule: "Every revision is checked against the ceiling before it goes out. Above it, we stop revising and say what number would work.",
    });
  }

  // 7. The seller's number became ours.
  const sellerNamed = postMortems.filter((pm) => pm?.negotiation?.sellerNamedPrice && pm.scorecard?.overCeiling);
  if (sellerNamed.length) {
    recs.push({
      id: "seller_named_price", kind: "negotiation",
      title: "A seller's break-even is their problem, not our price",
      confidence: "medium",
      evidence: sellerNamed.map((pm) => `${pm.street}: the agent named ${money(pm.scorecard.contractPrice)} and we contracted at it; the ceiling was ${money(pm.scorecard.ceiling.withFee)}`),
      suggestedSettings: null,
      negotiationRule: "When the seller names a number, run it through the ceiling before answering. \"That's what they need\" is not underwriting.",
    });
  }

  // 8. Nobody answered.
  const silentDeals = failed.filter((x) => x.buyers.contacted >= 5 && x.buyers.silent / x.buyers.contacted > 0.5);
  if (silentDeals.length) {
    recs.push({
      id: "silent_majority", kind: "process",
      title: "Follow up the silent buyers before calling a deal dead",
      confidence: "low",
      evidence: silentDeals.map((x) => `${name(x)}: ${x.buyers.silent} of ${x.buyers.contacted} buyers never replied${x.days.underContract != null ? ` in ${x.days.underContract} days` : ""}`),
      suggestedSettings: null,
      negotiationRule: null,
    });
  }

  // The digest the bot may carry: the rules in one breath, no dollar
  // figures, so the money guard's allowance stays exactly the record book.
  const fm = metrics.find((m) => m.key === "buyerPctOfArv");
  const digestLines = [];
  if (over.length) digestLines.push(`Buyers pay at most about ${s.maoPctOfArv}% of ARV minus repairs, all-in. Our contract price plus our fee has to sit under that line.`);
  if (fm?.failed?.median != null && fm?.controls?.median != null) digestLines.push(`Deals that fell through asked buyers for ${pctS(fm.failed.median)} of ARV; deals that sold asked ${pctS(fm.controls.median)}.`);
  for (const r of recs) if (r.negotiationRule && r.id !== "ceiling_rule") digestLines.push(r.negotiationRule);
  const digest = digestLines.join(" ").replace(/\$\s?[\d,.]+[kKmM]?/g, "the line").slice(0, 900);

  return {
    generatedAt: new Date(now).toISOString(),
    sample: { failed: failed.length, controls: ctrl.length, failedDeals: failed.map(name), controlDeals: ctrl.map(name) },
    current: { underwriteMode: s.underwriteMode, maoPctOfArv: s.maoPctOfArv, wholesaleFee: s.wholesaleFee, cashPctOfArv: s.cashPctOfArv, repairBuffer: s.repairBuffer },
    metrics,
    recommendations: recs,
    digest,
  };
}

export { PASS_REASON_LABEL };
