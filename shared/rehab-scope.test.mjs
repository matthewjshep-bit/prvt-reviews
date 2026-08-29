import test from "node:test";
import assert from "node:assert/strict";
import {
  blankRehabState, hydrateRehabState, seedRoomCounts, applyScanSuggestion,
  priceScope, scopeAmount, resizeRooms,
} from "./rehab-scope.js";
import { ALL_REHAB_ITEMS } from "./rehab-catalog.js";

const tick = (s, id, patch = {}) => {
  s.rows[id] = { ...s.rows[id], on: true, ...patch };
  return s;
};

/* ---------------- the blank state ---------------- */

test("blank state carries every catalog item, all unticked at catalog price", () => {
  const s = blankRehabState();
  assert.equal(Object.keys(s.rows).length, ALL_REHAB_ITEMS.length);
  for (const item of ALL_REHAB_ITEMS) {
    assert.equal(s.rows[item.id].on, false);
    assert.equal(s.rows[item.id].unit, item.unit);
  }
  const { lines, subtotal, total } = priceScope(s, 1500);
  assert.deepEqual(lines, []);
  assert.equal(subtotal, 0);
  assert.equal(total, 0);
});

test("hydrate fills in a catalog item a stored snapshot predates", () => {
  const s = hydrateRehabState({ rows: { roof: { on: true, unit: 12000, qty: 1 } }, contingency: "0" });
  assert.equal(s.rows.roof.on, true);
  assert.equal(s.rows["kit-appl"].on, false);      // came from the blank
  assert.equal(s.rows["kit-appl"].unit, 4500);
});

/* ---------------- pricing: the numbers must not move ---------------- */
// Reference values computed from the catalog by hand:
//   sizeFactor(770)  = 0.5 + 0.5 * (770/1500)  = 0.756666…
//   sizeFactor(2400) = 0.5 + 0.5 * (2400/1500) = 1.3
// A 770 sqft cottage is the case that forced sizeFactor to exist at all.

test("770 sqft: per-sqft, size-scaled, flat and per-unit items each price their own way", () => {
  let s = blankRehabState();
  tick(s, "paint-int");            // sqft   $3/sqft            → 3 × 770        = 2,310
  tick(s, "roof");                 // flat + scales  $12,000    → × 0.756666…    = 9,080
  tick(s, "kit-appl");             // flat, no scale $4,500     → 4,500 flat     = 4,500
  tick(s, "windows", { qty: 6 });  // qty    $650 each          → × 6            = 3,900

  const { lines, subtotal, total } = priceScope(s, 770);
  assert.deepEqual(lines, [
    { label: "Appliance package", cost: 4500 },
    { label: "Interior paint (whole house)", cost: 2310 },
    { label: "Roof replacement", cost: 9080 },
    { label: "Windows ×6", cost: 3900 },
  ]);
  assert.equal(subtotal, 19790);
  assert.equal(total, 22000);      // 19,790 × 1.10 = 21,769 → $500 → 22,000
});

test("2,400 sqft: the same scope costs more, and only the scaling items move", () => {
  let s = blankRehabState();
  tick(s, "paint-int");
  tick(s, "roof");
  tick(s, "kit-appl");
  tick(s, "windows", { qty: 6 });
  const { lines, subtotal, total } = priceScope(s, 2400);
  assert.deepEqual(lines.map((l) => l.cost), [4500, 7200, 15600, 3900]);
  assert.equal(subtotal, 31200);
  assert.equal(total, 34500);      // 31,200 × 1.10 = 34,320 → $500 → 34,500
});

test("contingency 0 skips the uplift but still rounds to $500", () => {
  let s = blankRehabState();
  s.contingency = "0";
  tick(s, "paint-int");
  tick(s, "roof");
  tick(s, "kit-appl");
  tick(s, "windows", { qty: 6 });
  assert.equal(priceScope(s, 770).subtotal, 19790);
  assert.equal(priceScope(s, 770).total, 20000);   // 19,790 → $500 → 20,000
});

test("the $500 rounding lands on the half and rounds up", () => {
  const at = (cost) => priceScope({ ...blankRehabState(), contingency: "0", custom: [{ id: "x", label: "Lump", cost }] }, 0).total;
  assert.equal(at(19750), 20000);   // exactly 39.5 × 500 → up
  assert.equal(at(19749), 19500);
  assert.equal(at(19751), 20000);
});

test("size unknown falls back to catalog price rather than guessing", () => {
  const s = tick(blankRehabState(), "roof");
  assert.equal(priceScope(s, 0).subtotal, 12000);   // sizeFactor(0) === 1
});

test("a zero-cost line never reaches the scope", () => {
  const s = tick(blankRehabState(), "roof", { unit: 0 });
  assert.deepEqual(priceScope(s, 1500).lines, []);
});

/* ---------------- rooms ---------------- */

test("room counts come off the subject record, bathrooms rounded up", () => {
  const s = seedRoomCounts(blankRehabState(), { beds: 3, baths: 1.75 });
  assert.equal(s.bedCount, 3);
  assert.equal(s.bathCount, 2);            // the half bath is a room you walk into
  assert.equal(s.bedRooms.length, 3);
  assert.equal(s.bathRooms.length, 2);
  assert.deepEqual(priceScope(s, 1500).lines, []);   // "no work" tiers price nothing
});

