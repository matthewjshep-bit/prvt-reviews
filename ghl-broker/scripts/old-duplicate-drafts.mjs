// old-duplicate-drafts.mjs — one time: close drafts more than 20 days old that
// sit beside a decided row on the same house (shared/stale-unsent.js
// oldDuplicateDrafts). The 2026-10-22 audit found 35 of 42 old drafts were
// these, read in the book as "waiting on you".
//
// Dry run by default: reads the database, writes nothing, prints ids and
// statuses only (no names, no addresses). --write marks each one we_passed,
// "duplicate of a decided row on this house", retired by "duplicate-drafts".
// Nothing is texted and nothing goes to GHL: the agent's real row on the
// house already said what there was to say.
//
// Needs the live database: DATABASE_URL and GHL_LOCATION_ID — the broker's
// Render Shell has both. Run from ghl-broker/:
//
//   node scripts/old-duplicate-drafts.mjs            dry run
//   node scripts/old-duplicate-drafts.mjs --write    closes them

import { store } from "../store.js";
import { oldDuplicateDrafts } from "../shared/stale-unsent.js";
import { sameRaisedHouse } from "../shared/ghl-stages.js";
import { effectiveStatus } from "../shared/offer-status.js";

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const i = argv.indexOf("--location");
const locationId = (i >= 0 ? argv[i + 1] : "") || process.env.GHL_LOCATION_ID || "";
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set: this reads the live database (run it in the broker's Render Shell)"); process.exit(1); }
if (!locationId) { console.error("no location: set GHL_LOCATION_ID or pass --location"); process.exit(1); }

await store.init();
const offers = await store.listOffers(locationId, { limit: 5000, lean: true });
const found = oldDuplicateDrafts(offers, { now: Date.now(), sameHouse: sameRaisedHouse });
console.log(`${found.length} old draft(s) beside a decided row on the same house${write ? "" : " (dry run)"}`);
const byStatus = {};
for (const f of found) byStatus[f.decidedStatus] = (byStatus[f.decidedStatus] || 0) + 1;
console.log("decided row is:", JSON.stringify(byStatus));
for (const f of found) console.log(`  ${f.offerId}  ${f.ageDays}d old  beside ${f.decidedId} (${f.decidedStatus})`);

if (write) {
  let closed = 0;
  for (const f of found) {
    const full = await store.getOffer(f.offerId).catch(() => null);
    if (!full || effectiveStatus(full) !== "draft") continue;
    const ts = new Date().toISOString();
    const note = "duplicate of a decided row on this house";
    await store.updateOffer(f.offerId, {
      ...full, status: "we_passed", statusAt: ts, statusNote: note,
      statusHistory: [...(full.statusHistory || []), { status: "we_passed", ts, note }],
      retired: { at: ts, by: "duplicate-drafts", reason: `beside ${f.decidedId}` }, updatedAt: ts,
    });
    closed++;
  }
  console.log(`closed ${closed}`);
}
await store.close?.();
