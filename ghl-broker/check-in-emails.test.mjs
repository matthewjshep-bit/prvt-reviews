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
const { normalizeCheckInEmail, checkInEmailFor, checkInEmailDue, DEFAULT_CHECK_IN_EMAILS, areaOf, townOf, introEmailFor } = await import("./shared/outreach-email.js");
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
    assert.doesNotMatch(e.body, /rather not get these/i, "Matt took the opt-out line out");
    assert.match(e.body, /near \{town\}/, "names where they work, and reads 'near you' when that won't fit");
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
  assert.equal(due(base, NOW + 7 * DAY).reason, "day 16 went by", "a missed day isn't sent late (six days' grace for the wait after the text)");
  const day30 = due(base, NOW + 14 * DAY);
  assert.deepEqual([day30.step, day30.n], [30, 2]);
  assert.deepEqual([due(base, NOW + 42 * DAY).step, due(base, NOW + 42 * DAY).n], [58, 4], "day 58 is the last");
  assert.equal(due(base, NOW + 56 * DAY).reason, "past the follow-up window", "day 72 is past the 60-day window");
  assert.equal(checkInEmailDue({ events: base, steps: [14], repeatEvery: 0, now: NOW }).due, false, "a ladder that doesn't repeat has no check-ins");
});

test("the emails name where the agent works: the listing's town, else its county", () => {
  assert.equal(areaOf({ address: "14820 SE 172nd St, Renton, WA 98058", county: "King" }), "Renton or the surrounding areas");
  assert.equal(areaOf({ address: "1 Elm St", county: "Pierce County" }), "Pierce County or the surrounding areas");
  assert.equal(areaOf({}), "your area");
  for (const n of [1, 2, 3, 4]) {
    const e = checkInEmailFor({ checkInEmail: {}, name: "Brenda", contactId: "c-1", n, address: "5232 S Yakima Ave, Tacoma, WA", county: "Pierce" });
    assert.match(e.body, /near Tacoma/, e.subject);
    assert.doesNotMatch(e.body, /\{(?:area|town)\}/);
  }
  assert.match(introEmailFor({ introEmail: {}, name: "Brenda", address: "1 Elm St", county: "Snohomish" }).body, /fixers near Snohomish County\?/);
  // {area} still fills for wording a person wrote with it.
  assert.match(introEmailFor({ introEmail: { body: "Hi {first}, anything around {area}?" }, name: "Brenda", address: "5232 S Yakima Ave, Tacoma, WA" }).body, /around Tacoma or the surrounding areas\?/);
});

// 2026-11-02, Matt: "keep the email outreach emails to under 100 characters
// but personalized". The intro read 480 characters and the check-ins 230–300.
test("every outreach email is under 100 characters and still says their name and town", () => {
  const agents = [
    { name: "Brenda Smith", address: "14820 SE 172nd St, Renton, WA 98058" },
    { name: "Jo", address: "1 Elm St", county: "Snohomish" },
    { name: "Christopher Montgomery", address: "1 Main St, Mountlake Terrace, WA" },
    { name: "Bartholomew", address: "9 Oak Ave, University Place, WA" },
    { name: "Brenda" },
  ];
  for (const a of agents) {
    const first = a.name.split(" ")[0];
    const intro = introEmailFor({ introEmail: {}, ...a });
    assert.ok(intro.body.length < 100, `${intro.body.length}: ${intro.body}`);
    assert.ok(intro.body.startsWith(`Hi ${first},`));
    for (const n of [1, 2, 3, 4]) {
      const e = checkInEmailFor({ checkInEmail: {}, contactId: "c-1", n, ...a });
      assert.ok(e.body.length < 100, `${e.body.length}: ${e.body}`);
      assert.ok(e.body.startsWith(`Hi ${first},`));
      assert.doesNotMatch(e.body, /\{/);
    }
  }
  // The town when it fits; "near you" when a long name and town wouldn't.
  assert.match(introEmailFor({ introEmail: {}, ...agents[0] }).body, /near Renton\?/);
  assert.match(introEmailFor({ introEmail: {}, ...agents[2] }).body, /near you\?/);
  assert.match(introEmailFor({ introEmail: {}, ...agents[4] }).body, /near you\?/);
  assert.equal(townOf({ address: "1 Elm St", county: "Pierce County" }), "Pierce County");
  // A check-in that can't fit gives way to the next one that does.
  const long = { emails: [{ subject: "a", body: `Hi {first},\n\n${"so much to say ".repeat(8)}` }, { subject: "b", body: "Hi {first}, short one." }] };
  assert.equal(checkInEmailFor({ checkInEmail: long, name: "Brenda", contactId: "c-1", n: 1 }).subject, "b");
  // Wording a person wrote that runs long still goes when nothing shorter is there.
  assert.ok(checkInEmailFor({ checkInEmail: { emails: [long.emails[0]] }, name: "Brenda", contactId: "c-1", n: 1 }).body.length > 99);
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
  assert.match(draft.reply, /Renton/, "the town of the listing we texted them about");
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
