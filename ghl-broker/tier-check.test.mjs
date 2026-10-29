import test from "node:test";
import assert from "node:assert/strict";
import { planTierFixes, runTierCheck, maybeRunTierCheck } from "./tier-check.js";

const PIPES = [
  { id: "pA", name: "Acquisitions", stages: [
    { id: "new", name: "New Lead" }, { id: "t1", name: "Tier 1 - Hot/Actionable, Active Deal" },
    { id: "t2", name: "Tier 2 - Warm, No Active Deal" }, { id: "t3", name: "Tier 3- Cold/Keep Warm" },
    { id: "out", name: "Offer Out" }, { id: "passed", name: "Passed on Offer" },
  ] },
  { id: "pD", name: "Dispositions", stages: [{ id: "d1", name: "Tier 1 - Interested" }, { id: "d2", name: "Tier 2 - Working" }, { id: "d3", name: "Tier 3 x" }] },
];
const opp = (contactId, stage, tags, over = {}) => ({
  id: `op-${contactId}`, contactId, pipelineId: "pA", pipelineStageId: stage, status: "open",
  lastStageChangeAt: "2026-09-15T10:00:00Z", contact: { id: contactId, name: contactId, tags }, ...over,
});

test("a tier card sets the tags; stacked and missing tags are fixed", () => {
  const fixes = planTierFixes({ pipelines: PIPES, opportunities: [
    opp("jahine", "t3", ["agent", "tier-1", "tier-3"]),
    opp("slavic", "t2", ["agent", "tier-1"]),
    opp("ok", "t1", ["agent", "tier-1"]),
  ] });
  const by = Object.fromEntries(fixes.map((f) => [f.contactId, f]));
  assert.deepEqual([by.jahine.add, by.jahine.remove, by.jahine.moveTo], [[], ["tier-1"], null]);
  assert.deepEqual([by.slavic.add, by.slavic.remove], [["tier-2"], ["tier-1"]]);
  assert.equal(by.ok, undefined);
});

test("a card at Offer Out keeps tier-1 alone; early, passed, closed and non-agent cards are left be", () => {
  const fixes = planTierFixes({ pipelines: PIPES, opportunities: [
    opp("brenda", "out", ["agent", "tier-3", "tier-1"]),
    opp("gabe", "out", ["agent"]),
    opp("lead", "new", ["agent", "tier-2"]),
    opp("passed", "passed", ["agent", "tier-1"]),
    opp("lost", "t1", ["agent", "tier-3"], { status: "lost" }),
    opp("seller", "t3", ["seller-lead"]),
    opp("dispo", "d1", ["agent", "tier-3"], { pipelineId: "pD" }),
  ] });
  const by = Object.fromEntries(fixes.map((f) => [f.contactId, f]));
  assert.deepEqual([by.brenda.add, by.brenda.remove], [[], ["tier-3"]]);
  assert.deepEqual(by.gabe.add, ["tier-1"]);
  assert.deepEqual(Object.keys(by).sort(), ["brenda", "gabe"]);
});

test("a tag the bot added after the card last moved moves the card instead; an older one doesn't", () => {
  const lori = opp("lori", "t3", ["agent", "tier-1", "tier-3"]);
  const newer = planTierFixes({ pipelines: PIPES, opportunities: [lori],
    tagEvents: [{ contactId: "lori", at: "2026-09-15T11:00:00Z", data: { tag: "tier-1" } }] });
  assert.deepEqual([newer[0].moveTo, newer[0].remove, newer[0].add], ["t1", ["tier-3"], []]);
  const older = planTierFixes({ pipelines: PIPES, opportunities: [lori],
    tagEvents: [{ contactId: "lori", at: "2026-09-15T09:00:00Z", data: { tag: "tier-1" } }] });
  assert.deepEqual([older[0].moveTo, older[0].remove], [null, ["tier-1"]]);
});

test("a contact whose open cards disagree is left for a person", () => {
  const fixes = planTierFixes({ pipelines: PIPES, opportunities: [
    opp("two", "t1", ["agent", "tier-3"], { id: "a" }), opp("two", "t3", ["agent", "tier-3"], { id: "b" }),
  ] });
  assert.deepEqual(fixes, []);
});

const fakeStore = () => ({
  events: [], cursors: new Map(),
  async listContactEventsSince() { return []; },
  async appendContactEvents(_l, contactId, rows) { this.events.push(...rows.map((r) => ({ contactId, ...r }))); return { inserted: rows.length }; },
  async getContactProfile() { return null; }, async upsertContactProfile() { return true; },
  async getJobCursor(l, k) { return this.cursors.get(`${l}|${k}`) || null; },
  async setJobCursor(l, k, v) { this.cursors.set(`${l}|${k}`, v); },
});
const fakeApi = (rows) => {
  const calls = [];
  return { calls, api: {
    listPipelines: async () => PIPES,
    listAcquisitionOpportunities: async () => rows,
    addContactTags: async (_c, id, tags) => { calls.push(["add", id, tags]); },
    removeContactTags: async (_c, id, tags) => { calls.push(["remove", id, tags]); },
    updateOpportunity: async (_c, id, body) => { calls.push(["update", id, body]); },
  } };
};

