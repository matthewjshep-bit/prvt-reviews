import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeConversationAi, CONVERSATION_AI_DEFAULTS, INTENTS, NEVER_AUTO, autoEligible, OUTBOUND_INTENTS,
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
    assert.ok(autoEligible(p).every((i) => INTENTS[p].includes(i) || (OUTBOUND_INTENTS[p] || []).includes(i)));
  }
});

test("intent rules keep only real actions; a dataroom invite rides along without dragging the rule to ask", () => {
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
  assert.equal(r.mode, "auto", "the tags still fire; planActions keeps the invite itself a suggestion");
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

/* ---------- the consolidated GHL bots ---------- */

import { starterConfig, detectOptOut, optOutActions, DEFAULT_OPT_OUT_KEYWORDS } from "./conversation-ai.js";

test("style, opt-out and media sections coerce and default", () => {
  const c = normalizeConversationAi({
    style: { noDollarSigns: "false", maxSmsChars: "5000" },
    optOut: { keywords: "STOP, Wrong Number", tags: ["Stop Bot"], workflowId: " wf9 " },
    media: { reply: "" },
    routing: { unknown: "classify", tagOnClassify: "false" },
    persona: { ifAskedIfBot: "  I'm an assistant.  " },
  });
  assert.equal(c.style.noDollarSigns, false);
  assert.equal(c.style.noLinks, true);
  assert.equal(c.style.maxSmsChars, 1600, "clamped");
  assert.deepEqual(c.optOut.keywords, ["stop", "wrong number"]);
  assert.deepEqual(c.optOut.tags, ["stop bot"]);
  assert.equal(c.optOut.workflowId, "wf9");
  assert.equal(c.media.reply, "Thanks for the images, taking a look!", "an empty reply falls back");
  assert.equal(c.routing.unknown, "classify");
  assert.equal(c.routing.tagOnClassify, false);
  assert.equal(c.persona.ifAskedIfBot, "I'm an assistant.");
  const d = normalizeConversationAi({});
  assert.deepEqual(d.optOut.keywords, DEFAULT_OPT_OUT_KEYWORDS);
  assert.deepEqual(optOutActions(d.optOut), [{ type: "add_tags", tags: ["dnc"] }]);
  assert.deepEqual(optOutActions({ tags: ["a"], removeTags: ["b"], workflowId: "w" }).map((a) => a.type), ["add_tags", "remove_tags", "add_to_workflow"]);
});

test("a dataroom invite inside an auto rule no longer drags the tags down to ask", () => {
  const c = normalizeConversationAi({ parties: { investor: { intentRules: {
    interested: { mode: "auto", actions: [{ type: "add_tags", tags: ["hot"] }, { type: "suggest_dataroom_invite" }] },
  } } } });
  assert.equal(c.parties.investor.intentRules.interested.mode, "auto");
});

test("the starter playbook is a valid config with the real tags, and every auto-send is off", () => {
  const c = starterConfig({ signer: "Matt Shepherd" });
  assert.deepEqual(normalizeConversationAi(c), c, "idempotent");
  assert.equal(c.persona.name, "Matt");
  assert.match(c.persona.ifAskedIfBot, /assistant on Matt's team/);
  assert.equal(c.routing.unknown, "classify");
  assert.ok(c.routing.investorTags.includes("dispo-*"));
  assert.equal(c.parties.agent.autoSend.enabled, false);
  assert.equal(c.parties.investor.autoSend.enabled, false);
  const a = c.parties.agent.intentRules;
  assert.deepEqual(a.deal_available.actions[0], { type: "add_tags", tags: ["tier-1"] });
  assert.deepEqual(a.investor_open.actions[0], { type: "add_tags", tags: ["tier-2"] });
  assert.deepEqual(a.rejection.actions[0], { type: "add_tags", tags: ["tier-3"] });
  assert.deepEqual(a.counter.actions.map((x) => x.type), ["mark_offer_countered"], "a counter is a person's call to answer, but the offer is marked");
  const i = c.parties.investor.intentRules;
  assert.equal(i.interested.mode, "auto");
  assert.ok(i.interested.actions.some((x) => x.type === "suggest_dataroom_invite"));
  assert.equal(i.wants_to_buy.mode, "ask");
  assert.deepEqual(c.optOut.tags, ["stop bot", "dnc"]);
  assert.equal(c.style.noDollarSigns, true);
  assert.ok(c.rules.some((r) => /off-market/.test(r)));
  assert.equal(detectOptOut("Unsubscribe", c.optOut), true);
});

import { matchStarterWorkflows } from "./conversation-ai.js";

test("the starter wires the five GHL workflows by name when it can see them, and not otherwise", () => {
  const list = [
    { id: "w1", name: "TIER 1" }, { id: "w2", name: "TIER 2" }, { id: "w3", name: "TIER 3" },
    { id: "d1", name: "Tier 1 Disposition" }, { id: "d2", name: "Tier 2 Disposition" },
    { id: "x", name: "AGENT - SMS blast campaign" }, { id: "y", name: "Tier 1 something else" },
  ];
  const m = matchStarterWorkflows(list);
  assert.deepEqual(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.id])), { tier1: "w1", tier2: "w2", tier3: "w3", dispoTier1: "d1", dispoTier2: "d2" });
  const c = starterConfig({ signer: "Matt", workflows: list });
  const wfIn = (party, intent) => c.parties[party].intentRules[intent].actions.filter((a) => a.type === "add_to_workflow").map((a) => a.workflowId);
  assert.deepEqual(wfIn("agent", "deal_available"), ["w1"]);
  assert.deepEqual(wfIn("agent", "new_property"), ["w1"]);
  assert.deepEqual(wfIn("agent", "investor_open"), ["w2"]);
  assert.deepEqual(wfIn("agent", "rejection"), ["w3"]);
  assert.deepEqual(wfIn("investor", "interested"), ["d1"]);
  assert.deepEqual(wfIn("investor", "wants_to_buy"), ["d1"]);
  assert.deepEqual(wfIn("investor", "looking_for_deals"), ["d2"]);
  assert.deepEqual(wfIn("investor", "buybox_update"), ["d2"]);
  assert.equal(c.parties.agent.intentRules.deal_available.actions[0].type, "add_tags", "the tags still come first");
  const bare = starterConfig({ signer: "Matt" });
  assert.deepEqual(bare.parties.agent.intentRules.deal_available.actions.map((a) => a.type), ["add_tags", "remove_tags", "set_field"], "no workflows visible, no workflow actions");
});

