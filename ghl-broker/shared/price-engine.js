// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// price-engine.js — every read of a house in, one answer out (auto-underwrite v2, 2026-11-04).
//
// The 2026-11-04 review of 100 days: 14 of 17 deals came from Matt's own numbers; the machine's
// ARV ran high and its rehab ~40% low, its numbers went out fast, and agents said yes to numbers we
// then walked back. Matt's direction: price once, accurately, and let the machine run the houses it
// is sure of. This module is the pricing half, pure:
//
//   priceHouse(reads, settings) → { arv, rehab, rehabWhy, investorPrice, walkAway, open, grade,
//                                   triage, spread, killers, turnkey, misses, reasons }
//
// - ARV: Bricked's (it grades its comps for renovation; Matt kept it on 11 of 16 houses he priced),
//   cross-checked by our own comps when we have them. Reads more than `arvSplitPct` apart drop the
//   grade — the engine never quietly takes the lower.
// - Rehab: the best evidence (photo scope, Bricked's line items from a description, their own repair
//   figure when higher), never under the floor for the house's age and condition
//   (shared/rehab-floor.js). One floor, applied once.
// - Investor price: `maoPct` (70) of ARV less rehab — what buyers, post-mortems and investors in
//   their own words say a flipper pays. King County's flip ratio for the ZIP is a cross-check that
//   drops the grade, binding only with `minZipFlips` flips behind it.
// - Walk-away = investor price − the minimum fee ($15k, Matt 2026-11-04); open = investor price −
//   the target fee ($30k). Both capped at 90% of list.
// - Grade A: the ARV is sure, the rehab has evidence, the house is in the box, not turnkey, no
//   killer facts. B: one miss. C: two or more, or any killer, kind or turnkey hold.
// - Triage: walk-away ÷ the seller's number (theirs when said, else list): hot ≥ 95%, workable
//   ≥ 85%, long shot ≥ 70%, no fit below. Agreements happen within 5% (23 → 4 deals); 5–10% went
//   17 → 0 before anything could move up.
//
// Pure: no I/O, no clock.

import { rehabFloor, normalizeRehabFloors } from "./rehab-floor.js";
import { normalizePricingV2 } from "./pricing-v2-settings.js";

export { normalizePricingV2, PRICING_V2_DEFAULTS } from "./pricing-v2-settings.js";
import { gutSignal } from "./rehab-catalog.js";
import { saysTurnkey, bankSaleIn } from "./flip-read.js";
import { onMarketCue } from "./off-market.js";
import { ASSIGNMENT_RX } from "./lead-source.js";
import { ruralHold } from "./asset-type.js";

// A comp is renovated when Bricked says so, or (is_renovated null, as on 49 of 50 reads) when its
// renovation score is 0.7 or more.
const RENOVATED_SCORE = 0.7;
const renovated = (c = {}) => c.renovated === true || (c.renovated == null && Number(c.renovationScore) >= RENOVATED_SCORE);

const TEARDOWN_RX = /\btear[\s-]?down\b|\bvalue\s+(?:is\s+)?in\s+the\s+land\b|\blot\s+value\b|\bbuild(?:er)?\s+opportunity\b/i;
const MOVED_RX = /\b(?:was|been|has\s+been)\s+moved\b|\bmoved\s+(?:twice|two\s+times|2x)\b/i;
const PARK_RX = /\blot\s+rent\b|\bspace\s+rent\b|\bmobile\s+home\s+park\b|\b55\+\s*(?:park|community)\b/i;

/**
 * killersOf({ homeType, lotSqft, said, remarks }) → ["manufactured", "rural", "teardown", …]
 * The facts that keep a house from a machine number: wrong asset for our buyers, a bank's sale,
 * someone else bidding, another wholesaler's paper. Each one cost a deal (post-mortems 2026-09-10,
 * 10-12, 10-21).
 */
export function killersOf({ homeType = "", lotSqft = 0, said = "", remarks = "" } = {}) {
  const words = `${said || ""}\n${remarks || ""}`;
  const t = String(homeType || "").toUpperCase();
  const out = [];
  if (/MANUFACTURED|MOBILE/.test(t) || PARK_RX.test(words)) out.push("manufactured");
  if (/LOT|LAND/.test(t)) out.push("land");
  if (/MULTI|DUPLEX|TRIPLEX|FOURPLEX|APARTMENT/.test(t)) out.push("multi_family");
  if (/CONDO|TOWN/.test(t)) out.push("condo_or_townhouse");
  if (Number(lotSqft) > 0 && ruralHold(lotSqft)) out.push("rural");
  if (TEARDOWN_RX.test(words)) out.push("teardown");
  const bank = bankSaleIn(words);
  if (bank) out.push(bank === "short sale" ? "short_sale" : "bank_owned");
  if (onMarketCue(said)) out.push("competing");
  if (ASSIGNMENT_RX.test(said)) out.push("wholesaler_paper");
  if (MOVED_RX.test(words)) out.push("moved");
  return out;
}

