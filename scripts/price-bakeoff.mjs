// price-bakeoff.mjs — is Bricked.ai's ARV, turned into an investor price by
// the county's own flips, closer to what investors really pay than InvestorBase?
//
// The plan (2026-10-28, ~/.claude/plans/can-you-do-research-eventual-shell.md):
// 20 houses with a known answer, priced blind.
//   - our deals: what the buyer paid (contract + fee) and the ARV buyers said
//     the house was worth (scripts/backtest-buyers-2026-10.json)
//   - King County houses a known flipper bought 2–6 months ago and hasn't
//     resold (scripts/kc-flips.mjs): what they paid is the as-is investor price
// For each: Bricked's ARV, as-is value and repairs; the investor price
// (ARV × the ZIP's buy/resale ratio); the old rule (ARV × 70% − repairs) as a
// cross-check; and InvestorBase's numbers where Matt has typed them in.
//
//   node scripts/price-bakeoff.mjs                    the houses and their answers — nothing is called
//   node scripts/price-bakeoff.mjs --go               price them on Bricked (each new house is one lookup on the plan)
//   node scripts/price-bakeoff.mjs --go --kc 15       15 county houses instead of 10
//   node scripts/price-bakeoff.mjs --go --fresh       ignore the saved Bricked answers and look again
//
// Needs ghl-broker/tmp/kc-flips.json (node scripts/kc-flips.mjs). --go needs
// BRICKED_API_KEY in ghl-broker/.env or the environment. Deals come from the
// live broker, read-only (GHL_LOCATION_ID); without it the county houses run alone.
//
// InvestorBase: the plan run writes ghl-broker/tmp/investorbase.json with every
// address and empty numbers. Type InvestorBase's ARV and its investor price
// (its MAO) into it; the next run scores them beside Bricked.
//
// Output: ghl-broker/tmp/price-bakeoff-<date>.csv, addresses and prices only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { investorPrice, RATIO_MIN_N } from "../shared/investor-ratio.js";
import { brickedProperty } from "../ghl-broker/price-bricked.js";
import { geocodeAddress } from "../ghl-broker/geocode.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = path.join(root, "ghl-broker", "tmp");
const envFile = path.join(root, "ghl-broker", ".env");
const env = {
  ...(fs.existsSync(envFile) ? Object.fromEntries(fs.readFileSync(envFile, "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")])) : {}),
  ...process.env,
};
const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const GO = process.argv.includes("--go");
const FRESH = process.argv.includes("--fresh");
const KC_N = Number(arg("--kc", 10)) || 0;
const MAO_PCT = Number(arg("--mao", 70)) || 70;
const BUYERS = JSON.parse(fs.readFileSync(arg("--buyers", path.join(root, "scripts", "backtest-buyers-2026-10.json")), "utf8"));
const BROKER = env.BROKER_URL || "https://offers.shepflips.com";

const flipsFile = path.join(tmp, "kc-flips.json");
if (!fs.existsSync(flipsFile)) { console.error("No ghl-broker/tmp/kc-flips.json. Run: node scripts/kc-flips.mjs"); process.exit(1); }
const flips = JSON.parse(fs.readFileSync(flipsFile, "utf8"));
const table = flips.table;

