// price-engine-backtest.mjs — score the offer engine v2 against what we know, read-only.
//
//   node scripts/price-engine-backtest.mjs                  # reads the live broker (GETs only)
//   node scripts/price-engine-backtest.mjs --from offers.json [--deals deals.json] [--hindsight]
//
// Answer keys (2026-11-04 plan):
//   - Matt's own priced offers: his ARV and rehab, and his inputs run through the SAME 70% formula,
//     so his 75% habit doesn't read as the engine being low. ARV and rehab are scored separately.
//   - Bricked reads beside his ARV on the same house.
//   - The deals: the walk-away against the contract (closed deals should land within −5%…0%;
//     the ones that died on price or rehab ≥ 10% under). A deal with no size on record is priced on
//     the $60k rehab ballpark rather than skipped (2026-11-09: 10 of 18 deals were skipped).
//     Why a deal fell through is hindsight the engine never has, so it is only passed as the
//     agent's words with --hindsight.
//   - The golden set (shared/fixtures/price-golden.json, when it is committed): the deals we won
//     on Matt's inputs, and the ones that died on the buyers' ARV and rehab (the answer key).
// Prints only street names and numbers; no contact names, phones or emails.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { priceHouse, normalizePricingV2 } from "../shared/price-engine.js";
import { KC_FLIP_RATIOS } from "../shared/kc-flip-ratios.js";
import { goldenBar } from "../shared/price-scorecard.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const HINDSIGHT = process.argv.includes("--hindsight");
const envFile = path.join(root, "ghl-broker", ".env");
const env = fs.existsSync(envFile)
  ? Object.fromEntries(fs.readFileSync(envFile, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]))
  : {};
const BASE = process.env.BROKER_URL || "https://offers.shepflips.com";
const L = env.GHL_LOCATION_ID;
const get = (p) => fetch(`${BASE}${p}${p.includes("?") ? "&" : "?"}location_id=${L}`).then((r) => r.json());

let offers;
if (arg("--from")) offers = Object.values(JSON.parse(fs.readFileSync(arg("--from"), "utf8"))).filter((o) => o && !o.error);
else {
  const lean = (await get("/api/offers?lean=1&limit=2000")).offers || [];
  offers = [];
  for (const r of lean) { const j = await get(`/api/offers/${r.id}`); if (j.offer) offers.push(j.offer); }
}
const deals = arg("--deals") ? JSON.parse(fs.readFileSync(arg("--deals"), "utf8")).deals : (await get("/api/offers/deals")).deals || [];
const settings = normalizePricingV2({});
const q = (a, p) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) * p)] : null; };
const dist = (a) => (a.length ? `n ${a.length} · p10 ${q(a, 0.1).toFixed(2)} · p25 ${q(a, 0.25).toFixed(2)} · med ${q(a, 0.5).toFixed(2)} · p75 ${q(a, 0.75).toFixed(2)} · p90 ${q(a, 0.9).toFixed(2)}` : "n 0");
const street = (a) => String(a || "").split(",")[0];

const inputsOf = (o) => o.calc?.inputs || o.inputs || {};
const subjectOf = (o) => o.snapshot?.subjectInfo || o.snap?.subject || {};
const hand = (o) => ["revise", "publish", "send"].includes(o.approved?.by) || (o.revisions || []).some((r) => r.by === "you") || !o.autoUnderwrite;
const sqftOf = (o) => Number(subjectOf(o).sqft) || Number((o.revisions || []).find((r) => r.sqft)?.sqft) || 0;
const yearOf = (o) => Number(subjectOf(o).yearBuilt) || Number((o.revisions || []).find((r) => r.yearBuilt)?.yearBuilt) || 0;
const zipOf = (o) => (String(o.address || "").match(/\b(9[0-9]{4})\b/) || [])[1] || "";
// A sure ARV stand-in: we score the rehab and the formula here, with the ARV Matt chose.
const SURE = { arvConfidence: 0.9, comps: [{ renovated: true }, { renovated: true }, { renovated: true }] };

