import { test, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkView from "../WorkView.jsx";
import { ContactDrawerContext } from "../ContactLink.jsx";
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

// Matt, 2026-10-01: he never used Feedback, so it takes no room until T or
// the ⋯ menu asks for it; a verdict saved before still reads "noted".
test("Feedback stays out of the way until T or ⋯, and a saved verdict still reads 'noted'", () => {
  const r = owedNumber();
  const audit = { id: "audit:unanswered_inbound:c9:2026-09-19T19:09:53", kind: "audit_owed", severity: "now", group: "yours", contactId: "c9", contactName: "Melissa W", title: "Melissa W: Texts we never answered", detail: "not drafted: the cap", ops: [{ key: "open_contact", label: "Open the thread", intent: "primary" }],
    feedback: { category: "should_have_replied", label: "Should have replied itself", note: "", at: "2026-09-20T15:00:00Z" } };
  const draft = { id: "d1", contactId: "c2", contactName: "Alan R", status: "draft", intent: "buyer_pulse", party: "investor", reply: "Alan, buying right now?", createdAt: "2026-09-20T09:00:00Z", outbound: { kind: "buyer_pulse" } };
  const draftRow = { id: "draft_waiting:d1", kind: "draft_waiting", severity: "now", group: "yours", contactId: "c2", draftId: "d1", title: "Alan R", ops: [] };
  const blast = { id: "blast_no_opens:o7", kind: "blast_no_opens", severity: "soon", group: "yours", offerId: "o7", address: "7 Birch Ln, Auburn, WA", title: "Nobody opened it", ops: [] };
  const actions = [...r.actions, audit, draftRow, blast];
  const rowFeedback = { "draft:d1": { category: "right_to_hand_over", label: "Right to hand it to me", note: "", at: "2026-09-20T15:00:00Z" } };
  for (const a of actions) {
    const html = render({ actions, drafts: [draft], rowFeedback, initialRowId: a.id });
    const saved = Boolean(a.feedback) || a.id === draftRow.id;
    expect(html.match(/aria-label="Feedback for the bot"/g)?.length || 0).toBe(saved ? 1 : 0);
    expect(html.match(/aria-label="More"/g)?.length).toBe(1);   // ⋯: Feedback (T), their record, GHL
    expect(html).not.toContain("Teach the bot");
    expect(html).not.toContain("What was wrong with it?");
    expect(html).not.toContain("In your words");
  }
  expect(render({ actions, drafts: [draft], rowFeedback, initialRowId: audit.id })).toContain("noted · Should have replied itself");
  expect(render({ actions, drafts: [draft], rowFeedback, initialRowId: draftRow.id })).toContain("noted · Right to hand it to me");
});

// Matt didn't know what Record was: the person's name is the way in now.
test("the person's name opens their record; there is no Record button, and no 'open the thread' either", () => {
  const audit = { id: "audit:unanswered_inbound:c9:x", kind: "audit_owed", severity: "now", group: "yours", contactId: "c9", contactName: "Melissa W", title: "Melissa W: Texts we never answered", ops: [{ key: "open_contact", label: "Open the thread", intent: "primary" }] };
  const html = renderToStaticMarkup(
    <ContactDrawerContext.Provider value={{ open: () => {} }}>
      <WorkView sendsEnabled onDone={() => {}} bodies={EMPTY} actions={[audit]} />
    </ContactDrawerContext.Provider>,
  );
  expect(html).toMatch(/<h2[^>]*>.*title="Open their record"[^>]*>Melissa W<\/button>/s);
  expect(html).not.toMatch(/>\s*Record\s*</);
  expect(html).not.toContain("Open the thread");
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
  expect(html).toContain("Offers with Dana · 2");
  expect(html).toContain("9 Oak St");
  expect(html).not.toContain("Their other offers");
});

test("the header carries the offer's status menu, the Bot menu, Edit offer and Call, and names the person and the house", () => {
  const r = owedNumber();
  const offer = { id: "o1", contactId: "c1", contactName: "Dana", address: "12 Elm St, Renton, WA", cashAmount: 410000, status: "sent", sends: [{ ts: "2026-09-19T00:00:00Z" }] };
  const html = render({ actions: r.actions, bodies: { ...EMPTY, offer, siblings: [offer] } });
  expect(html).toContain("Change status (currently Sent)");
  expect(html).toContain('aria-label="Bot: Bot"');   // no timeline yet: a plain Bot menu, Stop still works
  expect(html).toContain("Edit offer");
  expect(html).toMatch(/> Call<\/button>/);
  expect(html).toMatch(/<h2[^>]*>.*>Dana <svg.*<\/a><span> · 12 Elm St<\/span><\/h2>/s);
  expect(html).not.toMatch(/>\s*Record\s*</);
  expect(html).not.toContain("Offers with");   // one offer: nothing to switch between
});

test("the header shows the last moments, what's next, and History", () => {
  const r = owedNumber();
  const offer = { id: "o1", contactId: "c1", contactName: "Dana", address: "12 Elm St, Renton, WA", cashAmount: 410000, status: "countered", sends: [{ ts: "2026-09-19T00:00:00Z" }] };
  const timeline = {
    moments: [
      { at: "2026-09-12T17:00:00Z", kind: "priced", label: "priced 410K", who: "machine" },
      { at: "2026-09-12T18:00:00Z", kind: "sent", label: "offer sent", who: "us" },
      { at: "2026-09-16T18:00:00Z", kind: "they_wrote", label: "they wrote ×2", who: "them", count: 2 },
      { at: "2026-09-18T18:00:00Z", kind: "countered", label: "countered 425K", who: "them" },
    ],
    total: 4,
    next: { at: "2026-09-24T16:00:00Z", kind: "offer_nudge", label: "Nudge · day 7", who: "machine", reason: "" },
    bot: { held: false, kind: null, pace: "less", conversationEnabled: true },
  };
  const html = render({ actions: r.actions, bodies: { ...EMPTY, offer, siblings: [offer], timeline } });
  for (const s of ["priced 410K", "offer sent", "they wrote ×2", "countered 425K", "next: nudge", ">History<"]) expect(html).toContain(s);
  expect(html.indexOf("priced 410K")).toBeLessThan(html.indexOf("countered 425K"));
  expect(html).toContain('aria-label="Bot: Bot on · less often"');
});

test("a stopped person's draft says it waits for you, and the Bot menu says stopped", () => {
  const r = owedNumber();
  const open = { id: "d5", contactId: "c1", contactName: "Dana", status: "draft", intent: "question", party: "agent", inbound: "Any update?", reply: "Still running numbers, Dana.", createdAt: "2026-09-20T16:00:00Z",
    autoSend: { decided: false, reason: "you stopped the bot on them — it waits for you" } };
  const timeline = { moments: [], total: 0, next: { kind: "stopped", label: "Stopped by you", at: null }, bot: { held: true, kind: "stopped", pace: "normal", conversationEnabled: true } };
  const html = render({ actions: r.actions, drafts: [open], bodies: { ...EMPTY, timeline } });
  expect(html).toContain("The bot is stopped on them");
  expect(html).toContain('aria-label="Bot: Bot stopped"');
  expect(html).toContain("Stopped by you");
});

test("a row with no offer has no status menu to press", () => {
  const events = [{ contactId: "c1", type: "promise_owed", at: "2026-09-20T13:00:00Z", address: "44 Pine Ave, Kent, WA", data: { what: "number", text: "I'll get back to you with a number." } }];
  const r = buildPipeline({ events, now: NOW });
  const html = render({ actions: r.actions });
  expect(html).not.toContain("Change status");
  expect(html).not.toContain("Edit offer");
});

test("a row with no offer says so and offers to start one", () => {
  const events = [{ contactId: "c1", type: "promise_owed", at: "2026-09-20T13:00:00Z", address: "44 Pine Ave, Kent, WA", data: { what: "number", text: "I'll get back to you with a number." } }];
  const r = buildPipeline({ events, now: NOW });
  const html = render({ actions: r.actions });
  expect(html).toContain("No offer yet on 44 Pine Ave");
  expect(html).toContain("Start one");
});

test("the reply box holds the bot's draft as plain text, without the draft card around it", () => {
  const r = owedNumber();
  const open = { id: "d5", contactId: "c1", contactName: "Dana", status: "draft", intent: "question", party: "agent", inbound: "Any update?", reply: "Still running numbers, Dana.", createdAt: "2026-09-20T16:00:00Z",
    flags: ["a other is a person's call"], summary: "Dana asks for an update", profileUpdates: { learned: ["history: still live"] } };
  const withDraft = render({ actions: r.actions, drafts: [open] });
  expect(withDraft).toContain("drafted by the bot");
  expect(withDraft).toContain("Still running numbers, Dana.");
  expect(withDraft).toContain('id="work-reply"');
  expect(withDraft).not.toContain("The bot&#x27;s draft");
  expect(withDraft).not.toContain("They said:");
  expect(withDraft).not.toContain("Needs you:");
  expect(withDraft).not.toContain("Filed to their profile");
  expect(withDraft).not.toContain("Dana asks for an update");
  const without = renderToStaticMarkup(<WorkView sendsEnabled={false} onDone={() => {}} bodies={EMPTY} actions={r.actions} drafts={[]} />);
  expect(without).toContain("The bot has nothing drafted");
  expect(without).toContain("sends are off — this previews only");
  expect(without).toContain('id="work-reply"');
});

test("a draft written before their last message says they've written since", () => {
  const r = owedNumber();
  const open = { id: "d5", contactId: "c1", contactName: "Dana", status: "draft", intent: "other", party: "agent", reply: "Straight up, 774.", createdAt: "2026-09-12T16:00:00Z" };
  const thread = { more: false, messages: [{ id: "m1", at: "2026-09-19T18:00:00Z", channel: "sms", dir: "in", body: "Put forth an offer." }] };
  expect(render({ actions: r.actions, drafts: [open], bodies: { ...EMPTY, thread } })).toContain("they&#x27;ve written since");
  const fresh = { ...open, createdAt: "2026-09-19T19:00:00Z" };
  expect(render({ actions: r.actions, drafts: [fresh], bodies: { ...EMPTY, thread } })).not.toContain("written since");
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
  expect(html).not.toMatch(/> Call<\/button>/);   // nobody to ring
  expect(html).toContain("Nudge them");
});

test("the coach's ideas for this thread are a header button, and only when it has some", () => {
  const r = owedNumber();
  const coach = {
    canFile: false,
    proposals: [{ id: "p1", kind: "rule", status: "open", text: "Don't open with sympathy.", why: "you cut the opener twice", evidence: ["d1"] }],
    taught: [],
  };
  expect(render({ actions: r.actions, bodies: { ...EMPTY, coach } })).toContain("Coach · 1 idea");
  expect(render({ actions: r.actions })).not.toContain("Coach ·");
});

test("the rail and the pane agree on where you are", () => {
  const r = owedNumber();
  const extra = { id: "gone_quiet:o9", kind: "gone_quiet", severity: "fyi", group: "stuck", contactId: "c3", offerId: "o9", address: "3 Ash Ct, Renton, WA", title: "Gone quiet", ops: [] };
  const html = render({ actions: [...r.actions, extra], initialRowId: extra.id });
  expect(html).toContain("2 of 2");
  expect(html).toContain('aria-current="true"');
  expect(html).toContain("Stuck");
});

// 1415 2nd St, 2026-09-28: a closing row had Mark closed, Open the deal and
// Fell through, and no way to say "seen it, next".
test("every row can be dismissed from its header, and a row with its own Dismiss doesn't get a second", () => {
  const closing = { id: "closing_soon:o9", kind: "closing_soon", severity: "soon", group: "yours", offerId: "o9", contactId: "c9", contactName: "Christian S",
    address: "1415 2nd St, Snohomish, WA 98290", title: "1415 2nd St, Snohomish, WA 98290 closes in 2d", detail: "buyer found",
    ops: [{ key: "mark_closed", label: "Mark closed", intent: "primary" }, { key: "open_deals", label: "Open the deal", intent: "secondary" }, { key: "fell_through", label: "Fell through", intent: "danger" }] };
  const html = render({ actions: [closing] });
  expect(html).toContain("Mark closed");
  expect(html.match(/>Dismiss</g)?.length).toBe(1);
  expect(html).toContain("go to the next row (D)");

  const owed = render({ actions: owedNumber().actions });
  expect(owed.match(/>Dismiss</g)?.length).toBe(1);   // the promise's own, which asks why
  expect(owed).not.toContain("go to the next row (D)");
});
