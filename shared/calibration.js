// calibration.js — the underwriter learns from Matt's own corrections (2026-10-15).
//
// The funnel review: on 35 of 305 houses our number fell after the agent had
// seen it, and hand and machine first numbers were cut about equally (12.6%
// against 11%). The inputs are the problem: rehab read low off the photos,
// ARV read high. Every time Matt opens an auto-underwrite and changes its ARV
// or its rehab, he is telling the machine how far off it was. Revisions now
// record that (routes/offers.js: arv and repairs from → to, the size, the
// year built, who moved it), and this turns his revisions into two settings
// he can apply from Lessons:
//
//   rehab_psf_floor  by era (before 1950, 1950–79, 1980 on): the scan's rehab
//                    is never under what his own revisions run per sqft
//   arv_haircut      the ARV comes off by the share his revisions take off it
//
// Nothing applies itself. `underwriteCalibration` is absent until he presses
// Apply, and the underwriter changes nothing while it is absent.
//
// Pure.

// The eras, by year built. `beforeYear` is exclusive; the last one is "any
// later year". A house with no year built gets no floor.
export const CALIBRATION_ERAS = [
  { key: "pre1950", label: "built before 1950", beforeYear: 1950 },
  { key: "1950to1979", label: "built 1950–79", beforeYear: 1980 },
  { key: "1980on", label: "built 1980 on", beforeYear: 10000 },
];
export const CALIBRATION_MIN_N = 5;
// His revisions must lean one way this often before it's a pattern.
export const CALIBRATION_LEAN = 0.6;
export const ARV_HAIRCUT_MAX = 15;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n) => Math.round(num(n));
const money = (n) => `$${round(n).toLocaleString("en-US")}`;
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const quantile = (xs, q) => {
  const s = sorted(xs);
  if (!s.length) return null;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};

/**
 * normalizeUnderwriteCalibration(v) → { rehabFloorPsf: [{ beforeYear, psf }], arvHaircutPct } | null
 *
 * Null (absent) is "change nothing". A block with neither part set is null too.
 */
export function normalizeUnderwriteCalibration(v) {
  if (!v || typeof v !== "object") return null;
  const eras = new Set(CALIBRATION_ERAS.map((e) => e.beforeYear));
  const floors = (Array.isArray(v.rehabFloorPsf) ? v.rehabFloorPsf : [])
    .map((x) => ({ beforeYear: round(x?.beforeYear), psf: Math.min(500, Math.max(0, round(x?.psf))) }))
    .filter((x) => eras.has(x.beforeYear) && x.psf > 0);
  const byYear = new Map(floors.map((x) => [x.beforeYear, x]));
  const rehabFloorPsf = [...byYear.values()].sort((a, b) => a.beforeYear - b.beforeYear);
  const arvHaircutPct = Math.min(ARV_HAIRCUT_MAX, Math.max(0, Math.round(num(v.arvHaircutPct) * 10) / 10));
  if (!rehabFloorPsf.length && !arvHaircutPct) return null;
  return { rehabFloorPsf, arvHaircutPct };
}

export const eraOf = (yearBuilt) => {
  const y = round(yearBuilt);
  if (y < 1800) return null;
  return CALIBRATION_ERAS.find((e) => y < e.beforeYear) || null;
};

/**
 * calibrate({ calibration, arv, repairs, sqft, yearBuilt, heavyTop }) → { arv, arvCutPct, arvNote, floorPsf, repairsTarget, repairsAdd, repairsNote }
 *
 * What the calibration does to one house. The rehab floor never goes past
 * the heavy band's top (`heavyTop`), so it can't hold a run; with no size or
 * no year built there is no floor; with no rehab scanned there is nothing to
 * floor.
 */
export function calibrate({ calibration = null, arv = 0, repairs = 0, sqft = 0, yearBuilt = 0, heavyTop = 0 } = {}) {
  const c = normalizeUnderwriteCalibration(calibration);
  const out = { arv: round(arv), arvCutPct: 0, arvNote: "", floorPsf: 0, repairsTarget: 0, repairsAdd: 0, repairsNote: "" };
  if (!c) return out;
  if (c.arvHaircutPct > 0 && num(arv) > 0) {
    out.arv = Math.round(num(arv) * (1 - c.arvHaircutPct / 100));
    out.arvCutPct = c.arvHaircutPct;
    out.arvNote = `calibrated: less ${c.arvHaircutPct}%, the share your own revisions take off our ARV`;
  }
  const era = eraOf(yearBuilt);
  const floor = era ? c.rehabFloorPsf.find((x) => x.beforeYear === era.beforeYear) : null;
  if (floor && num(sqft) > 0 && num(repairs) > 0) {
    const target = Math.round(Math.min(floor.psf * num(sqft), num(heavyTop) > 0 ? num(heavyTop) : Infinity));
    out.floorPsf = floor.psf;
    out.repairsTarget = target;
    if (target > num(repairs)) {
      out.repairsAdd = target - round(repairs);
      out.repairsNote = `calibrated rehab floor: houses ${era.label} run about $${floor.psf}/sqft on your revisions`;
    }
  }
  return out;
}

