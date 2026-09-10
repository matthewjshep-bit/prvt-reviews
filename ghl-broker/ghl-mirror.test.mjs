import test from "node:test";
import assert from "node:assert/strict";
import { mirrorOffer, reconcileLocation, mirrorAgent, reconcileAgents } from "./ghl-mirror.js";

const cfg = { enabled: true,
  acquisitions: { mode: "lanes", pipelineId: "pA", stages: { ready: "s-ready", sent: "s-sent", dead: "s-dead", won: "s-won" } },
  dispositions: { pipelineId: "pD", stages: { under_contract: "d-uc", closed: "d-closed" } } };
const fakeGhl = () => {
  const calls = []; let n = 0;
  return { calls, api: {
    searchOpportunities: async (_c, _l, q) => { calls.push(["search", q]); return []; },
    createOpportunity: async (_c, body) => { calls.push(["create", body]); return { id: `op${++n}` }; },
    updateOpportunity: async (_c, id, body) => { calls.push(["update", id, body]); return {}; },
  } };
};
const fakeStore = (offers) => ({
  docs: new Map(offers.map((o) => [o.id, o])),
  async listOffers() { return [...this.docs.values()].map((o) => ({ ...o })); },
  async getOffer(id) { return this.docs.get(id) || null; },
  async updateOffer(id, doc) { this.docs.set(id, doc); return true; },
  cursors: new Map(), async setJobCursor(l, k, v) { this.cursors.set(`${l}|${k}`, v); },
});
const offer = (over = {}) => ({ id: "o1", contactId: "c1", address: "12 Elm St", cashAmount: 410000, status: "new", createdAt: "2026-09-01T00:00:00Z", ...over });

test("a new offer is created in the mapped lane, remembered, and not written again", async () => {
  const { calls, api } = fakeGhl();
  const store = fakeStore([offer()]);
  const r = await mirrorOffer({ client: {}, locationId: "L", offer: store.docs.get("o1"), config: cfg, store, ghl: api });
  assert.deepEqual(r.wrote, ["acquisitions"]);
  assert.equal(calls[0][0], "search");
  assert.equal(calls[1][0], "create");
  assert.equal(calls[1][1].stageId, "s-ready");
  assert.equal(calls[1][1].value, 410000);
  const saved = store.docs.get("o1");
  assert.equal(saved.mirror.acquisitions.id, "op1");
  const again = await mirrorOffer({ client: {}, locationId: "L", offer: saved, config: cfg, store, ghl: api });
  assert.deepEqual(again.skipped, ["acquisitions"]);
  assert.equal(calls.length, 2);
});

test("an existing opportunity on the contact with the same name is adopted rather than duplicated", async () => {
  const { calls, api } = fakeGhl();
  api.searchOpportunities = async () => [{ id: "hand-made", name: "12 elm st", pipelineId: "pA", stageId: "x", status: "open", value: 0 }];
  const store = fakeStore([offer()]);
  await mirrorOffer({ client: {}, locationId: "L", offer: store.docs.get("o1"), config: cfg, store, ghl: api });
  assert.equal(calls.some(([k]) => k === "create"), false);
  assert.equal(calls.find(([k]) => k === "update")[1], "hand-made");
  assert.equal(store.docs.get("o1").mirror.acquisitions.id, "hand-made");
});

test("becoming a deal marks the acquisitions opportunity won and creates the dispositions one", async () => {
  const { calls, api } = fakeGhl();
  const o = offer({ mirror: { acquisitions: { id: "op1", pipelineId: "pA", stageId: "s-sent", status: "open", value: 410000 } }, status: "accepted",
    deal: { stage: "under_contract", contractPrice: 410000, assignmentFee: 30000, stageHistory: [] } });
  const store = fakeStore([o]);
  const r = await mirrorOffer({ client: {}, locationId: "L", offer: store.docs.get("o1"), config: cfg, store, ghl: api });
  assert.deepEqual(r.wrote, ["acquisitions", "dispositions"]);
  const upd = calls.find(([k, id]) => k === "update" && id === "op1");
  assert.equal(upd[2].status, "won");
  assert.equal(upd[2].stageId, "s-won");
  const create = calls.find(([k]) => k === "create");
  assert.equal(create[1].pipelineId, "pD");
  assert.equal(create[1].value, 440000);
});

