// check-in-emails.test.mjs — an email goes with each 14-day check-in to a
// cold agent the intro email reached (2026-10-20).
//
// Matt: "add an email follow-up with the 14-day check-in: something short,
// concise, and to the point, every 14 days with the agent check-in. Make it
// personable. Make it fun."
//
// Real file store (events + dedupe + drafts), fake GHL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-in-emails-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { normalizeCheckInEmail, checkInEmailFor, checkInEmailDue, DEFAULT_CHECK_IN_EMAILS } = await import("./shared/outreach-email.js");
const { runCheckInEmails } = await import("./outreach-email.js");
const { startFollowUpSweep, getFollowUpJob, _resetJobs } = await import("./follow-up-sweep.js");
await store.init();

const DAY = 86400000;
const NOW = Date.parse("2026-11-05T16:30:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const LADDER = { steps: [2], repeatEvery: 14 };

test("the check-in emails are short, fun, and each one asks for the ugly ones", () => {
  for (const e of DEFAULT_CHECK_IN_EMAILS) {
    const words = e.body.split("\n\n")[1].split(/\s+/).length;
    assert.ok(words <= 45, `${words} words: ${e.subject}`);
    assert.match(e.subject, /^[a-z]/, "lowercase subjects, like 'texted you'");
    assert.match(e.body, /^Hi \{first\},\n\n/);
    assert.match(e.body, /shepflips\.com/);
    assert.match(e.body, /reply and say so/, "an easy way out");
  }
  const ce = normalizeCheckInEmail({});
  assert.deepEqual([ce.enabled, ce.autoSend, ce.emails.length], [false, false, DEFAULT_CHECK_IN_EMAILS.length]);
});

test("each check-in email is the next one along, never the same twice running", () => {
  for (const contactId of ["c-1", "c-2", "c-3"]) {
    const seen = [1, 2, 3, 4].map((n) => checkInEmailFor({ checkInEmail: {}, name: "Brenda Jones", contactId, n }));
    for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i].index, seen[i - 1].index, contactId);
    assert.match(seen[0].body, /^Hi Brenda,\n\n/);
  }
  const mine = { emails: [{ subject: "yo", body: "Hi {first},\n\nmine" }, { subject: "", body: "dropped: no subject" }] };
  assert.deepEqual(normalizeCheckInEmail(mine).emails, [{ subject: "yo", body: "Hi {first},\n\nmine" }]);
});

test("a check-in email is due on each check-in day, only after the intro email, and only until they answer", () => {
  const base = [{ type: "outreach_sent", at: ago(16), address: "1 Elm St" }, { type: "outreach_email_queued", at: ago(14) }];
  const due = (events, now = NOW) => checkInEmailDue({ events, ...LADDER, now });
  assert.deepEqual([due(base).due, due(base).step, due(base).n], [true, 16, 1]);
  assert.equal(due([base[0]]).reason, "no intro email went", "the email follows up an email");
  assert.equal(due([...base, { type: "text_summary", at: ago(3) }]).due, false);
  assert.equal(due([...base, { type: "checkin_email_queued", at: ago(0.2), data: { step: 16 } }]).due, false, "once per check-in day");
  assert.equal(due(base, NOW - 2 * DAY).due, false, "day 14: not yet");
  assert.equal(due(base, NOW + 6 * DAY).reason, "day 16 went by", "a missed day isn't sent late");
  const day30 = due(base, NOW + 14 * DAY);
  assert.deepEqual([day30.step, day30.n], [30, 2]);
  assert.deepEqual([due(base, NOW + 42 * DAY).step, due(base, NOW + 42 * DAY).n], [58, 4], "day 58 is the last");
  assert.equal(due(base, NOW + 56 * DAY).reason, "past the follow-up window", "day 72 is past the 60-day window");
  assert.equal(checkInEmailDue({ events: base, steps: [14], repeatEvery: 0, now: NOW }).due, false, "a ladder that doesn't repeat has no check-ins");
});