test("the run applies the fixes, records them, stops at the limit, and a dry run writes nothing", async () => {
  const rows = [opp("a", "t3", ["agent", "tier-1"]), opp("b", "t2", ["agent", "tier-1"]), opp("c", "out", ["agent", "tier-2", "tier-1"])];
  const dry = fakeApi(rows);
  const d = await runTierCheck({ client: {}, locationId: "L", store: fakeStore(), ghl: dry.api, dryRun: true });
  assert.equal(d.planned, 3);
  assert.equal(dry.calls.length, 0);

  const live = fakeApi(rows);
  const store = fakeStore();
  const r = await runTierCheck({ client: {}, locationId: "L", store, ghl: live.api, limit: 2 });
  assert.equal(r.applied, 2);
  assert.deepEqual(live.calls.filter(([k]) => k === "remove").map(([, id, t]) => [id, t]), [["a", ["tier-1"]], ["b", ["tier-1"]]]);
  assert.ok(store.events.some((e) => e.contactId === "a" && e.type === "tag_added" && e.data.tag === "tier-3" && e.source === "tier_check"));
});

test("once a day, from 7am PT", async () => {
  const store = fakeStore();
  const { api } = fakeApi([opp("a", "t3", ["agent", "tier-1"])]);
  const six = Date.parse("2026-09-15T13:30:00Z");   // 6:30am PT
  assert.equal(await maybeRunTierCheck({ client: {}, locationId: "L", store, ghl: api, now: six }), null);
  const eight = Date.parse("2026-09-15T15:00:00Z"); // 8am PT
  const r = await maybeRunTierCheck({ client: {}, locationId: "L", store, ghl: api, now: eight });
  assert.equal(r.applied, 1);
  assert.equal((await store.getJobCursor("L", "tierCheck")).doc.last.applied, 1, "the summary is the day's `last`, like every daily job");
  assert.equal(await maybeRunTierCheck({ client: {}, locationId: "L", store, ghl: api, now: eight + 3600000 }), null);
});

/* ---------- GHL stages follow the app (2026-10-02) ---------- */

const { runStagePlan } = await import("./tier-check.js");
const stageStore = (offers = []) => ({ events: [], async listOffers() { return offers; }, async listContactEventsSince() { return []; }, async lastContactActivity() { return []; },
  async appendContactEvents(l, id, rows) { this.events.push(...rows.map((r) => ({ ...r, contactId: id }))); return { inserted: rows.length }; },
  async getContactProfile() { return null; }, async upsertContactProfile() { return {}; } });
const stageGhl = (moved) => ({ listPipelines: async () => PIPES, listWorkflows: async () => [{ id: "nw", name: "Tier 2+3 nurture", status: "draft" }],
  listAcquisitionOpportunities: async () => [opp("sent1", "t1", ["agent", "tier-1"])], updateOpportunity: async (c, id, body) => { moved.push({ id, ...body }); } });

test("while off, a card the app says should move is reported and nothing moves", async () => {
  const moved = [];
  const store = stageStore([{ id: "o1", contactId: "sent1", address: "1 St", cashAmount: 1, status: "sent", sends: [{ ts: "2026-10-01T00:00:00Z" }], createdAt: "2026-09-30T00:00:00Z" }]);
  const r = await runStagePlan({ client: {}, locationId: "L", store, ghl: stageGhl(moved), saved: {}, dryRun: false, now: Date.parse("2026-10-02T20:00:00Z") });
  assert.equal(r.mode, "off");
  assert.equal(r.planned, 1);
  assert.deepEqual(r.moves.map((m) => [m.contactId, m.to]), [["sent1", "Offer Out"]]);
  assert.equal(moved.length, 0, "off means a report only");
  assert.equal(JSON.stringify(r).includes("tier-1"), false, "ids and stage names, no tags or names");
});

test("switched on, it moves the card and puts the move on their record; a dry run still moves nothing", async () => {
  const moved = [];
  const store = stageStore([{ id: "o1", contactId: "sent1", address: "1 St", cashAmount: 1, status: "sent", sends: [{ ts: "2026-10-01T00:00:00Z" }], createdAt: "2026-09-30T00:00:00Z" }]);
  const now = Date.parse("2026-10-02T20:00:00Z");
  await runStagePlan({ client: {}, locationId: "L", store, ghl: stageGhl(moved), saved: { ghlStages: { mode: "on" } }, dryRun: true, now });
  assert.equal(moved.length, 0);
  const r = await runStagePlan({ client: {}, locationId: "L", store, ghl: stageGhl(moved), saved: { ghlStages: { mode: "on" } }, dryRun: false, now });
  assert.equal(r.applied, 1);
  assert.deepEqual(moved, [{ id: "op-sent1", stageId: "out" }]);
  assert.equal(store.events[0].type, "ghl_stage_moved");
});

