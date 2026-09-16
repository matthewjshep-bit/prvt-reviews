// outreach-retry.test.mjs — a slow or failing RentCast doesn't cost the day.
// 2026-09-15: the 10am King pull hit the 15s timeout, the daily cursor was
// already stamped, and no outreach went out until the next workday.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-retry-test-"));
process.env.RENTCAST_TIMEOUT_MS = "200";
process.env.RENTCAST_RETRY_MS = "10";

let mode = "ok";
let hits = 0;
const mock = http.createServer((req, res) => {
  hits++;
  const first = hits === 1;
  if (mode === "fail-once" && first) { res.writeHead(503); res.end("busy"); return; }
  if (mode === "hang-once" && first) { setTimeout(() => { try { res.writeHead(200); res.end("[]"); } catch {} }, 600); return; }
  if (mode === "always-hang") { setTimeout(() => { try { res.writeHead(200); res.end("[]"); } catch {} }, 600); return; }
  if (mode === "bad-key") { res.writeHead(401); res.end("no"); return; }
  res.writeHead(200, { "Content-Type": "application/json", "X-Total-Count": "1" });
  res.end(JSON.stringify([{ formattedAddress: "1 Test St, Auburn, WA 98001", price: 400000 }]));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
process.env.RENTCAST_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

const { _rentcastPage } = await import("./routes/outreach.js");
const { maybeStartOutreachSweep, getOutreachJob, _resetJobs, CURSOR_NAME } = await import("./outreach-sweep.js");

test.after(() => mock.close());

test("RentCast: a 503 or a timeout is tried once more; a refusal is not", async () => {
  mode = "fail-once"; hits = 0;
  assert.equal((await _rentcastPage("k", {})).listings.length, 1);
  assert.equal(hits, 2);

  mode = "hang-once"; hits = 0;
  assert.equal((await _rentcastPage("k", {})).total, 1);
  assert.equal(hits, 2);

  mode = "always-hang"; hits = 0;
  await assert.rejects(_rentcastPage("k", {}), /didn't answer/);
  assert.equal(hits, 2);

  mode = "bad-key"; hits = 0;
  await assert.rejects(_rentcastPage("k", {}), /RentCast 401/);
  assert.equal(hits, 1);
});

const settle = () => new Promise((r) => setTimeout(r, 30));
const memStore = () => ({
  cursors: new Map(),
  async getJobCursor(l, k) { return this.cursors.get(`${l}|${k}`) || null; },
  async setJobCursor(l, k, v) { this.cursors.set(`${l}|${k}`, v); },
  async listOutreachPulls() { return []; },
});

test("a failed daily run is tried again through the working day, spaced out and at most six times", async () => {
  _resetJobs();
  const store = memStore();
  let pulls = 0;
  const deps = { runPull: async () => { pulls++; throw new Error("The operation was aborted due to timeout"); }, importAgents: async () => ({}) };
  const saved = { rentcastApiKey: "k", outreachAutopilot: { enabled: true } };
  const base = { locationId: "loc-r", client: {}, store, deps, saved, hour: 10 };
  const at = (pt) => Date.parse(`2026-09-15T${pt}:00-07:00`); // a Tuesday, Pacific

  assert.equal(await maybeStartOutreachSweep({ ...base, now: at("10:10") }), true);
  await settle();
  assert.equal(getOutreachJob("loc-r").status, "error");
  assert.equal(store.cursors.get(`loc-r|${CURSOR_NAME}`).doc.failed, true);

  assert.equal(await maybeStartOutreachSweep({ ...base, now: at("10:20") }), false, "too soon after the failure");
  assert.equal(await maybeStartOutreachSweep({ ...base, now: at("10:35") }), true, "second try");
  await settle();
  assert.equal(await maybeStartOutreachSweep({ ...base, now: at("11:00") }), true, "third try, past the 10am hour");
  await settle();
  // 2026-09-16: six tries, until 5pm — Matt asked for it to just happen.
  for (const t of ["11:30", "12:00", "12:30"]) { assert.equal(await maybeStartOutreachSweep({ ...base, now: at(t) }), true, `try at ${t}`); await settle(); }
  assert.equal(await maybeStartOutreachSweep({ ...base, now: at("13:00") }), false, "six tries is the most");
  assert.equal(pulls, 6);
});

test("retries stop at 5pm, and a run that worked is never repeated", async () => {
  _resetJobs();
  const at = (pt) => Date.parse(`2026-09-15T${pt}:00-07:00`);
  const saved = { rentcastApiKey: "k", outreachAutopilot: { enabled: true } };

  const failing = memStore();
  const failDeps = { runPull: async () => { throw new Error("RentCast 503"); }, importAgents: async () => ({}) };
  assert.equal(await maybeStartOutreachSweep({ locationId: "loc-late", client: {}, store: failing, deps: failDeps, saved, hour: 10, now: at("10:05") }), true);
  await settle();
  assert.equal(await maybeStartOutreachSweep({ locationId: "loc-late", client: {}, store: failing, deps: failDeps, saved, hour: 10, now: at("17:05") }), false, "past the retry window");

  const worked = memStore();
  await worked.setJobCursor("loc-ok", CURSOR_NAME, { at: new Date(at("10:05")).toISOString(), doc: { tries: 1 } });
  assert.equal(await maybeStartOutreachSweep({ locationId: "loc-ok", client: {}, store: worked, deps: failDeps, saved, hour: 10, now: at("10:45") }), false, "no failure, no retry");
  assert.equal(await maybeStartOutreachSweep({ locationId: "loc-ok", client: {}, store: worked, deps: failDeps, saved, hour: 10, now: at("11:15") }), false, "and not a fresh run outside 10am");
});
