// needs-matt.test.mjs — the runner that keeps GHL's "Needs Matt" stage
// (needs-matt.js). The store is the JSON-file backend in a temp folder; the
// pipeline read, the card sync and GHL are stubs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "needs-matt-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { runNeedsMatt, maybeRunNeedsMatt } = await import("./needs-matt.js");
const { NEEDS_MATT_CURSOR, NEEDS_MATT_EVENT } = await import("./shared/needs-matt.js");
await store.init();
test.after(async () => { await new Promise((r) => setTimeout(r, 120)); fs.rmSync(DIR, { recursive: true, force: true }); });

// Thursday 2026-10-22, 11:00am Pacific.
const NOW = Date.parse("2026-10-22T18:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const ON = { ghlStages: { mode: "on" } };
const STAGES = [{ id: "s-nm", name: "Needs Matt" }, { id: "s-t1", name: "Tier 1 - Hot" }, { id: "s-t2", name: "Tier 2 - Warm" }, { id: "s-out", name: "Offer Out" }];
const ghlWith = (stages) => {
  const calls = [];
  return {
    calls,
    listPipelines: async () => [{ id: "acq", name: "Acquisitions", stages }],
    call: async (p, { method = "GET", body } = {}) => {
      calls.push({ method, path: p, body });
      if (/\/customFields$/.test(p)) return method === "GET" ? { customFields: [] } : { customField: { id: "cf-why", name: body.name } };
      return method === "PUT" ? { contact: {} } : { succeeded: true };
    },
  };
};
const YES = { id: "approve_number:o-ann", kind: "approve_number", contactId: "ann", offerId: "o-ann", address: "123 Main St, Kent, WA", amount: 715000 };
const PRICE = { id: "price_it:o-bo", kind: "price_it", contactId: "bo", offerId: "o-bo", address: "9 Elm St, Auburn, WA", readyAt: hoursAgo(30) };
const FRESH = { id: "price_it:o-cy", kind: "price_it", contactId: "cy", offerId: "o-cy", address: "4 Oak St, Kent, WA", readyAt: hoursAgo(2) };
const pipelineFor = (rows) => async () => ({ shownActions: rows, shownCalls: [], drafts: [] });
function syncStub() {
  const seen = [];
  return { seen, fn: async (a) => { seen.push({ contactId: a.contactId, need: a.needsMatt?.kind || null }); return { applied: { to: a.needsMatt ? "Needs Matt" : "Offer Out" } }; } };
}

test("an agent's yes and a house waiting a day for its price land in Needs Matt, with the why on the card once", async () => {
  const loc = "loc-land";
  const ghl = ghlWith(STAGES);
  const sync = syncStub();
  const r = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW, deps: { pipelineFor: pipelineFor([YES, PRICE, FRESH]), syncAgentCard: sync.fn } });
  assert.equal(r.stage, true);
  assert.deepEqual(sync.seen.sort((a, b) => a.contactId.localeCompare(b.contactId)), [{ contactId: "ann", need: "yes" }, { contactId: "bo", need: "price" }]);
  assert.equal(r.noted, 2);
  const notes = ghl.calls.filter((c) => c.method === "POST" && /\/notes$/.test(c.path));
  assert.equal(notes.length, 2);
  assert.match(notes.map((c) => c.body.body).join("\n"), /approve the number/);

  // The same list again: nothing to move, nothing written twice.
  const again = syncStub();
  const r2 = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW + 900000, deps: { pipelineFor: pipelineFor([YES, PRICE, FRESH]), syncAgentCard: again.fn } });
  assert.equal(again.seen.length, 0);
  assert.equal(r2.noted, 0);
  const claims = await store.listContactEventsSince(loc, hoursAgo(48), { types: [NEEDS_MATT_EVENT], limit: 50 });
  assert.equal(claims.length, 2);
});

test("the card leaves Needs Matt once the number is approved", async () => {
  const loc = "loc-leave";
  const ghl = ghlWith(STAGES);
  await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW, deps: { pipelineFor: pipelineFor([YES]), syncAgentCard: syncStub().fn } });
  const sync = syncStub();
  const r = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW + 900000, deps: { pipelineFor: pipelineFor([]), syncAgentCard: sync.fn } });
  assert.deepEqual(sync.seen, [{ contactId: "ann", need: null }]);
  assert.deepEqual(r.left, [{ contactId: "ann" }]);
  const cur = await store.getJobCursor(loc, NEEDS_MATT_CURSOR);
  assert.deepEqual(cur.doc.needs, {});
});

test("a card GHL refused to move is tried again on the next tick", async () => {
  const loc = "loc-retry";
  const ghl = ghlWith(STAGES);
  await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW, deps: { pipelineFor: pipelineFor([YES]), syncAgentCard: async () => ({ error: "GHL PUT -> 429" }) } });
  const sync = syncStub();
  await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW + 900000, deps: { pipelineFor: pipelineFor([YES]), syncAgentCard: sync.fn } });
  assert.deepEqual(sync.seen, [{ contactId: "ann", need: "yes" }]);
});

test("without a stage named Needs Matt the list is kept and no card moves", async () => {
  const loc = "loc-nostage";
  const ghl = ghlWith(STAGES.slice(1));
  const sync = syncStub();
  const r = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW, deps: { pipelineFor: pipelineFor([YES]), syncAgentCard: sync.fn } });
  assert.equal(r.stage, false);
  assert.equal(r.needs, 1);
  assert.equal(sync.seen.length, 0);
  assert.ok((await store.getJobCursor(loc, NEEDS_MATT_CURSOR)).doc.needs.ann);
});

