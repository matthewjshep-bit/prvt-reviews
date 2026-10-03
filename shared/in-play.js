// in-play.js — every agent with something live, one row each.
//
// Matt, 2026-10-02: every day he walked GHL's Acquisitions → Tier 1 stage to
// call agents, read and text by hand, check nothing had dropped, and move
// cards — and then walked the Offers tab for the sent, hot and countered
// offers that "need spurring along". Tier 1 was stale (about a third of its
// agents had nothing live in the app), and the Offers tab is per house, not
// per person. This is the per-person view the app already knows enough to
// draw: the agent, where their best house stands, ours against theirs on
// each, when anyone last spoke, what the machine does next, and whether
// anything has fallen off (shared/line.js offerLeaks — a leak sorts first).
//
// Pure. Takes the Offers list's lean rows with `activity` and `next`.

import { annotateCurrent } from "./current-offer.js";
import { effectiveStatus, isHot, needsAiReview, aiHoldReasons, LIVE_DEAL_STAGES, DEAD_STATUSES } from "./offer-status.js";
import { offerLeaks } from "./line.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

// Strongest first: an agent's row takes the stage of their best house.
export const IN_PLAY_STAGES = [
  { key: "deal",      label: "Deal" },
  { key: "hot",       label: "Hot" },
  { key: "countered", label: "Countered" },
  { key: "sent",      label: "Offer out" },
  { key: "floated",   label: "Floated" },
  { key: "ready",     label: "Not sent" },
  { key: "held",      label: "Held underwrite" },
  { key: "recent",    label: "Passed lately" },
];
const RANK = Object.fromEntries(IN_PLAY_STAGES.map((s, i) => [s.key, i]));
// Worst first: nothing scheduled, a clock that's late, then waiting on you.
const LEAK_RANK = { nothing: 0, missed: 1, waiting_on_you: 2 };
export const LEAK_LABEL = { nothing: "nothing scheduled", missed: "a follow-up is late", waiting_on_you: "waiting on you" };

/** stageOf(offer) → a stage key, or null for an offer that isn't in play. */
export function stageOf(o) {
  if (!o) return null;
  if (o.deal) return LIVE_DEAL_STAGES.has(o.deal.stage) ? "deal" : null;
  const st = effectiveStatus(o);
  if (st === "draft") return needsAiReview(o) && aiHoldReasons(o).length ? "held" : null;
  if (isHot(o)) return "hot";
  if (st === "countered") return "countered";
  if (st === "sent") return "sent";
  if (st === "new") return o.proactive?.takeCheckAt || o.proactive?.realmCheckAt ? "floated" : "ready";
  if (DEAD_STATUSES.has(st)) return "recent";
  return null;
}

/**
 * buildInPlay(offers, { now, recentDays }) → rows, one per agent
 *
 *   { contactId, contactName, stage, houses: [{ offerId, address, ours, theirs, stage, next, leak }],
 *     lead (the best house's offer row), lastActivity, next, leak, leakLabel }
 *
 * Only each house's current offer counts (current-offer.js). A house passed
 * on more than `recentDays` ago is history, not in play. Sorted: leaks
 * first, then by stage, then the freshest conversation.
 */
export function buildInPlay(offers = [], { now = Date.now(), recentDays = 30 } = {}) {
  const current = annotateCurrent((offers || []).filter(Boolean)).filter((o) => !o.supersededBy);
  const by = new Map();
  for (const o of current) {
    if (!o.contactId) continue;
    const stage = stageOf(o);
    if (!stage) continue;
    if (stage === "recent") {
      const t = ms(o.statusAt) ?? ms(o.createdAt);
      if (t == null || now - t > recentDays * DAY_MS) continue;
    }
    const leak = stage === "recent" || stage === "held" ? null : offerLeaks([o], { now }).rows[0]?.leak || null;
    const theirs = Number(o.counter?.amount) || 0;
    const house = { offerId: o.id, address: o.address || "", ours: Number(o.cashAmount) || 0, theirs: theirs > (Number(o.cashAmount) || 0) ? theirs : 0, stage, next: o.nextFollowUp || null, leak, offer: o };
    if (!by.has(o.contactId)) by.set(o.contactId, []);
    by.get(o.contactId).push(house);
  }
  const rows = [];
  for (const [contactId, houses] of by) {
    houses.sort((a, b) => RANK[a.stage] - RANK[b.stage]);
    const lead = houses[0];
    const leaks = houses.map((h) => h.leak).filter(Boolean).sort((a, b) => LEAK_RANK[a] - LEAK_RANK[b]);
    const acts = houses.map((h) => h.offer.lastActivity).filter((a) => a?.at).sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
    rows.push({
      contactId, contactName: houses.map((h) => h.offer.contactName).find(Boolean) || "",
      stage: lead.stage, lead: lead.offer, houses: houses.map(({ offer, ...h }) => h),
      lastActivity: acts[0] || null, next: lead.next, leak: leaks[0] || null, leakLabel: leaks[0] ? LEAK_LABEL[leaks[0]] : "",
    });
  }
  return rows.sort((a, b) => (a.leak ? LEAK_RANK[a.leak] : 9) - (b.leak ? LEAK_RANK[b.leak] : 9)
    || RANK[a.stage] - RANK[b.stage]
    || (ms(b.lastActivity?.at) ?? 0) - (ms(a.lastActivity?.at) ?? 0));
}

/** inPlayCounts(rows) → { all, live, leaks, yours, byStage } for the chips. */
export function inPlayCounts(rows = []) {
  const byStage = Object.fromEntries(IN_PLAY_STAGES.map((s) => [s.key, 0]));
  for (const r of rows) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
  return {
    all: rows.length,
    live: rows.filter((r) => r.stage !== "recent").length,
    leaks: rows.filter((r) => r.leak === "nothing" || r.leak === "missed").length,
    yours: rows.filter((r) => r.leak === "waiting_on_you").length,
    byStage,
  };
}
