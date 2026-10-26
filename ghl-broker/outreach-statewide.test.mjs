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

/* ---------- a county in another state (2026-10-21, Matt: "start going into the Bend market") ---------- */

const withBend = [...corridor, { county: "Deschutes", state: "OR" }];
// A Bend agent as Bend's pull files them: distress by Bend's rule ("any": sitting, cut or cheap).
const bendRow = (k, hook = {}) => { const r = agentRow(k); return { ...r, doc: { ...r.doc, distressRule: "any", hook: { ...r.doc.hook, yearBuilt: 1998, ...hook } } }; };
// Washington answers the state read; Bend answers its own circle.
const twoStateDeps = (bodies, calls, { stateNext = 1500, bendNext = 0 } = {}) => ({
  runPull: async (_l, _c, b) => {
    bodies.push(b);
    if (b.statewide) {
      return { ok: true, requestsUsed: 4, nextOffset: stateNext, totalCount: 5600, warnings: [],
        counties: b.counties.map((c) => ({ key: `${c.county}, ${c.state}`, batchId: b.batchIds[`${c.county}, ${c.state}`], listingsKept: 10, agentsTotal: 5, agentsNew: 1 })) };
    }
    return { ok: true, requestsUsed: 1, batchId: b.batchId, nextOffset: bendNext, totalCount: 180, listingsFetched: 180, listingsKept: 40, agentsTotal: 30, agentsNew: 12, warnings: [] };
  },
  importAgents: async (a) => { calls.push(a); return { imported: a.agentKeys.length, results: [] }; },
});

test("Bend agents get texted: a Deschutes, OR county is read by its own circle, not left out of the Washington read", async () => {
  _resetJobs();
  const store2 = fakeStore({ "b-Autopilot · King, WA": [agentRow("k1")], "b-Autopilot · Deschutes, OR": [bendRow("bend1"), bendRow("bend2")] });
  const bodies = [];
  const calls = [];
  const saved = { outreachAutopilot: { enabled: true, coverage: "statewide", counties: withBend, monthlyRequests: 1000, dailyCap: 50 } };
  const job = startOutreachSweep({ locationId: "loc-bend", client: {}, saved, store: store2, deps: twoStateDeps(bodies, calls), now: oct2 });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(bodies.length, 2, "Washington once, Bend once");
  assert.equal(bodies[0].state, "WA");
  assert.deepEqual(bodies[0].counties, corridor, "Oregon isn't asked of the Washington read");
  assert.equal(bodies[1].statewide, undefined);
  assert.equal(bodies[1].county, "Deschutes");
  assert.equal(bodies[1].state, "OR");
  assert.equal(bodies[1].metro, true, "Bend's own circle, not the whole county's");
  assert.equal(bodies[1].batchId, "b-Autopilot · Deschutes, OR");
  assert.deepEqual(calls.map((c) => [c.batchId, c.agentKeys, c.county]), [
    ["b-Autopilot · King, WA", ["k1"], "King, WA"],
    ["b-Autopilot · Deschutes, OR", ["bend1", "bend2"], "Deschutes, OR"],
  ]);
  assert.ok(job.tried.some((t) => t.county === "Deschutes, OR" && t.picked === 2));
  assert.ok(!job.warnings.some((w) => /left out/.test(w)), job.warnings.join(" | "));
});

test("Bend's place and Washington's place are both kept", async () => {
  _resetJobs();
  const store2 = fakeStore({});
  const bodies = [];
  const saved = { outreachAutopilot: { enabled: true, coverage: "statewide", counties: withBend, monthlyRequests: 1000 } };
  startOutreachSweep({ locationId: "loc-bend2", client: {}, saved, store: store2, deps: twoStateDeps(bodies, [], { stateNext: 1500, bendNext: 500 }), now: oct2 });
  await settle();
  const doc = store2.cursors.get(`loc-bend2|${PAGES_CURSOR}`).doc;
  assert.equal(doc.statewide.offset, 1500, "saving Bend's page didn't wipe the state's");
  assert.equal(doc.offsets["Deschutes, OR"], 500);
  _resetJobs();
  startOutreachSweep({ locationId: "loc-bend2", client: {}, saved, store: store2, deps: twoStateDeps(bodies, [], { stateNext: 1500, bendNext: 0 }), now: oct2 });
  await settle();
  assert.equal(bodies[3].offset, 500, "tomorrow's Bend read carries on from today's");
});