const round250 = (n) => Math.round(n / 250) * 250;

/**
 * triageOf({ walkAway, sellerNumber, list }) → { triage, spread, against }
 * hot ≥ 0.95, workable ≥ 0.85, long_shot ≥ 0.70, no_fit below; "unknown" with no number to measure.
 */
export function triageOf({ walkAway = 0, sellerNumber = 0, list = 0 } = {}) {
  const theirs = Number(sellerNumber) > 0 ? Number(sellerNumber) : Number(list) > 0 ? Number(list) : 0;
  const against = Number(sellerNumber) > 0 ? "their number" : Number(list) > 0 ? "the list price" : null;
  if (!(theirs > 0) || !(walkAway > 0)) return { triage: walkAway > 0 ? "unknown" : "no_fit", spread: null, against };
  const spread = Math.round((walkAway / theirs) * 1000) / 1000;
  const triage = spread >= 0.95 ? "hot" : spread >= 0.85 ? "workable" : spread >= 0.70 ? "long_shot" : "no_fit";
  return { triage, spread, against };
}

/**
 * priceHouse(reads, settings, { ratios }) → the engine's answer for one house.
 *
 * reads:
 *   list, sellerNumber, zip, sqft, yearBuilt, lotSqft, homeType
 *   bricked  { arv, arvConfidence (0–1), asIs, repairs, described, comps: [{ use, renovated, renovationScore }], condition }
 *   comps    { arv, n }            our own Zillow read, when one was taken
 *   scope    { total, photos }     the photo scan's priced scope
 *   theirRepairs                   the agent's or seller's own repair figure
 *   countyCondition                King County's condition code (1 poor … 5 very good)
 *   said, remarks                  the agent's words, the listing remarks
 * ratios: shared/kc-flip-ratios.js KC_FLIP_RATIOS (optional)
 */
