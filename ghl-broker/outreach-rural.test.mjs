// outreach-rural.test.mjs — a listing on two acres or more is never a reason
// to text an agent (Matt, 2026-10-08: rural is harder to comp and our buyers
// don't want it). Drives the real pull against a local mock RentCast.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-rural-test-"));

const ACRE = 43560;
const LISTINGS = [
  { street: "1 Farm Rd", agent: { name: "Rural Only", phone: "206-555-0101" }, lotSize: 5 * ACRE },
  { street: "2 Town St", agent: { name: "Town Lot", phone: "206-555-0102" }, lotSize: 7200 },
  { street: "3 Ranch Rd", agent: { name: "Has Both", phone: "206-555-0103" }, lotSize: 2 * ACRE, price: 150000 },
  { street: "4 Elm St", agent: { name: "Has Both", phone: "206-555-0103" }, lotSize: 9000 },
  { street: "5 Ash St", agent: { name: "No Lot", phone: "206-555-0105" } },
  { street: "6 Park Ln", agent: { name: "Mobile Only", phone: "206-555-0106" }, lotSize: 6000, propertyType: "Manufactured" },
];
const mock = http.createServer((req, res) => {
  const rows = LISTINGS.map((l, i) => ({
    formattedAddress: `${l.street}, Tacoma, WA 98402`, addressLine1: l.street, zipCode: "98402", price: l.price || 300000, squareFootage: 1500,
    lotSize: l.lotSize, propertyType: l.propertyType || "Single Family", daysOnMarket: 80, mlsName: "NWMLS", mlsNumber: `R${i}`, listingAgent: l.agent, listingOffice: { name: "Office" },
  }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(rows));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
process.env.RENTCAST_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");

const LOC = "loc-rural-1";
await store.init();
await store.saveOfferSettings(LOC, { rentcastApiKey: "test-key" });
const client = { async call() { return {}; } };
const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client }) });
test.after(() => mock.close());

test("an agent whose only listing sits on two acres or more is not picked, and a rural listing is never the hook", async () => {
  const r = await router.runPull(LOC, client, { zipCodes: "98402", daysOld: "45:*", distressOnly: false }, { maxRequestsCap: 1 });
  assert.ok((r.warnings || []).some((w) => /rural filter \(under 2 acres\) kept 4 of 6/.test(w)), (r.warnings || []).join(" | "));
  const rows = await store.listOutreachAgents(LOC, { batchId: r.batchId, limit: 50 });
  const byName = Object.fromEntries(rows.map((x) => [x.doc.name, x.doc]));
  assert.equal(byName["Rural Only"], undefined, "five acres: not a reason to text them");
  assert.ok(byName["Town Lot"], "a town lot is");
  assert.ok(byName["No Lot"], "no lot on record goes ahead");
  assert.match(byName["Has Both"].hook.address, /^4 Elm St/, "the in-town listing is the hook, not the two-acre one");
  assert.equal(byName["Has Both"].listingCount, 2, "their whole book still counts as activity");
});

// Matt, 2026-10-08: no manufactured homes in outreach. RentCast is asked for
// single-family only; a listing of another type that comes back anyway (a
// cached page from before the setting) is dropped here too.
test("a manufactured listing never qualifies an agent when the pull asks for single-family", async () => {
  const LOC2 = "loc-rural-types";
  await store.saveOfferSettings(LOC2, { rentcastApiKey: "test-key" });
  const r = await router.runPull(LOC2, client, { zipCodes: "98402", daysOld: "45:*", distressOnly: false, propertyType: "Single Family" }, { maxRequestsCap: 1 });
  assert.ok((r.warnings || []).some((w) => /property type filter \(Single Family\) kept 5 of 6/.test(w)), (r.warnings || []).join(" | "));
  const rows = await store.listOutreachAgents(LOC2, { batchId: r.batchId, limit: 50 });
  const names = rows.map((x) => x.doc.name);
  assert.ok(!names.includes("Mobile Only"), names.join(", "));
  assert.ok(names.includes("Town Lot"));
});
