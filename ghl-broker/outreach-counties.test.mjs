import test from "node:test";
import assert from "node:assert/strict";
import { countiesFrom, normalizeOutreachAutopilot } from "./outreach-sweep.js";

test("counties typed without a state default to Washington instead of vanishing", () => {
  assert.deepEqual(countiesFrom("King \nPierce\nSnohomish"), [
    { county: "King", state: "WA" }, { county: "Pierce", state: "WA" }, { county: "Snohomish", state: "WA" },
  ]);
  assert.equal(normalizeOutreachAutopilot({ counties: "King \nPierce\nSnohomish" }).counties.length, 3);
});

test("an explicit state still wins, and 'County' is dropped", () => {
  assert.deepEqual(countiesFrom("Multnomah County, or\nKing, WA"), [
    { county: "Multnomah", state: "OR" }, { county: "King", state: "WA" },
  ]);
});

test("a bad state is still refused, and blank lines are ignored", () => {
  assert.deepEqual(countiesFrom("King, Washington\n\n"), []);
});

import { autopilotBatchId } from "./outreach-sweep.js";

test("a county with no state that isn't a Washington county is still dropped", () => {
  assert.deepEqual(countiesFrom("King\nNowhere"), [{ county: "King", state: "WA" }]);
});

test("the autopilot keeps its own batch per market, found by name or created once", async () => {
  const batches = [{ id: "spokane", name: "Spokane County, WA · Sep 3" }];
  const store = {
    async listOutreachBatches() { return batches; },
    async createOutreachBatch(_loc, { name, autoNamed }) { const b = { id: `b${batches.length}`, name, autoNamed }; batches.push(b); return b; },
  };
  const first = await autopilotBatchId({ store, locationId: "LOC", market: "King, WA" });
  assert.notEqual(first, "spokane", "never the most recent hand-made batch");
  assert.equal(batches.find((b) => b.id === first).name, "Autopilot · King, WA");
  assert.equal(batches.find((b) => b.id === first).autoNamed, false);
  assert.equal(await autopilotBatchId({ store, locationId: "LOC", market: "King, WA" }), first, "the same batch next run");
  assert.notEqual(await autopilotBatchId({ store, locationId: "LOC", market: "Pierce, WA" }), first);
});

test("a store without batches leaves the pull to pick its own", async () => {
  assert.equal(await autopilotBatchId({ store: {}, locationId: "LOC", market: "King, WA" }), undefined);
});
