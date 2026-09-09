import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ActionQueue from "../ActionQueue.jsx";
import { buildPipeline } from "@shared/pipeline.js";
import { normalizeConversationAi } from "@shared/conversation-ai.js";

test("the queue groups what the pipeline builder emits and shows each op", () => {
  const now = Date.parse("2026-09-20T17:00:00Z");
  const config = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, steps: [2, 5] } } } } } });
  const offers = [{ id: "o1", contactId: "c1", contactName: "Dana", address: "12 Elm St", cashAmount: 410000, status: "sent", createdAt: "2026-09-01T00:00:00Z", sends: [{ ts: "2026-09-02T00:00:00Z" }], validityDays: 7 }];
  const events = [{ contactId: "cold", type: "outreach_sent", at: "2026-09-05T00:00:00Z", address: "9 Cold Creek Rd", data: { contactName: "Sam" } },
    { contactId: "cold", type: "follow_up_sent", at: "2026-09-07T00:00:00Z", data: { kind: "outreach_nudge", step: 2 } },
    { contactId: "cold", type: "follow_up_sent", at: "2026-09-10T00:00:00Z", data: { kind: "outreach_nudge", step: 5 } }];
  const drafts = [{ id: "d1", contactId: "c1", contactName: "Dana", status: "draft", intent: "realm_yes", party: "agent", propertyAddress: "12 Elm St", createdAt: "2026-09-19T00:00:00Z",
    actions: [{ id: "a2", type: "send_offer", mode: "ask", status: "pending" }] }];
  const r = buildPipeline({ offers, drafts, events, config, now, contactNames: { cold: "Sam Okafor" } });
  const html = renderToStaticMarkup(<ActionQueue actions={r.actions} draftsById={{}} sendsEnabled onDone={() => {}} />);
  expect(html).toContain("One click from you");
  expect(html).toContain("Send the formal offer (the documents)");
  expect(html).toContain("Cold agents who never answered");
  expect(html).toContain("Sam Okafor: 3 texts, no reply");
  expect(html).toContain("Do it");
});

test("an empty queue says so", () => {
  expect(renderToStaticMarkup(<ActionQueue actions={[]} />)).toContain("Nothing is waiting on you.");
});