test("a GHL failure is an error on the result and the memory is not advanced", async () => {
  const { api } = fakeGhl();
  api.createOpportunity = async () => { throw new Error("401 no scope"); };
  const store = fakeStore([offer()]);
  const r = await mirrorOffer({ client: {}, locationId: "L", offer: store.docs.get("o1"), config: cfg, store, ghl: api });
  assert.equal(r.wrote.length, 0);
  assert.match(r.errors[0], /401 no scope/);
  assert.equal(store.docs.get("o1").mirror, undefined);
});

test("the reconcile writes only what differs, bounded per tick", async () => {
  const { calls, api } = fakeGhl();
  const store = fakeStore([offer({ id: "a" }), offer({ id: "b", status: "passed" }), offer({ id: "c", status: "draft" }),
    offer({ id: "d", mirror: { acquisitions: { id: "opd", pipelineId: "pA", stageId: "s-ready", status: "open", value: 410000 } } })]);
  const r = await reconcileLocation({ client: {}, locationId: "L", saved: { ghlMirror: cfg }, store, ghl: api, limit: 10 });
  assert.equal(r.considered, 4);
  assert.equal(r.wrote, 2, "a and b; c is a hand draft, d is unchanged");
  const off = await reconcileLocation({ client: {}, locationId: "L", saved: { ghlMirror: { ...cfg, enabled: false } }, store, ghl: api });
  assert.equal(off.wrote, 0);
  const bounded = fakeStore([offer({ id: "x" }), offer({ id: "y" }), offer({ id: "z" })]);
  const b = await reconcileLocation({ client: {}, locationId: "L", saved: { ghlMirror: cfg }, store: bounded, ghl: fakeGhl().api, limit: 2 });
  assert.equal(b.wrote, 2);
});

/* ---------- agents by tier ---------- */

const tiersCfg = { enabled: true, acquisitions: { mode: "tiers", pipelineId: "pA", pipelineName: "Acquisitions", stages: { "tier-1": "s1", "tier-2": "s2", "tier-3": "s3" } }, dispositions: {} };
const fakeGhlWithContacts = (contacts = {}) => {
  const base = fakeGhl();
  base.api.getContact = async (_c, id) => { base.calls.push(["getContact", id]); return contacts[id] || { id, tags: [] }; };
  return base;
};
const agentStore = ({ profiles = [], offers = [], events = [] } = {}) => ({
  profiles: new Map(profiles.map((p) => [p.contactId, p])),
  docs: new Map(offers.map((o) => [o.id, o])),
  events,
  cursors: new Map(),
  async listContactProfiles() { return [...this.profiles.values()]; },
  async upsertContactProfile(l, id, patch) { const prev = this.profiles.get(id) || { contactId: id }; const next = { ...prev, ...patch }; this.profiles.set(id, next); return next; },
  async getContactProfile(l, id) { return this.profiles.get(id) || null; },
  async listOffers() { return [...this.docs.values()]; },
  async getOffer(id) { return this.docs.get(id) || null; },
  async updateOffer(id, doc) { this.docs.set(id, doc); return true; },
  async listContactEventsSince(l, since, { types } = {}) { return this.events.filter((e) => e.at >= since && (!types || types.includes(e.type))); },
  async getJobCursor(l, k) { return this.cursors.get(`${l}|${k}`) || null; },
  async setJobCursor(l, k, v) { this.cursors.set(`${l}|${k}`, v); },
});

