import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeConversationAi, CONVERSATION_AI_DEFAULTS, INTENTS, NEVER_AUTO, autoEligible,
  draftStats, substituteTokens, actionAllowedFor, isValidTimeZone,
} from "./conversation-ai.js";

test("an empty doc is the defaults, and normalizing twice changes nothing", () => {
  const a = normalizeConversationAi(null);
  assert.deepEqual(a, normalizeConversationAi({}));
  assert.deepEqual(normalizeConversationAi(a), a);
  assert.equal(a.enabled, true);
  assert.equal(a.dailyCap, 60);
  assert.deepEqual(a.routing.agentTags, CONVERSATION_AI_DEFAULTS.routing.agentTags);
  assert.equal(a.parties.agent.autoSend.enabled, false);
  assert.deepEqual(a.parties.agent.intentRules, {});
});

test("the first-version reply agent's settings seed a fresh config — and only a fresh one", () => {
  const seed = { instructions: "Sign as Matt.", dailyCap: "25", signer: "Matt" };
  const fresh = normalizeConversationAi(undefined, seed);
  assert.equal(fresh.parties.agent.instructions, "Sign as Matt.");
  assert.equal(fresh.dailyCap, 25);
  assert.equal(fresh.persona.name, "Matt");
  const saved = normalizeConversationAi({ dailyCap: 10 }, seed);
  assert.equal(saved.dailyCap, 10);
  assert.equal(saved.parties.agent.instructions, "", "a saved doc is never re-seeded");
  assert.equal(saved.persona.name, "");
});

test("numbers, enums and strings are coerced rather than trusted", () => {
  const c = normalizeConversationAi({
    dailyCap: "1,000,000", enabled: "false",
    persona: { name: "  Matt ", length: "epic", useFirstName: "false" },
    autoSend: { delayMinSec: "300", delayMaxSec: "60", quietHours: { start: "25:00", end: "20:30", timeZone: "Mars/Olympus" }, channels: ["sms", "fax", "email"] },
    routing: { priority: "nobody", unknown: "panic", agentTags: "Agent, AGENT-*,, agent" },
  });
  assert.equal(c.dailyCap, 1000);
  assert.equal(c.enabled, false);
  assert.equal(c.persona.name, "Matt");
  assert.equal(c.persona.length, "short");
  assert.equal(c.persona.useFirstName, false);
  assert.equal(c.autoSend.delayMinSec, 300);
  assert.equal(c.autoSend.delayMaxSec, 300, "max is never below min");
  assert.equal(c.autoSend.quietHours.start, "08:00", "a bad time falls back");
  assert.equal(c.autoSend.quietHours.end, "20:30");
  assert.equal(c.autoSend.quietHours.timeZone, "America/Los_Angeles", "a bad zone falls back");
  assert.deepEqual(c.autoSend.channels, ["sms", "email"]);
  assert.equal(c.routing.priority, "agent");
  assert.equal(c.routing.unknown, "hold");
  assert.deepEqual(c.routing.agentTags, ["agent", "agent-*"], "lowercased, deduped, blanks dropped");
});

test("an allowlist can never contain a never-auto intent, and unknown intents are dropped", () => {
  const c = normalizeConversationAi({
    parties: {
      agent: { autoSend: { enabled: true, intents: ["question", "counter", "acceptance", "made_up"] } },
      investor: { autoSend: { enabled: true, intents: ["interested", "wants_to_buy", "price_pushback"] } },
    },
  });
  assert.deepEqual(c.parties.agent.autoSend.intents, ["question"]);
  assert.deepEqual(c.parties.investor.autoSend.intents, ["interested"]);
  for (const p of ["agent", "investor"]) {
    for (const i of NEVER_AUTO[p]) assert.equal(autoEligible(p).includes(i), false, `${p}:${i}`);
    assert.ok(autoEligible(p).every((i) => INTENTS[p].includes(i)));
  }
});

