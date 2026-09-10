import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTONOMY_MODES, autonomyPlan, applyAutonomy, detectAutonomy, autonomyFingerprint, autonomyDiff,
} from "./autonomy.js";
import { starterConfig, autoEligible, normalizeConversationAi } from "./conversation-ai.js";
import { kindsFor } from "./follow-up.js";

const starter = () => ({
  conversationAi: starterConfig({ signer: "Matt", workflows: [] }),
  outreachAutopilot: { enabled: false, dailyCap: 7, firstTouch: "app" },
  dispoAutopilot: { sendWith: "app", spreadSec: 90, autoBlastCount: 10 },
  apifyToken: "keep-me",
});

test("every mode round-trips: apply it, and the detector names it", () => {
  for (const mode of AUTONOMY_MODES) {
    const out = applyAutonomy(starter(), mode);
    assert.equal(detectAutonomy(out), mode, mode);
  }
});

test("applying a mode keeps everything that is not a switch", () => {
  const before = starter();
  const out = applyAutonomy(before, "normal");
  assert.equal(out.apifyToken, "keep-me");
  assert.equal(out.outreachAutopilot.dailyCap, 7);
  assert.equal(out.dispoAutopilot.spreadSec, 90);
  assert.equal(out.dispoAutopilot.autoBlastCount, 10);
  const a = out.conversationAi.parties.agent;
  assert.equal(a.instructions, before.conversationAi.parties.agent.instructions);
  assert.deepEqual(Object.keys(a.intentRules), Object.keys(before.conversationAi.parties.agent.intentRules));
  // Ladder days survive; only the enabled bit moves.
  assert.deepEqual(a.followUp.ladders.offer_nudge.steps, [3, 7, 14]);
  assert.equal(a.followUp.ladders.offer_nudge.enabled, true);
});

test("off switches the bot off and stops the sweeps and waves", () => {
  const out = applyAutonomy(applyAutonomy(starter(), "full"), "off");
  assert.equal(out.conversationAi.enabled, false);
  assert.equal(out.outreachAutopilot.enabled, false);
  assert.equal(out.dispoAutopilot.autoBlastOnPromote, false);
  assert.equal(out.dispoAutopilot.autoInvite, false);
  assert.equal(out.dispoAutopilot.paperworkOnCommit, false);
  assert.equal(detectAutonomy(out), "off");
});

test("cautious: conversational replies only, floats and nudges draft, holds on needs-human", () => {
  const out = applyAutonomy(starter(), "cautious");
  const c = out.conversationAi;
  assert.equal(c.enabled, true);
  assert.equal(c.autoSend.holdOnNeedsHuman, true);
  assert.equal(c.autoSend.minConfidence, "high");
  const agent = c.parties.agent.autoSend.intents;
  assert.ok(agent.includes("question"));
  assert.ok(agent.includes("deal_available"));
  for (const i of ["realm_check", "take_check", "offer_nudge", "outreach_nudge", "outreach_open", "realm_yes"]) {
    assert.ok(!agent.includes(i), `${i} must draft in cautious`);
  }
  assert.ok(!c.parties.investor.autoSend.intents.includes("blast_open"));
  // The floats are on (so they draft) but the ladders are not.
  assert.equal(c.parties.agent.realmCheck.enabled, true);
  assert.equal(c.parties.agent.followUp.enabled, false);
  assert.equal(c.parties.agent.sendOffer.onClearUnderwrite, false);
  assert.equal(c.parties.agent.counterBand.enabled, false);
  assert.equal(out.outreachAutopilot.enabled, false);
});

