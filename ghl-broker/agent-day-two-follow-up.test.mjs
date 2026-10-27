// agent-day-two-follow-up.test.mjs — a cold agent hears from us on day 2,
// then a check-in every 14 days, and gets one introduction email on day 2
// (2026-10-20).
//
// Matt: "Currently, it's 14 days later … Let's edit that to 2 days later …
// 'Hey Brenda, following up on my earlier message. Not sure if that listing
// was distressed, needed work …' … and then check in every 14 days after
// that." And: "include an initial email to that agent introducing ourselves,
// telling them a little bit about what we do (including our website), and
// asking if they have any distressed properties. Maybe we do that on day 2."
// Until now a rung past the last step (a repeat) read as step 1 and sent
// follow-up 1 again word for word.
//
// Real file store (events + dedupe + drafts), fake GHL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "day-two-follow-up-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { standardText } = await import("./shared/standard-texts.js");
const { normalizeOpener, DEFAULT_FOLLOW_UP_TEXTS, PREVIOUS_DEFAULT_FOLLOW_UP_TEXTS, DEFAULT_CHECK_IN_TEXTS } = await import("./shared/outreach-opener.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { DEFAULT_LADDERS, dueStep } = await import("./shared/follow-up.js");
const { outboundDescriptor } = await import("./reply-agent.js");
const { normalizeIntroEmail, introEmailFor, introEmailDue } = await import("./shared/outreach-email.js");
const { runIntroEmails } = await import("./outreach-email.js");
const { startFollowUpSweep, getFollowUpJob, _resetJobs } = await import("./follow-up-sweep.js");
const { carrierFlags } = await import("./shared/carrier-words.js");
await store.init();

const DAY = 86400000;
const NOW = Date.parse("2026-10-22T16:30:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const LADDER = { steps: [2], repeatEvery: 14 };
const nudge = (step, saved = {}) => outboundDescriptor({ kind: "outreach_nudge", offer: null, saved,
  subject: { address: "14820 SE 172nd St, Renton, WA 98058", step, steps: LADDER.steps, repeatEvery: LADDER.repeatEvery } });
const textOn = (step, contactId = "c-brenda", saved = {}) => standardText({ kind: "outreach_nudge", outbound: nudge(step, saved), name: "Brenda", contactId })?.text;

/* ---------- the texts ---------- */

test("a cold agent's follow-up goes on day 2, then every 14 days", () => {
  assert.deepEqual(DEFAULT_LADDERS.outreach_nudge.steps, [2]);
  assert.equal(DEFAULT_LADDERS.outreach_nudge.repeatEvery, 14);
  const n = normalizeConversationAi({}).parties.agent.followUp.ladders.outreach_nudge;
  assert.deepEqual([n.steps, n.repeatEvery], [[2], 14]);
});

test("the old six-step default saved verbatim reads as day 2 and every 14, repeat and all", () => {
  const n = normalizeConversationAi({ parties: { agent: { followUp: { ladders: { outreach_nudge: { enabled: true, steps: [2, 5, 9, 14, 21, 30], repeatEvery: 0 } } } } } })
    .parties.agent.followUp.ladders.outreach_nudge;
  assert.deepEqual([n.steps, n.repeatEvery, n.enabled], [[2], 14, true]);
  const mine = normalizeConversationAi({ parties: { agent: { followUp: { ladders: { outreach_nudge: { steps: [14], repeatEvery: 0 } } } } } })
    .parties.agent.followUp.ladders.outreach_nudge;
  assert.deepEqual([mine.steps, mine.repeatEvery], [[14], 0], "a ladder Matt set himself is kept as he set it");
});

// Since 2026-10-26 it names the house (fewer-stops.test.mjs): "Not sure if
// that listing needs work" drew a STOP for every 4 replies.
test("the day-2 follow-up names their house", () => {
  assert.equal(textOn(2), "Hey Brenda, circling back on 14820 SE 172nd St. If it's not a fit, no worries. Any fixers or houses that need some TLC on your radar, on or off market?");
  assert.deepEqual(carrierFlags(DEFAULT_FOLLOW_UP_TEXTS[0]), []);
});

test("the old pair of default follow-ups, saved by the chart, reads as today's", () => {
  assert.deepEqual(normalizeOpener({ followUps: PREVIOUS_DEFAULT_FOLLOW_UP_TEXTS }).followUps, DEFAULT_FOLLOW_UP_TEXTS);
  assert.deepEqual(normalizeOpener({ followUps: ["Hi {first}, mine?"] }).followUps, ["Hi {first}, mine?"]);
});

test("a check-in 14 days after the follow-up is a check-in, not follow-up 1 again", () => {
  for (const contactId of ["c-brenda", "c-1", "c-2", "c-3"]) {
    const first = textOn(2, contactId);
    const checkIn = textOn(16, contactId);
    assert.notEqual(checkIn, first, contactId);
    assert.ok(DEFAULT_CHECK_IN_TEXTS.map((t) => t.replace("{first}", "Brenda")).includes(checkIn), checkIn);
  }
});

test("two check-ins in a row are never the same text", () => {
  for (const contactId of ["c-brenda", "c-1", "c-2"]) {
    const texts = [16, 30, 44, 58].map((d) => textOn(d, contactId));
    for (let i = 1; i < texts.length; i++) assert.notEqual(texts[i], texts[i - 1], `${contactId} day ${[16, 30, 44, 58][i]}`);
  }
  for (const t of DEFAULT_CHECK_IN_TEXTS) assert.deepEqual(carrierFlags(t), [], t);
});

test("Matt's own check-ins are the ones that go", () => {
  const saved = { outreachAutopilot: { opener: { checkIns: ["Hi {first}, mine one?", "Hi {first}, mine two?"] } } };
  assert.equal(textOn(16, "c-brenda", saved).startsWith("Hi Brenda, mine"), true);
  assert.notEqual(textOn(16, "c-brenda", saved), textOn(30, "c-brenda", saved));
});

test("an agent texted 16 days ago who had the day-2 follow-up is due the day-16 check-in", () => {
  const d = dueStep({ ...LADDER, startedAt: ago(16), sentSteps: [2], now: NOW, minHoursBetween: 72 });
  assert.deepEqual([d.due, d.step], [true, 16]);
  const early = dueStep({ ...LADDER, startedAt: ago(1), sentSteps: [], now: NOW });
  assert.equal(early.due, false);
  assert.deepEqual(dueStep({ ...LADDER, startedAt: ago(2), sentSteps: [], now: NOW }).step, 2);
});

/* ---------- the intro email ---------- */

test("the intro email is off and waits for Matt until he says otherwise, on day 2", () => {
  const ie = normalizeIntroEmail({});
  assert.deepEqual([ie.enabled, ie.autoSend, ie.day], [false, false, 2]);
});

test("the intro email says who we are, what we buy, the website, and asks for distressed properties", () => {
  const e = introEmailFor({ introEmail: {}, name: "Brenda Jones", address: "14820 SE 172nd St, Renton, WA 98058" });
  assert.match(e.body, /^Hi Brenda,\n\n/);
  assert.match(e.body, /Shep Flips/);
  assert.match(e.body, /https:\/\/shepflips\.com/);
  assert.match(e.body, /distressed/);
  assert.match(e.body, /\n\nThanks,\nMatt Shepherd\nShep Flips$/, "the paragraphs and the sign-off lines keep their shape");
  assert.ok(e.subject.length > 0);
  assert.match(introEmailFor({ introEmail: {}, name: "", address: "" }).body, /^Hi,\n\n/);
});

test("the intro email goes from day 2, once, only to an agent who hasn't answered", () => {
  const first = { type: "outreach_sent", at: ago(2), address: "1 Elm St" };
  assert.equal(introEmailDue({ events: [first], now: NOW }).due, true);
  assert.equal(introEmailDue({ events: [{ ...first, at: ago(1) }], now: NOW }).due, false);
  assert.equal(introEmailDue({ events: [first, { type: "text_summary", at: ago(1) }], now: NOW }).due, false);
  assert.equal(introEmailDue({ events: [first, { type: "outreach_email_queued", at: ago(0.5) }], now: NOW }).due, false);
  assert.equal(introEmailDue({ events: [{ ...first, at: ago(30) }], now: NOW }).due, false, "switching it on doesn't email a month of agents");
});

const LOC = "loc-email";
const AI = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, ...LADDER } } } } } });
const savedWith = (introEmail) => ({ aiApiKey: "k", conversationAi: AI, outreachAutopilot: { enabled: true, introEmail } });
const CONTACTS = {
  "c-email": { firstName: "Brenda", lastName: "Jones", email: "b@example.com" },
  "c-noemail": { firstName: "Rigo", email: "" },
  "c-optout": { firstName: "Dana", email: "d@example.com", dndSettings: { Email: { status: "active" } } },
  "c-replied": { firstName: "Sam", email: "s@example.com" },
};
const getContact = async (id) => CONTACTS[id] || null;

