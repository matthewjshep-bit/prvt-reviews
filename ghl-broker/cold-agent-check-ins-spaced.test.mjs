// cold-agent-check-ins-spaced.test.mjs — a cold agent who never answered
// got a check-in text 7 days after the last one, not 14 (2026-11-02).
//
// Matt: "look at the convo with Terry V. … why are we spamming her so much
// needs to be more time between outreach." A Snohomish listing agent, never
// a reply, five touches in 17 days: our first text Fri 10/16, the bulk email
// (a script outside the app, stopped 10/22) Tue 10/20, the app's intro email
// Wed 10/21, the day-2 follow-up text Mon 10/26 (eight days late, in the
// backlog when day 2 went live), and the day-16 check-in Mon 11/2. The
// ladder counted every check-in from the FIRST text, so a follow-up that
// went late didn't push the next one back: the only floor between two texts
// was 72 hours. And the check-in email went 72 hours after each check-in
// text, so the 14 days between check-ins were really a text and an email
// three days apart, then eleven days of nothing.
//
// Now each check-in waits 14 days after the last text we sent, and after
// the day-2 follow-up a cold agent hears from us at most once in half that
// (a week): the check-in email goes a week after the check-in text, and a
// text waits a week after one of our emails.
//
// Real file store (events + dedupe + drafts), fake GHL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-agent-check-ins-spaced-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { dueStep, coldTouchGapDays } = await import("./shared/follow-up.js");
const { checkInEmailDue, checkInEmailGapHours } = await import("./shared/outreach-email.js");
const { runCheckInEmails } = await import("./outreach-email.js");
const { startFollowUpSweep, getFollowUpJob, _resetJobs } = await import("./follow-up-sweep.js");
await store.init();

const DAY = 86400000, HOUR = 3600000;
const LADDER = { steps: [2], repeatEvery: 14 };
// Her thread, as it went (Pacific times in the comments).
const FIRST_TEXT = "2026-10-16T19:45:00Z";     // Fri 10/16 12:45pm
const INTRO_EMAIL = "2026-10-21T16:00:00Z";    // Wed 10/21, the morning sweep's claim
const DAY_TWO_TEXT = "2026-10-26T21:14:00Z";   // Mon 10/26 2:14pm, eight days late
const morning = (date) => Date.parse(`${date}T17:00:00Z`);  // the 9am PST sweep
const MON_NOV_2 = morning("2026-11-02");
const MON_NOV_9 = morning("2026-11-09");

const AI = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, ...LADDER } } } } } });

/* ---------- the check-in text ---------- */

test("a check-in comes 14 days after our last text, not 7 days after a follow-up that went late", () => {
  const d = (now) => dueStep({ ...LADDER, startedAt: FIRST_TEXT, sentSteps: [2], lastTouchAt: DAY_TWO_TEXT, now, minHoursBetween: 72, repeatFromLastTouch: true });
  const early = d(MON_NOV_2);
  assert.equal(early.due, false, "day 16 came round, but the last text was a week ago");
  assert.equal(early.reason, "the last follow-up went 6 days ago — a check-in waits 14 days after it");
  const on = d(MON_NOV_9);
  assert.equal(on.due, true, on.reason);
  assert.equal(on.step, 16, "it is still the day-16 check-in, sent once");
});

test("the 14th morning after an afternoon text counts as 14 days", () => {
  const r = dueStep({ ...LADDER, startedAt: FIRST_TEXT, sentSteps: [2], lastTouchAt: DAY_TWO_TEXT, now: MON_NOV_9, repeatFromLastTouch: true });
  assert.ok(MON_NOV_9 - Date.parse(DAY_TWO_TEXT) < 14 * DAY, "the sweep runs before the hour the last text went");
  assert.equal(r.due, true, r.reason);
});

