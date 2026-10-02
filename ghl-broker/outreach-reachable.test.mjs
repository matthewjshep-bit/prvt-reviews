// outreach-reachable.test.mjs — who the daily pick can actually reach (2026-10-02).
//
// On 10/2 the Pierce run read 261 agents and found one nobody had talked to.
// Agents already in GHL and agents with no phone stay "new" forever, and the
// pick read the newest thousand "new" rows — so a county full of people we
// can't text crowded out the ones we can. And a listing that carries no phone
// for an agent we already have a phone for (another listing, another pull)
// left that agent unreachable.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-reachable-test-"));

// A mock RentCast: each zip is its own little market.
const MARKETS = {
  // Batch A's pull: the full identities.
  "98001": [
    { agent: { name: "Xavier Cross", email: "x@acme.com", phone: "206-555-0101" }, office: { name: "Acme", phone: "206-555-9000" } },
    { agent: { name: "Yolanda Young", phone: "206-555-0102" }, office: { name: "Acme", phone: "206-555-9000" } },
  ],
  // Batch B's pull: the same people, phones missing from these listings.
  "98002": [
    { agent: { name: "Xavier Cross", email: "x@acme.com" }, office: { name: "Acme", phone: "206-555-9000" } },
    { agent: { name: "Yolanda Young" }, office: { name: "Acme", phone: "206-555-9000" } },
    { agent: { name: "Zed Zane" }, office: { name: "Beta Realty", phone: "206-555-9111" } },
  ],
  // Two people in one office with the same name: neither can be told apart.
  "98003": [
    { agent: { name: "Sam Smith", phone: "206-555-0103" }, office: { name: "Gamma", phone: "206-555-9222" } },
  ],
  "98004": [
    { agent: { name: "Sam Smith" }, office: { name: "Gamma", phone: "206-555-9222" } },
    { agent: { name: "Sam Smith", email: "sam2@gamma.com", phone: "206-555-0104" }, office: { name: "Gamma", phone: "206-555-9222" } },
  ],
};
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const zip = u.searchParams.get("zipCode");
  const rows = (MARKETS[zip] || []).map((m, i) => ({
    formattedAddress: `${i + 1} ${zip} Ave, Tacoma, WA ${zip}`, zipCode: zip, price: 400000, squareFootage: 1500,
    daysOnMarket: 80, mlsName: "NWMLS", mlsNumber: `${zip}-${i}`, listingAgent: m.agent, listingOffice: m.office,
  }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(rows));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
process.env.RENTCAST_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");
const { startOutreachSweep, _resetJobs } = await import("./outreach-sweep.js");

const LOC = "loc-reach-1";
await store.init();
await store.saveOfferSettings(LOC, { rentcastApiKey: "test-key" });

// Every GHL duplicate search answers "no match", and is counted.
const ghlAsks = [];
const client = { async call(p) { if (String(p).includes("/contacts/search/duplicate")) ghlAsks.push(p); return {}; } };
const app = express();
app.use(express.json());
const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client }) });
app.use("/api/outreach", router);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const B = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); mock.close(); });

async function pull(zip, batchId) {
  const r = await fetch(`${B}/api/outreach/pull`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location_id: LOC, zipCodes: zip, batchId }),
  });
  const json = await r.json();
  assert.equal(r.status, 200, JSON.stringify(json));
  return json;
}
const rowsOf = async (batchId) => Object.fromEntries(
  (await store.listOutreachAgents(LOC, { batchId, limit: 100 })).map((r) => [r.doc.name + (r.doc.email ? ` <${r.doc.email}>` : ""), r]));

test("the same agent's phone from another pull fills a blank one", async () => {
  const a = await store.createOutreachBatch(LOC, { name: "A", autoNamed: false });
  const b = await store.createOutreachBatch(LOC, { name: "B", autoNamed: false });
  await pull("98001", a.id);
  await pull("98002", b.id);
  const rows = await rowsOf(b.id);
  assert.equal(rows["Xavier Cross <x@acme.com>"].doc.phone, "2065550101", "same email, another pull");
  assert.equal(rows["Xavier Cross <x@acme.com>"].doc.phoneFrom, "another pull");
  assert.equal(rows["Yolanda Young"].doc.phone, "2065550102", "same name at the same office");
  assert.equal(rows["Yolanda Young"].doc.phoneFrom, "name and office");
});

test("an agent with only an office phone is never given it, and never picked", async () => {
  const b = (await store.listOutreachBatches(LOC)).find((x) => x.name === "B");
  const rows = await rowsOf(b.id);
  assert.equal(rows["Zed Zane"].doc.phone, "");
  assert.equal(rows["Zed Zane"].doc.officePhone, "2065559111");
  const pickable = await store.listOutreachPickable(LOC, { batchId: b.id });
  assert.ok(!pickable.some((r) => r.doc.name === "Zed Zane"));
});

test("a name shared by two people at one office fills nobody's phone", async () => {
  const c = await store.createOutreachBatch(LOC, { name: "C", autoNamed: false });
  const d = await store.createOutreachBatch(LOC, { name: "D", autoNamed: false });
  await pull("98003", c.id);
  await pull("98004", d.id);
  const rows = await rowsOf(d.id);
  assert.equal(rows["Sam Smith"].doc.phone, "", "this pull has a second Sam Smith at Gamma with his own phone");
});