async function seed(loc) {
  for (const id of Object.keys(CONTACTS)) {
    await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_sent", at: ago(2), address: "14820 SE 172nd St, Renton, WA 98058", source: "conversation", dedupeKey: `outreach_sent:${id}` });
  }
  await recordEvent({ store, locationId: loc, contactId: "c-replied", party: "agent", type: "text_summary", at: ago(1), source: "conversation", dedupeKey: "ts:c-replied" });
}

test("on day 2 an agent with an email gets one intro email, scheduled when it may send itself", async () => {
  const loc = `${LOC}-1`;
  await seed(loc);
  const r = await runIntroEmails({ store, locationId: loc, saved: savedWith({ enabled: true, autoSend: true }), sendsEnabled: true, now: NOW, deps: { getContact } });
  assert.equal(r.queued, 1);
  const byId = Object.fromEntries(r.rows.map((x) => [x.contactId, x]));
  assert.equal(byId["c-email"].status, "scheduled");
  assert.equal(byId["c-noemail"].reason, "no email in GHL");
  assert.equal(byId["c-optout"].reason, "they opted out of email");
  assert.equal(byId["c-replied"], undefined, "an agent who answered isn't introduced to");
  const [draft] = await store.listReplyDrafts(loc, { contactId: "c-email", limit: 5 });
  assert.equal(draft.channel, "email");
  assert.equal(draft.status, "scheduled");
  assert.equal(draft.outbound.kind, "outreach_email");
  assert.ok(draft.outbound.subject);
  assert.match(draft.reply, /^Hi Brenda,/);
  assert.ok(Date.parse(draft.sendAt) >= NOW);

  const again = await runIntroEmails({ store, locationId: loc, saved: savedWith({ enabled: true, autoSend: true }), sendsEnabled: true, now: NOW + 3600000, deps: { getContact } });
  assert.equal(again.queued + again.drafted, 0, "once per agent");
});

