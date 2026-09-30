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