test("an on-time ladder is unchanged: day 2, then day 16, 30, 44, 58", () => {
  const start = Date.parse(FIRST_TEXT);
  const sent = [];
  let last = null;
  for (let day = 0; day < 60; day++) {
    const now = start + day * DAY + 2 * HOUR;
    const r = dueStep({ ...LADDER, startedAt: FIRST_TEXT, sentSteps: sent, lastTouchAt: last, now, minHoursBetween: 72, repeatFromLastTouch: true });
    if (r.due) { sent.push(r.step); last = new Date(now).toISOString(); }
  }
  assert.deepEqual(sent, [2, 16, 30, 44, 58]);
});

test("a follow-up text waits a week after an email of ours", () => {
  const emailed = new Date(MON_NOV_9 - 3 * DAY).toISOString();
  const d = (now) => dueStep({ ...LADDER, startedAt: FIRST_TEXT, sentSteps: [2], lastTouchAt: DAY_TWO_TEXT, now, repeatFromLastTouch: true,
    lastEmailAt: emailed, emailGapDays: coldTouchGapDays(LADDER.repeatEvery) });
  const r = d(MON_NOV_9);
  assert.equal(r.due, false);
  assert.equal(r.reason, "we emailed them 3 days ago — a text waits 7 days after an email");
  assert.equal(d(MON_NOV_9 + 4 * DAY).due, true);
});

test("the old ladder without the spacing reads as it did, for the offer nudges and the rest", () => {
  const r = dueStep({ ...LADDER, startedAt: FIRST_TEXT, sentSteps: [2], lastTouchAt: DAY_TWO_TEXT, now: MON_NOV_2, minHoursBetween: 72 });
  assert.deepEqual([r.due, r.step], [true, 16]);
});

/* ---------- the check-in email ---------- */

test("a cold agent hears from us at most once a week after the day-2 follow-up", () => {
  assert.equal(coldTouchGapDays(14), 7);
  assert.equal(coldTouchGapDays(21), 10.5);
  assert.equal(coldTouchGapDays(0), 0);
  assert.equal(checkInEmailGapHours(AI), 7 * 24 - 12, "a week, counted in mornings");
  assert.equal(checkInEmailGapHours(normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { minHoursBetween: 200, ladders: { outreach_nudge: { enabled: true, steps: [2], repeatEvery: 14 } } } } } })), 200);
});

test("the check-in email goes a week after the check-in text, not three days", () => {
  const checkInText = "2026-11-02T19:02:00Z";   // Mon 11/2 11:02am, the day-16 check-in she got
  const events = [
    { type: "outreach_sent", at: FIRST_TEXT, address: "14th Pl W, Lynnwood, WA" },
    { type: "outreach_email_queued", at: INTRO_EMAIL },
    { type: "follow_up_sent", at: DAY_TWO_TEXT, data: { kind: "outreach_nudge", step: 2 } },
    { type: "follow_up_sent", at: checkInText, data: { kind: "outreach_nudge", step: 16 } },
  ];
  const due = (now) => checkInEmailDue({ events, ...LADDER, now, gapHours: checkInEmailGapHours(AI) });
  const thursday = due(morning("2026-11-05"));
  assert.equal(thursday.due, false, "three days after the text is what she would have had");
  assert.equal(thursday.reason, "we texted them 2 days ago — an email waits 7 days after a text");
  const r = due(MON_NOV_9);
  assert.equal(r.due, true, r.reason);
  assert.equal(r.step, 16);
});

test("the check-in email still goes when the check-in text went on its day in the afternoon", () => {
  const start = Date.parse(FIRST_TEXT);
  const events = [
    { type: "outreach_sent", at: FIRST_TEXT, address: "1 Elm St" },
    { type: "outreach_email_queued", at: new Date(start + 5 * DAY).toISOString() },
    { type: "follow_up_sent", at: new Date(start + 16 * DAY + 4 * HOUR).toISOString(), data: { kind: "outreach_nudge", step: 16 } },
  ];
  const on = (day) => checkInEmailDue({ events, ...LADDER, now: start + day * DAY - 3 * HOUR, gapHours: checkInEmailGapHours(AI) });
  assert.equal(on(22).due, false);
  const r = on(23);
  assert.equal(r.due, true, r.reason);
  assert.equal(r.step, 16);
});

