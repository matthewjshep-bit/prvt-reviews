import test from "node:test";
import assert from "node:assert/strict";
import {
  workingHoursBetween, paperWent, paperWorthy, floatSentAt, floatSentIndex, answeredSince, paperAfterSilenceDue, PAPER_FLOAT_MAX_DAYS,
} from "./paper-follows.js";

// Friday 2026-10-02, 2pm Pacific.
const FRI_2PM = Date.parse("2026-10-02T21:00:00Z");
const H = 3600000;
const offer = (extra = {}) => ({
  id: "o1", contactId: "c1", address: "1 Main St", cashAmount: 300000, status: "new", statusHistory: [],
  autoUnderwrite: { passed: true }, proactive: { realmCheckAt: new Date(FRI_2PM - 60000).toISOString() }, ...extra,
});
const floatDraft = (at = FRI_2PM, extra = {}) => ({ status: "sent", sentAt: new Date(at).toISOString(), outbound: { kind: "realm_check", offerId: "o1" }, ...extra });

test("working hours skip the weekend", () => {
  assert.equal(workingHoursBetween(FRI_2PM, FRI_2PM + 10 * H), 10, "Friday afternoon into the evening");
  const monday2pm = Date.parse("2026-10-05T21:00:00Z");
  assert.equal(workingHoursBetween(FRI_2PM, monday2pm), 24, "Friday 2pm to Monday 2pm is one working day");
  assert.equal(workingHoursBetween(monday2pm, FRI_2PM), 0);
});

test("a floated number nobody answered gets the written offer after 24 working hours, not over a weekend", () => {
  const drafts = [floatDraft()];
  const saturday = paperAfterSilenceDue({ offer: offer(), drafts, now: FRI_2PM + 24 * H });
  assert.equal(saturday.due, false, "Saturday 2pm is ten working hours on");
  const mondayNoon = paperAfterSilenceDue({ offer: offer(), drafts, now: Date.parse("2026-10-05T19:00:00Z") });
  assert.equal(mondayNoon.due, false);
  const monday2pm = paperAfterSilenceDue({ offer: offer(), drafts, now: Date.parse("2026-10-05T21:00:00Z") });
  assert.equal(monday2pm.due, true);
  assert.equal(monday2pm.floatAt, new Date(FRI_2PM).toISOString());
});

test("the clock starts when the number went out, not when it was drafted", () => {
  // Drafted Friday, approved and sent Monday at 9am.
  const sentMonday = Date.parse("2026-10-05T16:00:00Z");
  const r = paperAfterSilenceDue({ offer: offer(), drafts: [floatDraft(sentMonday)], now: Date.parse("2026-10-05T21:00:00Z") });
  assert.equal(r.due, false);
  assert.equal(floatSentAt([floatDraft(sentMonday), { ...floatDraft(FRI_2PM), outbound: { kind: "take_check", offerId: "o1" } }], "o1"), new Date(sentMonday).toISOString());
  assert.equal(floatSentAt([{ ...floatDraft(), status: "scheduled" }], "o1"), null, "not out yet");
});

test("an agent who replied after the float is left to the reply path", () => {
  const later = Date.parse("2026-10-06T21:00:00Z");
  const replied = [floatDraft(), { inbound: "let me check with the seller", createdAt: new Date(FRI_2PM + 2 * H).toISOString(), status: "sent" }];
  assert.equal(paperAfterSilenceDue({ offer: offer(), drafts: replied, now: later }).reason, "they answered — the conversation has it");
  const called = [{ type: "call_summary", at: new Date(FRI_2PM + 3 * H).toISOString(), data: {} }];
  assert.equal(paperAfterSilenceDue({ offer: offer(), drafts: [floatDraft()], events: called, now: later }).due, false, "a call counts");
  const before = [{ type: "text_summary", at: new Date(FRI_2PM - 3 * H).toISOString(), data: { inbound: "send me numbers" } }];
  assert.equal(answeredSince(new Date(FRI_2PM).toISOString(), { events: before }), false, "what they said before the float doesn't");
});

