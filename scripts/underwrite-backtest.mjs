// underwrite-backtest.mjs — would the buyer-view checks have priced our deals
// the way buyers did? Re-underwrites real houses on the live broker in QUIET
// mode (POST /api/offers/automations/underwrite/backtest: checks forced on, no
// tag, no note, no draft, no offer, no event) and compares the numbers before
// and after the checks with what buyers said and what actually sold.
//
//   node scripts/underwrite-backtest.mjs                    the plan and the cost — nothing runs
//   node scripts/underwrite-backtest.mjs --go               run it on every deal
//   node scripts/underwrite-backtest.mjs --go --recent 20   …plus the 20 newest auto-underwrites
//   node scripts/underwrite-backtest.mjs --go --buyers buyers.json
//
// It SPENDS: each house is a real underwrite (Apify comps + listings + the
// photo scan, about $0.6–1.6). That's why it does nothing without --go.
//
// buyers.json (optional, local) maps an address prefix to what buyers said:
//   { "5232 S Yakima": { "arv": 362000, "rehab": 100000 } }
//
// The pass bars (the plan, 2026-10-02):
//   - a deal that SOLD: the buyer line after the checks (maoPct × ARV − repairs)
//     stays within 5% of what the buyer actually paid (contract + fee)
//   - a deal that DIED: the line comes down, and where buyers.json has their
//     numbers, the ARV and rehab move toward them
// Reads GHL_LOCATION_ID from ghl-broker/.env; BROKER_URL defaults to prod.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, "ghl-broker", ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const BROKER = process.env.BROKER_URL || "https://offers.shepflips.com";
const LOC = env.GHL_LOCATION_ID;
if (!LOC) { console.error("ghl-broker/.env needs GHL_LOCATION_ID"); process.exit(1); }
const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const GO = process.argv.includes("--go");
const RECENT = Number(arg("--recent", 0)) || 0;
const BUYERS = arg("--buyers") ? JSON.parse(fs.readFileSync(arg("--buyers"), "utf8")) : {};
const q = `location_id=${encodeURIComponent(LOC)}`;
const get = async (p) => { const r = await fetch(`${BROKER}${p}${p.includes("?") ? "&" : "?"}${q}`); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
const money = (n) => (n == null ? "—" : `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`);
const pct = (a, b) => (a && b ? `${a > b ? "+" : ""}${Math.round(((a - b) / b) * 1000) / 10}%` : "—");

// What to run: every deal (sold and dead alike), and optionally the newest
// auto-underwrites (the acceptance-risk read: how much lower would we offer?).
const { deals = [] } = await get("/api/offers/deals?limit=500");
const items = deals.map((o) => ({
  address: o.address, kind: "deal", stage: o.deal?.stage,
  paid: o.deal?.stage === "closed" || o.deal?.stage === "buyer_found" || o.deal?.stage === "assigned"
    ? (Number(o.deal.contractPrice) || 0) + (Number(o.deal.assignmentFee) || 0) : null,
}));
if (RECENT) {
  const { offers = [] } = await get(`/api/offers?lean=1&limit=2000`);
  const seen = new Set(items.map((i) => i.address));
  for (const o of offers.filter((x) => x.autoUnderwrite && x.status !== "draft" && !seen.has(x.address)).slice(0, RECENT)) {
    items.push({ address: o.address, kind: "recent", stage: o.status, paid: null });
    seen.add(o.address);
  }
}
console.log(`${items.length} houses (${items.filter((i) => i.kind === "deal").length} deals${RECENT ? `, ${items.filter((i) => i.kind === "recent").length} recent underwrites` : ""}) — about $${Math.round(items.length * 0.6)}–$${Math.round(items.length * 1.6)} of Apify + photo scans`);
if (!GO) {
  for (const i of items) console.log(`  ${i.kind.padEnd(6)} ${String(i.stage || "").padEnd(13)} ${i.address}`);
  console.log("\nNothing ran. Add --go to run the quiet backtest (it spends).");
  process.exit(0);
}

const { normalizeUsAddress } = await import(path.join(root, "shared", "us-address.js"));
const settings = (await get("/api/offers/settings")).settings || {};
const maoPct = Number(settings.maoPctOfArv) || 75;
const line = (arv, repairs) => (arv ? Math.round((maoPct / 100) * arv - (repairs || 0)) : null);

const started = await fetch(`${BROKER}/api/offers/automations/underwrite/backtest?${q}`, {
  method: "POST", headers: { "content-type": "application/json" },
  // The short USPS form ("22018 76th Ave W, Edmonds, WA 98026"): deal records
  // carry the long one ("…Avenue West, Edmonds, Washington 98026"), which
  // Zillow's lookup matches less often.
  body: JSON.stringify({ items: items.map((i) => ({ address: normalizeUsAddress(i.address) })) }),
}).then((r) => r.json());
if (!started.ok) { console.error(started.error || "backtest didn't start"); process.exit(1); }

const results = [];
for (const [n, j] of started.jobs.entries()) {
  const item = items[n];
  if (!j.jobId) { results.push({ ...item, error: j.skipped || "not started" }); continue; }
  let job = null;
  for (let t = 0; t < 180; t++) {
    job = (await get(`/api/offers/automations/underwrite?jobId=${encodeURIComponent(j.jobId)}`)).job;
    if (["done", "held", "error", "canceled"].includes(job?.status)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const before = job?.checksBefore || { arv: job?.arv, repairs: job?.repairs };
  results.push({ ...item, job, before, after: { arv: job?.arv, repairs: job?.repairs } });
  process.stdout.write(".");
}
console.log("\n");

let passSold = 0, failSold = 0, passDead = 0, failDead = 0;
const moves = [];
for (const r of results) {
  if (r.error || !r.job || r.job.status === "error") { console.log(`✗ ${r.address}: ${r.error || r.job?.error || "no result"}`); continue; }
  const lb = line(r.before.arv, r.before.repairs);
  const la = line(r.after.arv, r.after.repairs);
  // Zillow without a record of the house means no size, no photos, no scope:
  // the run can't price it, so it isn't counted either way.
  const partial = (r.job.warnings || []).some((w) => /^Zillow listing:/.test(w)) || !r.job.photosAnalyzed;
  if (partial) {
    console.log(`${r.address}  [${r.kind}${r.stage ? ` · ${r.stage}` : ""}]`);
    console.log(`  couldn't fully re-underwrite — ${(r.job.warnings || []).find((w) => /^Zillow listing:/.test(w)) || "no listing photos"}; ARV ${money(r.before.arv)} → ${money(r.after.arv)} on unsized comps (not counted)`);
    continue;
  }
  if (lb && la) moves.push((la - lb) / lb);
  const said = Object.entries(BUYERS).find(([k]) => r.address.toLowerCase().startsWith(k.toLowerCase()))?.[1] || null;
  let verdict = "";
  if (r.paid) {
    const ok = la != null && la >= r.paid * 0.95;
    ok ? passSold++ : failSold++;
    verdict = ok ? "PASS (sold — still priced to what the buyer paid)" : `FAIL (sold at ${money(r.paid)}; the checks would price ${pct(la, r.paid)})`;
  } else if (r.kind === "deal") {
    const towardArv = said?.arv ? Math.abs(r.after.arv - said.arv) <= Math.abs(r.before.arv - said.arv) : true;
    const towardRehab = said?.rehab ? Math.abs(r.after.repairs - said.rehab) <= Math.abs(r.before.repairs - said.rehab) : true;
    const ok = la != null && lb != null && la <= lb && towardArv && towardRehab;
    ok ? passDead++ : failDead++;
    verdict = ok ? "PASS (came down toward the buyers)" : "FAIL (didn't move toward the buyers)";
  }
  console.log(`${r.address}  [${r.kind}${r.stage ? ` · ${r.stage}` : ""}]`);
  console.log(`  ARV ${money(r.before.arv)} → ${money(r.after.arv)}   repairs ${money(r.before.repairs)} → ${money(r.after.repairs)}   buyer line ${money(lb)} → ${money(la)}${said ? `   buyers said ARV ${money(said.arv)}, rehab ${money(said.rehab)}` : ""}${r.paid ? `   paid ${money(r.paid)}` : ""}`);
  for (const l of r.job.checks ? (await import(path.join(root, "shared", "underwrite-checks.js"))).checksLines(r.job.checks) : []) console.log(`    · ${l}`);
  if (verdict) console.log(`  ${verdict}`);
}
const sorted = moves.sort((a, b) => a - b);
const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
console.log(`\nSold deals: ${passSold} pass, ${failSold} fail · Dead deals: ${passDead} pass, ${failDead} fail`);
console.log(`Median change in the buyer line across ${moves.length} houses: ${Math.round(med * 1000) / 10}% (how much lower we'd offer — the acceptance risk)`);
