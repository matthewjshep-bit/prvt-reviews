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
