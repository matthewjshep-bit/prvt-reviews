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

test("the realm check's float switches show under it, off until ticked", () => {
  const config = normalizeConversationAi({ parties: { agent: { realmCheck: { enabled: true } } } });
  const html = renderToStaticMarkup(<PartyPlaybooks config={config} patch={() => {}} workflows={{ list: [], loading: false }} />);
  expect(html).toContain("Say how we got there first");
  expect(html).toContain("Float a range topped by our number");
  expect(html).toContain("End with one setup question");
  const on = normalizeConversationAi({ parties: { agent: { realmCheck: { enabled: true, range: { enabled: true, pct: 5 }, setupQuestion: { enabled: true } } } } });
  const html2 = renderToStaticMarkup(<PartyPlaybooks config={on} patch={() => {}} workflows={{ list: [], loading: false }} />);
  expect(html2).toContain("% under our number");
  expect(html2).toContain("anything I won&#x27;t see in the photos");
  const off = normalizeConversationAi({ parties: { agent: { realmCheck: { enabled: false } } } });
  expect(renderToStaticMarkup(<PartyPlaybooks config={off} patch={() => {}} workflows={{ list: [], loading: false }} />)).not.toContain("Float a range topped by our number");
});
