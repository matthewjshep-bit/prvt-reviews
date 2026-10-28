// kc-flips.mjs — King County's recorded flips, turned into what investors pay.
//
// Reads the assessor's weekly sales and residential-building files (free, no
// key), finds every buy-then-resell by the same owner (shared/investor-ratio.js),
// drops new construction, and writes:
//   - the buy/resale ratio by ZIP and county-wide, from flips resold in the
//     24 months before --as-of: ARV × ratio = what a flipper pays as-is
//   - the answer key: houses a company that has flipped before bought 2–6
//     months before --as-of and hasn't resold, with what they paid
// to ghl-broker/tmp/kc-flips.json, for scripts/price-bakeoff.mjs.
//
//   node scripts/kc-flips.mjs                     uses the cached county files, downloading them the first time (~170 MB)
//   node scripts/kc-flips.mjs --refresh           downloads fresh files first (the county posts them weekly)
//   node scripts/kc-flips.mjs --as-of 2026-10-01  the date the ratio and the answer key are read as of
//
// Free. Writes no buyer or seller names, only parcels, addresses and prices.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { singleParcelSales, flipPairs, dropRebuilds, ratioTable, openInvestorBuys, RATIO_MIN_N } from "../shared/investor-ratio.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = path.join(root, "ghl-broker", "tmp");
const dir = path.join(tmp, "kc");
const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const REFRESH = process.argv.includes("--refresh");
const asOf = arg("--as-of") ? Date.parse(`${arg("--as-of")}T00:00:00Z`) : Date.now();
if (!Number.isFinite(asOf)) { console.error("--as-of wants YYYY-MM-DD"); process.exit(1); }

const BASE = "https://aqua.kingcounty.gov/extranet/assessor/";
const FILES = [
  { zip: "Real Property Sales.zip", csv: "EXTR_RPSale.csv" },
  { zip: "Residential Building.zip", csv: "EXTR_ResBldg.csv" },
];

fs.mkdirSync(dir, { recursive: true });
for (const f of FILES) {
  const csv = path.join(dir, f.csv);
  if (fs.existsSync(csv) && !REFRESH) continue;
  const zip = path.join(dir, f.zip);
  console.log(`downloading ${f.zip}…`);
  const res = await fetch(BASE + encodeURIComponent(f.zip));
  if (!res.ok) { console.error(`${f.zip}: HTTP ${res.status}`); process.exit(1); }
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", zip, f.csv, "-d", dir]);
  fs.rmSync(zip);
}

// The county quotes every field and never quotes a quote, so a row splits on
// the "," between fields even when a name has a comma in it.
async function* rows(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, file)) });
  let head = null;
  for await (const line of rl) {
    const cells = line.replace(/^"|"$/g, "").split('","').map((c) => c.trim());
    if (!head) { head = cells; continue; }
    yield Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  }
}
const parcelOf = (r) => `${r.Major}-${r.Minor}`;

// Houses: one row per building. A parcel with a second building is counted as
// more than one unit, so it drops out of both the ratio and the answer key.
const buildings = new Map();
for await (const r of rows("EXTR_ResBldg.csv")) {
  const p = parcelOf(r);
  const prev = buildings.get(p);
  if (prev) { prev.units += Number(r.NbrLivingUnits) || 1; continue; }
  const zip = (r.ZipCode || "").slice(0, 5) || (r.Address.match(/\b(98\d{3})\b/) || [])[1] || null;
  buildings.set(p, {
    address: r.Address.replace(/\s+/g, " ").replace(/\s*\b98\d{3}\b\s*$/, "").trim(), zip,
    units: Number(r.NbrLivingUnits) || 1, yearBuilt: Number(r.YrBuilt) || 0, yearRenovated: Number(r.YrRenovated) || 0,
    sqft: Number(r.SqFtTotLiving) || 0, beds: Number(r.Bedrooms) || 0,
    baths: (Number(r.BathFullCount) || 0) + 0.75 * (Number(r.Bath3qtrCount) || 0) + 0.5 * (Number(r.BathHalfCount) || 0),
    condition: Number(r.Condition) || null, grade: Number(r.BldgGrade) || null,
  });
}

