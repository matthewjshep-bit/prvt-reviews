// promise-driver.test.mjs — the machine keeping its own promises.

import test from "node:test";
import assert from "node:assert/strict";
import { driveOpenPromises, DRIVER_GRACE_MIN } from "./promise-driver.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";

const NOW = Date.parse("2026-09-17T20:00:00Z");
const at = (h) => new Date(NOW - h * 3600000).toISOString();
const HOUSE = "3004 E Yesler Way, Seattle, WA 98122";
const THIN = "only 1 priced comps — the price proxy needs 6 to have a top tier — not enough nearby sales to tell renovated from tired by price";
const saved = (on = true) => ({ aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true, driver: { promises: { enabled: on } }, parties: { agent: { followUp: { enabled: true } } } }) });

const fakeStore = ({ events = [], drafts = [], offers = [] } = {}) => {
  const rows = [...events];
  return {
    events: rows,
    async listContactEventsSince(_loc, since, { types = null } = {}) { return rows.filter((e) => e.at >= since && (!types || types.includes(e.type))); },
    async listContactEvents(_loc, contactId) { return rows.filter((e) => e.contactId === contactId); },
    async appendContactEvents(_loc, contactId, add) {
      let inserted = 0;
      for (const r of add) { if (r.dedupeKey && rows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue; rows.push({ ...r, contactId }); inserted++; }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; },
    async upsertContactProfile() { return {}; },
    async listReplyDrafts(_loc, { contactId } = {}) { return drafts.filter((d) => !contactId || d.contactId === contactId); },
    async listOffers(_loc, { contactId } = {}) { return offers.filter((o) => !contactId || o.contactId === contactId); },
    async getOffer(id) { return offers.find((o) => o.id === id) || null; },
  };
};
const made = (hoursAgo, over = {}, data = {}) => ({
  id: `p${hoursAgo}`, contactId: "c1", type: "promise_made", at: at(hoursAgo), address: HOUSE, dedupeKey: `promise_made:d${hoursAgo}`,
  data: { what: "number", draftId: `d${hoursAgo}`, dueAt: at(hoursAgo - 4), text: "I'll run it by underwriting and get back to you with a number.", ...data }, ...over,
});
const priced = (over = {}) => ({ id: "o1", locationId: "LOC", contactId: "c1", address: HOUSE, status: "new", cashAmount: 410000, sends: [], createdAt: at(1), ...over });
const heldDraft = (over = {}) => ({ id: "h1", locationId: "LOC", contactId: "c1", address: HOUSE, status: "draft", cashAmount: null, askingPrice: 600000, createdAt: at(1), updatedAt: at(1), autoUnderwrite: { jobId: "j1", held: [THIN], finishedAt: at(1) }, ...over });
const inbound = (text, hoursAgo = 0.5) => ({ id: `in${hoursAgo}`, contactId: "c1", status: "sent", party: "agent", intent: "question", inbound: text, reply: "ok", propertyAddress: HOUSE, createdAt: at(hoursAgo) });

const spies = () => {
  const calls = { float: [], underwrite: [], proactive: [] };
  return { calls, deps: {
    floatOffer: async (a) => { calls.float.push(a); return { skipped: null, kind: "realm_check", job: { id: "jf" } }; },
    startUnderwrite: async (a) => { calls.underwrite.push(a); return { job: { id: "ju" } }; },
    startProactive: async (a) => { calls.proactive.push(a); return { skipped: null, job: { id: "jp" } }; },
    listUnderwriteJobs: () => [],
    getContact: async () => ({ tags: [], dnd: false }),
    searchOpportunities: async () => [],
  } };
};
const drive = (store, deps, over = {}) => driveOpenPromises({ locationId: "LOC", saved: saved(), store, sendsEnabled: true, deps, now: NOW, ...over });

test("with the switch off the driver does nothing at all", async () => {
  const store = fakeStore({ events: [made(5)], offers: [priced()] });
  const s = spies();
  const r = await drive(store, s.deps, { saved: saved(false) });
  assert.match(r.reason, /switched off/);
  assert.deepEqual(s.calls, { float: [], underwrite: [], proactive: [] });
  assert.equal(store.events.length, 1, "and claims nothing");
});

test("a number that landed after we promised it goes out, once", async () => {
  const store = fakeStore({ events: [made(5)], offers: [priced()] });
  const s = spies();
  const r = await drive(store, s.deps);
  assert.deepEqual(s.calls.float, [{ offerId: "o1" }]);
  assert.equal(r.results[0].move, "send_number");
  assert.equal(r.results[0].status, "started");
  await drive(store, s.deps, { now: NOW + 900000 });
  assert.equal(s.calls.float.length, 1, "the next tick finds it claimed");
});

test("a promise made minutes ago is left alone: the reply agent may be starting the underwrite itself", async () => {
  const store = fakeStore({ events: [made((DRIVER_GRACE_MIN - 10) / 60)] });
  const s = spies();
  const r = await drive(store, s.deps);
  assert.equal(s.calls.underwrite.length, 0);
  assert.equal(r.results[0].status, "waiting");
});

test("nothing ever ran on the house we promised a number for: the underwrite starts, queued if capped", async () => {
  const store = fakeStore({ events: [made(2)] });
  const s = spies();
  await drive(store, s.deps);
  assert.equal(s.calls.underwrite.length, 1);
  assert.equal(s.calls.underwrite[0].contactId, "c1");
  assert.equal(s.calls.underwrite[0].address, HOUSE);
});

test("a hold with a promise open asks the agent for their numbers right then, and never twice", async () => {
  const store = fakeStore({ events: [made(5)], offers: [heldDraft()], drafts: [inbound("any update?")] });
  const s = spies();
  const r = await drive(store, s.deps);
  assert.equal(r.results[0].move, "ask_numbers");
  assert.equal(s.calls.proactive.length, 1);
  assert.equal(s.calls.proactive[0].kind, "take_ask");
  assert.deepEqual(s.calls.proactive[0].subject.needs, ["value"]);
  await drive(store, s.deps, { now: NOW + 900000 });
  assert.equal(s.calls.proactive.length, 1, "asked once: the next tick waits on them");
  assert.ok(store.events.some((e) => e.type === "audit_action" && e.data?.kind === "held_ask"), "the same claim the nightly sweep makes, so it won't ask again either");
});

test("they gave us their value after the hold: it re-runs on their numbers, replacing the held draft", async () => {
  const est = { type: "agent_estimate", contactId: "c1", address: HOUSE, at: at(0.5), data: { arv: 850000 } };
  const store = fakeStore({ events: [made(5), est], offers: [heldDraft()], drafts: [inbound("I'd say 850 fixed up")] });
  const s = spies();
  const r = await drive(store, s.deps);
  assert.equal(r.results[0].move, "rerun");
  assert.equal(s.calls.underwrite.length, 1);
  assert.equal(s.calls.underwrite[0].replaceOfferId, "h1");
});

test("somebody who unsubscribed is never driven", async () => {
  const store = fakeStore({ events: [made(5), { type: "unsubscribed", contactId: "c1", at: at(1) }], offers: [priced()] });
  const s = spies();
  const r = await drive(store, s.deps);
  assert.deepEqual(s.calls.float, []);
  assert.equal(r.results[0].status, "stopped");
});

test("a promise we never owed, one that is waiting, and one that is yours are all left alone", async () => {
  const asked = made(5, {}, { text: "Got it. What did the seller say about the roof?", what: "answer" });
  const s = spies();
  await drive(fakeStore({ events: [asked] }), s.deps);
  await drive(fakeStore({ events: [made(5)] }), { ...s.deps, listUnderwriteJobs: () => [{ id: "j", contactId: "c1", status: "running" }] });
  await drive(fakeStore({ events: [made(5, { address: "" })] }), s.deps);
  assert.deepEqual(s.calls, { float: [], underwrite: [], proactive: [] });
});

test("`only` drives one contact: the hook a finishing underwrite uses", async () => {
  const other = made(5, { id: "px", contactId: "c2", dedupeKey: "promise_made:dx" });
  const store = fakeStore({ events: [made(5), other], offers: [priced(), priced({ id: "o2", contactId: "c2" })] });
  const s = spies();
  await drive(store, s.deps, { only: "c2" });
  assert.deepEqual(s.calls.float, [{ offerId: "o2" }]);
});

test("a move that throws is reported and does not stop the rest", async () => {
  const other = made(5, { id: "px", contactId: "c2", dedupeKey: "promise_made:dx" });
  const store = fakeStore({ events: [made(5), other], offers: [priced(), priced({ id: "o2", contactId: "c2" })] });
  const s = spies();
  let n = 0;
  s.deps.floatOffer = async (a) => { if (n++ === 0) throw new Error("GHL timed out"); s.calls.float.push(a); return { skipped: null, job: { id: "jf" } }; };
  const r = await drive(store, s.deps);
  assert.equal(r.results.filter((x) => x.status === "error").length, 1);
  assert.equal(s.calls.float.length, 1);
});
