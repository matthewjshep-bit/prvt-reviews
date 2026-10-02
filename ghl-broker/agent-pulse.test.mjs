// agent-pulse.test.mjs — the agent check-in's runner, on the JSON store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pulse-test-"));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { planAgentPulse, startAgentPulse, maybeRunAgentPulse, _resetJobs, CURSOR_NAME } = await import("./agent-pulse.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
await store.init();

const DAY = 86400000;
const settle = () => new Promise((r) => setTimeout(r, 40));
const savedWith = (pulse = {}) => ({
  aiApiKey: "k",
  conversationAi: normalizeConversationAi({ enabled: true }),
  outreachAutopilot: { pulse: { enabled: true, dailyCap: 5, ...pulse } },
});
const client = { call: async () => ({}) };
const reachable = async (id) => ({ id, phone: "+12065550100", tags: ["agent"] });
const repliedAgent = async (loc, id, daysAgo = 40) => {
  await store.upsertContactProfile(loc, id, { party: "agent", name: "Agent" });
  await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "text_summary", at: new Date(Date.now() - daysAgo * DAY).toISOString(),
    source: "conversation", dedupeKey: `ts:${id}`, data: { inbound: "nothing right now, maybe next month" } });
};

test("the check-in ships off, and runs once a workday in its window", async () => {
  _resetJobs();
  const loc = "loc-ap-gate";
  const tueNoonPT = Date.parse("2026-09-29T19:05:00Z");
  assert.equal(await maybeRunAgentPulse({ client, locationId: loc, saved: { aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true }) }, store, now: tueNoonPT }), false, "off by default");
  const deps = { getContact: reachable, startProactive: async () => ({ job: { id: "j" } }) };
  assert.equal(await maybeRunAgentPulse({ client, locationId: loc, saved: savedWith(), store, deps, now: tueNoonPT - 3 * 3600000 }), false, "not before its hour");
  assert.equal(await maybeRunAgentPulse({ client, locationId: loc, saved: savedWith(), store, deps, now: tueNoonPT }), true);
  await settle();
  assert.equal(await maybeRunAgentPulse({ client, locationId: loc, saved: savedWith(), store, deps, now: tueNoonPT + 3600000 }), false, "once a day");
  assert.ok((await store.getJobCursor(loc, CURSOR_NAME)).doc.last, "the day's run is on the cursor");
});

test("claims each agent before drafting; a start that drafts nothing gives the day's seat back", async () => {
  _resetJobs();
  const loc = "loc-ap-claim";
  await repliedAgent(loc, "ag1");
  const before = await planAgentPulse({ locationId: loc, saved: savedWith(), store });
  assert.deepEqual(before.picks.map((p) => [p.contactId, p.reason]), [["ag1", "general"]]);

  const held = startAgentPulse({ client, locationId: loc, saved: savedWith(), store, sendsEnabled: false,
    deps: { getContact: reachable, startProactive: async () => ({ skipped: "their text is waiting on you" }) } });
  await settle();
  assert.equal(held.status, "done", held.error);
  assert.equal(held.results[0].status, "skipped");
  const events = await store.listContactEvents(loc, "ag1", { limit: 50 });
  assert.ok(events.some((e) => e.type === "agent_pulse_sent"), "claimed before anything was drafted");
  assert.ok(events.some((e) => e.type === "agent_pulse_voided"), "and voided when nothing was");
  const after = await planAgentPulse({ locationId: loc, saved: savedWith(), store });
  assert.equal(after.claimedToday, 0, "the seat came back");
  assert.equal(after.picks.length, 0, "tried today: tomorrow, not twice today");
  const tomorrow = Date.now() + DAY;
  assert.deepEqual((await planAgentPulse({ locationId: loc, saved: savedWith(), store, now: tomorrow })).picks.map((p) => p.contactId), ["ag1"], "and still due");

  _resetJobs();
  const calls = [];
  const went = startAgentPulse({ client, locationId: loc, saved: savedWith(), store, sendsEnabled: false, now: tomorrow,
    deps: { getContact: reachable, startProactive: async (args) => { calls.push(args); return { job: { id: "j1", draftId: "d1" } }; } } });
  await settle();
  assert.equal(went.started, 1, JSON.stringify(went.results));
  assert.equal(calls[0].kind, "agent_pulse");
  assert.equal(calls[0].subject.reason, "general");
  assert.equal(calls[0].deps.releaseHeld, false, "drafts only until the pulse's own autoSend");
  const later = await planAgentPulse({ locationId: loc, saved: savedWith(), store, now: tomorrow + 3600000 });
  assert.equal(later.claimedToday, 1);
  assert.equal(later.picks.length, 0, "checked in today: not due again");
});

