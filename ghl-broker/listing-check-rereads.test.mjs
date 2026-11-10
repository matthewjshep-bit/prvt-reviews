// listing-check-rereads.test.mjs — the listing check reads again what the old
// rules got wrong, a sending day that opens nobody says so in Slack, and a
// late retry doesn't cost the next morning (2026-11-09 audit: first texts to
// new agents fell from about 58 a sending day to 2, and nothing said so).
// Streets, remarks and ids are made up.
//
//   node --test listing-check-rereads.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "listing-check-rereads-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const {
  screenAddresses, maybeStartOutreachSweep, startOutreachSweep, normalizeOutreachAutopilot, getOutreachJob, _resetJobs,
  CURSOR_NAME, SCREEN_CURSOR, SCREEN_RULES_VERSION, SCREEN_KEEP_OK_DAYS, RETRY_GAP_MS,
} = await import("./outreach-sweep.js");
const { runSlackPings } = await import("./slack-notify.js");
const { streetKey } = await import("./comps-zillow.js");

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; fs.rmSync(DIR, { recursive: true, force: true }); });

const DAY = 86400000;
const MIN = 60000;
const iso = (t) => new Date(t).toISOString();
// Monday 2026-11-09, 10:05am Pacific.
const MON = Date.parse("2026-11-09T18:05:00Z");

const fakeStore = (rows = []) => ({
  cursors: new Map(),
  async listOutreachAgents() { return rows; },
  async listOutreachPulls() { return []; },
  async getJobCursor(l, n) { return this.cursors.get(`${l}|${n}`) || null; },
  async setJobCursor(l, n, v) { this.cursors.set(`${l}|${n}`, v); return v; },
  async listJobCursors(l) {
    return [...this.cursors].filter(([k]) => k.startsWith(`${l}|`)).map(([k, c]) => ({ name: k.slice(l.length + 1), at: c.at, doc: c.doc }));
  },
  async listAppErrorsSince() { return []; },
});
const agent = (k, street) => ({
  agentKey: k, status: "new", contactId: null,
  doc: { name: k, phone: `20655501${k.slice(-2).padStart(2, "0")}`, distressedCount: 2, distressRule: "cut-or-old", listingCount: 1,
    hook: { priceCut: true, address: `${street}, Tacoma, WA`, score: 50, price: 380000 }, ghl: {} },
});
const zillowSays = (description, status = "FOR_SALE") => async ({ addresses }) =>
  new Map(addresses.map((a) => [streetKey(a), { status, description }]));
const settle = async (locationId) => {
  for (let i = 0; i < 200 && getOutreachJob(locationId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 10));
};
const SWEEP = (over = {}) => ({ rentcastApiKey: "k", outreachAutopilot: { enabled: true, hour: 10, dailyCap: 10, firstTouch: "ghl", distressCheck: { enabled: true }, ...over } });

/* ---------- the listing check's memory ---------- */

test("a verdict saved under the old rules is read again", async () => {
  const store = fakeStore();
  const at = iso(MON - 5 * DAY);
  store.cursors.set(`L|${SCREEN_CURSOR}`, { at, doc: { seen: {
    // Read before the needs-work phrases were added: read again.
    [streetKey("210 Alder Ln, Tacoma, WA")]: { at, ok: false, why: "nothing in the remarks says it needs work" },
    // A finished read stands, whatever the rules.
    [streetKey("212 Alder Ln, Tacoma, WA")]: { at, ok: false, why: "reads finished (move-in ready)" },
    // Already read under today's rules.
    [streetKey("214 Alder Ln, Tacoma, WA")]: { at, ok: false, why: "nothing in the remarks says it needs work", v: SCREEN_RULES_VERSION },
  } } });
  const asked = [];
  const deps = { screenListings: async (a) => { asked.push(...a.addresses); return zillowSays("Needs new flooring and paint.")(a); } };
  const items = ["210", "212", "214"].map((n) => ({ id: n, address: `${n} Alder Ln, Tacoma, WA` }));
  const { verdict, stats } = await screenAddresses({ items, locationId: "L", store, deps, now: MON });
  assert.deepEqual(asked, ["210 Alder Ln, Tacoma, WA"]);
  assert.equal(verdict.get("210"), true, "read again by the new rules, and kept");
  assert.equal(verdict.get("212"), false);
  assert.equal(verdict.get("214"), false);
  assert.equal(stats.reread, 1);
  assert.equal(stats.rememberedDrops, 2);
  const seen = store.cursors.get(`L|${SCREEN_CURSOR}`).doc.seen;
  assert.equal(seen[streetKey("210 Alder Ln, Tacoma, WA")].v, SCREEN_RULES_VERSION, "stamped with the rules it was read by");
});

