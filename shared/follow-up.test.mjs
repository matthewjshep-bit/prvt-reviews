// follow-up.test.mjs — the clock's arithmetic. Every case here is a decision
// the sweep makes unattended against somebody's phone, so the interesting
// tests are the ones about NOT sending.

import test from "node:test";
import assert from "node:assert/strict";
import {
  dueStep, exhausted, followUpDedupeKey, normalizeSteps, stepLabel,
  kindsFor, DEFAULT_LADDERS, FOLLOW_UP_KINDS,
} from "./follow-up.js";

const DAY = 86400000;
const SENT = "2026-09-01T17:00:00.000Z";
const at = (days, hours = 0) => Date.parse(SENT) + days * DAY + hours * 3600000;
const LADDER = [3, 7, 14];

/* ---------- when a nudge is due ---------- */

test("the first step comes due three days after the offer was sent and not before", () => {
  assert.equal(dueStep({ steps: LADDER, startedAt: SENT, now: at(2, 23) }).due, false);
  const d = dueStep({ steps: LADDER, startedAt: SENT, now: at(3) });
  assert.equal(d.due, true);
  assert.equal(d.step, 3);
});

test("a step already recorded is never due again", () => {
  const d = dueStep({ steps: LADDER, startedAt: SENT, sentSteps: [3], now: at(3, 6) });
  assert.equal(d.due, false);
  assert.match(d.reason, /day 7/);
});

test("a sweep that missed two days fires one nudge, not three", () => {
  // Down for a fortnight, back on day 15. Every rung is overdue. It must send
  // the one it would be sending today, not work through the backlog.
  const d = dueStep({ steps: LADDER, startedAt: SENT, sentSteps: [], now: at(15) });
  assert.equal(d.due, true);
  assert.equal(d.step, 14, "the highest overdue rung, not the lowest");
});

test("a reply from them ends the ladder even when the next step is overdue", () => {
  const d = dueStep({ steps: LADDER, startedAt: SENT, lastInboundAt: new Date(at(1)).toISOString(), now: at(9) });
  assert.equal(d.due, false);
  assert.equal(d.reason, "they replied");
});

test("something they said before the offer went out is not a reply to it", () => {
  const d = dueStep({ steps: LADDER, startedAt: SENT, lastInboundAt: new Date(at(-2)).toISOString(), now: at(3) });
  assert.equal(d.due, true);
});

test("an operator who wants the ladder to run through a reply can turn that off", () => {
  const d = dueStep({ steps: LADDER, startedAt: SENT, lastInboundAt: new Date(at(1)).toISOString(),
                      now: at(3), stopOnAnyInbound: false });
  assert.equal(d.due, true);
});

test("two nudges cannot land inside the minimum gap even when two steps are overdue", () => {
  const d = dueStep({ steps: LADDER, startedAt: SENT, sentSteps: [3],
                      lastTouchAt: new Date(at(7, -6)).toISOString(), now: at(7), minHoursBetween: 40 });
  assert.equal(d.due, false);
  assert.match(d.reason, /too soon/);
});

test("the minimum gap stops mattering once it has passed", () => {
  const d = dueStep({ steps: LADDER, startedAt: SENT, sentSteps: [3],
                      lastTouchAt: new Date(at(3)).toISOString(), now: at(7), minHoursBetween: 40 });
  assert.equal(d.due, true);
  assert.equal(d.step, 7);
});

test("an empty ladder is never due", () => {
  assert.equal(dueStep({ steps: [], startedAt: SENT, now: at(99) }).due, false);
});

test("a ladder with nothing to count from is never due", () => {
  assert.equal(dueStep({ steps: LADDER, startedAt: null, now: at(99) }).due, false);
  assert.equal(dueStep({ steps: LADDER, startedAt: "not a date", now: at(99) }).due, false);
});

test("a finished ladder says so rather than going quiet", () => {
  const d = dueStep({ steps: LADDER, startedAt: SENT, sentSteps: [3, 7, 14], now: at(30) });
  assert.equal(d.due, false);
  assert.equal(d.reason, "ladder finished");
});

/* ---------- when the ladder is over ---------- */

test("the ladder is exhausted only once the last step's day has passed", () => {
  assert.equal(exhausted({ steps: LADDER, sentSteps: [3, 7], startedAt: SENT, now: at(13) }), false);
  assert.equal(exhausted({ steps: LADDER, sentSteps: [3, 7, 14], startedAt: SENT, now: at(14) }), true);
});

test("a ladder whose middle rung was skipped is still over when its last day goes by", () => {
  // They were on a live deal that week and the sweep stood aside. That is not
  // a reason to keep the offer open forever.
  assert.equal(exhausted({ steps: LADDER, sentSteps: [3, 14], startedAt: SENT, now: at(20) }), true);
});

test("a ladder with a rung still owed on its last day is not yet exhausted", () => {
  assert.equal(exhausted({ steps: LADDER, sentSteps: [3, 7], startedAt: SENT, now: at(14) }), false);
});

/* ---------- coercion ---------- */

test("a saved ladder with nonsense days is coerced to sorted whole days", () => {
  assert.deepEqual(normalizeSteps(["7", 3.4, "x", -2, 0, 3, 999, 14]), [3, 7, 14]);
});

test("a ladder typed as a comma-separated string is read the same as a list", () => {
  assert.deepEqual(normalizeSteps("3, 7,14"), [3, 7, 14]);
});

// Twelve, so the passed-offer check-in can run every ten days for four months.
test("a ladder longer than twelve rungs is capped", () => {
  assert.equal(normalizeSteps([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]).length, 12);
});

/* ---------- identity ---------- */

