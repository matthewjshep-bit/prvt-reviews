// outreach-statewide.test.mjs — one read of the state, filed county by county
// (2026-10-02).
//
// Matt chose ten Puget Sound + I-5 counties. A circle per county overlaps its
// neighbours (the Pierce circle once came back all King) and misses the rural
// edges, so the sweep can instead ask RentCast for the whole state and keep
// the listings in the chosen counties — each county's agents in its own
// batch, each listing measured against its own ZIP's (or county's) $/sqft.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-statewide-test-"));

let n = 0;
const listing = ({ county, zip, ppsf, agent, sqft = 1500 }) => ({
  formattedAddress: `${++n} Main St, Somewhere, WA ${zip}`, zipCode: zip, county, state: "WA",
  price: ppsf * sqft, squareFootage: sqft, daysOnMarket: 80, mlsName: "NWMLS", mlsNumber: `S${n}`,
  listingAgent: { name: agent, phone: `206555${String(1000 + n).slice(-4)}`, email: `${agent.toLowerCase().replace(/\W+/g, ".")}@x.com` },
  listingOffice: { name: "Office" },
});
// King around $500/sqft, Pierce around $320, Spokane around $150 — and none of
// these ZIPs has fifteen listings, so each falls back to its county.
const STATE = [
  ...Array.from({ length: 12 }, (_, i) => listing({ county: "King", zip: `980${10 + (i % 4)}`, ppsf: 500, agent: `King Filler ${i}` })),
  listing({ county: "King", zip: "98010", ppsf: 430, agent: "Kim King" }),          // 86% of King's: cheap
  ...Array.from({ length: 12 }, (_, i) => listing({ county: "Pierce", zip: `984${10 + (i % 4)}`, ppsf: 320, agent: `Pierce Filler ${i}` })),
  listing({ county: "Pierce", zip: "98410", ppsf: 300, agent: "Pat Pierce" }),       // 94% of Pierce's: not cheap
  ...Array.from({ length: 12 }, (_, i) => listing({ county: "Spokane", zip: `992${10 + (i % 4)}`, ppsf: 150, agent: `Spokane Filler ${i}` })),
  listing({ county: "Spokane", zip: "99210", ppsf: 100, agent: "Sid Spokane" }),
];
const seen = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  seen.push(Object.fromEntries(u.searchParams));
  const offset = Number(u.searchParams.get("offset") || 0);
  const page = STATE.slice(offset, offset + 500);
  res.writeHead(200, { "Content-Type": "application/json", "X-Total-Count": String(STATE.length) });
  res.end(JSON.stringify(page));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
process.env.RENTCAST_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");
const { medianIndex } = await import("./outreach-score.js");
const { startOutreachSweep, _resetJobs, normalizeOutreachAutopilot, PAGES_CURSOR, STATEWIDE_STEP_BACK } = await import("./outreach-sweep.js");

const LOC = "loc-state-1";
await store.init();
await store.saveOfferSettings(LOC, { rentcastApiKey: "test-key" });
const client = { async call() { return {}; } };
const app = express();
app.use(express.json());
const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client }) });
app.use("/api/outreach", router);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
test.after(() => { server.close(); mock.close(); });

const king = await store.createOutreachBatch(LOC, { name: "Autopilot · King, WA", autoNamed: false });
const pierce = await store.createOutreachBatch(LOC, { name: "Autopilot · Pierce, WA", autoNamed: false });
const statewideBody = {
  statewide: true, state: "WA",
  counties: [{ county: "King", state: "WA" }, { county: "Pierce", state: "WA" }],
  batchIds: { "King, WA": king.id, "Pierce, WA": pierce.id },
  daysOld: "45:*", propertyType: "Single Family", distressRule: "cut-or-cheap", offset: 0, maxRequests: 5,
};
const names = async (batchId) => (await store.listOutreachAgents(LOC, { batchId, limit: 100 })).map((r) => r.doc.name);

test("a statewide pull asks RentCast for the state, not a circle", async () => {
  const before = seen.length;
  const r = await router.runPull(LOC, client, statewideBody, { maxRequestsCap: 40 });
  const q = seen[before];
  assert.equal(q.state, "WA");
  assert.equal(q.latitude, undefined);
  assert.equal(q.radius, undefined);
  assert.equal(q.daysOld, "45:*");
  assert.equal(r.requestsUsed, 1);
  assert.equal(r.nextOffset, 0, "the whole state fit in one page");
});

