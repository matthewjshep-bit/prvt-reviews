// cold-agent-spacing.test.mjs — a cold agent who never answered heard from
// us twice on day one and got two introduction emails (2026-10-27).
//
// Matt: "why did we send this person so much outreach? We should make sure
// that it is being staggered more." A Snohomish listing agent, never a
// reply: our first text 10/19 12:24, the bulk email (a script outside the
// app) 3:47 the same afternoon, the app's own intro email 10/22, the
// follow-up text 10/27, and STOP 53 minutes later. Of 416 agents first
// texted since 10/13 who never answered, 83 had two touches inside 24 hours
// (3.6% STOPped, against 1.2% when every touch was a day or more apart).
// The texts were already 72 hours apart; an email only waited 20 hours
// after a text, and never saw a text or email sent from outside the app.
//
// Real file store, fake GHL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-agent-spacing-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { introEmailDue, checkInEmailDue, emailGapHours } = await import("./shared/outreach-email.js");
const { ourLastTouches } = await import("./ghl.js");
const { runIntroEmails, runCheckInEmails } = await import("./outreach-email.js");
await store.init();

const DAY = 86400000, HOUR = 3600000;
const NOW = Date.parse("2026-10-27T16:00:00Z");
const iso = (t) => new Date(t).toISOString();
const ago = (days) => iso(NOW - days * DAY);

/* ---------- an email waits as long after a text as a text does ---------- */

test("the intro email doesn't go the day after the follow-up text — it waits the 72 hours a text would", () => {
  const opened = { type: "outreach_sent", at: ago(4), address: "708 79th Ave SE, Lake Stevens, WA" };
  const nudged = { type: "follow_up_sent", at: iso(NOW - 30 * HOUR), data: { kind: "outreach_nudge", step: 2 } };
  const r = introEmailDue({ events: [opened, nudged], day: 2, now: NOW, gapHours: 72 });
  assert.equal(r.due, false);
  assert.equal(r.reason, "we texted them 30 hours ago — an email waits 72 hours after a text");
  assert.equal(introEmailDue({ events: [opened, nudged], day: 2, now: NOW + 43 * HOUR, gapHours: 72 }).due, true);
});

test("a follow-up text sent in the afternoon still leaves room for the intro email inside its window", () => {
  // Day-2 text at 5pm, the email's morning runs after it: day 5 is 63 hours,
  // day 6 is 87.
  const start = Date.parse("2026-10-19T19:00:00Z");
  const events = [
    { type: "outreach_sent", at: iso(start), address: "1 Elm St" },
    { type: "follow_up_sent", at: iso(start + 2 * DAY + 5 * HOUR), data: { kind: "outreach_nudge", step: 2 } },
  ];
  const morning = (d) => start + d * DAY - 3 * HOUR;
  assert.equal(introEmailDue({ events, day: 2, now: morning(5), gapHours: 72 }).due, false);
  assert.equal(introEmailDue({ events, day: 2, now: morning(6), gapHours: 72 }).due, true);
});

test("the check-in email waits 72 hours after the check-in text, and its day hasn't gone by", () => {
  const start = NOW - 16 * DAY;
  const events = [
    { type: "outreach_sent", at: iso(start), address: "1 Elm St" },
    { type: "outreach_email_queued", at: iso(start + 5 * DAY) },
    { type: "follow_up_sent", at: iso(NOW - HOUR), data: { kind: "outreach_nudge", step: 16 } },
  ];
  const due = (now) => checkInEmailDue({ events, steps: [2], repeatEvery: 14, now, gapHours: 72 });
  assert.equal(due(NOW + DAY).due, false, "a day after the text is too soon");
  const r = due(NOW + 4 * DAY);
  assert.equal(r.due, true, r.reason);
  assert.equal(r.step, 16);
});

test("the gap is the follow-up's own hours between texts, and never under a day's 20 hours", () => {
  assert.equal(emailGapHours(normalizeConversationAi({})), 72);
  assert.equal(emailGapHours(normalizeConversationAi({ parties: { agent: { followUp: { minHoursBetween: 96 } } } })), 96);
  assert.equal(emailGapHours(normalizeConversationAi({ parties: { agent: { followUp: { minHoursBetween: 0 } } } })), 20);
});

/* ---------- what went out from outside the app counts ---------- */

test("our last text or email in their GHL thread is read from any sender, failed sends aside", () => {
  const msgs = [
    { direction: "outbound", messageType: "TYPE_SMS", dateAdded: ago(8), status: "delivered" },
    { direction: "outbound", messageType: "TYPE_EMAIL", dateAdded: ago(7.9) },
    { direction: "inbound", messageType: "TYPE_SMS", dateAdded: ago(1) },
    { direction: "outbound", messageType: "TYPE_SMS", dateAdded: ago(0.5), status: "failed" },
    { direction: "outbound", messageType: "TYPE_ACTIVITY_CONTACT", dateAdded: ago(0.2) },
  ];
  assert.deepEqual(ourLastTouches(msgs), { lastAt: Date.parse(ago(7.9)), emailedAt: Date.parse(ago(7.9)) });
  assert.deepEqual(ourLastTouches([]), { lastAt: null, emailedAt: null });
});