/* ---------- the card follows the offers (Matt's diagram, 2026-10-13) ---------- */

const { syncAgentCard, syncChangedCards, _resetWorkflowCache } = await import("./tier-check.js");
const FOUR = [{ id: "pA", name: "Acquisitions", stages: [
  { id: "t1", name: "Tier 1" }, { id: "t2", name: "Tier 2" }, { id: "out", name: "Offer Out" }, { id: "cs", name: "Contract Signed" },
] }];
const cardGhl = ({ cards = [], workflows = [], moved = [], made = [], fail = false } = {}) => ({
  listPipelines: async () => FOUR,
  listWorkflows: async () => workflows,
  searchOpportunities: async () => { if (fail) throw new Error("GHL 502"); return cards; },
  updateOpportunity: async (_c, id, body) => { moved.push({ id, ...body }); },
  createOpportunity: async (_c, body) => { made.push(body); return { id: "new-card" }; },
});
const cardStore = (offers = [], saved = { ghlStages: { mode: "on" } }) => ({
  events: [], cursors: new Map(),
  async getOfferSettings() { return saved; },
  async listOffers(_l, { contactId } = {}) { return offers.filter((o) => !contactId || o.contactId === contactId); },
  async appendContactEvents(_l, contactId, rows) { this.events.push(...rows.map((r) => ({ contactId, ...r }))); return { inserted: rows.length }; },
  async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
  async getJobCursor(l, k) { return this.cursors.get(`${l}|${k}`) || null; },
  async setJobCursor(l, k, v) { this.cursors.set(`${l}|${k}`, v); },
});
const NOW13 = Date.parse("2026-10-13T20:00:00Z");
const sentOffer = (contactId, over = {}) => ({ id: `o-${contactId}`, contactId, contactName: "An Agent", address: "1 Elm St", cashAmount: 300000,
  status: "sent", createdAt: "2026-10-10T00:00:00Z", sends: [{ ts: "2026-10-13T19:00:00Z" }], ...over });

test("the offer going out moves the agent's card from Tier 1 to Offer Out and notes it on their record", async () => {
  _resetWorkflowCache();
  const moved = [];
  const store = cardStore([sentOffer("c1")]);
  const r = await syncAgentCard({ client: {}, locationId: "L-sync1", contactId: "c1", store,
    ghl: cardGhl({ moved, cards: [{ id: "op1", pipelineId: "pA", stageId: "t1", status: "open" }] }), now: NOW13 });
  assert.equal(r.applied?.to, "Offer Out");
  assert.deepEqual(moved, [{ id: "op1", stageId: "out" }]);
  assert.equal(store.events[0].type, "ghl_stage_moved");
  assert.equal(JSON.stringify(store.events).includes("An Agent"), false, "no names on the record line");
});

test("with GHL not following the offers, nothing is read from GHL and nothing moves", async () => {
  const moved = [];
  const store = cardStore([sentOffer("c1")], { ghlStages: { mode: "off" } });
  const r = await syncAgentCard({ client: {}, locationId: "L-sync2", contactId: "c1", store,
    ghl: { ...cardGhl({ moved }), listPipelines: async () => { throw new Error("should not read"); } }, now: NOW13 });
  assert.match(r.skip, /ghlStages off/);
  assert.equal(moved.length, 0);
});

test("a pass sends the card back to Tier 2 unless a texting nurture would fire, and a GHL failure never throws", async () => {
  _resetWorkflowCache();
  const passed = sentOffer("c2", { status: "passed", statusAt: "2026-10-13T19:30:00Z" });
  const moved = [];
  const ok = await syncAgentCard({ client: {}, locationId: "L-sync3", contactId: "c2", store: cardStore([passed]),
    ghl: cardGhl({ moved, cards: [{ id: "op2", pipelineId: "pA", stageId: "out", status: "open" }], workflows: [{ id: "w", name: "Tier 2+3 nurture", status: "draft" }] }), now: NOW13 });
  assert.equal(ok.applied?.to, "Tier 2");
  _resetWorkflowCache();
  const held = await syncAgentCard({ client: {}, locationId: "L-sync4", contactId: "c2", store: cardStore([passed]),
    ghl: cardGhl({ cards: [{ id: "op2", pipelineId: "pA", stageId: "out", status: "open" }], workflows: [{ id: "w", name: "Tier 2+3 nurture", status: "published" }] }), now: NOW13 });
  assert.match(held.move.blocked, /nurture/);
  const broken = await syncAgentCard({ client: {}, locationId: "L-sync5", contactId: "c2", store: cardStore([passed]), ghl: cardGhl({ fail: true }), now: NOW13 });
  assert.match(broken.error, /502/);
});

test("an agent with a live offer and no card gets one, at the stage the offer puts them", async () => {
  _resetWorkflowCache();
  const made = [];
  const r = await syncAgentCard({ client: {}, locationId: "L-sync6", contactId: "c3", store: cardStore([sentOffer("c3")]), ghl: cardGhl({ made }), now: NOW13 });
  assert.equal(r.applied?.to, "Offer Out");
  assert.deepEqual(made.map((m) => [m.contactId, m.stageId, m.name]), [["c3", "out", "An Agent"]]);
});

