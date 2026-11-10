// agent-focus.js — one agent, one house at a time, for every door.
//
// The rules are pure and live in shared/agent-focus.js. The follow-up sweep
// asks them before it claims a rung; this is the same question for the
// texts started anywhere else — the nightly audit's nudges, the agent
// check-in — so nothing texts an agent around them. startProactive asks it.

import { focusOf, focusHolds, machineTexts, spacingHolds, callOwedHolds, UNPROMPTED_AGENT_KINDS, OFF_FOCUS_KINDS, CALL_WAIT_KINDS } from "./shared/agent-focus.js";
import { CALL_OWED_EVENT_TYPES, OWED_WINDOW_DAYS } from "./shared/promise-owed.js";
import { threadHealth, HOUSE_OVER_REASONS } from "./shared/thread-health.js";
import { openOfferIdle, AGENT_PULSE_EVENT_TYPES } from "./shared/agent-pulse.js";
import { withBotEvents } from "./bot-hold.js";

// The timeline window the check-in's planner reads (ghl-broker/agent-pulse.js).
const EVENTS_DAYS = 130;

/**
 * agentTurnReason({ store, locationId, contactId, kind, address, config, now })
 *   → reason | null
 *
 * Why this unprompted text to an agent waits: another house is live, or we
 * texted them too recently, or they've had the week's texts. null: it may go.
 * A read that fails says nothing — the sweep's own checks still ran.
 */
export async function agentTurnReason({ store, locationId, contactId, kind = "", address = "", config = {}, now = Date.now() }) {
  if (!contactId || !UNPROMPTED_AGENT_KINDS.has(kind)) return null;
  const fu = config?.parties?.agent?.followUp || {};
  const [drafts, offers] = await Promise.all([
    typeof store?.listReplyDrafts === "function" ? store.listReplyDrafts(locationId, { contactId, limit: 20 }).catch(() => []) : [],
    OFF_FOCUS_KINDS.has(kind) && typeof store?.listOffers === "function"
      ? store.listOffers(locationId, { contactId, limit: 200, lean: true }).catch(() => [])
      : [],
  ]);
  let focus = OFF_FOCUS_KINDS.has(kind) ? focusOf(offers || [], { contactId }) : null;
  // A live offer they said no to, or one with nothing coming on it and no
  // text either way for a week, is not what we talk to them about any more:
  // the check-in asks for their next one. The planner's own rule
  // (shared/agent-pulse.js openOfferIdle), so the door agrees with the plan.
  if (focus && kind === "agent_pulse") {
    const windowed = typeof store?.listContactEvents === "function"
      ? await store.listContactEvents(locationId, contactId, { types: AGENT_PULSE_EVENT_TYPES, since: new Date(now - EVENTS_DAYS * 86400000).toISOString(), limit: 300 }).catch(() => [])
      : [];
    const events = await withBotEvents({ store, locationId, contactId, events: windowed || [] });
    const h = threadHealth({ offer: focus, drafts: drafts || [], now });
    if ((!h.drive && HOUSE_OVER_REASONS.has(h.reason)) || openOfferIdle({ offer: focus, drafts: drafts || [], events, config, now })) focus = null;
  }
  return focusHolds({ kind, address, focus })
    || spacingHolds({ kind, sent: machineTexts(drafts || []), now, minHours: fu.minHoursBetween, perWeek: fu.maxPerContactPerWeek })
    || await callOwedReason({ store, locationId, contactId, kind, now });
}

/**
 * callOwedReason({ store, locationId, contactId, kind, now }) → reason | null
 *
 * A call we owe them (booked, missed or promised) goes first: the check-in
 * and the cold ladder's repeat rungs wait (shared/agent-focus.js
 * callOwedHolds, 2026-11-09). One small read of their call events, only for
 * those kinds. A read that fails holds nothing back.
 */
export async function callOwedReason({ store, locationId, contactId, kind = "", now = Date.now() }) {
  if (!contactId || !CALL_WAIT_KINDS.has(kind) || typeof store?.listContactEvents !== "function") return null;
  const events = await store.listContactEvents(locationId, contactId, {
    types: [...CALL_OWED_EVENT_TYPES], since: new Date(now - OWED_WINDOW_DAYS * 86400000).toISOString(), limit: 300,
  }).catch(() => []);
  return callOwedHolds({ kind, events: events || [], now });
}
