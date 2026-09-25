// current-offer-report.mjs — what the current-offer rule does to the live book,
// before and after it ships. Read-only: it GETs the offer list and each
// contact's thread, and writes nothing anywhere.
//
//   node scripts/current-offer-report.mjs            every house with >1 offer
//   node scripts/current-offer-report.mjs --all      every live house
//
// Reads GHL_TOKEN + GHL_LOCATION_ID from ghl-broker/.env and the broker at
// BROKER_URL (default https://offers.shepflips.com). For each contact+house it
// prints the row the rule calls current, the row the OLD send path would have
// picked (first open row, newest created), and whether paper at the current
// row's number would be held because we texted lower since (paperCheck).
// Contacts are printed by id, never by name.

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
if (!LOC || !env.GHL_TOKEN) { console.error("ghl-broker/.env needs GHL_TOKEN and GHL_LOCATION_ID"); process.exit(1); }
const ALL = process.argv.includes("--all");

const { groupHouses, resolveHouse, paperCheck, pricedAt } = await import(path.join(root, "shared", "current-offer.js"));
const { effectiveStatus, OPEN_STATUSES } = await import(path.join(root, "shared", "offer-status.js"));
const { buildTranscript } = await import(path.join(root, "ghl-broker", "enrich.js"));
const { makeClient } = await import(path.join(root, "ghl-broker", "ghl.js"));

const r = await fetch(`${BROKER}/api/offers?location_id=${encodeURIComponent(LOC)}&lean=1&limit=2000`);
if (!r.ok) { console.error(`offer list: HTTP ${r.status}`); process.exit(1); }
const { offers: lean } = await r.json();
// Houses with more than one row are read in full: a broker older than this
// change leaves `revisions` off the lean row, and a hand re-price is a price
// move the rule has to see.
const full = new Map();
{
  const multiIds = [...groupHouses(lean).values()].filter((rows) => rows.filter((o) => o.status !== "draft").length > 1).flat().map((o) => o.id);
  for (const id of multiIds) {
    const d = await fetch(`${BROKER}/api/offers/${encodeURIComponent(id)}?location_id=${encodeURIComponent(LOC)}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (d?.offer) full.set(id, d.offer);
  }
}
const offers = lean.map((o) => full.get(o.id) || o);
const client = makeClient(env.GHL_TOKEN);
const threads = new Map();
const thread = async (contactId) => {
  if (!threads.has(contactId)) {
    threads.set(contactId, await buildTranscript(client, LOC, contactId, { maxCallTranscripts: 0 }).then((t) => t.text || "").catch((e) => `!${e.message}`));
  }
  return threads.get(contactId);
};

const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");
const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const row = (o) => `${o.id.slice(0, 8)} ${money(o.cashAmount).padStart(11)} ${String(effectiveStatus(o)).padEnd(11)} priced ${day(pricedAt(o))}${o.pin?.at ? " PINNED" : ""}`;
// The old send path: open, priced, not a deal, newest created first.
const oldPick = (rows) => [...rows]
  .filter((o) => o.status !== "draft" && !o.deal && Number(o.cashAmount) > 0 && OPEN_STATUSES.has(effectiveStatus(o)))
  .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;

let houses = 0, multi = 0, disagree = 0, held = 0;
for (const rows of groupHouses(offers).values()) {
  const live = rows.filter((o) => o.status !== "draft");
  if (!live.length) continue;
  houses++;
  if (live.length > 1) multi++;
  if (!ALL && live.length < 2) continue;
  const { current, superseded } = resolveHouse(rows);
  const old = oldPick(rows);
  const differs = Boolean(old) && old.id !== current.id;
  if (differs) disagree++;
  let paper = "";
  if (!current.deal && ["new", "sent", "countered"].includes(effectiveStatus(current))) {
    const t = await thread(current.contactId);
    if (t.startsWith("!")) paper = `thread unreadable (${t.slice(1, 60)})`;
    else {
      const c = paperCheck({ offer: current, transcript: t });
      if (!c.ok) { held++; paper = `PAPER HELD — ${c.reason}`; }
    }
  }
  console.log(`\n${current.address}  · contact ${current.contactId}`);
  console.log(`  current     ${row(current)}`);
  for (const o of superseded) console.log(`  superseded  ${row(o)}`);
  if (differs) console.log(`  ! the old send path would have sent ${old.id.slice(0, 8)} at ${money(old.cashAmount)}`);
  if (paper) console.log(`  ${paper}`);
}
console.log(`\n${houses} houses · ${multi} with more than one offer · ${disagree} where the old send path picked a different row · ${held} whose paper would be held now`);