test("fallback rules, bot-off tags, debounce, human-active, profile and notes all normalize", () => {
  const c = normalizeConversationAi({
    routing: { botOffTags: "Stop Bot, bot-off" },
    autoSend: { debounceSec: "45", humanActiveMin: "-5" },
    profile: { enabled: "false", callTranscripts: 99 },
    notes: { onDraft: false },
    dailyCapPerContact: "3",
    retentionDays: "0",
    parties: { agent: { fallback: { mode: "auto", actions: [{ type: "add_tags", tags: ["tier-3"] }, { type: "mark_investor_passed" }], unlessTags: ["Tier-1"] } } },
  });
  assert.deepEqual(c.routing.botOffTags, ["stop bot", "bot-off"]);
  assert.equal(c.autoSend.debounceSec, 45);
  assert.equal(c.autoSend.humanActiveMin, 0);
  assert.equal(c.profile.enabled, false);
  assert.equal(c.profile.callTranscripts, 10);
  assert.equal(c.notes.onDraft, false);
  assert.equal(c.notes.onAutoSend, true);
  assert.equal(c.dailyCapPerContact, 3);
  assert.equal(c.retentionDays, 0);
  assert.deepEqual(c.parties.agent.fallback, { mode: "auto", actions: [{ type: "add_tags", tags: ["tier-3"] }], unlessTags: ["tier-1"] });
  assert.deepEqual(c.parties.investor.fallback, { mode: "ask", actions: [], unlessTags: [] });
  const st = starterConfig({ signer: "Matt", workflows: [{ id: "w2", name: "TIER 2" }, { id: "w3", name: "TIER 3" }] });
  assert.deepEqual(st.parties.agent.intentRules.deal_available.actions.map((a) => a.type), ["add_tags", "remove_tags", "remove_from_workflow", "remove_from_workflow", "set_field"]);
  assert.equal(st.parties.agent.intentRules.deal_available.actions.at(-1).value, "{{propertyAddress}}");
  assert.equal(st.parties.agent.intentRules.counter.actions[0].type, "mark_offer_countered");
  assert.equal(st.parties.investor.intentRules.passing.actions[0].type, "mark_investor_passed");
  assert.equal(st.parties.investor.intentRules.wants_to_buy.actions.some((a) => a.type === "mark_investor_committed"), true);
  assert.equal(st.autoSend.debounceSec, 45);
});

test("the realm check and the math switch normalize, and realm_check is an outbound intent on the agent allowlist", () => {
  const c = normalizeConversationAi({ parties: { agent: { showMath: "true", realmCheck: { enabled: "true" }, autoSend: { enabled: true, intents: ["realm_check", "realm_yes", "counter"] } } } });
  assert.equal(c.parties.agent.showMath, true);
  assert.equal(c.parties.agent.realmCheck.enabled, true);
  assert.deepEqual(c.parties.agent.autoSend.intents, ["realm_check", "realm_yes"]);
  assert.equal(INTENTS.agent.includes("realm_check"), false, "the classifier never reads an inbound text as one");
  const st = starterConfig({ signer: "Matt" });
  assert.equal(st.parties.agent.realmCheck.enabled, true);
  assert.equal(st.parties.agent.showMath, false);
  assert.deepEqual(st.parties.agent.intentRules.realm_yes.actions.map((a) => a.type), ["add_tags", "mark_offer_realm_yes"]);
  assert.match(st.parties.agent.instructions, /REALM CHECK/);
});
