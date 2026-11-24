// cold-ladder-last-word.test.mjs — agents who never answered kept getting
// "any houses around Kent that need real work?" until day 58 (2026-11-24).
//
// Matt: "some agents we've just been blasting with no reply, and the ones
// with no reply are only going to flag the 'any fixers' kind of messaging...
// hey sorry I've been reaching out so much, do you work with investors or
// not, happy to take off list if not." The 11-23 audit: 1,712 generic
// check-ins to agents who had never answered got 3% replies. The ladder's
// maxRepeats only picked which rung said it was the last; the texts ran on.
//
// Now the cold ladder stops at maxRepeats, its last rung is the "sorry for
// all the texts" one (shared/outreach-opener.js COLD_LAST_RUNG_TEXTS), the
// agents whose ladder ran before that get it once from a queue Matt fills
// (last-word.js), and a plain "no" to it is their opt-out.
//
// Real file store (events + dedupe + drafts), fake GHL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-ladder-last-word-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { startFollowUpSweep, getFollowUpJob, _resetJobs } = await import("./follow-up-sweep.js");
const { maybeRunLastWord, queueLastWord, lastWordSkip, LAST_WORD_CURSOR } = await import("./last-word.js");
const { lastSentIsLastWord } = await import("./reply-agent.js");
const { LAST_WORD_STEP } = await import("./shared/outreach-opener.js");
await store.init();

const DAY = 86400000;
const FIRST_TEXT = "2026-10-01T19:00:00Z";
const AI = (maxRepeats) => normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true,
  ladders: { outreach_nudge: { enabled: true, steps: [2], repeatEvery: 14, maxRepeats } } } } } });

async function seed(loc, id, { sent = [] } = {}) {
  await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_sent", at: FIRST_TEXT, address: "14th Pl W, Halden, WA", source: "conversation", dedupeKey: `outreach_sent:${id}` });
  for (const [step, at] of sent) {
    await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "follow_up_sent", at, source: "conversation",
      dedupeKey: `fus:${id}:${step}`, data: { kind: "outreach_nudge", step } });
  }
}

