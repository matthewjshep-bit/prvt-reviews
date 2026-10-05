// counter-hold.test.mjs — after our held number: check in, then pass.
//
// Matt, 2026-10-04: "hold, then pass". The hold text is the reply agent's;
// this is the clock after it — a check-in on the normal spacing, and the
// pass when they don't move.

import test from "node:test";
import assert from "node:assert/strict";
import { holdState, runCounterHolds } from "./counter-hold.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-10T16:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const CFG = (on = true) => normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, minHoursBetween: 72 }, counterHold: { enabled: on, checkIns: 2 } } } });
const heldOffer = (hold) => ({ id: "o1", contactId: "c1", address: "12 Elm St, Seattle, WA 98101", status: "countered", cashAmount: 300000,
  createdAt: ago(30), sends: [{ ts: ago(20) }], counter: { amount: 315000, at: ago(9) }, counterHold: { ours: 300000, theirs: 315000, nudges: [], replies: [], ...hold } });

test("after the hold: a check-in once the spacing has passed, then the pass after two quiet ones", () => {
  assert.equal(holdState(heldOffer({ at: ago(1) }), { now: NOW }).next, "wait");
  assert.equal(holdState(heldOffer({ at: ago(4) }), { now: NOW }).next, "nudge");
  assert.equal(holdState(heldOffer({ at: ago(8), nudges: [ago(4)] }), { now: NOW }).next, "nudge");
  assert.equal(holdState(heldOffer({ at: ago(12), nudges: [ago(8), ago(4)] }), { now: NOW }).next, "pass");
  // A reply that didn't move counts like a check-in.
  assert.equal(holdState(heldOffer({ at: ago(12), nudges: [ago(8)], replies: [ago(4)] }), { now: NOW }).next, "pass");
  // They wrote since our last word: the conversation has it, no clock.
  assert.equal(holdState(heldOffer({ at: ago(8), nudges: [ago(4)] }), { lastInboundAt: ago(2), now: NOW }).next, "wait");
});

const fakeStore = (offers, drafts = []) => ({
  events: [],
  async listOffers() { return offers; },
  async getOffer(id) { return offers.find((o) => o.id === id) || null; },
  async listReplyDrafts(_l, { contactId } = {}) { return drafts.filter((d) => !contactId || d.contactId === contactId); },
  async listContactEvents() { return this.events; },
  async appendContactEvents(_l, contactId, add) {
    let inserted = 0;
    for (const r of add) { if (r.dedupeKey && this.events.some((e) => e.dedupeKey === r.dedupeKey)) continue; this.events.push({ ...r, contactId }); inserted++; }
    return { inserted, skipped: add.length - inserted };
  },
  async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
});

test("a counter above our number gets our number once, then we move on: check in, check in, pass", async () => {
  const started = [], nudged = [], passed = [];
  const deps = {
    startProactive: async (a) => { started.push(a); return { job: { id: "p1" } }; },
    markCounterHoldNudge: async (a) => { nudged.push(a.offerId); return { ok: true }; },
    passHeldCounter: async (a) => { passed.push(a); return { ok: true }; },
  };
  const nudge = await runCounterHolds({ locationId: "L", store: fakeStore([heldOffer({ at: ago(4) })]), config: CFG(), deps, now: NOW });
  assert.deepEqual(nudge.map((r) => r.status), ["started"]);
  assert.equal(started[0].kind, "counter_nudge");
  assert.deepEqual(started[0].subject.held, { ours: 300000, step: 1, of: 2 });
  assert.deepEqual(nudged, ["o1"]);
  const pass = await runCounterHolds({ locationId: "L", store: fakeStore([heldOffer({ at: ago(12), nudges: [ago(8), ago(4)] })]), config: CFG(), deps, now: NOW });
  assert.deepEqual(pass.map((r) => r.status), ["passed"]);
  assert.match(passed[0].note, /held at 300K; 2 check-ins and they didn't move/);
  // Off: nothing — and a preview can still say what it would do.
  assert.deepEqual(await runCounterHolds({ locationId: "L", store: fakeStore([heldOffer({ at: ago(4) })]), config: CFG(false), deps, now: NOW }), []);
  const preview = await runCounterHolds({ locationId: "L", store: fakeStore([heldOffer({ at: ago(12), nudges: [ago(8), ago(4)] })]), config: CFG(false), deps, now: NOW, dryRun: true, ignoreSwitch: true });
  assert.deepEqual(preview.map((r) => r.status), ["would_pass"]);
});

test("an agreed price or a deal is never passed by the clock", async () => {
  const deps = { passHeldCounter: async () => { throw new Error("must not pass"); }, startProactive: async () => ({ job: { id: "x" } }) };
  const agreed = { ...heldOffer({ at: ago(12), nudges: [ago(8), ago(4)] }), agreed: { amount: 300000, at: ago(3) } };
  assert.deepEqual(await runCounterHolds({ locationId: "L", store: fakeStore([agreed]), config: CFG(), deps, now: NOW }), []);
  const deal = { ...heldOffer({ at: ago(12), nudges: [ago(8), ago(4)] }), deal: { stage: "under_contract" } };
  assert.deepEqual(await runCounterHolds({ locationId: "L", store: fakeStore([deal]), config: CFG(), deps, now: NOW }), []);
});