// 2026-10-29 Jessica S.: Matt passed the house the card sat in Needs Matt
// for, and the card stayed there. The click's sync read the Needs Matt list
// from 7 minutes before the pass.
const FIVE = [{ ...FOUR[0], stages: [...FOUR[0].stages, { id: "nm", name: "Needs Matt" }] }];
const needsMattStore = (offers, need) => {
  const store = cardStore(offers);
  store.cursors.set("L-nm|needsMatt", { at: need.readAt, doc: { readAt: need.readAt, needs: { c9: { kind: "price", rowKind: "price_it", why: "Price it", key: "k1", offerId: "o-c9", placed: true, landedAt: "2026-10-28T23:46:03Z" } } } });
  return store;
};
test("changing a house's status after the Needs Matt list was read takes the card out on that click", async () => {
  _resetWorkflowCache();
  const passed = sentOffer("c9", { status: "we_passed", statusAt: "2026-10-13T19:53:00Z", sends: [] });
  const moved = [];
  const store = needsMattStore([passed], { readAt: "2026-10-13T19:46:00Z" });
  const r = await syncAgentCard({ client: {}, locationId: "L-nm", contactId: "c9", store,
    ghl: { ...cardGhl({ moved, cards: [{ id: "op9", pipelineId: "pA", stageId: "nm", status: "open" }] }), listPipelines: async () => FIVE }, now: NOW13 });
  assert.equal(r.applied?.to, "Tier 2");
  assert.deepEqual(moved, [{ id: "op9", stageId: "t2" }]);
  assert.equal(store.cursors.get("L-nm|needsMatt").doc.needs.c9.placed, false, "the Needs Matt run reads them again and puts the card back if something still needs him");

  _resetWorkflowCache();
  const kept = [];
  const read = needsMattStore([passed], { readAt: "2026-10-13T19:55:00Z" });
  const s = await syncAgentCard({ client: {}, locationId: "L-nm", contactId: "c9", store: read,
    ghl: { ...cardGhl({ moved: kept, cards: [{ id: "op9", pipelineId: "pA", stageId: "nm", status: "open" }] }), listPipelines: async () => FIVE }, now: NOW13 });
  assert.match(s.skip, /already in Needs Matt/, "a list read after the change still holds");
  assert.equal(kept.length, 0);
});

test("every 15 minutes, only agents whose offers moved since the last run are synced; the first run only sets the clock", async () => {
  _resetWorkflowCache();
  const moved = [];
  const offers = [sentOffer("old", { sends: [{ ts: "2026-10-01T00:00:00Z" }], createdAt: "2026-09-30T00:00:00Z" }), sentOffer("fresh")];
  const store = cardStore(offers);
  const ghl = { ...cardGhl({ moved }), searchOpportunities: async (_c, _l, { contactId }) => [{ id: `op-${contactId}`, pipelineId: "pA", stageId: "t1", status: "open" }] };
  const first = await syncChangedCards({ client: {}, locationId: "L-tick", store, saved: { ghlStages: { mode: "on" } }, ghl, now: Date.parse("2026-10-13T19:30:00Z") });
  assert.equal(first.contacts, 0);
  offers[1].sends = [{ ts: "2026-10-13T19:45:00Z" }];
  const second = await syncChangedCards({ client: {}, locationId: "L-tick", store, saved: { ghlStages: { mode: "on" } }, ghl, now: NOW13 });
  assert.deepEqual([second.contacts, second.moved], [1, 1]);
  assert.deepEqual(moved, [{ id: "op-fresh", stageId: "out" }]);
  assert.equal(await syncChangedCards({ client: {}, locationId: "L-tick", store, saved: {}, ghl, now: NOW13 }), null, "off: no run at all");
});

test("when GHL follows the offers, a tag the bot added never moves the card; the tags follow the card", () => {
  const lori = opp("lori", "t3", ["agent", "tier-1", "tier-3"]);
  const fixes = planTierFixes({ pipelines: PIPES, opportunities: [lori], followsOffers: true,
    tagEvents: [{ contactId: "lori", at: "2026-09-15T11:00:00Z", data: { tag: "tier-1" } }] });
  assert.deepEqual([fixes[0].moveTo, fixes[0].remove, fixes[0].add], [null, ["tier-1"], []]);
});

// 2026-10-14: the bot's TIER 2 enrollment on "she's listing next week" put
// the card in Tier 2 — the conversation's own read. It's not the app's move
// to undo on an unsent number; the planner's and the migration's are.
import { appMovesByContact as _appMoves } from "./tier-check.js";
test("only the app's own card moves count as the app's, not the bot's TIER workflows", () => {
  const m = _appMoves([
    { contactId: "a", type: "ghl_stage_moved", at: "2026-10-13T23:07:31Z" },
    { contactId: "b", type: "workflow_enrolled", at: "2026-10-13T22:09:58Z" },
  ]);
  assert.deepEqual(m.get("a"), ["2026-10-13T23:07:31Z"]);
  assert.equal(m.has("b"), false);
});

