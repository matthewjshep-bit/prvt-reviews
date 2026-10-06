// same-side.test.mjs — is a comp on the house's side of the main roads?
//
// 2026-10-06, 2325 48th Ave SW, Tumwater: every comp carrying the ARV was a
// new build across Trosper Rd SW, and the sales on the house's own side
// carried nothing. These build that street on a flat grid around the house.
//
//   node --test same-side.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { barrierLines, acrossBetween, markSides, isAcross, acrossLabel, barrierName, sameSideFirst } from "./same-side.js";
import { normalizeOverpass } from "./site-check.js";
import { similarity } from "./comp-match.js";

const LAT = 47.0045, LNG = -122.9302;
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos((LAT * Math.PI) / 180));
// metres north and east of the house
const at = (north, east) => ({ lat: LAT + north * M_LAT, lng: LNG + east * M_LNG });
const HOUSE = at(0, 0);
const way = (tags, pts) => ({ type: "way", tags, geometry: pts.map((p) => ({ lat: p.lat, lon: p.lng })) });
const eastWest = (north) => [at(north, -3000), at(north, 3000)];
const northSouth = (east) => [at(-3000, east), at(3000, east)];

// Trosper Rd SW 300 m south; a quiet street, a creek and a freeway ramp
// between the house and its neighbours to the north.
const MAP = normalizeOverpass({ elements: [
  way({ highway: "tertiary", name: "Trosper Road Southwest" }, eastWest(-300)),
  way({ highway: "residential", name: "Lambskin Street Southwest" }, eastWest(150)),
  way({ waterway: "stream", name: "Percival Creek" }, eastWest(250)),
  way({ highway: "motorway_link" }, eastWest(350)),
] });

test("a new build across Trosper Rd is across it; a sale on the house's own side isn't", () => {
  const [lot25, lambskin] = markSides({ subject: HOUSE, comps: [{ id: "lot25", ...at(-800, -300) }, { id: "lambskin", ...at(320, 150) }], context: MAP });
  assert.deepEqual(lot25.side.across, [{ name: "Trosper Road Southwest", kind: "tertiary" }]);
  assert.equal(isAcross(lot25), true);
  assert.deepEqual(lambskin.side.across, [], "a quiet street, a creek and a ramp are not main roads");
  assert.equal(isAcross(lambskin), false);
});

test("a railway, a river and every class of main road count; a creek, a quiet street and a ramp don't", () => {
  const map = normalizeOverpass({ elements: [
    way({ highway: "motorway", ref: "I 5" }, northSouth(500)),
    way({ highway: "primary", name: "Capitol Boulevard Southeast" }, northSouth(700)),
    way({ railway: "rail", name: "BNSF" }, northSouth(900)),
    way({ waterway: "river", name: "Deschutes River" }, northSouth(1100)),
    way({ highway: "residential", name: "Quiet Lane" }, northSouth(200)),
    way({ waterway: "stream", name: "Percival Creek" }, northSouth(300)),
    way({ highway: "trunk_link" }, northSouth(400)),
  ] });
  assert.deepEqual(barrierLines(map).map((b) => b.kind).sort(), ["motorway", "primary", "rail", "river"]);
  const across = acrossBetween(HOUSE, at(0, 1300), barrierLines(map));
  assert.deepEqual(across.map((b) => b.name), ["I 5", "Capitol Boulevard Southeast", "BNSF", "Deschutes River"]);
});

test("the road the house fronts is not a road between it and its comps", () => {
  // Rural Rd runs 12 m east of the house: its own frontage, or a geocode on
  // the centre line. A comp across the road from the house still is.
  const map = normalizeOverpass({ elements: [way({ highway: "tertiary", name: "Rural Road Southwest" }, northSouth(12))] });
  assert.deepEqual(acrossBetween(HOUSE, at(0, 600), barrierLines(map)), []);
  const farSide = acrossBetween(HOUSE, at(0, 600), barrierLines(normalizeOverpass({ elements: [way({ highway: "tertiary", name: "Rural Road Southwest" }, northSouth(200))] })));
  assert.equal(farSide.length, 1);
});

test("no map, no side: a lookup that failed never reads as the same side", () => {
  const comps = [{ id: "a", ...at(-800, 0), distance: 0.5 }];
  assert.equal(markSides({ subject: HOUSE, comps, context: null }), comps, "untouched");
  assert.equal(isAcross(comps[0]), false);
  const s = similarity({ beds: 3 }, { ...comps[0], beds: 3 }, { radiusMiles: 1 });
  assert.equal(s.factors.find((f) => f.key === "side").value, null, "unknown leaves the denominator");
});

test("a comp across a main road loses its side points; the same comp on the house's side keeps them", () => {
  const facts = { beds: 4, baths: 3, sqft: 3000, distance: 0.3 };
  const same = similarity(facts, { ...facts, side: { across: [] } }, { radiusMiles: 1 });
  const across = similarity(facts, { ...facts, side: { across: [{ name: "Trosper Road Southwest", kind: "tertiary" }] } }, { radiusMiles: 1 });
  assert.ok(same.score > across.score + 10, `${same.score} vs ${across.score}`);
  assert.match(across.factors.find((f) => f.key === "side").detail, /across Trosper Road Southwest/);
});

test("comps across a main road only top the house's side up to what the proxy needs", () => {
  const side = (id, across) => ({ id, side: { across: across ? [{ name: "Trosper Road Southwest", kind: "tertiary" }] : [] } });
  const best = [side("x1", true), side("s1"), side("x2", true), side("s2"), side("x3", true), side("s3")];
  const short = sameSideFirst(best, { min: 5 });
  assert.deepEqual(short.picked.map((c) => c.id), ["s1", "s2", "s3", "x1", "x2"]);
  assert.equal(short.acrossUsed, 2);
  const enough = sameSideFirst(best, { min: 3 });
  assert.deepEqual(enough.picked.map((c) => c.id), ["s1", "s2", "s3"], "the house's side carries it alone");
  assert.equal(enough.acrossUsed, 0);
});

test("the road is named the way it's signed", () => {
  assert.equal(barrierName({ name: "Trosper Road Southwest", kind: "tertiary" }), "Trosper Rd SW");
  assert.equal(barrierName({ name: "", kind: "motorway" }), "the freeway");
  assert.equal(barrierName({ name: "", kind: "secondary" }), "a main road");
  assert.equal(acrossLabel({ side: { across: [{ name: "Trosper Road Southwest" }, { name: "Kirsop Road Southwest" }] } }), "across Trosper Rd SW + 1 more");
  assert.equal(acrossLabel({ side: { across: [] } }), "");
});