test("an unsubscribed agent is marked and skipped before any claim", async () => {
  _resetJobs();
  const loc = "loc-ap-dnd";
  await repliedAgent(loc, "ag2");
  const job = startAgentPulse({ client, locationId: loc, saved: savedWith(), store,
    deps: { getContact: async (id) => ({ id, phone: "+12065550101", tags: [], dndSettings: { SMS: { status: "permanent" } } }), startProactive: async () => { throw new Error("must not start"); } } });
  await settle();
  assert.equal(job.results[0].detail, "they unsubscribed");
  const events = await store.listContactEvents(loc, "ag2", { limit: 50 });
  assert.equal(events.some((e) => e.type === "agent_pulse_sent"), false, "never claimed");
  assert.ok(events.some((e) => e.type === "unsubscribed"), "and remembered, so nothing asks again");
});

test("a known agent's fresh distressed listing from the pull is raised by street, never by price", async () => {
  _resetJobs();
  const loc = "loc-ap-listing";
  const batch = await store.createOutreachBatch(loc, { name: "Autopilot · King, WA" });
  await store.upsertOutreachAgents(loc, batch.id, [{ agentKey: "e:agent@example.com", doc: {
    name: "Known Agent", phone: "+12065550102", distressRule: "cut-or-cheap", ghl: { contactId: "ag3" },
  } }]);
  await store.upsertOutreachListings(loc, batch.id, [{ listingKey: "L-123", agentKey: "e:agent@example.com", doc: {
    address: "123 Main St, Kent, WA 98031", city: "Kent", price: 415000, daysOnMarket: 64, propertyType: "Single Family",
    qualifies: true, score: 72, distress: { stale: true, cut: true, cheap: false },
  } }]);
  const plan = await planAgentPulse({ locationId: loc, saved: savedWith(), store });
  const pick = plan.picks.find((p) => p.contactId === "ag3");
  assert.ok(pick, `the known agent is picked (${JSON.stringify(plan.counts)})`);
  assert.equal(pick.reason, "fresh_listing");
  assert.equal(pick.segment, "cold");
  assert.equal(pick.subject.listing.street, "123 Main St");
  assert.doesNotMatch(JSON.stringify(pick.subject), /415/, "no price in what the text may lean on");

  const calls = [];
  startAgentPulse({ client, locationId: loc, saved: savedWith(), store,
    deps: { getContact: reachable, startProactive: async (args) => { calls.push(args); return { job: { id: "j", draftId: "d" } }; } } });
  await settle();
  const events = await store.listContactEvents(loc, "ag3", { limit: 50 });
  assert.ok(events.some((e) => e.type === "listing_pinged" && e.data?.listingKey === "L-123"), "one text per listing, ever");
  const again = await planAgentPulse({ locationId: loc, saved: savedWith(), store });
  assert.equal(again.picks.some((p) => p.contactId === "ag3"), false);
});

test("a dry run picks and reports, and claims nobody", async () => {
  _resetJobs();
  const loc = "loc-ap-dry";
  await repliedAgent(loc, "ag4");
  const job = startAgentPulse({ client, locationId: loc, saved: savedWith(), store, dryRun: true,
    deps: { getContact: async () => { throw new Error("a dry run reads nothing from GHL"); }, startProactive: async () => { throw new Error("nor drafts"); } } });
  await settle();
  assert.deepEqual(job.results.map((r) => [r.contactId, r.status]), [["ag4", "would draft"]]);
  assert.equal((await store.listContactEvents(loc, "ag4", { limit: 50 })).some((e) => e.type === "agent_pulse_sent"), false);
});

