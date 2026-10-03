// underwrite-checks.test.mjs — the buyer's view, end to end on one house.

import test from "node:test";
import assert from "node:assert/strict";
import {
  UNDERWRITE_CHECKS_DEFAULTS, normalizeUnderwriteChecks, checksFor, buyerView, checksLines, summarizeChecks, normalizeDeclined,
} from "./underwrite-checks.js";
import { blankRehabState } from "./rehab-scope.js";

test("the checks ship switched off, and turning the master on brings every check with it", () => {
  const c = normalizeUnderwriteChecks(null);
  assert.equal(c.enabled, false);
  assert.equal(checksFor({}), null);
  const on = normalizeUnderwriteChecks({ enabled: true });
  for (const sec of ["site", "layout", "actives", "rehab", "flags"]) assert.equal(on[sec].enabled, true, sec);
  assert.deepEqual(on.site, UNDERWRITE_CHECKS_DEFAULTS.site);
});

test("a saved partial keeps the defaults it didn't mention, and out-of-range numbers are clamped", () => {
  const c = normalizeUnderwriteChecks({ enabled: true, site: { busyRoadPct: "-8", railMeters: 9999 }, rehab: { enabled: false } });
  assert.equal(c.site.busyRoadPct, -8);
  assert.equal(c.site.railMeters, 500);
  assert.equal(c.site.commercialPct, -5);
  assert.equal(c.rehab.enabled, false);
  assert.equal(normalizeUnderwriteChecks({ site: { busyRoadPct: 4 } }).site.busyRoadPct, 0, "a 'cut' can't become a premium");
});

test("a backtest forces the checks on without touching the saved setting", () => {
  const saved = { underwriteChecks: { enabled: false } };
  assert.equal(checksFor(saved), null);
  assert.equal(checksFor(saved, { force: true }).enabled, true);
  assert.equal(saved.underwriteChecks.enabled, false);
});

// Yakima, roughly: a 1950s 3/1 on a secondary street, four quiet renovated
// comps around 415k, listings asking less, a thin scope.
const SITE = {
  status: "ok",
  subject: { flags: { busy_road: { how: "fronts", label: "fronts S Yakima Ave (arterial)" } }, nearest: null },
  comps: { c1: [], c2: [], c3: [], c4: [] },
};
const COMPS = [410000, 415000, 420000, 418000].map((price, i) => ({ id: `c${i + 1}`, price, sqft: 1300, beds: 3, baths: 1, condition: "renovated", similarity: 80 }));
const ACTIVES = [
  { id: "a1", address: "1 A St", price: 389000, sqft: 1300, beds: 3, baths: 1, distance: 0.3 },
  { id: "a2", address: "2 B St", price: 385000, sqft: 1300, beds: 3, baths: 1, distance: 0.4 },
  { id: "a3", address: "3 C St", price: 300000, sqft: 1300, beds: 3, baths: 1, distance: 0.5 },
  { id: "a4", address: "4 D St", price: 305000, sqft: 1300, beds: 3, baths: 1, distance: 0.6 },
];

test("the Yakima house is cut for the street, held to its listings and given the systems it lacks", () => {
  const checks = checksFor({ underwriteChecks: { enabled: true } });
  const state = blankRehabState(); state.rows["paint-int"].on = true; state.rows.lvp.on = true;
  const v = buyerView({
    checks, address: "5232 South Yakima Avenue, Tacoma, WA 98408",
    subject: { sqft: 1300, beds: 3, baths: 1, yearBuilt: 1952 }, comps: COMPS, sqft: 1300,
    site: SITE, actives: ACTIVES, rehabState: state, remarks: "Sold as-is. Needs work throughout.",
  });
  assert.equal(v.pre.base, 417000);
  assert.ok(v.arv.capped, "held to what similar houses list for");
  assert.ok(v.arv.arv < 380000, `ARV ${v.arv.arv}`);
  assert.deepEqual(v.adjustments.map((a) => [a.key, a.pct]), [["busy_road", -5]], "no comp shares the street, so the whole cut");
  assert.deepEqual(v.rehab.rows.map((r) => r.key).slice(0, 2), ["systems_electrical", "systems_plumbing"]);
  assert.ok(v.rehab.after > v.rehab.before);
  const lines = checksLines(v.summary);
  assert.ok(lines.some((l) => l.startsWith("ARV: Busy road — fronts S Yakima Ave")));
  assert.ok(lines.some((l) => l.startsWith("Listings: capped at $")));
  assert.ok(lines.some((l) => l.startsWith("Rehab: +$")));
});