// Matt, 2026-10-16 (Deanna W.): an agent wrote back with nothing to price,
// so no offer, so no card — nothing in GHL said to follow up with her.
// With ghlStages.tier2Repliers, a conversation gets a Tier 2 card.
const word = (contactId, at, over = {}) => ({ contactId, party: "agent", type: "text_summary", at, data: { inbound: "no fixers right now, I'll call when I have one" }, ...over });
const TAGS = { dw: ["agent-outreach"], "has-t1": ["agent"], "aa-talk": ["agent-outreach-pierce"], stop: ["agent"], unsub: ["agent"], buyer: ["investor"], home: ["wholesaling_pipeline_automation"] };
const replierStore = ({ last = [], events = [], offers = [], saved = { ghlStages: { mode: "on", tier2Repliers: true } } } = {}) => ({
  ...cardStore(offers, saved),
  async lastContactActivity() { return last; },
  async listContactProfiles() { return Object.entries(TAGS).map(([contactId, tags]) => ({ contactId, party: "agent", tags })); },
  async listContactEventsSince(_l, since, { types } = {}) { return [...last, ...events].filter((e) => String(e.at) >= since && (!types || types.includes(e.type))); },
  async listContactEvents(_l, contactId, { types } = {}) { return [...last, ...events].filter((e) => e.contactId === contactId && (!types || types.includes(e.type))); },
});
const replierGhl = ({ made = [], moved = [], cards = [] } = {}) => ({
  ...cardGhl({ made, moved, cards }),
  listAcquisitionOpportunities: async () => cards,
  getContact: async (_c, id) => ({ id, firstName: "Dee", lastName: "W", tags: TAGS[id] || [] }),
});

test("an agent who wrote back with nothing to price gets a Tier 2 card at the morning sweep; a buyer and an agent who opted out don't", async () => {
  _resetWorkflowCache();
  const made = [];
  const store = replierStore({
    last: [word("dw", "2026-10-13T01:06:00Z"), word("buyer", "2026-10-13T01:00:00Z", { party: "investor" }),
      word("stop", "2026-10-13T01:00:00Z", { data: { inbound: "STOP", intent: "opt_out" } }), word("unsub", "2026-10-12T01:00:00Z")],
    events: [{ contactId: "unsub", party: "agent", type: "unsubscribed", at: "2026-10-12T02:00:00Z" }],
  });
  const saved = await store.getOfferSettings();
  const preview = await runStagePlan({ client: {}, locationId: "L-rep1", store, ghl: replierGhl({ made }), saved, dryRun: true, now: NOW13 });
  assert.deepEqual(preview.creates.map((c) => [c.contactId, c.to]), [["dw", "Tier 2"]]);
  assert.equal(made.length, 0, "a dry run makes nothing");
  const r = await runStagePlan({ client: {}, locationId: "L-rep1", store, ghl: replierGhl({ made }), saved, dryRun: false, now: NOW13 });
  assert.equal(r.created, 1);
  assert.deepEqual(made.map((m) => [m.contactId, m.stageId, m.name]), [["dw", "t2", "Dee W"]]);
  assert.equal(store.events.at(-1).type, "ghl_stage_moved");
  assert.equal(JSON.stringify(store.events.at(-1)).includes("Dee"), false, "no names on the record line");
  // Switched off: no card.
  const off = await runStagePlan({ client: {}, locationId: "L-rep1", store, ghl: replierGhl(), saved: { ghlStages: { mode: "on" } }, dryRun: true, now: NOW13 });
  assert.equal(off.creates.length, 0);
});

test("a conversation's Tier 2 card waits behind the offers' own cards when the run's cap is reached", async () => {
  _resetWorkflowCache();
  const made = [];
  const store = replierStore({ last: [word("aa-talk", "2026-10-13T01:06:00Z")], offers: [sentOffer("zz-live")],
    saved: { ghlStages: { mode: "on", tier2Repliers: true, maxMovesPerRun: 1 } } });
  const r = await runStagePlan({ client: {}, locationId: "L-rep2", store, ghl: replierGhl({ made }), saved: await store.getOfferSettings(), dryRun: false, now: NOW13 });
  assert.deepEqual(made.map((m) => [m.contactId, m.stageId]), [["zz-live", "out"]]);
  assert.equal(r.creates.find((c) => c.contactId === "aa-talk").applied, undefined);
});

