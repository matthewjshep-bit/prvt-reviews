// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// price-scorecard.js — is the offer engine accurate yet, and is it getting better? (auto-underwrite v2, 2026-11-04)
//
// The engine prices every named house in the shadow (ghl-broker/price-v2.js). This measures those
// answers against what really happened, per grade and per lead source, so Matt can switch a grade
// live only when it has earned it (Matt chose "shadow two weeks first"):
//   - Matt's own ARV and rehab, scored separately, and his inputs run through the SAME formula
//     (70% − rehab − the minimum fee), so his 75% habit doesn't read as the engine being low;
//   - the seller's numbers and whether they agreed;
//   - what the house sold for, when it sold after we priced it.
// The bars are lopsided on purpose: over-pricing is the costly miss (66 walk-backs in 100 days).
//
// Pure.

import { houseKey } from "./current-offer.js";

export const BARS = Object.freeze({ minHouses: 20, arvGap: 0.05, rehabBelowShare: 0.30, overMatt: 0.10 });
const HAND_APPROVALS = new Set(["revise", "publish", "send", "pin", "today"]);
const DEAD = new Set(["passed", "we_passed", "unavailable", "no_response"]);

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
// The middle value, or the middle of the two (2026-11-09: the lower middle let
// ARV gaps of 2, 4, 10 and 12% read 4% and pass a 5% bar; the median is 7%).
const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : 0; };

/**
 * outcomeOf({ address, offers }) → what happened on the house, from its offer rows (full docs).
 *   mattNumber/mattArv/mattRehab   the last number a person stood behind, and its inputs
 *   machineSent                    a machine number that went out with no person behind it
 *   sellerLowest                   the lowest counter amount on record
 *   agreed                         an acceptance, or a deal
 *   deal                           { stage, contractPrice }
 *   sold                           { price, at } after we priced it (price watch)
 */
export function outcomeOf({ address = "", offers = [] } = {}) {
  const key = houseKey(address);
  const rows = (offers || []).filter((o) => o && houseKey(o.address) === key);
  if (!rows.length) return null;
  const byTime = [...rows].sort((a, b) => ms(a.updatedAt || a.createdAt) - ms(b.updatedAt || b.createdAt));
  const hand = byTime.filter((o) => num(o.cashAmount) && (HAND_APPROVALS.has(o.approved?.by) || (o.revisions || []).some((r) => r?.by === "you") || !o.autoUnderwrite));
  const matt = hand.at(-1) || null;
  const inputs = matt?.calc?.inputs || matt?.inputs || {};
  const machine = byTime.filter((o) => num(o.cashAmount) && o.autoUnderwrite && !hand.includes(o) && (o.status && o.status !== "draft" && o.status !== "new" || (o.sends || []).length)).at(-1) || null;
  const counters = rows.flatMap((o) => (o.statusHistory || []).filter((h) => h?.status === "countered" && num(h.amount)).map((h) => num(h.amount)));
  const deal = rows.find((o) => o.deal)?.deal || null;
  const sold = rows.map((o) => o.priceWatch?.sold).filter((s) => num(s?.price)).sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0] || null;
  const current = byTime.at(-1);
  return {
    offerIds: rows.map((o) => o.id),
    leadSource: rows.map((o) => o.autoUnderwrite?.leadSource || o.leadSource?.source).find(Boolean) || null,
    mattNumber: matt ? Math.round(num(matt.cashAmount)) : null,
    mattArv: num(inputs.arv) || num(matt?.arv) || null,
    mattRehab: inputs.repairs != null && Number(inputs.repairs) >= 0 ? Math.round(Number(inputs.repairs)) : (matt?.repairs != null ? Math.round(Number(matt.repairs)) : null),
    mattAt: matt ? (matt.approved?.at || matt.updatedAt || null) : null,
    machineSent: machine ? Math.round(num(machine.cashAmount)) : null,
    sellerLowest: counters.length ? Math.min(...counters) : null,
    agreed: rows.some((o) => o.deal || (o.statusHistory || []).some((h) => h?.status === "accepted") || o.status === "accepted"),
    status: current?.status || null,
    dead: rows.every((o) => DEAD.has(o.status)) && !deal,
    deal: deal ? { stage: deal.stage || null, contractPrice: num(deal.contractPrice) || null } : null,
    sold: sold ? { price: num(sold.price), at: sold.at || null } : null,
  };
}

/**
 * theirReadOf({ address, events }) → { theirNumber, theirArv, theirRehab }
 *
 * What the agent said about this house, newest first: the seller's number
 * (property_details sellerAsk) and their own ARV and rehab (agent_estimate).
 * The engine is graded against these as well as Matt's (2026-11-09: the
 * scorecard only knew Matt's numbers, which run ARV high and rehab low the
 * same way the engine's do).
 */
