// rehab-checks.test.mjs — is the scope complete? Fixtures from the deals
// buyers said we under-scoped (2026-10-02): Edmonds (1941, 960 sqft, $30k),
// Yakima (415k ARV, $50k, "100k rehab"), 3511 NE 153rd (hoarder house).

import test from "node:test";
import assert from "node:assert/strict";
import { rehabChecks, withAllowance } from "./rehab-checks.js";
import { blankRehabState, priceScope } from "./rehab-scope.js";
import { remarkSignals } from "./house-facts.js";
import { heavyCeiling } from "./rehab-catalog.js";
import { UNDERWRITE_CHECKS_DEFAULTS } from "./underwrite-checks.js";

const T = UNDERWRITE_CHECKS_DEFAULTS.rehab;
const on = (s, ...ids) => { for (const id of ids) s.rows[id] = { ...s.rows[id], on: true }; return s; };
const keys = (r) => r.rows.map((x) => x.key);

test("a 1941 house with no electrical row gets the systems allowance ($14,800 at 960 sqft)", () => {
  const r = rehabChecks({ state: on(blankRehabState(), "paint-int", "lvp"), sqft: 960, yearBuilt: 1941, arv: 700000, t: T });
  assert.deepEqual(r.rows.map((x) => [x.key, x.cost]), [["systems_electrical", 6600], ["systems_plumbing", 8200]]);
  assert.match(r.rows[0].label, /^Buyer allowance — rewire \(built 1941\)/);
  assert.match(r.rows[0].evidence, /photos don't show the electrical/);
});

test("a 1972 house gets the ordinary update, a 1985 house none", () => {
  const r72 = rehabChecks({ state: blankRehabState(), sqft: 1500, yearBuilt: 1972, arv: 600000, t: T });
  assert.deepEqual(r72.rows.map((x) => [x.key, x.cost]), [["systems_electrical", 4000], ["systems_plumbing", 5000]]);
  assert.match(r72.rows[0].label, /electrical update \(built 1972\)/);
  assert.deepEqual(rehabChecks({ state: blankRehabState(), sqft: 1500, yearBuilt: 1985, arv: 600000, t: T }).rows, []);
});

test("photos that show the panel updated waive the electrical half only", () => {
  const r = rehabChecks({ state: blankRehabState(), sqft: 960, yearBuilt: 1941, arv: 700000, areas: [{ area: "electrical", grade: "good", note: "new panel" }], t: T });
  assert.deepEqual(keys(r), ["systems_plumbing"]);
});

test("remarks that say rewired and repiped waive both", () => {
  const r = rehabChecks({ state: blankRehabState(), sqft: 960, yearBuilt: 1941, arv: 700000, remarks: remarkSignals("Rewired 2018 and repiped with PEX."), t: T });
  assert.deepEqual(r.rows, []);
});

test("a scope that already prices plumbing isn't charged twice", () => {
  const r = rehabChecks({ state: on(blankRehabState(), "plumb"), sqft: 960, yearBuilt: 1941, arv: 700000, t: T });
  assert.deepEqual(keys(r), ["systems_electrical"]);
});

test("a roof the photos grade poor with no roof line gets one; a priced roof doesn't", () => {
  const areas = [{ area: "roof", grade: "poor", note: "moss and missing shingles" }, { area: "kitchen", grade: "dated" }];
  const r = rehabChecks({ state: blankRehabState(), sqft: 1500, yearBuilt: 1990, arv: 500000, areas, t: T });
  assert.deepEqual(r.rows.map((x) => [x.key, x.cost]), [["photos_roof", 12000]]);
  assert.equal(r.rows[0].evidence, "moss and missing shingles");
  assert.deepEqual(rehabChecks({ state: on(blankRehabState(), "roof"), sqft: 1500, yearBuilt: 1990, arv: 500000, areas, t: T }).rows, []);
});

test("water damage in the remarks prices drywall and dry rot; fire is flagged, not priced", () => {
  const r = rehabChecks({ state: blankRehabState(), sqft: 1500, yearBuilt: 1995, arv: 500000, remarks: remarkSignals("Water damage in the bath. Prior fire in the garage."), t: T });
  assert.deepEqual(keys(r), ["remarks_water_damage", "remarks_water_damage"]);
  assert.ok(r.flags.some((f) => f.key === "remarks_fire"));
});

test("a house full of belongings carries a heavy cleanout (3511 NE 153rd)", () => {
  const r = rehabChecks({ state: blankRehabState(), sqft: 1500, yearBuilt: 1995, arv: 849000, contents: "heavy", t: T });
  assert.deepEqual(r.rows.map((x) => [x.key, x.cost]), [["cleanout", 3000]]);
});

test("a distressed listing's rehab never lands under 8% of ARV", () => {
  const state = on(blankRehabState(), "paint-int");
  const r = rehabChecks({ state, sqft: 1300, yearBuilt: 1995, arv: 415000, remarks: remarkSignals("Sold as-is, needs work"), t: T });
  assert.ok(keys(r).includes("distress_floor"));
  assert.ok(r.after >= 33200, `after ${r.after}`);
  assert.equal(r.floor.why, "the listing sells it as a project");
});

test("a turnkey listing isn't held to the distressed floor", () => {
  const r = rehabChecks({ state: blankRehabState(), sqft: 1300, yearBuilt: 1995, arv: 415000, remarks: remarkSignals("Fully remodeled, sold as-is"), t: T });
  assert.equal(keys(r).includes("distress_floor"), false);
});

test("the checks never push a scope past the heavy band", () => {
  const state = on(blankRehabState(), "kit-gut", "roof", "lvp", "paint-int", "paint-ext", "windows");
  state.rows.windows.qty = 10;
  const r = rehabChecks({ state, sqft: 960, yearBuilt: 1941, arv: 700000, contents: "heavy", remarks: remarkSignals("as-is"), t: T });
  assert.ok(r.after <= Math.max(heavyCeiling(960), r.before), `after ${r.after} vs ceiling ${heavyCeiling(960)}`);
  assert.equal(r.trimmed, true);
});

test("a line a person removed stays removed; the checks only ever add", () => {
  const r = rehabChecks({ state: blankRehabState(), sqft: 960, yearBuilt: 1941, arv: 700000, declined: ["systems_electrical"], t: T });
  assert.deepEqual(keys(r), ["systems_plumbing"]);
  assert.ok(r.after >= r.before);
});

test("allowance lines are scope lines and carry the contingency", () => {
  const state = withAllowance(blankRehabState(), [{ id: "allow-elec", key: "systems_electrical", label: "Buyer allowance — rewire (built 1941)", cost: 6600 }]);
  const p = priceScope(state, 960);
  assert.deepEqual(p.lines.map((l) => [l.label, l.cost]), [["Buyer allowance — rewire (built 1941)", 6600]]);
  assert.equal(p.total, 7500, "6,600 + 10% contingency, rounded to $500");
});

test("a re-run recomputes the allowance instead of stacking on the last one", () => {
  const first = rehabChecks({ state: blankRehabState(), sqft: 960, yearBuilt: 1941, arv: 700000, t: T });
  const again = rehabChecks({ state: withAllowance(blankRehabState(), first.rows), sqft: 960, yearBuilt: 1941, arv: 700000, t: T });
  assert.deepEqual(again.rows, first.rows);
  assert.equal(again.before, first.before);
});

test("the ARV's add-a-bath cure is priced as a buyer allowance", () => {
  const r = rehabChecks({ state: blankRehabState(), sqft: 1056, yearBuilt: 1990, arv: 825000, cures: [{ key: "add_bath", label: "Add a bath — the ARV comps have 2, this has 1", cost: 25000 }], t: T });
  assert.deepEqual(r.rows.map((x) => [x.key, x.cost]), [["add_bath", 25000]]);
});
