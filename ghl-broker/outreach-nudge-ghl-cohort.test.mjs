// outreach-nudge-ghl-cohort.test.mjs — the agents the GHL workflow texted
// first get the app's follow-up (outreachAutopilot.nudgeGhlCohort), and one
// system owns it. Real file store (events + dedupe), fake GHL.
//
// 2026-10-16: 195 agents whose first text was the GHL workflow's, who never
// answered, had heard nothing in 15 to 45 days. The check-in left them to
// "the outreach follow-up workflow", which had sent about 73 texts in two
// weeks to the whole cohort.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-nudge-ghl-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { startFollowUpSweep, getFollowUpJob, _resetJobs, afterFirstText, FIRST_TEXT_GRACE_HOURS } = await import("./follow-up-sweep.js");
const { startOutreachFollowUp, _resetJobs: resetGhlFollowUp } = await import("./outreach-followup.js");
const { normalizeOutreachAutopilot } = await import("./outreach-sweep.js");
const { planAgentPulse } = await import("./agent-pulse.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { evaluateAgent, normalizeAgentPulse } = await import("./shared/agent-pulse.js");
await store.init();

const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.parse("2026-10-16T16:30:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (loc) => {
  await pause(20);
  const until = Date.now() + 5000;
  while (getFollowUpJob(loc)?.status === "running" && Date.now() < until) await pause(5);
};

const CONFIG = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: {
  outreach_nudge: { enabled: true, steps: [14], repeatEvery: 0 },
} } } } });
const savedWith = (oa = {}) => ({ aiApiKey: "k", conversationAi: CONFIG,
  outreachAutopilot: { enabled: true, followUpEnabled: false, followUpWorkflowId: "wf-follow", nudgeGhlCohort: true, ...oa } });

const sms = (direction, daysAgo, over = {}) => ({ direction, messageType: "TYPE_SMS", dateAdded: ago(daysAgo), body: direction === "inbound" ? "Who is this?" : "Hi, is your listing a project?", ...over });

// Agents imported into a county batch and enrolled in the GHL first-text
// workflow 30 days ago; the GHL follow-up workflow enrolled them at day 14.
async function seed(loc, ids, { batchName = "Autopilot · Pierce, WA", hookCounty = "Pierce", followUpEnrolled = true } = {}) {
  const batch = await store.createOutreachBatch(loc, { name: batchName });
  await store.upsertOutreachAgents(loc, batch.id, ids.map((id, i) => ({ agentKey: `k-${id}`,
    doc: { name: "Dana Agent", hook: { address: `${i + 10} Birch Ln, Tacoma, WA 98404`, ...(hookCounty ? { county: hookCounty } : {}) } } })));
  for (const [i, id] of ids.entries()) {
    await store.setOutreachAgentStatus(loc, batch.id, `k-${id}`, { status: "imported", contactId: id, importedAt: ago(30) });
    await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_enrolled", at: ago(30), source: "import",
      address: `${i + 10} Birch Ln, Tacoma, WA 98404`, ref: batch.id, dedupeKey: `outreach_enrolled:first:${id}`,
      data: { kind: "first", workflowId: "wf-first", batchId: batch.id } });
    if (followUpEnrolled) {
      await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_enrolled", at: ago(16), source: "sweep",
        ref: id, dedupeKey: `outreach_enrolled:followup:${id}`, data: { kind: "followup", workflowId: "wf-follow", firstEnrolledAt: ago(30) } });
    }
  }
  return batch;
}

function run(loc, { saved = savedWith(), threads = {}, dryRun = false, client = {}, deps = {} } = {}) {
  const started = [];
  const removed = [];
  const reads = [];
  const job = startFollowUpSweep({
    client, locationId: loc, saved, store, sendsEnabled: true, now: NOW, dryRun,
    deps: {
      paceMs: 0,
      startProactive: async (args) => { started.push(args); return { skipped: null, job: { id: `j-${args.contactId}` } }; },
      ghlThread: async (id) => { reads.push(id); const t = threads[id]; if (t instanceof Error) throw t; return t || []; },
      removeFromWorkflow: async (id, wf) => { removed.push([id, wf]); },
      ...deps,
    },
  });
  return { job, started, removed, reads };
}
const claims = async (loc, id) => (await store.listContactEvents(loc, id, { types: ["follow_up_sent"], limit: 20 }))
  .filter((e) => e.data?.kind === "outreach_nudge");

