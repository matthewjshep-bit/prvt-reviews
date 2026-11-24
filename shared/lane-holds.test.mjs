// lane-holds.test.mjs — the two replies to an agent that wait for Matt
// (2026-11-23 audit: R7 / neg-8, R11). Every street, name and word here is
// invented.

import test from "node:test";
import assert from "node:assert/strict";
import { declinesLane, offersLane, laneHoldFlags, LANE_HOLD_FLAG, closesOut, namesTheHouse, closeOutFlags } from "./lane-holds.js";
import { QUALIFY_PASSES, QUALIFY_CLOSED } from "./flip-read.js";

test("a reply that says land isn't our lane is held for Matt", () => {
  for (const reply of [
    "That's outside our lane, we're not land development. Got anything that needs work?",
    "Appreciate it, but lots aren't really what we do.",
    "We don't do teardowns, but send me any fixers.",
    "Not really my lane on a duplex, thanks though.",
    "We only buy single-family, so I'll pass on this one.",
    "We're not developers, so that one's not for us.",
  ]) {
    assert.ok(declinesLane(reply), reply);
    assert.deepEqual(laneHoldFlags({ reply, inbound: "" }), [LANE_HOLD_FLAG], reply);
  }
});

test("a reply that only talks about work, a lot of it, isn't a lane decline", () => {
  for (const reply of [
    "Not a lot of work there from the sound of it. What's the seller hoping to get?",
    "Got it, let me look at where we'd land on it.",
    "Thanks, what's the lot size on that one?",
  ]) {
    assert.equal(declinesLane(reply), "", reply);
    assert.deepEqual(laneHoldFlags({ reply, inbound: "" }), [], reply);
  }
});

test("an agent who offers land, a teardown or a duplex and gets our pass has the pass held", () => {
  const pass = "Thanks, sounds too clean for me. Got anything rougher on your end?";
  for (const inbound of [
    "I have a buildable lot in Bellevue the owner wants to sell quietly.",
    "It's basically a teardown, land value only.",
    "Owner has a duplex in Kent, both units need work.",
    "Two lots next to each other, zoned for townhomes.",
    "Great development site, LR2 zoning.",
  ]) {
    assert.ok(offersLane(inbound), inbound);
    assert.deepEqual(laneHoldFlags({ reply: pass, inbound }), [LANE_HOLD_FLAG], inbound);
  }
  // A house on a third of an acre is a house.
  assert.equal(offersLane("3 bed 2 bath on 0.3 acres, needs a roof"), "");
  assert.equal(offersLane("Where would you land on it?"), "");
  // Our question on their land is not a pass.
  assert.deepEqual(laneHoldFlags({ reply: "What's the owner hoping to get for it?", inbound: "I have a vacant lot in Kent" }), []);
});

test("every canned pass and close reads as a close-out", () => {
  for (const reply of [...QUALIFY_PASSES, ...QUALIFY_CLOSED, "Appreciate it. Keep me in mind if anything rougher comes up."]) {
    assert.ok(closesOut(reply), reply);
  }
  assert.equal(closesOut("Got it. What's the address on that one?"), "");
});

test("an agent who sends a house, a link, a price or the work it needs doesn't get the canned close-out", () => {
  const reply = "Sounds lighter than what we usually go for. Any fixers on your radar, listed or off-market?";
  const cases = [
    ["Here's another one, 4410 Juniper Pl NE in Lacey, owner is tired of it.", "another house"],
    ["https://www.zillow.com/homedetails/example", "a link"],
    ["Seller would take 380k on it.", "a price"],
    ["Roof is shot and the foundation has settled.", "the work it needs"],
    ["What do you mean by rougher? It could be a tear down.", "the work it needs"],
  ];
  for (const [inbound, gave] of cases) {
    assert.equal(namesTheHouse(inbound, { address: "12 Alder Ct, Kent, WA 98031" }), gave, inbound);
    const flags = closeOutFlags({ reply, inbound, address: "12 Alder Ct, Kent, WA 98031" });
    assert.equal(flags.length, 1, inbound);
    assert.match(flags[0], /brushes off a house they handed us/);
  }
});

test("an agent who says the house is turnkey still gets the pass", () => {
  const reply = "Sounds lighter than what we usually go for. Any fixers on your radar, listed or off-market?";
  for (const inbound of ["It's turnkey, fully remodeled last year.", "Just needs paint and carpet.", "Not a flip, it's in great shape, listed at 640k."]) {
    assert.deepEqual(closeOutFlags({ reply, inbound, address: "12 Alder Ct, Kent, WA 98031" }), [], inbound);
  }
  // ...unless they hand us another house in the same text.
  assert.equal(closeOutFlags({ reply, inbound: "That one's turnkey, but 88 Spruce Ave in Auburn needs everything.", address: "12 Alder Ct, Kent, WA 98031" }).length, 1);
});
