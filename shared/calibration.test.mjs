// calibration.test.mjs — the underwriter learns from Matt's own revisions.

import test from "node:test";
import assert from "node:assert/strict";
import { calibrationReport, calibrate, normalizeUnderwriteCalibration, eraOf, CALIBRATION_MIN_N } from "./calibration.js";
import { effectiveSettings } from "./offer-calc.js";

// One auto-underwrite Matt revised by hand: the machine's ARV and rehab, then his.
const revised = (i, { arv = [500000, 470000], repairs = [40000, 70000], sqft = 1400, yearBuilt = 1942, by = "you" } = {}) => ({
  id: `o${i}`, address: `${100 + i} Fern Way, Kent, WA 98030`, cashAmount: 300000, autoUnderwrite: { passed: true },
  revisions: [{ ts: `2026-10-${String(10 + (i % 15)).padStart(2, "0")}T18:00:00Z`, from: 320000, to: 300000, by, arv, repairs, sqft, yearBuilt }],
});

test("with fewer than five of his revisions there is no recommendation, and a note says so", () => {
  const r = calibrationReport({ offers: [revised(1), revised(2), revised(3)] });
  assert.deepEqual(r.recommendations, []);
  assert.match(r.note, /Not enough of your revisions yet to calibrate: 3 of 5/);
  assert.equal(r.sample.revisions, 3);
});

test("only a person's revisions of an auto-underwrite count", () => {
  const machine = Array.from({ length: 6 }, (_, i) => revised(i, { by: "requote" }));
  const handMade = Array.from({ length: 6 }, (_, i) => ({ ...revised(i), autoUnderwrite: null }));
  const old = Array.from({ length: 6 }, (_, i) => ({ ...revised(i), revisions: [{ ts: "2026-09-01T18:00:00Z", from: 320000, to: 300000 }] }));
  for (const offers of [machine, handMade, old]) assert.equal(calibrationReport({ offers }).sample.revisions, 0);
});

test("when he keeps raising the rehab on old houses, the floor is where a quarter of his run under", () => {
  const offers = [30, 35, 40, 45, 50, 55].map((psf, i) => revised(i, { repairs: [30000, psf * 1400], sqft: 1400, yearBuilt: 1930 + i }));
  const r = calibrationReport({ offers });
  const rec = r.recommendations.find((x) => x.id === "rehab_psf_floor");
  assert.ok(rec, r.note);
  assert.equal(rec.kind, "settings");
  assert.match(rec.title, /floor it at \$\d+\/sqft built before 1950/);
  const floor = rec.suggestedSettings.underwriteCalibration.rehabFloorPsf;
  assert.deepEqual(floor.map((x) => x.beforeYear), [1950]);
  assert.ok(floor[0].psf >= 36 && floor[0].psf <= 38, `lower quartile of 30–55, got ${floor[0].psf}`);
  assert.ok(rec.evidence.some((e) => /you raised the rehab on 6 of 6/.test(e)));
  assert.equal(r.note, "");
  // The same houses but he cut the rehab: no floor.
  const cut = calibrationReport({ offers: offers.map((o) => ({ ...o, revisions: [{ ...o.revisions[0], repairs: [80000, 50000] }] })) });
  assert.equal(cut.recommendations.find((x) => x.id === "rehab_psf_floor"), undefined);
});

test("when he keeps lowering the ARV, the haircut is his middle cut, and Apply carries the whole block", () => {
  const offers = [4, 5, 6, 7, 8].map((pct, i) => revised(i, { arv: [500000, 500000 * (1 - pct / 100)], repairs: [50000, 50000] }));
  const settings = { underwriteCalibration: { rehabFloorPsf: [{ beforeYear: 1980, psf: 40 }], arvHaircutPct: 0 } };
  const rec = calibrationReport({ offers, settings }).recommendations.find((x) => x.id === "arv_haircut");
  assert.ok(rec);
  assert.match(rec.title, /take 6% off it/);
  assert.deepEqual(rec.suggestedSettings, { underwriteCalibration: { rehabFloorPsf: [{ beforeYear: 1980, psf: 40 }], arvHaircutPct: 6 } },
    "the floor already set rides along");
  for (const k of ["id", "kind", "title", "confidence", "evidence", "suggestedSettings", "negotiationRule"]) assert.ok(k in rec, k);
  // Already at 6%: nothing new.
  assert.equal(calibrationReport({ offers, settings: { underwriteCalibration: { arvHaircutPct: 6 } } }).recommendations.length, 0);
});

test("the calibration is absent until applied, and absent changes nothing", () => {
  assert.equal(normalizeUnderwriteCalibration(undefined), null);
  assert.equal(normalizeUnderwriteCalibration({ rehabFloorPsf: [], arvHaircutPct: 0 }), null);
  assert.deepEqual(normalizeUnderwriteCalibration({ rehabFloorPsf: [{ beforeYear: 1950, psf: "45" }, { beforeYear: 1234, psf: 9 }], arvHaircutPct: 40 }),
    { rehabFloorPsf: [{ beforeYear: 1950, psf: 45 }], arvHaircutPct: 15 }, "an unknown era is dropped and the haircut is capped");
  assert.equal("underwriteCalibration" in effectiveSettings({}), false, "never added to settings that don't have it");
  assert.equal(effectiveSettings({ underwriteCalibration: { arvHaircutPct: 3 } }).underwriteCalibration.arvHaircutPct, 3);
  const none = calibrate({ calibration: null, arv: 500000, repairs: 40000, sqft: 1400, yearBuilt: 1940, heavyTop: 90000 });
  assert.equal(none.arv, 500000);
  assert.equal(none.repairsAdd, 0);
});

test("the rehab floor stops at the heavy band and needs a size, a year and a scanned rehab", () => {
  const cal = { rehabFloorPsf: [{ beforeYear: 1950, psf: 80 }], arvHaircutPct: 4 };
  const c = calibrate({ calibration: cal, arv: 500000, repairs: 40000, sqft: 1400, yearBuilt: 1940, heavyTop: 90000 });
  assert.equal(c.arv, 480000);
  assert.equal(c.repairsTarget, 90000, "80 × 1,400 is 112,000, past the heavy band's 90,000");
  assert.equal(c.repairsAdd, 50000);
  assert.match(c.repairsNote, /houses built before 1950 run about \$80\/sqft/);
  assert.equal(calibrate({ calibration: cal, repairs: 40000, sqft: 1400, yearBuilt: 0, heavyTop: 90000 }).repairsAdd, 0, "no year built");
  assert.equal(calibrate({ calibration: cal, repairs: 0, sqft: 1400, yearBuilt: 1940, heavyTop: 90000 }).repairsAdd, 0, "nothing scanned");
  assert.equal(calibrate({ calibration: cal, repairs: 95000, sqft: 1400, yearBuilt: 1940, heavyTop: 90000 }).repairsAdd, 0, "already over");
  assert.equal(eraOf(1979).key, "1950to1979");
  assert.equal(eraOf(1980).key, "1980on");
  assert.equal(CALIBRATION_MIN_N, 5);
});
