// heavy-reads.test.mjs — opening Reports can't knock over the broker.
//
// 2026-11-09, 18:21 PT: the one broker that takes GHL's webhooks flapped 502
// for about six minutes right after /line. /line and /followup cached only
// after they finished, so two opens at once both ran both check-in planners;
// /outreach/pulse ran the agent planner uncached (28 seconds); Flow read the
// 3.5MB investor book on every thirty-second poll; the Autopilot tabs built
// all of Today for their switch pills; and each tick read Today three or four
// times over. On the JSON store, through the real routers.
//
//   node --test heavy-reads.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-reads-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");
const { _resetPulsePlans } = await import("./pulse-plans.js");
const { createMemo, createGate, settingsSig } = await import("./read-memo.js");

const LOC = "loc-heavy-reads";
const client = { call: async () => ({}) };
const resolveLocation = () => ({ locationId: LOC, client });
const dashboard = createDashboardRouter({ resolveLocation });
const app = express();
app.use(express.json());
app.use("/api/dashboard", dashboard);
app.use("/api/outreach", createOutreachRouter({ resolveLocation }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const get = async (p) => { const r = await fetch(`${B}${p}`); const j = await r.json(); assert.equal(r.status, 200, j.error); return j; };

// Count calls to store methods while `fn` runs. `slowMs` makes each counted
// read take that long, the way a real database does, so requests overlap.
async function counting(names, fn, { slowMs = 0 } = {}) {
  const real = {};
  const n = Object.fromEntries(names.map((k) => [k, 0]));
  for (const k of names) {
    real[k] = store[k];
    store[k] = async (...a) => { n[k]++; if (slowMs) await new Promise((r) => setTimeout(r, slowMs)); return real[k].apply(store, a); };
  }
  try { await fn(); } finally { for (const k of names) store[k] = real[k]; }
  return n;
}

await store.saveOfferSettings(LOC, { conversationAi: { enabled: true } });
await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-1", contactName: "Morgan Invented", address: "40 Bramble Rd, Kent, WA 98031",
  status: "sent", cashAmount: 280000, sends: [{ ts: ago(3), channels: ["sms"] }], statusHistory: [], createdAt: ago(5) });

test("two people opening Line at once compute it once", async () => {
  const n = await counting(["listDeals"], async () => {
    const [a, b, c] = await Promise.all([get("/api/dashboard/line"), get("/api/dashboard/line"), get("/api/dashboard/line?fresh=1")]);
    assert.equal(a.generatedAt, b.generatedAt);
    assert.equal(a.generatedAt, c.generatedAt, "?fresh=1 joins the compute already running");
  }, { slowMs: 150 });
  assert.equal(n.listDeals, 1, "one compute for three opens");
  const again = await counting(["listDeals"], () => get("/api/dashboard/line"));
  assert.equal(again.listDeals, 0, "kept a minute");
  const fresh = await counting(["listDeals"], () => get("/api/dashboard/line?fresh=1"));
  assert.equal(fresh.listDeals, 1, "?fresh=1 with nothing running computes it again");
});

test("Line, Follow-up and the outreach check-in page share one check-in plan", async () => {
  _resetPulsePlans();
  const n = await counting(["listFreshAgentListings"], async () => {
    await get("/api/dashboard/line?fresh=1");
    await get("/api/dashboard/followup?period=week&fresh=1");
    const pulse = await get("/api/outreach/pulse");
    assert.ok(pulse.counts, "the check-in page still answers");
  });
  assert.equal(n.listFreshAgentListings, 1, "the agent planner ran once for all three");

  // A settings save starts a new plan, whichever route saved.
  const saved = await store.getOfferSettings(LOC);
  await store.saveOfferSettings(LOC, { ...saved, lineTargets: { offersPerDay: 9 } });
  const after = await counting(["listFreshAgentListings"], () => get("/api/outreach/pulse"));
  assert.equal(after.listFreshAgentListings, 1);
});

