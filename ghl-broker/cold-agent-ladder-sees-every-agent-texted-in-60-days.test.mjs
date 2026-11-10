// cold-agent-ladder-sees-every-agent-texted-in-60-days.test.mjs — the day
// 30, 44 and 58 check-ins to agents who never answered went missing
// (2026-11-09).
//
// The cold ladder reads 60 days of the location's timeline to find the agents
// it texted first: our first text, our follow-ups, their replies, every
// agent's and every buyer's. It read them in one call capped at 5,000 rows,
// and the store keeps the NEWEST rows when it cuts. At the outreach volume of
// October that was about the last three weeks, so an agent first texted a
// month ago was simply not in the read: of 69 day-30 check-ins due by 11/6,
// one went. Reports → Follow-up planned from the same read, so it showed
// nothing missing.
//
// Now the window is walked a page at a time (contact-events.js), once, and
// the follow-up planner reuses that walk instead of making its own.
//
// Real file store, fake GHL, the model never called. Every name, street and
// number here is invented.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-agent-ladder-window-test-"));
process.env.DATA_DIR = dir;
delete process.env.DATABASE_URL;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { followUpDedupeKey } = await import("./shared/follow-up.js");
const { startFollowUpSweep, getFollowUpJob, _resetJobs, outreachCandidates, _resetColdWindow } = await import("./follow-up-sweep.js");
const { followUpEngineFor, _resetPlanMemo } = await import("./follow-up-engine.js");
const { previewProactive, outboundDescriptor, ourLastTexts } = await import("./reply-agent.js");
const { standardText, plainBody } = await import("./shared/standard-texts.js");
const { DEFAULT_CHECK_IN_TEXTS, COLD_LAST_RUNG_TEXTS } = await import("./shared/outreach-opener.js");
await store.init();

const DAY = 86400000, HOUR = 3600000;
// Monday 2026-11-09, 9am Pacific: the morning sweep's hour.
const NOW = Date.parse("2026-11-09T17:00:00Z");
const iso = (t) => new Date(t).toISOString();
const AI = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true,
  ladders: { outreach_nudge: { enabled: true, steps: [2], repeatEvery: 14 } } } } } });
const SAVED = { aiApiKey: "k", conversationAi: AI, outreachAutopilot: { enabled: true } };
const HOUSE = "4410 Quarry Rd, Halden, WA 98011";

// A cold agent: our first text `daysAgo` before NOW, and the rungs that went.
async function seedAgent(loc, contactId, daysAgo, rungs = []) {
  const first = NOW - daysAgo * DAY;
  await recordEvent({ store, locationId: loc, contactId, party: "agent", type: "outreach_sent", at: iso(first), address: HOUSE,
    source: "conversation", dedupeKey: `outreach:${contactId}:first` });
  for (const step of rungs) {
    await recordEvent({ store, locationId: loc, contactId, party: "agent", type: "follow_up_sent", at: iso(first + step * DAY + 2 * HOUR), address: HOUSE,
      source: "conversation", dedupeKey: followUpDedupeKey({ kind: "outreach_nudge", subjectId: contactId, step }), data: { kind: "outreach_nudge", step, ladder: [2] } });
  }
  return first;
}

// `count` replies on other threads, all newer than our agent's first text:
// the busy weeks that pushed them out of the capped read.
async function crowd(loc, count, fromMs, toMs) {
  const per = 20;
  for (let c = 0; c < Math.ceil(count / per); c++) {
    const rows = [];
    for (let k = 0; k < per && c * per + k < count; k++) {
      const n = c * per + k;
      rows.push({ party: "agent", type: "text_summary", at: iso(fromMs + ((n + 1) / (count + 1)) * (toMs - fromMs)), source: "conversation",
        dedupeKey: `crowd:${c}:${k}`, data: { inbound: "nothing new on my end this week" } });
    }
    await store.appendContactEvents(loc, `crowd-${c}`, rows);
  }
}

