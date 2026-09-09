import test from "node:test";
import assert from "node:assert/strict";
import {
  pickAgentsToImport, normalizeOutreachAutopilot, startOutreachSweep, maybeStartOutreachSweep, getOutreachJob, _resetJobs, CURSOR_NAME,
} from "./outreach-sweep.js";

const settle = () => new Promise((r) => setTimeout(r, 15));
const row = (k, doc = {}, extra = {}) => ({ agentKey: k, status: "new", contactId: null, doc: { name: k, phone: "2065550100", distressedCount: 1, listingCount: 2, hook: { address: `${k} St`, score: 50 }, ghl: {}, ...doc }, ...extra });

test("settings coerce to safe defaults", () => {
  assert.deepEqual(normalizeOutreachAutopilot(undefined), { enabled: false, dailyCap: 12, firstTouch: "app", requireDistress: true });
  assert.equal(normalizeOutreachAutopilot({ enabled: true, dailyCap: "500" }).dailyCap, 100);
  assert.equal(normalizeOutreachAutopilot({ firstTouch: "ghl" }).firstTouch, "ghl");
});

test("only agents nobody has touched, most distressed first, under the cap", () => {
  const rows = [
    row("a", { distressedCount: 1 }),
    row("b", { distressedCount: 3 }),
    row("c", { distressedCount: 2, ghl: { contactId: "existing" } }),   // already in GHL
    row("d", {}, { status: "imported", contactId: "x" }),
    row("e", {}, { status: "skipped" }),
    row("f", { phone: "" }),
    row("g", { distressedCount: 0 }),                                    // nothing distressed
    row("h", { distressedCount: 2, hook: { score: 90 } }),
    row("i", { distressedCount: 2, hook: { score: 10 } }),
  ];
  assert.deepEqual(pickAgentsToImport(rows, { cap: 3 }).map((r) => r.agentKey), ["b", "h", "i"]);
  assert.deepEqual(pickAgentsToImport(rows, { cap: 10 }).map((r) => r.agentKey), ["b", "h", "i", "a"]);
  assert.ok(pickAgentsToImport(rows, { cap: 10, requireDistress: false }).some((r) => r.agentKey === "g"));
});

const fakeStore = (rows) => ({
  cursors: new Map(),
  async listOutreachAgents() { return rows; },
  async getJobCursor(loc, name) { return this.cursors.get(`${loc}|${name}`) || null; },
  async setJobCursor(loc, name, v) { this.cursors.set(`${loc}|${name}`, v); return v; },
});

test("the sweep pulls, picks, imports with the app saying hello, and no trigger tag", async () => {
  _resetJobs();
  const calls = [];
  const deps = {
    runPull: async () => ({ ok: true, batchId: "b1", batchName: "Auburn", requestsUsed: 1, agentsNew: 2, warnings: [] }),
    importAgents: async (args) => { calls.push(args); return { ok: true, dryRun: false, imported: 2, opened: 2, results: args.agentKeys.map((k) => ({ agentKey: k, ok: true, action: "created", contactId: `c-${k}`, opened: { jobId: "j" } })), warnings: [] }; },
  };
  const store = fakeStore([row("a"), row("b", { distressedCount: 4 }), row("c", {}, { status: "imported" })]);
  const job = startOutreachSweep({ locationId: "loc", client: {}, saved: { outreachAutopilot: { enabled: true, dailyCap: 5 } }, store, deps });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(job.candidates, 3);
  assert.equal(job.picked, 2);
  assert.equal(job.imported, 2);
  assert.equal(job.opened, 2);
  assert.deepEqual(calls[0].agentKeys, ["b", "a"]);
  assert.equal(calls[0].applyTag, false, "the GHL template must not also text them");
  assert.equal(calls[0].openWith, "app");
  assert.equal(calls[0].batchId, "b1");
});

test("firstTouch 'ghl' keeps the old way: trigger tag on, no bot draft", async () => {
  _resetJobs();
  let seen;
  const deps = { runPull: async () => ({ batchId: "b1", warnings: [] }), importAgents: async (a) => { seen = a; return { imported: 1, results: [] }; } };
  startOutreachSweep({ locationId: "loc", client: {}, saved: { outreachAutopilot: { enabled: true, firstTouch: "ghl" } }, store: fakeStore([row("a")]), deps });
  await settle();
  assert.equal(seen.applyTag, true);
  assert.equal(seen.openWith, null);
});

test("nothing to pick means no import call at all", async () => {
  _resetJobs();
  let called = false;
  const deps = { runPull: async () => ({ batchId: "b1", warnings: [] }), importAgents: async () => { called = true; return {}; } };
  const job = startOutreachSweep({ locationId: "loc", client: {}, saved: {}, store: fakeStore([row("a", {}, { status: "imported" })]), deps });
  await settle();
  assert.equal(job.status, "done");
  assert.equal(called, false);
});

test("the tick fires once a day, in its hour, only when switched on with a key", async () => {
  _resetJobs();
  const deps = { runPull: async () => ({ batchId: "b1", warnings: [] }), importAgents: async () => ({}) };
  const store = fakeStore([]);
  const inHour = Date.parse("2026-09-10T15:10:00Z");
  const base = { locationId: "loc", client: {}, store, deps, utcHour: 15 };
  assert.equal(await maybeStartOutreachSweep({ ...base, saved: { rentcastApiKey: "k", outreachAutopilot: { enabled: true } }, now: inHour - 3600000 }), false, "wrong hour");
  assert.equal(await maybeStartOutreachSweep({ ...base, saved: { rentcastApiKey: "k" }, now: inHour }), false, "switched off");
  assert.equal(await maybeStartOutreachSweep({ ...base, saved: { outreachAutopilot: { enabled: true } }, now: inHour }), false, "no key");
  assert.equal(await maybeStartOutreachSweep({ ...base, saved: { rentcastApiKey: "k", outreachAutopilot: { enabled: true } }, now: inHour }), true);
  await settle();
  assert.equal(getOutreachJob("loc").status, "done");
  assert.ok(store.cursors.get(`loc|${CURSOR_NAME}`).at, "the cursor is written");
  assert.equal(await maybeStartOutreachSweep({ ...base, saved: { rentcastApiKey: "k", outreachAutopilot: { enabled: true } }, now: inHour + 600000 }), false, "already ran this day");
});