test("the follow-up switch for the GHL cohort ships off", () => {
  assert.equal(normalizeOutreachAutopilot({}).nudgeGhlCohort, false);
  assert.equal(normalizeOutreachAutopilot({ nudgeGhlCohort: "yes" }).nudgeGhlCohort, false);
  assert.equal(normalizeOutreachAutopilot({ nudgeGhlCohort: true }).nudgeGhlCohort, true);
});

test("an agent the GHL workflow texted first, who never heard from us again, gets the app's follow-up in their county", async () => {
  const loc = "loc-ghl-quiet";
  await seed(loc, ["c-quiet"]);
  _resetJobs();
  const { job, started, removed } = run(loc, { threads: { "c-quiet": [sms("outbound", 30)] } });
  await settle(loc);
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, "outreach_nudge");
  assert.equal(started[0].contactId, "c-quiet");
  assert.equal(started[0].subject.address, "10 Birch Ln, Tacoma, WA 98404", "the listing the first text was about");
  assert.equal(started[0].subject.county, "Pierce", "the nudge names their county and nowhere else");
  assert.equal(started[0].subject.step, 14);
  assert.deepEqual(removed, [["c-quiet", "wf-follow"]], "out of the GHL follow-up workflow, so GHL can't double it");
  assert.equal((await claims(loc, "c-quiet")).length, 1);
  const left = (await store.listContactEvents(loc, "c-quiet", { types: ["workflow_left"], limit: 5 }))[0];
  assert.equal(left?.data?.workflowId, "wf-follow");
  assert.equal((await store.listContactEvents(loc, "c-quiet", { types: ["outreach_left"], limit: 5 })).length, 0,
    "never outreach_left: that one means they wrote back");
  assert.equal(job.results.find((r) => r.contactId === "c-quiet").ghlFollowUp, "removed");

  // The next morning: the rung is spent, nothing more.
  _resetJobs();
  const again = startFollowUpSweep({ client: {}, locationId: loc, saved: savedWith(), store, sendsEnabled: true, now: NOW + DAY,
    deps: { paceMs: 0, startProactive: async (a) => { started.push(a); return { job: { id: "x" } }; }, ghlThread: async () => [sms("outbound", 30)], removeFromWorkflow: async () => {} } });
  await settle(loc);
  assert.equal(again.status, "done", again.error);
  assert.equal(started.length, 1);
});

test("one who wrote back in GHL, or whom GHL already texted again, is skipped and nothing is claimed", async () => {
  const loc = "loc-ghl-skip";
  await seed(loc, ["c-wrote", "c-followed", "c-failed-followup", "c-unread", "c-nothing"]);
  _resetJobs();
  const { job, started, removed } = run(loc, { threads: {
    "c-wrote": [sms("outbound", 30), sms("inbound", 29)],
    "c-followed": [sms("outbound", 30), sms("outbound", 15)],
    // GHL's follow-up went, but the carrier refused it: it never reached them.
    "c-failed-followup": [sms("outbound", 30), sms("outbound", 15, { status: "failed" })],
    "c-unread": Object.assign(new Error("forbidden"), { status: 403 }),
    "c-nothing": [],
  } });
  await settle(loc);
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(started.map((s) => s.contactId), ["c-failed-followup"]);
  const why = (id) => job.results.find((r) => r.contactId === id)?.reason || "";
  assert.match(why("c-wrote"), /wrote back in GHL/);
  assert.match(why("c-followed"), /texted them again/);
  assert.match(why("c-unread"), /conversations\.readonly/);
  assert.match(why("c-nothing"), /no first text/);
  for (const id of ["c-wrote", "c-followed", "c-unread", "c-nothing"]) assert.equal((await claims(loc, id)).length, 0, id);
  assert.deepEqual(removed.map(([id]) => id), ["c-failed-followup"], "only a nudge that goes takes them out of the workflow");
});

