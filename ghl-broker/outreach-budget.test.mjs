// outreach-budget.test.mjs — the RentCast meter on a paid plan (2026-10-02).
//
// Matt moved RentCast to the Foundation plan (1,000 requests a month) to find
// more agents. Until then the month's budget was a constant 48, the count of
// what was used read only the newest 200 pulls, and no run could spend more
// than ten requests — so a paid plan would have bought nothing.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-budget-test-"));

// A mock RentCast with far more listings than any one run reads.
const TOTAL = 30000;
const seen = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  seen.push(Object.fromEntries(u.searchParams));
  const offset = Number(u.searchParams.get("offset") || 0);
  const n = Math.max(0, Math.min(500, TOTAL - offset));
  const listings = Array.from({ length: n }, (_, i) => ({
    formattedAddress: `${offset + i} Budget St, Auburn, WA 98001`, price: 400000, squareFootage: 1500,
  }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(listings));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
process.env.RENTCAST_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");
const {
  startOutreachSweep, _resetJobs, normalizeOutreachAutopilot, rentcastCycle, runsLeftInCycle, MAX_REQUESTS_PER_RUN,
} = await import("./outreach-sweep.js");

const LOC = "loc-budget-1";
await store.init();
await store.saveOfferSettings(LOC, { rentcastApiKey: "test-key" });

const app = express();
app.use(express.json());
const router = createOutreachRouter({
  resolveLocation: () => ({ locationId: LOC, client: { async call() { return {}; } } }),
});
app.use("/api/outreach", router);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const B = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); mock.close(); });

const settle = () => new Promise((r) => setTimeout(r, 15));

// A store whose pull list honours its limit, the way Postgres does.
const sweepStore = (pulls) => ({
  cursors: new Map(),
  async listOutreachAgents() { return []; },
  async listOutreachPulls(_l, { limit = 50 } = {}) {
    return [...pulls].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  },
  async sumOutreachRequests(_l, sinceIso) {
    return pulls.filter((p) => p.createdAt >= sinceIso).reduce((s, p) => s + (Number(p.doc?.requestsUsed) || 0), 0);
  },
  async getJobCursor(loc, name) { return this.cursors.get(`${loc}|${name}`) || null; },
  async setJobCursor(loc, name, v) { this.cursors.set(`${loc}|${name}`, v); return v; },
});

test("the month's RentCast count reads every pull, not the newest 200", async () => {
  _resetJobs();
  const now = Date.parse("2026-10-20T17:05:00Z");
  // 300 one-request pulls this month: a hand Pull button session and the sweep.
  const pulls = Array.from({ length: 300 }, (_, i) => ({
    createdAt: new Date(Date.parse("2026-10-01T16:00:00Z") + i * 60000).toISOString(), doc: { requestsUsed: 1 },
  }));
  const deps = { runPull: async () => ({ batchId: "b1", warnings: [] }), importAgents: async () => ({ results: [] }) };
  const saved = { outreachAutopilot: { enabled: true, monthlyRequests: 1000 } };
  const job = startOutreachSweep({ locationId: "loc-sum", client: {}, saved, store: sweepStore(pulls), deps, now });
  await settle();
  assert.equal(job.budget.used, 300);
});

test("the JSON store counts every pull since a date", async () => {
  const loc = "loc-sum-file";
  for (let i = 0; i < 250; i++) await store.recordOutreachPull(loc, { requestsUsed: 2 });
  const since = new Date(Date.now() - 3600000).toISOString();
  assert.equal(await store.sumOutreachRequests(loc, since), 500);
  assert.equal(await store.sumOutreachRequests(loc, new Date(Date.now() + 3600000).toISOString()), 0, "nothing after now");
});

test("a monthly budget from Settings spreads across the workdays left and keeps the reserve", async () => {
  _resetJobs();
  // Friday 2026-10-02, 10:05 Pacific. The plan renews on the 15th, so this
  // cycle began 2026-09-15 (Pacific) and has nine workdays left, today included.
  const now = Date.parse("2026-10-02T17:05:00Z");
  const pulls = [
    { createdAt: "2026-09-10T17:00:00.000Z", doc: { requestsUsed: 500 } },  // the cycle before
    { createdAt: "2026-09-20T17:00:00.000Z", doc: { requestsUsed: 700 } },
  ];
  const bodies = [];
  const caps = [];
  const deps = {
    runPull: async (_l, _c, b, opts = {}) => { bodies.push(b); caps.push(opts.maxRequestsCap); return { batchId: "b1", warnings: [], requestsUsed: b.maxRequests }; },
    importAgents: async () => ({ results: [] }),
  };
  const saved = { outreachAutopilot: { enabled: true, monthlyRequests: 950, reserveRequests: 20, cycleDay: 15 } };
  const job = startOutreachSweep({ locationId: "loc-spread", client: {}, saved, store: sweepStore(pulls), deps, now });
  await settle();
  // 950 − 700 used − 20 kept = 230 spendable, over 9 runs = 25 a run.
  assert.deepEqual(job.budget, { used: 700, budget: 950, reserve: 20, runsLeft: 9, perRun: 25 });
  assert.equal(bodies[0].maxRequests, 25);
  assert.equal(caps[0], MAX_REQUESTS_PER_RUN, "the sweep may ask for more than the Pull button's ten");
});