test("a for-sale verdict older than 3 days is read again", async () => {
  assert.equal(SCREEN_KEEP_OK_DAYS, 3);
  const store = fakeStore();
  store.cursors.set(`L2|${SCREEN_CURSOR}`, { at: iso(MON), doc: { seen: {
    [streetKey("300 Birch Ct, Tacoma, WA")]: { at: iso(MON - 4 * DAY), ok: true, signals: ["fixer"], v: SCREEN_RULES_VERSION },
    [streetKey("302 Birch Ct, Tacoma, WA")]: { at: iso(MON - 2 * DAY), ok: true, signals: ["fixer"], v: SCREEN_RULES_VERSION },
  } } });
  const asked = [];
  // It went pending since: the ping would have named a house that's gone.
  const deps = { screenListings: async (a) => { asked.push(...a.addresses); return zillowSays("Fixer.", "PENDING")(a); } };
  const items = ["300", "302"].map((n) => ({ id: n, address: `${n} Birch Ct, Tacoma, WA` }));
  const { verdict } = await screenAddresses({ items, locationId: "L2", store, deps, now: MON });
  assert.deepEqual(asked, ["300 Birch Ct, Tacoma, WA"]);
  assert.equal(verdict.get("300"), false);
  assert.equal(verdict.get("302"), true, "two days old is still trusted");
});

/* ---------- a listing check that couldn't run ---------- */

test("a sweep whose listing check throws is marked failed and retried", async () => {
  _resetJobs();
  const LOC = "loc-throws";
  const store = fakeStore([agent("a01", "400 Cedar Rd"), agent("a02", "402 Cedar Rd")]);
  const deps = {
    runPull: async () => ({ batchId: "b1", warnings: [], requestsUsed: 1 }),
    importAgents: async () => ({ results: [], imported: 0 }),
    // Up, but every read of a listing fails.
    screenListings: async ({ addresses }) => { if (addresses.length) throw new Error("listing lookup failed (actor 502)"); return new Map(); },
  };
  assert.equal(await maybeStartOutreachSweep({ locationId: LOC, client: {}, store, deps, saved: SWEEP(), now: MON }), true);
  await settle(LOC);
  const doc = store.cursors.get(`${LOC}|${CURSOR_NAME}`).doc;
  assert.equal(doc.failed, true, "a day the check couldn't read is not a finished day");
  assert.match(doc.error, /listing check/);
  assert.equal(await maybeStartOutreachSweep({ locationId: LOC, client: {}, store, deps, saved: SWEEP(), now: MON + RETRY_GAP_MS + MIN }), true, "the tick tries the day again");
  await settle(LOC);
  assert.equal(store.cursors.get(`${LOC}|${CURSOR_NAME}`).doc.tries, 2);
});

test("a listing check that can't run at all fails before RentCast is asked", async () => {
  _resetJobs();
  const LOC = "loc-no-token";
  let pulls = 0;
  const store = fakeStore([agent("b01", "500 Dogwood Way")]);
  const deps = {
    runPull: async () => { pulls++; return { batchId: "b1", warnings: [] }; },
    importAgents: async () => ({ results: [], imported: 0 }),
    screenListings: async () => { throw new Error("no Apify token in Settings"); },
  };
  assert.equal(await maybeStartOutreachSweep({ locationId: LOC, client: {}, store, deps, saved: SWEEP(), now: MON }), true);
  await settle(LOC);
  assert.equal(pulls, 0, "no request spent on a day nobody can be checked");
  const doc = store.cursors.get(`${LOC}|${CURSOR_NAME}`).doc;
  assert.equal(doc.failed, true);
  assert.match(doc.error, /no Apify token/);
});

/* ---------- a day that opens nobody ---------- */

test("the empty-day alert is on at 10 new agents a day, and 0 turns it off", () => {
  assert.equal(normalizeOutreachAutopilot({}).minNewAgentsPerDay, 10);
  assert.equal(normalizeOutreachAutopilot({ minNewAgentsPerDay: 0 }).minNewAgentsPerDay, 0);
  assert.equal(normalizeOutreachAutopilot({ minNewAgentsPerDay: "4" }).minNewAgentsPerDay, 4);
  assert.equal(normalizeOutreachAutopilot({ minNewAgentsPerDay: "lots" }).minNewAgentsPerDay, 10);
});

function slack() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/api/")[1], body: JSON.parse(init.body) });
    return Response.json({ ok: true, ts: `1700000000.000${calls.length}` });
  };
  return calls;
}
const SLACK = { slackBotToken: "xoxb-test-token", slack: { enabled: true, channels: { machine: "C0MACH0001" }, streams: { machine: true } } };

