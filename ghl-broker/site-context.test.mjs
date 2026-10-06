// site-context.test.mjs — OpenStreetMap around a house, and what happens
// when it doesn't answer. The public Overpass endpoint answered about one
// request in five with an XML rate-limit page when this was measured
// (2026-10-02); none of that may ever read as "a quiet street".
//
//   node --test site-context.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { fetchSiteContext, overpassQuery, siteBox, checkSite, _resetSiteCache, OVERPASS_ENDPOINTS, SITE_MAX_COMPS, fetchBarriers } from "./site-context.js";
import { UNDERWRITE_CHECKS_DEFAULTS } from "./shared/underwrite-checks.js";

const LAT = 47.799463, LNG = -122.335745;
const WAY = { elements: [{ type: "way", tags: { highway: "tertiary", name: "76th Avenue West" },
  geometry: [{ lat: LAT - 0.002, lon: LNG + 0.0002 }, { lat: LAT + 0.002, lon: LNG + 0.0002 }] }] };
const reply = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text });
const json = (o) => reply(200, JSON.stringify(o));
const BOX = siteBox({ points: [{ lat: LAT, lng: LNG }], padMeters: 275 });

test("the query asks for major roads, commercial land and rail inside one small box", () => {
  const box = siteBox({ points: [{ lat: LAT, lng: LNG }], padMeters: 275 });
  const q = overpassQuery({ box });
  assert.match(q, /^\[out:json\]\[timeout:25\]\[bbox:47\.79\d{3},-122\.33\d{3},47\.80\d{3},-122\.33\d{3}\];/);
  assert.match(q, /way\[highway~"\^\(motorway\|trunk\|primary\|secondary\|tertiary/);
  assert.match(q, /way\[landuse~"\^\(commercial\|retail\|industrial\)\$"\]/);
  assert.match(q, /way\[railway=rail\]/);
  assert.match(q, /out tags geom;$/);
});

// 2026-10-02, the night it shipped: a mile-wide disc around a Tacoma house
// took 13.5 s on the public endpoint and every live run read "street not
// checked". The box now covers the house and the dozen comps the ARV can come
// from, padded by the farthest any rule looks.
test("the box covers the house and its comps, padded by the farthest a rule looks", () => {
  const b = siteBox({ points: [{ lat: LAT, lng: LNG }, { lat: LAT + 0.004, lng: LNG - 0.006 }], padMeters: 275 });
  assert.ok(b.s < LAT - 0.0024 && b.n > LAT + 0.004 + 0.0024);
  assert.ok(b.w < LNG - 0.006 - 0.0036 && b.e > LNG + 0.0036);
  assert.equal(siteBox({ points: [] }), null);
});

test("only the first dozen comps are measured, and a far-flung one doesn't balloon the box", async () => {
  _resetSiteCache();
  let query = "";
  const fetchImpl = async (url, opts) => { query = decodeURIComponent(String(opts.body).slice(5)); return json(WAY); };
  const comps = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, lat: LAT + 0.001 * (i % 5), lng: LNG + 0.001, address: `${i} Main St` }));
  comps.push({ id: "far", lat: LAT + 0.2, lng: LNG, address: "far away" });
  const r = await checkSite({ subject: { lat: LAT, lng: LNG, address: "22018 76th Ave W, Edmonds, WA", precision: "address" }, comps: [comps[20], ...comps.slice(0, 20)], t: UNDERWRITE_CHECKS_DEFAULTS.site, fetchImpl });
  assert.equal(r.status, "ok");
  assert.equal(Object.keys(r.comps).length, SITE_MAX_COMPS - 1, "the far comp was dropped to keep the box small");
  assert.equal(r.comps.far, undefined);
  const [s, , n] = query.match(/bbox:([\d.,-]+)\]/)[1].split(",").map(Number);
  assert.ok((n - s) * 111320 < 4000, "the box stays under 4 km");
});

