// investor-sync.test.mjs — the nightly re-read of the buyer book.
//
// The Sync button was the only thing that refreshed the Dispositions list,
// and nobody pressed it for ten days. The nightly run is the backstop for
// what a conversation can't bring in: new buyers, tags added or removed in
// GHL, fields edited there by hand. It ships off.
//
//   node --test investor-sync.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { maybeRunBookSync, getBookSyncJob, _resetJobs, CURSOR_NAME, bookSyncSettings } from "./investor-sync.js";

// 2026-09-23 04:05 Pacific (PDT, UTC-7).
const AT_4AM = Date.UTC(2026, 8, 23, 11, 5);
const H = 3600000;
const on = { dispoAutopilot: { bookSync: { enabled: true } } };

function fakeStore() {
  const cursors = new Map();
  return {
    cursors,
    async getJobCursor(_loc, name) { return cursors.get(name) || null; },
    async setJobCursor(_loc, name, c) { cursors.set(name, c); },
    async recordAppError() {},
  };
}
const settle = () => new Promise((r) => setImmediate(r));
const syncing = (impl = async () => ({ synced: 3, removed: 0, truncated: false, warnings: [] })) => {
  const calls = [];
  return { calls, syncBook: async (a) => { calls.push(a); return impl(a); } };
};

test.beforeEach(() => _resetJobs());

test("the nightly sync is off unless it is switched on", async () => {
  assert.equal(bookSyncSettings({}).enabled, false);
  const deps = syncing();
  assert.equal(await maybeRunBookSync({ locationId: "LOC", saved: {}, store: fakeStore(), deps, now: AT_4AM }), false);
  assert.equal(deps.calls.length, 0);
});

test("switched on, the book is re-read once in its hour and the result is kept", async () => {
  const store = fakeStore();
  const deps = syncing();
  assert.equal(await maybeRunBookSync({ locationId: "LOC", saved: on, store, deps, now: AT_4AM - H }), false, "not before its hour");
  assert.equal(await maybeRunBookSync({ locationId: "LOC", saved: on, store, deps, now: AT_4AM }), true);
  await settle();
  assert.equal(deps.calls.length, 1);
  assert.equal(getBookSyncJob("LOC").status, "done");
  const doc = store.cursors.get(CURSOR_NAME).doc;
  assert.equal(doc.last.synced, 3);
  assert.equal(doc.run, undefined, "a finished run leaves the cursor");
  assert.equal(await maybeRunBookSync({ locationId: "LOC", saved: on, store, deps, now: AT_4AM + 30 * 60000 }), false, "never twice a night");
});

test("a sync that failed is tried again that night, up to three times", async () => {
  const store = fakeStore();
  const deps = syncing(async () => { throw new Error("GHL 502"); });
  let t = AT_4AM;
  assert.equal(await maybeRunBookSync({ locationId: "LOC", saved: on, store, deps, now: t }), true);
  await settle();
  assert.equal(store.cursors.get(CURSOR_NAME).doc.failed, true);
  assert.equal(await maybeRunBookSync({ locationId: "LOC", saved: on, store, deps, now: t + 5 * 60000 }), false, "not straight away");
  for (const n of [2, 3]) {
    t += 25 * 60000;
    assert.equal(await maybeRunBookSync({ locationId: "LOC", saved: on, store, deps, now: t }), true, `try ${n}`);
    await settle();
  }
  t += 25 * 60000;
  assert.equal(await maybeRunBookSync({ locationId: "LOC", saved: on, store, deps, now: t }), false, "the night's tries are capped");
  assert.equal(deps.calls.length, 3);
});

test("a run a redeploy killed is started again once it is stale", async () => {
  const store = fakeStore();
  // What a killed run leaves: the night claimed, a run on the cursor, no result.
  await store.setJobCursor("LOC", CURSOR_NAME, { at: new Date(AT_4AM).toISOString(), doc: { tries: 1, lastDaily: new Date(AT_4AM).toISOString(), run: { startedAt: new Date(AT_4AM).toISOString() } } });
  const deps = syncing();
  assert.equal(await maybeRunBookSync({ locationId: "LOC", saved: on, store, deps, now: AT_4AM + 30 * 60000 }), false, "might still be going");
  assert.equal(await maybeRunBookSync({ locationId: "LOC", saved: on, store, deps, now: AT_4AM + 90 * 60000 }), true);
});