test("a statewide pull files each corridor county's agents in its own batch and drops the rest of the state", async () => {
  const k = await names(king.id);
  const p = await names(pierce.id);
  assert.ok(k.includes("Kim King"));
  assert.ok(!k.some((x) => /Pierce|Spokane/.test(x)));
  assert.ok(!p.some((x) => /King|Spokane/.test(x)));
  const all = [...k, ...p];
  assert.ok(!all.some((x) => /Spokane/.test(x)), "Spokane isn't in the corridor");
});

test("King listings are never measured against Spokane's median", async () => {
  // Pooled together, King and Pierce have one median ($375): Pat's $300 would
  // read as cheap and Kim's $430 wouldn't. Against their own counties it's
  // the other way round.
  assert.ok((await names(king.id)).includes("Kim King"));
  assert.ok(!(await names(pierce.id)).includes("Pat Pierce"));
});

test("a cheap ZIP isn't measured against Bellevue", () => {
  const rows = [
    ...Array.from({ length: 15 }, () => ({ zipCode: "98118", county: "King", price: 350 * 1000, squareFootage: 1000 })),
    ...Array.from({ length: 15 }, () => ({ zipCode: "98004", county: "King", price: 900 * 1000, squareFootage: 1000 })),
    { zipCode: "98070", county: "King", price: 600 * 1000, squareFootage: 1000 },
  ];
  const medianFor = medianIndex(rows, { min: 15 });
  assert.equal(medianFor({ zipCode: "98118", county: "King" }), 350, "its own ZIP");
  assert.equal(medianFor({ zipCode: "98004", county: "King" }), 900);
  assert.equal(medianFor({ zipCode: "98070", county: "King" }), 600, "a thin ZIP falls back to the county (31 listings, the middle one $600)");
  assert.equal(medianFor({ zipCode: "99999", county: "Nowhere" }), 0);
});

test("pulling the same pages again doesn't add anyone twice", async () => {
  const before = (await names(king.id)).length;
  const r = await router.runPull(LOC, client, { ...statewideBody, offset: 0, maxRequests: 6 }, { maxRequestsCap: 40 });
  assert.equal((await names(king.id)).length, before);
  assert.equal(r.counties.find((c) => c.key === "King, WA").agentsNew, 0);
});

test("the setting reads the whole state only when asked", () => {
  assert.equal(normalizeOutreachAutopilot({}).coverage, "counties");
  assert.equal(normalizeOutreachAutopilot({ coverage: "statewide" }).coverage, "statewide");
  assert.equal(normalizeOutreachAutopilot({ coverage: "bogus" }).coverage, "counties");
});

/* ---------- the sweep's side ---------- */

const settle = () => new Promise((r) => setTimeout(r, 20));
const fakeStore = (byBatch = {}) => ({
  cursors: new Map(),
  batches: [],
  async listOutreachBatches() { return this.batches; },
  async createOutreachBatch(_l, { name }) { const b = { id: `b-${name}`, name }; this.batches.push(b); return b; },
  async listOutreachAgents(_l, { batchId }) { return byBatch[batchId] || []; },
  async listOutreachPulls() { return []; },
  async getJobCursor(l, k) { return this.cursors.get(`${l}|${k}`) || null; },
  async setJobCursor(l, k, v) { this.cursors.set(`${l}|${k}`, v); return v; },
});
const agentRow = (k) => ({ agentKey: k, status: "new", contactId: null, doc: { name: k, phone: `206${k.length}${k.charCodeAt(0)}${k.charCodeAt(k.length - 1)}000`.slice(0, 10), distressedCount: 1, distressRule: "cut-or-old", hook: { priceCut: true, price: 400000, score: 50 }, ghl: {} } });
const corridor = [{ county: "King", state: "WA" }, { county: "Pierce", state: "WA" }, { county: "Thurston", state: "WA" }];
const oct2 = Date.parse("2026-10-02T17:05:00Z");