// One offer's correction: the machine's figures before Matt's first revision,
// his after the last one. Only revisions a person made, on an auto-underwrite.
function correctionOf(o) {
  if (!o?.autoUnderwrite) return null;
  const mine = (o.revisions || []).filter((r) => r?.by === "you" && (Array.isArray(r.arv) || Array.isArray(r.repairs)));
  if (!mine.length) return null;
  const first = mine[0], last = mine.at(-1);
  const pair = (k) => {
    const a = Array.isArray(first[k]) ? round(first[k][0]) : 0;
    const b = Array.isArray(last[k]) ? round(last[k][1]) : 0;
    return a > 0 && b > 0 ? [a, b] : null;
  };
  const sqft = round(last.sqft || first.sqft);
  const yearBuilt = round(last.yearBuilt || first.yearBuilt);
  return { offerId: o.id, street: String(o.address || "").split(",")[0].trim(), arv: pair("arv"), repairs: pair("repairs"), sqft, yearBuilt };
}

/**
 * calibrationReport({ offers, settings, minN }) → { recommendations, note, sample }
 *
 * Lessons-shaped recommendations ({ id, kind, title, confidence, evidence,
 * suggestedSettings, negotiationRule }) from Matt's revisions of the
 * machine's numbers. `suggestedSettings.underwriteCalibration` carries the
 * whole block (the current one with the change), because Apply merges at the
 * top level only. Under `minN` corrections, no recommendation and a note.
 */
export function calibrationReport({ offers = [], settings = {}, minN = CALIBRATION_MIN_N } = {}) {
  const current = normalizeUnderwriteCalibration(settings?.underwriteCalibration) || { rehabFloorPsf: [], arvHaircutPct: 0 };
  const fixes = (offers || []).map(correctionOf).filter(Boolean);
  const confidence = (n) => (n >= minN * 4 ? "high" : n >= minN * 2 ? "medium" : "low");
  const recs = [];

  /* the rehab floor, by era */
  const floors = [];
  const evidence = [];
  for (const era of CALIBRATION_ERAS) {
    const pts = fixes.filter((f) => f.repairs && f.sqft > 0 && eraOf(f.yearBuilt)?.key === era.key);
    if (pts.length < minN) continue;
    const raised = pts.filter((f) => f.repairs[1] > f.repairs[0]);
    if (raised.length / pts.length < CALIBRATION_LEAN) continue;
    const psf = pts.map((f) => f.repairs[1] / f.sqft);
    const floor = Math.round(quantile(psf, 0.25));
    const had = current.rehabFloorPsf.find((x) => x.beforeYear === era.beforeYear)?.psf || 0;
    if (!(floor > had)) continue;
    floors.push({ beforeYear: era.beforeYear, psf: floor, n: pts.length });
    evidence.push(`Houses ${era.label}: you raised the rehab on ${raised.length} of ${pts.length}; yours run $${Math.round(quantile(psf, 0))}–$${Math.round(quantile(psf, 1))}/sqft, a quarter of them under $${floor}.`);
    for (const f of pts.slice(0, 3)) evidence.push(`${f.street} (${f.sqft.toLocaleString("en-US")} sqft, ${f.yearBuilt}): rehab ${money(f.repairs[0])} → ${money(f.repairs[1])}`);
  }
  if (floors.length) {
    const merged = new Map(current.rehabFloorPsf.map((x) => [x.beforeYear, x]));
    for (const f of floors) merged.set(f.beforeYear, { beforeYear: f.beforeYear, psf: f.psf });
    const words = floors.map((f) => `$${f.psf}/sqft ${CALIBRATION_ERAS.find((e) => e.beforeYear === f.beforeYear).label}`).join(", ");
    recs.push({
      id: "rehab_psf_floor", kind: "settings",
      title: `The scan reads rehab low against your revisions — floor it at ${words}`,
      confidence: confidence(Math.min(...floors.map((f) => f.n))),
      evidence,
      suggestedSettings: { underwriteCalibration: { ...current, rehabFloorPsf: [...merged.values()].sort((a, b) => a.beforeYear - b.beforeYear) } },
      negotiationRule: null,
    });
  }

  /* the ARV haircut */
  const arvPts = fixes.filter((f) => f.arv);
  if (arvPts.length >= minN) {
    const cuts = arvPts.map((f) => ((f.arv[0] - f.arv[1]) / f.arv[0]) * 100);
    const lowered = cuts.filter((c) => c > 0).length;
    const med = quantile(cuts, 0.5);
    const pct = Math.min(ARV_HAIRCUT_MAX, Math.round(med * 10) / 10);
    if (lowered / arvPts.length >= CALIBRATION_LEAN && pct > 1 && pct > current.arvHaircutPct) {
      recs.push({
        id: "arv_haircut", kind: "settings",
        title: `Our ARV runs high against your revisions — take ${pct}% off it`,
        confidence: confidence(arvPts.length),
        evidence: [
          `You lowered the ARV on ${lowered} of ${arvPts.length}; the middle cut was ${pct}%.`,
          ...arvPts.slice(0, 4).map((f) => `${f.street}: ARV ${money(f.arv[0])} → ${money(f.arv[1])}`),
        ],
        suggestedSettings: { underwriteCalibration: { ...current, arvHaircutPct: pct } },
        negotiationRule: null,
      });
    }
  }

  const n = fixes.length;
  const note = recs.length ? "" : n < minN
    ? `Not enough of your revisions yet to calibrate: ${n} of ${minN} hand revisions of an auto-underwrite with the ARV and rehab recorded (recorded from 2026-10-15).`
    : `Your ${n} revisions don't lean one way yet — nothing to calibrate.`;
  return { recommendations: recs, note, sample: { revisions: n } };
}
