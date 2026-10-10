// agent-focus.js — one agent, one house at a time, for every door.
//
// The rules are pure and live in shared/agent-focus.js. The follow-up sweep
// asks them before it claims a rung; this is the same question for the
// texts started anywhere else — the nightly audit's nudges, the agent
// check-in — so nothing texts an agent around them. startProactive asks it.

import { focusOf, focusHolds, machineTexts, spacingHolds, UNPROMPTED_AGENT_KINDS, OFF_FOCUS_KINDS } from "./shared/agent-focus.js";
import { threadHealth, HOUSE_OVER_REASONS } from "./shared/thread-health.js";

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
  // A live offer they said no to, that the machine has stopped working, is
  // not what we talk to them about any more: the check-in asks for their
  // next one (shared/agent-pulse.js openOfferIdle).
  if (focus && kind === "agent_pulse") {
    const h = threadHealth({ offer: focus, drafts: drafts || [], now });
    if (!h.drive && HOUSE_OVER_REASONS.has(h.reason)) focus = null;
  }
  return focusHolds({ kind, address, focus })
    || spacingHolds({ kind, sent: machineTexts(drafts || []), now, minHours: fu.minHoursBetween, perWeek: fu.maxPerContactPerWeek });
}