test("checks switched off price exactly as before", () => {
  assert.equal(buyerView({ checks: null, comps: COMPS }), null);
});

test("a person's removals hold: no street cut, no cap, no systems line", () => {
  const checks = checksFor({ underwriteChecks: { enabled: true } });
  const v = buyerView({
    checks, address: "5232 South Yakima Avenue, Tacoma, WA 98408", subject: { sqft: 1300, beds: 3, baths: 1, yearBuilt: 1952 },
    comps: COMPS, sqft: 1300, site: SITE, actives: ACTIVES, rehabState: blankRehabState(),
    declined: { arv: ["busy_road"], rehab: ["systems_electrical", "systems_plumbing"], cap: true },
  });
  assert.equal(v.arv.arv, v.pre.base);
  assert.deepEqual(v.rehab.rows.map((r) => r.key), []);
  assert.deepEqual(v.summary.declined, normalizeDeclined({ arv: ["busy_road"], rehab: ["systems_electrical", "systems_plumbing"], cap: true }));
});

test("the street not checked and the listings not pulled read as such, and change nothing", () => {
  const checks = checksFor({ underwriteChecks: { enabled: true } });
  const v = buyerView({ checks, subject: { sqft: 1300, yearBuilt: 2001 }, comps: COMPS, sqft: 1300, site: { status: "unavailable", subject: { flags: {} }, comps: {} }, actives: null });
  assert.equal(v.arv.arv, v.pre.base);
  assert.equal(v.status.site, "unavailable");
  assert.equal(v.status.actives, "unavailable");
  assert.ok(checksLines(v.summary).includes("Street: not checked (map service unavailable)"));
});

test("Vashon's ferry, a high ARV and a tiny house are flags — never price", () => {
  const checks = checksFor({ underwriteChecks: { enabled: true } });
  const v = buyerView({ checks, address: "21904 Vashon Hwy SW, Vashon, WA 98070", subject: { sqft: 900, yearBuilt: 1994 }, comps: [{ id: "x", price: 1600000, condition: "renovated" }, { id: "y", price: 1600000, condition: "renovated" }], sqft: 900 });
  assert.deepEqual(v.flags.map((f) => f.key).sort(), ["thin_high_arv", "thin_island", "thin_small"]);
  assert.equal(v.arv.arv, 1600000);
});

test("the listing's exposure, septic and easement are flagged for the package", () => {
  const checks = checksFor({ underwriteChecks: { enabled: true } });
  const v = buyerView({ checks, subject: { sqft: 1500, yearBuilt: 2000 }, comps: COMPS, sqft: 1500,
    house: { status: "FOR_SALE", daysOnMarket: 64, priceCuts: 2, sewer: "septic" }, remarks: "Shared driveway easement." });
  const f = Object.fromEntries(v.flags.map((x) => [x.key, x.label]));
  assert.match(f.exposure, /on the market, 64 days, 2 price cuts — buyers have likely seen it/);
  assert.ok(f.legal_septic && f.legal_easement);
});

test("the offer's compact record is read off the snapshot", () => {
  const checks = checksFor({ underwriteChecks: { enabled: true } });
  const v = buyerView({ checks, address: "5232 South Yakima Avenue, Tacoma, WA 98408", subject: { sqft: 1300, beds: 3, baths: 1, yearBuilt: 1952 }, comps: COMPS, sqft: 1300, site: SITE, actives: ACTIVES, rehabState: blankRehabState() });
  const s = summarizeChecks({ checks: v.summary });
  assert.equal(s.arvCutPct, -5);
  assert.equal(s.capped, true);
  assert.ok(s.rehabAdded > 0);
  assert.equal(summarizeChecks({}), null);
});