test("with sends off, or its own auto-send off, the intro email waits in the outbox", async () => {
  const loc = `${LOC}-2`;
  await seed(loc);
  const r = await runIntroEmails({ store, locationId: loc, saved: savedWith({ enabled: true }), sendsEnabled: true, now: NOW, deps: { getContact } });
  assert.deepEqual([r.queued, r.drafted], [0, 1]);
  const [draft] = await store.listReplyDrafts(loc, { contactId: "c-email", limit: 5 });
  assert.equal(draft.status, "draft");
  assert.match(draft.autoSend.reason, /wait for you/);
});

test("off, nothing is emailed; a dry run claims nothing; a stopped agent isn't emailed", async () => {
  const loc = `${LOC}-3`;
  await seed(loc);
  const off = await runIntroEmails({ store, locationId: loc, saved: savedWith({}), sendsEnabled: true, now: NOW, deps: { getContact } });
  assert.equal(off.rows.length, 0);
  const dry = await runIntroEmails({ store, locationId: loc, saved: savedWith({ enabled: true, autoSend: true }), sendsEnabled: true, now: NOW, dryRun: true, deps: { getContact } });
  assert.equal(dry.rows.find((x) => x.contactId === "c-email").status, "would email");
  const held = await runIntroEmails({ store, locationId: loc, saved: savedWith({ enabled: true, autoSend: true }), sendsEnabled: true, now: NOW, deps: { getContact }, held: (id) => id === "c-email" });
  assert.equal(held.rows.find((x) => x.contactId === "c-email").reason, "you stopped the bot on them");
  assert.equal((await store.listReplyDrafts(loc, { contactId: "c-email", limit: 5 })).length, 0);
});

test("the morning sweep sends the intro email with the day-2 follow-up", async () => {
  const loc = `${LOC}-4`;
  await seed(loc);
  _resetJobs();
  const started = [];
  const emailed = [];
  startFollowUpSweep({ client: {}, locationId: loc, saved: savedWith({ enabled: true, autoSend: true }), store, sendsEnabled: true, now: NOW,
    deps: { paceMs: 0, startProactive: async (a) => { started.push(a.contactId); return { job: { id: "j" } }; },
      runIntroEmails: async (a) => { emailed.push(a.locationId); return { queued: 1, drafted: 0, rows: [] }; } } });
  const until = Date.now() + 5000;
  while (getFollowUpJob(loc)?.status === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.equal(getFollowUpJob(loc).status, "done", getFollowUpJob(loc).error || "");
  assert.ok(started.includes("c-email"), "the day-2 text starts");
  assert.deepEqual(emailed, [loc]);
  assert.equal(getFollowUpJob(loc).emailed, 1);
});
