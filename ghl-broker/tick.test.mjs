// tick.test.mjs — every job on the 15-minute tick fails on its own.

import test from "node:test";
import assert from "node:assert/strict";
import { runLocationTick } from "./tick.js";

test("one job that throws doesn't stop the jobs after it that tick", async () => {
  const ran = [];
  const errors = [];
  const jobs = [
    { area: "first", run: async () => { ran.push("first"); } },
    { area: "broken", run: async () => { throw new Error("settings blob was malformed"); } },
    { area: "last", run: async () => { ran.push("last"); } },
  ];
  const r = await runLocationTick({ locationId: "L" }, jobs, { store: {}, log: () => {}, recordError: async (_s, e) => { errors.push(e.area); } });
  assert.deepEqual(ran, ["first", "last"]);
  assert.deepEqual(r.failed, ["broken"]);
  assert.deepEqual(errors, ["tick:broken"], "recorded under its own area");
});

test("a job's rejected promise is caught and recorded, not an unhandled rejection", async () => {
  const errors = [];
  const jobs = [{ area: "enrich", run: () => Promise.reject(new Error("model timed out")) }];
  const r = await runLocationTick({ locationId: "L" }, jobs, { log: () => {}, recordError: async (_s, e) => { errors.push(e.area); } });
  assert.deepEqual(r.failed, ["enrich"]);
  assert.deepEqual(errors, ["tick:enrich"]);
});

// 2026-11-09 audit: the tick logged a job's error text whole, and GHL's error
// text carries the lookup it made, email and all.
test("a failing job's log line carries no email or phone", async () => {
  const logged = [];
  const jobs = [{ area: "outreach", run: async () => { throw new Error("GHL GET /contacts/search/duplicate?email=lee.fake%40example.com: 400 for lee.fake@example.com at +1 206 555 0177"); } }];
  await runLocationTick({ locationId: "L" }, jobs, { log: (s) => logged.push(s) });
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0], /lee\.fake|example\.com|555 0177|%40/, logged[0]);
  assert.match(logged[0], /^tick:outreach failed for L: GHL GET \/contacts\/search\/duplicate: 400 for <email> at <phone>$/);
});
