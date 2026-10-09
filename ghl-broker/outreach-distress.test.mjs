import test from "node:test";
import assert from "node:assert/strict";
import { distressSignals, OLD_HOUSE_YEAR } from "./outreach-score.js";
import { pickAgentsToImport, SWEEP_DISTRESS_RULE, pullQuery, normalizeOutreachAutopilot } from "./outreach-sweep.js";

// The 2-week review: the sweep texted agents about finished houses in slow
// towns, because a cheap $/sqft counted as distress. Real distress is a
// price cut or an older house.

const listing = (o = {}) => ({ price: 300000, squareFootage: 2000, daysOnMarket: 90, history: {}, ...o });
const cutHistory = { "2026-07-01": { event: "Sale Listing", price: 340000 } };

test("a cheap but finished 2015 house with no price cut isn't distress", () => {
  const sig = distressSignals(listing({ yearBuilt: 2015 }), { medianPpsf: 400 });
  assert.equal(sig.cheap, true, "it is cheap for the market");
  assert.equal(sig.old, false);
  assert.equal(sig.cut || sig.old, false);
  assert.equal(SWEEP_DISTRESS_RULE, "cut-or-old");
  assert.equal(pullQuery(normalizeOutreachAutopilot({})).distressRule, "cut-or-old");
});

test("a 1962 house with no price cut is distress", () => {
  const sig = distressSignals(listing({ yearBuilt: 1962 }), { medianPpsf: 100 });
  assert.equal(OLD_HOUSE_YEAR, 1980);
  assert.equal(sig.cut, false);
  assert.equal(sig.old, true);
  assert.equal(distressSignals(listing({}), { medianPpsf: 100 }).old, false, "year unknown isn't old");
});

test("a price cut counts whatever the year", () => {
  const sig = distressSignals(listing({ yearBuilt: 2019, history: cutHistory }), { medianPpsf: 100 });
  assert.equal(sig.cut, true);
  assert.equal(sig.old, false);
});

const phoneOf = (k) => `206555${String([...k].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7)).padStart(4, "0")}`;
const row = (k, hook = {}, doc = {}) => ({ agentKey: k, status: "new", contactId: null,
  doc: { name: k, phone: phoneOf(k), distressedCount: 1, distressRule: "cut-or-old", listingCount: 1,
    hook: { address: `${k} St`, score: 50, price: 400000, ...hook }, ghl: {}, ...doc } });

test("an older pull's 2012 hook isn't imported once the year cap is 1999", () => {
  const rows = [
    row("new-build", { yearBuilt: 2012, priceCut: true }),
    row("old", { yearBuilt: 1955 }),
    row("cut-unknown-year", { priceCut: true }),
  ];
  const opts = { cap: 10, distressRule: "cut-or-old", maxYearBuilt: 1999 };
  assert.deepEqual(pickAgentsToImport(rows, opts).map((r) => r.agentKey).sort(), ["cut-unknown-year", "old"]);
  assert.equal(pickAgentsToImport(rows, { ...opts, maxYearBuilt: 0 }).length, 3, "no cap, no year check");
});

test("an agent stored under the old rule whose hook was cut still gets imported", () => {
  const legacy = { distressRule: "cut-or-cheap" };
  const rows = [
    row("cut", { yearBuilt: 2010, priceCut: true }, legacy),
    row("old", { yearBuilt: 1948 }, legacy),
    row("cheap-only", { yearBuilt: 2015, priceCut: false }, legacy),   // finished house, slow town
    row("cheap-unknown", { priceCut: false }, legacy),
  ];
  assert.deepEqual(pickAgentsToImport(rows, { cap: 10, distressRule: "cut-or-old" }).map((r) => r.agentKey).sort(), ["cut", "old"]);
});
