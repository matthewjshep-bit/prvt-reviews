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
  expect(html).not.toContain("Sam Okafor");   // a cold agent is a number on Reports, not a row here
  expect(r.counts.coldNoReply).toBe(1);
  expect(html).toContain("Do it");
});

test("an empty queue says so", () => {
  expect(renderToStaticMarkup(<ActionQueue actions={[]} />)).toContain("Nothing is waiting on you.");
});

test("an owed number on a priced offer offers to send it, not only Dismiss", () => {
  const now = Date.parse("2026-09-20T17:00:00Z");
  const offers = [{ id: "o1", contactId: "c1", address: "12 Elm St, Renton, WA", cashAmount: 410000, status: "new", createdAt: "2026-09-20T12:00:00Z", sends: [] }];
  const events = [{ contactId: "c1", type: "promise_owed", at: "2026-09-20T13:00:00Z", address: "12 Elm St, Renton, WA", data: { what: "number", text: "I'll get back to you with a number." } }];
  const r = buildPipeline({ offers, events, now });
  const html = renderToStaticMarkup(<ActionQueue actions={r.actions} draftsById={{}} sendsEnabled onDone={() => {}} />);
  expect(html).toContain("Owed a number");
  expect(html).toContain("Float our read");
  expect(html).toContain("the number is ready and hasn&#x27;t gone out");
  expect(html).toContain("Dismiss");
});
