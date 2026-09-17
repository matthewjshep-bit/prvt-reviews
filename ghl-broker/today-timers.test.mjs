// today-timers.test.mjs — rows the machine clears by itself after a wait.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runTodayTimers } from "./today-timers.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";

const NOW = Date.parse("2026-09-17T18:05:00Z");
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const saved = (on = true) => ({ aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true, driver: { timers: { enabled: on } } }) });
const ready = (over = {}) => ({ id: "o1", contactId: "c1", contactName: "Sarah", address: "12 Elm St, Renton, WA", cashAmount: 265000, status: "new", sends: [], createdAt: ago(6), autoUnderwrite: { jobId: "j1", held: [], finishedAt: ago(6) }, ...over });
const quiet = (over = {}) => ({ id: "o2", contactId: "c2", address: "44 Pine St, Kent, WA", cashAmount: 300000, status: "sent", statusAt: ago(40 * 24), createdAt: ago(41 * 24), sends: [{ ts: ago(40 * 24) }], ...over });

const fakeStore = ({ offers = [], drafts = [], events = [] } = {}) => {
  const rows = [...events];
  return {
    events: rows,
    async listOffers() { return offers; },
    async listReplyDrafts(_l, { contactId = null, status = null } = {}) { return drafts.filter((d) => (!contactId || d.contactId === contactId) && (!status || (Array.isArray(status) ? status.includes(d.status) : d.status === status))); },
    async listContactEventsSince(_l, since, { types = null } = {}) { return rows.filter((e) => e.at >= since && (!types || types.includes(e.type))); },
    async listContactEvents(_l, contactId) { return rows.filter((e) => e.contactId === contactId); },
    async appendContactEvents(_l, contactId, add) {
      let inserted = 0;
      for (const r of add) { if (r.dedupeKey && rows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue; rows.push({ ...r, contactId }); inserted++; }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
  };
};
const spies = () => {
  const calls = { float: [], status: [], underwrite: [] };
  return { calls, deps: {
    floatOffer: async (a) => { calls.float.push(a); return { skipped: null, job: { id: "jf" } }; },
    setOfferStatus: async (a) => { calls.status.push(a); return { ok: true }; },
    startUnderwrite: async (a) => { calls.underwrite.push(a); return { job: { id: "ju" } }; },
    listUnderwriteJobs: () => [],
  } };
};
const run = (store, deps, over = {}) => runTodayTimers({ locationId: "LOC", saved: saved(), store, deps, now: NOW, ...over });

test("with the timers off nothing is touched", async () => {
  const s = spies();
  const r = await run(fakeStore({ offers: [ready(), quiet()] }), s.deps, { saved: saved(false) });
  assert.match(r.reason, /switched off/);
  assert.deepEqual(s.calls, { float: [], status: [], underwrite: [] });
});

test("a priced offer nobody floated is floated once it has waited its hours, and never twice", async () => {
  const store = fakeStore({ offers: [ready()] });
  const s = spies();
  const r = await run(store, s.deps);
  assert.deepEqual(s.calls.float, [{ offerId: "o1" }]);
  assert.equal(r.results[0].status, "started");
  await run(store, s.deps, { now: NOW + 2 * 3600000 });
  assert.equal(s.calls.float.length, 1, "claimed: the next pass leaves it");
});

test("one that has not waited yet is left, and said so", async () => {
  const s = spies();
  const r = await run(fakeStore({ offers: [ready({ createdAt: ago(1), autoUnderwrite: { jobId: "j1", held: [], finishedAt: ago(1) } })] }), s.deps);
  assert.deepEqual(s.calls.float, []);
  assert.equal(r.results[0].status, "waiting");
});

test("an offer gone quiet is marked no response through the same door a person's button uses", async () => {
  const s = spies();
  await run(fakeStore({ offers: [quiet()] }), s.deps);
  assert.equal(s.calls.status.length, 1);
  assert.equal(s.calls.status[0].contactId, "c2");
  assert.equal(s.calls.status[0].status, "no_response");
  assert.match(s.calls.status[0].note, /quiet/);
});

test("a failed underwrite is retried once when the failure was the network's", async () => {
  const job = { id: "j9", contactId: "c3", status: "error", address: "9 Oak St, Kent, WA", error: "stopped early — the comps provider timed out", finishedAt: ago(0.2), offerId: "d9" };
  const store = fakeStore();
  const s = spies();
  s.deps.listUnderwriteJobs = () => [job];
  await run(store, s.deps);
  await run(store, s.deps, { now: NOW + 600000 });
  assert.equal(s.calls.underwrite.length, 1);
  assert.equal(s.calls.underwrite[0].replaceOfferId, "d9");
});

test("a thread the brake stopped gets no float, but is still marked quiet: that ends a thread, it doesn't push one", async () => {
  const cross = { id: "x", contactId: "c1", status: "superseded", party: "agent", intent: "question", inbound: "please stop texting me", reply: "", createdAt: ago(3) };
  const s = spies();
  const r = await run(fakeStore({ offers: [ready(), quiet()], drafts: [cross] }), s.deps);
  assert.deepEqual(s.calls.float, []);
  assert.equal(r.results.find((x) => x.move === "float").status, "stopped");
  assert.equal(s.calls.status.length, 1);
});

test("no timer reads or writes an env switch", () => {
  const src = readFileSync(new URL("./today-timers.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /process\.env/);
});