test("the Autopilot tabs load without reading the whole pipeline", async () => {
  const n = await counting(["listOffers", "listInvestors", "listContactEventsSince"], async () => {
    const r = await get("/api/dashboard/autopilot");
    assert.ok(Array.isArray(r.autopilot.switches), "the switch pills");
    assert.equal(typeof r.autopilot.mode, "string");
    assert.equal(r.conversationEnabled, true);
  });
  assert.deepEqual(n, { listOffers: 0, listInvestors: 0, listContactEventsSince: 0 });
});

test("Flow reads its few missing names by id, never the whole investor book", async () => {
  await store.upsertInvestors(LOC, [{ contactId: "buyer-9", name: "Avery Buyer", doc: { name: "Avery Buyer" } }]);
  await store.appendContactEvents(LOC, "buyer-9", [{ type: "investor_committed", at: ago(1), source: "operator", offerId: "o-x", address: "40 Bramble Rd, Kent, WA 98031" }]);
  const n = await counting(["listInvestors", "contactNamesByIds"], async () => {
    const r = await get("/api/dashboard/flow?days=7");
    assert.equal(typeof r.coldNoReply, "number");
    assert.ok(Array.isArray(r.stages));
    const row = r.feed.find((f) => f.contactId === "buyer-9");
    if (row) assert.equal(row.contactName, "Avery Buyer");
  });
  assert.equal(n.listInvestors, 0);
  const again = await counting(["listOffers"], () => get("/api/dashboard/flow?days=7"));
  assert.equal(again.listOffers, 0, "a poll inside the window shares the last compute");
});

test("the tick's jobs share one Today read", async () => {
  const n = await counting(["listInvestors"], async () => {
    await Promise.all([dashboard.pipelineForTick({ locationId: LOC, client }), dashboard.pipelineForTick({ locationId: LOC, client })]);
    await dashboard.pipelineForTick({ locationId: LOC, client });
  });
  assert.equal(n.listInvestors, 1, "ghl-calls, needs-matt and slack read Today once a tick");
  const fresh = await counting(["listInvestors"], () => get("/api/dashboard/pipeline"));
  assert.equal(fresh.listInvestors, 1, "GET /pipeline stays fresh on every poll");
});

/* ---------- the pieces ---------- */

test("the heavy computes run one at a time, and one inside another doesn't wait on itself", async () => {
  const gate = createGate(1);
  let running = 0, most = 0;
  const work = () => gate(async () => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 5)); running--; return "done"; });
  assert.deepEqual(await Promise.all([work(), work(), work()]), ["done", "done", "done"]);
  assert.equal(most, 1);
  assert.equal(await gate(() => gate(async () => "nested")), "nested", "no deadlock");
});

test("a memo joins a compute in flight, keeps a result, forgets a failure, and a settings change starts over", async () => {
  const memo = createMemo({ ttlMs: 1000, gate: createGate(1) });
  let runs = 0;
  const run = async () => { runs++; await new Promise((r) => setTimeout(r, 5)); return runs; };
  const [a, b] = await Promise.all([memo.get("k", run, { sig: "s1", now: 0 }), memo.get("k", run, { sig: "s1", now: 0, fresh: true })]);
  assert.deepEqual([a, b, runs], [1, 1, 1]);
  assert.equal(await memo.get("k", run, { sig: "s1", now: 500 }), 1, "kept");
  assert.equal(await memo.get("k", run, { sig: "s1", now: 1500 }), 2, "past its time, computed again");
  assert.equal(await memo.get("k", run, { sig: "s2", now: 1500 }), 3, "settings changed");
  await assert.rejects(memo.get("bad", async () => { throw new Error("no"); }, { now: 0 }));
  assert.equal(await memo.get("bad", async () => "ok", { now: 0 }), "ok", "a failure isn't kept");
  assert.notEqual(settingsSig({ a: 1 }), settingsSig({ a: 2 }));
  assert.equal(settingsSig(null), settingsSig({}));
});
