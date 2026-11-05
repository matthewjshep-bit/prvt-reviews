// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// rehab-floor.js — the least a house of its age and condition costs to finish (2026-11-04).
//
// The 2026-11-04 underwrite review: the machine's rehab ran ~40% under Matt's own at every age of
// house ($/sqft, machine vs Matt: before 1950 46 vs 71; 1950–79 34 vs 56; 1980–99 25 vs 60; 2000+
// 17 vs 35), and buyers said even his ran 1.3–3× low on every dead deal, never high. Matt chose
// "by age, from your prices": a $/sqft floor per era seeded from his medians, never under his $60k
// ballpark, that better evidence can only raise.
//
// Condition raises the floor: a heavy tier for a poor condition grade or distress words, the gut
// tier ($150/sqft, shared/rehab-catalog.js) for a teardown or a gut. Nothing here lowers a figure.
//
// Pure.

import { gutSignal, gutRehab, GUT_PER_SQFT } from "./rehab-catalog.js";

// Matt's medians, rounded (2026-11-04). `beforeYear` is exclusive; the last is any later year.
export const REHAB_FLOOR_BY_ERA = [
  { key: "pre1950", label: "built before 1950", beforeYear: 1950, psf: 70 },
  { key: "y1950", label: "built 1950–79", beforeYear: 1980, psf: 55 },
  { key: "y1980", label: "built 1980–99", beforeYear: 2000, psf: 55 },
  { key: "y2000", label: "built 2000 on", beforeYear: 10000, psf: 35 },
];
export const MIN_REHAB = 60000;
// No year built: the middle of the table.
export const UNKNOWN_ERA_PSF = 55;
// The heavy tier: a poor grade or a house the words call rough, short of a gut.
export const HEAVY_PER_SQFT = 100;

// Words that say heavy work, short of a gut (a gut or teardown is gutSignal's). Their negation is
// not one ("no water damage").
export const HEAVY_RX = /\bfire[\s-]?damage(?:d)?\b|\bhad\s+a\s+fire\b|\bwater\s+damage(?:d)?\b|\bflood(?:ed|ing)?\b|\bmold\b|\bhoard(?:er|ing)\b|\bneeds?\s+(?:everything|it\s+all|a\s+lot\s+of\s+work|major\s+(?:work|repairs?))\b|\bmajor\s+(?:repairs?|renovation|rehab)\b|\buninhabitable\b|\bnot\s+livable\b|\bunlivable\b|\bcash\s+only\b|\bwon'?t\s+(?:qualify|finance)\b|\bwill\s+not\s+(?:qualify|finance)\b|\bvacant\s+for\s+years\b|\bsquatters?\b|\bmeth\b|\bneeds\s+(?:a\s+)?(?:new\s+)?(?:roof|foundation)\s+and\b/i;
const NEGATED_RX = /\b(?:no|not|never|without|zero)\b[^.!?\n]{0,12}$|n't\b[^.!?\n]{0,12}$/i;

function heavyWords(text = "") {
  const t = String(text || "");
  const re = new RegExp(HEAVY_RX.source, "gi");
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (!NEGATED_RX.test(t.slice(Math.max(0, m.index - 20), m.index))) return m[0];
  }
  return "";
}

export const eraFor = (yearBuilt, table = REHAB_FLOOR_BY_ERA) => {
  const y = Math.round(Number(yearBuilt) || 0);
  if (y < 1800) return null;
  return table.find((e) => y < e.beforeYear) || null;
};

const round500 = (n) => Math.round(n / 500) * 500;

/**
 * normalizeRehabFloors(v) → the era table, with any saved $/sqft (10–300) laid over the defaults.
 * `v` is { pre1950, y1950, y1980, y2000 } in $/sqft.
 */
export function normalizeRehabFloors(v) {
  const saved = v && typeof v === "object" ? v : {};
  return REHAB_FLOOR_BY_ERA.map((e) => {
    const n = Math.round(Number(saved[e.key]));
    return Number.isFinite(n) && n >= 10 && n <= 300 ? { ...e, psf: n } : e;
  });
}

/**
 * rehabFloor({ sqft, yearBuilt, condition, countyCondition, said, remarks, floors, minRehab })
 *   → { floor, tier: "age" | "heavy" | "gut", why, psf }
 *
 *   condition        Bricked's grade of the house itself, C1 (best) … C6 (worst)
 *   countyCondition  King County's condition code, 1 poor … 5 very good
 *   said / remarks   the agent's words, the listing remarks
 */
export function rehabFloor({ sqft = 0, yearBuilt = 0, condition = null, countyCondition = null, said = "", remarks = "", floors = REHAB_FLOOR_BY_ERA, minRehab = MIN_REHAB } = {}) {
  const size = Number(sqft) || 0;
  const gut = gutSignal({ said, remarks });
  if (gut && size > 0) return { floor: Math.max(gutRehab(size), minRehab), tier: "gut", why: `a gut at $${GUT_PER_SQFT}/sqft: ${gut.why}`, psf: GUT_PER_SQFT };
  const words = heavyWords(said) || heavyWords(remarks);
  const poorGrade = Number(condition) >= 4 ? `Bricked grades the house C${Math.round(Number(condition))}` : Number(countyCondition) > 0 && Number(countyCondition) <= 2 ? `the county rates its condition ${countyCondition} of 5` : "";
  if ((words || poorGrade) && size > 0) {
    return { floor: Math.max(round500(size * HEAVY_PER_SQFT), minRehab), tier: "heavy", why: `heavy work at $${HEAVY_PER_SQFT}/sqft: ${words ? `"${words.toLowerCase()}"` : poorGrade}`, psf: HEAVY_PER_SQFT };
  }
  const era = eraFor(yearBuilt, floors);
  const psf = era ? era.psf : UNKNOWN_ERA_PSF;
  if (!(size > 0)) return { floor: minRehab, tier: "age", why: `no size on record: the $${Math.round(minRehab / 1000)}k ballpark`, psf: 0 };
  const at = round500(size * psf);
  return at >= minRehab
    ? { floor: at, tier: "age", why: `$${psf}/sqft for a house ${era ? era.label : "of unknown age"}`, psf }
    : { floor: minRehab, tier: "age", why: `never under the $${Math.round(minRehab / 1000)}k ballpark ($${psf}/sqft gives ${Math.round(at / 1000)}k)`, psf };
}
