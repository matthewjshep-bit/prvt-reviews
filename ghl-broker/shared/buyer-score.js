// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

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

import { regionFor, citySlug, regionsForArea } from "./dispo-regions.js";
import { TALK_EVENT_TYPES, isTalkEvent } from "./talked-to.js";
import { matchBuybox } from "./buybox.js";
import { isBlockedBuyer } from "./buyer-pulse.js";
import { sameStreet } from "./us-address.js";
import { normalizeAsset, buyerTypeFit } from "./asset-type.js";

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
 * dealTarget({ address, city, priceMin, priceMax, rehabAppetite, asset }) → the deal as rankForDeal reads it
 *
 * `asset` is the kind of house (shared/asset-type.js). A mobile home is its
 * own strategy, so a buyer tagged dispo-type-mobile-home reads as one.
 */
export function dealTarget({ city = "", zip = "", priceMin = null, priceMax = null, rehabAppetite = null, propertyTypes = [], lotMin = null, asset = null } = {}) {
  const slug = citySlug(city);
  const mid = priceMin != null && priceMax != null ? (priceMin + priceMax) / 2 : priceMax ?? priceMin ?? null;
  const kind = normalizeAsset(asset);
  const strategy = kind?.type === "manufactured" ? "mobile-home" : rehabAppetite === "full_gut" ? "new-construction" : "flip";
  return { city: slug, zip: /^\d{5}$/.test(String(zip || "")) ? String(zip) : "", region: slug ? regionFor(city) : null, price: mid, strategy, asset: kind,
    // What the buy box can rule in or out beyond place and price.
    box: { propertyTypes: propertyTypes || [], rehabAppetite: rehabAppetite || null, lotMin: lotMin ?? null } };
}

/** isManufacturedTarget(target) → true for a mobile home deal, whose waves go by who buys them, not by city. */
export const isManufacturedTarget = (t) => t?.asset?.type === "manufactured";

// A buyer spoken for elsewhere (committed or soft-committed on another live
// deal). A buyer only weighing another deal is NOT: the hottest buyers are
// the ones to show the next deal (2026-09-29). Rows from before carry only
// `onLiveDeal`, which is read the old way.
const spokenFor = (i) => (i.spokenFor !== undefined ? Boolean(i.spokenFor) : Boolean(i.onLiveDeal));

/**
 * rankForDeal(buyer, target) → { score, parts, reasons }
 *
 * `buyer` carries markets, flips, buybox and its own scoreBuyer result (`tier`).
 */
export function rankForDeal(i = {}, t = {}, { now = Date.now() } = {}) {
  const mk = i.markets || { cities: [], regions: [], types: [] };
  const b = i.buybox || {};
  const reasons = [];

  // Location — do they buy where this is: the city (their loans or their buy
  // box), the zip in their buy box, or the region either way ("South King").
  let location = 0;
  const rawAreas = (b.areas || []).map((a) => String(a || "").trim()).filter(Boolean);
  const areas = rawAreas.map((a) => citySlug(a));
  const zips = rawAreas.filter((a) => /^\d{5}$/.test(a));
  const areaRegions = new Set(rawAreas.flatMap(regionsForArea));
  if (t.city && (mk.cities.includes(t.city) || areas.includes(t.city))) { location = 35; reasons.push("buys in this city"); }
  else if (t.zip && zips.includes(t.zip)) { location = 35; reasons.push("buys in this zip"); }
  else if (t.region && (mk.regions.includes(t.region) || areaRegions.has(t.region))) { location = 22; reasons.push("buys in this region"); }

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
  if (mk.types?.includes(t.strategy)) { strategy = 10; if (t.strategy !== "mobile-home") reasons.push(t.strategy === "flip" ? "flips" : "builds"); }
  else if (mk.types?.length) strategy = 3;

  // The kind of house (shared/asset-type.js). A mobile home goes to the
  // buyers who told us they buy them — 1510 Maple Lane went to twenty-five
  // Kent flippers instead (2026-10-01). A stated no ("no park homes",
  // "mobile homes only") keeps them off it altogether (pickWave).
  const fit = buyerTypeFit(i, t.asset);
  let type = 0;
  if (fit.refuses) { type = -30; reasons.push(`won't take it (${fit.reason})`); }
  else if (fit.wants && t.asset?.type === "manufactured") { type = 30; reasons.push(fit.reason); }
  // Whether we know where they buy at all — a mobile home buyer with no area
  // on file is still a buyer; one whose areas are all elsewhere is not.
  const areaKnown = Boolean(mk.cities?.length || mk.regions?.length || rawAreas.length);

  // Their buy box on the rest — the kind of house, how much work, the lot.
  // A documented fit earns a little; a documented contradiction costs a lot
  // (a mismatched blast is what teaches a buyer to ignore us).
  let box = 0;
  const q = t.box || {};
  if (q.propertyTypes?.length || q.rehabAppetite || q.lotMin != null) {
    const m = matchBuybox(b, q);
    if (m.missed.length) { box = -20; reasons.push(`their buy box rules it out (${m.missed.join(", ")})`); }
    else if (m.matched.length) { box = 10; reasons.push("fits their buy box"); }
  }

  // Someone we are actually talking to (shared/talked-to.js) — Matt,
  // 2026-09-29: wave 2 on 3511 NE 153rd went by location tags alone, and the
  // buyers already in conversation scored no better than strangers.
  const talking = i.relationship === "talking" ? 8 : 0;
  if (talking) reasons.push("we're talking with them");

  let score = location + price + recency + tierPts + strategy + box + talking + type;
  if (spokenFor(i)) { score -= 10; reasons.push("committed to another live deal"); }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    parts: { location, price, recency, tier: tierPts, strategy, box, talking, type, typeRefused: fit.refuses, areaKnown },
    reasons,
  };
}

