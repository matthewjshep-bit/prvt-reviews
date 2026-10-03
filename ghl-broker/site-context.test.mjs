// site-context.test.mjs — OpenStreetMap around a house, and what happens
// when it doesn't answer. The public Overpass endpoint answered about one
// request in five with an XML rate-limit page when this was measured
// (2026-10-02); none of that may ever read as "a quiet street".
//
//   node --test site-context.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { fetchSiteContext, overpassQuery, siteRadiusMeters, checkSite, _resetSiteCache, OVERPASS_ENDPOINTS } from "./site-context.js";
import { UNDERWRITE_CHECKS_DEFAULTS } from "./shared/underwrite-checks.js";

const LAT = 47.799463, LNG = -122.335745;
const WAY = { elements: [{ type: "way", tags: { highway: "tertiary", name: "76th Avenue West" },
  geometry: [{ lat: LAT - 0.002, lon: LNG + 0.0002 }, { lat: LAT + 0.002, lon: LNG + 0.0002 }] }] };
const reply = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text });
const json = (o) => reply(200, JSON.stringify(o));

test("the query asks for major roads, commercial land and rail around the point", () => {
  const q = overpassQuery({ lat: LAT, lng: LNG, radiusMeters: 1750 });
  assert.match(q, /\[out:json\]/);
  assert.match(q, /highway~"\^\(motorway\|trunk\|primary\|secondary\|tertiary/);
  assert.match(q, /landuse~"\^\(commercial\|retail\|industrial\)\$"/);
  assert.match(q, /railway=rail/);
  assert.match(q, /around:1750,47\.799463,-122\.335745/);
  assert.match(q, /out tags geom;$/);
});

test("one query reaches the farthest comp, a mile at least, rounded so neighbours share it", () => {
  assert.equal(siteRadiusMeters({ center: { lat: LAT, lng: LNG }, points: [] }), 2000);
  assert.equal(siteRadiusMeters({ center: { lat: LAT, lng: LNG }, points: [{ lat: LAT + 0.03, lng: LNG }] }), 2500, "held to 2.5 km");
});

test("an XML rate-limit page falls through to the mirror", async () => {
  _resetSiteCache();
  const hit = [];
  const fetchImpl = async (url) => { hit.push(url); return url === OVERPASS_ENDPOINTS[0] ? reply(200, "<?xml version='1.0'?><osm>rate limited</osm>") : json(WAY); };
  const r = await fetchSiteContext({ lat: LAT, lng: LNG, fetchImpl, pauseMs: 0 });
  assert.deepEqual(hit, OVERPASS_ENDPOINTS);
  assert.equal(r.context.roads.length, 1);
});

test("a 200 that says the query timed out is a failure, not an empty street", async () => {
  _resetSiteCache();
  const fetchImpl = async () => json({ elements: [], remark: "runtime error: Query timed out in \"query\" at line 1 after 26 seconds." });
  const r = await fetchSiteContext({ lat: LAT, lng: LNG, fetchImpl, pauseMs: 0 });
  assert.equal(r.context, null);
  assert.match(r.error, /no usable data/);
});

test("Overpass down everywhere returns nothing after one retry, and nothing is cached", async () => {
  _resetSiteCache();
  let n = 0;
  const down = async () => { n++; return reply(429, "Too Many Requests"); };
  const r = await fetchSiteContext({ lat: LAT, lng: LNG, fetchImpl: down, pauseMs: 0 });
  assert.equal(r.context, null);
  assert.equal(n, 4, "two endpoints, two rounds");
  const up = async () => json(WAY);
  assert.ok((await fetchSiteContext({ lat: LAT, lng: LNG, fetchImpl: up, pauseMs: 0 })).context, "the next ask goes out — the failure wasn't remembered");
});

test("the same street is asked once a day", async () => {
  _resetSiteCache();
  let n = 0;
  const fetchImpl = async () => { n++; return json(WAY); };
  await fetchSiteContext({ lat: LAT, lng: LNG, fetchImpl });
  const again = await fetchSiteContext({ lat: LAT, lng: LNG, fetchImpl });
  assert.equal(n, 1);
  assert.equal(again.cached, true);
  await fetchSiteContext({ lat: LAT, lng: LNG, fetchImpl, now: Date.now() + 25 * 3600 * 1000 });
  assert.equal(n, 2, "a day later it's asked again");
});

test("a hung endpoint is abandoned at the time budget", async () => {
  _resetSiteCache();
  const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
  const t0 = Date.now();
  const r = await fetchSiteContext({ lat: LAT, lng: LNG, fetchImpl: hang, timeoutMs: 50, budgetMs: 400, pauseMs: 10 });
  assert.equal(r.context, null);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test("checkSite classifies the subject and its comps from one query", async () => {
  _resetSiteCache();
  const fetchImpl = async () => json(WAY);
  const r = await checkSite({
    subject: { lat: LAT, lng: LNG, address: "22018 76th Ave W, Edmonds, WA 98026", precision: "address" },
    comps: [{ id: "c1", lat: LAT + 0.003, lng: LNG + 0.004, address: "21800 80th Ave W, Edmonds, WA" }],
    t: UNDERWRITE_CHECKS_DEFAULTS.site, fetchImpl,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.subject.flags.busy_road.how, "fronts");
  assert.deepEqual(r.comps.c1, []);
});
