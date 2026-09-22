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

test("the answer box renders the question they asked, with somewhere to type", () => {
  const now = Date.parse("2026-09-20T17:00:00Z");
  const events = [{ contactId: "c1", type: "promise_owed", at: "2026-09-20T13:00:00Z", address: "", data: { what: "answer", text: "Let me check with my partner and get back to you.", draftId: "d0" } }];
  const sentDrafts = [{ id: "d0", contactId: "c1", status: "sent", inbound: "Quick one. What's your inspection window?", reply: "Let me check with my partner and get back to you.", createdAt: "2026-09-20T09:00:00Z", sentAt: "2026-09-20T09:00:00Z" }];
  const r = buildPipeline({ events, sentDrafts, now });
  const html = renderToStaticMarkup(<ActionQueue actions={r.actions} draftsById={{}} sendsEnabled onDone={() => {}} />);
  expect(html).toContain("They asked: “What&#x27;s your inspection window?”");
  expect(html).toContain("<textarea");
  expect(html).toContain("Save for next time");
  expect(html).toContain("Draft the reply");
});

test("machine rows are collapsed under their own heading and carry a Stop; your calls come first", () => {
  const now = Date.parse("2026-09-20T17:00:00Z");
  const config = normalizeConversationAi({ enabled: true, driver: { promises: { enabled: true } } });
  const offers = [{ id: "o1", contactId: "c1", address: "12 Elm St, Renton, WA", cashAmount: 410000, status: "new", createdAt: "2026-09-20T12:00:00Z", sends: [] }];
  const events = [{ contactId: "c1", type: "promise_owed", at: "2026-09-20T13:00:00Z", address: "12 Elm St, Renton, WA", data: { what: "number", text: "I'll get back to you with a number." } }];
  const drafts = [{ id: "d1", contactId: "c9", contactName: "Dana", status: "draft", intent: "counter", party: "agent", propertyAddress: "9 Oak St", createdAt: "2026-09-20T16:00:00Z", actions: [] }];
  const r = buildPipeline({ offers, events, drafts, config, now });
  const html = renderToStaticMarkup(<ActionQueue actions={r.actions} draftsById={{}} sendsEnabled onDone={() => {}} />);
  expect(html.indexOf("Your call")).toBeLessThan(html.indexOf("The machine is on it"));
  expect(html).toContain("Next: sends the number on the next pass");
  expect(html).toContain(">Stop<");
  expect(html).not.toContain(">Stuck<");   // nothing is stuck, so the heading isn't there
});

test("every row on Today, a draft or not, can be taught what the bot should have done", () => {
  const now = Date.parse("2026-09-20T17:00:00Z");
  const offers = [{ id: "o1", contactId: "c1", address: "12 Elm St, Renton, WA", cashAmount: 410000, status: "new", createdAt: "2026-09-20T12:00:00Z", sends: [] }];
  const events = [{ contactId: "c1", type: "promise_owed", at: "2026-09-20T13:00:00Z", address: "12 Elm St, Renton, WA", data: { what: "number", text: "I'll get back to you with a number." } }];
  const r = buildPipeline({ offers, events, now });
  const audit = { id: "audit:unanswered_inbound:c9:2026-09-19T19:09:53", kind: "audit_owed", severity: "now", group: "yours", contactId: "c9", contactName: "Melissa W", title: "Melissa W: Texts we never answered", detail: "not drafted: the cap", ops: [{ key: "open_contact", label: "Open the thread", intent: "primary" }],
    feedback: { category: "should_have_replied", label: "Should have replied itself", note: "", at: "2026-09-20T15:00:00Z" } };
  const draft = { id: "d1", contactId: "c2", contactName: "Alan R", status: "draft", intent: "buyer_pulse", party: "investor", reply: "Alan, buying right now?", createdAt: "2026-09-20T09:00:00Z", outbound: { kind: "buyer_pulse" } };
  const draftRow = { id: "draft_waiting:d1", kind: "draft_waiting", severity: "now", group: "yours", contactId: "c2", draftId: "d1", title: "Alan R", ops: [] };
  const html = renderToStaticMarkup(<ActionQueue actions={[...r.actions, audit, draftRow]} draftsById={{ d1: draft }} sendsEnabled onDone={() => {}}
    rowFeedback={{ "draft:d1": { category: "right_to_hand_over", label: "Right to hand it to me", note: "", at: "2026-09-20T15:00:00Z" } }} />);
  expect(r.actions.length).toBeGreaterThan(0);
  expect((html.match(/>Teach it</g) || []).length).toBe(r.actions.length);   // every untaught row offers it, once
  expect(html).toContain("noted · Should have replied itself");   // the audit row, from the action itself
  expect(html).toContain("noted · Right to hand it to me");       // the draft row, from the map
});
