// outreach-off-market.test.mjs — listings that came off the market lately
// without selling (2026-10-15). New-agent supply had fallen to two a day; a
// listing that came off the market is a seller who may still want out. The
// sweep reads one county's "Inactive" listings a run, keeps the ones that came
// off in the last 30 days and didn't sell, and the first text asks whether
// the seller is still hoping to sell. Agents already in GHL never hear it from
// a check-in (2026-10-19). Drives the real pull against a local mock RentCast.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-off-market-test-"));

const DAY = 86400000;
const NOW = Date.now();
const day = (d) => new Date(NOW - d * DAY).toISOString();
const listing = (n, over = {}) => ({
  formattedAddress: `${n} Larch St, Auburn, WA 98001`, addressLine1: `${n} Larch St`, city: "Auburn", state: "WA", zipCode: "98001", county: "King",
  price: 450000, squareFootage: 1500, bedrooms: 3, yearBuilt: 2005, propertyType: "Single Family", status: "Inactive",
  listedDate: day(120), removedDate: day(10), daysOnMarket: 110,
  listingAgent: { name: `Dana Agent${n}`, phone: `206555${String(1000 + n).slice(-4)}`, email: `agent${n}@example.com` },
  listingOffice: { name: "Test Realty" },
  ...over,
});
const LISTINGS = [
  listing(1),                                                          // off 10 days ago: kept
  listing(2, { removedDate: day(45) }),                                // off too long ago
  listing(3, { history: { [day(10).slice(0, 10)]: { event: "Sold", price: 440000 } } }),   // sold, per RentCast
  listing(4),                                                          // Zillow says sold
  listing(5),                                                          // Zillow says it's back for sale
  listing(6),                                                          // Zillow says off market: kept
];

const seen = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  seen.push(Object.fromEntries(u.searchParams));
  res.writeHead(200, { "Content-Type": "application/json", "X-Total-Count": String(LISTINGS.length) });
  res.end(JSON.stringify(LISTINGS));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
process.env.RENTCAST_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

// Zillow's detail actor (Apify), stubbed: the status for each street asked.
const ZILLOW = { "4 Larch St": "SOLD", "5 Larch St": "FOR_SALE", "6 Larch St": "OFF_MARKET" };
const realFetch = globalThis.fetch;
let apifyAsked = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith("https://api.apify.com/")) {
    const { addresses = [] } = JSON.parse(opts.body || "{}");
    apifyAsked.push(...addresses);
    const items = addresses.map((a) => {
      const street = String(a).split(",")[0];
      return ZILLOW[street] ? { address: { streetAddress: street }, listingStatus: ZILLOW[street] } : null;
    }).filter(Boolean);
    return new Response(JSON.stringify(items), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, opts);
};