test("a day that opens nobody posts the reason to the machine channel once", async () => {
  _resetJobs();
  const LOC = "loc-empty";
  const store = fakeStore([agent("c01", "600 Elm Pl"), agent("c02", "602 Elm Pl")]);
  const deps = {
    runPull: async () => ({ batchId: "b1", warnings: [], requestsUsed: 1 }),
    importAgents: async () => ({ results: [], imported: 0 }),
    screenListings: zillowSays("Three bedrooms near the park."),
  };
  assert.equal(await maybeStartOutreachSweep({ locationId: LOC, client: {}, store, deps, saved: SWEEP(), now: MON }), true);
  await settle(LOC);
  const cursor = store.cursors.get(`${LOC}|${CURSOR_NAME}`).doc;
  assert.notEqual(cursor.failed, true, cursor.error);
  assert.equal(cursor.emptyDay?.day, "2026-11-09");

  const calls = slack();
  const saved = { ...SWEEP(), ...SLACK };
  await runSlackPings({ store, locationId: LOC, saved, now: MON + 20 * MIN });
  const posts = calls.filter((c) => c.method === "chat.postMessage");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.channel, "C0MACH0001");
  const said = [posts[0].body.text, ...(posts[0].body.blocks || []).map((b) => b.text?.text)].join("\n");
  assert.match(said, /Agent sweep opened 0 new agents today/);
  assert.match(said, /picked 2, remembered drops 0, read 2, kept 0/);
  assert.match(said, /Biggest reason: no sign it needs work \(2\)/);
  assert.doesNotMatch(said, /Elm|c0[12]|2065550/, "counts only: no street, id or phone");
  assert.equal(store.cursors.get(`${LOC}|${CURSOR_NAME}`).doc.lastEmptyAlertDay, "2026-11-09");

  // Once a day: the next tick, and the next morning before a new run, say nothing.
  await runSlackPings({ store, locationId: LOC, saved, now: MON + 35 * MIN });
  await runSlackPings({ store, locationId: LOC, saved, now: MON + DAY - 60 * MIN });
  assert.equal(calls.filter((c) => c.method === "chat.postMessage").length, 1);
});

test("a day that opens its number, or a run by hand, posts nothing", async () => {
  _resetJobs();
  const LOC = "loc-full";
  const rows = Array.from({ length: 10 }, (_, i) => agent(`d${String(i).padStart(2, "0")}`, `${700 + i} Fir St`));
  const deps = {
    runPull: async () => ({ batchId: "b1", warnings: [], requestsUsed: 1 }),
    importAgents: async (a) => ({ results: a.agentKeys.map((agentKey) => ({ agentKey, ok: true, action: "created" })), imported: a.agentKeys.length }),
    screenListings: zillowSays("Fixer, sold as-is."),
  };
  const store = fakeStore(rows);
  assert.equal(await maybeStartOutreachSweep({ locationId: LOC, client: {}, store, deps, saved: SWEEP(), now: MON }), true);
  await settle(LOC);
  assert.equal(store.cursors.get(`${LOC}|${CURSOR_NAME}`).doc.emptyDay ?? null, null, "ten new agents is the day's number");

  _resetJobs();
  const quiet = fakeStore([]);
  startOutreachSweep({ locationId: "loc-hand", client: {}, store: quiet, deps, saved: SWEEP(), now: MON });
  await settle("loc-hand");
  assert.equal(quiet.cursors.get(`loc-hand|${CURSOR_NAME}`).doc.emptyDay ?? null, null, "Run now isn't the day's run");
});

/* ---------- the day's gate ---------- */

test("a retry at 2:30pm doesn't cost tomorrow's sweep", async () => {
  _resetJobs();
  const LOC = "loc-late";
  const store = fakeStore([]);
  // Monday's day was retried at 2:30pm Pacific and finished.
  const retried = Date.parse("2026-11-09T22:30:00Z");
  store.cursors.set(`${LOC}|${CURSOR_NAME}`, { at: iso(retried), doc: { tries: 2, last: { status: "done" } } });
  const deps = { runPull: async () => ({ batchId: "b1", warnings: [] }), importAgents: async () => ({}) };
  const saved = { rentcastApiKey: "k", outreachAutopilot: { enabled: true, hour: 10 } };
  const tue = Date.parse("2026-11-10T18:05:00Z"); // Tuesday 10:05am Pacific, under 20 hours later
  assert.equal(await maybeStartOutreachSweep({ locationId: LOC, client: {}, store, deps, saved, now: tue }), true);
  await settle(LOC);
  const doc = store.cursors.get(`${LOC}|${CURSOR_NAME}`).doc;
  assert.equal(doc.tries, 1, "a new day, not a retry");
  assert.equal(doc.lastDaily, iso(tue));
  assert.equal(await maybeStartOutreachSweep({ locationId: LOC, client: {}, store, deps, saved, now: tue + 30 * MIN }), false, "still once a day");
});
