// line.js — the Line view's reads. The arithmetic is shared/line.js.
//
// Every read here is one a scheduler already makes: the offer book with its
// next follow-ups (next-follow-up.js), the two pulse planners, the Today
// pipeline's deal rows, the job cursors and the app errors. So a leak on the
// Line is exactly what the machine would (or wouldn't) do next.
//
// Two callers: GET /api/dashboard/line (with the Flow stations) and the
// nightly audit (leaks only, for "Leaks last night" on Today).

import { buildLine } from "./shared/line.js";
import { buildFlow } from "./shared/flow.js";
import { buildPipeline } from "./shared/pipeline.js";
import { annotateCurrent } from "./shared/current-offer.js";
import { dealScorecard } from "./shared/post-mortem.js";
import { effectiveSettings } from "./shared/offer-calc.js";
import { attachNextFollowUps } from "./next-follow-up.js";
import { planAgentPulse } from "./agent-pulse.js";
import { planBuyerPulse } from "./buyer-pulse.js";
import { conversationConfig } from "./reply-agent.js";
import { allEventsSince } from "./contact-events.js";
import { isDealRoom } from "./routes/dataroom.js";
import { leadSourcesFor, LEAD_EVENT_TYPES } from "./shared/lead-source.js";

const DAY_MS = 86400000;
const iso = (t) => new Date(t).toISOString();
// The deal rows read blasts and package opens off the timeline.
const DEAL_EVENT_TYPES = ["blast_sent", "dataroom_viewed", "dataroom_sent", "investor_evaluating", "investor_committed", "investor_passed", "deal_promoted", "deal_stage"];

/**
 * dealRoomIds({ store, locationId, offers }) → offer ids with a live buyer package
 *
 * For the "no buyer package" row. One small read per deal under contract
 * (there are only ever a few); a read that fails counts as having one, so
 * the row never guesses.
 */
export async function dealRoomIds({ store, locationId, offers = [] }) {
  const live = offers.filter((o) => o?.deal?.stage === "under_contract");
  const ids = await Promise.all(live.map(async (o) => {
    try { return (await store.listDatarooms(locationId, { offerId: o.id, limit: 10 })).some(isDealRoom) ? o.id : null; }
    catch { return o.id; }
  }));
  return ids.filter(Boolean);
}

/**
 * lineFor({ store, locationId, saved, now, flow, buyerBook })
 *   → buildLine() output, plus { eventsTruncated }
 *
 *   flow       { eventTypes, jobs } to count the stations (the route), or
 *              null to skip them (the audit wants leaks only)
 *   buyerBook  (locationId) → the scored buyer book, for the buyer pulse
 *              plan; omitted, the buyer side reports nothing
 *
 * Each read that fails leaves its part empty; the rest still reports.
 */