test("intent rules keep only real actions, and a dataroom invite forces ask", () => {
  const c = normalizeConversationAi({
    parties: {
      investor: {
        intentRules: {
          interested: { mode: "auto", actions: [
            { type: "add_tags", tags: ["Hot-Investor", ""] },
            { type: "suggest_dataroom_invite" },
            { type: "start_underwrite" },              // agent-only, dropped
            { type: "set_field", key: "Last Intent!", value: "{{intent}}" },
            { type: "add_to_workflow", workflowId: "" }, // no id, dropped
            { type: "teleport" },
          ] },
          made_up: { mode: "auto", actions: [{ type: "add_tags", tags: ["x"] }] },
          passing: { mode: "auto", actions: [] },
        },
      },
      agent: { intentRules: { new_property: { mode: "auto", actions: [{ type: "start_underwrite" }, { type: "link_deal_evaluating" }] } } },
    },
  });
  const r = c.parties.investor.intentRules.interested;
  assert.equal(r.mode, "ask", "a document going out is never automatic");
  assert.deepEqual(r.actions, [
    { type: "add_tags", tags: ["hot-investor"] },
    { type: "suggest_dataroom_invite" },
    { type: "set_field", key: "last_intent", value: "{{intent}}" },
  ]);
  assert.equal(c.parties.investor.intentRules.made_up, undefined);
  assert.equal(c.parties.investor.intentRules.passing, undefined, "a rule with no actions is no rule");
  assert.deepEqual(c.parties.agent.intentRules.new_property, { mode: "auto", actions: [{ type: "start_underwrite" }] });
  assert.equal(actionAllowedFor("agent", "suggest_dataroom_invite"), false);
  assert.equal(actionAllowedFor("investor", "add_to_workflow"), true);
});

test("examples get ids and a party, and blanks are dropped", () => {
  const c = normalizeConversationAi({ examples: [
    { theySaid: "still buying?", weSay: "Yes — send it over.", party: "agent" },
    { theySaid: "", weSay: "" },
    { id: "keep", theySaid: "what's your fee", weSay: "We just quote the price.", party: "martian" },
  ] });
  assert.equal(c.examples.length, 2);
  assert.equal(c.examples[0].id, "ex-1");
  assert.equal(c.examples[0].party, "agent");
  assert.equal(c.examples[1].id, "keep");
  assert.equal(c.examples[1].party, "any");
});

test("time zones are checked the way the runtime will use them", () => {
  assert.equal(isValidTimeZone("America/Los_Angeles"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Nowhere/Nope"), false);
  assert.equal(isValidTimeZone(""), false);
});

test("tokens in a field value are filled from the draft; unknown ones are left alone", () => {
  const out = substituteTokens("{{intent}} on {{propertyAddress}} ({{date}}) {{nope}}", {
    intent: "interested", propertyAddress: "12 Elm St", now: Date.parse("2026-09-04T12:00:00Z"),
  });
  assert.equal(out, "interested on 12 Elm St (2026-09-04) {{nope}}");
});

test("draftStats counts the graduation evidence per party and intent", () => {
  const s = draftStats([
    { party: "agent", intent: "question", status: "sent", autoSendable: true, edited: false },
    { party: "agent", intent: "question", status: "sent", autoSendable: true, edited: true },
    { party: "agent", intent: "question", status: "sent", autoSendable: true, edited: false, autoSent: true },
    { party: "agent", intent: "counter", status: "dismissed", autoSendable: false },
    { party: "investor", intent: "interested", status: "draft", autoSendable: true, heldAt: "2026-09-04T00:00:00Z" },
    { intent: "status_check", status: "superseded" },   // no party → agent, the first version's rows
  ]);
  const q = s.byParty.agent.byIntent.question;
  assert.equal(q.total, 3);
  assert.equal(q.autoSendable, 3);
  assert.equal(q.sent, 3);
  assert.equal(q.sentUnedited, 2);
  assert.equal(q.sentEdited, 1);
  assert.equal(q.autoSent, 1);
  assert.equal(q.humanSentUnedited, 1, "the auto-sent one doesn't count as a person's verdict");
  assert.equal(s.byParty.agent.byIntent.counter.dismissed, 1);
  assert.equal(s.byParty.investor.byIntent.interested.held, 1);
  assert.equal(s.byParty.investor.byIntent.interested.pending, 1);
  assert.equal(s.byParty.agent.byIntent.status_check.superseded, 1);
  assert.equal(s.totals.total, 6);
});
