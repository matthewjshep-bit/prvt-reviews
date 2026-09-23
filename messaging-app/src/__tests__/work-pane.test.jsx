import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkView from "../WorkView.jsx";
import { buildPipeline } from "@shared/pipeline.js";
import { normalizeConversationAi } from "@shared/conversation-ai.js";

const NOW = Date.parse("2026-09-20T17:00:00Z");
// The pane's three sides are handed their data (`bodies`), so nothing loads.
const EMPTY = { offer: null, siblings: [], thread: { messages: [], more: false }, coach: { proposals: [], taught: [] } };
const render = (props) => renderToStaticMarkup(<WorkView sendsEnabled onDone={() => {}} bodies={EMPTY} {...props} />);

const owedNumber = () => {
  const offers = [{ id: "o1", contactId: "c1", contactName: "Dana", address: "12 Elm St, Renton, WA", cashAmount: 410000, status: "new", createdAt: "2026-09-20T12:00:00Z", sends: [] }];
  const events = [{ contactId: "c1", type: "promise_owed", at: "2026-09-20T13:00:00Z", address: "12 Elm St, Renton, WA", data: { what: "number", text: "I'll get back to you with a number." } }];
  return buildPipeline({ offers, events, now: NOW });
};

/* ---------- ported from the old list: every row kind still works here ---------- */

test("a one-click hand-off opens with its button, and a cold agent is not a row", () => {
  const config = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, steps: [2, 5] } } } } } });
  const offers = [{ id: "o1", contactId: "c1", contactName: "Dana", address: "12 Elm St", cashAmount: 410000, status: "sent", createdAt: "2026-09-01T00:00:00Z", sends: [{ ts: "2026-09-02T00:00:00Z" }], validityDays: 7 }];
  const events = [{ contactId: "cold", type: "outreach_sent", at: "2026-09-05T00:00:00Z", address: "9 Cold Creek Rd", data: { contactName: "Sam" } },
    { contactId: "cold", type: "follow_up_sent", at: "2026-09-07T00:00:00Z", data: { kind: "outreach_nudge", step: 2 } },
    { contactId: "cold", type: "follow_up_sent", at: "2026-09-10T00:00:00Z", data: { kind: "outreach_nudge", step: 5 } }];
  const drafts = [{ id: "d1", contactId: "c1", contactName: "Dana", status: "draft", intent: "realm_yes", party: "agent", propertyAddress: "12 Elm St", createdAt: "2026-09-19T00:00:00Z",
    actions: [{ id: "a2", type: "send_offer", mode: "ask", status: "pending" }] }];
  const r = buildPipeline({ offers, drafts, events, config, now: NOW, contactNames: { cold: "Sam Okafor" } });
  const handoff = r.actions.find((a) => a.kind === "handoff");
  const html = render({ actions: r.actions, initialRowId: handoff.id });
  expect(html).toContain("One click from you");
  expect(html).toContain("Send the formal offer (the documents)");
  expect(html).toContain("Do it");
  expect(html).not.toContain("Sam Okafor");   // a cold agent is a number on Reports, not a row here
  expect(r.counts.coldNoReply).toBe(1);
});

test("an empty queue says so", () => {
  expect(render({ actions: [] })).toContain("Nothing is waiting on you");
});

test("an owed number on a priced offer offers to send it, not only Dismiss", () => {
  const r = owedNumber();
  const html = render({ actions: r.actions });
  expect(html).toContain("Owed a number");
  expect(html).toContain("Float our read");
  expect(html).toContain("the number is ready and hasn&#x27;t gone out");
  expect(html).toContain("Dismiss");
});

test("the answer box renders the question they asked, with somewhere to type", () => {
  const events = [{ contactId: "c1", type: "promise_owed", at: "2026-09-20T13:00:00Z", address: "", data: { what: "answer", text: "Let me check with my partner and get back to you.", draftId: "d0" } }];
  const sentDrafts = [{ id: "d0", contactId: "c1", status: "sent", inbound: "Quick one. What's your inspection window?", reply: "Let me check with my partner and get back to you.", createdAt: "2026-09-20T09:00:00Z", sentAt: "2026-09-20T09:00:00Z" }];
  const r = buildPipeline({ events, sentDrafts, now: NOW });
  const html = render({ actions: r.actions });
  expect(html).toContain("They asked: “What&#x27;s your inspection window?”");
  expect(html).toContain("Save for next time");
  expect(html).toContain("Draft the reply");
});