test("normal: everything the gates allow, but the offer, counters and invites still ask", () => {
  const out = applyAutonomy(starter(), "normal");
  const c = out.conversationAi;
  assert.deepEqual([...c.parties.agent.autoSend.intents].sort(), [...autoEligible("agent")].sort());
  assert.deepEqual([...c.parties.investor.autoSend.intents].sort(), [...autoEligible("investor")].sort());
  for (const party of ["agent", "investor"]) {
    assert.equal(c.parties[party].followUp.enabled, true);
    for (const k of kindsFor(party)) assert.equal(c.parties[party].followUp.ladders[k].enabled, true, k);
  }
  assert.equal(c.parties.agent.requote.enabled, true);
  assert.equal(c.parties.agent.outreach.enabled, true);
  assert.equal(c.parties.agent.counterBand.enabled, false);
  assert.equal(c.parties.agent.sendOffer.onClearUnderwrite, false);
  const so = c.parties.agent.intentRules.realm_yes.actions.find((a) => a.type === "send_offer");
  assert.equal(so.mode, "ask");
  assert.equal(c.booking.enabled, false);
  assert.equal(out.outreachAutopilot.enabled, true);
  assert.equal(out.dispoAutopilot.autoBlastOnPromote, true);
  assert.equal(out.dispoAutopilot.paperworkOnCommit, true);
  assert.equal(out.dispoAutopilot.autoInvite, false);
});

test("full: the offer sends itself, the band is on, invites go, booking only with a calendar", () => {
  const out = applyAutonomy(starter(), "full");
  const c = out.conversationAi;
  assert.equal(c.parties.agent.sendOffer.onClearUnderwrite, true);
  assert.equal(c.parties.agent.counterBand.enabled, true);
  assert.equal(c.parties.agent.counterBand.acceptance, true);
  const rule = c.parties.agent.intentRules.realm_yes;
  assert.equal(rule.mode, "auto");
  assert.equal(rule.actions.find((a) => a.type === "send_offer").mode, "auto");
  assert.equal(out.dispoAutopilot.autoInvite, true);
  assert.equal(c.booking.enabled, false, "no calendar picked → booking stays off");
  assert.equal(detectAutonomy(out), "full");

  const withCal = starter();
  withCal.conversationAi.booking = { enabled: false, calendarId: "cal-1", calendarName: "Matt" };
  const on = applyAutonomy(withCal, "full");
  assert.equal(on.conversationAi.booking.enabled, true);
  assert.equal(on.conversationAi.booking.calendarId, "cal-1");
  assert.equal(detectAutonomy(on), "full");
});

test("full adds a send_offer action to realm_yes when the rule has none", () => {
  const s = starter();
  s.conversationAi.parties.agent.intentRules.realm_yes = { mode: "ask", actions: [{ type: "add_tags", tags: ["realm-yes"] }] };
  const out = applyAutonomy(s, "full");
  const rule = out.conversationAi.parties.agent.intentRules.realm_yes;
  assert.ok(rule.actions.some((a) => a.type === "send_offer" && a.mode === "auto"));
  assert.ok(rule.actions.some((a) => a.type === "add_tags"), "existing actions kept");
});

test("a hand-set blob is custom, and the diff names what differs", () => {
  const out = applyAutonomy(starter(), "normal");
  out.conversationAi.parties.agent.requote.enabled = false;
  assert.equal(detectAutonomy(out), "custom");
  assert.deepEqual(autonomyDiff(out, "normal"), ["parties.agent.requote"]);
});

test("a half-on ladder set matches no mode", () => {
  const out = applyAutonomy(starter(), "normal");
  out.conversationAi.parties.agent.followUp.ladders.offer_nudge.enabled = false;
  assert.equal(autonomyFingerprint(out).parties.agent.followUp, null);
  assert.equal(detectAutonomy(out), "custom");
});

test("the live prod shape from 2026-09-10 reads as custom, not as a mode", () => {
  // Auto-send on for every eligible intent, floats on, ladders off, no
  // outreach sweep — what the location actually had when the dial was built.
  const s = { conversationAi: normalizeConversationAi({
    enabled: true,
    parties: {
      agent: { autoSend: { enabled: true, intents: autoEligible("agent") }, realmCheck: { enabled: true }, takeCheck: { enabled: true } },
      investor: { autoSend: { enabled: true, intents: autoEligible("investor") } },
    },
  }) };
  assert.equal(detectAutonomy(s), "custom");
});

test("a fresh settings document is custom (bot on, everything drafts), and every mode can be applied to it", () => {
  assert.equal(detectAutonomy({}), "custom");
  assert.equal(detectAutonomy(null), "custom");
  for (const mode of AUTONOMY_MODES) assert.equal(detectAutonomy(applyAutonomy(undefined, mode)), mode);
});

test("autonomyPlan rejects an unknown mode", () => {
  assert.throws(() => autonomyPlan("yolo"), /unknown autonomy mode/);
});