test("an agent lands in the stage their tier tag maps to, is remembered, and only moves when the tier does", async () => {
  const { calls, api } = fakeGhlWithContacts();
  const store = agentStore({ profiles: [{ contactId: "c1", party: "agent", name: "Dana Reyes", tags: ["agent", "tier-2"], ghlSeenAt: new Date().toISOString() }],
    offers: [{ id: "o1", contactId: "c1", address: "12 Elm St", cashAmount: 410000, status: "sent", createdAt: "2026-09-01T00:00:00Z" }] });
  const r = await mirrorAgent({ client: {}, locationId: "L", contactId: "c1", config: tiersCfg, store, ghl: api, profile: store.profiles.get("c1"), offers: [...store.docs.values()] });
  assert.equal(r.wrote, true);
  assert.equal(r.tier, "tier-2");
  const create = calls.find(([k]) => k === "create");
  assert.equal(create[1].stageId, "s2");
  assert.equal(create[1].name, "Dana Reyes");
  assert.equal(create[1].value, 410000);
  // same again: nothing
  const again = await mirrorAgent({ client: {}, locationId: "L", contactId: "c1", config: tiersCfg, store, ghl: api, profile: store.profiles.get("c1"), offers: [...store.docs.values()] });
  assert.equal(again.skipped, true);
  // the bot moved them to tier 1 (an app event after the GHL snapshot): one update, to s1
  const ev = [{ contactId: "c1", type: "tag_added", at: new Date(Date.now() + 1000).toISOString(), data: { tag: "tier-1" } }];
  const moved = await mirrorAgent({ client: {}, locationId: "L", contactId: "c1", config: tiersCfg, store, ghl: api, profile: store.profiles.get("c1"), events: ev, offers: [...store.docs.values()] });
  assert.equal(moved.wrote, true);
  const upd = calls.find(([k]) => k === "update");
  assert.equal(upd[2].stageId, "s1");
});

test("the agent reconcile refreshes stale tag snapshots from GHL (bounded) and treats a live deal as tier 1", async () => {
  const { calls, api } = fakeGhlWithContacts({ stale: { id: "stale", firstName: "Lee", lastName: "Chen", tags: ["tier-3"] }, other: { id: "other", tags: ["tier-2"] } });
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  const store = agentStore({
    profiles: [{ contactId: "stale", party: "agent", name: "", tags: [], ghlSeenAt: old }, { contactId: "other", party: "agent", name: "Sam", tags: [], ghlSeenAt: old }],
    offers: [{ id: "o9", contactId: "dealer", contactName: "Priya", address: "9 Deal St", cashAmount: 300000, status: "accepted", deal: { stage: "under_contract" }, createdAt: "2026-09-01T00:00:00Z" }],
  });
  const r = await reconcileAgents({ client: {}, locationId: "L", saved: { ghlMirror: tiersCfg }, store, ghl: api, refreshLimit: 1 });
  assert.equal(r.considered, 3, "two profiles and one agent known only through an offer");
  assert.equal(r.refreshed, 1, "one refresh a pass under the budget");
  const refreshedId = calls.find(([k]) => k === "getContact")[1];
  assert.equal(store.profiles.get(refreshedId).tags.length > 0, true, "the snapshot was updated");
  const creates = calls.filter(([k]) => k === "create").map(([, b]) => [b.contactId, b.stageId]);
  assert.ok(creates.some(([id, st]) => id === "dealer" && st === "s1"), "a live deal is tier 1 whatever the tags say");
  assert.ok(creates.some(([id, st]) => id === refreshedId && (st === "s3" || st === "s2")), "the refreshed agent landed in the tier GHL holds");
  // off, or lanes mode: no agent pass
  const off = await reconcileAgents({ client: {}, locationId: "L", saved: { ghlMirror: { ...tiersCfg, acquisitions: { ...tiersCfg.acquisitions, mode: "lanes" } } }, store, ghl: api });
  assert.equal(off.considered, 0);
});