const AI = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, ...LADDER } } } } } });
const savedWith = (checkInEmail) => ({ aiApiKey: "k", conversationAi: AI, outreachAutopilot: { enabled: true, checkInEmail } });
const CONTACTS = {
  "c-email": { firstName: "Brenda", email: "b@example.com" },
  "c-nointro": { firstName: "Rigo", email: "r@example.com" },
  "c-replied": { firstName: "Sam", email: "s@example.com" },
};
const getContact = async (id) => CONTACTS[id] || null;
async function seed(loc) {
  for (const id of Object.keys(CONTACTS)) {
    await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_sent", at: ago(16), address: "14820 SE 172nd St, Renton, WA", source: "conversation", dedupeKey: `os:${id}` });
    if (id !== "c-nointro") await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_email_queued", at: ago(14), source: "conversation", dedupeKey: `outreach_email:${id}` });
  }
  await recordEvent({ store, locationId: loc, contactId: "c-replied", party: "agent", type: "text_summary", at: ago(5), source: "conversation", dedupeKey: "ts:c-replied" });
}

test("on day 16 the agent who had the intro email gets one check-in email, scheduled when it may send itself", async () => {
  const loc = "loc-ci-1";
  await seed(loc);
  const r = await runCheckInEmails({ store, locationId: loc, saved: savedWith({ enabled: true, autoSend: true }), sendsEnabled: true, now: NOW, deps: { getContact } });
  assert.equal(r.queued, 1);
  assert.deepEqual(r.rows.map((x) => x.contactId), ["c-email"]);
  const [draft] = await store.listReplyDrafts(loc, { contactId: "c-email", limit: 5 });
  assert.deepEqual([draft.channel, draft.status, draft.outbound.kind, draft.outbound.step], ["email", "scheduled", "checkin_email", 16]);
  assert.match(draft.reply, /^Hi Brenda,\n\n/);
  assert.ok(DEFAULT_CHECK_IN_EMAILS.some((e) => e.subject === draft.outbound.subject));
  const again = await runCheckInEmails({ store, locationId: loc, saved: savedWith({ enabled: true, autoSend: true }), sendsEnabled: true, now: NOW + 3600000, deps: { getContact } });
  assert.equal(again.queued + again.drafted, 0, "once per check-in day");
});

test("off, nothing; its own auto-send off, the email waits in the outbox", async () => {
  const loc = "loc-ci-2";
  await seed(loc);
  assert.equal((await runCheckInEmails({ store, locationId: loc, saved: savedWith({}), sendsEnabled: true, now: NOW, deps: { getContact } })).rows.length, 0);
  const r = await runCheckInEmails({ store, locationId: loc, saved: savedWith({ enabled: true }), sendsEnabled: true, now: NOW, deps: { getContact } });
  assert.deepEqual([r.queued, r.drafted], [0, 1]);
  const [draft] = await store.listReplyDrafts(loc, { contactId: "c-email", limit: 5 });
  assert.match(draft.autoSend.reason, /check-in emails wait for you/);
});

test("the morning sweep runs the check-in emails after the intro emails", async () => {
  const loc = "loc-ci-3";
  _resetJobs();
  const order = [];
  startFollowUpSweep({ client: {}, locationId: loc, saved: savedWith({ enabled: true, autoSend: true }), store, sendsEnabled: true, now: NOW,
    deps: { paceMs: 0, startProactive: async () => ({ job: { id: "j" } }),
      runIntroEmails: async () => { order.push("intro"); return { queued: 1, drafted: 0, rows: [] }; },
      runCheckInEmails: async () => { order.push("check-in"); return { queued: 2, drafted: 0, rows: [] }; } } });
  const until = Date.now() + 5000;
  while (getFollowUpJob(loc)?.status === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.equal(getFollowUpJob(loc).status, "done", getFollowUpJob(loc).error || "");
  assert.deepEqual(order, ["intro", "check-in"]);
  assert.equal(getFollowUpJob(loc).emailed, 3);
});