test("a low-confidence or agent-numbers offer is never papered on silence", () => {
  const later = Date.parse("2026-10-06T21:00:00Z");
  const drafts = [floatDraft()];
  assert.equal(paperAfterSilenceDue({ offer: offer({ autoUnderwrite: { passed: false, basis: "agent_numbers" } }), drafts, now: later }).due, false);
  assert.equal(paperAfterSilenceDue({ offer: offer({ autoUnderwrite: { passed: false } }), drafts, now: later }).due, false, "held");
  assert.equal(paperAfterSilenceDue({ offer: offer({ autoUnderwrite: { passed: false, publishedAt: "2026-10-01" } }), drafts, now: later }).due, true, "a held one a person published is theirs");
  assert.equal(paperWorthy({}), true, "a person's own number");
});

test("passed, sold, we-passed and deals get no paper on silence", () => {
  const later = Date.parse("2026-10-06T21:00:00Z");
  const drafts = [floatDraft()];
  for (const status of ["passed", "we_passed", "unavailable", "countered", "accepted"]) {
    assert.equal(paperAfterSilenceDue({ offer: offer({ status }), drafts, now: later }).due, false, status);
  }
  assert.equal(paperAfterSilenceDue({ offer: offer({ deal: { stage: "contract" } }), drafts, now: later }).due, false);
});

test("paper goes once, and not after a float more than two weeks old", () => {
  const later = Date.parse("2026-10-06T21:00:00Z");
  assert.equal(paperAfterSilenceDue({ offer: offer({ paperAfterFloat: { at: "x" } }), drafts: [floatDraft()], now: later }).due, false);
  const old = FRI_2PM - (PAPER_FLOAT_MAX_DAYS + 1) * 24 * H;
  assert.equal(paperAfterSilenceDue({ offer: offer(), drafts: [floatDraft(old)], now: FRI_2PM }).due, false);
});

test("a send where every channel failed isn't paper out", () => {
  assert.equal(paperWent({ sends: [{ ts: "2026-10-01", results: { sms: { ok: false }, email: { ok: false } } }] }), false);
  assert.equal(paperWent({ sends: [{ ts: "2026-10-01", results: { sms: { ok: false }, email: { ok: true } } }] }), true);
  assert.equal(paperWent({ sends: [{ ts: "2026-10-01" }] }), true, "an old ledger row without results");
  assert.equal(paperWent({}), false);
  const r = paperAfterSilenceDue({ offer: offer({ sends: [{ ts: "2026-10-01", results: { sms: { ok: false } } }] }), drafts: [floatDraft()], now: Date.parse("2026-10-06T21:00:00Z") });
  assert.equal(r.due, true, "a failed attempt doesn't stand in for the paper");
});

test("afterFloat survives the normaliser and is never on for investors", async () => {
  const { normalizeConversationAi } = await import("./conversation-ai.js");
  const fresh = normalizeConversationAi({});
  assert.deepEqual(fresh.parties.agent.sendOffer.afterFloat, { enabled: false, silenceHours: 24, onPushback: false, dailyCap: 20 });
  const on = normalizeConversationAi({ parties: {
    agent: { sendOffer: { afterFloat: { enabled: true, silenceHours: "48", onPushback: true, dailyCap: 500 } } },
    investor: { sendOffer: { afterFloat: { enabled: true, onPushback: true } } },
  } });
  assert.deepEqual(on.parties.agent.sendOffer.afterFloat, { enabled: true, silenceHours: 48, onPushback: true, dailyCap: 200 });
  assert.equal(on.parties.investor.sendOffer.afterFloat.enabled, false);
  assert.equal(on.parties.investor.sendOffer.afterFloat.onPushback, false);
  // What a save of the normalised config keeps.
  assert.deepEqual(normalizeConversationAi(on).parties.agent.sendOffer.afterFloat, on.parties.agent.sendOffer.afterFloat);
});

test("each offer's latest sent float is found; a take-check or an unsent draft isn't one", () => {
  const drafts = [
    floatDraft(FRI_2PM - 48 * H),
    floatDraft(FRI_2PM),
    floatDraft(FRI_2PM, { status: "draft" }),
    floatDraft(FRI_2PM + H, { outbound: { kind: "take_check", offerId: "o1" } }),
    floatDraft(FRI_2PM - H, { outbound: { kind: "realm_check", offerId: "o2" } }),
  ];
  const idx = floatSentIndex(drafts);
  assert.equal(idx.get("o1"), new Date(FRI_2PM).toISOString());
  assert.equal(idx.get("o2"), new Date(FRI_2PM - H).toISOString());
  assert.equal(idx.get("o3"), undefined);
  assert.equal(floatSentIndex(null).size, 0);
});
