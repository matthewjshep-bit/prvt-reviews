// outreach-recent-listers.test.mjs — agents who had a listing lately
// (2026-10-26). Pierce's listing agents were nearly all in GHL already: 788
// of the 955 "new" rows in its batch had a match. Matt: "only with people who
// have active listings in the last 60-90 days to weed out people who just
// don't do business recently … can rentcast pull this info so we don't use
// tracerfy credits". RentCast's "Inactive" listings carry the agent's phone,
// so the sweep reads a county's listings that came down in the window, sold
// or not, held to the county's distress rule, and texts the agents new to us
// about the house they had — in the past, never "came off the market".
// Drives the real pull against a local mock RentCast.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-recent-listers-test-"));

const DAY = 86400000;
const NOW = Date.now();
const day = (d) => new Date(NOW - d * DAY).toISOString();
const listing = (n, over = {}) => ({
  formattedAddress: `${n} Yakima Ave, Tacoma, WA 98405`, addressLine1: `${n} Yakima Ave`, city: "Tacoma", state: "WA", zipCode: "98405", county: "Pierce",
  price: 360000, squareFootage: 1400, bedrooms: 3, yearBuilt: 1962, propertyType: "Single Family", status: "Inactive",
  listedDate: day(80), removedDate: day(30), daysOnMarket: 50,
  listingAgent: { name: `Robin Lister${n}`, phone: `253555${String(1000 + n).slice(-4)}`, email: `lister${n}@example.com` },
  listingOffice: { name: "Tacoma Realty" },
  ...over,
});
const LISTINGS = [
  listing(1, { history: { [day(30).slice(0, 10)]: { event: "Sold", price: 355000 } } }),  // a 1962 house that sold last month: kept
  listing(2),                                                                         // came down unsold last month: kept
  listing(3, { removedDate: day(150) }),                                              // came down five months ago
  listing(4, { yearBuilt: 2005 }),                                                    // a 2005 house, no cut: no fixer
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
const realFetch = globalThis.fetch;
let apifyAsked = 0;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith("https://api.apify.com/")) { apifyAsked++; return new Response("[]", { status: 200 }); }
  return realFetch(url, opts);
};

const { store } = await import("./store.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");
const { recentListings } = await import("./outreach-score.js");
const { outboundDescriptor } = await import("./reply-agent.js");
const { firstTextHook } = await import("./shared/outreach-opener.js");
const { standardText, PAST_LISTING_TEXTS } = await import("./shared/standard-texts.js");
const { freshListingFor, normalizeAgentPulse } = await import("./shared/agent-pulse.js");
const { startOutreachSweep, normalizeOutreachAutopilot, _resetJobs, PAGES_CURSOR } = await import("./outreach-sweep.js");

await store.init();
test.after(() => { mock.close(); globalThis.fetch = realFetch; });

test("a listing that came down in the last 90 days is kept whether it sold or not; one from five months ago isn't", () => {
  const { kept, dropped } = recentListings(LISTINGS, { now: NOW, withinDays: 90 });
  assert.deepEqual(kept.map((l) => l.addressLine1), ["1 Yakima Ave", "2 Yakima Ave", "4 Yakima Ave"]);
  assert.equal(dropped.notRecent, 1);
  assert.ok(kept.every((l) => l.pastListing === true));
  assert.equal(recentListings([listing(9, { status: "Active" })], { now: NOW }).kept.length, 0, "still listed is the regular pull's");
});

test("a Pierce agent whose 1962 listing sold last month is in the batch, with the house as their past listing", async () => {
  const L = "loc-recent-pull";
  await store.saveOfferSettings(L, { rentcastApiKey: "test-key", apifyToken: "apify-test" });
  const batch = await store.createOutreachBatch(L, { name: "Autopilot · Recent · Pierce, WA", autoNamed: false });
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: L, client: { async call() { return {}; } } }) });
  seen.length = 0;
  apifyAsked = 0;
  const r = await router.runPull(L, { async call() { return {}; } }, { zipCodes: "98405", status: "Inactive", recent: true, withinDays: 90,
    batchId: batch.id, daysOld: "14:360", distressRule: "cut-or-old", maxRequests: 1 });
  assert.equal(seen[0].status, "Inactive");
  assert.equal(apifyAsked, 0, "sold or not doesn't matter, so Zillow isn't asked");
  assert.ok(r.warnings.some((w) => /^recent listers: kept 3 of 4/.test(w)), r.warnings.join(" · "));
  const rows = await store.listOutreachAgents(L, { batchId: batch.id });
  const hooks = rows.map((x) => x.doc.hook.address).sort();
  assert.deepEqual(hooks, ["1 Yakima Ave, Tacoma, WA 98405", "2 Yakima Ave, Tacoma, WA 98405"], "the 2005 house isn't a fixer, and five months ago is too long");
  assert.ok(rows.every((x) => x.doc.hook.pastListing === true && x.doc.hook.removedDate));
  const listingRows = (await Promise.all(rows.map((x) => store.listOutreachListings(L, { batchId: batch.id, agentKey: x.agentKey })))).flat();
  assert.ok(listingRows.every((x) => x.doc.pastListing === true));
});

