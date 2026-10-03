// site-check.test.mjs — the street a house sits on, from OpenStreetMap.
// Geometry is built around the real Edmonds deal (22018 76th Ave W) and the
// distances buyers complained at: 76th Ave W is a tertiary the house fronts;
// 3511 NE 153rd sits 87 m from Bothell Way; 7034 S K St 163 m from S 72nd St.

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOverpass, classifyPoint, siteReport, siteAdjustments, mergeSiteAdjustments,
  siteDealbreakers, siteFlagsOf, siteLine, metersToLine, SITE_PRESETS,
} from "./site-check.js";
import { UNDERWRITE_CHECKS_DEFAULTS } from "./underwrite-checks.js";

const T = UNDERWRITE_CHECKS_DEFAULTS.site;
const LAT = 47.799463, LNG = -122.335745;
const M_LAT = 1 / 111320;                                   // degrees per metre north
const M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180)); // degrees per metre east

// A north–south way `east` metres east of (lat, lng), 400 m long.
const nsWay = (tags, east, lat = LAT, lng = LNG) => ({
  type: "way", tags,
  geometry: [{ lat: lat - 200 * M_LAT, lon: lng + east * M_LNG }, { lat: lat + 200 * M_LAT, lon: lng + east * M_LNG }],
});
// A closed square `east` metres east, `size` metres across.
const box = (tags, east, size = 60, lat = LAT, lng = LNG) => {
  const w = lng + east * M_LNG, e = lng + (east + size) * M_LNG, s = lat - size / 2 * M_LAT, n = lat + size / 2 * M_LAT;
  return { type: "way", tags, geometry: [{ lat: s, lon: w }, { lat: s, lon: e }, { lat: n, lon: e }, { lat: n, lon: w }, { lat: s, lon: w }] };
};
const ctx = (...elements) => normalizeOverpass({ elements });

test("distance to a way is measured in metres on the ground", () => {
  const d = metersToLine({ lat: LAT, lng: LNG }, nsWay({}, 87).geometry);
  assert.ok(Math.abs(d - 87) < 1, `got ${d}`);
});

test("a house fronting a tertiary arterial gets the busy-road cut (Edmonds)", () => {
  const c = ctx(nsWay({ highway: "tertiary", name: "76th Avenue West", lanes: "3", maxspeed: "30 mph" }, 18));
  const r = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "76th Ave W", context: c, t: T });
  assert.equal(r.flags.busy_road.how, "fronts");
  assert.equal(r.flags.busy_road.cls, "tertiary");
  assert.match(r.flags.busy_road.label, /fronts 76th Ave W \(collector\)/);
});

test("a residential street is not busy, whatever it's called", () => {
  const c = ctx(nsWay({ highway: "residential", name: "138th Drive Southeast" }, 10));
  const r = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "138th Dr SE", context: c, t: T });
  assert.deepEqual(r.flags, {});
});

test("a primary road 87 m away counts, and 163 m still does; 260 m does not", () => {
  for (const [m, want] of [[87, true], [163, true], [260, false]]) {
    const c = ctx(nsWay({ highway: "primary", name: "Bothell Way Northeast" }, m));
    const r = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "NE 153rd St", context: c, t: T });
    assert.equal(Boolean(r.flags.busy_road), want, `${m} m`);
    if (want) assert.equal(r.flags.busy_road.how, "near");
  }
});

test("a same-named street that isn't at the house doesn't make it front one", () => {
  const c = ctx(nsWay({ highway: "secondary", name: "2nd Street" }, 400));
  const r = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "2nd St", context: c, t: T });
  assert.equal(r.flags.busy_road, undefined);
});

test("a house placed only on its street is checked for frontage, never distance", () => {
  const c = ctx(nsWay({ highway: "primary", name: "Aurora Avenue North" }, 60), box({ landuse: "commercial" }, 10));
  const r = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "Linden Ave N", precision: "street", context: c, t: T });
  assert.deepEqual(r.flags, {});
  const zip = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "Aurora Ave N", precision: "zip", context: c, t: T });
  assert.deepEqual(zip.flags, {}, "a ZIP centroid isn't a house");
});

test("commercial land behind the lot backs commercial; 80 m away doesn't", () => {
  const near = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "x", context: ctx(box({ landuse: "retail" }, 32)), t: T });
  assert.equal(near.flags.backs_commercial.meters, 32);
  const far = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "x", context: ctx(box({ landuse: "retail" }, 80)), t: T });
  assert.equal(far.flags.backs_commercial, undefined);
  const insideIt = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "x", context: ctx(box({ landuse: "commercial" }, -30)), t: T });
  assert.equal(insideIt.flags.backs_commercial.meters, 0, "a house inside a commercial polygon is on it");
});

test("a rail line 120 m away is flagged; a spur or a yard is not", () => {
  const main = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "x", context: ctx(nsWay({ railway: "rail" }, 120)), t: T });
  assert.equal(main.flags.railroad.meters, 120);
  const spur = classifyPoint({ point: { lat: LAT, lng: LNG }, street: "x", context: ctx(nsWay({ railway: "rail", service: "spur" }, 40)), t: T });
  assert.equal(spur.flags.railroad, undefined);
});

test("Overpass that answered nothing usable reads as unavailable, never as a quiet street", () => {
  assert.equal(normalizeOverpass(null), null);
  assert.equal(normalizeOverpass("<?xml version='1.0'?><osm>rate limited</osm>"), null);
  assert.equal(normalizeOverpass({ elements: [], remark: "runtime error: Query timed out in \"query\"" }), null);
  const report = siteReport({ subject: { lat: LAT, lng: LNG, address: "22018 76th Ave W, Edmonds, WA" }, comps: [], context: null, t: T });
  assert.equal(report.status, "unavailable");
  assert.deepEqual(siteAdjustments({ report, arvCompIds: [], t: T }), [], "Overpass down leaves the ARV alone");
});

