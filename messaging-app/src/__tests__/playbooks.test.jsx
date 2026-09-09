import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PartyPlaybooks, BookingCard, AutoSendCard } from "../ConversationPlaybooks.jsx";
import { normalizeConversationAi, NEVER_AUTO, INTENT_LABEL } from "@shared/conversation-ai.js";

test("the playbook grid offers every eligible intent as a box and every locked one as a lock", () => {
  const config = normalizeConversationAi({ parties: { agent: { autoSend: { enabled: true, intents: ["question"] } } } });
  const html = renderToStaticMarkup(<PartyPlaybooks config={config} patch={() => {}} workflows={{ list: [], loading: false }} />);
  expect(html).toContain("First text to new agents");
  expect(html).toContain("Send the offer after a clean underwrite");
  expect(html).toContain(INTENT_LABEL.agent.outreach_open);
  for (const intent of NEVER_AUTO.agent) expect(html).toContain(INTENT_LABEL.agent[intent]);
  expect(html).toContain("Never on its own");
});

test("the booking and auto-send cards render on a default config", () => {
  const config = normalizeConversationAi({ booking: { enabled: true } });
  const booking = renderToStaticMarkup(<BookingCard config={config} patch={() => {}} calendars={{ list: [{ id: "c1", name: "Matt" }], loading: false }} />);
  expect(booking).toContain("Booking calls");
  expect(booking).toContain("Matt");
  const auto = renderToStaticMarkup(<AutoSendCard config={config} patch={() => {}} />);
  expect(auto).toContain("Quick replies");
  expect(auto).toContain("Weekends");
});
