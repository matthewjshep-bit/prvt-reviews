// tier-one-route.test.mjs — the Tier 1 list (Matt, 2026-10-07): GHL's Tier 1
// stage read into the app, screened, and worked with Pass / Kick out / Add,
// which move the GHL card so the two lists never drift.
//
// JSON file backend in a throwaway temp directory; GHL is a stub board.
//
//   node --test tier-one-route.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tier-one-route-test-"));
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { default: createDashboardRouter } = await import("./routes/dashboard.js");
const { _resetPipelineCache } = await import("./ghl-mirror.js");

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const STAGES = [
  ["s-new", "New Lead"], ["s-t1", "Tier 1 - Hot/Actionable"], ["s-t2", "Tier 2 - Warm"], ["s-t3", "Tier 3- Cold/Keep Warm"],
  ["s-out", "Offer Out"], ["s-neg", "Negotiations"], ["s-cs", "Contract Signed"], ["s-pass", "Passed on Offer"], ["s-bad", "Not a Good Deal"], ["s-lost", "Lost"],
].map(([id, name], position) => ({ id, name, position }));

// A GHL board in memory: cards by id, tag calls, every call logged.
function ghlBoard(cards) {
  const board = new Map(cards.map((c) => [c.id, { pipelineId: "acq", status: "open", ...c }]));
  const tagCalls = [];
  const calls = [];
  const client = {
    call: async (p, opts = {}) => {
      const method = opts.method || "GET";
      calls.push([method, p]);
      if (p.startsWith("/opportunities/pipelines")) return { pipelines: [{ id: "acq", name: "Acquisitions", stages: STAGES }, { id: "dispo", name: "Dispositions", stages: [] }] };
      if (p.startsWith("/opportunities/search")) {
        const q = new URLSearchParams(p.split("?")[1]);
        const contact = q.get("contact_id");
        const rows = [...board.values()].filter((c) => !contact || c.contactId === contact);
        return { opportunities: rows.map((c) => ({ ...c })), meta: {} };
      }
      const m = p.match(/^\/opportunities\/([^/?]+)$/);
      if (m && method === "PUT") { Object.assign(board.get(m[1]), opts.body.pipelineStageId ? { pipelineStageId: opts.body.pipelineStageId } : {}, opts.body.status ? { status: opts.body.status } : {}); return {}; }
      if (m && method === "GET") return { opportunity: board.get(m[1]) };
      if (p === "/opportunities/" && method === "POST") { const id = `op-new-${board.size}`; board.set(id, { id, ...opts.body }); return { opportunity: { id } }; }
      if (/^\/contacts\/[^/]+\/tags$/.test(p)) { tagCalls.push([method, p.split("/")[2], opts.body.tags]); return { tags: [] }; }
      return {};
    },
  };
  return { client, board, tagCalls, calls };
}

