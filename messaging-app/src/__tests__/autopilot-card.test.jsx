import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AutopilotCard from "../AutopilotCard.jsx";
import { autopilotSummary } from "@shared/graduation.js";
import { normalizeConversationAi } from "@shared/conversation-ai.js";

test("the autopilot card renders every switch the broker sends, grouped, with its state", () => {
  const config = normalizeConversationAi({ enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } });
  const autopilot = { ...autopilotSummary({ config, sendsEnabled: true, underwriteLive: false, outreach: { enabled: true, dailyCap: 12 }, importsEnabled: true, dispo: { sendWith: "app" }, blastsEnabled: true }), readyToGraduate: 2, windowDays: 14 };
  const html = renderToStaticMarkup(<AutopilotCard autopilot={autopilot} />);
  expect(html).toContain("Autopilot");
  expect(html).toContain("Daily listing pull + import");
  expect(html).toContain("Deal blasts");
  expect(html).toContain("2 intents are ready to send on their own");
  for (const s of autopilot.switches) expect(html).toContain(s.label);
});

test("with nothing to show it renders nothing rather than throwing", () => {
  expect(renderToStaticMarkup(<AutopilotCard autopilot={null} />)).toBe("");
});