export function theirReadOf({ address = "", events = [] } = {}) {
  const key = houseKey(address);
  const mine = (events || []).filter((e) => e?.address && houseKey(e.address) === key)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  const newest = (type, field) => num(mine.find((e) => e.type === type && num(e.data?.[field]))?.data?.[field]) || null;
  return { theirNumber: newest("property_details", "sellerAsk"), theirArv: newest("agent_estimate", "arv"), theirRehab: newest("agent_estimate", "rehab") };
}

/** One record's measurements against its outcome (null fields where there's nothing to measure). */
export function measure(doc = {}, { maoPct = 70, minFee = 15000 } = {}) {
  const v = doc.v2 || {};
  const o = doc.outcome || {};
  const r = doc.reads || {};
  const mattAtOurs = num(o.mattArv) ? (maoPct / 100) * o.mattArv - (Number(o.mattRehab) || 0) - minFee : 0;
  // Their number: what the engine knew when it priced, else what they said since.
  const theirs = num(r.sellerNumber) || num(o.theirNumber);
  const theirRehab = num(o.theirRehab) || num(r.theirRepairs);
  return {
    grade: v.grade || "C", lead: o.leadSource || doc.leadSource || "unknown", triage: v.triage || "unknown", at: v.at || null,
    arvGap: num(v.arv) && num(o.mattArv) ? Math.abs(v.arv / o.mattArv - 1) : null,
    rehabBelow: num(v.rehab) && o.mattRehab != null && o.mattRehab > 0 ? v.rehab < o.mattRehab : null,
    walkVsMatt: num(v.walkAway) && mattAtOurs > 0 ? v.walkAway / mattAtOurs : null,
    overMatt: num(v.walkAway) && mattAtOurs > 0 ? v.walkAway > mattAtOurs * 1.1 : null,
    overSold: num(v.walkAway) && num(o.sold?.price) ? v.walkAway > o.sold.price : null,
    walkVsSeller: num(v.walkAway) && num(o.sellerLowest) ? v.walkAway / o.sellerLowest : null,
    // Against their stated number (Matt, 2026-11-09: the machine never offers over it).
    walkVsTheir: num(v.walkAway) && theirs ? v.walkAway / theirs : null,
    overTheir: num(v.walkAway) && theirs ? v.walkAway > theirs : null,
    // The engine's ARV and rehab against the agent's own read.
    arvVsTheir: num(v.arv) && num(o.theirArv) ? v.arv / o.theirArv : null,
    rehabVsTheir: num(v.rehab) && theirRehab ? v.rehab / theirRehab : null,
    agreed: Boolean(o.agreed),
  };
}

function summarize(ms_ = []) {
  const share = (k) => { const xs = ms_.filter((m) => m[k] != null); return xs.length ? round3(xs.filter((m) => m[k]).length / xs.length) : null; };
  const triage = {};
  for (const m of ms_) { const t = (triage[m.triage] ||= { n: 0, agreed: 0 }); t.n++; if (m.agreed) t.agreed++; }
  return {
    n: ms_.length,
    withMatt: ms_.filter((m) => m.arvGap != null).length,
    arvGap: round3(median(ms_.map((m) => m.arvGap).filter((x) => x != null))),
    rehabBelowShare: share("rehabBelow"),
    walkVsMatt: round3(median(ms_.map((m) => m.walkVsMatt).filter((x) => x != null))),
    overMatt: ms_.filter((m) => m.overMatt).length,
    overSold: ms_.filter((m) => m.overSold).length,
    sold: ms_.filter((m) => m.overSold != null).length,
    walkVsSeller: round3(median(ms_.map((m) => m.walkVsSeller).filter((x) => x != null))),
    withTheir: ms_.filter((m) => m.walkVsTheir != null).length,
    walkVsTheir: round3(median(ms_.map((m) => m.walkVsTheir).filter((x) => x != null))),
    overTheir: ms_.filter((m) => m.overTheir).length,
    arvVsTheir: round3(median(ms_.map((m) => m.arvVsTheir).filter((x) => x != null))),
    rehabVsTheir: round3(median(ms_.map((m) => m.rehabVsTheir).filter((x) => x != null))),
    triage,
  };
}

/** graduated(summary, bars) → { ready, missing: [why] } — the bars before Matt switches a grade live. */
export function graduated(s = {}, bars = BARS) {
  const missing = [];
  if (!(s.withMatt >= bars.minHouses)) missing.push(`${s.withMatt || 0} of ${bars.minHouses} houses with your own price to compare`);
  if (s.arvGap == null || s.arvGap > bars.arvGap) missing.push(`ARV off yours by ${s.arvGap == null ? "?" : Math.round(s.arvGap * 1000) / 10}% at the median (bar ${bars.arvGap * 100}%)`);
  if (s.rehabBelowShare == null || s.rehabBelowShare > bars.rehabBelowShare) missing.push(`rehab under yours on ${s.rehabBelowShare == null ? "?" : Math.round(s.rehabBelowShare * 100)}% (bar ${bars.rehabBelowShare * 100}%)`);
  if (s.overMatt > 0) missing.push(`${s.overMatt} over your number by more than ${bars.overMatt * 100}% at the same formula`);
  if (s.overSold > 0) missing.push(`${s.overSold} over what the house sold for`);
  if (s.overTheir > 0) missing.push(`${s.overTheir} walk-away${s.overTheir === 1 ? "" : "s"} above their stated number`);
  return { ready: missing.length === 0, missing };
}