/* ---------- the check-in replaces the TIER 2/3 drips (2026-09-30) ---------- */

const { startLeaveDrips, getLeaveDripsJob, previewAgentPulse } = await import("./agent-pulse.js");
// The live playbook's tier rules: a "no" goes to TIER 3, "open to investors" to TIER 2.
const tierCai = (over = {}) => normalizeConversationAi({ enabled: true, parties: { agent: { intentRules: {
  investor_open: { mode: "auto", actions: [{ type: "add_tags", tags: ["tier-2"] }, { type: "add_to_workflow", workflowId: "wf-t2", workflowName: "TIER 2" }] },
  rejection: { mode: "auto", actions: [{ type: "add_tags", tags: ["tier-3"] }, { type: "add_to_workflow", workflowId: "wf-t3", workflowName: "TIER 3" }] },
} } }, ...over });
const savedTier = (pulse = {}) => ({ aiApiKey: "k", conversationAi: tierCai(), outreachAutopilot: { pulse: { enabled: true, dailyCap: 5, ...pulse } } });
// GHL's list: the nurture drip GHL starts on a Tier 2/3 stage move is what texts.
const WORKFLOWS = async () => [
  { id: "wf-t2", name: "TIER 2", status: "published" }, { id: "wf-t3", name: "TIER 3", status: "published" },
  { id: "wf-n", name: "Tier 2+3 nurture", status: "published" },
];

test("an agent the check-in texts leaves the tier nurture drip first, so they never hear from both; a dry run takes nobody out", async () => {
  _resetJobs();
  const loc = "loc-ap-drips";
  await repliedAgent(loc, "ag5");
  const removed = [];
  const deps = { getContact: reachable, removeFromWorkflow: async (id, wf) => { removed.push([id, wf]); }, listWorkflows: WORKFLOWS,
    startProactive: async () => ({ job: { id: "j", draftId: "d" } }) };
  startAgentPulse({ client, locationId: loc, saved: savedTier(), store, dryRun: true, deps });
  await settle();
  assert.deepEqual(removed, [], "a dry run touches nothing in GHL");
  _resetJobs();
  const job = startAgentPulse({ client, locationId: loc, saved: savedTier(), store, deps });
  await settle();
  assert.equal(job.started, 1, JSON.stringify(job.results));
  assert.deepEqual(removed, [["ag5", "wf-n"]], "the nurture only; TIER 2/3 keep moving the card");
  const events = await store.listContactEvents(loc, "ag5", { limit: 50 });
  assert.deepEqual(events.filter((e) => e.type === "workflow_left").map((e) => e.data.workflowId), ["wf-n"]);
});

test("taking everyone out of the nurture drip now: a dry run counts, a live run removes each tagged agent once, and never while the check-in is off", async () => {
  const loc = "loc-ap-leave";
  const tagged = async () => [{ id: "t1", tags: ["tier-2"] }, { id: "t2", tags: ["tier-3", "agent"] }];
  const removed = [];
  const removeFromWorkflow = async (id, wf) => {
    if (id === "t2") { const e = new Error("not enrolled"); e.status = 400; throw e; }
    removed.push([id, wf]);
  };
  const dry = startLeaveDrips({ client, locationId: loc, saved: savedTier(), store, dryRun: true, deps: { taggedContacts: tagged, removeFromWorkflow, listWorkflows: WORKFLOWS } });
  await settle();
  assert.equal(dry.status, "done", dry.error);
  assert.equal(dry.tagged, 2);
  assert.deepEqual(dry.drips.map((d) => d.name), ["Tier 2+3 nurture"]);
  assert.deepEqual(removed, []);

  assert.throws(() => startLeaveDrips({ client, locationId: loc, saved: savedTier({ enabled: false }), store, deps: { taggedContacts: tagged, removeFromWorkflow, listWorkflows: WORKFLOWS } }),
    /turn the agent check-in on first/);

  const live = startLeaveDrips({ client, locationId: loc, saved: savedTier(), store, deps: { taggedContacts: tagged, removeFromWorkflow, listWorkflows: WORKFLOWS, paceMs: 0 } });
  await settle();
  assert.equal(live.status, "done", live.error);
  assert.deepEqual(removed, [["t1", "wf-n"]]);
  assert.equal(live.removed, 1);
  assert.equal(live.notIn, 1);
  assert.equal(getLeaveDripsJob(loc).id, live.id);

  const none = startLeaveDrips({ client, locationId: "loc-ap-leave-none", saved: savedTier(), store, dryRun: true, deps: { taggedContacts: tagged, listWorkflows: async () => [{ id: "wf-t2", name: "TIER 2", status: "published" }] } });
  await settle();
  assert.equal(none.status, "error");
  assert.match(none.error, /no nurture drip/i);
});