const money = (n) => (n == null ? "—" : `$${Math.round(Number(n)).toLocaleString("en-US")}`);
const err = (got, want) => (got && want ? (got - want) / want : null);
const pct = (x) => (x == null ? "—" : `${x > 0 ? "+" : ""}${Math.round(x * 1000) / 10}%`);
const zipIn = (s) => (String(s).match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || null;
const said = (address) => Object.entries(BUYERS).find(([k]) => !k.startsWith("_") && address.toLowerCase().startsWith(k.toLowerCase()))?.[1] || null;

/* ---------- the houses ---------- */

const houses = [];
if (env.GHL_LOCATION_ID) {
  const r = await fetch(`${BROKER}/api/offers/deals?limit=500&location_id=${encodeURIComponent(env.GHL_LOCATION_ID)}`);
  if (!r.ok) { console.error(`deals: HTTP ${r.status}`); process.exit(1); }
  for (const o of (await r.json()).deals || []) {
    const sold = ["closed", "buyer_found", "assigned"].includes(o.deal?.stage);
    const paid = sold ? (Number(o.deal.contractPrice) || 0) + (Number(o.deal.assignmentFee) || 0) || null : null;
    const s = said(o.address);
    if (!paid && !s?.arv) continue;
    houses.push({ kind: "deal", address: o.address, zip: zipIn(o.address), truthPrice: paid, truthArv: s?.arv || null, note: o.deal?.stage || "" });
  }
} else {
  console.log("No GHL_LOCATION_ID: our deals are left out, the county houses run alone.");
}

// County houses: newest first, one per ZIP, in ZIPs with enough flips for their
// own ratio, inside the price band we buy in.
const seenZip = new Set();
for (const o of [...flips.open].sort((a, b) => b.boughtOn.localeCompare(a.boughtOn))) {
  if (houses.filter((h) => h.kind === "county").length >= KC_N) break;
  if (seenZip.has(o.zip) || (table.zips[o.zip]?.n || 0) < RATIO_MIN_N || o.bought < 200000 || o.bought > 1500000) continue;
  seenZip.add(o.zip);
  houses.push({ kind: "county", address: `${o.address}, WA ${o.zip}`, zip: o.zip, truthPrice: o.bought, truthArv: null, note: `bought ${o.boughtOn}`, facts: o });
}

// InvestorBase, typed in by hand.
const ibFile = path.join(tmp, "investorbase.json");
const ib = fs.existsSync(ibFile) ? JSON.parse(fs.readFileSync(ibFile, "utf8")) : {};
let addedToIb = 0;
for (const h of houses) if (!(h.address in ib)) { ib[h.address] = { arv: null, price: null }; addedToIb++; }
if (addedToIb) {
  ib._what ||= "InvestorBase's numbers for the bake-off: arv = its ARV, price = its investor price / MAO. Leave null where it had none.";
  fs.writeFileSync(ibFile, JSON.stringify(ib, null, 1));
}

const cacheDir = path.join(tmp, "bricked");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const cached = (h) => path.join(cacheDir, `${slug(h.address)}.json`);
const toCall = houses.filter((h) => FRESH || !fs.existsSync(cached(h)));

console.log(`${houses.length} houses: ${houses.filter((h) => h.kind === "deal").length} of our deals, ${houses.filter((h) => h.kind === "county").length} county flipper buys. Ratio table as of ${flips.asOf}.`);
if (!GO) {
  for (const h of houses) console.log(`  ${h.kind.padEnd(6)} ${h.address}  paid ${money(h.truthPrice)}${h.truthArv ? `  buyers' ARV ${money(h.truthArv)}` : ""}  ${h.note}`);
  console.log(`\n${toCall.length} would be new Bricked lookups (${houses.length - toCall.length} saved). InvestorBase sheet: ${path.relative(root, ibFile)}${addedToIb ? ` (${addedToIb} added)` : ""}.`);
  console.log("Nothing was called. Add --go to price them on Bricked.");
  process.exit(0);
}
const apiKey = env.BRICKED_API_KEY;
if (!apiKey) { console.error("BRICKED_API_KEY isn't set (ghl-broker/.env or the environment)."); process.exit(1); }

/* ---------- price them ---------- */

fs.mkdirSync(cacheDir, { recursive: true });
for (const h of houses) {
  if (!FRESH && fs.existsSync(cached(h))) { h.bricked = JSON.parse(fs.readFileSync(cached(h), "utf8")); continue; }
  // The county writes a street and a ZIP, no city; Bricked's search wants the
  // address people write, so the Census matcher fills the city in.
  let q = h.address;
  if (h.kind === "county") q = (await geocodeAddress(h.address, { minPrecision: "address" }))?.matched || h.address;
  try {
    h.bricked = await brickedProperty(q, { apiKey });
    fs.writeFileSync(cached(h), JSON.stringify(h.bricked));
    process.stdout.write(".");
  } catch (e) {
    h.error = e.message;
    process.stdout.write("x");
    if (e.status === 401 || e.status === 402) { console.error(`\n${e.message}. Stopping.`); break; }
  }
}
console.log("\n");

/* ---------- score ---------- */

const rows = [];
for (const h of houses) {
  const b = h.bricked;
  const typed = ib[h.address] || {};
  if (!b) { rows.push({ ...h }); console.log(`✗ ${h.address}: ${h.error || "not priced"}`); continue; }
  const ip = investorPrice({ arv: b.arv, zip: h.zip, table });
  const cross = b.arv ? Math.round((MAO_PCT / 100) * b.arv - (b.repairs || 0)) : null;
  // Bricked's as-is value sitting on the house's own recent sale is the answer
  // read back, not found: counted, and flagged.
  const own = b.subject.lastSale;
  const anchored = !!(own && b.asIs && Math.abs(b.asIs - own.price) / own.price <= 0.01 && Date.now() - own.at < 365 * 24 * 3600 * 1000);
  const arvComps = b.comps.filter((c) => c.use === "arv" && c.selected);
  const row = {
    ...h, arv: b.arv, arvConfidence: b.arvConfidence, asIs: b.asIs, repairs: b.repairs,
    ratio: ip?.ratio ?? null, ratioBasis: ip ? `${ip.basis} (${ip.n})` : "", investorPrice: ip?.price ?? null, cross,
    ibArv: typed.arv ?? null, ibPrice: typed.price ?? null,
    renovatedComps: `${arvComps.filter((c) => c.renovated).length}/${arvComps.length}`, anchored, link: b.links.share,
  };
  row.errArv = err(row.arv, h.truthArv);
  row.errPrice = err(row.investorPrice, h.truthPrice);
  row.errCross = err(row.cross, h.truthPrice);
  row.errAsIs = err(row.asIs, h.truthPrice);
  row.errIbArv = err(row.ibArv, h.truthArv);
  row.errIbPrice = err(row.ibPrice, h.truthPrice);
  rows.push(row);
  console.log(`${h.address}  [${h.kind} · ${h.note}]`);
  console.log(`  Bricked ARV ${money(row.arv)}${row.arvConfidence != null ? ` (conf ${row.arvConfidence})` : ""}, as-is ${money(row.asIs)}${anchored ? " ⚠ = its own last sale" : ""}, repairs ${money(row.repairs)}, ARV comps renovated ${row.renovatedComps}`);
  console.log(`  investor price ${money(row.investorPrice)} at ${row.ratio != null ? `${Math.round(row.ratio * 1000) / 10}%` : "—"} (${row.ratioBasis || "no ratio"})   ARV×${MAO_PCT}%−repairs ${money(cross)}${row.ibPrice || row.ibArv ? `   InvestorBase ARV ${money(row.ibArv)} price ${money(row.ibPrice)}` : ""}`);
  console.log(`  truth: paid ${money(h.truthPrice)}${h.truthArv ? `, buyers' ARV ${money(h.truthArv)}` : ""} → investor price ${pct(row.errPrice)}, cross ${pct(row.errCross)}${h.truthArv ? `, ARV ${pct(row.errArv)}` : ""}${row.errIbPrice != null ? `, InvestorBase price ${pct(row.errIbPrice)}` : ""}`);
}

function score(label, key, filter = () => true) {
  const e = rows.filter(filter).map((r) => r[key]).filter((x) => x != null);
  if (!e.length) return console.log(`  ${label.padEnd(36)} —`);
  const abs = e.map(Math.abs).sort((a, b) => a - b);
  const signed = [...e].sort((a, b) => a - b);
  const within = abs.filter((x) => x <= 0.05).length;
  console.log(`  ${label.padEnd(36)} n=${String(e.length).padEnd(3)} median miss ${pct(abs[abs.length >> 1]).replace("+", "")}, leans ${pct(signed[signed.length >> 1])}, within 5%: ${within}/${e.length}`);
}
console.log("\nHow close (miss = |got − truth| / truth; leans = the median signed miss, + is too high):");
score("Bricked ARV vs buyers' ARV", "errArv");
score("InvestorBase ARV vs buyers' ARV", "errIbArv");
score("Investor price (ARV × ratio)", "errPrice");
score(`ARV × ${MAO_PCT}% − repairs`, "errCross");
score("Bricked as-is, not on its own sale", "errAsIs", (r) => !r.anchored);
score("InvestorBase price", "errIbPrice");
console.log("\nPass bar: Bricked's ARV and the investor price each miss by ~5% or less on the median, and by no more than InvestorBase's.");

const cols = ["kind", "address", "zip", "note", "truthPrice", "truthArv", "arv", "arvConfidence", "asIs", "anchored", "repairs", "ratio", "ratioBasis", "investorPrice", "cross", "ibArv", "ibPrice", "errArv", "errPrice", "errCross", "errAsIs", "errIbArv", "errIbPrice", "renovatedComps", "link", "error"];
const csvCell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const outFile = path.join(tmp, `price-bakeoff-${new Date().toISOString().slice(0, 10)}.csv`);
fs.writeFileSync(outFile, [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n");
console.log(`→ ${path.relative(root, outFile)}`);
