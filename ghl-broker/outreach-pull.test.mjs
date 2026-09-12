// outreach-pull.test.mjs — what the pull actually asks RentCast for, and how
// it pages. Drives the real route against a local mock RentCast, so no
// free-tier requests are spent and every query string is visible.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-pull-test-"));

// The mock: 1,400 matching listings, served 500 at a time from ?offset,
// with X-Total-Count when asked for it.
const TOTAL = 1400;
const seen = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  seen.push(Object.fromEntries(u.searchParams));
  const offset = Number(u.searchParams.get("offset") || 0);
  const n = Math.max(0, Math.min(500, TOTAL - offset));
  const listings = Array.from({ length: n }, (_, i) => ({
    formattedAddress: `${offset + i} Test St, Auburn, WA 98001`, price: 400000, squareFootage: 1500,
  }));
  const headers = { "Content-Type": "application/json" };
  if (u.searchParams.get("includeTotalCount") === "true") headers["X-Total-Count"] = String(TOTAL);
  res.writeHead(200, headers);
  res.end(JSON.stringify(listings));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
process.env.RENTCAST_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");

const LOC = "loc-pull-1";
await store.init();
await store.saveOfferSettings(LOC, { rentcastApiKey: "test-key" });

const app = express();
app.use(express.json());
app.use("/api/outreach", createOutreachRouter({
  resolveLocation: () => ({ locationId: LOC, client: { async call() { return {}; } } }),
}));
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const B = `http://127.0.0.1:${server.address().port}`;

async function pull(body) {
  const before = seen.length;
  const r = await fetch(`${B}/api/outreach/pull`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location_id: LOC, ...body }),
  });
  const json = await r.json();
  assert.equal(r.status, 200, JSON.stringify(json));
  return { ...json, queries: seen.slice(before) };
}

test.after(() => { server.close(); mock.close(); });

test("the sweep's query: stale listings, the right types, from where it left off, to the end", async () => {
  const r = await pull({ zipCodes: "98001", offset: 500, maxRequests: 3, daysOld: "45:*", propertyType: "single family|Condo|bogus", yearBuilt: "*:1995" });
  assert.equal(r.queries.length, 2, "500 → 1000, then the last 400");
  assert.equal(r.queries[0].offset, "500");
  assert.equal(r.queries[1].offset, "1000");
  assert.equal(r.queries[0].daysOld, "45:*");
  assert.equal(r.queries[0].propertyType, "Single Family|Condo");
  assert.equal(r.queries[0].yearBuilt, "*:1995");
  assert.equal(r.queries[0].includeTotalCount, "true");
  assert.equal(r.requestsUsed, 2);
  assert.equal(r.totalCount, TOTAL);
  assert.equal(r.nextOffset, 0, "read to the end");
});

test("out of requests mid-county: says where the next page starts, and doesn't call it truncated", async () => {
  const r = await pull({ zipCodes: "98002", offset: 0, maxRequests: 1, daysOld: "45:*" });
  assert.equal(r.queries.length, 1);
  assert.equal(r.queries[0].offset, undefined, "offset 0 is not sent");
  assert.equal(r.nextOffset, 500);
  assert.ok(!r.warnings.some((w) => /truncated/.test(w)));
});

test("the same pull again is a free cache hit with the same place", async () => {
  const r = await pull({ zipCodes: "98002", offset: 0, maxRequests: 1, daysOld: "45:*" });
  assert.equal(r.queries.length, 0);
  assert.equal(r.cached, true);
  assert.equal(r.nextOffset, 500);
  assert.equal(r.totalCount, TOTAL);
});

test("a manual pull is unchanged: a bare daysOld is still a maximum", async () => {
  const r = await pull({ zipCodes: "98003", daysOld: 180 });
  assert.equal(r.queries[0].daysOld, "180");
  assert.equal(r.queries.length, 3, "default 3 requests covers 1,400");
  assert.equal(r.nextOffset, 0);
});