test("a text of ours since the first one, an offer, or the app's own first text takes them off this ladder", async () => {
  const loc = "loc-ghl-ours";
  await seed(loc, ["c-pinged", "c-offered", "c-app", "c-plain"]);
  await recordEvent({ store, locationId: loc, contactId: "c-pinged", party: "agent", type: "agent_pulse_texted", at: ago(10), source: "conversation", dedupeKey: "p1" });
  await recordEvent({ store, locationId: loc, contactId: "c-offered", party: "agent", type: "offer_sent", at: ago(8), source: "offer", dedupeKey: "o1" });
  // The app's own first text: the app ladder counts from it (not due yet).
  await recordEvent({ store, locationId: loc, contactId: "c-app", party: "agent", type: "outreach_sent", at: ago(5), source: "conversation", dedupeKey: "s1", data: { county: "Pierce" } });
  _resetJobs();
  const threads = Object.fromEntries(["c-pinged", "c-offered", "c-app", "c-plain"].map((id) => [id, [sms("outbound", 30)]]));
  const { job, started, reads } = run(loc, { threads });
  await settle(loc);
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(started.map((s) => s.contactId), ["c-plain"]);
  assert.deepEqual(reads, ["c-plain"], "GHL is asked only about candidates");
});

test("with the switch off the GHL cohort is GHL's, as before: nobody is read or texted", async () => {
  const loc = "loc-ghl-off";
  await seed(loc, ["c-off"]);
  _resetJobs();
  const { job, started, reads, removed } = run(loc, { saved: savedWith({ nudgeGhlCohort: false, followUpEnabled: true }), threads: { "c-off": [sms("outbound", 30)] } });
  await settle(loc);
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 0);
  assert.equal(reads.length, 0);
  assert.equal(removed.length, 0);
});

test("a dry run reads GHL and says who would get it, in which county, and claims and removes nothing", async () => {
  const loc = "loc-ghl-dry";
  // No county on the row: the batch the sweep imported them into says it.
  await seed(loc, ["c-dry"], { hookCounty: "" });
  _resetJobs();
  const { job, started, removed, reads } = run(loc, { dryRun: true, threads: { "c-dry": [sms("outbound", 30)] } });
  await settle(loc);
  assert.equal(job.status, "done", job.error);
  const row = job.results.find((r) => r.contactId === "c-dry");
  assert.equal(row.status, "would send");
  assert.equal(row.county, "Pierce");
  assert.deepEqual(reads, ["c-dry"]);
  assert.equal(started.length, 0);
  assert.equal(removed.length, 0);
  assert.equal((await claims(loc, "c-dry")).length, 0);
});

test("through the real GHL calls: the thread is read by contact, and the follow-up workflow removal is a DELETE", async () => {
  const loc = "loc-ghl-client";
  await seed(loc, ["c-real"]);
  _resetJobs();
  const calls = [];
  const client = {
    async call(p, opts = {}) {
      calls.push({ method: opts.method || "GET", path: p });
      if (/\/conversations\/search\?.*contactId=c-real/.test(p)) return { conversations: [{ id: "conv-1", contactId: "c-real" }] };
      if (/\/conversations\/conv-1\/messages/.test(p)) return { messages: { messages: [sms("outbound", 30), { direction: "outbound", messageType: "TYPE_ACTIVITY_OPPORTUNITY", dateAdded: ago(15) }], nextPage: false } };
      return {};
    },
  };
  const { job, started } = run(loc, { client, deps: { ghlThread: undefined, removeFromWorkflow: undefined } });
  await settle(loc);
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 1, "a card moving in GHL is not a text");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/contacts/c-real/workflow/wf-follow"));
});

test("the first text is whatever GHL sent within a few hours; the app's own nudges don't count against its ladder", () => {
  const first = sms("outbound", 30);
  const part2 = { ...sms("outbound", 30), dateAdded: new Date(Date.parse(ago(30)) + (FIRST_TEXT_GRACE_HOURS - 1) * HOUR).toISOString() };
  assert.deepEqual(afterFirstText([part2, first]), { wroteBack: false, firstTextAt: ago(30), laterAt: null });
  assert.equal(afterFirstText([first, sms("outbound", 15)]).laterAt, ago(15));
  // Epoch-millisecond dates read the same as ISO ones.
  assert.equal(afterFirstText([first, { ...sms("outbound", 15), dateAdded: Date.parse(ago(15)) }]).laterAt, ago(15));
  assert.equal(afterFirstText([first, sms("outbound", 15, { status: "undelivered" })]).laterAt, null);
  assert.equal(afterFirstText([first, sms("outbound", 15)], { appSince: ago(16) }).laterAt, null, "ours, after our first nudge");
  assert.equal(afterFirstText([first, { direction: "inbound", messageType: "TYPE_CALL", dateAdded: ago(20) }]).wroteBack, true, "a call from them is an answer");
  assert.equal(afterFirstText([]).firstTextAt, null);
});

