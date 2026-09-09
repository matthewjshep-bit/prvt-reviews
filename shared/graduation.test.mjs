import test from "node:test";
import assert from "node:assert/strict";
import { intentVerdict, graduationReport, autopilotSummary, verdictsIn, GRADUATION } from "./graduation.js";
import { normalizeConversationAi, draftStats, autoEligible } from "./conversation-ai.js";

const cell = (asWritten, edited = 0, dismissed = 0, extra = {}) =>
  ({ humanSentUnedited: asWritten, sentEdited: edited, dismissed, ...extra });

test("a verdict is a person's judgement, never the bot's own send", () => {
  assert.equal(verdictsIn(cell(5, 2, 1, { autoSent: 40, pending: 3 })), 8);
});

test("locked intents never graduate, whatever the numbers", () => {
  const v = intentVerdict({ party: "agent", intent: "counter", cell: cell(100) });
  assert.equal(v.state, "locked");
});

test("not enough verdicts is its own state, with the shortfall", () => {
  const v = intentVerdict({ party: "agent", intent: "question", cell: cell(12) });
  assert.equal(v.state, "not_enough");
  assert.equal(v.needed, GRADUATION.minVerdicts - 12);
  assert.equal(v.pct, 100);
});

test("ready needs the share as written over the bar", () => {
  assert.equal(intentVerdict({ party: "agent", intent: "question", cell: cell(19, 1) }).state, "ready");
  assert.equal(intentVerdict({ party: "agent", intent: "question", cell: cell(17, 3) }).state, "not_yet");
  assert.equal(intentVerdict({ party: "agent", intent: "question", cell: cell(18, 0, 2) }).state, "ready");
});

test("an intent already on the allowlist reads as on, not ready", () => {
  const playbook = { autoSend: { enabled: true, intents: ["question"] } };
  assert.equal(intentVerdict({ party: "agent", intent: "question", cell: cell(30), playbook }).state, "on");
  // ticked but the party switch is off: it is not sending, so it is not "on"
  const off = { autoSend: { enabled: false, intents: ["question"] } };
  assert.equal(intentVerdict({ party: "agent", intent: "question", cell: cell(30), playbook: off }).state, "ready");
});

test("the report lists every intent, ready first, and counts them", () => {
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push({ party: "agent", intent: "question", status: "sent", autoSendable: true, edited: false });
  for (let i = 0; i < 25; i++) rows.push({ party: "investor", intent: "interested", status: "sent", autoSendable: true, edited: i % 2 === 0 });
  const stats = draftStats(rows);
  const config = normalizeConversationAi({});
  const r = graduationReport({ stats, config });
  assert.equal(r.ready, 1);
  assert.equal(r.byParty.agent[0].intent, "question");
  assert.equal(r.byParty.agent[0].state, "ready");
  assert.equal(r.byParty.investor[0].intent, "interested");
  assert.equal(r.byParty.investor[0].state, "not_yet");
  // every eligible intent is present even with no drafts, and locked ones last
  const agentIntents = r.byParty.agent.map((x) => x.intent);
  for (const i of autoEligible("agent")) assert.ok(agentIntents.includes(i), i);
  assert.equal(r.byParty.agent.at(-1).state, "locked");
});

test("the switchboard reads a default config as everything off or drafting", () => {
  const config = normalizeConversationAi({});
  const s = autopilotSummary({ config, sendsEnabled: true, underwriteLive: false });
  const by = Object.fromEntries(s.switches.map((x) => [x.key, x.state]));
  assert.equal(by.sends, "on");
  assert.equal(by.conversation, "on");
  assert.equal(by.underwrite, "drafting");
  assert.equal(by["autosend:agent"], "drafting");
  assert.equal(by["ladder:offer_nudge"], "off");
  assert.equal(by.counter_band, "off");
  assert.equal(s.counts.on, 2);
});

test("a ladder that is on with its intent unticked is drafting; ticked, it is on", () => {
  const base = { parties: { agent: { followUp: { enabled: true, ladders: { offer_nudge: { enabled: true, steps: [3, 7] } } } } } };
  let s = autopilotSummary({ config: normalizeConversationAi(base), sendsEnabled: true });
  assert.equal(s.switches.find((x) => x.key === "ladder:offer_nudge").state, "drafting");
  const on = normalizeConversationAi({ ...base, parties: { agent: { ...base.parties.agent, autoSend: { enabled: true, intents: ["offer_nudge"] } } } });
  s = autopilotSummary({ config: on, sendsEnabled: true });
  const l = s.switches.find((x) => x.key === "ladder:offer_nudge");
  assert.equal(l.state, "on");
  assert.match(l.note, /day 3, 7/);
});

test("with broker sends off, nothing can be on except the switch that says so", () => {
  const config = normalizeConversationAi({ parties: { agent: { autoSend: { enabled: true, intents: ["question"] } } } });
  const s = autopilotSummary({ config, sendsEnabled: false, underwriteLive: true });
  assert.ok(s.switches.every((x) => x.key === "underwrite" || x.state !== "on"), JSON.stringify(s.switches.filter((x) => x.state === "on")));
});
