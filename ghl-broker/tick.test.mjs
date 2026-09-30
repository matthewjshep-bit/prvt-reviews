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
