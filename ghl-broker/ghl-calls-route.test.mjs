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
const { pacificDay, ghlCallsSettled } = await import("./ghl-calls.js");

const LOC = "loc-ghl-calls-route";
// GHL, recorded: every contact has a phone; the two fields get made on first use.
const sent = [];
const defs = [];
const client = {
  call: async (p, { method = "GET", body } = {}) => {
    sent.push({ method, path: p, body });
    if (method === "GET" && /^\/contacts\/[^/]+$/.test(p)) return { contact: { id: p.split("/")[2], phone: "+12065550100" } };
    if (/\/customFields$/.test(p)) {
      if (method === "GET") return { customFields: defs };
      const f = { id: `cf-${defs.length + 1}`, name: body.name, fieldKey: `contact.${body.name.toLowerCase().replace(/\s+/g, "_")}` };
      defs.push(f);
      return { customField: f };
    }
    return {};
  },
};
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

test("GET /ghl-calls shows the setting, who went in today, and who failed", async () => {
  await store.saveOfferSettings(LOC, { desk: { ghlCalls: { enabled: true, workflowId: `https://app.gohighlevel.com/location/x/workflow/${WF}` } } });
  const r = await (await fetch(`${B}/api/dashboard/ghl-calls`)).json();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.on, true);
  assert.equal(r.settings.workflowId, WF);
  assert.deepEqual(r.window, { start: 8.5, end: 17 });
  assert.deepEqual(r.today.queued.map((q) => [q.contactId, q.inGhl, q.ended]).sort(), [["dana", false, "ghl_call_failed"], ["gus", true, null]]);
  assert.deepEqual(r.today.failed.map((f) => f.contactId), ["dana"]);
  assert.equal(r.inGhl, 1);
  assert.equal(r.cursor, null, "the job hasn't run");
});

test("POST /ghl-calls/run lists who would go without writing; a real run needs the switch", async () => {
  await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "eli", contactName: "Eli Agent", address: "5 Cedar Way, Renton, WA 98055",
    status: "sent", cashAmount: 410000, hot: { at: ago(2), by: "operator" }, statusHistory: [], createdAt: ago(100), sends: [{ ts: ago(90) }] });
  const before = await store.listContactEventsSince(LOC, ago(48), { types: ["ghl_call_queued", "ghl_call_failed", "ghl_call_withdrawn"], limit: 100 });
  sent.length = 0;
  const dry = await (await fetch(`${B}/api/dashboard/ghl-calls/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "morning" }) })).json();
  assert.equal(dry.ok, true, dry.error);
  assert.equal(dry.dryRun, true, "a dry run unless you say otherwise");
  assert.deepEqual(dry.queued.map((q) => [q.contactId, q.kind, q.status]), [["eli", "call_hot", "would go to GHL"]]);
  assert.ok(dry.skipped.some((x) => x.contactId === "gus" && x.why === "already in GHL today"));
  assert.ok(dry.skipped.some((x) => x.contactId === "dana" && /tried earlier today/.test(x.why)), "a failed call stays on Today for the day");
  assert.equal(sent.filter((c) => c.method !== "GET").length, 0, "nothing written to GHL");
  const after = await store.listContactEventsSince(LOC, ago(48), { types: ["ghl_call_queued", "ghl_call_failed", "ghl_call_withdrawn"], limit: 100 });
  assert.equal(after.length, before.length, "nothing written to the timeline");

  await store.saveOfferSettings(LOC, {});
  const off = await fetch(`${B}/api/dashboard/ghl-calls/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun: false }) });
  assert.equal(off.status, 400);
  assert.match((await off.json()).error, /off/);

  await store.saveOfferSettings(LOC, { desk: { ghlCalls: { enabled: true, workflowId: WF } } });
  const live = await fetch(`${B}/api/dashboard/ghl-calls/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun: false, mode: "morning" }) });
  assert.equal(live.status, 202);
  await ghlCallsSettled(LOC);
  assert.deepEqual(sent.filter((c) => c.method === "POST" && /\/workflow\//.test(c.path)).map((c) => c.path), [`/contacts/eli/workflow/${WF}`]);
  const r = await (await fetch(`${B}/api/dashboard/ghl-calls`)).json();
  assert.ok(r.today.queued.some((q) => q.contactId === "eli" && q.inGhl && q.trigger === "manual"));
  assert.equal(r.cursor.hand.last.queued[0].contactId, "eli");
  assert.equal(r.cursor.fieldsSet, true);
  // And Eli's call has left Today.
  const t = await pipeline();
  assert.ok(!t.desk.rows.some((x) => x.contactId === "eli" && x.kind === "call_hot"));
});