// Four ARV comps around the house; `busy` says which sit on the arterial.
function reportWith({ subjectBusy, busyComps }) {
  const road = nsWay({ highway: "secondary", name: "South Yakima Avenue" }, 12);
  const comps = [0, 1, 2, 3].map((i) => {
    const onRoad = busyComps.includes(i);
    return { id: `c${i}`, lat: LAT + (i + 1) * 40 * M_LAT, lng: LNG + (onRoad ? 0 : 300) * M_LNG, address: `${5200 + i} ${onRoad ? "South Yakima Avenue" : "South Ainsworth Avenue"}, Tacoma, WA` };
  });
  return siteReport({
    subject: { lat: LAT, lng: LNG + (subjectBusy ? 0 : 300) * M_LNG, address: subjectBusy ? "5232 South Yakima Avenue, Tacoma, WA" : "5232 South Ainsworth Avenue, Tacoma, WA" },
    comps, context: ctx(road), t: T,
  });
}

test("a busy-road subject comped against quiet sales takes the whole cut", () => {
  const r = reportWith({ subjectBusy: true, busyComps: [] });
  const adj = siteAdjustments({ report: r, arvCompIds: ["c0", "c1", "c2", "c3"], t: T });
  assert.deepEqual(adj.map((a) => [a.key, a.pct]), [["busy_road", -5]]);
  assert.match(adj[0].label, /^Busy road — fronts S Yakima Ave/);
  assert.equal(adj[0].source, "auto");
});

test("a busy-road subject comped against busy-road sales is not cut twice", () => {
  const half = siteAdjustments({ report: reportWith({ subjectBusy: true, busyComps: [0, 1] }), arvCompIds: ["c0", "c1", "c2", "c3"], t: T });
  assert.deepEqual(half.map((a) => a.pct), [-2.5]);
  assert.equal(half[0].note, "2 of 4 ARV comps have it too");
  const all = siteAdjustments({ report: reportWith({ subjectBusy: true, busyComps: [0, 1, 2, 3] }), arvCompIds: ["c0", "c1", "c2", "c3"], t: T });
  assert.deepEqual(all, [], "every comp is on the same street: already priced in");
});

test("a quiet house comped against busy-road sales earns a small credit, never more than 3%", () => {
  const adj = siteAdjustments({ report: reportWith({ subjectBusy: false, busyComps: [0, 1] }), arvCompIds: ["c0", "c1", "c2", "c3"], t: T });
  assert.deepEqual(adj.map((a) => [a.key, a.pct]), [["busy_road_credit", 2.5]]);
  const capped = siteAdjustments({ report: reportWith({ subjectBusy: false, busyComps: [0, 1, 2, 3] }), arvCompIds: ["c0", "c1", "c2", "c3"], t: T, maxCreditPct: 3 });
  assert.equal(capped[0].pct, 3);
});

test("comps nobody could place don't dilute the cut", () => {
  const r = reportWith({ subjectBusy: true, busyComps: [] });
  const adj = siteAdjustments({ report: r, arvCompIds: ["c0", "ghost1", "ghost2"], t: T });
  assert.deepEqual(adj.map((a) => a.pct), [-5], "only c0 was classified, and it's quiet");
});

test("an operator who removed a cut doesn't get it back; one ticked by hand stays theirs", () => {
  const auto = [{ key: "busy_road", label: "Busy road — fronts S Yakima Ave (arterial)", pct: -5, source: "auto" }];
  assert.deepEqual(mergeSiteAdjustments([], auto, ["busy_road"]), []);
  const mine = [{ key: "busy_road", label: "Busy road", pct: -3 }];
  assert.deepEqual(mergeSiteAdjustments(mine, auto, []), mine, "a hand-set busy-road cut wins over the auto one");
  const stale = [{ key: "busy_road", label: "old auto", pct: -5, source: "auto" }];
  assert.deepEqual(mergeSiteAdjustments(stale, auto, []).map((a) => a.label), [auto[0].label], "a saved auto row is recomputed, not stacked");
});

test("a deal's street flags come from the check or from a preset ticked by hand", () => {
  assert.deepEqual(siteFlagsOf({ snapshot: { comps: { site: { subject: { flags: { busy_road: {} } } } } } }), ["busy_road"]);
  assert.deepEqual(siteFlagsOf({ snapshot: { comps: { adjustments: [{ key: "railroad", pct: -6 }] } } }), ["railroad"]);
  assert.equal(siteLine(["busy_road", "backs_commercial"]), "on a busy street, next to commercial");
  assert.equal(SITE_PRESETS.find((p) => p.key === "busy_road").pct, -5);
});

test("'no busy streets', 'no yellow lines' and 'quiet streets only' are busy-road dealbreakers", () => {
  assert.deepEqual(siteDealbreakers("No busy streets or short basements"), ["busy_road"]);
  assert.deepEqual(siteDealbreakers("quiet residential streets only, no arterials with yellow lines, must look like a house"), ["busy_road"]);
  assert.deepEqual(siteDealbreakers("no busy streets, no proximity to commercial district, not interested in Vashon"), ["busy_road", "backs_commercial"]);
  assert.deepEqual(siteDealbreakers("no properties near Aurora Ave (Seattle)"), ["busy_road"]);
  assert.deepEqual(siteDealbreakers("Pierce County only"), []);
});
