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

// Matt, 2026-11-10: the clock passed houses the engine had already priced. A house with an engine
// number of any grade stays on Needs Matt with that number on the card; only an unpriced one passes.
test("a house the engine priced stays on Needs Matt with its number and is never passed by the clock", async () => {
  const { houseKey } = await import("./shared/current-offer.js");
  const loc = "loc-engine-priced";
  const ghl = ghlWith(STAGES);
  const old = 24 + 72 + 1;
  await store.createOffer({ id: "o-hal", locationId: loc, contactId: "hal", address: "15 Cedar St, Kent, WA", status: "draft", cashAmount: 0,
    draft: { engine: { grade: "B", open: 238000, walkAway: 253000, gradeB: { mode: "shadow", open: 214250, wouldSend: true } } } });
  await store.createOffer({ id: "o-ida", locationId: loc, contactId: "ida", address: "16 Spruce St, Kent, WA", status: "draft", cashAmount: 0 });
  await store.upsertHousePricing(loc, houseKey("16 Spruce St, Kent, WA"), { address: "16 Spruce St, Kent, WA", v2: { grade: "C", open: 0, walkAway: 181000, at: hoursAgo(old) } });
  await store.createOffer({ id: "o-jo", locationId: loc, contactId: "jo", address: "17 Hemlock St, Kent, WA", status: "draft", cashAmount: 0 });
  const row = (who, h) => ({ id: `price_it:o-${who}`, kind: "price_it", contactId: who, offerId: `o-${who}`, address: { hal: "15 Cedar St, Kent, WA", ida: "16 Spruce St, Kent, WA", jo: "17 Hemlock St, Kent, WA" }[who], readyAt: hoursAgo(h) });
  const rows = ["hal", "ida", "jo"].map((w) => row(w, old));
  await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW - 73 * 3600000,
    deps: { pipelineFor: pipelineFor(rows.map((x) => ({ ...x, readyAt: new Date(Date.parse(x.readyAt) - 73 * 3600000).toISOString() }))), syncAgentCard: syncStub().fn } });
  const r = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW, deps: { pipelineFor: pipelineFor(rows), syncAgentCard: syncStub().fn } });
  assert.deepEqual(r.passed, [{ contactId: "jo", offerId: "o-jo" }], "only the house with no engine number");
  assert.equal((await store.getOffer("o-hal")).status, "draft");
  assert.equal((await store.getOffer("o-ida")).status, "draft", "the house's record counts too, any grade");
  assert.equal((await store.getOffer("o-jo")).status, "we_passed");
  const needs = (await store.getJobCursor(loc, NEEDS_MATT_CURSOR)).doc.needs;
  assert.deepEqual(needs.hal.engine, { grade: "B", open: 238000, walkAway: 253000 });
  assert.equal(needs.hal.why, "Price it on 15 Cedar St: the engine has 238K (grade B) on the draft; the agent has waited 4 days");
  assert.equal(needs.ida.engine.walkAway, 181000);
  assert.equal(needs.jo.engine, undefined);
});

test("the pass clock skips the weekend and his days off", async () => {
  const loc = "loc-weekend";
  const ghl = ghlWith(STAGES);
  await store.createOffer({ id: "o-kit", locationId: loc, contactId: "kit", address: "18 Laurel St, Kent, WA", status: "draft", cashAmount: 0 });
  const FRI = Date.parse("2026-10-16T17:00:00Z"); // Friday 10am Pacific
  const rows = [{ id: "price_it:o-kit", kind: "price_it", contactId: "kit", offerId: "o-kit", address: "18 Laurel St, Kent, WA", readyAt: new Date(FRI - 30 * 3600000).toISOString() }];
  const go = (now, saved = ON) => runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved, now, deps: { pipelineFor: pipelineFor(rows), syncAgentCard: syncStub().fn } });
  await go(FRI);
  const mon = await go(Date.parse("2026-10-19T18:00:00Z")); // Monday 11am: 73 clock hours, 25 working
  assert.deepEqual(mon.passDue, []);
  assert.equal((await store.getOffer("o-kit")).status, "draft", "the weekend didn't count");
  const off = { ...ON, conversationAi: { autoSend: { offDays: ["2026-10-20"] } } };
  const wedOff = await go(Date.parse("2026-10-21T17:30:00Z"), off); // Wednesday 10:30am, Tuesday off
  assert.deepEqual(wedOff.passDue, [], "a day off doesn't count either");
  const wed = await go(Date.parse("2026-10-21T17:30:00Z")); // Wednesday 10:30am: three working days
  assert.deepEqual(wed.passed, [{ contactId: "kit", offerId: "o-kit" }]);
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

// Matt, 2026-11-09 (Ed K., 624 NW Hill St): we told him we couldn't make it work,
// he named a lower number the seller might take, and the card went to Needs Matt as a
// house to price. We'd already passed on it.
test("their number on a house we passed on keeps the card out of Needs Matt", async () => {
  const loc = "loc-walked";
  const ghl = ghlWith(STAGES);
  const noOffer = { ok: false, name: "offer_live", detail: "no open offer" };
  const counter = (who) => ({ id: `d-${who}`, contactId: who, party: "agent", status: "draft", intent: "counter", counterAmount: 595000,
    propertyAddress: `1 ${who} St, Bend, OR`, createdAt: hoursAgo(30), exception: { kind: "counter_band", passed: false, checks: [noOffer] } });
  await store.createOffer({ id: "o-ek", locationId: loc, contactId: "ek", address: "1 ek St, Bend, OR", status: "we_passed", cashAmount: null });
  await store.createOffer({ id: "o-fo", locationId: loc, contactId: "fo", address: "1 fo St, Bend, OR", status: "passed", cashAmount: null });
  const drafts = [counter("ek"), counter("fo")];
  const rows = drafts.map((d) => ({ id: `draft_waiting:o-${d.contactId}`, kind: "draft_waiting", draftId: d.id, contactId: d.contactId, offerId: `o-${d.contactId}` }));
  const sync = syncStub();
  const r = await runNeedsMatt({ store, locationId: loc, client: ghl, ghl, saved: ON, now: NOW,
    deps: { pipelineFor: async () => ({ shownActions: rows, shownCalls: [], drafts }), syncAgentCard: sync.fn } });
  assert.deepEqual(sync.seen, [{ contactId: "fo", need: "price" }], "they passed and came back with a number: his to price");
  assert.equal(r.needs, 1);
  assert.equal((await store.getOffer("o-ek")).status, "we_passed", "our pass stands");
});
