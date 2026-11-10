// daily-gate.test.mjs — once a day, and back the same day when a deploy
// killed the run. Every push to main redeploys the broker.

import test from "node:test";
import assert from "node:assert/strict";
import { claimDailyRun, closeDailyRun, STALE_RUN_MS, RETRY_GAP_MS, MAX_DAILY_TRIES } from "./daily-gate.js";

const memStore = () => {
  const cursors = new Map();
  return { cursors, async getJobCursor(l, n) { return cursors.get(`${l}|${n}`) || null; }, async setJobCursor(l, n, v) { cursors.set(`${l}|${n}`, v); return v; } };
};
const T = Date.parse("2026-09-29T16:05:00Z");
const MIN = 60000;
const gate = (store, over = {}) => claimDailyRun({ store, locationId: "L", cursorName: "job", now: T, hourNow: 16, startHour: 16, windowHours: 3, ...over });

test("a new day starts inside its window, not before or after", async () => {
  assert.equal((await gate(memStore(), { hourNow: 15 })).go, false);
  assert.equal((await gate(memStore(), { hourNow: 19 })).go, false);
  assert.equal((await gate(memStore(), { hourNow: 17 })).go, true, "a boot that missed the first hour still gets the day");
});

test("a finished day never runs twice", async () => {
  const store = memStore();
  assert.equal((await gate(store)).go, true);
  await closeDailyRun({ store, locationId: "L", cursorName: "job", last: { done: true } });
  assert.equal((await gate(store, { now: T + 2 * 3600000, hourNow: 18 })).go, false);
  assert.deepEqual(store.cursors.get("L|job").doc.last, { done: true });
});

test("a run a deploy killed comes back once it's stale, not tomorrow", async () => {
  const store = memStore();
  assert.equal((await gate(store)).go, true);   // claimed, then the process died: nothing closes it
  assert.equal((await gate(store, { now: T + 30 * MIN })).go, false, "it might still be going");
  const r = await gate(store, { now: T + STALE_RUN_MS + MIN, hourNow: 16 });
  assert.equal(r.go, true);
  assert.equal(r.tries, 2);
  assert.ok(store.cursors.get("L|job").doc.staleRun, "the dead run is kept on the cursor for the record");
  assert.equal((await gate(store, { now: T + STALE_RUN_MS + 2 * MIN, running: true })).go, false, "never while it runs here");
});

test("a failed day retries at most four times, twenty minutes apart", async () => {
  const store = memStore();
  let now = T;
  assert.equal((await gate(store, { now })).tries, 1);
  let started = 1;
  for (let i = 0; i < 10; i++) {
    await closeDailyRun({ store, locationId: "L", cursorName: "job", failed: true, error: "boom" });
    assert.equal((await gate(store, { now: now + RETRY_GAP_MS - MIN, hourNow: 16 })).go, false, "not inside the gap");
    now += RETRY_GAP_MS + MIN;
    const r = await gate(store, { now, hourNow: 16 + Math.floor((now - T) / 3600000) });
    if (!r.go) break;
    started++;
  }
  assert.equal(started, MAX_DAILY_TRIES);
});

// 2026-11-09 audit: "ran today" was "under 20 hours ago", so a run retried
// late in a long window (the tier check's runs 7am to 8pm) pushed the next
// day's start into the afternoon, or past the window altogether.
test("a retry late in the window doesn't cost tomorrow's run", async () => {
  const store = memStore();
  const evening = Date.parse("2026-11-09T03:30:00Z");   // Sunday 7:30pm Pacific
  await store.setJobCursor("L", "job", { at: new Date(evening).toISOString(), doc: { lastDaily: new Date(evening).toISOString(), tries: 3, last: { done: true } } });
  const morning = Date.parse("2026-11-09T15:05:00Z");   // Monday 7:05am Pacific, under 12 hours later
  const r = await gate(store, { now: morning, hourNow: 7, startHour: 7, windowHours: 13 });
  assert.equal(r.go, true);
  assert.equal(r.tries, 1, "a new day, not a retry");
  await closeDailyRun({ store, locationId: "L", cursorName: "job", last: { done: true } });
  assert.equal((await gate(store, { now: morning + 3 * 3600000, hourNow: 10, startHour: 7, windowHours: 13 })).go, false, "and only once");
});

// A job on the UTC clock whose window runs over midnight Pacific is still one run.
test("a window that runs over midnight Pacific runs once", async () => {
  const store = memStore();
  const late = Date.parse("2026-11-10T07:05:00Z");      // 11:05pm Pacific Monday, hour 7 UTC
  assert.equal((await gate(store, { now: late, hourNow: 7, startHour: 7, windowHours: 3 })).go, true);
  await closeDailyRun({ store, locationId: "L", cursorName: "job", last: { done: true } });
  assert.equal((await gate(store, { now: late + 2 * 3600000, hourNow: 9, startHour: 7, windowHours: 3 })).go, false, "1:05am Pacific Tuesday is the same run");
});

test("a cursor written before the gate counts as today's run", async () => {
  const store = memStore();
  await store.setJobCursor("L", "job", { at: new Date(T - 10 * MIN).toISOString(), doc: {} });
  assert.equal((await gate(store)).go, false, "the first deploy doesn't re-run a day that already ran");
});