test("a preview drafts the next check-ins without a claim, a draft row or a send", async () => {
  _resetJobs();
  const loc = "loc-ap-preview";
  await repliedAgent(loc, "ag6");
  const seen = [];
  const r = await previewAgentPulse({ client, locationId: loc, saved: savedTier(), store, limit: 3,
    deps: { previewProactive: async (args) => { seen.push(args); return { contactName: "Agent", reply: "Hi Dana, hope the Burien listing went well. Anything coming up that needs work?", held: false, flags: [] }; } } });
  assert.equal(r.previews.length, 1);
  assert.equal(r.previews[0].contactId, "ag6");
  assert.match(r.previews[0].reply, /Burien/);
  assert.equal(seen[0].kind, "agent_pulse");
  const events = await store.listContactEvents(loc, "ag6", { limit: 50 });
  assert.equal(events.some((e) => e.type === "agent_pulse_sent"), false, "nobody claimed");
  assert.deepEqual(await store.listReplyDrafts(loc, { contactId: "ag6", limit: 5 }), [], "nothing in the outbox");
});

test("an agent skipped before the claim (unsubscribed) hands the day's seat to the next in line", async () => {
  _resetJobs();
  const loc = "loc-ap-spare";
  await repliedAgent(loc, "ag7a");
  await repliedAgent(loc, "ag7b");
  const started = [];
  const job = startAgentPulse({ client, locationId: loc, saved: savedWith({ dailyCap: 1 }), store,
    deps: {
      getContact: async (id) => (id === "ag7a" ? { id, phone: "+12065550103", dndSettings: { SMS: { status: "permanent" } } } : { id, phone: "+12065550104", tags: [] }),
      startProactive: async (args) => { started.push(args.contactId); return { job: { id: "j", draftId: "d" } }; },
    } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(started, ["ag7b"], JSON.stringify(job.results));
  assert.equal(job.started, 1);
  assert.equal(job.results.find((r) => r.contactId === "ag7a").detail, "they unsubscribed");
});

test("a sample that would be skipped doesn't use up the samples", async () => {
  _resetJobs();
  const loc = "loc-ap-sample-skip";
  await repliedAgent(loc, "ag8a");
  await repliedAgent(loc, "ag8b");
  const r = await previewAgentPulse({ client, locationId: loc, saved: savedTier({ dailyCap: 1 }), store, limit: 1,
    deps: { previewProactive: async ({ contactId }) => (contactId === "ag8a" ? { skipped: "they unsubscribed (DND in GHL) — nothing is drafted" } : { contactName: "Agent", reply: "Hi, anything coming up that needs work?", held: false, flags: [] }) } });
  assert.deepEqual(r.previews.map((p) => [p.contactId, Boolean(p.reply), p.skipped ? "skipped" : ""]), [["ag8a", false, "skipped"], ["ag8b", true, ""]]);
});

// Matt, 2026-10-01: a stop holds however long ago it was pressed — the
// pulse's own read keeps 130 days.
test("an agent you stopped the bot on months ago is still not checked in on", async () => {
  _resetJobs();
  const loc = "loc-ap-old-stop";
  await repliedAgent(loc, "ag9");
  await recordEvent({ store, locationId: loc, contactId: "ag9", type: "drive_stopped", at: new Date(Date.now() - 200 * DAY).toISOString(), source: "operator", data: { reason: "" } });
  const plan = await planAgentPulse({ locationId: loc, saved: savedWith(), store });
  assert.equal(plan.picks.length, 0);
});
