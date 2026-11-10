// job-switches.js — which of the switchboard's jobs (shared/line.js
// LINE_JOBS) are switched on, read from the saved settings the same way each
// job reads its own switch.
//
// lineJobs only calls a job late while its switch is on (2026-11-09: a job
// that quietly stopped running was never reported; a job switched off must
// never be). A job left out of this map has no word on its switch and is
// never called late; its failed runs are still reported.
//
// Pure: settings in, { name: boolean } out.

import { normalizeGhlStages } from "./shared/ghl-stages.js";
import { normalizePricingV2 } from "./shared/pricing-v2-settings.js";
import { normalizeDesk } from "./shared/call-list.js";
import { ghlCallsOn } from "./shared/ghl-calls.js";
import { normalizeSlack, slackOn } from "./shared/slack-notify.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";

export function jobSwitches(saved = {}) {
  const stagesOn = normalizeGhlStages(saved?.ghlStages).mode === "on";
  const pv2 = normalizePricingV2(saved?.pricingV2);
  const ai = normalizeConversationAi(saved?.conversationAi || {});
  const hasKey = Boolean(String(saved?.aiApiKey || "").trim());
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
  };
}
