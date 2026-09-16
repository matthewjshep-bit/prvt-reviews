// auto-underwrite-queue.test.mjs — an address past the daily cap waits in
// line and starts when the cap resets, instead of being dropped.

import test from "node:test";
import assert from "node:assert/strict";
import { startUnderwrite, drainUnderwriteQueue, QUEUE_CURSOR } from "./auto-underwrite.js";

const TODAY = new Date().toISOString();
const saved = { aiApiKey: "k", apifyToken: "t", autoUnderwriteDailyCap: 2 };

// `used` offers already underwritten today; job cursors in memory.
const fakeStore = (used) => {
  const cursors = new Map();
  return {
    cursors,
    usedToday: used,
    async listOffers() { return Array.from({ length: this.usedToday }, (_, i) => ({ id: `o${i}`, createdAt: TODAY, autoUnderwrite: { jobId: `uw-old-${i}`, startedAt: TODAY } })); },
    async getJobCursor(loc, name) { return cursors.get(`${loc}|${name}`) || null; },
    async setJobCursor(loc, name, v) { cursors.set(`${loc}|${name}`, v); return v; },
  };
};
const queue = (store) => store.cursors.get(`LOC|${QUEUE_CURSOR}`)?.doc?.items || [];

test("past the cap, the conversation's underwrite is queued once per house, not dropped", async () => {
  const store = fakeStore(2);
  const args = { client: {}, locationId: "LOC", saved, store, contactId: "c1", message: "12 Elm St needs work", address: "12 Elm St, Seattle, WA", dryRun: true, deps: {} };
  const r = await startUnderwrite({ ...args, queueIfCapped: true });
  assert.equal(r.queued, true);
  assert.equal(r.position, 1);
  assert.match(r.reason, /daily cap reached \(2\/2\)/);
  const again = await startUnderwrite({ ...args, queueIfCapped: true, message: "any update on 12 Elm St?" });
  assert.equal(again.position, 1, "the same house is not queued twice");
  assert.equal(queue(store).length, 1);

  // a GHL workflow call (no queueIfCapped) is still refused as before
  const plain = await startUnderwrite(args);
  assert.match(plain.skipped, /daily cap reached/);
});

test("the tick starts queued underwrites while the cap has room, oldest first, and keeps the rest waiting", async () => {
  const store = fakeStore(2);
  const now = Date.now();
  await store.setJobCursor("LOC", QUEUE_CURSOR, { at: TODAY, doc: { items: [
    { contactId: "c1", address: "1 A St", message: "", at: new Date(now - 3600000).toISOString() },
    { contactId: "c2", address: "2 B St", message: "", at: new Date(now - 1800000).toISOString() },
    { contactId: "c3", address: "3 C St", message: "", at: new Date(now - 5 * 86400000).toISOString() }, // too old
  ] } });

  // still capped: nothing starts, the stale one is dropped
  const started = [];
  const start = async (item) => { started.push(item.contactId); return { job: { id: "uw" } }; };
  let r = await drainUnderwriteQueue({ store, locationId: "LOC", saved, start, now });
  assert.deepEqual(started, []);
  assert.equal(r.dropped, 1);
  assert.equal(queue(store).length, 2);

  // the cap resets with room for one
  store.usedToday = 1;
  r = await drainUnderwriteQueue({ store, locationId: "LOC", saved, start, now });
  assert.deepEqual(started, ["c1"]);
  assert.deepEqual(queue(store).map((i) => i.contactId), ["c2"]);

  // a refusal that waiting won't fix drops it
  store.usedToday = 0;
  r = await drainUnderwriteQueue({ store, locationId: "LOC", saved, start: async () => ({ skipped: "no address found" }), now });
  assert.equal(r.dropped, 1);
  assert.equal(queue(store).length, 0);
});

// Colin Foote, 2026-09-15: 811 NE 66th and 15605 NE 1st queued behind the
// cap; when it lifted, the first started and the second was asked a second
// later, while that run was in flight — startUnderwrite's per-contact guard
// answered `deduped`, the drain counted it as started, and the Bellevue flip
// left the line without ever being priced.
test("two houses from the same agent start a tick apart, and a deduped start stays in line", async () => {
  const store = fakeStore(0);
  const now = Date.now();
  await store.setJobCursor("LOC", QUEUE_CURSOR, { at: TODAY, doc: { items: [
    { contactId: "c1", address: "811 NE 66th St", message: "", at: new Date(now - 7200000).toISOString() },
    { contactId: "c1", address: "15605 NE 1st St", message: "", at: new Date(now - 3600000).toISOString() },
    { contactId: "c2", address: "2 B St", message: "", at: new Date(now - 1800000).toISOString() },
  ] } });
  const started = [];
  const start = async (item) => { started.push(item.address); return { job: { id: `uw-${started.length}` } }; };
  let r = await drainUnderwriteQueue({ store, locationId: "LOC", saved: { ...saved, autoUnderwriteDailyCap: 0 }, start, now });
  assert.deepEqual(started, ["811 NE 66th St", "2 B St"], "one house per agent per pass; the other agent's still goes");
  assert.equal(r.left, 1);
  assert.deepEqual(queue(store).map((i) => i.address), ["15605 NE 1st St"], "the second house waits for the next tick");

  // Next tick, the first run is still in flight: startUnderwrite says so.
  const deduped = async () => ({ deduped: true, job: { id: "uw-1" } });
  r = await drainUnderwriteQueue({ store, locationId: "LOC", saved: { ...saved, autoUnderwriteDailyCap: 0 }, start: deduped, now: now + 900000 });
  assert.equal(r.started, 0, "a deduped answer is not a start");
  assert.deepEqual(queue(store).map((i) => i.address), ["15605 NE 1st St"], "and it stays in line");

  // The tick after that, it runs.
  r = await drainUnderwriteQueue({ store, locationId: "LOC", saved: { ...saved, autoUnderwriteDailyCap: 0 }, start, now: now + 1800000 });
  assert.equal(r.started, 1);
  assert.deepEqual(queue(store), []);
});