// Sales: the last four years, residential (PrincipalUse 6), $50K and up, one
// parcel per deed. Multi-parcel deeds are counted across every use before the
// filter, so a house sold with its neighbour's lot is still left out.
const since = asOf - 4 * 365.25 * 24 * 3600 * 1000;
const all = [];
for await (const r of rows("EXTR_RPSale.csv")) {
  const [m, d, y] = String(r.DocumentDate).split("/").map(Number);
  const at = Date.UTC(y, m - 1, d);
  if (!(at >= since) || at > asOf) continue;
  all.push({ excise: r.ExciseTaxNbr, parcel: parcelOf(r), at, price: Number(r.SalePrice) || 0, buyer: r.BuyerName, seller: r.SellerName, use: r.PrincipalUse });
}
const sales = singleParcelSales(all).filter((s) => s.use === "6" && s.price >= 50000);

const pairs = flipPairs(sales);
const { kept, dropped } = dropRebuilds(pairs, buildings);
const zipOf = (p) => buildings.get(p)?.zip || null;
const table = ratioTable(kept, { asOf, zipOf });

// Only buyers with a flip of a standing house behind them: a builder's lot buy
// isn't a flipper's price.
const flippers = new Set(kept.map((p) => p.flipper));
const open = openInvestorBuys(sales, { asOf, flippers })
  .map((o) => ({ ...o, house: buildings.get(o.parcel) }))
  .filter((o) => o.house && o.house.units === 1 && o.house.sqft > 0 && o.house.yearBuilt && o.house.yearBuilt < new Date(o.boughtAt).getUTCFullYear() && o.bought >= 100000)
  .map(({ parcel, boughtAt, bought, house: h }) => ({
    parcel, address: h.address, zip: h.zip, boughtOn: new Date(boughtAt).toISOString().slice(0, 10), bought,
    sqft: h.sqft, beds: h.beds, baths: h.baths, yearBuilt: h.yearBuilt, condition: h.condition, grade: h.grade,
  }));

const reasons = {};
for (const p of dropped) reasons[p.reason] = (reasons[p.reason] || 0) + 1;
const out = {
  _what: "King County flips → investor buy/resale ratio by ZIP, plus houses a company bought 2–6 months before asOf and hasn't resold (the answer key). Built by scripts/kc-flips.mjs.",
  builtAt: new Date().toISOString(), asOf: new Date(asOf).toISOString().slice(0, 10),
  counts: { sales: sales.length, flips: pairs.length, dropped: reasons, kept: kept.length, inWindow: table.county.n, open: open.length },
  table, open,
};
fs.writeFileSync(path.join(tmp, "kc-flips.json"), JSON.stringify(out, null, 1));

const pct = (x) => (x == null ? "—" : `${Math.round(x * 1000) / 10}%`);
const zips = Object.entries(table.zips).filter(([, s]) => s.n >= RATIO_MIN_N).sort((a, b) => a[1].median - b[1].median);
console.log(`as of ${out.asOf}: ${sales.length.toLocaleString()} residential sales, ${pairs.length} flips (${Object.entries(reasons).map(([k, v]) => `${v} ${k}`).join(", ") || "none dropped"})`);
console.log(`${table.county.n} flips resold in the last ${table.windowMonths} months: investors paid ${pct(table.county.median)} of resale (middle half ${pct(table.county.p25)}–${pct(table.county.p75)})`);
console.log(`${zips.length} ZIPs with ${RATIO_MIN_N}+ flips. Lowest: ${zips.slice(0, 4).map(([z, s]) => `${z} ${pct(s.median)} (${s.n})`).join(", ")}. Highest: ${zips.slice(-4).map(([z, s]) => `${z} ${pct(s.median)} (${s.n})`).join(", ")}`);
console.log(`answer key: ${open.length} houses a known flipper bought 2–6 months ago and hasn't resold`);
console.log(`→ ${path.relative(root, path.join(tmp, "kc-flips.json"))}`);