test("the email runner holds the check-in email a week after a text in their GHL thread", async () => {
  const loc = "loc-spaced-runner";
  const id = "c-terry";
  await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_sent", at: FIRST_TEXT, address: "14th Pl W, Lynnwood, WA", source: "conversation", dedupeKey: `outreach_sent:${id}` });
  await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_email_queued", at: INTRO_EMAIL, source: "conversation", dedupeKey: `oeq:${id}` });
  const saved = { aiApiKey: "k", conversationAi: AI, outreachAutopilot: { enabled: true, checkInEmail: { enabled: true, autoSend: true } } };
  const deps = (lastAt) => ({ getContact: async () => ({ firstName: "Terry", email: "t@example.com" }), ourTouches: async () => ({ lastAt, emailedAt: null }) });
  const now = morning("2026-11-05");
  const r = await runCheckInEmails({ store, locationId: loc, saved, sendsEnabled: true, now, deps: deps(Date.parse("2026-11-02T19:02:00Z")) });
  assert.equal(r.rows[0]?.reason, "we reached them 2 days ago — an email waits 7 days after a text");
  assert.equal(r.queued, 0);
});

/* ---------- the morning sweep ---------- */

async function seedTerry(loc) {
  const id = "c-terry";
  await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_sent", at: FIRST_TEXT, address: "14th Pl W, Lynnwood, WA", source: "conversation", dedupeKey: `outreach_sent:${id}` });
  await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_email_queued", at: INTRO_EMAIL, source: "conversation", dedupeKey: `oeq:${id}` });
  await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "follow_up_sent", at: DAY_TWO_TEXT, source: "conversation", dedupeKey: `fus:${id}:2`, data: { kind: "outreach_nudge", step: 2 } });
}

async function sweep(loc, now) {
  _resetJobs();
  const started = [];
  startFollowUpSweep({ client: {}, locationId: loc, saved: { aiApiKey: "k", conversationAi: AI, outreachAutopilot: { enabled: true } }, store, sendsEnabled: true, now,
    deps: { paceMs: 0, startProactive: async (a) => { started.push(a.contactId); return { job: { id: "j" } }; },
      runIntroEmails: async () => ({ queued: 0, drafted: 0, rows: [] }), runCheckInEmails: async () => ({ queued: 0, drafted: 0, rows: [] }) } });
  const until = Date.now() + 5000;
  while (getFollowUpJob(loc)?.status === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.equal(getFollowUpJob(loc).status, "done", getFollowUpJob(loc).error || "");
  return { started, results: getFollowUpJob(loc).results || [] };
}

test("the morning sweep doesn't send Terry's check-in a week after her late follow-up", async () => {
  const loc = "loc-spaced-sweep";
  await seedTerry(loc);
  const nov2 = await sweep(loc, MON_NOV_2);
  assert.deepEqual(nov2.started, []);
  const row = nov2.results.find((x) => x.contactId === "c-terry");
  assert.equal(row?.reason, "the last follow-up went 6 days ago — a check-in waits 14 days after it");
  const nov9 = await sweep(loc, MON_NOV_9);
  assert.deepEqual(nov9.started, ["c-terry"]);
});

test("the morning sweep holds a follow-up text a week after our email", async () => {
  const loc = "loc-spaced-sweep-email";
  await seedTerry(loc);
  await recordEvent({ store, locationId: loc, contactId: "c-terry", party: "agent", type: "checkin_email_queued", at: new Date(MON_NOV_9 - 2 * DAY).toISOString(), source: "conversation", dedupeKey: "cieq:c-terry:16", data: { step: 16, n: 1 } });
  const r = await sweep(loc, MON_NOV_9);
  assert.deepEqual(r.started, []);
  assert.equal(r.results.find((x) => x.contactId === "c-terry")?.reason, "we emailed them 2 days ago — a text waits 7 days after an email");
});