test("every 15 minutes, an agent who wrote back since the last run and has no card gets a Tier 2 card; that path never moves a card they have", async () => {
  _resetWorkflowCache();
  const made = [];
  const moved = [];
  const last = [];
  const store = replierStore({ last });
  const saved = await store.getOfferSettings();
  const ghl = { ...replierGhl({ made, moved }), searchOpportunities: async (_c, _l, { contactId }) => (contactId === "has-t1"
    ? [{ id: "op-t1", pipelineId: "pA", stageId: "t1", status: "open", lastStageChangeAt: "2026-09-01T00:00:00Z" }] : []) };
  await syncChangedCards({ client: {}, locationId: "L-rep3", store, saved, ghl, now: Date.parse("2026-10-13T19:30:00Z") });
  last.push(word("dw", "2026-10-13T19:40:00Z"), word("has-t1", "2026-10-13T19:41:00Z"), word("buyer", "2026-10-13T19:42:00Z", { party: "investor" }));
  const r = await syncChangedCards({ client: {}, locationId: "L-rep3", store, saved, ghl, now: NOW13 });
  assert.equal(r.repliers, 2);
  assert.deepEqual(made.map((m) => [m.contactId, m.stageId]), [["dw", "t2"]]);
  assert.equal(moved.length, 0, "a Tier 1 card with no offers is the morning sweep's, not this path's");
});

// The preview before switching it on (2026-10-16) planned a card for a
// homeowner from the June seller texts: "No thanks. That's our primary home".
// Their texts were filed as an agent's. Only a contact GHL tags as an agent
// (the Conversation AI routing: agent, agent-*) gets a conversation's card.
test("a homeowner whose text was filed as an agent's gets no Tier 2 card; only a contact tagged as an agent does", async () => {
  _resetWorkflowCache();
  const made = [];
  const store = replierStore({ last: [word("dw", "2026-10-13T01:06:00Z"), word("home", "2026-10-13T01:00:00Z")] });
  const saved = await store.getOfferSettings();
  const r = await runStagePlan({ client: {}, locationId: "L-rep4", store, ghl: replierGhl({ made }), saved, dryRun: false, now: NOW13 });
  assert.deepEqual(r.creates.map((c) => c.contactId), ["dw"]);
  assert.deepEqual(made.map((m) => m.contactId), ["dw"]);
  // Profile tags can be stale: GHL's own tags are checked before the card is made.
  const stale = { ...store, async listContactProfiles() { return [{ contactId: "home", party: "agent", tags: ["agent"] }]; } };
  const r2 = await runStagePlan({ client: {}, locationId: "L-rep5", store: stale, ghl: replierGhl({ made }), saved, dryRun: false, now: NOW13 });
  assert.deepEqual([r2.created, made.length], [0, 1]);
  assert.match(r2.creates.find((c) => c.contactId === "home").skipped, /not tagged as an agent/);
  // The 15-minute path checks the same.
  const tick = replierStore({ last: [] });
  await syncChangedCards({ client: {}, locationId: "L-rep6", store: tick, saved, ghl: replierGhl({ made }), now: Date.parse("2026-10-13T19:30:00Z") });
  tick.lastContactActivity = async () => [word("home", "2026-10-13T19:50:00Z")];
  const tickWords = [word("home", "2026-10-13T19:50:00Z")];
  tick.listContactEventsSince = async () => tickWords;
  tick.listContactEvents = async (_l, id) => tickWords.filter((e) => e.contactId === id);
  const t = await syncChangedCards({ client: {}, locationId: "L-rep6", store: tick, saved, ghl: replierGhl({ made }), now: NOW13 });
  assert.deepEqual([t.repliers, t.moved, made.length], [1, 0, 1]);
});

// The second preview planned none: most profiles carry no tags (Deanna W.'s
// is []). Her agent tag is on her timeline, from the outreach import.
test("an agent whose profile has no tags is known by the agent tag the outreach import added, or by our opener, or by an offer", async () => {
  _resetWorkflowCache();
  const made = [];
  const at = "2026-10-12T17:22:38Z";
  const store = {
    ...replierStore({ last: [word("dw", "2026-10-13T01:06:00Z"), word("aa-talk", "2026-10-13T01:05:00Z"), word("has-t1", "2026-10-13T01:04:00Z"), word("home", "2026-10-13T01:00:00Z")],
      offers: [sentOffer("has-t1", { status: "passed", statusAt: "2026-10-12T00:00:00Z" })] }),
    async listContactProfiles() { return ["dw", "aa-talk", "has-t1", "home"].map((contactId) => ({ contactId, party: "agent", tags: [] })); },
  };
  const signals = [{ contactId: "dw", type: "tag_added", at, data: { tag: "agent-outreach-autopilot-king-wa" } },
    { contactId: "aa-talk", type: "outreach_sent", at }, { contactId: "home", type: "tag_added", at, data: { tag: "wholesaling_pipeline_automation" } }];
  const events = store.listContactEventsSince;
  store.listContactEventsSince = async (l, since, o = {}) => [...(await events.call(store, l, since, o)), ...signals.filter((e) => !o.types || o.types.includes(e.type))];
  const r = await runStagePlan({ client: {}, locationId: "L-rep7", store, ghl: replierGhl({ made }), saved: await store.getOfferSettings(), dryRun: true, now: NOW13 });
  assert.deepEqual(r.creates.map((c) => c.contactId).sort(), ["aa-talk", "dw", "has-t1"]);
});

