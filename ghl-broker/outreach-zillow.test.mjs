// outreach-zillow.test.mjs — a phone for an agent RentCast gave us none for,
// from the agent's own listing on Zillow (2026-10-02). Off by default; on,
// it only trusts a phone when Zillow's agent has our agent's last name.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-zillow-test-"));

const LISTINGS = [
  { street: "101 Oak St", agent: { name: "Riley Moss" } },          // Zillow: same agent, has a phone
  { street: "202 Elm St", agent: { name: "Casey Lane" } },          // Zillow: a different agent
  { street: "303 Ash St", agent: { name: "Jo Park", phone: "206-555-0140" } },
];
const mock = http.createServer((req, res) => {
  const rows = LISTINGS.map((l, i) => ({
    formattedAddress: `${l.street}, Tacoma, WA 98402`, addressLine1: l.street, zipCode: "98402", price: 300000, squareFootage: 1500,
    daysOnMarket: 80, mlsName: "NWMLS", mlsNumber: `Z${i}`, listingAgent: l.agent, listingOffice: { name: "Office", phone: "206-555-9999" },
  }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(rows));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
process.env.RENTCAST_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

// Apify, faked: the detail actor's rows for the listings it was asked about.
const realFetch = globalThis.fetch;
const apifyAsks = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("api.apify.com")) {
    const { addresses } = JSON.parse(opts.body);
    apifyAsks.push(addresses);
    const rows = addresses.map((a) => {
      const street = String(a).split(",")[0];
      if (street === "101 Oak St") return { address: { streetAddress: street }, attributionInfo: { agentName: "Riley Moss", agentPhoneNumber: "253-555-0111", agentEmail: "riley@moss.com" } };
      if (street === "202 Elm St") return { address: { streetAddress: street }, attributionInfo: { agentName: "Pat Other", agentPhoneNumber: "253-555-0122" } };
      return { isValid: false };
    });
    return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, opts);
};

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOutreachRouter, sameLastName } = await import("./routes/outreach.js");
const { zillowAgentFrom } = await import("./rehab-scan.js");
const { normalizeOutreachAutopilot } = await import("./outreach-sweep.js");

const LOC = "loc-zillow-1";
await store.init();
const client = { async call() { return {}; } };
const app = express();
app.use(express.json());
const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client }) });
app.use("/api/outreach", router);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const B = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); mock.close(); globalThis.fetch = realFetch; });

const sweepPull = (batchId) => router.runPull(LOC, client, { zipCodes: "98402", daysOld: "45:*", metro: true, batchId }, { maxRequestsCap: 40 });
const byName = async (batchId) => Object.fromEntries((await store.listOutreachAgents(LOC, { batchId, limit: 50 })).map((r) => [r.doc.name, r.doc]));

test("the lookup reads Zillow's agent and says which fields it found", () => {
  const z = zillowAgentFrom({ attributionInfo: { agentName: "Riley Moss", agentPhoneNumber: "253-555-0111", brokerName: "X" } });
  assert.deepEqual([z.name, z.phone, z.email], ["Riley Moss", "253-555-0111", ""]);
  assert.deepEqual(z.fields, ["agentName", "agentPhoneNumber", "brokerName"]);
  assert.equal(sameLastName("Riley Moss", "riley MOSS"), true);
  assert.equal(sameLastName("Casey Lane", "Pat Other"), false);
  assert.equal(sameLastName("", ""), false);
});

test("off by default: nothing is asked of Zillow", async () => {
  assert.deepEqual(normalizeOutreachAutopilot({}).zillowLookup, { enabled: false, perRun: 25 });
  await store.saveOfferSettings(LOC, { rentcastApiKey: "k", apifyToken: "t" });
  const b = await store.createOutreachBatch(LOC, { name: "Autopilot · Pierce, WA", autoNamed: false });
  await sweepPull(b.id);
  assert.equal(apifyAsks.length, 0);
  assert.equal((await byName(b.id))["Riley Moss"].phone, "");
});

test("a Zillow agent with a different name gives ours no phone", async () => {
  await store.saveOfferSettings(LOC, { rentcastApiKey: "k", apifyToken: "t", outreachAutopilot: { zillowLookup: { enabled: true, perRun: 10 } } });
  const b = await store.createOutreachBatch(LOC, { name: "Autopilot · King, WA", autoNamed: false });
  await sweepPull(b.id);
  assert.equal(apifyAsks.length, 1);
  assert.deepEqual(apifyAsks[0].map((a) => a.split(",")[0]).sort(), ["101 Oak St", "202 Elm St"], "only the two with no phone");
  const rows = await byName(b.id);
  assert.equal(rows["Riley Moss"].phone, "2535550111");
  assert.equal(rows["Riley Moss"].phoneFrom, "zillow");
  assert.equal(rows["Riley Moss"].email, "riley@moss.com");
  assert.equal(rows["Casey Lane"].phone, "", "Zillow's agent there is someone else");
  assert.equal(rows["Jo Park"].phoneFrom, undefined, "had a phone already");
});

test("a pull from the button never asks Zillow", async () => {
  const before = apifyAsks.length;
  const b = await store.createOutreachBatch(LOC, { name: "Hand pull", autoNamed: false });
  await router.runPull(LOC, client, { zipCodes: "98402", daysOld: "45:*", batchId: b.id });
  assert.equal(apifyAsks.length, before);
});

test("the preview says what Zillow carried, never a name or a number", async () => {
  const r = await (await fetch(`${B}/api/outreach/zillow-agents/preview`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location_id: LOC, limit: 3 }),
  })).json();
  assert.equal(r.ok, true);
  assert.ok(r.checked >= 1);
  const text = JSON.stringify(r);
  assert.ok(!/Casey|Lane|Other|555/.test(text), text);
  assert.ok(r.results.some((x) => x.foundListing && x.hasPhone && x.sameName === false));
});