/**
 * pickWave(ranked, { wave, floor, exclude, manufactured, email }) → the buyers an automatic wave reaches
 *
 * `ranked` rows carry rank, rankParts, tier, phone, email, onLiveDeal, alreadyBlasted.
 * A buyer must buy where the deal is (city or region): tier and price alone
 * clear the floor, and 7034 S K St, Tacoma went to fifteen Snohomish and
 * Eastside VIPs that way (2026-09-28). Wave 1 is VIP and Active, VIPs first;
 * later waves take anyone at the floor, best fit first.
 *
 * A mobile home (`manufactured`) goes by who buys them instead: only buyers
 * who said they do, in any area unless every area they gave is elsewhere,
 * whatever their tier or score — the twenty who told us are mostly cold and
 * mostly have no area on file. A buyer who refuses the kind is never picked.
 * `email` lets a buyer with no phone in, to be emailed rather than texted.
 */
export function pickWave(ranked = [], { wave = 1, floor = 0, exclude = "blasted", manufactured = false, email = false } = {}) {
  const tierOrder = { vip: 0, active: 1, cold: 2 };
  const reachable = (i) => Boolean(i.phone || (email && i.email));
  const fits = manufactured
    ? (i) => (i.rankParts?.type || 0) > 0 && !(i.rankParts?.areaKnown && !(i.rankParts?.location > 0))
    : (i) => i.rank >= floor && (i.rankParts?.location || 0) > 0;
  return ranked
    .filter((i) => reachable(i) && !isBlockedBuyer(i) && !spokenFor(i) && !i.rankParts?.typeRefused)
    .filter(fits)
    .filter((i) => exclude !== "blasted" || !i.alreadyBlasted)
    .filter((i) => manufactured || wave !== 1 || i.tier === "vip" || i.tier === "active")
    .sort((a, b) => wave === 1 && !manufactured ? ((tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3)) || (b.rank - a.rank) : b.rank - a.rank);
}

// A blast draft that is going out, or about to.
const BLAST_DRAFT_LIVE = new Set(["draft", "scheduled", "sending"]);

/**
 * blastedTo(offer, { events, drafts }) → Set(contactId)
 *
 * Everyone this deal has gone to or is about to go to. That means:
 *   - a blast_sent recorded for the offer;
 *   - a GHL-workflow blast, which knows its tag and label but not its deal,
 *     matched on one of the deal's blast tags or its street;
 *   - anyone on one of the deal's app waves (deal.blasts[].contactIds);
 *   - a blast draft for the deal still waiting to go.
 * A wave that read only what had already sent would draft a wave-1 buyer
 * again while their first text was still waiting in the outbox.
 */
export function blastedTo(offer = {}, { events = [], drafts = [] } = {}) {
  const out = new Set();
  const tags = new Set((offer?.deal?.blastTags || []).map((t) => String(t || "").toLowerCase()).filter(Boolean));
  for (const e of events || []) {
    if (e?.type !== "blast_sent" || !e.contactId) continue;
    if (e.offerId) { if (e.offerId === offer?.id) out.add(e.contactId); continue; }
    const tag = String(e.data?.tag || "").toLowerCase();
    if ((tag && tags.has(tag)) || sameStreet(e.address || e.data?.label || "", offer?.address || "")) out.add(e.contactId);
  }
  for (const b of offer?.deal?.blasts || []) for (const id of b?.contactIds || []) if (id) out.add(id);
  for (const d of drafts || []) {
    if (d?.contactId && d.outbound?.kind === "blast_open" && d.outbound?.offerId === offer?.id && BLAST_DRAFT_LIVE.has(d.status)) out.add(d.contactId);
  }
  return out;
}

/** engagementFromEvents(events) → Map(contactId → { blasts, viewed, evaluating, committed, passed, talks, lastEngagedAt }) */
export function engagementFromEvents(events = []) {
  const out = new Map();
  for (const ev of events) {
    if (!ev?.contactId) continue;
    const e = out.get(ev.contactId) || { blasts: 0, viewed: 0, evaluating: 0, committed: 0, passed: 0, talks: 0, lastEngagedAt: "" };
    if (ev.type === "blast_sent") e.blasts++;
    // A logged call, or a fact learned from them: evidence of a conversation,
    // not of a deal, so it leaves lastEngagedAt (the deal clock) alone.
    else if (TALK_EVENT_TYPES.includes(ev.type)) { if (isTalkEvent(ev)) e.talks++; }
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