// Matt, 2026-10-16: "Tier 1 should be allowed even if there is no draft or
// offer." An agent answered our first text with "It needs a lot of work";
// the bot asked its one question, nothing was priced, and the card stayed
// out of Tier 1. The conversation's own record raises the house
// (shared/ghl-stages.js raisedHouses), with tier2Repliers on or off.
const raisedEv = (contactId, type, data, at = "2026-10-13T19:45:00Z", address = "20911 78th Ave W, Edmonds, WA 98026") => ({ contactId, party: "agent", type, at, address, data });
const ONLY_OFFERS = { ghlStages: { mode: "on" } };

test("an agent who says the house needs a lot of work gets a Tier 1 card at the morning sweep with nothing priced; a homeowner saying it about their own house doesn't", async () => {
  _resetWorkflowCache();
  const made = [];
  const store = replierStore({ saved: ONLY_OFFERS, events: [
    raisedEv("dw", "property_details", { condition: "needs a lot of work" }),
    raisedEv("home", "property_details", { condition: "needs a lot of work" }),
  ] });
  const r = await runStagePlan({ client: {}, locationId: "L-raise1", store, ghl: replierGhl({ made }), saved: ONLY_OFFERS, dryRun: false, now: NOW13 });
  assert.deepEqual(r.creates.map((c) => [c.contactId, c.to, c.conversation]), [["dw", "Tier 1", true]]);
  assert.deepEqual(made.map((m) => [m.contactId, m.stageId]), [["dw", "t1"]]);
  assert.equal(r.counts.conversation, 1);
});

test("a Tier 1 card from the conversation waits for GHL's agent tag, even when the profile says agent", async () => {
  _resetWorkflowCache();
  const made = [];
  const store = { ...replierStore({ saved: ONLY_OFFERS, events: [raisedEv("home", "house_mentioned", { needsAddress: false })] }),
    async listContactProfiles() { return [{ contactId: "home", party: "agent", tags: ["agent"] }]; } };
  const r = await runStagePlan({ client: {}, locationId: "L-raise2", store, ghl: replierGhl({ made }), saved: ONLY_OFFERS, dryRun: false, now: NOW13 });
  assert.equal(made.length, 0);
  assert.match(r.creates.find((c) => c.contactId === "home")?.skipped || "", /not tagged as an agent/);
});

test("every 15 minutes, a house an agent raised since the last run puts their card in Tier 1, and our pass on it takes the card back to Tier 2", async () => {
  _resetWorkflowCache();
  const made = [];
  const moved = [];
  const events = [];
  const store = replierStore({ saved: ONLY_OFFERS, events });
  let cards = [];
  const ghl = { ...replierGhl({ made, moved }), searchOpportunities: async () => cards };
  await syncChangedCards({ client: {}, locationId: "L-raise3", store, saved: ONLY_OFFERS, ghl, now: Date.parse("2026-10-13T19:30:00Z") });
  events.push(raisedEv("dw", "house_mentioned", { needsAddress: false, note: "rambler, needs some work and updates" }, "2026-10-13T19:40:00Z"));
  const r = await syncChangedCards({ client: {}, locationId: "L-raise3", store, saved: ONLY_OFFERS, ghl, now: Date.parse("2026-10-13T19:45:00Z") });
  assert.equal(r.moved, 1);
  assert.deepEqual(made.map((m) => [m.contactId, m.stageId]), [["dw", "t1"]]);
  cards = [{ id: "op-dw", contactId: "dw", pipelineId: "pA", stageId: "t1", status: "open", lastStageChangeAt: "2026-10-13T19:45:00Z" }];
  events.push(raisedEv("dw", "house_closed", { why: "we passed on it" }, "2026-10-13T19:50:00Z"));
  const back = await syncChangedCards({ client: {}, locationId: "L-raise3", store, saved: ONLY_OFFERS, ghl, now: NOW13 });
  assert.equal(back.moved, 1);
  assert.deepEqual(moved.map((m) => [m.id, m.stageId]), [["op-dw", "t2"]]);
});

// Matt, 2026-10-19 (Nikki C., Brian B.): "all agents who HAVE responded (not
// negatively like stop, etc)" in Tier 2. The app knew a reply only from the
// bot's summary of it, and 153 agents who wrote back had none — the July and
// August lists the bot never answered, threads it was stopped on. The
// morning sweep reads GHL's threads for them.
const thread = (contactId, lastMessageDate, tags = ["agent-list-1"]) => ({ id: `cv-${contactId}`, contactId, lastMessageDate, tags, sort: [lastMessageDate] });
const textIn = (body, dateAdded) => ({ direction: "inbound", messageType: "TYPE_SMS", body, dateAdded });
const textOut = (dateAdded) => ({ direction: "outbound", messageType: "TYPE_SMS", body: "Hey, saw your listing. Is it a bit of a project?", dateAdded });
const ghlThreads = (threads, messages) => ({
  searchConversations: async (_c, _l, { startAfterDate } = {}) => ({
    conversations: threads.filter((t) => startAfterDate == null || t.lastMessageDate < startAfterDate).sort((a, b) => b.lastMessageDate - a.lastMessageDate).slice(0, 100),
  }),
  listConversationMessages: async (_c, id) => ({ messages: messages[id.slice(3)] || [] }),
});
const JUL22 = Date.parse("2026-07-22T18:00:00Z");