let seq = 0;
async function harness({ cards, saved = {} }) {
  const LOC = `loc-tier-one-${++seq}`;
  _resetPipelineCache();
  const ghl = ghlBoard(cards);
  const statusCalls = [];
  const operatorStatus = async ({ offer, status, note }) => {
    statusCalls.push({ offerId: offer.id, status, note });
    await store.updateOffer(offer.id, { ...offer, status, statusAt: new Date().toISOString() });
    return [];
  };
  if (Object.keys(saved).length) await store.saveOfferSettings(LOC, saved);
  const app = express();
  app.use(express.json());
  app.use("/api/dashboard", createDashboardRouter({ resolveLocation: () => ({ locationId: LOC, client: ghl.client }), operatorStatus }));
  const server = app.listen(0);
  const B = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, p, body) => {
    const r = await fetch(B + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { LOC, ghl, statusCalls, req, close: () => server.close() };
}

const offer = (LOC, over = {}) => store.createOffer({ locationId: LOC, contactId: "c1", contactName: "Sam Lee", address: "13814 214th St E, Graham, WA 98338",
  cashAmount: 300000, status: "sent", sends: [{ ts: ago(2), results: { sms: { ok: true } } }], calc: { inputs: { arv: 520000, repairs: 90000, askingPrice: 450000 } }, ...over });
const said = (LOC, contactId, text, at = ago(1)) => recordEvent({ store, locationId: LOC, contactId, party: "agent", type: "text_summary", at, source: "conversation", data: { inbound: text } });

await store.init();

test("Tier 1 lists only GHL's Tier 1 cards, with the house, our numbers and flags", async () => {
  const h = await harness({ cards: [
    { id: "op1", contactId: "c1", name: "Sam Lee", pipelineStageId: "s-t1", lastStageChangeAt: ago(3) },
    { id: "op2", contactId: "c2", name: "Pat Doe", pipelineStageId: "s-t1", lastStageChangeAt: ago(9) },
    { id: "op3", contactId: "c3", name: "Kim Roe", pipelineStageId: "s-t2" },
  ] });
  try {
    await offer(h.LOC);
    await said(h.LOC, "c1", "It needs a full kitchen and a roof, seller is motivated");
    await offer(h.LOC, { contactId: "c2", contactName: "Pat Doe", address: "88 Elm St, Tacoma, WA 98405", priceWatch: { status: "PENDING" } });
    await said(h.LOC, "c2", "anything else?");
    const r = await h.req("GET", "/api/dashboard/tier1");
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
    assert.deepEqual(r.json.rows.map((x) => x.contactId).sort(), ["c1", "c2"], "Tier 2's card is not on it");
    const sam = r.json.rows.find((x) => x.contactId === "c1");
    assert.equal(sam.ok, true);
    assert.equal(sam.house.address, "13814 214th St E, Graham, WA 98338");
    assert.equal(sam.offer.cashAmount, 300000);
    assert.equal(sam.offer.arv, 520000);
    assert.equal(sam.opportunityId, "op1");
    const pat = r.json.rows.find((x) => x.contactId === "c2");
    assert.equal(pat.ok, false);
    assert.deepEqual(pat.flags.map((f) => f.key), ["gone"]);
    assert.equal(r.json.rows[0].contactId, "c2", "flagged cards first");
    assert.deepEqual(h.ghl.calls.filter(([m]) => m !== "GET"), [], "reading moves nothing");
  } finally { h.close(); }
});

test("a clean Tier 1 agent with no card at Tier 1 or later is listed as belonging", async () => {
  const h = await harness({ cards: [{ id: "op9", contactId: "c9", name: "Lee Ray", pipelineStageId: "s-t3" }] });
  try {
    await offer(h.LOC, { contactId: "c9", contactName: "Lee Ray", status: "new", sends: [] });
    await said(h.LOC, "c9", "needs everything, call me");
    const r = await h.req("GET", "/api/dashboard/tier1?fresh=1");
    assert.deepEqual(r.json.belongs.map((x) => x.contactId), ["c9"]);
  } finally { h.close(); }
});

test("Pass marks we passed, moves the card to Passed on Offer, takes tier-1 off and never adds tier-2", async () => {
  const h = await harness({ cards: [{ id: "op1", contactId: "c1", name: "Sam Lee", pipelineStageId: "s-t1" }] });
  try {
    const o = await offer(h.LOC);
    const r = await h.req("POST", "/api/dashboard/tier1/c1/pass", { offerId: o.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(h.statusCalls.map((c) => c.status), ["we_passed"]);
    assert.equal(h.ghl.board.get("op1").pipelineStageId, "s-pass");
    assert.equal(r.json.card.verified, true, "read back by id");
    assert.deepEqual(h.ghl.tagCalls, [["DELETE", "c1", ["tier-1"]]]);
    assert.equal(h.ghl.tagCalls.some(([m, , tags]) => m === "POST" || (tags || []).includes("tier-2")), false);
    const events = await store.listContactEvents(h.LOC, "c1", { limit: 50 });
    assert.ok(events.some((e) => e.type === "tier1_passed" && e.offerId === o.id));
    assert.ok(events.some((e) => e.type === "ghl_stage_moved" && e.data?.to === "Passed on Offer"));
  } finally { h.close(); }
});

test("a pass on a house never priced is recorded, so the check-in and the bot leave it alone", async () => {
  const h = await harness({ cards: [{ id: "op4", contactId: "c4", name: "Ana Bee", pipelineStageId: "s-t1" }] });
  try {
    await recordEvent({ store, locationId: h.LOC, contactId: "c4", party: "agent", type: "subject_property_set", at: ago(1), address: "4430 Sunnyside Blvd, Marysville, WA 98270", source: "conversation" });
    const r = await h.req("POST", "/api/dashboard/tier1/c4/pass", {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.offerId, null);
    assert.deepEqual(h.statusCalls, [], "no offer to mark");
    const events = await store.listContactEvents(h.LOC, "c4", { limit: 50 });
    assert.equal(events.find((e) => e.type === "tier1_passed")?.address, "4430 Sunnyside Blvd, Marysville, WA 98270");
    assert.equal(h.ghl.board.get("op4").pipelineStageId, "s-pass");
  } finally { h.close(); }
});

test("Kick out on a house that's gone marks it no longer available and the card Not a Good Deal", async () => {
  const h = await harness({ cards: [{ id: "op2", contactId: "c2", name: "Pat Doe", pipelineStageId: "s-t1" }] });
  try {
    const o = await offer(h.LOC, { contactId: "c2", contactName: "Pat Doe", address: "88 Elm St, Tacoma, WA 98405" });
    const r = await h.req("POST", "/api/dashboard/tier1/c2/kick", { offerId: o.id, reason: "gone", flags: ["gone"] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(h.statusCalls.map((c) => c.status), ["unavailable"]);
    assert.equal(h.ghl.board.get("op2").pipelineStageId, "s-bad");
  } finally { h.close(); }
});

test("Add puts the agent's card on Tier 1, or makes one", async () => {
  const h = await harness({ cards: [{ id: "op9", contactId: "c9", name: "Lee Ray", pipelineStageId: "s-t3" }] });
  try {
    const r = await h.req("POST", "/api/dashboard/tier1/c9/add", { address: "1 Main St, Kent, WA 98031" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(h.ghl.board.get("op9").pipelineStageId, "s-t1");
    const made = await h.req("POST", "/api/dashboard/tier1/c10/add", { name: "New Agent" });
    assert.equal(made.json.card.created, true);
  } finally { h.close(); }
});

test("nothing moves while the GHL mirror owns the board", async () => {
  const h = await harness({ cards: [{ id: "op1", contactId: "c1", name: "Sam Lee", pipelineStageId: "s-t1" }], saved: { ghlMirror: { enabled: true } } });
  try {
    assert.equal((await store.getOfferSettings(h.LOC))?.ghlMirror?.enabled, true);
    const o = await offer(h.LOC);
    const r = await h.req("POST", "/api/dashboard/tier1/c1/pass", { offerId: o.id });
    assert.equal(r.status, 409);
    assert.equal(h.ghl.board.get("op1").pipelineStageId, "s-t1");
    assert.deepEqual(h.statusCalls, []);
  } finally { h.close(); }
});

test("a deal's card is never passed from Tier 1", async () => {
  const h = await harness({ cards: [{ id: "op1", contactId: "c1", name: "Sam Lee", pipelineStageId: "s-t1" }] });
  try {
    const o = await offer(h.LOC, { status: "accepted", deal: { stage: "under_contract" } });
    const r = await h.req("POST", "/api/dashboard/tier1/c1/pass", { offerId: o.id });
    assert.equal(r.status, 409);
    assert.equal(h.ghl.board.get("op1").pipelineStageId, "s-t1");
  } finally { h.close(); }
});

test("no name or message text in the logs", async () => {
  const h = await harness({ cards: [{ id: "op1", contactId: "c1", name: "Sam Lee", pipelineStageId: "s-t1" }] });
  const lines = [];
  const log = console.log, err = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const o = await offer(h.LOC);
    await said(h.LOC, "c1", "secret seller story about the divorce");
    await h.req("GET", "/api/dashboard/tier1?fresh=1");
    await h.req("POST", "/api/dashboard/tier1/c1/pass", { offerId: o.id });
  } finally { console.log = log; console.error = err; h.close(); }
  const all = lines.join("\n");
  assert.ok(lines.some((l) => /tier-one:/.test(l)), "it does log");
  assert.doesNotMatch(all, /Sam Lee|divorce|214th/);
});

/* ---------- the morning clear-out (tierOne.autoKick, ships off) ---------- */

const { runTierOneScreen } = await import("./tier-one.js");

async function morning({ autoKick, autoKickMax }) {
  const LOC = `loc-tier-one-am-${++seq}`;
  _resetPipelineCache();
  const ghl = ghlBoard([
    { id: "opA", contactId: "a1", name: "A", pipelineStageId: "s-t1" },
    { id: "opB", contactId: "b1", name: "B", pipelineStageId: "s-t1" },
    { id: "opC", contactId: "c1", name: "C", pipelineStageId: "s-t1" },
    { id: "opD", contactId: "d1", name: "D", pipelineStageId: "s-t1" },
  ]);
  const pending = (contactId, address) => offer(LOC, { contactId, address, priceWatch: { status: "PENDING" } });
  await pending("a1", "1 Gone St, Kent, WA 98031");
  await pending("b1", "2 Gone St, Kent, WA 98031");
  await pending("c1", "3 Gone St, Kent, WA 98031");
  await recordEvent({ store, locationId: LOC, contactId: "c1", party: "agent", type: "tier1_added", at: ago(2), address: "3 Gone St, Kent, WA 98031", source: "tier_one" });
  await offer(LOC, { contactId: "d1", address: "4 Live St, Kent, WA 98031" });
  await said(LOC, "d1", "needs a full gut");
  const statusCalls = [];
  const operatorStatus = async ({ offer: o, status }) => { statusCalls.push([o.contactId, status]); await store.updateOffer(o.id, { ...o, status }); return []; };
  const saved = { tierOne: { autoKick, autoKickMax } };
  const r = await runTierOneScreen({ client: ghl.client, locationId: LOC, saved, store, deps: { operatorStatus } });
  return { r, ghl, statusCalls, LOC };
}

test("with the switch off the morning run only reports", async () => {
  const { r, ghl, statusCalls } = await morning({ autoKick: false });
  assert.equal(r.on, false);
  assert.equal(r.planned, 2, "the two gone houses; not the one added this week, not the live one");
  assert.equal(r.applied, 0);
  assert.deepEqual(statusCalls, []);
  assert.deepEqual(ghl.calls.filter(([m]) => m !== "GET"), []);
  assert.deepEqual(r.kicks.map((k) => k.reason), ["gone", "gone"]);
  assert.doesNotMatch(JSON.stringify(r), /Gone St|"A"|"B"/, "ids and reasons only");
});

test("with it on it clears at most autoKickMax, marked as the machine's, and never a card you added this week", async () => {
  const { r, ghl, statusCalls, LOC } = await morning({ autoKick: true, autoKickMax: 1 });
  assert.equal(r.planned, 2);
  assert.equal(r.applied, 1);
  assert.deepEqual(statusCalls.map(([, s]) => s), ["unavailable"]);
  assert.equal([...ghl.board.values()].filter((c) => c.pipelineStageId === "s-bad").length, 1);
  assert.equal(ghl.board.get("opC").pipelineStageId, "s-t1", "added by hand this week");
  assert.equal(ghl.board.get("opD").pipelineStageId, "s-t1", "a live house stays");
  const kicked = r.kicks.find((k) => k.applied);
  const events = await store.listContactEvents(LOC, kicked.contactId, { limit: 50 });
  assert.equal(events.find((e) => e.type === "tier1_kicked")?.data?.by, "machine");
});
