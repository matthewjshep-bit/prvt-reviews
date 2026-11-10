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
});

test("each switch follows its job's own setting", () => {
  const s = jobSwitches({
    aiApiKey: "sk-test", ghlStages: { mode: "on" }, pricingV2: { shadow: true, reads: true },
    desk: { ghlCalls: { enabled: true, workflowId: "wf-calls-1" } },
    slack: { enabled: true }, slackBotToken: "xoxb-test",
    conversationAi: { enabled: false, coach: { enabled: true }, nightlyAudit: { enabled: false } },
  });
  assert.deepEqual(s, { needsMatt: true, cardSync: true, ghlCalls: true, priceScorecard: true, threadReads: true, handReplies: false, slack: true, conversationAudit: false, coach: true });
  assert.equal(jobSwitches({ pricingV2: { reads: true } }).threadReads, false, "no key, the reads don't run");
  assert.equal(jobSwitches({ desk: { ghlCalls: { enabled: true } } }).ghlCalls, false, "no workflow, no calls");
});