test("the statewide sweep reads the state once and imports each county into its own batch", async () => {
  _resetJobs();
  const store2 = fakeStore({ "b-Autopilot · King, WA": [agentRow("k1")], "b-Autopilot · Thurston, WA": [agentRow("t1"), agentRow("t2")] });
  const bodies = [];
  const calls = [];
  const deps = {
    runPull: async (_l, _c, b) => {
      bodies.push(b);
      return { ok: true, requestsUsed: 12, nextOffset: 0, totalCount: 5600, warnings: [],
        counties: b.counties.map((c) => ({ key: `${c.county}, ${c.state}`, batchId: b.batchIds[`${c.county}, ${c.state}`], listingsKept: 10, agentsTotal: 5, agentsNew: 1 })) };
    },
    importAgents: async (a) => { calls.push(a); return { imported: a.agentKeys.length, results: [] }; },
  };
  const saved = { outreachAutopilot: { enabled: true, coverage: "statewide", counties: corridor, monthlyRequests: 1000, dailyCap: 50 } };
  const job = startOutreachSweep({ locationId: "loc-sw", client: {}, saved, store: store2, deps, now: oct2 });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(bodies.length, 1, "one read for all three counties");
  assert.equal(bodies[0].statewide, true);
  assert.equal(bodies[0].state, "WA");
  assert.deepEqual(bodies[0].counties, corridor);
  assert.deepEqual(Object.keys(bodies[0].batchIds), ["King, WA", "Pierce, WA", "Thurston, WA"]);
  assert.deepEqual(calls.map((c) => [c.batchId, c.agentKeys]), [["b-Autopilot · King, WA", ["k1"]], ["b-Autopilot · Thurston, WA", ["t1", "t2"]]]);
  assert.equal(job.county, "King, WA · Thurston, WA");
  assert.deepEqual(job.tried.map((t) => [t.county, t.picked]), [["King, WA", 1], ["Pierce, WA", 0], ["Thurston, WA", 2]]);
});

test("a resumed lap steps back a little, and a finished lap starts over", async () => {
  _resetJobs();
  const store2 = fakeStore({});
  const bodies = [];
  let reply = { nextOffset: 1500 };
  const deps = {
    runPull: async (_l, _c, b) => { bodies.push(b); return { ok: true, requestsUsed: 3, totalCount: 5600, warnings: [], counties: [], ...reply }; },
    importAgents: async () => ({ results: [] }),
  };
  const saved = { outreachAutopilot: { enabled: true, coverage: "statewide", counties: corridor, monthlyRequests: 1000 } };
  startOutreachSweep({ locationId: "loc-lap", client: {}, saved, store: store2, deps, now: oct2 });
  await settle();
  assert.equal(bodies[0].offset, 0);
  assert.equal(store2.cursors.get(`loc-lap|${PAGES_CURSOR}`).doc.statewide.offset, 1500);
  _resetJobs();
  reply = { nextOffset: 0 };
  startOutreachSweep({ locationId: "loc-lap", client: {}, saved, store: store2, deps, now: oct2 });
  await settle();
  assert.equal(STATEWIDE_STEP_BACK, 50);
  assert.equal(bodies[1].offset, 1450, "the list may have shifted overnight: read the last fifty again");
  const place = store2.cursors.get(`loc-lap|${PAGES_CURSOR}`).doc.statewide;
  assert.equal(place.offset, 0, "read to the end: tomorrow starts a new lap");
  assert.ok(place.lapAt);
});

test("a dry run of the statewide sweep doesn't move the place", async () => {
  _resetJobs();
  const store2 = fakeStore({});
  const deps = {
    runPull: async () => ({ ok: true, requestsUsed: 3, nextOffset: 1500, totalCount: 5600, warnings: [], counties: [] }),
    importAgents: async () => ({ results: [] }),
  };
  const saved = { outreachAutopilot: { enabled: true, coverage: "statewide", counties: corridor, monthlyRequests: 1000 } };
  startOutreachSweep({ locationId: "loc-dry", client: {}, saved, store: store2, deps, now: oct2, dryRun: true });
  await settle();
  assert.equal(store2.cursors.get(`loc-dry|${PAGES_CURSOR}`), undefined);
});