test("the Washington read leaves a request for Bend", async () => {
  _resetJobs();
  const store2 = fakeStore({});
  const bodies = [];
  const saved = { outreachAutopilot: { enabled: true, coverage: "statewide", counties: withBend, monthlyRequests: 1000 } };
  const job = startOutreachSweep({ locationId: "loc-bend3", client: {}, saved, store: store2, deps: twoStateDeps(bodies, []), now: oct2 });
  await settle();
  assert.equal(bodies[0].maxRequests, job.budget.perRun - 1);
  assert.ok(bodies[1].maxRequests >= 1);
});

test("Bend's circle is ten miles round Bend: Tumalo in, Redmond and Sisters out", async () => {
  const { METRO_CIRCLES } = await import("./routes/outreach.js");
  const c = METRO_CIRCLES["41017"];
  assert.ok(c, "Deschutes County has a population circle");
  const miles = (lat, lng) => {
    const r = (d) => (d * Math.PI) / 180;
    const a = Math.sin(r(lat - c.lat) / 2) ** 2 + Math.cos(r(c.lat)) * Math.cos(r(lat)) * Math.sin(r(lng - c.lng) / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(a));
  };
  assert.equal(c.radiusMi, 10);
  for (const [town, lat, lng] of [["Bend", 44.058, -121.315], ["Tumalo", 44.149, -121.329], ["Deschutes River Woods", 43.993, -121.364]]) {
    assert.ok(miles(lat, lng) < c.radiusMi, `${town} is ${miles(lat, lng).toFixed(1)} mi out`);
  }
  for (const [town, lat, lng] of [["Redmond", 44.272, -121.174], ["Sisters", 44.291, -121.549]]) {
    assert.ok(miles(lat, lng) > c.radiusMi, `${town} is only ${miles(lat, lng).toFixed(1)} mi out`);
  }
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

/* ---------- Bend's own rules (2026-10-21, Matt: "at least for Bend, targeting just primarily distressed property signals … at least 16 years old … properties that have been sitting") ---------- */

test("Bend's pull asks RentCast for houses built 2010 or before, and counts sitting 60 days, a cut or a cheap price as distress", async () => {
  _resetJobs();
  const bodies = [];
  const saved = { outreachAutopilot: { enabled: true, coverage: "statewide", counties: withBend, monthlyRequests: 1000, minDaysOnMarket: 21, turnkeyShare: 25 } };
  startOutreachSweep({ locationId: "loc-bend-rules", client: {}, saved, store: fakeStore({}), deps: twoStateDeps(bodies, []), now: oct2 });
  await settle();
  const [wa, bend] = bodies;
  assert.equal(bend.yearBuilt, "*:2010");
  assert.equal(bend.maxYearBuilt, 2010, "checked again after the pull");
  assert.equal(bend.staleDom, 60);
  assert.equal(bend.distressRule, "any");
  assert.equal(bend.daysOld, "21:*");
  assert.equal(bend.keepTurnkey, undefined, "no turnkey seats in Bend");
  // Washington's read is the sweep's, as before.
  assert.equal(wa.yearBuilt, undefined);
  assert.equal(wa.distressRule, "cut-or-old");
  assert.equal(wa.staleDom, undefined);
  assert.equal(wa.keepTurnkey, true);
});

test("a Bend agent whose listing was built after 2010 isn't texted", async () => {
  _resetJobs();
  const calls = [];
  const store2 = fakeStore({ "b-Autopilot · Deschutes, OR": [bendRow("old"), bendRow("new", { yearBuilt: 2018 })] });
  const saved = { outreachAutopilot: { enabled: true, coverage: "statewide", counties: withBend, monthlyRequests: 1000 } };
  startOutreachSweep({ locationId: "loc-bend-new", client: {}, saved, store: store2, deps: twoStateDeps([], calls), now: oct2 });
  await settle();
  assert.deepEqual(calls.map((c) => c.agentKeys), [["old"]]);
});

test("Settings can set a market's rules, and new rules start its pages over", async () => {
  const { normalizeOutreachAutopilot, marketRules } = await import("./outreach-sweep.js");
  const oa = normalizeOutreachAutopilot({ requireDistress: true, maxYearBuilt: 0, markets: { "Deschutes, OR": { maxYearBuilt: "2008", staleDom: 90, distressRule: "bogus" }, "Nowhere": { maxYearBuilt: 2000 } } });
  assert.deepEqual(oa.markets, { "Deschutes, OR": { maxYearBuilt: 2008, staleDom: 90 } });
  assert.deepEqual(marketRules(oa, "Deschutes, OR"), { maxYearBuilt: 2008, minDaysOnMarket: oa.minDaysOnMarket, staleDom: 90, distressRule: "cut-or-old", turnkeyShare: 0 });
  assert.deepEqual(marketRules(oa, "King, WA").maxYearBuilt, 0);

  _resetJobs();
  const store2 = fakeStore({});
  const bodies = [];
  const base = { enabled: true, coverage: "statewide", counties: withBend, monthlyRequests: 1000 };
  startOutreachSweep({ locationId: "loc-bend-sig", client: {}, saved: { outreachAutopilot: base }, store: store2, deps: twoStateDeps(bodies, [], { bendNext: 500 }), now: oct2 });
  await settle();
  _resetJobs();
  startOutreachSweep({ locationId: "loc-bend-sig", client: {}, saved: { outreachAutopilot: { ...base, markets: { "Deschutes, OR": { maxYearBuilt: 2000 } } } }, store: store2, deps: twoStateDeps(bodies, []), now: oct2 });
  await settle();
  assert.equal(bodies[3].offset, 0, "Bend under new rules reads from the top");
  assert.equal(bodies[2].offset, 1450, "Washington's place is kept");
});

/* ---------- Pierce's own rules (2026-10-26, Matt: more outreach in Pierce, still distressed houses) ---------- */

// The read asks RentCast for the loosest county's days; each county is filed
// by its own rules. Pierce: a cut, an older house, or sitting 60 days, and 14
// days on the market is enough. King keeps 21 days and a cut or an older house.
const pierceRules = { minDom: 14, maxYearBuilt: 2010, distressRule: "cut-old-or-stale", staleDom: 60 };
const kingRules = { minDom: 21, maxYearBuilt: 0, distressRule: "cut-or-old" };
const own = (o) => ({ ...listing(o), yearBuilt: o.yearBuilt, daysOnMarket: o.dom });

test("a Pierce house sitting 60 days gets its agent into the batch while King still needs a cut or an old house", async () => {
  STATE.push(
    own({ county: "Pierce", zip: "98411", ppsf: 320, agent: "Sam Sitting", yearBuilt: 1995, dom: 70 }),
    own({ county: "King", zip: "98011", ppsf: 500, agent: "Kurt Sitting", yearBuilt: 1995, dom: 70 }),
    own({ county: "Pierce", zip: "98412", ppsf: 320, agent: "Nina Newbuild", yearBuilt: 2018, dom: 70 }),
  );
  const k = await store.createOutreachBatch(LOC, { name: "Rules · King, WA", autoNamed: false });
  const p = await store.createOutreachBatch(LOC, { name: "Rules · Pierce, WA", autoNamed: false });
  await router.runPull(LOC, client, {
    ...statewideBody, daysOld: "14:*", distressRule: "cut-or-old",
    counties: [{ county: "King", state: "WA", rules: kingRules }, { county: "Pierce", state: "WA", rules: pierceRules }],
    batchIds: { "King, WA": k.id, "Pierce, WA": p.id },
  }, { maxRequestsCap: 40 });
  const pierceNames = await names(p.id);
  assert.ok(pierceNames.includes("Sam Sitting"), "sitting 70 days counts in Pierce");
  assert.ok(!pierceNames.includes("Nina Newbuild"), "built 2018: past Pierce's 2010");
  assert.ok(!(await names(k.id)).includes("Kurt Sitting"), "King still wants a cut or a house built before 1980");
  const sam = (await store.listOutreachAgents(LOC, { batchId: p.id, limit: 100 })).find((r) => r.doc.name === "Sam Sitting");
  assert.equal(sam.doc.distressRule, "cut-old-or-stale");
  assert.equal(sam.doc.distressedCount, 1);
});

test("a 15-day-old Pierce listing is read but a 15-day-old King one is not", async () => {
  STATE.push(
    own({ county: "Pierce", zip: "98413", ppsf: 320, agent: "Fran Fresh", yearBuilt: 1962, dom: 15 }),
    own({ county: "King", zip: "98012", ppsf: 500, agent: "Fred Fresh", yearBuilt: 1962, dom: 15 }),
  );
  const k = await store.createOutreachBatch(LOC, { name: "Fresh · King, WA", autoNamed: false });
  const p = await store.createOutreachBatch(LOC, { name: "Fresh · Pierce, WA", autoNamed: false });
  await router.runPull(LOC, client, {
    ...statewideBody, daysOld: "14:*", distressRule: "cut-or-old", maxRequests: 2,
    counties: [{ county: "King", state: "WA", rules: kingRules }, { county: "Pierce", state: "WA", rules: pierceRules }],
    batchIds: { "King, WA": k.id, "Pierce, WA": p.id },
  }, { maxRequestsCap: 40 });
  assert.ok((await names(p.id)).includes("Fran Fresh"));
  assert.ok(!(await names(k.id)).includes("Fred Fresh"), "King's 21 days still hold");
});

test("the sweep asks for the loosest county's days, hands each county its rules, and starts the lap over once", async () => {
  const { stateRead } = await import("./outreach-sweep.js");
  const markets = { "Pierce, WA": { minDaysOnMarket: 14, maxYearBuilt: 2010, distressRule: "cut-old-or-stale", staleDom: 60, turnkeyShare: 0 } };
  const oa = normalizeOutreachAutopilot({ enabled: true, coverage: "statewide", counties: corridor, minDaysOnMarket: 21, markets });
  const read = stateRead(oa, oa.counties);
  assert.equal(read.query.daysOld, "14:*");
  assert.equal(read.query.yearBuilt, undefined, "King and Thurston have no year bound");
  assert.deepEqual(read.rules["Pierce, WA"], { minDom: 14, maxYearBuilt: 2010, distressRule: "cut-old-or-stale", staleDom: 60 });
  assert.deepEqual(read.rules["King, WA"], { minDom: 21, maxYearBuilt: 0, distressRule: "cut-or-old" });
  assert.equal(stateRead(normalizeOutreachAutopilot({ counties: corridor }), corridor).sig, null, "no county of its own: the sweep's query, as before");

  _resetJobs();
  const store2 = fakeStore({});
  const bodies = [];
  const deps = {
    runPull: async (_l, _c, b) => { bodies.push(b); return { ok: true, requestsUsed: 3, nextOffset: 1500, totalCount: 5600, warnings: [], counties: [] }; },
    importAgents: async () => ({ results: [] }),
  };
  const base = { enabled: true, coverage: "statewide", counties: corridor, monthlyRequests: 1000, minDaysOnMarket: 21 };
  startOutreachSweep({ locationId: "loc-pierce-sig", client: {}, saved: { outreachAutopilot: base }, store: store2, deps, now: oct2 });
  await settle();
  _resetJobs();
  startOutreachSweep({ locationId: "loc-pierce-sig", client: {}, saved: { outreachAutopilot: { ...base, markets } }, store: store2, deps, now: oct2 });
  await settle();
  assert.equal(bodies[1].offset, 0, "new Pierce rules: the state is read from the top");
  assert.equal(bodies[1].daysOld, "14:*");
  assert.deepEqual(bodies[1].counties.find((c) => c.county === "Pierce").rules, read.rules["Pierce, WA"]);
  _resetJobs();
  startOutreachSweep({ locationId: "loc-pierce-sig", client: {}, saved: { outreachAutopilot: { ...base, markets } }, store: store2, deps, now: oct2 });
  await settle();
  assert.equal(bodies[2].offset, 1450, "same rules the next day: the lap carries on");
});

test("a Pierce agent whose listing has sat 70 days is picked under Pierce's rule, and not under King's", async () => {
  const { pickAgentsToImport } = await import("./outreach-sweep.js");
  const row = (k, hook) => ({ agentKey: k, status: "new", contactId: null, doc: { name: k, phone: `25355500${k.length}${k.charCodeAt(0) % 10}`, distressedCount: 1, distressRule: "cut-old-or-stale", hook: { price: 400000, score: 40, ...hook }, ghl: {} } });
  const rows = [row("sitting", { yearBuilt: 1995, dom: 70 }), row("fresh", { yearBuilt: 1995, dom: 30 }), row("old", { yearBuilt: 1962, dom: 20 })];
  const pierce = pickAgentsToImport(rows, { cap: 10, distressRule: "cut-old-or-stale", staleDom: 60, maxYearBuilt: 2010 }).map((r) => r.agentKey);
  assert.deepEqual(pierce.sort(), ["old", "sitting"]);
  const king = pickAgentsToImport(rows, { cap: 10, distressRule: "cut-or-old" }).map((r) => r.agentKey);
  assert.deepEqual(king, [], "a cut-or-old pick doesn't take a stale-rule row");
});
