// backfill-replier-profiles.mjs — one time: agents who texted us back before
// the app saw replies join the agent check-in (ghl-broker/replier-backfill.js).
//
// Reads every outreach agent with a GHL contact, skips the ones the check-in
// already has (and buyers), reads each one's GHL thread three at a time, and
// sorts them: replied, opted out (STOP, wrong number, take me off, SMS DND,
// a do-not-text tag), auto-reply only, annoyed, or never wrote back.
//
// Dry run by default: reads GHL and the database, writes nothing, prints
// counts only (no names, phones or message text). --write gives each replier
// an agent profile and their last word on the timeline (spread first
// check-ins from the day it runs), and marks the opted-out through the usual
// stop path (the `unsubscribed` tag in GHL + an `unsubscribed` event).
// Reruns are safe: written contacts are in the pool and skipped, and the
// timeline marker has a dedupe key.
//
// Needs the live database and GHL: DATABASE_URL, GHL_TOKEN (or GHL_TOKENS)
// and GHL_LOCATION_ID — the broker's Render Shell has all three. Run from
// ghl-broker/ after the deploy that carries it:
//
//   node scripts/backfill-replier-profiles.mjs                 dry run, counts
//   node scripts/backfill-replier-profiles.mjs --limit 20      dry run, a slice
//   node scripts/backfill-replier-profiles.mjs --write         writes

import { makeClient } from "../ghl.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ""; };
const write = argv.includes("--write");
const limit = Number(flag("--limit")) || 0;

const locationId = flag("--location") || process.env.GHL_LOCATION_ID || "";
let tokens = {};
try { tokens = JSON.parse(process.env.GHL_TOKENS || "{}"); } catch { tokens = {}; }
const token = tokens[locationId] || process.env.GHL_TOKEN || "";
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set: this reads and writes the live database (run it in the broker's Render Shell)"); process.exit(1); }
if (!locationId || !token) { console.error("GHL_LOCATION_ID and GHL_TOKEN (or GHL_TOKENS) must be set"); process.exit(1); }

const { store } = await import("../store.js");
const { runReplierBackfill } = await import("../replier-backfill.js");
await store.init();

console.log(`mode: ${write ? "WRITE" : "DRY RUN (pass --write to write)"}${limit ? `, first ${limit} candidates` : ""}`);
let shown = 0;
const r = await runReplierBackfill({
  client: makeClient(token), locationId, store, write, limit,
  onProgress: (o) => { const done = o.read + o.failed; if (done - shown >= 50) { shown = done; console.log(`  read ${done}`); } },
});

console.log(`outreach rows:        ${r.outreachRows} (${r.outreachContacts} GHL contacts)`);
console.log(`already in check-in:  ${r.alreadyInPool}`);
console.log(`buyers (skipped):     ${r.investors}`);
console.log(`read from GHL:        ${r.read} of ${r.candidates} candidates${r.failed ? `, ${r.failed} failed` : ""}`);
console.log(`replied (join):       ${r.kinds.engaged || 0}`);
console.log(`opted out (stop):     ${r.kinds.opted_out || 0}`);
console.log(`auto-reply only:      ${r.kinds.auto_reply || 0} (left out)`);
console.log(`annoyed:              ${r.kinds.annoyed || 0} (left out)`);
console.log(`never wrote back:     ${r.kinds.none || 0}`);
console.log(`why:                  ${Object.entries(r.why).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
if (write) console.log(`written:              ${r.written.profiles} profiles, ${r.written.markers} timeline markers, ${r.written.optedOut} opted out`);
else console.log("Nothing written. Check the counts (opted out should hold the stops and wrong numbers), then re-run with --write.");
process.exit(0);
