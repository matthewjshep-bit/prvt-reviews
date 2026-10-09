// outreach-turnkey.test.mjs — the turnkey seats (Matt, 2026-10-09). The
// three off-market deals with committed buyers started on turnkey listings;
// the pull keeps agents whose listings are all finished, flagged, when the
// sweep has seats for them. Drives the real pull against a local mock RentCast.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-turnkey-test-"));

const LISTINGS = [
  { street: "1 New Ct", agent: { name: "Finished Only", phone: "206-555-0201" }, yearBuilt: 2015 },
  { street: "2 Old St", agent: { name: "Old House", phone: "206-555-0202" }, yearBuilt: 1950 },
  { street: "3 New Ln", agent: { name: "Has Both", phone: "206-555-0203" }, yearBuilt: 2010, price: 900000 },
  { street: "4 Old Ave", agent: { name: "Has Both", phone: "206-555-0203" }, yearBuilt: 1962, price: 350000 },
];
const mock = http.createServer((req, res) => {
  const rows = LISTINGS.map((l, i) => ({
    formattedAddress: `${l.street}, Tacoma, WA 98402`, addressLine1: l.street, zipCode: "98402", price: l.price || 450000, squareFootage: 1500,
    lotSize: 6000, yearBuilt: l.yearBuilt, propertyType: "Single Family", daysOnMarket: 60, mlsName: "NWMLS", mlsNumber: `T${i}`, listingAgent: l.agent, listingOffice: { name: "Office" },
  }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(rows));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
process.env.RENTCAST_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");

const client = { async call() { return {}; } };
test.after(() => mock.close());

test("with turnkey seats, an agent whose listings are all finished joins the batch flagged turnkey; the distressed hook still wins when there is one", async () => {
  const LOC = "loc-turnkey-1";
  await store.init();
  await store.saveOfferSettings(LOC, { rentcastApiKey: "test-key" });
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client }) });
  const r = await router.runPull(LOC, client, { zipCodes: "98402", daysOld: "45:*", distressRule: "cut-or-old", keepTurnkey: true }, { maxRequestsCap: 1 });
  const rows = await store.listOutreachAgents(LOC, { batchId: r.batchId, limit: 50 });
  const by = Object.fromEntries(rows.map((x) => [x.doc.name, x.doc]));
  assert.equal(by["Finished Only"]?.turnkey, true, "kept, flagged");
  assert.equal(by["Finished Only"].hook.turnkey, true, "the opener knows it's a finished listing");
  assert.equal(by["Finished Only"].distressedCount, 0);
  assert.equal(by["Old House"].turnkey, undefined, "a distressed agent is not a turnkey seat");
  assert.match(by["Has Both"].hook.address, /^4 Old Ave/, "their old house is the hook, not the finished one");
  assert.equal(by["Has Both"].turnkey, undefined);
});

test("without turnkey seats the pull is distress only, as before", async () => {
  const LOC = "loc-turnkey-2";
  await store.saveOfferSettings(LOC, { rentcastApiKey: "test-key" });
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client }) });
  const r = await router.runPull(LOC, client, { zipCodes: "98402", daysOld: "45:*", distressRule: "cut-or-old" }, { maxRequestsCap: 1 });
  const names = (await store.listOutreachAgents(LOC, { batchId: r.batchId, limit: 50 })).map((x) => x.doc.name).sort();
  assert.deepEqual(names, ["Has Both", "Old House"]);
});
