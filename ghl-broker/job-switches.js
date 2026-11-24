// job-switches.js — which of the switchboard's jobs (shared/line.js
// LINE_JOBS) are switched on, read from the saved settings the same way each
// job reads its own switch.
//
// lineJobs only calls a job late while its switch is on (2026-11-09: a job
// that quietly stopped running was never reported; a job switched off must
// never be). A job left out of this map has no word on its switch and is
// never called late; its failed runs are still reported.
//
// 2026-11-23 audit (AH-5): the jobs that bring in business are here too —
// the outreach sweep, the follow-up sweep, both check-ins, price watch, the
// delivery check, the daytime pass, the buyer waves, the tier check, the lot
// finder and the gatekeeper line. A job whose runner claims its day whatever
// its settings (price watch, tier check) is always on.
//
// Pure: settings in, { name: boolean } out.

import { normalizeGhlStages } from "./shared/ghl-stages.js";
import { normalizePricingV2 } from "./shared/pricing-v2-settings.js";
import { normalizeDesk } from "./shared/call-list.js";
import { ghlCallsOn } from "./shared/ghl-calls.js";
import { normalizeSlack, slackOn } from "./shared/slack-notify.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { normalizeAgentPulse } from "./shared/agent-pulse.js";
import { normalizeBuyerPulse } from "./shared/buyer-pulse.js";
import { normalizeLotFinder } from "./shared/lot-finder.js";
import { normalizeGatekeepers } from "./shared/gatekeeper.js";
import { normalizeOutreachAutopilot } from "./outreach-sweep.js";

// The follow-up sweep's own test (follow-up-sweep.js maybeStartFollowUpSweep):
// a key, the Conversation AI on, and a ladder or one of the two emails to run.
function followUpOn(saved, ai, hasKey) {
  if (!hasKey || !ai.enabled) return false;
  const anyLadder = ["agent", "investor"].some((p) => {
    const fu = ai.parties?.[p]?.followUp;
    return fu?.enabled && (Object.values(fu.ladders || {}).some((l) => l.enabled && l.steps?.length) || fu.secondLook?.enabled);
  });
  const oa = normalizeOutreachAutopilot(saved?.outreachAutopilot);
  return Boolean(anyLadder || oa.introEmail.enabled || oa.checkInEmail.enabled);
}

export function jobSwitches(saved = {}) {
  const stagesOn = normalizeGhlStages(saved?.ghlStages).mode === "on";
  const pv2 = normalizePricingV2(saved?.pricingV2);
  const ai = normalizeConversationAi(saved?.conversationAi || {});
  const hasKey = Boolean(String(saved?.aiApiKey || "").trim());
  const oa = normalizeOutreachAutopilot(saved?.outreachAutopilot);
  const lots = normalizeLotFinder(saved?.lotFinder);
  return {
    // needs-matt.js maybeRunNeedsMatt and tier-check.js syncChangedCards.
    needsMatt: stagesOn,
    cardSync: stagesOn,
    // ghl-calls.js maybeRunGhlCalls.
    ghlCalls: ghlCallsOn(normalizeDesk(saved?.desk).ghlCalls),
    // price-scorecard.js and thread-reads.js.
    priceScorecard: Boolean(pv2.shadow),
    threadReads: Boolean(pv2.reads) && hasKey,
    // hand-reply-sweep.js reads unless the Conversation AI is switched off.
    handReplies: saved?.conversationAi?.enabled !== false,
    slack: slackOn(normalizeSlack(saved?.slack), saved?.slackBotToken),
    // conversation-audit.js and coach.js.
    conversationAudit: Boolean(ai.nightlyAudit?.enabled),
    coach: Boolean(ai.coach?.enabled) && hasKey,
    // outreach-sweep.js maybeStartOutreachSweep: the toggle and a RentCast key.
    outreach: oa.enabled && Boolean(String(saved?.rentcastApiKey || "").trim()),
    followUp: followUpOn(saved, ai, hasKey),
    // agent-pulse.js / buyer-pulse.js: their own toggle, with the Conversation AI on.
    agentPulse: normalizeAgentPulse(saved?.outreachAutopilot?.pulse).enabled && Boolean(ai.enabled),
    buyerPulse: normalizeBuyerPulse(saved?.dispoAutopilot?.pulse).enabled && Boolean(ai.enabled),
    // price-watch.js and tier-check.js claim their day whatever is saved.
    priceWatch: true,
    tierCheck: true,
    // delivery-watch.js: conversationAi.deliveryWatch.
    deliveryWatch: Boolean(ai.deliveryWatch?.enabled),
    // conversation-audit.js maybeRunDaytimeDriver: driver.daytime, with the AI on.
    daytimeDriver: Boolean(ai.enabled) && Boolean(ai.driver?.daytime?.enabled),
    // dispo-autopilot.js maybeStartDispoSweep: normalizeDispoAutopilot reads
    // autoBlastOnPromote as `=== true` (read here, not imported: that module
    // reaches the reply agent).
    dispo: saved?.dispoAutopilot?.autoBlastOnPromote === true,
    // lot-finder.js and gatekeeper-sweep.js.
    lotFinder: lots.enabled && lots.pockets.some((p) => p.enabled),
    gatekeepers: normalizeGatekeepers(saved?.outreachAutopilot?.gatekeepers).enabled,
  };
}