test("a dry run lists who would go in and writes nothing", async () => {
  const loc = "loc-dry";
  const ghl = ghlWith(STAGES);
  const sync = syncStub();
  const r = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW, dryRun: true, deps: { pipelineFor: pipelineFor([YES]), syncAgentCard: sync.fn } });
  assert.deepEqual(r.entered, [{ contactId: "ann", kind: "yes" }]);
  assert.equal(sync.seen.length, 0);
  assert.equal(await store.getJobCursor(loc, NEEDS_MATT_CURSOR), null);
});

test("the tick runs only with the GHL stages on and in the day's hours", async () => {
  const deps = { pipelineFor: pipelineFor([]), syncAgentCard: syncStub().fn };
  const ghl = ghlWith(STAGES);
  assert.equal(await maybeRunNeedsMatt({ client: ghl, locationId: "loc-tick", saved: {}, store, deps, now: NOW }), null);
  assert.equal(await maybeRunNeedsMatt({ client: ghl, locationId: "loc-tick", saved: ON, store, deps, now: Date.parse("2026-10-22T11:00:00Z") }), null);
});

// Matt, 2026-10-22: "Land, then bot passes." Three days on the stage with no
// price, and the bot passes: the house is marked we passed (went quiet), and
// the pass note tells the agent.
test("a house still unpriced three days after it landed is passed, and the agent gets the pass note", async () => {
  const loc = "loc-pass";
  const ghl = ghlWith(STAGES);
  const old = 24 + 72 + 1;
  await store.createOffer({ id: "o-dee", locationId: loc, contactId: "dee", address: "5 Pine St, Kent, WA", status: "draft", cashAmount: 0 });
  await store.createOffer({ id: "o-eve", locationId: loc, contactId: "eve", address: "6 Fir St, Kent, WA", status: "draft", cashAmount: 0 });
  await store.createOffer({ id: "o-flo", locationId: loc, contactId: "flo", address: "7 Ash St, Kent, WA", status: "draft", cashAmount: 0 });
  const row = (who, h) => ({ id: `price_it:o-${who}`, kind: "price_it", contactId: who, offerId: `o-${who}`, address: "x", readyAt: hoursAgo(h) });
  // Priced since the read: Matt got to it first, nothing is passed.
  await store.updateOffer("o-flo", { ...(await store.getOffer("o-flo")), status: "new", cashAmount: 300000 });
  const rows = [row("dee", old), row("eve", 30), row("flo", old)];
  // First sight: a week-old row has never been on the stage, so nothing goes.
  const first = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW - 73 * 3600000,
    deps: { pipelineFor: pipelineFor([row("dee", old), row("flo", old)].map((x) => ({ ...x, readyAt: new Date(Date.parse(x.readyAt) - 73 * 3600000).toISOString() }))), syncAgentCard: syncStub().fn } });
  assert.deepEqual(first.passed, [], "not passed on the day it landed");
  assert.equal((await store.getOffer("o-dee")).status, "draft");
  const r = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW,
    deps: { pipelineFor: pipelineFor(rows), syncAgentCard: syncStub().fn } });
  const dee = await store.getOffer("o-dee");
  assert.equal(dee.status, "we_passed");
  assert.equal(dee.passReason?.code, "quiet");
  assert.equal(dee.passNote?.status, "due");
  assert.equal((await store.getOffer("o-eve")).status, "draft", "landed since: still his");
  assert.equal((await store.getOffer("o-flo")).status, "new", "priced since: not passed");
  assert.deepEqual(r.passed, [{ contactId: "dee", offerId: "o-dee" }]);

  // No stage in GHL: nothing is passed either.
  const loc2 = "loc-pass-off";
  await store.createOffer({ id: "o-gil", locationId: loc2, contactId: "gil", address: "8 Elm St, Kent, WA", status: "draft", cashAmount: 0 });
  await runNeedsMatt({ store, locationId: loc2, client: ghlWith(STAGES.slice(1)), ghl: ghlWith(STAGES.slice(1)), saved: ON, now: NOW,
    deps: { pipelineFor: pipelineFor([row("gil", old)]), syncAgentCard: syncStub().fn } });
  assert.equal((await store.getOffer("o-gil")).status, "draft");
});

test("a house the agent called cosmetic is passed at once and never lands; one with no house number is left to the bot", async () => {
  const loc = "loc-screen";
  const ghl = ghlWith(STAGES);
  await store.createOffer({ id: "o-hal", locationId: loc, contactId: "hal", address: "3 Cedar St, Kent, WA 98032", status: "draft", cashAmount: 0,
    autoUnderwrite: { message: "Mostly cosmetic" } });
  await store.createOffer({ id: "o-ida", locationId: loc, contactId: "ida", address: "125th Ave SE", status: "draft", cashAmount: 0,
    autoUnderwrite: { message: "no it's selling" } });
  const row = (who) => ({ id: `price_it:o-${who}`, kind: "price_it", contactId: who, offerId: `o-${who}`, address: "x", readyAt: hoursAgo(30) });
  const sync = syncStub();
  const r = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW,
    deps: { pipelineFor: pipelineFor([row("hal"), row("ida")]), syncAgentCard: sync.fn } });
  assert.equal(sync.seen.length, 0, "neither card moves into Needs Matt");
  assert.equal(r.needs, 0);
  const hal = await store.getOffer("o-hal");
  assert.equal(hal.status, "we_passed");
  assert.equal(hal.passReason?.code, "turnkey");
  assert.equal(hal.passNote?.status, "due");
  assert.equal((await store.getOffer("o-ida")).status, "draft", "the address chase is the bot's, nothing marked");
});
