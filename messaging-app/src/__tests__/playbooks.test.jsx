import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PartyPlaybooks, BookingCard, AutoSendCard, readOffDays, CheckInComposerFields } from "../ConversationPlaybooks.jsx";
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

test("the days-off box saves a list of dates and drops a typo", () => {
  const read = readOffDays("2026-12-25\n 2026-11-26 \n\n11/27/2026\nThanksgivng\n2026-02-30\n2026-11-26");
  expect(read.days).toEqual(["2026-11-26", "2026-11-27", "2026-12-25"]);
  expect(read.dropped).toEqual(["Thanksgivng", "2026-02-30"]);
  // What the box saves is what the settings keep.
  expect(normalizeConversationAi({ autoSend: { offDays: read.days } }).autoSend.offDays).toEqual(read.days);
  const config = normalizeConversationAi({ autoSend: { offDays: ["2026-11-26", "2026-12-25"] } });
  const html = renderToStaticMarkup(<AutoSendCard config={config} patch={() => {}} />);
  expect(html).toContain("Days off (no machine texts; replies still go)");
  expect(html).toContain("2026-11-26\n2026-12-25");
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

// 2026-11-09: check-ins that name one real thing. The composer is new
// automation: it shows Off until Matt sets it, and its samples sit side by side.
test("the check-in composer shows off by default, with its share, wait and personal switches", () => {
  const html = renderToStaticMarkup(<CheckInComposerFields config={normalizeConversationAi({})} patch={() => {}} />);
  expect(html).toContain("Check-ins: one real thing");
  expect(html).toContain("Never a past house, street or address");
  expect(html).toMatch(/<option value="off" selected="">Off<\/option>/);
  expect(html).toContain("Shadow (write beside, send the fixed one)");
  expect(html).toContain("Share written by the model (%)");
  expect(html).toContain("Wait when there&#x27;s nothing to say (days)");
  expect(html).toContain("A detail they shared may be the one thing");
  expect(html).toContain("Read 3 side by side");
  const on = renderToStaticMarkup(<CheckInComposerFields config={normalizeConversationAi({ checkIns: { composer: "shadow", composerShare: 50 } })} patch={() => {}} />);
  expect(on).toMatch(/<option value="shadow" selected="">/);
  expect(on).toContain('value="50"');
});