test("the dedupe key is stable for the same offer and step and differs across steps", () => {
  const a = followUpDedupeKey({ kind: "offer_nudge", subjectId: "o1", step: 3 });
  assert.equal(a, followUpDedupeKey({ kind: "offer_nudge", subjectId: "o1", step: 3 }));
  assert.notEqual(a, followUpDedupeKey({ kind: "offer_nudge", subjectId: "o1", step: 7 }));
  assert.notEqual(a, followUpDedupeKey({ kind: "offer_nudge", subjectId: "o2", step: 3 }));
  assert.notEqual(a, followUpDedupeKey({ kind: "blast_nudge", subjectId: "o1", step: 3 }));
});

test("the step reads as a position so a person approving it knows how far in we are", () => {
  assert.equal(stepLabel(7, LADDER), "step 2 of 3");
  assert.equal(stepLabel(1, LADDER), "");
  assert.equal(stepLabel(99, LADDER), "still asking (day 99)");
});

test("a rung keeps its identity when the operator inserts one before it", () => {
  // Steps are day offsets, not indexes. Adding a day-1 rung must not make the
  // day-3 touch look unsent and go out twice.
  const before = followUpDedupeKey({ kind: "offer_nudge", subjectId: "o1", step: 3 });
  assert.equal(dueStep({ steps: [1, 3, 7], startedAt: SENT, sentSteps: [3], now: at(3, 6) }).due, false);
  assert.equal(before, followUpDedupeKey({ kind: "offer_nudge", subjectId: "o1", step: 3 }));
});

/* ---------- the vocabulary ---------- */

test("each party owns only its own ladders", () => {
  assert.deepEqual(kindsFor("agent"), ["outreach_nudge", "offer_nudge", "passed_checkin"]);
  assert.deepEqual(kindsFor("investor"), ["blast_nudge", "dataroom_nudge"]);
});

test("every ladder ships switched off", () => {
  for (const [kind, d] of Object.entries(DEFAULT_LADDERS)) {
    assert.equal(d.enabled, false, `${kind} must ship off`);
    assert.ok(d.steps.length, `${kind} needs a default ladder`);
    assert.ok(FOLLOW_UP_KINDS[kind], `${kind} needs a party`);
  }
});

/* ---------- a ladder that keeps asking ---------- */

import { dueStep as dueR, exhausted as exhaustedR, stepLabel as labelR, DEFAULT_LADDERS as LADDERS_R } from "./follow-up.js";

const T0 = Date.parse("2026-08-01T18:00:00.000Z");
const dayR = (n) => T0 + n * 86400000;

test("the offer ladder repeats weekly by default — it asks until they answer", () => {
  assert.equal(LADDERS_R.offer_nudge.repeatEvery, 7);
  assert.equal(LADDERS_R.passed_checkin.repeatEvery, 0, "other ladders stop where they always did");
});

test("past the last configured day, a repeat rung comes due every N days", () => {
  const base = { steps: [3, 7, 14], repeatEvery: 7, startedAt: new Date(T0).toISOString(), sentSteps: [3, 7, 14] };
  assert.deepEqual(dueR({ ...base, now: dayR(21) }), { due: true, step: 21, dayOffset: 21 });
  assert.equal(dueR({ ...base, sentSteps: [3, 7, 14, 21], now: dayR(24) }).reason, "day 28 hasn't come round yet");
  assert.equal(dueR({ ...base, sentSteps: [3, 7, 14, 21], now: dayR(28) }).step, 28);
});

test("a repeat never works through a backlog — one text, the latest rung", () => {
  const r = dueR({ steps: [3, 7, 14], repeatEvery: 7, startedAt: new Date(T0).toISOString(), sentSteps: [3, 7, 14], now: dayR(60) });
  assert.equal(r.step, 56);
});

test("a reply still ends a repeating ladder", () => {
  const r = dueR({ steps: [3, 7, 14], repeatEvery: 7, startedAt: new Date(T0).toISOString(), sentSteps: [3, 7, 14],
    lastInboundAt: new Date(dayR(16)).toISOString(), now: dayR(21) });
  assert.deepEqual(r, { due: false, reason: "they replied" });
});

test("a repeating ladder is never exhausted; a plain one still is", () => {
  const base = { steps: [3, 7, 14], sentSteps: [3, 7, 14], startedAt: new Date(T0).toISOString(), now: dayR(90) };
  assert.equal(exhaustedR({ ...base, repeatEvery: 7 }), false);
  assert.equal(exhaustedR({ ...base, repeatEvery: 0 }), true);
});

test("a repeat rung is labelled as still asking, not as a step past the end", () => {
  assert.equal(labelR(7, [3, 7, 14]), "step 2 of 3");
  assert.equal(labelR(28, [3, 7, 14]), "still asking (day 28)");
});

/* ---------- a question the bot couldn't answer ---------- */

test("'let me check with my partner and get back to you' is a deflection, and a promised number is not", async () => {
  const { isDeflection, questionIn } = await import("./follow-up.js");
  assert.equal(isDeflection("Good question. Let me check with my partner on how we handle referrals and get back to you."), true);
  assert.equal(isDeflection("That's my partner's call, not something I want to guess at. I'll check with him and come back to you."), true);
  assert.equal(isDeflection("I'll run it by underwriting and get back to you with a number."), false);
  assert.equal(isDeflection("Sounds good, talk soon."), false);
  assert.equal(questionIn("Hi Matt. Do you pay a referral fee if I send you a seller? Thanks!"), "Do you pay a referral fee if I send you a seller?");
  assert.equal(questionIn("what's your inspection window"), "what's your inspection window");
  assert.equal(questionIn("x".repeat(400)).length, 240);
});