/* 1. Matt's own priced offers: rehab, and the number at one formula. */
const rehabR = [], walkR = [], gradeN = {};
for (const o of offers) {
  const i = inputsOf(o), sqft = sqftOf(o);
  if (!hand(o) || !(o.cashAmount > 0) || !(i.arv > 0) || !(sqft > 300) || o.underwriteModel === "income" || o.underwriteModel === "land") continue;
  const r = priceHouse({ list: i.askingPrice, sqft, yearBuilt: yearOf(o), zip: zipOf(o), bricked: { arv: i.arv, ...SURE } }, settings, { ratios: KC_FLIP_RATIOS });
  if (i.repairs > 0) rehabR.push(r.rehab / i.repairs);
  const mattAt70 = 0.7 * i.arv - (i.repairs || 0) - settings.minFee;
  if (mattAt70 > 0) walkR.push(r.walkAway / mattAt70);
  gradeN[r.grade] = (gradeN[r.grade] || 0) + 1;
}
console.log(`\n1. Matt's own priced offers (his ARV, our rehab and formula)`);
console.log(`   v2 rehab ÷ his rehab:                    ${dist(rehabR)}`);
console.log(`   v2 walk-away ÷ his inputs at 70% − $15k:  ${dist(walkR)}`);
console.log(`   rehab below his on ${rehabR.filter((x) => x < 1).length} of ${rehabR.length} (${Math.round((rehabR.filter((x) => x < 1).length / Math.max(1, rehabR.length)) * 100)}%)`);

/* 2. Bricked's ARV beside his. */
const arvR = [];
for (const o of offers) {
  const b = o.autoUnderwrite?.brickedArv, i = inputsOf(o);
  if (b > 0 && i.arv > 0 && hand(o)) arvR.push(b / i.arv);
}
console.log(`\n2. Bricked ARV ÷ Matt's ARV, same house: ${dist(arvR)}`);

/* 3. The deals. */
console.log(`\n3. Deals: the walk-away against the contract`);
const byId = new Map(offers.map((o) => [o.id, o]));
for (const d of deals) {
  const o = byId.get(d.id) || d;
  const c = d.deal?.ceilingAtPromote, i = inputsOf(o);
  const arv = c?.arv || i.arv, sqft = sqftOf(o);
  if (!(arv > 0)) { console.log(`   ${street(d.address).padEnd(26)} ${d.deal?.stage}: no ARV on record`); continue; }
  // No size: the engine's own $60k ballpark (shared/rehab-floor.js), said so on the line.
  const r = priceHouse({ sqft, yearBuilt: yearOf(o), zip: zipOf(d), bricked: { arv, ...SURE }, said: HINDSIGHT ? d.deal?.fellThroughReason || "" : "" }, settings, { ratios: KC_FLIP_RATIOS });
  const k = (n) => `${Math.round(n / 1000)}k`;
  const miss = r.walkAway / d.deal.contractPrice - 1;
  console.log(`   ${street(d.address).padEnd(26)} ${String(d.deal?.stage).padEnd(14)} contract ${k(d.deal.contractPrice).padStart(6)} · v2 walk-away ${k(r.walkAway).padStart(6)} (${miss >= 0 ? "+" : ""}${Math.round(miss * 100)}%) · rehab ${k(r.rehab)} (${r.rehabTier}${sqft > 0 ? "" : ", no size: the $60k ballpark"}) · grade ${r.grade}`);
}
if (HINDSIGHT) console.log(`   (--hindsight: why each deal fell through was read as the agent's words)`);

/* 4. The golden set: the deals and the buyers' answer key. */
const goldenFile = path.join(root, "shared", "fixtures", "price-golden.json");
if (fs.existsSync(goldenFile)) {
  const golden = JSON.parse(fs.readFileSync(goldenFile, "utf8"));
  const bar = goldenBar(golden, {
    price: ({ deal, arv, rehab }) => priceHouse({ sqft: deal.sqft || 0, yearBuilt: deal.yearBuilt || 0, zip: deal.zip || "", homeType: deal.homeType || "",
      bricked: { arv, ...SURE }, theirRepairs: rehab }, settings, { ratios: KC_FLIP_RATIOS }),
  });
  console.log(`\n4. Golden set (${path.relative(root, goldenFile)})`);
  console.log(`   won, on Matt's inputs: the walk-away reaches the contract on ${bar.won.reached} of ${bar.won.n}`);
  console.log(`   died, on the buyers' ARV and rehab: 10% or more under the contract on ${bar.dead.stayedOut} of ${bar.dead.n}`);
  for (const r of bar.rows) console.log(`   ${String(r.id).padEnd(10)} ${r.outcome.padEnd(5)} on ${r.on.padEnd(6)} walk-away ${Math.round(r.walkAway / 1000)}k vs contract ${Math.round(r.contract / 1000)}k (${r.miss >= 0 ? "+" : ""}${Math.round(r.miss * 100)}%)`);
} else {
  console.log(`\n4. Golden set: shared/fixtures/price-golden.json isn't committed yet, so there is no second bar.`);
}
console.log(`\nAll numbers are at maoPct ${settings.maoPct}, fees ${settings.targetFee}/${settings.minFee}, rehab floors from shared/rehab-floor.js.`);