test("an agent who wrote back that the bot never answered gets a Tier 2 card at the morning sweep; one who said stop, a buyer, and one who never answered don't", async () => {
  _resetWorkflowCache();
  const made = [];
  const store = replierStore({ last: [] });
  const saved = await store.getOfferSettings();
  const threads = [thread("july", JUL22), thread("stopped", JUL22 + 1000), thread("quiet", JUL22 + 2000),
    thread("buyer2", JUL22 + 3000, ["agent-list-1", "investor"]), thread("dnc", JUL22 + 4000, ["agent-outreach", "dnc"])];
  const messages = {
    july: [textOut("2026-07-22T17:00:00Z"), textIn("It just needs updating, but it's in really good condition", "2026-07-22T18:00:00Z")],
    stopped: [textOut("2026-07-22T17:00:00Z"), textIn("Brand new", "2026-07-22T18:00:00Z"), textIn("Remove from list please", "2026-07-22T18:01:00Z")],
    quiet: [textOut("2026-07-22T17:00:00Z")],
    buyer2: [textIn("Send it over", "2026-07-22T18:00:00Z")],
    dnc: [textIn("Sure", "2026-07-22T18:00:00Z")],
  };
  const ghl = { ...replierGhl({ made }), ...ghlThreads(threads, messages), getContact: async (_c, id) => ({ id, firstName: "Ann", lastName: "J", tags: ["agent-list-1"] }) };
  const r = await runStagePlan({ client: {}, locationId: "L-gw1", store, ghl, saved, dryRun: false, readGhlWords: true, now: NOW13 });
  assert.deepEqual(made.map((m) => [m.contactId, m.stageId]), [["july", "t2"]]);
  assert.equal(r.fromGhl, 1);
  // The next morning reads only the threads that moved since.
  const reads = [];
  const ghl2 = { ...ghl, listConversationMessages: async (_c, id) => { reads.push(id); return { messages: messages[id.slice(3)] || [] }; } };
  threads.push(thread("today", NOW13 + 3600000, ["agent-outreach-autopilot-king-wa"]));
  messages.today = [textOut("2026-10-13T20:30:00Z"), textIn("It's pending, closes Thursday", "2026-10-13T20:50:00Z")];
  await runStagePlan({ client: {}, locationId: "L-gw1", store, ghl: ghl2, saved, dryRun: false, readGhlWords: true, now: NOW13 + 86400000 });
  assert.deepEqual(reads, ["cv-today"]);
  assert.deepEqual(made.map((m) => m.contactId), ["july", "today"]);
  // A dry run (the Settings preview) reads no thread.
  reads.length = 0;
  await runStagePlan({ client: {}, locationId: "L-gw1", store, ghl: ghl2, saved, dryRun: true, readGhlWords: true, now: NOW13 + 2 * 86400000 });
  assert.equal(reads.length, 0);
});

test("an agent found in GHL's thread whose card waited behind the run's cap gets it the next morning, though their thread hasn't moved", async () => {
  _resetWorkflowCache();
  const made = [];
  const store = replierStore({ last: [], offers: [sentOffer("zz-live")], saved: { ghlStages: { mode: "on", tier2Repliers: true, maxMovesPerRun: 1 } } });
  const saved = await store.getOfferSettings();
  const threads = [thread("july", JUL22)];
  const messages = { july: [textIn("Not really a good candidate", "2026-07-22T18:00:00Z")] };
  const ghl = { ...replierGhl({ made }), ...ghlThreads(threads, messages), getContact: async (_c, id) => ({ id, firstName: "Ann", lastName: "J", tags: ["agent-list-1"] }) };
  await runStagePlan({ client: {}, locationId: "L-gw2", store, ghl, saved, dryRun: false, readGhlWords: true, now: NOW13 });
  assert.deepEqual(made.map((m) => m.contactId), ["zz-live"]);
  const ghl2 = { ...ghl, searchOpportunities: async () => [], listAcquisitionOpportunities: async () => [{ id: "op-zz", contactId: "zz-live", pipelineId: "pA", pipelineStageId: "out", status: "open", lastStageChangeAt: "2026-10-13T20:00:00Z" }] };
  await runStagePlan({ client: {}, locationId: "L-gw2", store, ghl: ghl2, saved, dryRun: false, readGhlWords: true, now: NOW13 + 86400000 });
  assert.deepEqual(made.map((m) => m.contactId), ["zz-live", "july"]);
  assert.deepEqual(Object.keys(store.cursors.get("L-gw2|ghlWords").doc.pending), [], "carded, so no longer waiting");
});