export async function lineFor({ store, locationId, saved = {}, now = Date.now(), flow = null, buyerBook = null }) {
  const settings = effectiveSettings(saved || {});
  const config = conversationConfig(saved || {});
  const since30 = iso(now - 30 * DAY_MS);
  const [offersRaw, dealDocs, openDrafts, dealEvents, cursors, errors, flowRead, flowDrafts, hooks, leadEvents] = await Promise.all([
    store.listOffers(locationId, { limit: 5000, lean: true }).catch(() => []),
    // The whole deal documents, for what buyers paid: the lean list above is
    // trimmed in SQL on Postgres and carries no ARV or repairs.
    store.listDeals(locationId, { limit: 500 }).catch(() => []),
    store.listReplyDrafts(locationId, { status: ["draft", "scheduled"], limit: 1000 }).catch(() => []),
    store.listContactEventsSince(locationId, iso(now - 90 * DAY_MS), { types: DEAL_EVENT_TYPES, limit: 20000 }).catch(() => []),
    typeof store.listJobCursors === "function" ? store.listJobCursors(locationId).catch(() => []) : [],
    typeof store.listAppErrorsSince === "function" ? store.listAppErrorsSince(locationId, iso(now - 7 * DAY_MS), { limit: 500 }).catch(() => []) : [],
    flow ? allEventsSince(store, locationId, since30, { types: flow.eventTypes }).catch(() => ({ events: [], truncated: false })) : null,
    flow ? store.listReplyDrafts(locationId, { since: since30, limit: 4000 }).catch(() => []) : [],
    // How each house came to us: every agent's opening listing, and our
    // texts that named a house or asked for the next one (a year back).
    typeof store.listOutreachHooks === "function" ? store.listOutreachHooks(locationId).catch(() => []) : [],
    store.listContactEventsSince(locationId, iso(now - 365 * DAY_MS), { types: LEAD_EVENT_TYPES, limit: 50000 }).catch(() => []),
  ]);

  // Offers: the current row on each house, with the one answer the Offers
  // tab shows for what comes next.
  const leads = leadSourcesFor({ offers: offersRaw, hooks, events: leadEvents });
  const offers = annotateCurrent(offersRaw.map((o) => (leads.has(o.id) ? { ...o, leadSource: leads.get(o.id) } : o)));
  await attachNextFollowUps({ store, locationId, saved, offers, now }).catch(() => {});

  // Stations: Flow's own counts, for the last week and the last month.
  let week = [], month = [];
  if (flowRead) {
    const events = flowRead.events || [];
    week = buildFlow({ offers, events, drafts: flowDrafts, jobs: flow.jobs || [], now, windowStartMs: now - 7 * DAY_MS, windowEndMs: now, feedLimit: 0 }).stages;
    month = buildFlow({ offers, events, drafts: flowDrafts, jobs: flow.jobs || [], now, windowStartMs: now - 30 * DAY_MS, windowEndMs: now, feedLimit: 0 }).stages;
  }

  // Deals: the Today rows that say a live deal isn't moving.
  const dealRooms = await dealRoomIds({ store, locationId, offers: offersRaw }).catch(() => null);
  let actions = [];
  try { actions = buildPipeline({ offers, drafts: openDrafts, events: dealEvents, jobs: [], config, now, dealRooms }).actions || []; } catch { actions = []; }

  // The two clocks that keep people warm.
  const [agentPlan, buyerPlan] = await Promise.all([
    planAgentPulse({ locationId, saved, store, now }).catch(() => null),
    buyerBook ? planBuyerPulse({ locationId, saved, store, now, deps: { book: buyerBook } }).catch(() => null) : null,
  ]);

  // What buyers paid, all-in, on the deals that ended. From the whole deal,
  // the way Lessons reads it, so the two can't disagree.
  const scorecards = [];
  for (const o of dealDocs) {
    const deal = o?.deal;
    if (!deal) continue;
    if (deal.stage === "fell_through") scorecards.push(deal.postMortem?.scorecard || dealScorecard({ offer: o, settings, feedback: deal.feedbackPackage || null, now }));
    else if (["closed", "assigned", "buyer_found"].includes(deal.stage)) scorecards.push(dealScorecard({ offer: o, settings, feedback: deal.feedbackPackage || null, now }));
  }

  const line = buildLine({ week, month, offers, actions, agentPlan, buyerPlan, cursors, errors, scorecards, settings, now });
  return { ...line, eventsTruncated: Boolean(flowRead?.truncated) };
}

/** leakSummary(line) → the few numbers the nightly audit keeps for Today. */
export function leakSummary(line) {
  if (!line) return null;
  const l = line.leaks || {};
  return {
    total: line.leakTotal, backlog: line.backlog || 0,
    offersNothing: l.offers?.nothing || 0, offersMissed: l.offers?.missed || 0, waitingOnYou: l.offers?.waitingOnYou || 0,
    // Due while their check-in is off (a leak) / queued behind today's seats (backlog).
    agentsOff: l.agents?.dueWhileOff || 0, agentsQueued: l.agents?.dueNoSeat || 0,
    buyersOff: l.buyers?.dueWhileOff || 0, buyersQueued: l.buyers?.dueNoSeat || 0,
    deals: l.deals?.total || 0,
  };
}