/**
 * goldenBar(golden, { price }) → { won: { n, reached }, dead: { n, stayedOut }, rows }
 *
 * The second bar, against the deals rather than Matt's numbers
 * (shared/fixtures/price-golden.json when it is committed: ZIP, size, age
 * and numbers, no names): a deal we won should be within reach of the
 * walk-away on Matt's own inputs, and a deal that died should price at least
 * 10% under its contract on the buyers' ARV and rehab (the answer key). Open
 * deals aren't scored. `price({ deal, arv, rehab })` → { walkAway }.
 */
export function goldenBar(golden = {}, { price } = {}) {
  const out = { won: { n: 0, reached: 0 }, dead: { n: 0, stayedOut: 0 }, rows: [] };
  if (typeof price !== "function") return out;
  for (const d of golden?.deals || []) {
    const contract = num(d?.contract);
    if (!contract) continue;
    if (d.outcome === "won" && num(d.matt?.arv)) {
      const w = num(price({ deal: d, arv: d.matt.arv, rehab: Number(d.matt.rehab) || 0 })?.walkAway);
      out.won.n++;
      if (w >= contract) out.won.reached++;
      out.rows.push({ id: d.id, outcome: "won", on: "matt", contract, walkAway: w, miss: round3(w / contract - 1) });
    } else if (d.outcome === "dead" && num(d.buyers?.arv) && num(d.buyers?.rehab)) {
      const w = num(price({ deal: d, arv: d.buyers.arv, rehab: d.buyers.rehab })?.walkAway);
      out.dead.n++;
      if (w <= contract * 0.9) out.dead.stayedOut++;
      out.rows.push({ id: d.id, outcome: "dead", on: "buyers", contract, walkAway: w, miss: round3(w / contract - 1) });
    }
  }
  return out;
}

/**
 * scorecard(records, { now, days, settings }) → per grade and lead source, the accuracy trend, and
 * whether each grade is ready. `records` are house_pricing docs.
 */
export function scorecard(records = [], { now = Date.now(), days = 120, settings = {} } = {}) {
  const from = now - days * 86400000;
  const all = (records || []).filter((d) => d?.v2 && ms(d.v2.at) >= from).map((d) => measure(d, settings));
  const group = (by) => { const g = {}; for (const m of all) (g[m[by]] ||= []).push(m); return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, summarize(v)])); };
  const byGrade = group("grade");
  for (const g of ["A", "B", "C"]) byGrade[g] = byGrade[g] || summarize([]);
  const recent = summarize(all.filter((m) => ms(m.at) >= now - 30 * 86400000));
  const before = summarize(all.filter((m) => ms(m.at) < now - 30 * 86400000 && ms(m.at) >= now - 60 * 86400000));
  return {
    generatedAt: new Date(now).toISOString(), days,
    total: summarize(all),
    byGrade, byLead: group("lead"),
    trend: { last30: { n: recent.withMatt, arvGap: recent.arvGap, walkVsMatt: recent.walkVsMatt }, prior30: { n: before.withMatt, arvGap: before.arvGap, walkVsMatt: before.walkVsMatt } },
    ready: { A: graduated(byGrade.A), B: graduated(byGrade.B) },
  };
}

/** scorecardLine(card) → one Slack line for the evening. */
export function scorecardLine(card = {}) {
  const t = card.total || {};
  const a = card.byGrade?.A || {};
  const pct = (x) => (x == null ? "—" : `${Math.round(x * 1000) / 10}%`);
  const ready = card.ready?.A?.ready ? "grade A is ready for your switch" : `grade A not ready: ${(card.ready?.A?.missing || [])[0] || "—"}`;
  return `Offer engine (shadow): ${t.n || 0} houses priced, ${t.withMatt || 0} with your own number. ` +
    `ARV off yours ${pct(t.arvGap)} at the median, rehab under yours on ${pct(t.rehabBelowShare)}, ` +
    `walk-away ${t.walkVsMatt == null ? "—" : `${Math.round(t.walkVsMatt * 100)}%`} of yours at the same formula. ` +
    `Grade A: ${a.n || 0} houses. ${ready}.` +
    (t.overTheir ? ` ${t.overTheir} walk-away${t.overTheir === 1 ? "" : "s"} above the seller's stated number.` : "");
}