test("a run never spends more than the per-run ceiling, however much is left", async () => {
  _resetJobs();
  const now = Date.parse("2026-10-02T17:05:00Z");
  const bodies = [];
  const deps = { runPull: async (_l, _c, b) => { bodies.push(b); return { batchId: "b1", warnings: [] }; }, importAgents: async () => ({ results: [] }) };
  const saved = { outreachAutopilot: { enabled: true, monthlyRequests: 25000, cycleDay: 15 } };
  const job = startOutreachSweep({ locationId: "loc-ceiling", client: {}, saved, store: sweepStore([]), deps, now });
  await settle();
  assert.equal(job.budget.perRun, MAX_REQUESTS_PER_RUN);
  assert.equal(bodies[0].maxRequests, MAX_REQUESTS_PER_RUN);
  assert.equal(MAX_REQUESTS_PER_RUN, 40);
});

test("an old top-level budget still counts", async () => {
  _resetJobs();
  const now = Date.parse("2026-10-02T17:05:00Z");
  const deps = { runPull: async () => ({ batchId: "b1", warnings: [] }), importAgents: async () => ({ results: [] }) };
  const saved = { rentcastMonthlyBudget: 100, outreachAutopilot: { enabled: true } };
  const job = startOutreachSweep({ locationId: "loc-legacy", client: {}, saved, store: sweepStore([]), deps, now });
  await settle();
  assert.equal(job.budget.budget, 100);
  const set = { rentcastMonthlyBudget: 100, outreachAutopilot: { enabled: true, monthlyRequests: 950 } };
  _resetJobs();
  const job2 = startOutreachSweep({ locationId: "loc-legacy", client: {}, saved: set, store: sweepStore([]), deps, now });
  await settle();
  assert.equal(job2.budget.budget, 950, "the Settings field wins");
});

test("the billing month starts on the plan's day, in Pacific time", () => {
  const oct2 = Date.parse("2026-10-02T17:05:00Z");
  const c = rentcastCycle(oct2, 15);
  assert.equal(new Date(c.start).toISOString(), "2026-09-15T07:00:00.000Z", "midnight Pacific, daylight time");
  assert.equal(new Date(c.end).toISOString(), "2026-10-15T07:00:00.000Z");
  const jan = rentcastCycle(Date.parse("2027-01-05T20:00:00Z"), 15);
  assert.equal(new Date(jan.start).toISOString(), "2026-12-15T08:00:00.000Z", "standard time, across the year");
  // The evening of Sep 30 Pacific is already Oct 1 in UTC — still September's cycle.
  const lateSep = rentcastCycle(Date.parse("2026-10-01T04:00:00Z"), 1);
  assert.equal(new Date(lateSep.start).toISOString(), "2026-09-01T07:00:00.000Z");
  assert.equal(runsLeftInCycle(oct2, { cycleDay: 15 }), 9);
  assert.equal(runsLeftInCycle(oct2, { cycleDay: 15, weekdaysOnly: false }), 13);
});

test("the plan's numbers survive the normaliser", () => {
  assert.equal(normalizeOutreachAutopilot({}).monthlyRequests, 0, "0 = not set: the old budget applies");
  assert.equal(normalizeOutreachAutopilot({}).cycleDay, 1);
  assert.equal(normalizeOutreachAutopilot({ monthlyRequests: "950", cycleDay: "15" }).monthlyRequests, 950);
  assert.equal(normalizeOutreachAutopilot({ cycleDay: 31 }).cycleDay, 28, "every month has a 28th");
  assert.equal(normalizeOutreachAutopilot({ cycleDay: "x" }).cycleDay, 1);
  assert.equal(normalizeOutreachAutopilot({ reserveRequests: 50 }).reserveRequests, 50);
});

test("the Pull button can't spend more than ten requests", async () => {
  const before = seen.length;
  const r = await fetch(`${B}/api/outreach/pull`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location_id: LOC, zipCodes: "98001", maxRequests: 40, daysOld: "45:*" }),
  });
  assert.equal(r.status, 200);
  assert.equal(seen.length - before, 10);
});

test("the sweep's pull may spend up to its own ceiling", async () => {
  const before = seen.length;
  await router.runPull(LOC, { async call() { return {}; } }, { zipCodes: "98002", maxRequests: 25, daysOld: "45:*" }, { maxRequestsCap: MAX_REQUESTS_PER_RUN });
  assert.equal(seen.length - before, 25);
});

test("the page meter and the autopilot strip show the plan's numbers", async () => {
  const saved = await store.getOfferSettings(LOC);
  await store.saveOfferSettings(LOC, { ...saved, outreachAutopilot: { monthlyRequests: 950, reserveRequests: 20 } });
  const a = await (await fetch(`${B}/api/outreach/autopilot?location_id=${LOC}`)).json();
  assert.equal(a.budget.budget, 950);
  assert.equal(a.budget.reserve, 20);
  assert.ok(a.budget.used >= 35, "the pulls above count");
  const g = await (await fetch(`${B}/api/outreach/agents?location_id=${LOC}`)).json();
  assert.equal(g.usage.budget, 950);
  assert.equal(g.usage.requestsThisMonth, a.budget.used);
});
