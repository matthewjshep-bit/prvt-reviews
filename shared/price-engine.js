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
//   the target fee ($30k). Both capped at 90% of list, and both at the seller's own number when
//   they said one (Matt, 2026-11-09: never more than they said they'd take).
// - Grade A: the ARV is sure, the rehab has evidence, the house is in the box, not turnkey, no
//   killer facts. B: one miss. C: two or more, or any killer, kind or turnkey hold. What the
//   engine can't know is a miss (audit 2026-11-09): an uncapped walk-away over the list price, or
//   more than `overSellerPct` over the seller's number (a likely ARV error, triage "over_theirs");
//   an ARV carried only by price-guessed comps that reached past the first ring, across a main
//   road or past the era band; a house Zillow didn't type ("kind"); their repair figure at or
//   under the floor, or a scope from under 8 photos (raises the rehab, never evidence).
// - Triage: walk-away ÷ the seller's number (theirs when said, else list): hot ≥ 95%, workable
//   ≥ 85%, long shot ≥ 70%, no fit below. Agreements happen within 5% (23 → 4 deals); 5–10% went
//   17 → 0 before anything could move up.
// - Grade B opens lower (Matt, 2026-11-10: the less sure the engine is, the lower it opens):
//   gradeBOpen is the open less `gradeBOpenPct` (10), to the $250. Too low costs a no or a counter;
//   too high costs a re-trade after the yes.
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
// An unfinished new build (audit 2026-11-09): an 85%-built 2024 house was priced as a flip with
// $114k of rehab, graded A, and a builder later bid about twice that to finish it. "New
// construction windows" is a part, not the house; a bare "unfinished" is a basement.
const NEW_BUILD_RX = /\bnew[\s-]+construction\b(?!\s+(?:windows?|vinyl|doors?|style|grade|quality|materials?))|\b\d{1,2}\s*(?:%|percent)\s*(?:complete|completed|done|finished)\b|\bunder\s+construction\b|\bbuilder\s+(?:went\s+under|walked(?:\s+away)?|(?:went\s+)?bankrupt)\b|\bunfinished\s+(?:new\s+)?build\b/i;
const NEW_BUILD_YEARS = 2;

/**
 * killersOf({ homeType, lotSqft, said, remarks, yearBuilt, currentYear }) → ["manufactured", "rural", "teardown", …]
 * The facts that keep a house from a machine number: wrong asset for our buyers, a bank's sale,
 * someone else bidding, another wholesaler's paper, a build nobody finished. Each one cost a deal
 * (post-mortems 2026-09-10, 10-12, 10-21; audit 11-09). `currentYear` comes from the caller (no
 * clock here): a house built in the last two years is a new build.
 */
export function killersOf({ homeType = "", lotSqft = 0, said = "", remarks = "", yearBuilt = 0, currentYear = 0 } = {}) {
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
  const built = Number(yearBuilt) || 0, now = Number(currentYear) || 0;
  if ((built > 0 && now > 0 && built >= now - NEW_BUILD_YEARS) || NEW_BUILD_RX.test(words)) out.push("new_build");
  return out;
}

// What a comps-only ARV can't vouch for (audit 2026-11-09, UWM-02/BT-03): four comps is the comps
// tool's own cap, so "n ≥ 4" is always true. An ARV carried only by price-guessed comps (fewer than
// three whose own listings say remodeled) is not sure once it reached past the first ring, took a
// comp from across a main road or leaned on the era band giving way; a gut check never is. A read
// that never said how far it reached (no `listing`) is judged as before.
const FIRST_RING_MILES = 0.5;
const LISTING_CARRIES = 3;
function weakReach(c = {}) {
  if (c.gutCheck === true) return "a gut check on a few sales";
  const listing = Number(c.listing);
  if (c.listing == null || !Number.isFinite(listing) || listing >= LISTING_CARRIES) return "";
  const why = [
    Number(c.radius) > FIRST_RING_MILES ? `reached ${Number(c.radius)} mi` : "",
    Number(c.acrossInArv) > 0 ? `took ${Number(c.acrossInArv)} from across a main road` : "",
    c.eraGivesWay === true ? "let the era band give way" : "",
  ].filter(Boolean);
  return why.length ? `price-guessed comps (${listing} say remodeled in their own listings) that ${why.join(", ")}` : "";
}

