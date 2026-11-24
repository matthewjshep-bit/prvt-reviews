// job-switches.test.mjs — which switchboard jobs are switched on, read the
// way each job reads its own switch. Only a switched-on job can be late.

import test from "node:test";
import assert from "node:assert/strict";
import { jobSwitches } from "./job-switches.js";

test("with nothing saved, the switched-off jobs read off and can never be called late", () => {
  const s = jobSwitches({});
  for (const name of ["needsMatt", "cardSync", "ghlCalls", "priceScorecard", "threadReads", "slack", "coach"]) assert.equal(s[name], false, name);
  assert.equal(s.handReplies, true, "the hand-reply read runs unless the Conversation AI is off");
  assert.equal(s.conversationAudit, true, "the nightly audit is on by default");
  assert.equal(s.laneBreaker, true, "the lane breaker is on by default: it only stops sends");
  assert.equal(jobSwitches({ conversationAi: { laneBreaker: { enabled: false } } }).laneBreaker, false);
});

test("each switch follows its job's own setting", () => {
  const s = jobSwitches({
    aiApiKey: "sk-test", ghlStages: { mode: "on" }, pricingV2: { shadow: true, reads: true },
    desk: { ghlCalls: { enabled: true, workflowId: "wf-calls-1" } },
    slack: { enabled: true }, slackBotToken: "xoxb-test",
    conversationAi: { enabled: false, coach: { enabled: true }, nightlyAudit: { enabled: false } },
  });
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  assert.deepEqual(pick(s, ["needsMatt", "cardSync", "ghlCalls", "priceScorecard", "threadReads", "handReplies", "slack", "conversationAudit", "coach", "laneBreaker"]),
    { needsMatt: true, cardSync: true, ghlCalls: true, priceScorecard: true, threadReads: true, handReplies: false, slack: true, conversationAudit: false, coach: true, laneBreaker: true });
  assert.equal(jobSwitches({ pricingV2: { reads: true } }).threadReads, false, "no key, the reads don't run");
  assert.equal(jobSwitches({ desk: { ghlCalls: { enabled: true } } }).ghlCalls, false, "no workflow, no calls");
});

// 2026-11-23 audit (AH-5): the jobs that bring in business stopped with no
// "hasn't run" line, because they had no word on their switch.
test("the business jobs read their switches the way their runners do", () => {
  const off = jobSwitches({});
  for (const name of ["outreach", "followUp", "agentPulse", "buyerPulse", "deliveryWatch", "daytimeDriver", "dispo", "lotFinder", "gatekeepers"]) assert.equal(off[name], false, name);
  assert.equal(off.priceWatch, true, "price watch claims its day whatever is saved");
  assert.equal(off.tierCheck, true, "so does the tier check");
  const on = jobSwitches({
    aiApiKey: "sk-test", rentcastApiKey: "rc-test",
    outreachAutopilot: { enabled: true, pulse: { enabled: true }, introEmail: { enabled: true }, gatekeepers: { enabled: true } },
    dispoAutopilot: { autoBlastOnPromote: true, pulse: { enabled: true } },
    lotFinder: { enabled: true, pockets: [{ id: "p1", name: "Test pocket", lat: 47.6, lng: -122.2 }] },
    conversationAi: { enabled: true, deliveryWatch: { enabled: true }, driver: { daytime: { enabled: true } } },
  });
  for (const name of ["outreach", "followUp", "agentPulse", "buyerPulse", "deliveryWatch", "daytimeDriver", "dispo", "lotFinder", "gatekeepers"]) assert.equal(on[name], true, name);
  assert.equal(jobSwitches({ lotFinder: { enabled: true, pockets: [{ name: "Test pocket", enabled: false }] } }).lotFinder, false, "no pocket switched on, no run");
  assert.equal(jobSwitches({ outreachAutopilot: { enabled: true } }).outreach, false, "no RentCast key, the sweep never starts");
  assert.equal(jobSwitches({ outreachAutopilot: { pulse: { enabled: true } }, conversationAi: { enabled: false } }).agentPulse, false, "the check-in waits on the Conversation AI");
  assert.equal(jobSwitches({ dispoAutopilot: { autoBlastOnPromote: "yes" } }).dispo, false, "only a saved true");
});