test("a pull doesn't re-ask GHL about an agent it checked this week, or one it can't text", async () => {
  const e = await store.createOutreachBatch(LOC, { name: "E", autoNamed: false });
  const before = ghlAsks.length;
  await pull("98002", e.id);
  const first = ghlAsks.length - before;
  assert.ok(first >= 2, "Xavier and Yolanda are checked the first time");
  assert.ok(!ghlAsks.slice(before).some((p) => /Zed/.test(p)), "Zed has no phone or email to check with");
  const again = ghlAsks.length;
  await pull("98002", e.id);
  assert.equal(ghlAsks.length - again, 0, "checked minutes ago: not asked again");
});

test("agents already in GHL or without a phone don't crowd the day's pick out of the read", async () => {
  _resetJobs();
  const loc = "loc-crowd";
  const batch = await store.createOutreachBatch(loc, { name: "Autopilot · Pierce, WA" });
  const good = (k) => ({ agentKey: k, doc: { name: k, phone: `20655${String(Math.random()).slice(2, 7)}`, distressedCount: 1, distressRule: "cut-or-cheap", hook: { address: `${k} St`, price: 400000, score: 50 }, ghl: {} } });
  await store.upsertOutreachAgents(loc, batch.id, ["g1", "g2", "g3", "g4", "g5"].map(good));
  await new Promise((r) => setTimeout(r, 5));
  // 1,200 newer rows nobody can be picked from: in GHL already, or no phone.
  const crowd = Array.from({ length: 1200 }, (_, i) => i % 2
    ? { agentKey: `in-ghl-${i}`, doc: { ...good(`in-ghl-${i}`).doc, ghl: { contactId: `c${i}` } } }
    : { agentKey: `no-phone-${i}`, doc: { ...good(`no-phone-${i}`).doc, phone: "" } });
  await store.upsertOutreachAgents(loc, batch.id, crowd);
  const calls = [];
  const deps = {
    runPull: async () => ({ batchId: batch.id, warnings: [], requestsUsed: 1, nextOffset: 0 }),
    importAgents: async (a) => { calls.push(a); return { imported: a.agentKeys.length, results: [] }; },
  };
  const job = startOutreachSweep({ locationId: loc, client: {}, saved: { outreachAutopilot: { enabled: true, dailyCap: 10 } }, store, deps });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(calls[0]?.agentKeys?.slice().sort(), ["g1", "g2", "g3", "g4", "g5"]);
});

test("an agent imported from another county's batch isn't picked again here", async () => {
  const loc = "loc-elsewhere";
  const king = await store.createOutreachBatch(loc, { name: "Autopilot · King, WA" });
  const pierce = await store.createOutreachBatch(loc, { name: "Autopilot · Pierce, WA" });
  const doc = { name: "Pat", phone: "2065550199", distressedCount: 1, hook: { price: 400000, score: 50 }, ghl: {} };
  await store.upsertOutreachAgents(loc, king.id, [{ agentKey: "e:pat@x.com", doc }]);
  await store.upsertOutreachAgents(loc, pierce.id, [{ agentKey: "e:pat@x.com", doc }, { agentKey: "e:quinn@x.com", doc: { ...doc, name: "Quinn", phone: "2065550198" } }]);
  await store.setOutreachAgentStatus(loc, king.id, "e:pat@x.com", { status: "imported", contactId: "c-pat", importedAt: new Date().toISOString() });
  const pickable = await store.listOutreachPickable(loc, { batchId: pierce.id });
  assert.deepEqual(pickable.map((r) => r.agentKey), ["e:quinn@x.com"]);
});

test("two rows with one phone are picked once in a run", async () => {
  _resetJobs();
  const row = (k, phone) => ({ agentKey: k, status: "new", contactId: null, doc: { name: k, phone, distressedCount: 1, distressRule: "cut-or-cheap", hook: { address: "1 St", price: 400000, score: 50 }, ghl: {} } });
  const byBatch = { "b-King": [row("e:yo@acme.com", "2065550102")], "b-Pierce": [row("n:yolanda-young|acme", "2065550102"), row("p:2065550177", "2065550177")] };
  const fake = {
    cursors: new Map(),
    async listOutreachAgents(_l, { batchId }) { return byBatch[batchId] || []; },
    async listOutreachPulls() { return []; },
    async getJobCursor(l, n) { return this.cursors.get(`${l}|${n}`) || null; },
    async setJobCursor(l, n, v) { this.cursors.set(`${l}|${n}`, v); return v; },
  };
  const calls = [];
  const deps = {
    runPull: async (_l, _c, b) => ({ batchId: `b-${b.county}`, warnings: [], requestsUsed: 1, nextOffset: 0 }),
    importAgents: async (a) => { calls.push(a); return { imported: a.agentKeys.length, results: [] }; },
  };
  const saved = { outreachAutopilot: { enabled: true, monthlyRequests: 1000, counties: [{ county: "King", state: "WA" }, { county: "Pierce", state: "WA" }] } };
  startOutreachSweep({ locationId: "loc-phone", client: {}, saved, store: fake, deps, now: Date.parse("2026-10-02T17:05:00Z") });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.map((c) => c.agentKeys), [["e:yo@acme.com"], ["p:2065550177"]]);
});