test("your calls come first on the rail; a machine row, opened, says what's next and carries Stop", () => {
  const config = normalizeConversationAi({ enabled: true, driver: { promises: { enabled: true } } });
  const offers = [{ id: "o1", contactId: "c1", address: "12 Elm St, Renton, WA", cashAmount: 410000, status: "new", createdAt: "2026-09-20T12:00:00Z", sends: [] }];
  const events = [{ contactId: "c1", type: "promise_owed", at: "2026-09-20T13:00:00Z", address: "12 Elm St, Renton, WA", data: { what: "number", text: "I'll get back to you with a number." } }];
  const drafts = [{ id: "d1", contactId: "c9", contactName: "Dana", status: "draft", intent: "counter", party: "agent", propertyAddress: "9 Oak St", createdAt: "2026-09-20T16:00:00Z", actions: [] }];
  const r = buildPipeline({ offers, events, drafts, config, now: NOW });
  const machine = r.actions.find((a) => a.group === "machine");
  const html = render({ actions: r.actions, drafts, initialRowId: machine.id });
  expect(html.indexOf("Your call")).toBeLessThan(html.indexOf("The machine is on it"));
  expect(html).toContain("Next: sends the number on the next pass");
  expect(html).toContain(">Stop<");
  expect(html).not.toContain(">Stuck<");   // nothing is stuck, so there is no Stuck heading
});

test("every row on Today, a draft or not, opens with Teach it already showing, and what was taught", () => {
  const r = owedNumber();
  const audit = { id: "audit:unanswered_inbound:c9:2026-09-19T19:09:53", kind: "audit_owed", severity: "now", group: "yours", contactId: "c9", contactName: "Melissa W", title: "Melissa W: Texts we never answered", detail: "not drafted: the cap", ops: [{ key: "open_contact", label: "Open the thread", intent: "primary" }],
    feedback: { category: "should_have_replied", label: "Should have replied itself", note: "", at: "2026-09-20T15:00:00Z" } };
  const draft = { id: "d1", contactId: "c2", contactName: "Alan R", status: "draft", intent: "buyer_pulse", party: "investor", reply: "Alan, buying right now?", createdAt: "2026-09-20T09:00:00Z", outbound: { kind: "buyer_pulse" } };
  const draftRow = { id: "draft_waiting:d1", kind: "draft_waiting", severity: "now", group: "yours", contactId: "c2", draftId: "d1", title: "Alan R", ops: [] };
  const actions = [...r.actions, audit, draftRow];
  const rowFeedback = { "draft:d1": { category: "right_to_hand_over", label: "Right to hand it to me", note: "", at: "2026-09-20T15:00:00Z" } };
  for (const a of actions) {
    const html = render({ actions, drafts: [draft], rowFeedback, initialRowId: a.id });
    expect(html).toContain("What should the bot have done?");
    expect(html).toContain("Should have replied itself");   // the chips, without a click
  }
  expect(render({ actions, drafts: [draft], rowFeedback, initialRowId: audit.id })).toContain("noted · Should have replied itself");
  expect(render({ actions, drafts: [draft], rowFeedback, initialRowId: draftRow.id })).toContain("noted · Right to hand it to me");
});

/* ---------- the three sides ---------- */

test("the offer side shows our number against theirs and what a buyer would be in for", () => {
  const r = owedNumber();
  const offer = { id: "o1", contactId: "c1", address: "12 Elm St, Renton, WA", cashAmount: 310000, askingPrice: 425000, arv: 520000, repairs: 85000, status: "countered",
    counter: { amount: 360000, at: "2026-09-19T00:00:00Z" }, statusHistory: [{ status: "countered", ts: "2026-09-19T00:00:00Z", note: "seller wants 360" }] };
  const html = render({ actions: r.actions, bodies: { ...EMPTY, offer, siblings: [offer, { id: "o2", address: "9 Oak St, Kent, WA", cashAmount: 280000, status: "passed" }] } });
  expect(html).toContain("$310,000");
  expect(html).toContain("$425,000");
  expect(html).toContain("Their counter");
  expect(html).toContain("76% of ARV");          // (310 + 85) / 520
  expect(html).toContain("over what buyers pay (70%)");
  expect(html).toContain("85.6% of ARV");        // at their counter
  expect(html).toContain("seller wants 360");
  expect(html).toContain("Their other offers");
  expect(html).toContain("9 Oak St");
});