export function priceHouse(reads = {}, settings = {}, { ratios = null } = {}) {
  const s = normalizePricingV2(settings);
  const reasons = [];
  const misses = [];
  const b = reads.bricked || null;
  const c = reads.comps && Number(reads.comps.arv) > 0 ? reads.comps : null;
  const list = Number(reads.list) || 0;
  const said = String(reads.said || "");
  const remarks = String(reads.remarks || "");

  /* --- killers and turnkey --- */
  const killers = killersOf({ homeType: reads.homeType, lotSqft: reads.lotSqft, said, remarks });
  const turnkeyBy = b?.asIs > 0 && b?.arv > 0 && b.asIs >= (b.arv * s.turnkeyPct) / 100
    ? `Bricked's as-is is ${Math.round((b.asIs / b.arv) * 100)}% of its ARV`
    : saysTurnkey(said) ? "the agent says it's turnkey" : "";

  /* --- ARV --- */
  const bArv = Number(b?.arv) > 0 ? Number(b.arv) : 0;
  const cArv = c ? Number(c.arv) : 0;
  let arv = 0, arvSure = false;
  const arvComps = (b?.comps || []).filter((x) => !x.use || x.use === "arv");
  const renovatedN = arvComps.filter(renovated).length;
  const conf = Number(b?.arvConfidence) || 0;
  if (bArv && cArv) {
    const split = Math.abs(bArv - cArv) / Math.min(bArv, cArv);
    if (split * 100 <= s.arvSplitPct) {
      arv = bArv; arvSure = true;
      reasons.push(`ARV ${k(bArv)} from Bricked; our comps agree (${k(cArv)}, ${Math.round(split * 100)}% apart)`);
    } else {
      arv = Math.min(bArv, cArv);
      reasons.push(`ARV reads disagree: Bricked ${k(bArv)} vs our comps ${k(cArv)} (${Math.round(split * 100)}% apart) — not sure enough to send`);
    }
  } else if (bArv) {
    arv = bArv;
    arvSure = conf >= 0.85 && renovatedN >= 3;
    reasons.push(`ARV ${k(bArv)} from Bricked, ${Math.round(conf * 100)}% sure, ${renovatedN} renovated comps${arvSure ? "" : " — not enough on its own"}`);
  } else if (cArv) {
    arv = cArv;
    arvSure = Number(c.n) >= 4;
    reasons.push(`ARV ${k(cArv)} from our comps (${Number(c.n) || 0})${arvSure ? "" : " — too few on their own"}`);
  }
  if (!arv) {
    return { arv: 0, rehab: 0, rehabWhy: "", investorPrice: 0, walkAway: 0, open: 0, grade: "C", triage: "unknown", spread: null,
      killers, turnkey: Boolean(turnkeyBy), misses: ["arv"], reasons: ["no ARV from any read"] };
  }
  if (!arvSure) misses.push("arv");

  /* --- rehab: the best evidence, never under the floor --- */
  const floors = normalizeRehabFloors(s.rehabFloorByEra || {});
  const floor = rehabFloor({ sqft: reads.sqft, yearBuilt: reads.yearBuilt, condition: b?.condition, countyCondition: reads.countyCondition, said, remarks, floors, minRehab: s.minRehab });
  const photos = Number(reads.scope?.photos) || 0;
  const scoped = photos >= 8 && Number(reads.scope?.total) > 0 ? Number(reads.scope.total) : 0;
  const described = b?.described && Number(b?.repairs) > 0 ? Number(b.repairs) : 0;
  const theirs = Number(reads.theirRepairs) > 0 ? Number(reads.theirRepairs) : 0;
  const best = scoped || described;
  let rehab = Math.max(floor.floor, best);
  let rehabWhy = best > floor.floor ? (scoped ? `the photo scope (${photos} photos)` : "Bricked's line items for the described work") : floor.why;
  if (theirs > rehab) { rehab = theirs; rehabWhy = "their own repair figure"; }
  rehab = Math.round(rehab / 500) * 500;
  const rehabEvidence = Boolean(scoped || described || theirs || floor.tier !== "age" || Number(b?.condition) > 0 || Number(reads.countyCondition) > 0);
  if (!rehabEvidence) misses.push("rehab");
  reasons.push(`rehab ${k(rehab)}: ${rehabWhy}`);

  /* --- the investor price, and the county's cross-check --- */
  const investorPrice = Math.round((s.maoPct / 100) * arv - rehab);
  const zipRow = ratios?.zips?.[String(reads.zip || "")];
  const ratio = zipRow && zipRow.n >= s.minZipFlips ? { ...zipRow, basis: `ZIP ${reads.zip}` } : null;
  if (ratio?.p75 && investorPrice > ratio.p75 * arv) {
    misses.push("zip");
    reasons.push(`${k(investorPrice)} is over what flippers paid in ${ratio.basis} (${Math.round(ratio.p75 * 100)}% of resale, top quarter of ${ratio.n})`);
  }

  /* --- the numbers --- */
  const cap = list > 0 ? (list * s.maxPctOfList) / 100 : Infinity;
  const walkAway = Math.max(0, round250(Math.min(investorPrice - s.minFee, cap)));
  const open = Math.max(0, Math.min(round250(investorPrice - s.targetFee), walkAway));
  if (list > 0 && investorPrice - s.minFee > cap) reasons.push(`capped at ${s.maxPctOfList}% of the ${k(list)} list`);

  /* --- grade and triage --- */
  let grade = misses.length === 0 ? "A" : misses.length === 1 ? "B" : "C";
  if (killers.length) { grade = "C"; reasons.push(`killer facts: ${killers.join(", ")}`); }
  if (turnkeyBy) { grade = "C"; reasons.push(`turnkey: ${turnkeyBy}`); }
  if (!(walkAway > 0)) grade = "C";
  const t = turnkeyBy ? { triage: "turnkey", spread: null, against: null } : triageOf({ walkAway, sellerNumber: reads.sellerNumber, list });
  return { arv: Math.round(arv), rehab, rehabWhy, rehabTier: floor.tier, investorPrice, walkAway, open, grade, triage: t.triage, spread: t.spread, against: t.against,
    killers, turnkey: Boolean(turnkeyBy), misses, reasons };
}

function k(n) {
  const v = Math.round(Number(n) || 0);
  return v >= 1e6 ? `${Math.round(v / 10000) / 100}M` : `${Math.round(v / 1000)}k`;
}