const AI = normalizeConversationAi({ enabled: true });
const CONTACTS = {
  "c-bulk": { firstName: "Crys", email: "c@example.com" },
  "c-texted": { firstName: "Dee", email: "d@example.com" },
  "c-fresh": { firstName: "Bea", email: "b@example.com" },
};
const getContact = async (id) => CONTACTS[id] || null;
// What each one's GHL thread holds besides the app's own records.
const THREADS = {
  "c-bulk": { lastAt: Date.parse(ago(2.9)), emailedAt: Date.parse(ago(2.9)) },  // the bulk email, the afternoon of the first text
  "c-texted": { lastAt: NOW - 5 * HOUR, emailedAt: null },                      // a text sent from GHL by hand this morning
  "c-fresh": { lastAt: Date.parse(ago(3)), emailedAt: null },                   // only our first text
};
const ourTouches = async (id) => THREADS[id];

test("an agent who already had an email from us outside the app isn't introduced to again", async () => {
  const loc = "loc-spacing-intro";
  for (const id of Object.keys(CONTACTS)) {
    await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_sent", at: ago(3), address: "708 79th Ave SE, Lake Stevens, WA", source: "conversation", dedupeKey: `outreach_sent:${id}` });
  }
  const saved = { aiApiKey: "k", conversationAi: AI, outreachAutopilot: { enabled: true, introEmail: { enabled: true, autoSend: true } } };
  const r = await runIntroEmails({ store, locationId: loc, saved, sendsEnabled: true, now: NOW, deps: { getContact, ourTouches } });
  const byId = Object.fromEntries(r.rows.map((x) => [x.contactId, x]));
  assert.equal(byId["c-bulk"].reason, "they already had an email from us");
  assert.equal(byId["c-texted"].reason, "we reached them 5 hours ago — an email waits 72 hours after a text");
  assert.equal(byId["c-fresh"].status, "scheduled");
  assert.equal(r.queued, 1);
  assert.equal((await store.listReplyDrafts(loc, { contactId: "c-bulk", limit: 5 })).length, 0);
  // Nothing was claimed for the one who waits: the next morning's run asks again.
  const later = await runIntroEmails({ store, locationId: loc, saved, sendsEnabled: true, now: NOW + 3 * DAY, deps: { getContact, ourTouches: async () => ({ lastAt: NOW - 5 * HOUR, emailedAt: null }) } });
  assert.equal(later.rows.find((x) => x.contactId === "c-texted").status, "scheduled");
});

test("a check-in email isn't held back by an email weeks ago, only by a touch inside the gap", async () => {
  const loc = "loc-spacing-checkin";
  const start = NOW - 16 * DAY - 2 * HOUR;
  for (const id of ["c-bulk", "c-texted"]) {
    await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_sent", at: iso(start), address: "1 Elm St", source: "conversation", dedupeKey: `outreach_sent:${id}` });
    await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_email_queued", at: iso(start + 5 * DAY), source: "conversation", dedupeKey: `oeq:${id}` });
  }
  const conversationAi = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, steps: [2], repeatEvery: 14 } } } } } });
  const saved = { aiApiKey: "k", conversationAi, outreachAutopilot: { enabled: true, checkInEmail: { enabled: true, autoSend: true } } };
  const threads = { "c-bulk": { lastAt: Date.parse(ago(11)), emailedAt: Date.parse(ago(11)) }, "c-texted": { lastAt: NOW - 5 * HOUR, emailedAt: null } };
  const r = await runCheckInEmails({ store, locationId: loc, saved, sendsEnabled: true, now: NOW, deps: { getContact, ourTouches: async (id) => threads[id] } });
  const byId = Object.fromEntries(r.rows.map((x) => [x.contactId, x]));
  assert.equal(byId["c-bulk"].status, "scheduled", byId["c-bulk"].reason);
  assert.equal(byId["c-texted"].reason, "we reached them 5 hours ago — an email waits 72 hours after a text");
});

test("a GHL thread that can't be read doesn't stop the email", async () => {
  const loc = "loc-spacing-unread";
  await recordEvent({ store, locationId: loc, contactId: "c-fresh", party: "agent", type: "outreach_sent", at: ago(3), address: "1 Elm St", source: "conversation", dedupeKey: "outreach_sent:c-fresh" });
  const saved = { aiApiKey: "k", conversationAi: AI, outreachAutopilot: { enabled: true, introEmail: { enabled: true, autoSend: true } } };
  const r = await runIntroEmails({ store, locationId: loc, saved, sendsEnabled: true, now: NOW, deps: { getContact, ourTouches: async () => { throw new Error("GHL 502"); } } });
  assert.equal(r.queued, 1);
});
