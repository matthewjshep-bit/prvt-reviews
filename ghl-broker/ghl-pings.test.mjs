// ghl-pings.test.mjs — the few things only Matt can do, pinged through GHL
// (ghl-pings.js). The store is the JSON-file backend in a temp folder; GHL is
// a recorded stub.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ghl-pings-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { runGhlPings, maybeRunGhlPings, CURSOR_NAME } = await import("./ghl-pings.js");
const { GHL_PING_EVENT_TYPES } = await import("./shared/ghl-pings.js");
await store.init();
test.after(async () => { await new Promise((r) => setTimeout(r, 120)); fs.rmSync(DIR, { recursive: true, force: true }); });

// Tuesday 2026-10-20, 10:00am Pacific.
const NOW = Date.parse("2026-10-20T17:00:00Z");
const WF = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const ON = { desk: { ghlPings: { enabled: true, workflowId: `https://app.gohighlevel.com/location/loc/workflow/${WF}` } } };
const ROWS = [
  { id: "paper_to_sign:o1", kind: "paper_to_sign", contactId: "ann", offerId: "o1", title: "1010 Bellevue Way: paperwork to sign" },
  { id: "closing_task_due:o2", kind: "closing_task_due", contactId: "bo", offerId: "o2", title: "3831 Bagley Ave N: Purchase & sale signed" },
  { id: "price_it:o3", kind: "price_it", contactId: "cy", offerId: "o3", title: "Price it: 609 168th Ave NE" },
  { id: "call_brought:dee", kind: "call_brought", contactId: "dee", title: "brought us a house" },
];
const pipelineFor = (rows = ROWS) => async () => ({ deskAll: { rows }, desk: { rows }, drafts: [] });
function ghl({ failAdd = false } = {}) {
  const calls = [];
  return {
    calls,
    of: (method, rx) => calls.filter((c) => c.method === method && rx.test(c.path)),
    call: async (p, { method = "GET", body } = {}) => {
      calls.push({ method, path: p, body });
      if (/\/customFields$/.test(p)) return method === "GET" ? { customFields: [] } : { customField: { id: "cf-ping", name: body.name } };
      if (/\/workflow\//.test(p) && method === "POST" && failAdd) throw Object.assign(new Error(`GHL POST ${p} -> 500`), { status: 500 });
      return method === "PUT" ? { contact: {} } : { succeeded: true };
    },
  };
}
const enrolled = (client) => client.of("POST", /\/workflow\//).map((c) => c.path.split("/")[2]).sort();

// 2026-10-20, no Today: paperwork to sign and a closing task reach Matt; a
// house to price (GHL Tier 1) and a call (Manual Actions) have their own homes.
test("paperwork to sign and a closing task ping Matt through his workflow, once each", async () => {
  const LOC = "loc-once";
  const client = ghl();
  const r = await runGhlPings({ store, locationId: LOC, client, saved: ON, deps: { pipelineFor: pipelineFor() }, now: NOW });
  assert.equal(r.error, null);
  assert.deepEqual(enrolled(client), ["ann", "bo"]);
  assert.ok(client.of("POST", /\/workflow\//).every((c) => c.path.endsWith(`/workflow/${WF}`)));
  const put = client.of("PUT", /^\/contacts\/bo$/)[0];
  assert.deepEqual(put.body.customFields, [{ id: "cf-ping", value: "3831 Bagley Ave N: Purchase & sale signed — in Deals" }]);
  assert.ok(client.of("POST", /\/notes$/).length >= 2, "a note beside each");
  // The next tick pings nothing again.
  const again = ghl();
  await runGhlPings({ store, locationId: LOC, client: again, saved: ON, deps: { pipelineFor: pipelineFor() }, now: NOW + 900000 });
  assert.deepEqual(enrolled(again), []);
  const sent = await store.listContactEventsSince(LOC, new Date(NOW - 3600000).toISOString(), { types: GHL_PING_EVENT_TYPES, limit: 50 });
  assert.equal(sent.filter((e) => e.type === "ghl_ping_sent").length, 2);
});

test("with the switch off nothing goes to GHL, and a dry run only lists", async () => {
  const client = ghl();
  const off = await runGhlPings({ store, locationId: "loc-off", client, saved: {}, deps: { pipelineFor: pipelineFor() }, now: NOW });
  assert.match(off.error, /off/);
  const dry = await runGhlPings({ store, locationId: "loc-off", client, saved: {}, deps: { pipelineFor: pipelineFor() }, now: NOW, dryRun: true });
  assert.deepEqual(dry.pinged.map((p) => [p.contactId, p.status]), [["ann", "would ping"], ["bo", "would ping"]]);
  assert.equal(client.calls.length, 0);
  assert.equal(await maybeRunGhlPings({ client, locationId: "loc-off", saved: {}, store, deps: { pipelineFor: pipelineFor() }, now: NOW }), null);
});

test("a GHL failure is recorded against the claim and doesn't ping twice", async () => {
  const LOC = "loc-fail";
  const r = await runGhlPings({ store, locationId: LOC, client: ghl({ failAdd: true }), saved: ON, deps: { pipelineFor: pipelineFor() }, now: NOW });
  assert.equal(r.failed.length, 2);
  const again = ghl();
  await runGhlPings({ store, locationId: LOC, client: again, saved: ON, deps: { pipelineFor: pipelineFor() }, now: NOW + 900000 });
  assert.deepEqual(enrolled(again), []);
});

test("the tick pings in the day's window only, and leaves its run on the cursor", async () => {
  const LOC = "loc-tick";
  const night = Date.parse("2026-10-20T06:00:00Z"); // 11pm Pacific
  assert.equal(await maybeRunGhlPings({ client: ghl(), locationId: LOC, saved: ON, store, deps: { pipelineFor: pipelineFor() }, now: night }), null);
  const client = ghl();
  assert.deepEqual(await maybeRunGhlPings({ client, locationId: LOC, saved: ON, store, deps: { pipelineFor: pipelineFor() }, now: NOW }), { ran: true });
  assert.deepEqual(enrolled(client), ["ann", "bo"]);
  const cur = await store.getJobCursor(LOC, CURSOR_NAME);
  assert.equal(cur.doc.run, null);
  assert.equal(cur.doc.last.pinged.length, 2);
});
