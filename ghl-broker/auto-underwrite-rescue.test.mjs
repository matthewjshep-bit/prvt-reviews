// auto-underwrite-rescue.test.mjs — pricing on the agent's numbers when ours are stuck.

import test from "node:test";
import assert from "node:assert/strict";
import { agentNumbersRescue, evaluateGates, UW_MIN_SUBJECT_PHOTOS, UW_MIN_PHOTOS_DESCRIBED } from "./auto-underwrite.js";

const THIN = [
  "only 0 priced comps — the price proxy needs 6 to have a top tier — not enough nearby sales to tell renovated from tired by price",
  "1 sold home in the search box, 0 of them inside 1.5 mi and within the bed/bath/size bands",
  "no ARV could be derived from the comps",
];

test("thin comps plus the agent's value: priced on their value, held near the list price", () => {
  const r = agentNumbersRescue({ held: THIN, theirArv: 1800000, listPrice: 1200000, repairs: 90000 });
  assert.ok(r, "rescued");
  assert.equal(r.value, 1500000, "125% of the 1.2M list, not their 1.8M");
  assert.equal(r.capped, true);
  assert.equal(r.fix, 90000, "our own scope stands when the repairs weren't the problem");
  assert.match(r.basis, /agent's numbers/);
});

test("no list price to cap their value against: still holds", () => {
  assert.equal(agentNumbersRescue({ held: THIN, theirArv: 900000, listPrice: 0, repairs: 50000 }), null);
});

test("thin comps and no value from the agent: still holds", () => {
  assert.equal(agentNumbersRescue({ held: THIN, theirRehab: 60000, listPrice: 700000, repairs: 50000 }), null);
});

test("a scope past the band with their repairs: their figure, but never cutting ours by more than a quarter", () => {
  const held = ["the scope totals $246,000, past the heavy band for 1,500–2,000 sqft ($110,000)"];
  const r = agentNumbersRescue({ held, theirRehab: 60000, ourArv: 900000, repairs: 246000, listPrice: 800000, sqft: 0 });
  assert.ok(r);
  assert.equal(r.value, 900000, "our ARV stands when the comps were fine");
  assert.equal(r.fix, 184500, "246k cut by a quarter, not down to their 60k");
});

test("their repairs still past the band for the size: holds", () => {
  const held = ["the scope totals $160,500, past the heavy band for under 1,000 sqft ($70,000)"];
  assert.equal(agentNumbersRescue({ held, theirRehab: 150000, ourArv: 400000, repairs: 160500, listPrice: 380000, sqft: 900 }), null);
});

test("a hold the agent's numbers don't answer — an unsure address, a structural flag — is never waved through", () => {
  assert.equal(agentNumbersRescue({ held: [...THIN, 'the address was read with medium confidence — "2903 East Union"'], theirArv: 900000, listPrice: 800000 }), null);
  assert.equal(agentNumbersRescue({ held: ["the photo scan flagged a possible foundation or structural problem"], theirRehab: 40000, ourArv: 500000, listPrice: 450000 }), null);
});

test("the agent describing the work lowers the photo bar from 8 to 4", () => {
  const base = { extraction: { address: "1 A St, Seattle, WA", confidence: "high" }, subject: { lat: 1, lng: 1, sqft: 1500 }, photosAnalyzed: 5 };
  const photoHold = (g) => g.held.find((h) => /listing photos? to scan/.test(h));
  assert.match(photoHold(evaluateGates(base)), new RegExp(`${UW_MIN_SUBJECT_PHOTOS} required`));
  assert.equal(photoHold(evaluateGates({ ...base, describedWork: true })), undefined);
  assert.match(photoHold(evaluateGates({ ...base, describedWork: true, photosAnalyzed: 2 })), new RegExp(`${UW_MIN_PHOTOS_DESCRIBED} required`));
});