test("the first text names the house as theirs, in the past, and asks for the next one", () => {
  const doc = { brokerage: "Tacoma Realty", listingCount: 1, hook: { address: "1 Yakima Ave, Tacoma, WA 98405", county: "Pierce", city: "Tacoma", pastListing: true, removedDate: day(30) } };
  const hook = firstTextHook(doc);
  assert.equal(hook.pastListing, true);
  const o = outboundDescriptor({ kind: "outreach_open", offer: null, saved: {}, subject: { address: hook.address, county: hook.county, city: hook.city, house: hook } });
  assert.equal(o.pastListing, true);
  for (let variant = 0; variant < PAST_LISTING_TEXTS.length; variant++) {
    const t = standardText({ kind: "outreach_open", outbound: { ...o, variant }, name: "Robin Lister" });
    assert.equal(t.set, "past_listing");
    assert.match(t.text, /^(Hi|Hey) Robin, /, t.text);
    assert.match(t.text, /had 1 Yakima Ave/, t.text);
    assert.doesNotMatch(t.text, /came off|off the market lately|still hoping|is it a (bit of a )?project|does (it|this one) need/i, t.text);
    assert.match(t.text, /anything else|other fixers|got anything else/i, t.text);
  }
  const ai = standardText({ kind: "outreach_open", outbound: { ...o, mode: "ai", variant: 0 }, name: "Robin Lister" });
  assert.equal(ai.set, "past_listing", "the model has no words for a house that's gone: the fixed text either way");
  const noTown = standardText({ kind: "outreach_open", outbound: { ...o, city: "", variant: 0 }, name: "Robin Lister" });
  assert.match(noTown.text, /fix up houses locally/, "no town on record: the line that doesn't name one");
});

test("a recent lister's follow-up never asks whether that listing needs work", () => {
  const o = outboundDescriptor({ kind: "outreach_nudge", offer: null, saved: {}, subject: { address: "1 Yakima Ave, Tacoma, WA 98405", step: 2, steps: [2], county: "Pierce", pastListing: true } });
  assert.equal(o.pastListing, true);
  const t = standardText({ kind: "outreach_nudge", outbound: o, name: "Robin Lister" });
  assert.equal(t.set, "check_in");
  assert.doesNotMatch(t.text, /that listing|1 Yakima/, t.text);
  const plain = standardText({ kind: "outreach_nudge", outbound: { ...o, pastListing: false }, name: "Robin Lister" });
  assert.match(plain.text, /that listing|Yakima/, "everyone else's follow-up is unchanged");
});

test("a check-in never pings an agent about a listing that came down", () => {
  const past = { listingKey: "L-past", firstSeen: day(2), lastSeen: day(1), distressRule: "cut-or-old",
    doc: { address: "1 Yakima Ave, Tacoma, WA 98405", city: "Tacoma", qualifies: true, pastListing: true, yearBuilt: 1962, score: 40, distress: { old: true } } };
  assert.equal(freshListingFor({ listings: [past], settings: normalizeAgentPulse({ enabled: true }), now: NOW }), null);
  assert.ok(freshListingFor({ listings: [{ ...past, doc: { ...past.doc, pastListing: undefined } }], settings: normalizeAgentPulse({ enabled: true }), now: NOW }),
    "the same listing still up is news");
});

/* ---------- the sweep's side ---------- */

const settle = () => new Promise((r) => setTimeout(r, 30));
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
const row = (k, hook = {}, over = {}) => ({ agentKey: k, status: "new", contactId: null, doc: { name: k, phone: `25355${String(10000 + k.length * 97 + k.charCodeAt(0)).slice(-5)}`,
  distressedCount: 1, distressRule: "cut-or-old", hook: { yearBuilt: 1962, price: 360000, score: 40, pastListing: true, ...hook }, ghl: {}, ...over } });
