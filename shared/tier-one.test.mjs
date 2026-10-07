import { test } from "node:test";
import assert from "node:assert/strict";
import { passedOnHouse, isTierOneAction } from "./tier-one.js";

const NOW = Date.parse("2026-10-07T18:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const A = "4430 Sunnyside Blvd, Marysville, WA 98270";

test("a house is passed when its newest offer says we passed or it's gone, not when a newer one is open", () => {
  assert.equal(passedOnHouse({ offers: [{ address: A, status: "we_passed", updatedAt: ago(2) }], address: "4430 Sunnyside Blvd" })?.why, "we passed on this house");
  assert.equal(passedOnHouse({ offers: [{ address: A, status: "unavailable", updatedAt: ago(2) }], address: A })?.why, "no longer available");
  assert.equal(passedOnHouse({ offers: [{ address: A, status: "we_passed", updatedAt: ago(9) }, { address: A, status: "sent", updatedAt: ago(1) }], address: A }), null);
  assert.equal(passedOnHouse({ offers: [{ address: A, status: "passed", updatedAt: ago(2) }], address: A }), null, "they passed is not us passing");
  assert.equal(passedOnHouse({ offers: [{ address: "12 Elm St, Kent, WA", status: "we_passed" }], address: A }), null, "another house");
});

test("a pass from the Tier 1 list counts with no offer row, until the house is added back", () => {
  const passed = { type: "tier1_passed", address: A, at: ago(3) };
  assert.ok(passedOnHouse({ events: [passed], address: A }));
  assert.ok(passedOnHouse({ events: [{ ...passed, type: "tier1_kicked" }], address: A }));
  assert.equal(passedOnHouse({ events: [passed, { type: "tier1_added", address: A, at: ago(1) }], address: A }), null);
  assert.equal(passedOnHouse({ events: [passed], address: "" }), null);
});

test("the tier-1 rule's actions are the tag, the TIER 1 workflow and the lower tiers it leaves", () => {
  assert.equal(isTierOneAction({ type: "add_tags", tags: ["tier-1"] }), true);
  assert.equal(isTierOneAction({ type: "remove_tags", tags: ["tier-2", "tier-3"] }), true);
  assert.equal(isTierOneAction({ type: "add_to_workflow", workflowName: "TIER 1" }), true);
  assert.equal(isTierOneAction({ type: "remove_from_workflow", workflowName: "Tier 2 nurture" }), true);
  assert.equal(isTierOneAction({ type: "add_tags", tags: ["tier-2"] }), false);
  assert.equal(isTierOneAction({ type: "start_underwrite" }), false);
  assert.equal(isTierOneAction({ type: "remove_tags", tags: ["tier-1"] }), false);
});
