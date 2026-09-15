import test from "node:test";
import assert from "node:assert/strict";
import { planTierFixes, runTierCheck, maybeRunTierCheck } from "./tier-check.js";

const PIPES = [
  { id: "pA", name: "Acquisitions", stages: [
    { id: "new", name: "New Lead" }, { id: "t1", name: "Tier 1 - Hot/Actionable, Active Deal" },
    { id: "t2", name: "Tier 2 - Warm, No Active Deal" }, { id: "t3", name: "Tier 3- Cold/Keep Warm" },
    { id: "out", name: "Offer Out" }, { id: "passed", name: "Passed on Offer" },
  ] },
  { id: "pD", name: "Dispositions", stages: [{ id: "d1", name: "Tier 1 - Interested" }, { id: "d2", name: "Tier 2 - Working" }, { id: "d3", name: "Tier 3 x" }] },
];
const opp = (contactId, stage, tags, over = {}) => ({
  id: `op-${contactId}`, contactId, pipelineId: "pA", pipelineStageId: stage, status: "open",
  lastStageChangeAt: "2026-09-15T10:00:00Z", contact: { id: contactId, name: contactId, tags }, ...over,
});

test("a tier card sets the tags; stacked and missing tags are fixed", () => {
  const fixes = planTierFixes({ pipelines: PIPES, opportunities: [
    opp("jahine", "t3", ["agent", "tier-1", "tier-3"]),
    opp("slavic", "t2", ["agent", "tier-1"]),
    opp("ok", "t1", ["agent", "tier-1"]),
  ] });
  const by = Object.fromEntries(fixes.map((f) => [f.contactId, f]));
  assert.deepEqual([by.jahine.add, by.jahine.remove, by.jahine.moveTo], [[], ["tier-1"], null]);
  assert.deepEqual([by.slavic.add, by.slavic.remove], [["tier-2"], ["tier-1"]]);
  assert.equal(by.ok, undefined);
});

test("a card at Offer Out keeps tier-1 alone; early, passed, closed and non-agent cards are left be", () => {
  const fixes = planTierFixes({ pipelines: PIPES, opportunities: [
    opp("brenda", "out", ["agent", "tier-3", "tier-1"]),
    opp("gabe", "out", ["agent"]),
    opp("lead", "new", ["agent", "tier-2"]),
    opp("passed", "passed", ["agent", "tier-1"]),
    opp("lost", "t1", ["agent", "tier-3"], { status: "lost" }),
    opp("seller", "t3", ["seller-lead"]),
    opp("dispo", "d1", ["agent", "tier-3"], { pipelineId: "pD" }),
  ] });
  const by = Object.fromEntries(fixes.map((f) => [f.contactId, f]));
  assert.deepEqual([by.brenda.add, by.brenda.remove], [[], ["tier-3"]]);
  assert.deepEqual(by.gabe.add, ["tier-1"]);
  assert.deepEqual(Object.keys(by).sort(), ["brenda", "gabe"]);
});

test("a tag the bot added after the card last moved moves the card instead; an older one doesn't", () => {
  const lori = opp("lori", "t3", ["agent", "tier-1", "tier-3"]);
  const newer = planTierFixes({ pipelines: PIPES, opportunities: [lori],
    tagEvents: [{ contactId: "lori", at: "2026-09-15T11:00:00Z", data: { tag: "tier-1" } }] });
  assert.deepEqual([newer[0].moveTo, newer[0].remove, newer[0].add], ["t1", ["tier-3"], []]);
  const older = planTierFixes({ pipelines: PIPES, opportunities: [lori],
    tagEvents: [{ contactId: "lori", at: "2026-09-15T09:00:00Z", data: { tag: "tier-1" } }] });
  assert.deepEqual([older[0].moveTo, older[0].remove], [null, ["tier-1"]]);
});

test("a contact whose open cards disagree is left for a person", () => {
  const fixes = planTierFixes({ pipelines: PIPES, opportunities: [
    opp("two", "t1", ["agent", "tier-3"], { id: "a" }), opp("two", "t3", ["agent", "tier-3"], { id: "b" }),
  ] });
  assert.deepEqual(fixes, []);
});

const fakeStore = () => ({
  events: [], cursors: new Map(),
  async listContactEventsSince() { return []; },
  async appendContactEvents(_l, contactId, rows) { this.events.push(...rows.map((r) => ({ contactId, ...r }))); return { inserted: rows.length }; },
  async getContactProfile() { return null; }, async upsertContactProfile() { return true; },
  async getJobCursor(l, k) { return this.cursors.get(`${l}|${k}`) || null; },
  async setJobCursor(l, k, v) { this.cursors.set(`${l}|${k}`, v); },
});
const fakeApi = (rows) => {
  const calls = [];
  return { calls, api: {
    listPipelines: async () => PIPES,
    listAcquisitionOpportunities: async () => rows,
    addContactTags: async (_c, id, tags) => { calls.push(["add", id, tags]); },
    removeContactTags: async (_c, id, tags) => { calls.push(["remove", id, tags]); },
    updateOpportunity: async (_c, id, body) => { calls.push(["update", id, body]); },
  } };
};

test("the run applies the fixes, records them, stops at the limit, and a dry run writes nothing", async () => {
  const rows = [opp("a", "t3", ["agent", "tier-1"]), opp("b", "t2", ["agent", "tier-1"]), opp("c", "out", ["agent", "tier-2", "tier-1"])];
  const dry = fakeApi(rows);
  const d = await runTierCheck({ client: {}, locationId: "L", store: fakeStore(), ghl: dry.api, dryRun: true });
  assert.equal(d.planned, 3);
  assert.equal(dry.calls.length, 0);

  const live = fakeApi(rows);
  const store = fakeStore();
  const r = await runTierCheck({ client: {}, locationId: "L", store, ghl: live.api, limit: 2 });
  assert.equal(r.applied, 2);
  assert.deepEqual(live.calls.filter(([k]) => k === "remove").map(([, id, t]) => [id, t]), [["a", ["tier-1"]], ["b", ["tier-1"]]]);
  assert.ok(store.events.some((e) => e.contactId === "a" && e.type === "tag_added" && e.data.tag === "tier-3" && e.source === "tier_check"));
});

test("once a day, from 7am PT", async () => {
  const store = fakeStore();
  const { api } = fakeApi([opp("a", "t3", ["agent", "tier-1"])]);
  const six = Date.parse("2026-09-15T13:30:00Z");   // 6:30am PT
  assert.equal(await maybeRunTierCheck({ client: {}, locationId: "L", store, ghl: api, now: six }), null);
  const eight = Date.parse("2026-09-15T15:00:00Z"); // 8am PT
  const r = await maybeRunTierCheck({ client: {}, locationId: "L", store, ghl: api, now: eight });
  assert.equal(r.applied, 1);
  assert.equal((await store.getJobCursor("L", "tierCheck")).doc.applied, 1);
  assert.equal(await maybeRunTierCheck({ client: {}, locationId: "L", store, ghl: api, now: eight + 3600000 }), null);
});