const oct27 = Date.parse("2026-10-27T16:05:00Z");
const RECENT = "b-Autopilot · Recent · Pierce, WA";
const KING = "b-Autopilot · King, WA";
const depsFor = (bodies, calls) => ({
  runPull: async (_l, _c, b) => { bodies.push(b); return { ok: true, requestsUsed: 1, batchId: b.batchId, nextOffset: 0, totalCount: 40, listingsFetched: 40, listingsKept: 12, warnings: [] }; },
  importAgents: async (a) => { calls.push(a); return { imported: a.agentKeys.length, results: [] }; },
});
const savedWith = (recentListers) => ({ outreachAutopilot: { enabled: true, counties: [{ county: "King", state: "WA" }], monthlyRequests: 1000, dailyCap: 0,
  ...(recentListers ? { recentListers } : {}) } });

test("the recent listers' pull reads Pierce's Inactive listings into their own batch and the agents new to us are imported", async () => {
  _resetJobs();
  const bodies = [];
  const calls = [];
  const store2 = fakeStore({
    [RECENT]: [row("sold-1962"), row("in-ghl", {}, { ghl: { contactId: "c1" } }), row("new-2005", { yearBuilt: 2005 }), row("still-listed", { pastListing: undefined })],
    [KING]: [row("king1", { pastListing: undefined, priceCut: true })],
  });
  const job = startOutreachSweep({ locationId: "loc-rl", client: {}, saved: savedWith({ enabled: true, counties: ["Pierce, WA"], withinDays: 90 }), store: store2, deps: depsFor(bodies, calls), now: oct27 });
  await settle();
  assert.equal(job.status, "done", job.error);
  const recent = bodies.find((b) => b.recent);
  assert.ok(recent, "the recent listers were read");
  assert.equal(recent.status, "Inactive");
  assert.equal(recent.county, "Pierce");
  assert.equal(recent.state, "WA");
  assert.equal(recent.withinDays, 90);
  assert.equal(recent.daysOld, "1:360", "listed within about a year of the window, at any age");
  assert.equal(recent.batchId, RECENT);
  assert.deepEqual(calls.map((c) => [c.batchId, c.agentKeys]), [[RECENT, ["sold-1962"]], [KING, ["king1"]]],
    "one already in GHL, a 2005 house and a row that isn't a past listing stay out");
  assert.equal(job.recentListers.picked, 1);
  assert.equal(store2.cursors.get(`loc-rl|${PAGES_CURSOR}`).doc.recent["Pierce, WA"].offset, 0);
});

test("the listing check leaves a recent lister alone: the house isn't for sale to read", async () => {
  _resetJobs();
  const calls = [];
  const store2 = fakeStore({ [RECENT]: [row("sold-1962")] });
  const saved = savedWith({ enabled: true, counties: ["Pierce, WA"] });
  saved.outreachAutopilot.distressCheck = { enabled: true };
  startOutreachSweep({ locationId: "loc-rl-screen", client: {}, saved, store: store2, deps: depsFor([], calls), now: oct27 });
  await settle();
  assert.deepEqual(calls.map((c) => c.agentKeys), [["sold-1962"]]);
});

test("with the switch off the recent listers spend no requests", async () => {
  _resetJobs();
  const bodies = [];
  startOutreachSweep({ locationId: "loc-rl-off", client: {}, saved: savedWith(null), store: fakeStore({}), deps: depsFor(bodies, []), now: oct27 });
  await settle();
  assert.equal(bodies.some((b) => b.recent), false);
  assert.equal(normalizeOutreachAutopilot({}).recentListers.enabled, false, "ships off");
  assert.equal(normalizeOutreachAutopilot({ recentListers: { withinDays: 365 } }).recentListers.withinDays, 120);
});

test("the preview reads Pierce's recent listers and says who is new and what they'd get, importing nobody", async () => {
  const { default: express } = await import("express");
  const L = "loc-recent-preview";
  await store.saveOfferSettings(L, { rentcastApiKey: "test-key" });
  const client = { async call() { return {}; } };
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: L, client }) });
  const app = express();
  app.use(express.json());
  app.use("/api/outreach", router);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/outreach/recent-listers/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ county: "Pierce, WA", maxRequests: 1 }) });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.county, "Pierce, WA");
    assert.equal(body.pickable, 2, JSON.stringify(body));
    assert.equal(body.samples.length, 2);
    assert.ok(body.samples.every((t) => /had \d Yakima Ave/.test(t)), body.samples.join(" | "));
    const batch = (await store.listOutreachBatches(L)).find((b) => b.name === "Autopilot · Recent · Pierce, WA");
    const rows = await store.listOutreachAgents(L, { batchId: batch.id });
    assert.ok(rows.every((x) => x.status === "new"), "nobody imported");
    const bad = await realFetch(`http://127.0.0.1:${server.address().port}/api/outreach/recent-listers/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});
