// pipeline-for.test.mjs — Today's read as a function (routes/dashboard.js
// router.pipelineFor): the GHL calls runner works from exactly the rows
// GET /api/dashboard/pipeline sends.
//
//   node --test pipeline-for.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-for-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");

const LOC = "loc-pipeline-for";
const client = { call: async () => ({}) };
const router = createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client }) });
const app = express();
app.use(express.json());
app.use("/api/dashboard", router);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => { server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();

test("the route answers with what pipelineFor reads, and the runner gets the Desk's rows beside it", async () => {
  await store.saveOfferSettings(LOC, {});
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "dana", contactName: "Dana Agent", address: "12 Elm St, Kent, WA 98030",
    status: "countered", cashAmount: 300000, counter: { amount: 315000, at: ago(3) }, statusHistory: [], createdAt: ago(100), sends: [{ ts: ago(90) }] });
  assert.ok(o.id);
  assert.equal(typeof router.pipelineFor, "function");
  const read = await router.pipelineFor({ locationId: LOC, client });
  const r = await (await fetch(`${B}/api/dashboard/pipeline`)).json();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(r).sort(), Object.keys(read.body).sort());
  assert.deepEqual(r.desk.rows.map((x) => x.id), read.body.desk.rows.map((x) => x.id));
  assert.deepEqual(read.desk.rows.map((x) => x.id), read.body.desk.rows.map((x) => x.id));
  for (const k of ["callRows", "shownCalls", "shownActions", "drafts", "offers", "cards", "events"]) assert.ok(Array.isArray(read[k]), `${k} rides along`);
  assert.equal(read.deskSettings.dailyCalls, 10);
});
