// report-house-duplicates.mjs — read only: the houses that still hold more
// than one offer row for the same agent.
//
// The editor keeps one row per house from 2026-10-23 (shared/current-offer.js
// rowOnHouse): a New offer on a house that has a row opens it, and Send turns
// a draft into the offer on the same row. Rows made before that are still
// there — a draft beside the offer, an August revision beside the July one.
// This lists them so Matt can decide what to clean up. It changes nothing.
//
// Prints offer ids, statuses and the street only (no names, phones or
// message text). Needs the live database: DATABASE_URL — the broker's Render
// Shell has it. Run from ghl-broker/:
//
//   node scripts/report-house-duplicates.mjs                    every house with 2+ rows
//   node scripts/report-house-duplicates.mjs --drafts-only      only houses where a draft sits beside another row

import { store } from "../store.js";
import { groupHouses, resolveHouse, isDraftOffer } from "../shared/current-offer.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ""; };
const draftsOnly = argv.includes("--drafts-only");
const locationId = flag("--location") || process.env.GHL_LOCATION_ID || "";
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set: this reads the live database (run it in the broker's Render Shell)"); process.exit(1); }
if (!locationId) { console.error("--location <id> or GHL_LOCATION_ID required"); process.exit(1); }

await store.init();
const rows = await store.listOffers(locationId, { limit: 5000, lean: true });
const houses = [...groupHouses(rows.filter((o) => o.contactId)).values()].filter((list) => list.length > 1);
let shown = 0;
for (const list of houses) {
  const drafts = list.filter(isDraftOffer);
  if (draftsOnly && !(drafts.length && drafts.length < list.length)) continue;
  const { current } = resolveHouse(list);
  shown += 1;
  console.log(`${String(list[0].address || "").split(",")[0]} — ${list.length} rows`);
  for (const o of list) {
    console.log(`   ${o.id}  ${String(o.status || "").padEnd(12)} ${o.cashAmount ? `$${Math.round(o.cashAmount).toLocaleString("en-US")}` : "—"}${o === current ? "  ← current" : ""}${o.deal ? "  (deal)" : ""}`);
  }
}
console.log(`\n${shown} house${shown === 1 ? "" : "s"} with more than one row (${rows.length} rows read). Nothing was changed.`);
process.exit(0);