const usd = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

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
 *   list, sellerNumber, zip, sqft, yearBuilt, lotSqft, homeType, currentYear
 *   bricked  { arv, arvConfidence (0–1), asIs, repairs, described, comps: [{ use, renovated, renovationScore }], condition }
 *   comps    { arv, n, listing, radius, acrossInArv, eraGivesWay, gutCheck }
 *                                  our own Zillow read, when one was taken, and how far it reached
 *   scope    { total, photos }     the photo scan's priced scope
 *   theirRepairs                   the agent's or seller's own repair figure
 *   priorRehab                     the house's highest rehab read in the last 14 days (shadowPrice)
 *   countyCondition                King County's condition code (1 poor … 5 very good)
 *   said, remarks                  the agent's words, the listing remarks
 *   saidNow                        the text that started the run alone, when `said` also carries
 *                                  their earlier lines about the house (readsFrom): those lines add
 *                                  killers and cost, never rehab evidence
 * ratios: shared/kc-flip-ratios.js KC_FLIP_RATIOS (optional)
 */
// Under either, a "list price" is not one: no house we buy sells for under $20k or 15% of its ARV.
export const LIST_MIN = 20000;
export const LIST_MIN_OF_ARV = 0.15;

export function priceHouse(reads = {}, settings = {}, { ratios = null } = {}) {
  const s = normalizePricingV2(settings);
  const reasons = [];
  const misses = [];
  // One miss per thing the engine isn't sure of: an ARV that's both thin and over the list is still
  // one "arv".
  const miss = (m) => { if (!misses.includes(m)) misses.push(m); };
  const b = reads.bricked || null;
  const c = reads.comps && Number(reads.comps.arv) > 0 ? reads.comps : null;
  let list = Number(reads.list) || 0;
  const said = String(reads.said || "");
  const remarks = String(reads.remarks || "");

  /* --- killers and turnkey --- */
  const killers = killersOf({ homeType: reads.homeType, lotSqft: reads.lotSqft, said, remarks, yearBuilt: reads.yearBuilt, currentYear: reads.currentYear });
  const turnkeyBy = b?.asIs > 0 && b?.arv > 0 && b.asIs >= (b.arv * s.turnkeyPct) / 100
    ? `Bricked's as-is is ${Math.round((b.asIs / b.arv) * 100)}% of its ARV`
    : saysTurnkey(said) ? "the agent says it's turnkey" : "";
  // A house Zillow didn't type could be anything (a condo, a lot, a park home): the kind holds
  // never got to look at it (audit 2026-11-09, UWP-15).
  const untyped = !String(reads.homeType || "").trim();

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
    const weak = weakReach(c);
    arvSure = Number(c.n) >= 4 && !weak;
    reasons.push(`ARV ${k(cArv)} from our comps (${Number(c.n) || 0})${weak ? `: ${weak}, not sure enough on their own` : arvSure ? "" : " — too few on their own"}`);
  }
  if (!arv) {
    return { arv: 0, rehab: 0, rehabWhy: "", investorPrice: 0, walkAway: 0, open: 0, grade: "C", triage: "unknown", spread: null,
      overList: false, overTheirs: false, killers, turnkey: Boolean(turnkeyBy), misses: ["arv"], reasons: ["no ARV from any read"] };
  }
  if (!arvSure) miss("arv");
  if (untyped) { miss("kind"); reasons.push("Zillow didn't say what kind of house this is"); }
  // A "list price" a house could never sell for is a rent or a typo (the 2026-11-04 backtest: Zillow's
  // $2,900 a month on a Des Moines rental capped the walk-away at $2,500). Measure against nothing.
  if (list > 0 && (list < LIST_MIN || list < arv * LIST_MIN_OF_ARV)) {
    reasons.push(`$${Math.round(list).toLocaleString("en-US")} isn't a sale price for a ${k(arv)} house (a month's rent?) — not measured against`);
    list = 0;
  }

  /* --- rehab: the best evidence, never under the floor --- */
  const floors = normalizeRehabFloors(s.rehabFloorByEra || {});
  const floor = rehabFloor({ sqft: reads.sqft, yearBuilt: reads.yearBuilt, condition: b?.condition, countyCondition: reads.countyCondition, said, remarks, floors, minRehab: s.minRehab });
  // The tier the evidence check reads: heavy words heard only in their earlier lines raise the floor
  // above but never vouch for it (they never made a house grade A before the engine heard them).
  const vouches = reads.saidNow != null && String(reads.saidNow) !== said
    ? rehabFloor({ sqft: reads.sqft, yearBuilt: reads.yearBuilt, condition: b?.condition, countyCondition: reads.countyCondition, said: String(reads.saidNow || ""), remarks, floors, minRehab: s.minRehab })
    : floor;
  const photos = Number(reads.scope?.photos) || 0;
  const scopeTotal = Number(reads.scope?.total) > 0 ? Number(reads.scope.total) : 0;
  const scoped = photos >= 8 ? scopeTotal : 0;
  // A scan of fewer than 8 photos is no evidence, but a heavier read than the floor is never thrown
  // away (audit 2026-11-09: one photo read 84k on a house the floor priced at 60k and graded A).
  const thinScope = photos < 8 ? scopeTotal : 0;
  const described = b?.described && Number(b?.repairs) > 0 ? Number(b.repairs) : 0;
  const theirs = Number(reads.theirRepairs) > 0 ? Number(reads.theirRepairs) : 0;
  const best = scoped || described;
  let rehab = Math.max(floor.floor, best);
  let rehabWhy = best > floor.floor ? (scoped ? `the photo scope (${photos} photos)` : "Bricked's line items for the described work") : floor.why;
  if (thinScope > rehab) { rehab = thinScope; rehabWhy = `the photo scope (${photos} photo${photos === 1 ? "" : "s"}, too few to count as evidence)`; }
  if (theirs > rehab) { rehab = theirs; rehabWhy = "their own repair figure"; }
  rehab = Math.round(rehab / 500) * 500;
  // What this read alone says, before an earlier, heavier read of the same house is kept.
  const rehabOwn = rehab;
  const prior = Number(reads.priorRehab) > 0 ? Math.round(Number(reads.priorRehab) / 500) * 500 : 0;
  if (prior > rehab) { rehab = prior; rehabWhy = `an earlier read of this house in the last two weeks (this one read ${k(rehabOwn)})`; }
  // Their figure is evidence only above the floor: at or under it, it says nothing the floor didn't
  // (a 60k figure that equalled the floor earned grade A, audit 2026-11-09).
  const theirsCounts = theirs > floor.floor;
  const rehabEvidence = Boolean(scoped || described || theirsCounts || vouches.tier !== "age" || Number(b?.condition) > 0 || Number(reads.countyCondition) > 0);
  if (!rehabEvidence) miss("rehab");
  reasons.push(`rehab ${k(rehab)}: ${rehabWhy}`);

  /* --- the investor price, and the county's cross-check --- */
  const investorPrice = Math.round((s.maoPct / 100) * arv - rehab);
  const zipRow = ratios?.zips?.[String(reads.zip || "")];
  const ratio = zipRow && zipRow.n >= s.minZipFlips ? { ...zipRow, basis: `ZIP ${reads.zip}` } : null;
  if (ratio?.p75 && investorPrice > ratio.p75 * arv) {
    miss("zip");
    reasons.push(`${k(investorPrice)} is over what flippers paid in ${ratio.basis} (${Math.round(ratio.p75 * 100)}% of resale, top quarter of ${ratio.n})`);
  }

  /* --- the numbers --- */
  // The walk-away the reads alone give, before any cap: the caps below can hide a wrong ARV, so the
  // checks measure this one.
  const rawWalk = investorPrice - s.minFee;
  const cap = list > 0 ? (list * s.maxPctOfList) / 100 : Infinity;
  let walkAway = Math.max(0, round250(Math.min(rawWalk, cap)));
  let open = Math.max(0, Math.min(round250(investorPrice - s.targetFee), walkAway));
  if (list > 0 && rawWalk > cap) reasons.push(`capped at ${s.maxPctOfList}% of the ${k(list)} list`);
  // Over the list price it is not a steal: the comps or the scope are wrong. The full run has held
  // this since 2026-10-14 (overListHold in auto-underwrite.js, the same words); the engine lost it
  // and a walk-away 1.2x the list went out capped (audit 2026-11-09). Between the cap and the list
  // it is still only the cap.
  const overList = list > 0 && rawWalk > list;
  if (overList) {
    miss("arv");
    reasons.push(`our walk-away (${usd(rawWalk)}) came out above the ${usd(list)} list price: the comps or the scope are off, so a person should look before it goes anywhere`);
  }
  // Matt (2026-11-09, binding): the machine never offers more than the seller said they'd take.
  // The open and the walk-away stop at their number (down to the $250); an uncapped walk-away more
  // than `overSellerPct` over it is a likely ARV error, held for him, never "hot". Only lowers.
  const seller = Number(reads.sellerNumber) > 0 ? Number(reads.sellerNumber) : 0;
  let overTheirs = false;
  if (seller > 0) {
    if (rawWalk > seller * (1 + s.overSellerPct / 100)) {
      overTheirs = true;
      miss("arv");
      reasons.push(`our walk-away is ${Math.round((rawWalk / seller - 1) * 100)}% over their number: the ARV is likely high`);
    }
    const ceiling = Math.floor(seller / 250) * 250;
    if (walkAway > ceiling) { walkAway = ceiling; reasons.push(`capped at their ${k(seller)}`); }
    open = Math.min(open, walkAway);
  }

  /* --- grade and triage --- */
  let grade = misses.length === 0 ? "A" : misses.length === 1 ? "B" : "C";
  if (killers.length) { grade = "C"; reasons.push(`killer facts: ${killers.join(", ")}`); }
  if (turnkeyBy) { grade = "C"; reasons.push(`turnkey: ${turnkeyBy}`); }
  if (!(walkAway > 0)) grade = "C";
  const t = turnkeyBy ? { triage: "turnkey", spread: null, against: null }
    : overTheirs ? { triage: "over_theirs", spread: Math.round((rawWalk / seller) * 1000) / 1000, against: "their number" }
    : triageOf({ walkAway, sellerNumber: reads.sellerNumber, list });
  return { arv: Math.round(arv), rehab, rehabOwn, rehabWhy, rehabTier: floor.tier, investorPrice, rawWalk: Math.round(rawWalk), walkAway, open, grade,
    triage: t.triage, spread: t.spread, against: t.against, overList, overTheirs, sellerNumber: seller,
    killers, turnkey: Boolean(turnkeyBy), misses, reasons };
}

/**
 * gradeBOpen(v2, settings) → the number a grade-B house opens at, or 0 for anything not grade B.
 *
 * Matt (2026-11-10): every house the engine can price gets a number, and the less sure it is, the
 * lower it opens. Grade B opens `gradeBOpenPct` (10) under the engine's own open, to the $250 the
 * way the open is rounded. The open already sits under the walk-away, the list cap and the seller's
 * number, so this only ever lowers it.
 */
export function gradeBOpen(v2, settings = {}) {
  const open = Number(v2?.open) || 0;
  if (v2?.grade !== "B" || !(open > 0)) return 0;
  const pct = normalizePricingV2(settings).gradeBOpenPct;
  return Math.max(0, Math.min(open, round250(open * (1 - pct / 100))));
}

function k(n) {
  const v = Math.round(Number(n) || 0);
  return v >= 1e6 ? `${Math.round(v / 10000) / 100}M` : `${Math.round(v / 1000)}k`;
}
