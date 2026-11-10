import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FlowChart, { textWarnings } from "../FlowChart.jsx";
import { agentFlow, investorFlow } from "@shared/autopilot-flows.js";
import { autopilotSummary } from "@shared/graduation.js";
import { normalizeConversationAi } from "@shared/conversation-ai.js";

const config = normalizeConversationAi({
  enabled: true,
  parties: {
    agent: { outreach: { enabled: true }, autoSend: { enabled: true, intents: ["outreach_open"], channels: ["sms"] },
      followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true } } } },
  },
});
const { switches } = autopilotSummary({ config, sendsEnabled: true, outreach: { enabled: true }, importsEnabled: true, dispo: {}, blastsEnabled: true });

test("the agent chart shows the first text and each follow-up as an agent would read them, with what sends itself", () => {
  const html = renderToStaticMarkup(<FlowChart steps={agentFlow({ settings: { outreachAutopilot: { enabled: true } }, config, switches })} onEdit={() => {}} />);
  for (const t of ["A new listing agent is found", "First text", "Wait until day 2", "Follow-up 1", "Intro email, day 2", "Then check in every 14 days", "They reply", "Check in every 21 days"]) expect(html).toContain(t);
  expect(html).toContain("Hi Brenda, saw your listing at 14820 SE 172nd St.");
  expect(html).toContain("Hey Brenda, circling back on 14820 SE 172nd St.");
  expect(html).toContain("Hi Brenda, any houses around Renton that need real work lately?");
  // The email keeps its paragraphs and shows the website (2026-11-09: one
  // short body, the website under the name, the opt-out line last).
  expect(html).toContain("Hi Brenda,\n\nMatt Shepherd here, I texted you about SE 172nd St.");
  expect(html).toContain("shepflips.com");
  expect(html).toContain("If you&#x27;d rather I didn&#x27;t email, just reply and say so.");
  expect(html).toContain("Sends itself");
  expect(html).toContain("Drafts for you");
  expect(html).not.toContain("{first}");
  expect(html).toContain("Edit");
});

// 2026-11-09: what the voice check sees in a text Matt saved is said beside
// it, and it still goes as he wrote it; the app's own texts read clean.
test("a saved text that reads like a machine is flagged beside it on the chart, and still goes", async () => {
  const { default: VoiceNote, voiceNotes } = await import("../VoiceNote.jsx");
  const settings = { outreachAutopilot: { enabled: true, opener: { examples: ["Hi {first}, saw your listing at {address}. I'm all ears if you have others!"] } } };
  const kindFor = (s) => (s.edit?.field === "examples" ? "outreach_open" : s.edit?.field === "pulse" ? "agent_checkin" : null);
  const html = renderToStaticMarkup(<FlowChart steps={agentFlow({ settings, config, switches })} onEdit={() => {}} voiceKindFor={kindFor} />);
  expect(html).toContain("Reads like a machine");
  expect(html).toContain("I&#x27;m all ears");
  expect(html).toContain("It still goes as you wrote it.");
  const plain = renderToStaticMarkup(<FlowChart steps={agentFlow({ settings: { outreachAutopilot: { enabled: true, opener: { examples: ["Hi {first}, does your listing on {street} need much work?"] } } }, config, switches })} onEdit={() => {}} voiceKindFor={kindFor} />);
  expect(plain).not.toContain("Reads like a machine");
  expect(voiceNotes("Subject: hi\n\nHi {first},\n\nAnything near {town}?\n\nMatt", { kind: "checkin_email", email: true })).toEqual([]);
  expect(voiceNotes("When they pass, say 'Understood, thanks for your time!'", { saved: true }).length).toBeGreaterThan(0);
  expect(renderToStaticMarkup(<VoiceNote text="Anything new lately, {first}?" kind="agent_checkin" />)).toBe("");
});

test("the open step shows its editor in place of its texts", () => {
  const steps = agentFlow({ settings: {}, config, switches });
  const html = renderToStaticMarkup(<FlowChart steps={steps} editing="follow-0" onEdit={() => {}} renderEditor={(s) => <div>editing {s.title}</div>} />);
  expect(html).toContain("editing Follow-up 1");
  expect(html).not.toContain("Hi Brenda, following up");
});

test("the deal chart shows the picked deal's text and the check-in between deals", () => {
  const flow = investorFlow({ settings: { dispoAutopilot: { autoBlastOnPromote: true } }, config, switches, samples: ["Hey Alex, got 1 Elm St in Kent under contract. Buyer price 349k."] });
  const html = renderToStaticMarkup(<><FlowChart steps={flow.deal} /><FlowChart steps={flow.between} /></>);
  expect(html).toContain("The deal, to everyone who buys there");
  expect(html).toContain("Hey Alex, got 1 Elm St in Kent under contract.");
  expect(html).toContain("One follow-up about the deal");
  expect(html).toContain("Each morning: anyone new who buys there");
  expect(html).toContain("Check in every 90 days");
  expect(html).not.toContain("Edit", "read-only without onEdit");
});

test("a text you type is checked for what carriers block, money, links and length", () => {
  expect(textWarnings("Hi {first}, any fixers on your radar?")).toEqual([]);
  expect(textWarnings("Hi {first}, we pay cash, $10k over, see www.x.com").length).toBe(3);
  expect(textWarnings(`Hi {first}, ${"word ".repeat(60)}`)[0]).toMatch(/characters/);
});

test("the deal text editor shows each version filled in with the picked deal, and says what's missing", async () => {
  const { default: DealTextsEditor } = await import("../DealTextsEditor.jsx");
  const input = { firstName: "Alex", address: "5232 S Yakima Ave, Tacoma, WA", city: "Tacoma", price: 261000, arv: 380000, repairs: 60000, ask: "", link: "", linkOnReply: true };
  const html = renderToStaticMarkup(<DealTextsEditor texts={["Hi {first}, {place} is ours. {numbers}. {close}", "Hey {first}, {place}, cash only. {close}"]} onChange={() => {}} input={input} />);
  expect(html).toContain("Hi Alex, 5232 S Yakima Ave in Tacoma is ours. Buyer price 261k, ARV around 380k, rehab about 60k. Want the details?");
  expect(html).toContain("doesn&#x27;t say the price");
  expect(html).toContain("carriers block texts to new buyers with: cash");
  expect(html).toContain("Back to the built-in wording");
  expect(html).toContain("{numbers}");
});
