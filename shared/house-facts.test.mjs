// house-facts.test.mjs — what the listing's own words say, read the way
// buyers read them in the 2026-10-02 threads.

import test from "node:test";
import assert from "node:assert/strict";
import { remarkSignals, normalizeHouse, garageOf } from "./house-facts.js";

test("a listing selling a project reads as distressed; a remodel never does", () => {
  assert.equal(remarkSignals("Sold strictly AS-IS. Bring your contractor — needs TLC throughout.").distressed, true);
  assert.equal(remarkSignals("Contractor special on a big lot, cash or rehab loan only").distressed, true);
  assert.equal(remarkSignals("Fully remodeled, move-in ready. Sold as-is with no repairs by seller.").distressed, false, "turnkey wins");
  assert.equal(remarkSignals("Charming 1950s rambler with a big yard").distressed, false);
});

test("the defects a buyer will price are named, each once", () => {
  const s = remarkSignals("Water damage in the hall bath, roof is at end of life, prior fire in the garage, some settling noted.");
  assert.deepEqual(s.defects.map((d) => d.key).sort(), ["fire", "foundation", "roof", "water_damage"]);
});

test("Ravenna's low ceilings, a carved-up layout and a tuck-under garage are layout facts", () => {
  const s = remarkSignals("Lower level has low ceilings. Converted into multiple rooms for UW students. Partial tuck-under garage.");
  assert.deepEqual(s.layout.map((l) => l.key).sort(), ["converted_rooms", "low_ceiling", "tuck_under"]);
});

test("title, permit and utility words are legal flags, not costs", () => {
  const s = remarkSignals("Shared driveway easement. ADU is unpermitted. On septic. HOA dues $40/mo.");
  assert.deepEqual(s.legal.map((l) => l.key).sort(), ["easement", "hoa", "septic", "unpermitted"]);
});

test("work the listing says is done is work a buyer won't budget twice", () => {
  const s = remarkSignals("Rewired in 2019, repiped with PEX throughout, new roof 2021.");
  assert.deepEqual(s.updated, { electrical: true, plumbing: true, roof: true });
  assert.deepEqual(remarkSignals("Original 1941 charm").updated, { electrical: false, plumbing: false, roof: false });
});

test("belongings left behind read as a cleanout", () => {
  assert.equal(remarkSignals("Estate sale — contents to be left with the house").contents, true);
  assert.equal(remarkSignals("Vacant and broom clean").contents, false);
});

test("house facts are unknown until the record says so — no garage means the record said no", () => {
  assert.equal(garageOf({}), null);
  assert.equal(garageOf({ garageSpaces: 0 }), false);
  assert.equal(garageOf({ garageSpaces: 2 }), true);
  assert.equal(garageOf({ hasGarage: false, garageSpaces: 2 }), false, "an explicit answer wins");
  const h = normalizeHouse({ aboveGradeSqft: "1,340 sqft", sewer: "septic", daysOnMarket: 64, priceCuts: 2 });
  assert.equal(h.aboveGradeSqft, 1340);
  assert.equal(h.sewer, "septic");
  assert.equal(h.daysOnMarket, 64);
  assert.equal(h.priceCuts, 2);
  assert.equal(normalizeHouse({ sewer: "maybe" }).sewer, null);
});