const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");
const { offMarketListings, soldInHistory } = await import("./outreach-score.js");
const { outboundDescriptor } = await import("./reply-agent.js");
const { outboundOpening } = await import("./conversation-prompt.js");
const { firstTextHook } = await import("./shared/outreach-opener.js");
const { evaluateAgent, normalizeAgentPulse, listingDistressed } = await import("./shared/agent-pulse.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { startOutreachSweep, normalizeOutreachAutopilot, _resetJobs } = await import("./outreach-sweep.js");

await store.init();
test.after(() => { mock.close(); globalThis.fetch = realFetch; });

test("a listing that came off the market in the last 30 days and didn't sell is kept; the sold, the old and the relisted aren't", () => {
  const keyOf = (l) => String(l.addressLine1 || "");
  const status = new Map([["4 Larch St", "SOLD"], ["5 Larch St", "FOR_SALE"], ["6 Larch St", "OFF_MARKET"]]);
  const { kept, dropped } = offMarketListings(LISTINGS, { now: NOW, zillowStatus: status, keyOf });
  assert.deepEqual(kept.map((l) => l.addressLine1), ["1 Larch St", "6 Larch St"]);
  assert.deepEqual(dropped, { notRecent: 1, sold: 1, zillow: 2 });
  assert.ok(kept.every((l) => l.offMarket === true));
  assert.equal(soldInHistory(listing(9, { history: { a: { event: "Sale Listing", price: 1 } } })), false, "a listing event isn't a sale");
  assert.equal(offMarketListings([listing(7, { status: "Active" })], { now: NOW }).kept.length, 0, "still on the market");
});

test("the off-market pull asks RentCast for Inactive listings and flags each agent's hook, with no distress rule after it", async () => {
  const L = "loc-off-market-pull";
  await store.saveOfferSettings(L, { rentcastApiKey: "test-key", apifyToken: "apify-test" });
  const batch = await store.createOutreachBatch(L, { name: "Autopilot · Off-market · King, WA", autoNamed: false });
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: L, client: { async call() { return {}; } } }) });
  seen.length = 0;
  apifyAsked = [];
  const r = await router.runPull(L, { async call() { return {}; } }, { zipCodes: "98001", status: "Inactive", batchId: batch.id, daysOld: "45:*",
    distressRule: "cut-or-old", maxRequests: 1 });
  assert.equal(seen[0].status, "Inactive", "RentCast is asked for listings that came off the market");
  assert.ok(apifyAsked.length >= 3, "Zillow is asked which of the recent ones sold");
  assert.ok(r.warnings.some((w) => /^off-market: kept 2 of 6/.test(w)), r.warnings.join(" · "));
  const rows = await store.listOutreachAgents(L, { batchId: batch.id });
  const hooks = rows.map((x) => x.doc.hook).sort((a, b) => a.address.localeCompare(b.address));
  assert.deepEqual(hooks.map((h) => h.address), ["1 Larch St, Auburn, WA 98001", "6 Larch St, Auburn, WA 98001"],
    "a 2005 house with no price cut still counts: coming off the market is the distress");
  assert.ok(hooks.every((h) => h.offMarket === true && h.removedDate));
  const listingRows = (await Promise.all(rows.map((x) => store.listOutreachListings(L, { batchId: batch.id, agentKey: x.agentKey })))).flat();
  assert.equal(listingRows.length, 2);
  assert.ok(listingRows.every((x) => x.doc.offMarket === true));
  assert.equal(listingDistressed({ ...listingRows[0].doc, qualifies: true }, "cut-or-old"), true, "the check-in reads it as news too");
});

test("the first text about a listing that came off the market asks whether the seller still hopes to sell, never 'expired'", () => {
  const doc = { brokerage: "Test Realty", listingCount: 1, hook: { address: "1 Larch St, Auburn, WA 98001", county: "King", city: "Auburn", offMarket: true, removedDate: day(10) } };
  const hook = firstTextHook(doc);
  assert.equal(hook.offMarket, true);
  const o = outboundDescriptor({ kind: "outreach_open", offer: null, saved: {}, subject: { address: hook.address, county: hook.county, city: hook.city, house: hook } });
  assert.equal(o.offMarket, true);
  const t = outboundOpening(o);
  assert.match(t, /THIS LISTING CAME OFF THE MARKET RECENTLY: say you saw it came off the market and ask whether the seller is still hoping to sell\. That is your one question/);
  assert.match(t, /ask ONE plain question about whether the seller still hopes to sell/);
  assert.match(t, /Never the word "expired"/);
  assert.match(t, /Phone carriers block texts/, "the carrier rule still rides on it");
});

// 2026-10-19: "Hey, saw the listing on 126th come off the market. Still hoping
// to sell?" Matt didn't like it: a check-in never brings up their listing
// coming off the market. The agent gets the ordinary check-in instead.
test("a check-in never says it saw their listing come off the market", () => {
  const now = NOW;
  const offListing = { listingKey: "L-off", firstSeen: day(2), lastSeen: day(1), distressRule: "cut-or-old",
    doc: { address: "6 Larch St, Auburn, WA 98001", city: "Auburn", qualifies: true, offMarket: true, removedDate: day(10), score: 30, distress: {} } };
  const ctx = { settings: normalizeAgentPulse({ enabled: true }), config: normalizeConversationAi({ enabled: true }), houses: { live: new Set(), walked: new Map() }, now };
  const known = evaluateAgent({ contactId: "c-known", name: "Dana", tags: [], offers: [], current: [], drafts: [], events: [], ledger: [], facts: {}, lastInboundAt: day(40), listings: [offListing] }, ctx);
  assert.notEqual(known.pulseReason, "off_market_listing");
  assert.equal(known.listing ?? null, null, "the off-market listing isn't the hook");
  const cold = evaluateAgent({ contactId: "c-cold", name: "Dana", tags: [], offers: [], current: [], drafts: [], events: [], ledger: [], facts: {}, lastInboundAt: null, listings: [offListing] }, ctx);
  assert.notEqual(cold.status, "due", "a cold agent whose only listing came off the market isn't texted");
  const t = outboundOpening({ kind: "agent_pulse", reason: "off_market_listing", segment: "cold", listing: { street: "126th Ave SE", city: "Kent", offMarket: true } });
  assert.doesNotMatch(t, /came off the market/);
});

