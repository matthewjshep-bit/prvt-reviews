// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// pricing-v2-settings.js — the offer engine's settings (auto-underwrite v2, 2026-11-04).
//
// `settings.pricingV2`, normalised by effectiveSettings (shared/offer-calc.js) so a saved partial is
// filled, never trusted. Every switch ships off; Matt turns each one on. No imports, so offer-calc
// can load it without a cycle.
//
// Pure.

const MIN_REHAB = 60000; // Matt's ballpark (2026-11-04); shared/rehab-floor.js MIN_REHAB

export const PRICING_V2_DEFAULTS = Object.freeze({
  shadow: false,        // price every named house beside the live path; writes a record, sends nothing
  liveA: false,         // grade-A houses get the engine's number for real
  // Grade B (Matt, 2026-11-10): "off", "shadow" (the number it would have sent goes on the house's
  // record, the draft and the timeline; nothing extra is sent) or "live" (a grade-B house goes out
  // the way grade A does, opening `gradeBOpenPct` lower). Live needs liveA on too.
  liveB: "off",
  gradeBOpenPct: 10,    // grade B opens this % under the engine's open (0–25)
  walkaway: false,      // grade A may come up to the walk-away on a counter
  reads: false,         // the nightly conversation reader
  autoCalibrate: false, // safer-direction calibration applies itself
  maoPct: 70,
  targetFee: 30000,
  minFee: 15000,
  minRehab: MIN_REHAB,
  turnkeyPct: 90,
  arvSplitPct: 10,
  minZipFlips: 15,
  maxPctOfList: 90,
  rehabFloorByEra: null, // { pre1950, y1950, y1980, y2000 } $/sqft over the defaults
  // Engine mode asks Bricked only when our own comps can't carry the ARV, at most this many a day
  // (Matt, 2026-11-04: ~300 credits left; "only when ours is unsure"). 0 = never.
  brickedPerDay: 3,
  // Matt (2026-11-09): the engine never offers past the seller's own number, and an uncapped
  // walk-away more than this % over it is a likely ARV error, held for him. 0 = any amount over holds.
  overSellerPct: 10,
});

const ERA_KEYS = ["pre1950", "y1950", "y1980", "y2000"];
export const GRADE_B_MODES = Object.freeze(["off", "shadow", "live"]);
const numIn = (v, lo, hi, dflt) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };

/** normalizePricingV2(v) → every key present, every number in range; switches off unless true. */
export function normalizePricingV2(v) {
  const s = v && typeof v === "object" ? v : {};
  const D = PRICING_V2_DEFAULTS;
  const targetFee = numIn(s.targetFee, 0, 200000, D.targetFee);
  const floors = s.rehabFloorByEra && typeof s.rehabFloorByEra === "object"
    ? Object.fromEntries(Object.entries(s.rehabFloorByEra).filter(([k, v]) => ERA_KEYS.includes(k) && Number(v) >= 10 && Number(v) <= 300).map(([k, v]) => [k, Math.round(Number(v))]))
    : null;
  return {
    shadow: s.shadow === true, liveA: s.liveA === true, walkaway: s.walkaway === true, reads: s.reads === true, autoCalibrate: s.autoCalibrate === true,
    liveB: GRADE_B_MODES.includes(s.liveB) ? s.liveB : D.liveB,
    gradeBOpenPct: numIn(s.gradeBOpenPct, 0, 25, D.gradeBOpenPct),
    maoPct: numIn(s.maoPct, 50, 85, D.maoPct),
    targetFee,
    minFee: Math.min(numIn(s.minFee, 0, 200000, D.minFee), targetFee),
    minRehab: numIn(s.minRehab, 0, 500000, D.minRehab),
    turnkeyPct: numIn(s.turnkeyPct, 70, 100, D.turnkeyPct),
    arvSplitPct: numIn(s.arvSplitPct, 2, 50, D.arvSplitPct),
    minZipFlips: numIn(s.minZipFlips, 1, 200, D.minZipFlips),
    maxPctOfList: numIn(s.maxPctOfList, 50, 100, D.maxPctOfList),
    brickedPerDay: Math.round(numIn(s.brickedPerDay, 0, 50, D.brickedPerDay)),
    rehabFloorByEra: floors,
    overSellerPct: numIn(s.overSellerPct, 0, 50, D.overSellerPct),
  };
}