test("resizing keeps the tiers already set and pads with no-work", () => {
  const rooms = [{ tier: "gut", unit: 12000 }, { tier: "refresh", unit: 1800 }];
  assert.deepEqual(resizeRooms(rooms, 3), [
    { tier: "gut", unit: 12000 },
    { tier: "refresh", unit: 1800 },
    { tier: "none", unit: 0 },
  ]);
  assert.deepEqual(resizeRooms(rooms, 1), [{ tier: "gut", unit: 12000 }]);
});

test("priced room lines name the room and its tier", () => {
  const s = { ...blankRehabState(), contingency: "0",
    bathCount: 2, bathRooms: [{ tier: "mid", unit: 8000 }, { tier: "refresh", unit: 1800 }],
    bedCount: 1, bedRooms: [{ tier: "full", unit: 2200 }] };
  const { lines, subtotal } = priceScope(s, 1500);
  assert.deepEqual(lines, [
    { label: "Bathroom 1 — mid remodel (surround/tile/vanity)", cost: 8000 },
    { label: "Bathroom 2 — refresh (vanity/toilet/fixtures)", cost: 1800 },
    { label: "Bedroom 1 — full redo (floor/paint/closet/door)", cost: 2200 },
  ]);
  assert.equal(subtotal, 12000);
});

/* ---------------- applying a scan ---------------- */

const SUGGESTION = {
  summary: "Dated throughout; roof at end of life.",
  items: [{ id: "roof", note: "Curling shingles, moss." }, { id: "paint-int", note: "Original wall color." }],
  bathrooms: [{ tier: "mid", note: "Pink tile surround." }, { tier: "refresh", note: "Not shown in photos." }],
  bedrooms: [{ tier: "refresh", note: "Carpet worn." }],
  areas: [{ area: "roof", grade: "poor", note: "Moss." }],
  custom: [{ label: "Oil tank decommission", cost: 3000, note: "Fill pipe visible." }],
};

test("a scan ticks items, sets room tiers, adds custom lines and records the notes", () => {
  const seeded = seedRoomCounts(blankRehabState(), { beds: 3, baths: 2 });
  const s = applyScanSuggestion(seeded, SUGGESTION, { photosAnalyzed: 24 });

  assert.equal(s.rows.roof.on, true);
  assert.equal(s.rows["paint-int"].on, true);
  assert.equal(s.rows["kit-gut"].on, false);

  assert.deepEqual(s.bathRooms, [{ tier: "mid", unit: 8000 }, { tier: "refresh", unit: 1800 }]);
  assert.equal(s.bedCount, 3);                                  // scan graded 1, record says 3 — record wins
  assert.deepEqual(s.bedRooms[0], { tier: "refresh", unit: 900 });
  assert.deepEqual(s.bedRooms[1], { tier: "none", unit: 0 });

  assert.equal(s.custom.length, 1);
  assert.equal(s.custom[0].cost, 3000);

  assert.equal(s.aiResult.photosAnalyzed, 24);
  assert.equal(s.aiResult.areas.length, 1);
  assert.equal(s.aiResult.notes.length, 6);                     // 2 items + 2 baths + 1 bed + 1 custom
});

test("a scan that finds more bathrooms than the record claims wins", () => {
  const seeded = seedRoomCounts(blankRehabState(), { beds: 2, baths: 1 });
  const s = applyScanSuggestion(seeded, {
    ...SUGGESTION,
    bathrooms: [{ tier: "mid" }, { tier: "gut" }, { tier: "refresh" }],
  });
  assert.equal(s.bathCount, 3);
  assert.deepEqual(s.bathRooms.map((r) => r.tier), ["mid", "gut", "refresh"]);
});

test("a scan never unticks what the operator ticked by hand", () => {
  const manual = tick(blankRehabState(), "found");             // foundation, ticked deliberately
  const s = applyScanSuggestion(manual, SUGGESTION);
  assert.equal(s.rows.found.on, true);
});

test("applying the same scan twice is a no-op — re-running the automation can't double-bill", () => {
  const seeded = seedRoomCounts(blankRehabState(), { beds: 3, baths: 2 });
  const once = applyScanSuggestion(seeded, SUGGESTION, { photosAnalyzed: 24 });
  const twice = applyScanSuggestion(once, SUGGESTION, { photosAnalyzed: 24 });
  assert.deepEqual(twice, once);
  assert.equal(priceScope(twice, 1500).subtotal, priceScope(once, 1500).subtotal);
});

test("a scan with a zero-cost custom item leaves it out", () => {
  const s = applyScanSuggestion(blankRehabState(), { custom: [{ label: "Nothing", cost: 0 }] });
  assert.deepEqual(s.custom, []);
});

test("applying a scan does not mutate the state it was handed", () => {
  const before = seedRoomCounts(blankRehabState(), { beds: 3, baths: 2 });
  const snapshot = JSON.parse(JSON.stringify(before));
  applyScanSuggestion(before, SUGGESTION);
  assert.deepEqual(before, snapshot);
});

/* ---------------- which number becomes the offer's repairs ---------------- */

test("scopeAmount is the itemized total until a bucket overrides it", () => {
  let s = blankRehabState();
  tick(s, "roof");
  assert.equal(scopeAmount(s, 1500), priceScope(s, 1500).total);
  s = { ...s, bucket: "medium", bucketAmount: "60000" };
  assert.equal(scopeAmount(s, 1500), 60000);
});

test("a bucket with no amount typed is zero, not the itemized total", () => {
  const s = { ...tick(blankRehabState(), "roof"), bucket: "light", bucketAmount: "" };
  assert.equal(scopeAmount(s, 1500), 0);
});
