import test from "node:test";
import assert from "node:assert/strict";
import {
  pickAgentsToImport, normalizeOutreachAutopilot, isWorkday, runsLeftInMonth, pullQuery, startOutreachSweep, maybeStartOutreachSweep, getOutreachJob, _resetJobs, CURSOR_NAME, PAGES_CURSOR,
} from "./outreach-sweep.js";

const settle = () => new Promise((r) => setTimeout(r, 15));
const row = (k, doc = {}, extra = {}) => ({ agentKey: k, status: "new", contactId: null, doc: { name: k, phone: "2065550100", distressedCount: 1, listingCount: 2, hook: { address: `${k} St`, score: 50 }, ghl: {}, ...doc }, ...extra });

test("settings coerce to safe defaults", () => {
  assert.deepEqual(normalizeOutreachAutopilot(undefined), {
    enabled: false, dailyCap: 12, weekdaysOnly: true, firstTouch: "app", requireDistress: true,
    workflowId: "", counties: [], followUpEnabled: false, followUpWorkflowId: "", followUpDays: 14,
    minDaysOnMarket: 45, propertyTypes: ["Single Family", "Multi-Family", "Manufactured", "Townhouse"], maxYearBuilt: 0, reserveRequests: 2,
  });
  assert.equal(normalizeOutreachAutopilot({ enabled: true, dailyCap: "250" }).dailyCap, 250);
  assert.equal(normalizeOutreachAutopilot({ enabled: true, dailyCap: "5000" }).dailyCap, 500);
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

const fakeStore = (rows, pulls = []) => ({
  cursors: new Map(),
  async listOutreachAgents() { return rows; },
  async listOutreachPulls() { return pulls; },
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

test("workflow ids and counties come in pasted however", () => {
  const url = "https://app.gohighlevel.com/v2/location/PvdeT4y6MyupP0pKMMjz/automation/workflow/640e73d6-6ef5-4ed6-8cce-59514c9eb1fe";
  const s = normalizeOutreachAutopilot({ firstTouch: "workflow", workflowId: url, followUpWorkflowId: " f979bd4a-2712 ", followUpDays: "400",
    counties: "King, WA\nPierce County, wa;Snohomish, WA\nNowhere" });
  assert.equal(s.firstTouch, "workflow");
  assert.equal(s.workflowId, "640e73d6-6ef5-4ed6-8cce-59514c9eb1fe");
  assert.equal(s.followUpWorkflowId, "f979bd4a-2712");
  assert.equal(s.followUpDays, 90);
  assert.deepEqual(s.counties, [{ county: "King", state: "WA" }, { county: "Pierce", state: "WA" }, { county: "Snohomish", state: "WA" }]);
  assert.equal(normalizeOutreachAutopilot({ workflowId: "<script>" }).workflowId, "");
});

test("the query asks RentCast for stale houses, not everything", () => {
  assert.deepEqual(pullQuery(normalizeOutreachAutopilot({})), { daysOld: "45:*", propertyType: "Single Family|Multi-Family|Manufactured|Townhouse" });
  assert.deepEqual(pullQuery(normalizeOutreachAutopilot({ minDaysOnMarket: 0, propertyTypes: [], maxYearBuilt: 1995 })), { daysOld: "1:*", yearBuilt: "*:1995" });
  assert.deepEqual(normalizeOutreachAutopilot({ propertyTypes: "condo|bogus|Condo" }).propertyTypes, ["Condo"]);
});

test("the month's requests are spread over the runs left in it", () => {
  const sep1 = Date.parse("2026-09-01T15:00:00Z"); // Tuesday
  assert.equal(runsLeftInMonth(sep1), 22);
  assert.equal(runsLeftInMonth(sep1, { weekdaysOnly: false }), 30);
  assert.equal(runsLeftInMonth(Date.parse("2026-09-30T15:00:00Z")), 1);
});

test("walks a county page by page across runs, then the next county; a dry run keeps its place", async () => {
  const counties = [{ county: "King", state: "WA" }, { county: "Pierce", state: "WA" }];
  const saved = { outreachAutopilot: { enabled: true, counties } };
  const day = Date.parse("2026-09-01T15:00:00Z");
  const store = fakeStore([]);
  const bodies = [];
  let reply;
  const deps = { runPull: async (_l, _c, b) => { bodies.push(b); return { batchId: "b1", warnings: [], ...reply }; }, importAgents: async () => ({ results: [] }) };
  const run = async (r, dryRun = false) => {
    reply = r; _resetJobs();
    const job = startOutreachSweep({ locationId: "loc-pg", client: {}, saved, store, deps, now: day, dryRun });
    await settle();
    return job;
  };
  const place = () => store.cursors.get(`loc-pg|${PAGES_CURSOR}`)?.doc;

  const j1 = await run({ nextOffset: 1000, totalCount: 1400, requestsUsed: 2 });
  assert.deepEqual(bodies[0], { daysOld: "45:*", propertyType: "Single Family|Multi-Family|Manufactured|Townhouse", maxRequests: 2, county: "King", state: "WA", offset: 0 },
    "46 spendable over 22 runs = 2 requests");
  assert.equal(j1.county, "King, WA");
  assert.deepEqual(j1.budget, { used: 0, budget: 48, reserve: 2, runsLeft: 22, perRun: 2 });
  assert.equal(place().offsets["King, WA"], 1000);

  await run({ nextOffset: 500, totalCount: 1400 }, true);
  assert.equal(bodies[1].offset, 1000);
  assert.equal(place().offsets["King, WA"], 1000, "a preview does not move the place");

  await run({ nextOffset: 0, totalCount: 1400 });
  assert.equal(bodies[2].county, "King");
  assert.equal(bodies[2].offset, 1000);
  assert.equal(place().offsets["King, WA"], 0, "King read to the end starts over next time");
  assert.equal(place().turn, 1);

  await run({ nextOffset: 0, totalCount: 300 });
  assert.equal(bodies[3].county, "Pierce");
  assert.equal(bodies[3].offset, 0);
  assert.equal(place().turn, 0, "then round to King again");
});

test("firstTouch 'workflow' enrolls by id: no tag, no bot draft", async () => {
  _resetJobs();
  let seen;
  const deps = { runPull: async () => ({ batchId: "b1", warnings: [] }), importAgents: async (a) => { seen = a; return { imported: 1, enrolled: 1, results: [] }; } };
  const job = startOutreachSweep({ locationId: "loc", client: {}, saved: { outreachAutopilot: { enabled: true, firstTouch: "workflow", workflowId: "wf-abc123" } }, store: fakeStore([row("a")]), deps });
  await settle();
  assert.equal(seen.applyTag, false);
  assert.equal(seen.openWith, null);
  assert.equal(seen.enrollWorkflowId, "wf-abc123");
  assert.equal(job.enrolled, 1);
});

test("firstTouch 'workflow' with no workflow picked stops before spending a request", async () => {
  _resetJobs();
  let pulled = false;
  const deps = { runPull: async () => { pulled = true; return { batchId: "b1", warnings: [] }; }, importAgents: async () => ({}) };
  const job = startOutreachSweep({ locationId: "loc", client: {}, saved: { outreachAutopilot: { enabled: true, firstTouch: "workflow" } }, store: fakeStore([row("a")]), deps });
  await settle();
  assert.equal(job.status, "done");
  assert.equal(pulled, false);
  assert.match(job.warnings[0], /none is picked/);
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

test("weekdays only: no run on Saturday or Sunday unless switched to every day", async () => {
  _resetJobs();
  assert.equal(isWorkday(Date.parse("2026-09-11T15:10:00Z")), true, "Friday");
  assert.equal(isWorkday(Date.parse("2026-09-12T15:10:00Z")), false, "Saturday");
  assert.equal(isWorkday(Date.parse("2026-09-15T02:00:00Z")), true, "Monday 7pm Pacific is still Monday there, Tuesday in UTC");
  const deps = { runPull: async () => ({ batchId: "b1", warnings: [] }), importAgents: async () => ({}) };
  const sat = Date.parse("2026-09-12T15:10:00Z");
  const base = { locationId: "loc-wk", client: {}, deps, utcHour: 15, now: sat };
  assert.equal(await maybeStartOutreachSweep({ ...base, store: fakeStore([]), saved: { rentcastApiKey: "k", outreachAutopilot: { enabled: true } } }), false);
  assert.equal(await maybeStartOutreachSweep({ ...base, store: fakeStore([]), saved: { rentcastApiKey: "k", outreachAutopilot: { enabled: true, weekdaysOnly: false } } }), true);
  await settle();
});

test("the sweep stands down when the month's RentCast budget is spent", async () => {
  _resetJobs();
  let pulled = false;
  const deps = { runPull: async () => { pulled = true; return { batchId: "b1", warnings: [] }; }, importAgents: async () => ({}) };
  // 48 is the stop and 2 are kept for the Pull button: at 46 the sweep is done.
  const pulls = [{ createdAt: new Date().toISOString(), doc: { requestsUsed: 46 } }];
  const job = startOutreachSweep({ locationId: "loc", client: {}, saved: { outreachAutopilot: { enabled: true } }, store: fakeStore([row("a")], pulls), deps });
  await settle();
  assert.equal(job.status, "done");
  assert.equal(pulled, false);
  assert.match(job.warnings[0], /RentCast budget/);
  assert.equal(job.budget.used, 46);
  assert.equal(job.budget.budget, 48);
  assert.equal(job.budget.perRun, 0);
});
