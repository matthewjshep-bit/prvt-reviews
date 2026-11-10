// pulse-plans.js — one check-in plan a location, shared by the pages
// (2026-11-09).
//
// Reports → Line, Reports → Follow-up and the agent check-in page
// (GET /api/outreach/pulse) each ran planAgentPulse on every uncached open,
// and Line and Follow-up ran planBuyerPulse too. Each planner reads months
// of events; the 11-09 crash came right after one of them. Now the three
// share one plan of each, kept 90 seconds, computed once behind the heavy
// gate (read-memo.js), and a settings save starts a new one.
//
// The send jobs (agent-pulse.js runAgentPulse, buyer-pulse.js) never read
// from here: what goes out is planned fresh, at the moment it goes.

import { planAgentPulse, pulseWorkflows, pulseTierCards } from "./agent-pulse.js";
import { planBuyerPulse } from "./buyer-pulse.js";
import { createMemo, heavyGate, settingsSig } from "./read-memo.js";

export const PULSE_PLAN_MS = 90000;
const agentPlans = createMemo({ ttlMs: PULSE_PLAN_MS, gate: heavyGate });
const buyerPlans = createMemo({ ttlMs: PULSE_PLAN_MS, gate: heavyGate });

/**
 * agentPulsePlanFor({ store, locationId, saved, client, now, deps }) → planAgentPulse() output
 *
 * With a GHL client (or deps.listWorkflows / deps.tierCards) the plan reads
 * the tier cards and the drips the way the check-in run does; without one
 * (the nightly audit) it plans without them, and is kept apart.
 */
export function agentPulsePlanFor({ store, locationId, saved = {}, client = null, now = Date.now(), deps = {} }) {
  const withGhl = Boolean(client || typeof deps.listWorkflows === "function" || typeof deps.tierCards === "function");
  // Its own key, so the audit's plan never pushes out the one the pages share.
  return agentPlans.get(`${locationId}|${withGhl ? "ghl" : "local"}`, async () => planAgentPulse({
    locationId, saved, store, now,
    workflows: withGhl ? await pulseWorkflows(client, locationId, deps).catch(() => null) : null,
    tierCards: withGhl ? await pulseTierCards(client, locationId, deps).catch(() => null) : null,
  }), { sig: `${settingsSig(saved)}:${withGhl ? "ghl" : "local"}`, now });
}

/** buyerPulsePlanFor({ store, locationId, saved, now, book }) → planBuyerPulse() output, or null with no book */
export function buyerPulsePlanFor({ store, locationId, saved = {}, now = Date.now(), book = null }) {
  if (typeof book !== "function") return Promise.resolve(null);
  return buyerPlans.get(locationId, () => planBuyerPulse({ locationId, saved, store, now, deps: { book } }), { sig: settingsSig(saved), now });
}

/** _resetPulsePlans() — tests. */
export function _resetPulsePlans() { agentPlans.clear(); buyerPlans.clear(); }
