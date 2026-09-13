// buyer-score.js — how good a buyer is, and how good a buyer is FOR THIS DEAL.
//
// Two numbers, both 0–100, both explained part by part so the page can show
// why someone ranks where they do:
//
//   scoreBuyer   — standing on its own: are they actively buying (financed
//                  properties), do they engage when we send them something
//                  (replied, opened the dataroom, evaluated, committed), and
//                  can we reach and place them (phone, buy box, market).
//                  Tier falls out of it: VIP / Active / Cold.
//
//   rankForDeal  — against one deal: do they buy where it is, at its price,
//                  recently, the kind of project it is — weighted by tier.
//
// Pure. The broker feeds it the timeline; the page only reads the result.

import { regionFor, citySlug } from "./dispo-regions.js";

export const TIERS = { vip: "VIP", active: "Active", cold: "Cold" };
// VIP: committed on a deal before, or scores at least this. Active: 40+, or replied in the last 3 months.
export const VIP_SCORE = 65;
export const ACTIVE_SCORE = 40;

const DAY = 86400000;
const monthsAgo = (iso, now) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? (now - t) / (30.44 * DAY) : null;
};

/**
 * scoreBuyer({ flips, markets, buybox, phone, lastRepliedAt, engagement }, { now }) → { score, tier, parts, reasons }
 *
 * `engagement`: { blasts, viewed, evaluating, committed, passed, lastEngagedAt } counts off the timeline.
 */
export function scoreBuyer(i = {}, { now = Date.now() } = {}) {
  const f = i.flips || null;
  const e = i.engagement || {};
  const reasons = [];

  // Activity — are they buying right now, and how much.
  let activity = 0;
  const m = monthsAgo(f?.lastAt, now);
  if (m != null) {
    activity += m <= 6 ? 20 : m <= 12 ? 14 : m <= 24 ? 7 : 2;
    reasons.push(m <= 6 ? "bought in the last 6 months" : m <= 12 ? "bought this year" : "bought before");
  }
  if (f?.count) activity += Math.min(f.count, 5) * 3;
  activity = Math.min(activity, 35);

  // Engagement — what they did when we sent them something.
  let engagement = 0;
  if (e.committed) { engagement += 25; reasons.push("committed on a deal"); }
  if (i.lastRepliedAt) { engagement += 15; reasons.push("has replied"); }
  if (e.viewed) { engagement += Math.min(e.viewed, 3) * 6; reasons.push("opened a dataroom"); }
  if (e.evaluating) engagement += 8;
  if (e.passed) engagement += 3; // a reasoned no is still a conversation
  // Ghosting: blasted three or more times and never a word back.
  const ghost = (e.blasts || 0) >= 3 && !i.lastRepliedAt && !e.viewed && !e.committed;
  if (ghost) { engagement -= 10; reasons.push(`no response to ${e.blasts} blasts`); }
  engagement = Math.max(-10, Math.min(engagement, 45));

  // Reachable and placeable.
  let reach = 0;
  if (i.phone) reach += 8;
  const b = i.buybox || {};
  if (b.areas?.length || b.priceMin != null || b.priceMax != null || b.propertyTypes?.length || b.rehabAppetite) reach += 7;
  if (i.markets?.cities?.length || i.markets?.regions?.length) reach += 5;

  const score = Math.max(0, Math.min(100, Math.round(activity + engagement + reach)));
  const recentReply = monthsAgo(i.lastRepliedAt, now);
  const tier = e.committed || score >= VIP_SCORE ? "vip"
    : score >= ACTIVE_SCORE || (recentReply != null && recentReply <= 3) ? "active"
    : "cold";
  return { score, tier, parts: { activity, engagement, reach }, reasons, ghost };
}

/**
 * dealTarget({ address, city, priceMin, priceMax, rehabAppetite }) → the deal as rankForDeal reads it
 */
export function dealTarget({ city = "", priceMin = null, priceMax = null, rehabAppetite = null } = {}) {
  const slug = citySlug(city);
  const mid = priceMin != null && priceMax != null ? (priceMin + priceMax) / 2 : priceMax ?? priceMin ?? null;
  const strategy = rehabAppetite === "full_gut" ? "new-construction" : "flip";
  return { city: slug, region: slug ? regionFor(city) : null, price: mid, strategy };
}

/**
 * rankForDeal(buyer, target) → { score, parts, reasons }
 *
 * `buyer` carries markets, flips, buybox and its own scoreBuyer result (`tier`).
 */
export function rankForDeal(i = {}, t = {}, { now = Date.now() } = {}) {
  const mk = i.markets || { cities: [], regions: [], types: [] };
  const b = i.buybox || {};
  const reasons = [];

  // Location — do they buy where this is.
  let location = 0;
  const areas = (b.areas || []).map((a) => citySlug(a));
  if (t.city && (mk.cities.includes(t.city) || areas.includes(t.city))) { location = 35; reasons.push("buys in this city"); }
  else if (t.region && mk.regions.includes(t.region)) { location = 22; reasons.push("buys in this region"); }

  // Price — does the deal sit where they spend. A buy box band wins; failing
  // that, their largest loan (loans run below price, so the band is generous).
  let price = 0;
  if (t.price) {
    if (b.priceMin != null || b.priceMax != null) {
      const lo = b.priceMin ?? 0, hi = b.priceMax ?? Infinity;
      if (t.price >= lo * 0.9 && t.price <= hi * 1.1) { price = 20; reasons.push("inside their price band"); }
    } else if (i.flips?.largest) {
      const r = t.price / i.flips.largest;
      if (r >= 0.4 && r <= 1.6) { price = 20; reasons.push("in their price range"); }
      else if (r >= 0.25 && r <= 2.5) price = 8;
    }
  }

  // Recency.
  const m = monthsAgo(i.flips?.lastAt, now);
  const recency = m == null ? 0 : m <= 6 ? 15 : m <= 12 ? 10 : m <= 24 ? 5 : 0;

  // Who they are to us.
  const tierPts = i.tier === "vip" ? 20 : i.tier === "active" ? 12 : 3;
  if (i.tier === "vip") reasons.push("VIP");

  // The kind of project.
  let strategy = 0;
  if (mk.types?.includes(t.strategy)) { strategy = 10; reasons.push(t.strategy === "flip" ? "flips" : "builds"); }
  else if (mk.types?.length) strategy = 3;

  let score = location + price + recency + tierPts + strategy;
  if (i.onLiveDeal) { score -= 10; reasons.push("already on a live deal"); }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    parts: { location, price, recency, tier: tierPts, strategy },
    reasons,
  };
}

/** engagementFromEvents(events) → Map(contactId → { blasts, viewed, evaluating, committed, passed, lastEngagedAt }) */
export function engagementFromEvents(events = []) {
  const out = new Map();
  for (const ev of events) {
    if (!ev?.contactId) continue;
    const e = out.get(ev.contactId) || { blasts: 0, viewed: 0, evaluating: 0, committed: 0, passed: 0, lastEngagedAt: "" };
    if (ev.type === "blast_sent") e.blasts++;
    else {
      if (ev.type === "dataroom_viewed") e.viewed++;
      else if (ev.type === "investor_evaluating") e.evaluating++;
      else if (ev.type === "investor_committed") e.committed++;
      else if (ev.type === "investor_passed") e.passed++;
      if (String(ev.at) > e.lastEngagedAt) e.lastEngagedAt = ev.at;
    }
    out.set(ev.contactId, e);
  }
  return out;
}

export const ENGAGEMENT_TYPES = ["blast_sent", "dataroom_viewed", "investor_evaluating", "investor_committed", "investor_passed"];
