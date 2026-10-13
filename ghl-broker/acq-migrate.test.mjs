// acq-migrate.test.mjs — the one-time move off GHL's old stages (Matt's
// four-stage board, 2026-10-13). A report until apply; capped; on the record.
//
//   node --test acq-migrate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { runMigration } from "./acq-migrate.js";

const PIPES = [{ id: "acq", name: "Acquisitions", stages: [
  { id: "s-new", name: "New Lead" }, { id: "s-t1", name: "Tier 1" }, { id: "s-t2", name: "Tier 2" }, { id: "s-t3", name: "Tier 3" },
  { id: "s-out", name: "Offer Out" }, { id: "s-neg", name: "Negotiations" }, { id: "s-pass", name: "Passed on Offer" }, { id: "s-cs", name: "Contract Signed" },
] }];
const card = (contactId, stage, over = {}) => ({ id: `op-${contactId}`, contactId, pipelineId: "acq", pipelineStageId: stage, status: "open", ...over });
const fakeStore = (offers = [], lastIn = []) => ({
  events: [], cursors: new Map(),
  async listOffers() { return offers; },
  async lastContactActivity() { return lastIn; },
  async getOfferSettings() { return {}; },
  async appendContactEvents(_l, contactId, rows) { this.events.push(...rows.map((r) => ({ contactId, ...r }))); return { inserted: rows.length }; },
  async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
  async setJobCursor(l, k, v) { this.cursors.set(`${l}|${k}`, v); },
});
const fakeGhl = (cards, moved, workflows = []) => ({
  listPipelines: async () => PIPES, listWorkflows: async () => workflows,
  listAcquisitionOpportunities: async () => cards,
  updateOpportunity: async (_c, id, body) => { moved.push({ id, ...body }); },
});
const NOW = Date.parse("2026-10-13T20:00:00Z");
const CARDS = [card("neg", "s-neg"), card("talked", "s-t3"), card("silent", "s-new"), card("fine", "s-t1")];
const OFFERS = [{ id: "o1", contactId: "neg", address: "1 Elm St", cashAmount: 300000, status: "countered", counter: { amount: 320000 }, createdAt: "2026-10-01T00:00:00Z", sends: [{ ts: "2026-10-02T00:00:00Z" }] }];

test("a report moves nothing and says where every old-stage card would go", async () => {
  const moved = [];
  const store = fakeStore(OFFERS, [{ contactId: "talked", at: "2026-10-05T00:00:00Z" }]);
  const r = await runMigration({ client: {}, locationId: "L", store, ghl: fakeGhl(CARDS, moved), now: NOW });
  assert.equal(moved.length, 0);
  assert.deepEqual(r.moves.map((m) => [m.contactId, m.to, m.status || "open"]).sort(),
    [["neg", "Offer Out", "open"], ["silent", "Tier 2", "abandoned"], ["talked", "Tier 2", "open"]]);
  assert.equal(store.cursors.get("L|pipelineMigrate").doc.apply, false);
});

test("apply moves them, at most the limit a press, each on the contact's record, no names", async () => {
  const moved = [];
  const store = fakeStore(OFFERS, [{ contactId: "talked", at: "2026-10-05T00:00:00Z" }]);
  const r = await runMigration({ client: {}, locationId: "L", store, ghl: fakeGhl(CARDS, moved), apply: true, limit: 2, now: NOW });
  assert.equal(r.applied, 2);
  assert.equal(r.left, 1);
  assert.equal(moved.length, 2);
  assert.ok(store.events.every((e) => e.type === "ghl_stage_moved" && e.source === "pipeline_migrate"));
});

test("while a texting nurture is published, nobody who replied is opened into Tier 2", async () => {
  const moved = [];
  const store = fakeStore([], [{ contactId: "talked", at: "2026-10-05T00:00:00Z" }]);
  const r = await runMigration({ client: {}, locationId: "L", store, ghl: fakeGhl([card("talked", "s-t3")], moved, [{ id: "w", name: "Tier 2+3 nurture", status: "published" }]), apply: true, now: NOW });
  assert.equal(moved.length, 0);
  assert.match(r.moves[0].blocked, /nurture/);
});