test("an XML rate-limit page falls through to the mirror", async () => {
  _resetSiteCache();
  const hit = [];
  const fetchImpl = async (url) => { hit.push(url); return url === OVERPASS_ENDPOINTS[0] ? reply(200, "<?xml version='1.0'?><osm>rate limited</osm>") : json(WAY); };
  const r = await fetchSiteContext({ box: BOX, fetchImpl, pauseMs: 0 });
  assert.deepEqual(hit, OVERPASS_ENDPOINTS);
  assert.equal(r.context.roads.length, 1);
});

test("a 200 that says the query timed out is a failure, not an empty street", async () => {
  _resetSiteCache();
  const fetchImpl = async () => json({ elements: [], remark: "runtime error: Query timed out in \"query\" at line 1 after 26 seconds." });
  const r = await fetchSiteContext({ box: BOX, fetchImpl, pauseMs: 0 });
  assert.equal(r.context, null);
  assert.match(r.error, /no usable data/);
});

test("Overpass down everywhere returns nothing after one retry, and nothing is cached", async () => {
  _resetSiteCache();
  let n = 0;
  const down = async () => { n++; return reply(429, "Too Many Requests"); };
  const r = await fetchSiteContext({ box: BOX, fetchImpl: down, pauseMs: 0 });
  assert.equal(r.context, null);
  assert.equal(n, 3, "the main endpoint, the mirror, the main endpoint again");
  const up = async () => json(WAY);
  assert.ok((await fetchSiteContext({ box: BOX, fetchImpl: up, pauseMs: 0 })).context, "the next ask goes out — the failure wasn't remembered");
});

test("the same street is asked once a day", async () => {
  _resetSiteCache();
  let n = 0;
  const fetchImpl = async () => { n++; return json(WAY); };
  await fetchSiteContext({ box: BOX, fetchImpl });
  const again = await fetchSiteContext({ box: BOX, fetchImpl });
  assert.equal(n, 1);
  assert.equal(again.cached, true);
  await fetchSiteContext({ box: BOX, fetchImpl, now: Date.now() + 25 * 3600 * 1000 });
  assert.equal(n, 2, "a day later it's asked again");
});

test("a hung endpoint is abandoned at the time budget", async () => {
  _resetSiteCache();
  const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
  const t0 = Date.now();
  const r = await fetchSiteContext({ box: BOX, fetchImpl: hang, timeoutMs: 50, budgetMs: 400, pauseMs: 10 });
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

// The same-side map (shared/same-side.js): every run asks for it, so it has
// to stay light and never be confused with the street check's answer.
test("the same-side map asks for main roads, rail and rivers around the whole ring, and is cached apart from the street check", async () => {
  _resetSiteCache();
  const bodies = [];
  const fetchImpl = async (url, opts) => { bodies.push(decodeURIComponent(String(opts.body))); return json(WAY); };
  const subject = { lat: LAT, lng: LNG };
  const r = await fetchBarriers({ subject, radiusMiles: 1, fetchImpl, pauseMs: 0 });
  assert.equal(r.context.roads[0].name, "76th Avenue West");
  assert.match(bodies[0], /waterway=river/);
  assert.match(bodies[0], /railway=rail/);
  assert.doesNotMatch(bodies[0], /landuse/, "no land use: the lines are all it reads");
  const m = bodies[0].match(/bbox:([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/);
  assert.ok((Number(m[3]) - Number(m[1])) * 111320 > 2 * 1609, "a mile each way");
  assert.ok((await fetchBarriers({ subject, radiusMiles: 1, fetchImpl, pauseMs: 0 })).cached, "the same ring is asked once a day");
  await fetchSiteContext({ box: siteBox({ points: [subject], padMeters: 1609.34 + 100 }), fetchImpl, pauseMs: 0 });
  assert.equal(bodies.length, 2, "the street check's own query isn't answered from the map's cache");
  assert.match(bodies[1], /landuse/);
});

test("the same-side map down is no map, never a throw", async () => {
  _resetSiteCache();
  const r = await fetchBarriers({ subject: { lat: LAT, lng: LNG }, fetchImpl: async () => reply(429, "slow down"), pauseMs: 0 });
  assert.equal(r.context, null);
  assert.match(r.error, /429/);
  assert.equal((await fetchBarriers({ subject: null })).context, null);
});
