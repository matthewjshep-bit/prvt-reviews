// outreach-new-only.test.mjs — the daily sweep only ever reaches agents who
// are not in GHL at all, and a rate-limited lookup is never read as "new".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-new-only-test-"));
delete process.env.OUTREACH_IMPORTS_ENABLED;   // every import here is a dry run

const { findDuplicateContact } = await import("./ghl.js");
const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");
const { startOutreachSweep, _resetJobs } = await import("./outreach-sweep.js");

const httpError = (status) => Object.assign(new Error(`GHL -> ${status}`), { status });

/* ---------- the lookup ---------- */

test("a GHL 'nothing here' answer is no match; a rate limit is an error, not 'new'", async () => {
  const client = (fn) => ({ async call(p) { return fn(p); } });
  assert.equal(await findDuplicateContact(client(() => ({ contact: null })), "L", { phone: "2065550100" }), null);
  assert.equal(await findDuplicateContact(client(() => { throw httpError(404); }), "L", { phone: "2065550100" }), null);
  assert.deepEqual(await findDuplicateContact(client((p) => (p.includes("number=%2B12065550100") ? { contact: { id: "c9" } } : { contact: null })), "L",
    { email: "a@b.co", phone: "2065550100" }), { id: "c9", matchedBy: "phone" });
  await assert.rejects(() => findDuplicateContact(client(() => { throw httpError(429); }), "L", { phone: "2065550100" }), /429/);
  await assert.rejects(() => findDuplicateContact(client(() => { throw httpError(500); }), "L", { email: "a@b.co" }), /500/);
});

/* ---------- the import, new-only ---------- */

const LOC = "loc-new-only";
await store.init();

// Phones ending 1 and 3 are already GHL contacts; the rest are new.
const existing = new Set(["+12065550101", "+12065550103"]);
const ghlClient = {
  async call(p) {
    const m = decodeURIComponent(p).match(/number=(\+\d+)/);
    return m && existing.has(m[1]) ? { contact: { id: `ghl-${m[1].slice(-1)}` } } : { contact: null };
  },
};
const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client: ghlClient }) });

test("new-only skips agents already in GHL, saves the match, and stops at the day's number of new ones", async () => {
  const batch = await store.createOutreachBatch(LOC, { name: "Autopilot · King, WA", autoNamed: false });
  const keys = ["a0", "a1", "a2", "a3", "a4", "a5"];
  await store.upsertOutreachAgents(LOC, batch.id, keys.map((k, i) => ({
    agentKey: k, doc: { name: k, phone: `20655501${String(i).padStart(2, "0")}`, ghl: { contactId: null } },
  })));

  const r = await router.importAgents({
    locationId: LOC, client: ghlClient, agentKeys: keys, batchId: batch.id, dryRun: true,
    enrollWorkflowId: "wf-1", applyTag: false, newOnly: true, createLimit: 3,
  });
  assert.equal(r.dryRun, true);
  // a0 new, a1 in GHL, a2 new, a3 in GHL, a4 new → three new reached; a5 never looked at.
  assert.deepEqual(r.results.map((x) => x.agentKey), ["a0", "a1", "a2", "a3", "a4"]);
  assert.deepEqual(r.results.filter((x) => x.wouldCreate).map((x) => x.agentKey), ["a0", "a2", "a4"]);
  assert.ok(r.results.filter((x) => x.wouldCreate).every((x) => x.wouldEnroll));
  assert.equal(r.skippedExisting, 2);
  assert.ok(!r.results.some((x) => x.wouldUpdate), "an existing contact is never updated or enrolled");

  const saved = await store.getOutreachAgent(LOC, batch.id, "a1");
  assert.equal(saved.doc.ghl.contactId, "ghl-1", "the match is kept so tomorrow's pick skips them");
  assert.equal(saved.status, "new");
});

test("without new-only, the import behaves as it always did", async () => {
  const batch = await store.createOutreachBatch(LOC, { name: "manual", autoNamed: false });
  await store.upsertOutreachAgents(LOC, batch.id, [{ agentKey: "m1", doc: { name: "m1", phone: "2065550101", ghl: {} } }]);
  const r = await router.importAgents({ locationId: LOC, client: ghlClient, agentKeys: ["m1"], batchId: batch.id, dryRun: true });
  assert.equal(r.results[0].wouldUpdate, true);
});

/* ---------- the sweep asks for it ---------- */

test("the daily sweep imports new-only, capped at the day's number, from a longer ranked list", async () => {
  _resetJobs();
  const rows = Array.from({ length: 8 }, (_, i) => ({
    agentKey: `k${i}`, status: "new", contactId: null,
    doc: { name: `k${i}`, phone: `206555020${i}`, distressedCount: 8 - i, listingCount: 1, hook: { address: `${i} St`, score: 50 }, ghl: {} },
  }));
  const fake = {
    cursors: new Map(),
    async listOutreachAgents() { return rows; },
    async listOutreachPulls() { return []; },
    async getJobCursor(l, n) { return this.cursors.get(`${l}|${n}`) || null; },
    async setJobCursor(l, n, v) { this.cursors.set(`${l}|${n}`, v); return v; },
  };
  let seen;
  const deps = {
    runPull: async () => ({ batchId: "b1", warnings: [] }),
    importAgents: async (a) => { seen = a; return { results: a.agentKeys.slice(0, 5).map((k, i) => (i % 2 ? { agentKey: k, ok: true, skipped: "already in GHL" } : { agentKey: k, ok: true, action: "created" })), skippedExisting: 2, imported: 3 }; },
  };
  const job = startOutreachSweep({ locationId: "loc-s", client: {}, saved: { outreachAutopilot: { enabled: true, dailyCap: 3, firstTouch: "workflow", workflowId: "wf-abc123" } }, store: fake, deps });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(job.status, "done", job.error);
  assert.equal(seen.newOnly, true);
  assert.equal(seen.createLimit, 3);
  assert.equal(seen.agentKeys.length, 8, "the whole ranked list, not just three");
  assert.equal(job.skippedExisting, 2);
  assert.deepEqual(job.results.map((x) => x.agentKey), ["k0", "k2", "k4"], "only the agents it reached and didn't skip");
});