test("with the off-market seats on, the sweep reads one county's Inactive listings into its own batch, first, and gives them only their share of the day", async () => {
  _resetJobs();
  const batches = [];
  const rowsByBatch = new Map();
  const offRow = (i) => ({ agentKey: `off${i}`, status: "new", contactId: null,
    doc: { name: `off${i}`, phone: `20655570${String(i).padStart(2, "0")}`, listingCount: 1, hook: { address: `${i} Larch St`, price: 400000, offMarket: true }, ghl: {} } });
  const newRow = (i) => ({ agentKey: `k${i}`, status: "new", contactId: null,
    doc: { name: `k${i}`, phone: `20655580${String(i).padStart(2, "0")}`, distressedCount: 2, distressRule: "cut-or-old", listingCount: 1, hook: { priceCut: true, address: `${i} Elm St`, price: 400000 }, ghl: {} } });
  const fake = {
    cursors: new Map(),
    async listOutreachBatches() { return batches; },
    async createOutreachBatch(_l, { name }) { const b = { id: `b${batches.length}`, name }; batches.push(b); rowsByBatch.set(b.id, name.includes("Off-market") ? [1, 2, 3, 4, 5].map(offRow) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(newRow)); return b; },
    async listOutreachPickable(_l, { batchId }) { return rowsByBatch.get(batchId) || []; },
    async listOutreachPulls() { return []; },
    async sumOutreachRequests() { return 0; },
    async getJobCursor(l, n) { return this.cursors.get(`${l}|${n}`) || null; },
    async setJobCursor(l, n, v) { this.cursors.set(`${l}|${n}`, v); return v; },
  };
  const pulls = [];
  const imports = [];
  const deps = {
    runPull: async (_l, _c, q) => { pulls.push(q); return { batchId: q.batchId, requestsUsed: 1, warnings: q.status ? ["off-market: kept 5 of 9"] : [] }; },
    importAgents: async (a) => { imports.push(a); return { results: a.agentKeys.slice(0, a.createLimit).map((agentKey) => ({ agentKey, action: "created", ok: true })), imported: Math.min(a.agentKeys.length, a.createLimit) }; },
    firstTextRoom: async () => Infinity,
  };
  const job = startOutreachSweep({ locationId: "loc-off-sweep", client: {}, store: fake, deps,
    saved: { rentcastApiKey: "k", outreachAutopilot: { enabled: true, dailyCap: 12, firstTouch: "app", counties: "King\nPierce", monthlyRequests: 1000, expired: { enabled: true } } } });
  for (let i = 0; i < 50 && job.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(job.status, "done", job.error);
  assert.equal(pulls[0].status, "Inactive", "the off-market pull goes first");
  assert.equal(batches.find((b) => b.id === pulls[0].batchId)?.name, "Autopilot · Off-market · King, WA", "its own batch");
  assert.ok(!pulls.slice(1).some((q) => q.status), "the regular pulls stay Active");
  assert.equal(imports[0].batchId, pulls[0].batchId);
  assert.equal(imports[0].createLimit, 3, "25% of the day's twelve");
  assert.equal(imports.reduce((s, a) => s + Math.min(a.agentKeys.length, a.createLimit), 0), 12, "the rest of the day goes to the regular pull");
  assert.equal(job.offMarket.county, "King, WA");
  assert.equal(fake.cursors.get("loc-off-sweep|outreachPages").doc.expiredTurn, 1, "Pierce's turn next run");
  assert.equal(normalizeOutreachAutopilot({}).expired.enabled, false, "off by default");
  assert.ok(pulls[0].maxRequests >= 1 && pulls[0].maxRequests < job.budget.perRun, "a share of the run's requests, never all of them");
});