async function sweep(loc, now, { storeFor = store, saved = SAVED } = {}) {
  _resetJobs();
  const started = [];
  startFollowUpSweep({ client: {}, locationId: loc, saved, store: storeFor, sendsEnabled: true, now,
    deps: { paceMs: 0, startProactive: async (a) => { started.push({ contactId: a.contactId, step: a.subject?.step, subject: a.subject }); return { job: { id: `j${started.length}` } }; },
      runIntroEmails: async () => ({ queued: 0, drafted: 0, rows: [] }), runCheckInEmails: async () => ({ queued: 0, drafted: 0, rows: [] }),
      ghlThread: async () => [{ direction: "outbound", dateAdded: iso(now - 40 * DAY), messageType: "TYPE_SMS" }] } });
  const until = Date.now() + 20000;
  while (getFollowUpJob(loc)?.status === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  const job = getFollowUpJob(loc);
  assert.equal(job.status, "done", job.error || "");
  return { started, job };
}

/* ---------- the read ---------- */

test("an agent first texted 50 days ago still gets the day-58 check-in when the window holds 6,000 other events", async () => {
  const loc = "loc-cold-58";
  _resetColdWindow?.();
  // First texted 50 days ago; day 2, 16, 30 and 44 went. Eight mornings on, day 58 is due.
  await seedAgent(loc, "c-wendell", 50, [2, 16, 30, 44]);
  const sweepAt = NOW + 8 * DAY;
  await crowd(loc, 6000, NOW - 49 * DAY, sweepAt - HOUR);
  const { started } = await sweep(loc, sweepAt);
  assert.deepEqual(started.map((s) => [s.contactId, s.step]), [["c-wendell", 58]]);
});

test("an agent first texted 40 days ago still gets the day-44 check-in when 6,000 newer events exist", async () => {
  const loc = "loc-cold-44";
  _resetColdWindow?.();
  // First texted 40 days ago; day 2, 16 and 30 went. Four mornings on, day 44 is due.
  await seedAgent(loc, "c-priya", 40, [2, 16, 30]);
  const sweepAt = NOW + 4 * DAY;
  await crowd(loc, 6000, NOW - 39 * DAY, sweepAt - HOUR);
  const { started, job } = await sweep(loc, sweepAt);
  assert.deepEqual(started.map((s) => [s.contactId, s.step]), [["c-priya", 44]]);
  assert.ok(!job.readTruncated, "the whole window was read");
});

test("the follow-up planner and the sweep share one read of the cold window", async () => {
  const loc = "loc-cold-shared";
  _resetColdWindow?.();
  _resetPlanMemo();
  await seedAgent(loc, "c-otto", 31, [2, 16]);
  // The GHL workflow's cohort is on too: one walk serves both ladders.
  await recordEvent({ store, locationId: loc, contactId: "c-ghl", party: "agent", type: "outreach_enrolled", at: iso(NOW - 20 * DAY), address: "9 Fern Ct, Halden, WA 98011",
    source: "conversation", dedupeKey: "enrolled:c-ghl", data: { kind: "first" } });
  const reads = [];
  // A cold-ladder read asks for our first texts, our follow-ups, their
  // replies and the offers that end a ladder: nothing else reads all four.
  const isColdRead = (types) => ["outreach_sent", "follow_up_sent", "realm_yes", "call_summary"].every((t) => (types || []).includes(t));
  const counting = Object.assign(Object.create(store), {
    listContactEventsSince: async (l, since, opts = {}) => { if (isColdRead(opts.types)) reads.push("since"); return store.listContactEventsSince(l, since, opts); },
    listContactEventsPage: async (l, since, opts = {}) => { if (isColdRead(opts.types) && !opts.after) reads.push("walk"); return store.listContactEventsPage(l, since, opts); },
  });
  const saved = { ...SAVED, outreachAutopilot: { enabled: true, nudgeGhlCohort: true } };
  const { started } = await sweep(loc, NOW, { storeFor: counting, saved });
  assert.ok(started.some((s) => s.contactId === "c-otto" && s.step === 30), JSON.stringify(started));
  assert.equal(reads.length, 1, `the sweep reads the cold window once for both ladders: ${reads.join(", ")}`);
  const page = await followUpEngineFor({ store: counting, locationId: loc, saved, period: "week", now: NOW + 60000 });
  assert.ok(page, "the planner answers");
  assert.equal(reads.length, 1, `the planner reuses the sweep's read: ${reads.join(", ")}`);
  assert.equal(page.readTruncated, false);
});

test("a cold window read cut short says so on the sweep and on the planner, with counts only", async () => {
  const loc = "loc-cold-cut";
  _resetColdWindow?.();
  _resetPlanMemo();
  await seedAgent(loc, "c-ines", 31, [2, 16]);
  // A store that can't page answers one capped read, and says it was cut.
  const cut = Object.assign(Object.create(store), {
    listContactEventsPage: undefined,
    listContactEventsSince: async (l, since, opts = {}) => {
      const rows = [...await store.listContactEventsSince(l, since, opts)];
      if ((opts.types || []).includes("outreach_sent")) rows.truncated = true;
      return rows;
    },
  });
  const logged = [];
  const warn = console.warn;
  console.warn = (...a) => logged.push(a.join(" "));
  try {
    const { job } = await sweep(loc, NOW, { storeFor: cut });
    assert.equal(job.readTruncated, true);
    const candidates = await outreachCandidates({ store: cut, locationId: loc, config: AI, now: NOW, fresh: true });
    assert.equal(candidates.truncated, true);
    _resetPlanMemo();
    const page = await followUpEngineFor({ store: cut, locationId: loc, saved: SAVED, period: "week", now: NOW + 60000 });
    assert.equal(page.readTruncated, true);
  } finally {
    console.warn = warn;
  }
  const line = logged.find((l) => /cold window/.test(l));
  assert.ok(line, logged.join("\n"));
  assert.doesNotMatch(line, /c-ines|Quarry|Halden/, "counts only, never a contact or a street");
});

/* ---------- the text ---------- */

const rungDescriptor = (step, subject = {}) => outboundDescriptor({ kind: "outreach_nudge", offer: null, saved: {},
  subject: { address: HOUSE, step, steps: [2], repeatEvery: 14, ...subject } });

test("a cold agent's day 30 names their town, day 58 says it's the last, and none names the first-text house", () => {
  for (const contactId of ["c-a1", "c-a2", "c-a3", "c-a4", "c-a5", "c-a6"]) {
    const day30 = standardText({ kind: "outreach_nudge", outbound: rungDescriptor(30), name: "Wendell Okafor", contactId });
    const day58 = standardText({ kind: "outreach_nudge", outbound: rungDescriptor(58), name: "Wendell Okafor", contactId });
    assert.match(day30.text, /Halden/, day30.text);
    assert.doesNotMatch(day30.text, /Quarry/, day30.text);
    assert.equal(day58.set, "cold_last", day58.text);
    assert.doesNotMatch(day58.text, /Quarry/, day58.text);
  }
  assert.equal(rungDescriptor(58).repeatMax, 4, "day 58 is the fourth and last repeat inside the 60-day window");
});

test("a town written in capitals or lower case reads the way people write it in the check-in", () => {
  const caps = rungDescriptor(30, { address: "4410 QUARRY RD, NORTH HALDEN, WA 98011" });
  assert.equal(caps.city, "North Halden");
  const low = rungDescriptor(30, { address: "4410 quarry rd, north halden, wa 98011" });
  assert.equal(low.city, "North Halden");
  assert.equal(rungDescriptor(30, { address: "4410 Quarry Rd, McHalden, WA 98011" }).city, "McHalden", "a town already written properly stays as written");
  const t = standardText({ kind: "outreach_nudge", outbound: caps, name: "Wendell", contactId: "c-a1" });
  assert.doesNotMatch(t.text, /NORTH HALDEN/, t.text);
});

test("a new listing of theirs rides into the check-in by its street; one we've already talked about doesn't", () => {
  const fresh = { street: "Larch Ave", address: "88 Larch Ave, Halden, WA 98011", city: "Halden" };
  const o = rungDescriptor(30, { freshListing: fresh });
  assert.deepEqual(o.freshListing, fresh);
  const t = standardText({ kind: "outreach_nudge", outbound: o, name: "Wendell", contactId: "c-a1" });
  assert.match(t.text, /Larch Ave/, t.text);
});

test("our last texts are read off the thread, newest first, calls left out", () => {
  const transcript = [
    "[2026-10-01 17:00] US sms: Hi Wendell, saw your listing at 4410 Quarry Rd.",
    "[2026-10-03 17:00] US call",
    "[2026-10-03 18:00] THEM sms: not this one",
    "[2026-10-17 17:00] US sms: Hey Wendell, anything on your end?",
  ].join("\n");
  assert.deepEqual(ourLastTexts(transcript, 6), ["Hey Wendell, anything on your end?", "Hi Wendell, saw your listing at 4410 Quarry Rd."]);
  assert.deepEqual(ourLastTexts(transcript, 1), ["Hey Wendell, anything on your end?"]);
  assert.deepEqual(ourLastTexts("", 6), []);
});

test("the check-in never sends the text our thread already has, and drops a listing the thread already named", async () => {
  const contactId = "c-thread";
  const would = standardText({ kind: "outreach_nudge", outbound: rungDescriptor(30), name: "Wendell", contactId }).text;
  const recent = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
  const thread = (extra = []) => [
    { id: "m1", direction: "outbound", messageType: "TYPE_SMS", body: "Hi Wendell, saw your listing at 4410 Quarry Rd. Does it need much work?", dateAdded: recent(30) },
    { id: "m2", direction: "outbound", messageType: "TYPE_SMS", body: would, dateAdded: recent(14) },
    ...extra,
  ];
  const clientWith = (messages) => ({ call: async (p) => {
    if (p.startsWith(`/contacts/${contactId}`)) return { contact: { id: contactId, firstName: "Wendell", lastName: "Okafor", tags: ["agent"] } };
    if (p.startsWith("/conversations/search")) return { conversations: [{ id: "cv1" }] };
    if (p.startsWith("/conversations/cv1/messages")) return { messages: { messages, nextPage: false } };
    return {};
  } });
  const saved = { aiApiKey: "k", conversationAi: AI };
  const draft = async () => { throw new Error("no model call for a fixed text"); };
  const r = await previewProactive({ client: clientWith(thread()), locationId: "loc-preview", saved, store, contactId, kind: "outreach_nudge",
    subject: { address: HOUSE, step: 30, steps: [2], repeatEvery: 14 }, deps: { draft } });
  assert.ok(r.reply, JSON.stringify(r));
  assert.notEqual(plainBody(r.reply, "Wendell"), plainBody(would, "Wendell"), r.reply);
  assert.equal(r.held, false, `the gates pass it: ${(r.flags || []).join(" · ")}`);
  // Their new listing was already in the thread: the plain check-in, not that listing again.
  const fresh = { street: "Larch Ave", address: "88 Larch Ave, Halden, WA 98011", city: "Halden" };
  const named = thread([{ id: "m3", direction: "outbound", messageType: "TYPE_SMS", body: "Saw 88 Larch Ave came up, nice one.", dateAdded: recent(3) }]);
  const r2 = await previewProactive({ client: clientWith(named), locationId: "loc-preview", saved, store, contactId, kind: "outreach_nudge",
    subject: { address: HOUSE, step: 30, steps: [2], repeatEvery: 14, freshListing: fresh }, deps: { draft } });
  assert.doesNotMatch(r2.reply, /Larch/, r2.reply);
  const r3 = await previewProactive({ client: clientWith(thread()), locationId: "loc-preview", saved, store, contactId, kind: "outreach_nudge",
    subject: { address: HOUSE, step: 30, steps: [2], repeatEvery: 14, freshListing: fresh }, deps: { draft } });
  assert.match(r3.reply, /Larch Ave/, r3.reply);
  assert.ok(DEFAULT_CHECK_IN_TEXTS.length >= 6 && COLD_LAST_RUNG_TEXTS.length >= 2);
});

test("a new listing our last check-in named by its street isn't named again two weeks later", async () => {
  // Day 30 named their new one by street alone ("saw you've got Larch Ave up
  // now"), so the house-number check never sees it. Freshness set wide
  // (Settings → pulse.freshDays), the same listing is still new on day 44.
  const contactId = "c-street-twice";
  const fresh = { street: "Larch Ave", address: "88 Larch Ave, Halden, WA 98011", city: "Halden" };
  const day30 = standardText({ kind: "outreach_nudge", outbound: rungDescriptor(30, { freshListing: fresh }), name: "Wendell", contactId }).text;
  assert.match(day30, /Larch Ave/, day30);
  const recent = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
  const messages = [
    { id: "s1", direction: "outbound", messageType: "TYPE_SMS", body: "Hi Wendell, saw your listing at 4410 Quarry Rd. Does it need much work?", dateAdded: recent(44) },
    { id: "s2", direction: "outbound", messageType: "TYPE_SMS", body: day30, dateAdded: recent(14) },
  ];
  const client = { call: async (p) => {
    if (p.startsWith(`/contacts/${contactId}`)) return { contact: { id: contactId, firstName: "Wendell", lastName: "Okafor", tags: ["agent"] } };
    if (p.startsWith("/conversations/search")) return { conversations: [{ id: "cv2" }] };
    if (p.startsWith("/conversations/cv2/messages")) return { messages: { messages, nextPage: false } };
    return {};
  } };
  const r = await previewProactive({ client, locationId: "loc-preview", saved: { aiApiKey: "k", conversationAi: AI }, store, contactId, kind: "outreach_nudge",
    subject: { address: HOUSE, step: 44, steps: [2], repeatEvery: 14, freshListing: fresh },
    deps: { draft: async () => { throw new Error("no model call for a fixed text"); } } });
  assert.ok(r.reply, JSON.stringify(r));
  assert.doesNotMatch(r.reply, /Larch/, r.reply);
  assert.match(r.reply, /Halden/, "the plain check-in, by their town");
});

test("every cold check-in text gets past the reply agent's gates as it would go", async () => {
  const fresh = { street: "Larch Ave", address: "88 Larch Ave, Halden, WA 98011", city: "Halden" };
  const saved = { aiApiKey: "k", conversationAi: AI };
  const draft = async () => { throw new Error("no model call for a fixed text"); };
  const seen = new Set();
  for (let i = 0; i < 14; i++) {
    const contactId = `c-gate-${i}`;
    const client = { call: async (p) => {
      if (p.startsWith(`/contacts/${contactId}`)) return { contact: { id: contactId, firstName: "Wendell", lastName: "Okafor", tags: ["agent"] } };
      if (p.startsWith("/conversations/search")) return { conversations: [] };
      return {};
    } };
    for (const [step, more] of [[16, {}], [30, {}], [44, {}], [58, {}], [30, { freshListing: fresh }]]) {
      const r = await previewProactive({ client, locationId: "loc-gates", saved, store, contactId, kind: "outreach_nudge",
        subject: { address: HOUSE, step, steps: [2], repeatEvery: 14, ...more }, deps: { draft } });
      assert.ok(r.reply, JSON.stringify(r));
      assert.equal(r.held, false, `${r.reply}: ${(r.flags || []).join(" · ")}`);
      seen.add(r.reply);
    }
  }
  assert.ok(seen.size >= 10, `${seen.size} different texts`);
});
