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
const { syncAgentCard, _resetWorkflowCache } = await import("./tier-check.js");

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const STAGES = [
  ["s-new", "New Lead"], ["s-t1", "Tier 1 - Hot/Actionable"], ["s-t2", "Tier 2 - Warm"], ["s-t3", "Tier 3- Cold/Keep Warm"],
  ["s-out", "Offer Out"], ["s-neg", "Negotiations"], ["s-cs", "Contract Signed"], ["s-pass", "Passed on Offer"], ["s-bad", "Not a Good Deal"], ["s-lost", "Lost"],
].map(([id, name], position) => ({ id, name, position }));

// A GHL board in memory: cards by id, tag calls, every call logged.
function ghlBoard(cards, workflows = []) {
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
      if (p.startsWith("/workflows/")) return { workflows: workflows.map((w) => ({ ...w })) };
      if (/^\/contacts\/[^/]+\/tags$/.test(p)) { tagCalls.push([method, p.split("/")[2], opts.body.tags]); return { tags: [] }; }
      return {};
    },
  };
  return { client, board, tagCalls, calls };
}

let seq = 0;
async function harness({ cards, saved = {}, workflows = [] }) {
  const LOC = `loc-tier-one-${++seq}`;
  _resetPipelineCache();
  _resetWorkflowCache();
  const ghl = ghlBoard(cards, workflows);
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

// Matt's diagram (2026-10-13): passed → back to Tier 2, the nurture — unless
// the agent has another live house, which keeps the card where that puts it.
test("with GHL following the offers, Pass sends the card to Tier 2, or wherever their other live house puts it", async () => {
  const h = await harness({ cards: [{ id: "op1", contactId: "c1", name: "Sam Lee", pipelineStageId: "s-t1" }], saved: { ghlStages: { mode: "on" } } });
  try {
    const o = await offer(h.LOC);
    const r = await h.req("POST", "/api/dashboard/tier1/c1/pass", { offerId: o.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(h.ghl.board.get("op1").pipelineStageId, "s-t2");
    const events = await store.listContactEvents(h.LOC, "c1", { limit: 50 });
    assert.ok(events.some((e) => e.type === "ghl_stage_moved" && e.data?.to === "Tier 2"));
  } finally { h.close(); }
  const h2 = await harness({ cards: [{ id: "op2", contactId: "c1", name: "Sam Lee", pipelineStageId: "s-t1" }], saved: { ghlStages: { mode: "on" } } });
  try {
    const o = await offer(h2.LOC);
    await offer(h2.LOC, { address: "88 Elm St, Tacoma, WA 98405" });
    await h2.req("POST", "/api/dashboard/tier1/c1/pass", { offerId: o.id });
    assert.equal(h2.ghl.board.get("op2").pipelineStageId, "s-out", "their other house is out");
  } finally { h2.close(); }
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

/* ---------- Tier 1 → Draft (tierOne.autoUnderwrite, ships off) ---------- */

const { maybeUnderwriteTierOne } = await import("./tier-one.js");
// Tuesday 2026-10-13, 10am Pacific.
const TEN_AM = Date.parse("2026-10-13T17:00:00Z");

async function tierOneBoard() {
  const LOC = `loc-tier-one-uw-${++seq}`;
  _resetPipelineCache();
  const ghl = ghlBoard([
    { id: "opN", contactId: "named", name: "N", pipelineStageId: "s-t1" },
    { id: "opP", contactId: "priced", name: "P", pipelineStageId: "s-t1" },
  ]);
  await recordEvent({ store, locationId: LOC, contactId: "named", party: "agent", type: "subject_property_set", at: new Date(TEN_AM - DAY).toISOString(), address: "41 Fixer Ave, Kent, WA 98031", source: "conversation" });
  await said(LOC, "named", "needs a full gut, seller wants out");
  await offer(LOC, { contactId: "priced", address: "7 Done St, Kent, WA 98031" });
  return { LOC, ghl };
}

test("a Tier 1 card with a house and no number starts its own underwrite, once an hour in the day, only when switched on", async () => {
  const { LOC, ghl } = await tierOneBoard();
  const started = [];
  const deps = { startUnderwrite: async (a) => { started.push(a); return { job: { id: "j" } }; } };
  assert.equal(await maybeUnderwriteTierOne({ client: ghl.client, locationId: LOC, saved: {}, store, deps, now: TEN_AM }), null, "off by default");
  const on = { tierOne: { autoUnderwrite: true } };
  const r = await maybeUnderwriteTierOne({ client: ghl.client, locationId: LOC, saved: on, store, deps, now: TEN_AM });
  assert.equal(r.started, 1);
  assert.deepEqual(started.map((a) => [a.contactId, a.address]), [["named", "41 Fixer Ave, Kent, WA 98031"]]);
  assert.equal(await maybeUnderwriteTierOne({ client: ghl.client, locationId: LOC, saved: on, store, deps, now: TEN_AM + 10 * 60000 }), null, "not again within the hour");
  assert.equal(await maybeUnderwriteTierOne({ client: ghl.client, locationId: LOC, saved: on, store, deps, now: Date.parse("2026-10-14T02:00:00Z") }), null, "not after 5pm");
  const cur = await store.getJobCursor(LOC, "tierOneUnderwrite");
  assert.equal(cur.doc.running, false);
  assert.equal(cur.doc.started, 1);
});

test("a run left running by a deploy is retried after half an hour", async () => {
  const { LOC, ghl } = await tierOneBoard();
  await store.setJobCursor(LOC, "tierOneUnderwrite", { at: new Date(TEN_AM - 40 * 60000).toISOString(), doc: { day: "2026-10-13", started: 0, tries: 1, running: true } });
  const started = [];
  const r = await maybeUnderwriteTierOne({ client: ghl.client, locationId: LOC, saved: { tierOne: { autoUnderwrite: true } }, store,
    deps: { startUnderwrite: async (a) => { started.push(a); return {}; } }, now: TEN_AM });
  assert.equal(r.started, 1);
  assert.equal((await store.getJobCursor(LOC, "tierOneUnderwrite")).doc.tries, 2);
});

/* ---------- the agent's GHL stage beside their name (2026-10-13) ---------- */

test("one agent's GHL stage is read for the name line: the open card, its four-stage label, or none", async () => {
  const h = await harness({ cards: [
    { id: "opA", contactId: "a1", name: "A", pipelineStageId: "s-out" },
    { id: "opB", contactId: "b1", name: "B", pipelineStageId: "s-t2", status: "lost" },
  ] });
  try {
    const a = await h.req("GET", "/api/dashboard/ghl/card?contact_id=a1");
    assert.deepEqual([a.json.stage, a.json.key, a.json.status, a.json.opportunityId], ["Offer Out", "offerOut", "open", "opA"]);
    const b = await h.req("GET", "/api/dashboard/ghl/card?contact_id=b1");
    assert.deepEqual([b.json.stage, b.json.status], ["Tier 2", "lost"]);
    assert.equal((await h.req("GET", "/api/dashboard/ghl/card?contact_id=nobody")).json.stage, null);
    assert.equal((await h.req("GET", "/api/dashboard/ghl/card")).status, 400);
    assert.deepEqual(h.ghl.calls.filter(([m]) => m !== "GET"), [], "reading moves nothing");
  } finally { h.close(); }
});

// Matt, 2026-10-29: "Right now I don't really have context as to why that was
// flagged or why it needs me."
test("a card in Needs Matt comes with the reason it's there and when it landed", async () => {
  STAGES.push({ id: "s-nm", name: "Needs Matt", position: STAGES.length });
  const h = await harness({ cards: [
    { id: "opA", contactId: "a1", name: "A", pipelineStageId: "s-nm" },
    { id: "opB", contactId: "b1", name: "B", pipelineStageId: "s-out" },
  ] });
  try {
    await store.setJobCursor(h.LOC, "needsMatt", { at: ago(0), doc: { needs: {
      a1: { kind: "price", rowKind: "price_it", why: "Price it on Lincoln St: the agent has waited 2 days for our number", at: ago(3), landedAt: ago(1), key: "k1", offerId: "o1", placed: true },
    } } });
    const a = (await h.req("GET", "/api/dashboard/ghl/card?contact_id=a1")).json;
    assert.deepEqual([a.key, a.stage], ["needsMatt", "Needs Matt"]);
    assert.equal(a.needsMatt.why, "Price it on Lincoln St: the agent has waited 2 days for our number");
    assert.equal(a.needsMatt.kind, "price");
    assert.ok(Date.parse(a.needsMatt.landedAt), "when it landed");
    assert.equal(Date.parse(a.needsMatt.passAt) - Date.parse(a.needsMatt.landedAt), 72 * 3600000, "an unpriced house is passed three days after it landed");
    assert.equal((await h.req("GET", "/api/dashboard/ghl/card?contact_id=b1")).json.needsMatt, null, "nothing open for them");
  } finally { STAGES.pop(); h.close(); }
});

/* ---------- Matt sets the stage from the companion window (2026-10-17) ---------- */

const setStage = (h, contact_id, to) => h.req("POST", "/api/dashboard/ghl/card", { contact_id, to });

test("a stage picked in the companion moves their GHL card there, and the record says Matt did it", async () => {
  const h = await harness({ cards: [{ id: "opA", contactId: "a1", name: "A", pipelineStageId: "s-t2" }] });
  try {
    const r = await setStage(h, "a1", "tier1");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.to, r.json.key, r.json.opportunityId], ["Tier 1", "tier1", "opA"]);
    assert.equal(h.ghl.board.get("opA").pipelineStageId, "s-t1");
    assert.deepEqual((await h.req("GET", "/api/dashboard/ghl/card?contact_id=a1")).json.key, "tier1");
    const evs = await store.listContactEvents(h.LOC, "a1", { types: ["ghl_stage_set", "ghl_stage_moved"] });
    assert.deepEqual(evs.map((e) => [e.type, e.source, e.data.to]), [["ghl_stage_set", "companion", "Tier 1"]], "his move, not the app's");
    assert.equal((await setStage(h, "a1", "tier1")).json.skip, "Already in Tier 1.");
  } finally { h.close(); }
});

test("the offers don't move a card back that Matt set in the companion, until something new happens on an offer", async () => {
  const saved = { ghlStages: { mode: "on" } };
  const h = await harness({ saved, cards: [{ id: "opS", contactId: "c1", name: "Sam Lee", pipelineStageId: "s-out" }] });
  try {
    await offer(h.LOC, { sends: [{ ts: ago(2), results: { sms: { ok: true } } }] });   // Sent: the offers want Offer Out
    // His pick has to be newer than the offer: in the same millisecond it
    // isn't, and the test failed whenever the run was fast enough.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await setStage(h, "c1", "tier1")).status, 200);
    const r = await syncAgentCard({ client: h.ghl.client, locationId: h.LOC, contactId: "c1", store, saved });
    assert.ok(r.youMoved, JSON.stringify(r));
    assert.equal(h.ghl.board.get("opS").pipelineStageId, "s-t1", "still where he put it");
  } finally { h.close(); }
});

test("with no open card, a stage picked reopens their closed card or makes one; a won card stays won", async () => {
  const h = await harness({ cards: [
    { id: "opL", contactId: "l1", name: "L", pipelineStageId: "s-out", status: "lost" },
    { id: "opW", contactId: "w1", name: "W", pipelineStageId: "s-cs", status: "won" },
  ] });
  try {
    await offer(h.LOC, { contactId: "w1", contactName: "Wes Ng" });
    assert.equal((await setStage(h, "l1", "tier1")).status, 200);
    assert.deepEqual([h.ghl.board.get("opL").pipelineStageId, h.ghl.board.get("opL").status], ["s-t1", "open"]);
    const made = await setStage(h, "w1", "tier2");
    assert.equal(made.json.created, true);
    assert.equal(h.ghl.board.get("opW").status, "won");
    const card = h.ghl.board.get(made.json.opportunityId);
    assert.deepEqual([card.pipelineStageId, card.contactId, card.name, card.pipelineId], ["s-t2", "w1", "Wes Ng", "acq"]);
  } finally { h.close(); }
});

test("a stage pick is refused with two open cards, an unknown stage, or a Tier 2 move that would start a texting nurture", async () => {
  const h = await harness({
    cards: [
      { id: "op1", contactId: "two", name: "T", pipelineStageId: "s-t2" }, { id: "op2", contactId: "two", name: "T", pipelineStageId: "s-out" },
      { id: "opN", contactId: "n1", name: "N", pipelineStageId: "s-t1" },
    ],
    workflows: [{ id: "wf1", name: "Tier 2+3 nurture", status: "published" }],
  });
  try {
    const two = await setStage(h, "two", "tier1");
    assert.equal(two.status, 409);
    assert.match(two.json.error, /two open cards/);
    assert.equal((await setStage(h, "n1", "won")).status, 400);
    assert.equal((await setStage(h, "", "tier1")).status, 400);
    const nurture = await setStage(h, "n1", "tier2");
    assert.equal(nurture.status, 409);
    assert.match(nurture.json.error, /Tier 2\+3 nurture is published/);
    assert.deepEqual(h.ghl.calls.filter(([m]) => m === "PUT" || m === "POST"), [], "nothing moved");
    assert.equal((await setStage(h, "n1", "offerOut")).status, 200, "other stages still move");
  } finally { h.close(); }
});