test("a row with no offer says so and offers to start one", () => {
  const events = [{ contactId: "c1", type: "promise_owed", at: "2026-09-20T13:00:00Z", address: "44 Pine Ave, Kent, WA", data: { what: "number", text: "I'll get back to you with a number." } }];
  const r = buildPipeline({ events, now: NOW });
  const html = render({ actions: r.actions });
  expect(html).toContain("No offer yet on 44 Pine Ave");
  expect(html).toContain("Start one");
});

test("the reply box is the bot's draft when one is open, and a plain box when not", () => {
  const r = owedNumber();
  const open = { id: "d5", contactId: "c1", contactName: "Dana", status: "draft", intent: "question", party: "agent", inbound: "Any update?", reply: "Still running numbers, Dana.", createdAt: "2026-09-20T16:00:00Z", flags: ["asks for a number"] };
  const withDraft = render({ actions: r.actions, drafts: [open] });
  expect(withDraft).toContain("The bot&#x27;s draft");
  expect(withDraft).toContain("Still running numbers, Dana.");
  expect(withDraft).toContain('id="work-reply"');
  const without = renderToStaticMarkup(<WorkView sendsEnabled={false} onDone={() => {}} bodies={EMPTY} actions={r.actions} drafts={[]} />);
  expect(without).toContain("The bot has nothing drafted");
  expect(without).toContain("sends are off — this previews only");
  expect(without).toContain('id="work-reply"');
});

test("the thread shows both sides, oldest first", () => {
  const r = owedNumber();
  const thread = { more: false, messages: [
    { id: "m1", at: "2026-09-19T18:00:00Z", channel: "sms", dir: "out", body: "Sent you our offer on Elm." },
    { id: "m2", at: "2026-09-20T13:00:00Z", channel: "sms", dir: "in", body: "Can you do better?" },
  ] };
  const html = render({ actions: r.actions, bodies: { ...EMPTY, thread } });
  expect(html.indexOf("Sent you our offer on Elm.")).toBeLessThan(html.indexOf("Can you do better?"));
});

test("a row about no one person says the conversation isn't here", () => {
  const blast = { id: "blast_no_opens:o7", kind: "blast_no_opens", severity: "soon", group: "yours", offerId: "o7", address: "7 Birch Ln, Auburn, WA", title: "Nobody opened it", ops: [{ key: "run_follow_ups", label: "Nudge them" }] };
  const html = render({ actions: [blast] });
  expect(html).toContain("isn&#x27;t a conversation with one person");
  expect(html).toContain("Nudge them");
});

test("the coach side shows this thread's lessons and what was taught before", () => {
  const r = owedNumber();
  const coach = {
    canFile: false,
    proposals: [{ id: "p1", kind: "rule", status: "open", text: "Don't open with sympathy.", why: "you cut the opener twice", evidence: ["d1"] }],
    taught: [{ eventId: "e1", label: "Wrong read of the message", note: "they meant the other house", at: "2026-09-18T00:00:00Z", rowKind: "draft_waiting" }],
  };
  const html = render({ actions: r.actions, bodies: { ...EMPTY, coach } });
  expect(html).toContain("The coach proposes, from this thread");
  expect(html).toContain("Don&#x27;t open with sympathy.");
  expect(html).toContain(">Apply<");
  expect(html).toContain("You taught it before");
  expect(html).toContain("they meant the other house");
});

test("the rail and the pane agree on where you are", () => {
  const r = owedNumber();
  const extra = { id: "gone_quiet:o9", kind: "gone_quiet", severity: "fyi", group: "stuck", contactId: "c3", offerId: "o9", address: "3 Ash Ct, Renton, WA", title: "Gone quiet", ops: [] };
  const html = render({ actions: [...r.actions, extra], initialRowId: extra.id });
  expect(html).toContain("2 of 2");
  expect(html).toContain('aria-current="true"');
  expect(html).toContain("Stuck");
});