async function sweep(loc, now, maxRepeats) {
  _resetJobs();
  const started = [];
  startFollowUpSweep({ client: {}, locationId: loc, saved: { aiApiKey: "k", conversationAi: AI(maxRepeats), outreachAutopilot: { enabled: true } }, store, sendsEnabled: true, now,
    deps: { paceMs: 0, startProactive: async (a) => { started.push(a); return { job: { id: "j" } }; },
      runIntroEmails: async () => ({ queued: 0, drafted: 0, rows: [] }), runCheckInEmails: async () => ({ queued: 0, drafted: 0, rows: [] }) } });
  const until = Date.now() + 5000;
  while (getFollowUpJob(loc)?.status === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.equal(getFollowUpJob(loc).status, "done", getFollowUpJob(loc).error || "");
  return started;
}

test("an agent who never answered gets nothing after the ladder's last text", async () => {
  const loc = "loc-ladder-stops";
  // Day 2, then day 16 (the one repeat a cap of 1 allows) already went.
  await seed(loc, "c-wendell", { sent: [[2, "2026-10-03T17:00:00Z"], [16, "2026-10-17T17:00:00Z"]] });
  const day30 = Date.parse("2026-11-01T17:00:00Z");
  assert.deepEqual((await sweep(loc, day30, 1)).map((a) => a.contactId), [], "day 30 doesn't go: the ladder is over");
  // With no cap (maxRepeats 0) the same agent still gets day 30: the stop is the cap's.
  await seed("loc-ladder-stops-uncapped", "c-wendell", { sent: [[2, "2026-10-03T17:00:00Z"], [16, "2026-10-17T17:00:00Z"]] });
  assert.deepEqual((await sweep("loc-ladder-stops-uncapped", day30, 0)).map((a) => a.contactId), ["c-wendell"]);
});

test("the ladder's last rung is marked as the last one when it starts", async () => {
  const loc = "loc-ladder-last";
  await seed(loc, "c-ines", { sent: [[2, "2026-10-03T17:00:00Z"]] });
  const started = await sweep(loc, Date.parse("2026-10-18T17:00:00Z"), 1);
  assert.equal(started.length, 1, JSON.stringify(getFollowUpJob(loc).results));
  assert.equal(started[0].subject.maxRepeats, 1, "repeatOf reads the cap, so day 16 is the 'sorry for all the texts' one");
});

test("an agent who had the last text from the queue never gets a ladder rung after it", async () => {
  const loc = "loc-ladder-after-last-word";
  await seed(loc, "c-oskar", { sent: [[2, "2026-10-03T17:00:00Z"]] });
  await recordEvent({ store, locationId: loc, contactId: "c-oskar", party: "agent", type: "follow_up_sent", at: "2026-10-10T17:00:00Z", source: "conversation",
    dedupeKey: `fus:c-oskar:${LAST_WORD_STEP}`, data: { kind: "outreach_nudge", step: LAST_WORD_STEP, lastWord: true } });
  assert.deepEqual(await sweep(loc, Date.parse("2026-10-18T17:00:00Z"), 2), []);
});

/* ---------- the one-time queue ---------- */

const TUE_10AM = Date.parse("2026-12-01T18:00:00Z"); // Tue 12/1, 10am Pacific
const SAVED = { aiApiKey: "k", conversationAi: AI(1) };

test("the queue takes new ids only, and nothing runs with nothing queued", async () => {
  const { doc, added } = queueLastWord({ queue: ["c-aaaaaa1"], done: ["c-bbbbbb2"] }, ["c-aaaaaa1", "c-bbbbbb2", "c-cccccc3", "bad id!", ""], { perDay: 5000 });
  assert.equal(added, 1);
  assert.deepEqual(doc.queue, ["c-aaaaaa1", "c-cccccc3"]);
  assert.equal(doc.perDay, 400, "at most 400 a day");
  assert.equal(await maybeRunLastWord({ locationId: "loc-empty", saved: SAVED, store, now: TUE_10AM }), null);
});

test("queued agents get the last text through the machine's own start, a day's share at a time", async () => {
  const loc = "loc-last-word-run";
  const ids = Array.from({ length: 30 }, (_, i) => `c-queued-${String(i).padStart(2, "0")}`);
  for (const id of ids) await seed(loc, id);
  // One wrote back since the list was made.
  await recordEvent({ store, locationId: loc, contactId: ids[0], party: "agent", type: "text_summary", at: "2026-11-30T20:00:00Z", source: "conversation", dedupeKey: `ts:${ids[0]}` });
  await store.setJobCursor(loc, LAST_WORD_CURSOR, { at: new Date(TUE_10AM).toISOString(), doc: queueLastWord({}, ids, { perDay: 20 }).doc });
  const started = [];
  const deps = { startProactive: async (a) => { started.push(a); return { job: { id: `j-${started.length}` } }; } };

  const r = await maybeRunLastWord({ locationId: loc, saved: SAVED, store, sendsEnabled: true, deps, now: TUE_10AM });
  assert.equal(r.started, 19, "20 today, one of them wrote back");
  assert.equal(r.skipped, 1);
  assert.ok(started.every((a) => a.kind === "outreach_nudge" && a.subject.lastWord === true && a.subject.step === LAST_WORD_STEP));
  assert.ok(!started.some((a) => a.contactId === ids[0]));
  // Today's share is done: the next tick waits for tomorrow.
  assert.equal(await maybeRunLastWord({ locationId: loc, saved: SAVED, store, sendsEnabled: true, deps, now: TUE_10AM + 15 * 60000 }), null);
  // Each is claimed once: the ladder sees it, and nothing sends it twice.
  const ev = await store.listContactEvents(loc, ids[1], { limit: 50 });
  assert.equal(lastWordSkip(ev), "they had it already");
  // Wednesday takes the rest.
  const wed = await maybeRunLastWord({ locationId: loc, saved: SAVED, store, sendsEnabled: true, deps, now: TUE_10AM + DAY });
  assert.equal(wed.started, 10);
  assert.equal((await store.getJobCursor(loc, LAST_WORD_CURSOR)).doc.queue.length, 0);
});

test("the queue waits on weekends, days off and outside the machine's hours", async () => {
  const loc = "loc-last-word-waits";
  await seed(loc, "c-weekend1");
  await store.setJobCursor(loc, LAST_WORD_CURSOR, { at: new Date(TUE_10AM).toISOString(), doc: queueLastWord({}, ["c-weekend1"]).doc });
  const deps = { startProactive: async () => { throw new Error("must not start"); } };
  const SAT = Date.parse("2026-12-05T18:00:00Z");
  // A list handed over on a busy day waits for the day it was told.
  await store.setJobCursor(loc, LAST_WORD_CURSOR, { at: new Date(TUE_10AM).toISOString(), doc: queueLastWord({}, ["c-weekend1"], { notBefore: "2026-12-02" }).doc });
  assert.equal(await maybeRunLastWord({ locationId: loc, saved: SAVED, store, deps, now: TUE_10AM }), null, "before its first day");
  assert.equal(await maybeRunLastWord({ locationId: loc, saved: SAVED, store, deps, now: SAT }), null, "Saturday");
  assert.equal(await maybeRunLastWord({ locationId: loc, saved: SAVED, store, deps, now: Date.parse("2026-12-01T15:00:00Z") }), null, "7am");
  const off = { ...SAVED, conversationAi: { ...AI(1), autoSend: { ...AI(1).autoSend, offDays: ["2026-12-01"] } } };
  assert.equal(await maybeRunLastWord({ locationId: loc, saved: off, store, deps, now: TUE_10AM }), null, "a day off");
});

/* ---------- their answer ---------- */

test("only our last text being the 'sorry for all the texts' one makes a plain no an opt-out", async () => {
  const loc = "loc-last-word-answer";
  const now = Date.parse("2026-12-02T18:00:00Z");
  const mk = (contactId, reply, extra = {}) => store.createReplyDraft({ locationId: loc, contactId, status: "sent", channel: "sms", reply, sentText: reply,
    sentAt: new Date(now - DAY).toISOString(), outbound: { kind: "outreach_nudge", ...extra }, party: "agent" });
  await mk("c-said-no", "Hey Wendell, sorry for all the texts. Do you ever work with buyers who fix houses up? If not, happy to take you off my list.", { lastWord: true });
  await mk("c-other", "Hi Wendell, any houses around Halden that need real work lately?");
  assert.equal(await lastSentIsLastWord({ store, locationId: loc, contactId: "c-said-no", now }), true);
  assert.equal(await lastSentIsLastWord({ store, locationId: loc, contactId: "c-other", now }), false);
  assert.equal(await lastSentIsLastWord({ store, locationId: loc, contactId: "c-said-no", now: now + 30 * DAY }), false, "a month later a no is about something else");
});
