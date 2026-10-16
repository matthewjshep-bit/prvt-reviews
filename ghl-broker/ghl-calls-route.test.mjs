// ghl-calls-route.test.mjs — Today with calls in GHL's Manual Actions.
//
// Matt, 2026-10-15: calls live in GHL only. Once a call is in GHL's queue it
// leaves Today; a counter above ours and partner terms stay for their
// buttons, marked as in GHL. Off, Today is exactly what it was.
//
//   node --test ghl-calls-route.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ghl-calls-route-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");
const { pacificDay } = await import("./ghl-calls.js");

const LOC = "loc-ghl-calls-route";
const client = { call: async () => ({}) };
const router = createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client }) });
const app = express();
app.use(express.json());
app.use("/api/dashboard", router);
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(async () => { server.close(); await new Promise((r) => setTimeout(r, 120)); fs.rmSync(DIR, { recursive: true, force: true }); });

const H = 3600000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();
const WF = "7f1c2a9e-0b3d-4e5f-8a6b-1c2d3e4f5a6b";
const today = pacificDay(Date.now());
const pipeline = async () => { const r = await (await fetch(`${B}/api/dashboard/pipeline`)).json(); assert.equal(r.ok, true, r.error); return r; };
const queue = (contactId, kind, at = ago(0.5)) => recordEvent({ store, locationId: LOC, contactId, type: "ghl_call_queued", at, source: "sweep",
  dedupeKey: `ghl_call:${contactId}:${today}`, data: { kind, workflowId: WF } });

await store.saveOfferSettings(LOC, {});
// A hot offer (a call), and a counter above ours (a decision with a call).
await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "dana", contactName: "Dana Agent", address: "12 Elm St, Kent, WA 98030",
  status: "sent", cashAmount: 300000, hot: { at: ago(5), by: "operator" }, statusHistory: [], createdAt: ago(100), sends: [{ ts: ago(90) }] });
await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "gus", contactName: "Gus Agent", address: "9 Pine Rd, Auburn, WA 98002",
  status: "countered", cashAmount: 300000, counter: { amount: 340000, at: ago(3) }, statusHistory: [], createdAt: ago(100), sends: [{ ts: ago(90) }] });

test("off, Today keeps every call — even one somebody queued in GHL", async () => {
  await queue("dana", "call_hot");
  const r = await pipeline();
  const kinds = r.desk.rows.map((x) => `${x.contactId}:${x.kind}`);
  assert.ok(kinds.includes("dana:call_hot"), kinds.join(", "));
  assert.ok(kinds.includes("gus:call_counter"), kinds.join(", "));
  assert.equal(r.desk.ghlCalls, undefined);
  assert.equal(r.desk.sections.find((s) => s.key === "call").empty, "No calls today.");
});

test("on, a call in GHL leaves Today; the counter stays, marked as in GHL; the counts follow", async () => {
  await store.saveOfferSettings(LOC, { desk: { ghlCalls: { enabled: true, workflowId: WF } } });
  const before = await pipeline();
  const dana = before.desk.rows.filter((x) => x.contactId === "dana");
  assert.ok(!dana.some((x) => x.kind === "call_hot" || x.also.some((a) => a.kind === "call_hot")), "Dana's call is in GHL");
  assert.deepEqual(dana.map((x) => x.kind), ["pre_contract"], "her hot offer's check before signing is still a decision");
  const gus = before.desk.rows.find((x) => x.contactId === "gus");
  assert.equal(gus.ghlQueued, undefined, "Gus's counter isn't in GHL yet");
  await queue("gus", "call_counter");
  const r = await pipeline();
  const g = r.desk.rows.find((x) => x.contactId === "gus");
  assert.equal(g.kind, "call_counter", "the counter's buttons stay on Today");
  assert.ok(g.ghlQueued?.at, "and it says the call is in GHL");
  assert.equal(r.desk.counts.call, 0);
  assert.equal(r.desk.sections.find((s) => s.key === "call").empty, "Today's calls are in GHL's Manual Actions.");
  assert.deepEqual(r.desk.ghlCalls, { on: true, inGhlToday: 2 });
  // The board (`actions`) is untouched.
  assert.deepEqual(r.actions.map((a) => a.id), before.actions.map((a) => a.id));
});

test("a call that failed to go to GHL stays on Today", async () => {
  await store.saveOfferSettings(LOC, { desk: { ghlCalls: { enabled: true, workflowId: WF } } });
  await recordEvent({ store, locationId: LOC, contactId: "dana", type: "ghl_call_failed", at: ago(0.4), source: "sweep",
    dedupeKey: `ghl_call_failed:ghl_call:dana:${today}`, data: { claimKey: `ghl_call:dana:${today}`, failed: true, error: "GHL 500" } });
  const r = await pipeline();
  assert.ok(r.desk.rows.some((x) => x.contactId === "dana" && x.kind === "call_hot"));
  // The runner's view (pipelineFor) keeps Today before the GHL hide.
  const read = await router.pipelineFor({ locationId: LOC, client });
  assert.ok(read.deskAll.rows.some((x) => x.contactId === "gus" && !x.ghlQueued));
});
