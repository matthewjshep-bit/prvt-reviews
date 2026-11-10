// rentcast-meter-route.test.mjs — the Activity page's RentCast meter
// (GET /api/dashboard/summary) on the JSON store.
//
//   node --test rentcast-meter-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rentcast-meter-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");
const { rentcastCycle } = await import("./outreach-sweep.js");

const LOC = "loc-rentcast-meter";
const app = express();
app.use(express.json());
app.use("/api/dashboard", createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }) }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

// 2026-11-09 audit: the meter said "of 50" and counted from the 1st of the
// calendar month, while the plan in Settings and the sweep's own budget
// count from the billing day.
test("the RentCast meter counts from the billing day", async () => {
  await store.saveOfferSettings(LOC, { outreachAutopilot: { monthlyRequests: 1000, cycleDay: 15 } });
  const since = new Date(rentcastCycle(Date.now(), 15).start).toISOString();
  // One pull the hour before the billing day began, one the hour after.
  const pulls = [
    { createdAt: new Date(Date.parse(since) - 3600000).toISOString(), requestsUsed: 30 },
    { createdAt: new Date(Date.parse(since) + 3600000).toISOString(), requestsUsed: 7 },
  ];
  const real = store.sumOutreachRequests;
  store.sumOutreachRequests = async (loc, sinceIso) => (loc === LOC ? pulls.filter((p) => p.createdAt >= sinceIso).reduce((s, p) => s + p.requestsUsed, 0) : 0);
  try {
    const r = await (await fetch(`${B}/api/dashboard/summary?days=7`)).json();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.outreach.usage.limit, 1000, "the plan in Settings, not 50");
    assert.equal(r.outreach.usage.since, since, "from the billing day");
    assert.equal(r.outreach.usage.requestsThisMonth, 7, "the pull before the billing day is last cycle's");
  } finally {
    store.sumOutreachRequests = real;
  }
});