test("the GHL follow-up leaves alone an agent the app already followed up", async () => {
  const loc = "loc-ghl-both";
  await seed(loc, ["c-nudged", "c-silent"], { followUpEnrolled: false });
  await recordEvent({ store, locationId: loc, contactId: "c-nudged", party: "agent", type: "follow_up_sent", at: ago(16), source: "conversation",
    ref: "outreach_nudge:c-nudged:14", dedupeKey: "fu-nudged", data: { kind: "outreach_nudge", step: 14 } });
  resetGhlFollowUp();
  const enrolled = [];
  const client = {
    async call(p, opts = {}) {
      if (opts.method === "POST" && /\/workflow\//.test(p)) enrolled.push(p);
      if (/conversations\/search/.test(p)) return { conversations: [{ lastMessageDate: NOW - 20 * DAY, lastMessageDirection: "outbound" }] };
      return {};
    },
  };
  const saved = { outreachAutopilot: { enabled: true, followUpEnabled: true, followUpWorkflowId: "wf-follow", followUpDays: 14 } };
  const job = startOutreachFollowUp({ locationId: loc, client, saved, store, now: NOW, paceMs: 0 });
  await pause(50);
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(enrolled, ["/contacts/c-silent/workflow/wf-follow"]);
});

/* ---------- the check-in lets go of the cohort ---------- */

const S = normalizeAgentPulse({ enabled: true });
const followed = { contactId: "a-fu", name: "", tags: [], offers: [], current: [], drafts: [], ledger: [], listings: [], facts: {}, lastInboundAt: null,
  events: [{ type: "outreach_enrolled", at: ago(30), data: { kind: "first" } }, { type: "outreach_enrolled", at: ago(10), data: { kind: "followup" } }] };

test("with the GHL follow-up off, an enrollment in it no longer holds the agent from the check-in", () => {
  const ctx = { settings: S, config: CONFIG, houses: {}, now: NOW };
  assert.equal(evaluateAgent(followed, ctx).reason, "the outreach follow-up workflow", "on: the workflow has them, as before");
  const off = evaluateAgent(followed, { ...ctx, outreachFollowUpOn: false });
  assert.notEqual(off.status, "owned", off.reason);
  assert.equal(off.segment, "cold", "a cold agent: only a fresh listing of theirs is a reason to text");
  // The first-text workflow's own days still hold a brand-new enrollment.
  const fresh = { ...followed, events: [{ type: "outreach_enrolled", at: ago(5), data: { kind: "first" } }] };
  assert.equal(evaluateAgent(fresh, { ...ctx, outreachFollowUpOn: false }).reason, "the outreach workflow");
});

test("the check-in reads the switch from Settings", async () => {
  const loc = "loc-ghl-pulse";
  await store.upsertContactProfile(loc, "a-fu", { party: "agent" });
  for (const e of followed.events) {
    await recordEvent({ store, locationId: loc, contactId: "a-fu", party: "agent", type: e.type, at: e.at, source: "import", dedupeKey: `${e.type}:${e.data.kind}:a-fu`, data: e.data });
  }
  const base = { aiApiKey: "k", conversationAi: CONFIG };
  const verdict = async (oa) => (await planAgentPulse({ locationId: loc, saved: { ...base, outreachAutopilot: { ...oa, pulse: { enabled: true } } }, store, now: NOW, tierCards: new Map() }))
    .verdicts.find((v) => v.contactId === "a-fu");
  assert.equal((await verdict({ followUpEnabled: true, followUpWorkflowId: "wf-follow" })).reason, "the outreach follow-up workflow");
  const off = await verdict({ followUpEnabled: false, followUpWorkflowId: "wf-follow" });
  assert.notEqual(off.status, "owned", off.reason);
});
