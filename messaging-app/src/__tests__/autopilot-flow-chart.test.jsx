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
  for (const t of ["A new listing agent is found", "First text", "Wait until day 3", "Follow-up 1", "Wait until day 10", "Follow-up 2", "They reply", "Check in every 21 days"]) expect(html).toContain(t);
  expect(html).toContain("Hi Brenda, saw your listing at 14820 SE 172nd St.");
  expect(html).toContain("Hi Brenda, following up on your listing at 14820 SE 172nd St.");
  expect(html).toContain("Hey Brenda, circling back on 14820 SE 172nd St.");
  expect(html).toContain("Sends itself");
  expect(html).toContain("Drafts for you");
  expect(html).not.toContain("{first}");
  expect(html).toContain("Edit");
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
  expect(html).toContain("Wave 1: the deal");
  expect(html).toContain("Hey Alex, got 1 Elm St in Kent under contract.");
  expect(html).toContain("One follow-up about the deal");
  expect(html).toContain("Wave 2: the deal");
  expect(html).toContain("Check in every 90 days");
  expect(html).not.toContain("Edit", "read-only without onEdit");
});

test("a text you type is checked for what carriers block, money, links and length", () => {
  expect(textWarnings("Hi {first}, any fixers on your radar?")).toEqual([]);
  expect(textWarnings("Hi {first}, we pay cash, $10k over, see www.x.com").length).toBe(3);
  expect(textWarnings(`Hi {first}, ${"word ".repeat(60)}`)[0]).toMatch(/characters/);
});
