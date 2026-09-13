// retag-dispo-markets.mjs — tag the buyers already in GHL by where they buy
// and how, from the borrower list they were imported from.
//
// Every city an investor financed a property in gets dispo-city-<city>, its
// region dispo-region-<region>, out-of-state dispo-oos-<st>, and the strategy
// dispo-type-<flip|new-construction|rental> — plus `investor`, which is what
// the dispo sync reads. Nobody is created: a buyer we can't find in GHL is a
// line in the report.
//
// Dry run by default; --live writes the tags.
//
//   node --env-file=.env scripts/retag-dispo-markets.mjs <csv> [<csv>...] [--tag dispo-seatac] [--live] [--limit N]

import path from "node:path";
import fs from "node:fs";
import { makeClient, searchAllContactsByTags, addContactTags } from "../ghl.js";
import { mapPool } from "../map-pool.js";
import { parseCsv, writeCsv, groupBuyers, contactIndex, matchBuyer, withRetry, sleep } from "../buyer-import.js";
import { REGIONS } from "../shared/dispo-regions.js";

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ""; };
  const live = argv.includes("--live");
  const limit = Number(flag("--limit")) || 0;
  const sourceTag = flag("--tag") || "disposition-seatac,dispositions-vashon";
  const consumed = new Set([flag("--limit"), flag("--tag"), flag("--record")].filter(Boolean));
  const files = argv.filter((a) => !a.startsWith("--") && !consumed.has(a));
  if (!files.length) { console.error("usage: retag-dispo-markets.mjs <csv> [...] [--tag dispo-seatac] [--live] [--limit N]"); process.exit(1); }

  const token = process.env.GHL_TOKEN, locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) { console.error("GHL_TOKEN and GHL_LOCATION_ID must be set (run with --env-file=.env)"); process.exit(1); }

  const rows = files.flatMap((f) => parseCsv(fs.readFileSync(f, "utf8")));
  let { buyers, skipped } = groupBuyers(rows);
  if (limit > 0) buyers = buyers.slice(0, limit);

  const client = makeClient(token);
  // Comma-separated: a buyer list can have been uploaded under more than one tag.
  const { contacts, total, truncated } = await searchAllContactsByTags(client, locationId, sourceTag.split(",").map((t) => t.trim()).filter(Boolean), { pageLimit: 100, maxPages: 100 });
  console.log(`csv rows:   ${rows.length} from ${files.length} file(s)  ->  ${buyers.length} named buyers, ${skipped.length} unnamed rows skipped`);
  console.log(`GHL:        ${contacts.length} contacts tagged ${sourceTag}${truncated ? ` (TRUNCATED of ${total})` : ""}`);
  const index = contactIndex(contacts);

  const regionCount = {}, cityCount = {}, typeCount = {}, matchCount = {};
  const results = [];
  for (const b of buyers) {
    const m = matchBuyer(b, index);
    const out = {
      name: `${b.firstName} ${b.lastName}`, phones: b.phones.join(" "), emails: b.emails.join(" "),
      purchases: b.purchases.length, lastAt: b.lastAt, largest: b.largest,
      cities: b.cities.join(" "), regions: b.regions.join(" "), types: b.types.join(" "), states: b.states.join(" "),
      tags: b.tags.join(" "), contactId: m.id || "", matchedBy: m.matchedBy || "", action: "", reason: "",
    };
    if (!b.tags.length) { out.action = "skip"; out.reason = "no address on any recording"; }
    else if (!m.id) { out.action = "skip"; out.reason = m.reason; }
    else {
      out.action = live ? "tag" : "would tag";
      matchCount[m.matchedBy] = (matchCount[m.matchedBy] || 0) + 1;
      for (const r of b.regions) regionCount[r] = (regionCount[r] || 0) + 1;
      for (const c of b.cities) cityCount[c] = (cityCount[c] || 0) + 1;
      for (const t of b.types) typeCount[t] = (typeCount[t] || 0) + 1;
    }
    results.push({ out, buyer: b });
  }

  const tagged = results.filter((r) => r.out.contactId && r.out.tags);
  console.log(`matched:    ${tagged.length} (${Object.entries(matchCount).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  console.log(`skipped:    ${results.length - tagged.length} (${Object.entries(results.filter((r) => r.out.action === "skip").reduce((a, r) => ((a[r.out.reason] = (a[r.out.reason] || 0) + 1), a), {})).map(([k, v]) => `${k}: ${v}`).join("; ")})`);
  console.log(`regions:    ${Object.entries(regionCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${REGIONS[k]?.label || k} ${v}`).join(" · ")}`);
  console.log(`types:      ${Object.entries(typeCount).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  console.log(`top cities: ${Object.entries(cityCount).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`\nmode:       ${live ? "LIVE — writing tags to GHL" : "DRY RUN (pass --live to write)"}\n`);

  if (live) {
    let done = 0;
    await mapPool(tagged, 2, async ({ out, buyer }) => {
      try {
        await sleep(150);
        await withRetry(() => addContactTags(client, out.contactId, [...buyer.tags, "investor"]));
      } catch (e) {
        out.action = "error"; out.reason = `${e.status || ""} ${e.message}`.trim();
        console.error(`  ! ${out.name}: ${out.reason}`);
      }
      if (++done % 100 === 0) console.log(`  tagged ${done}/${tagged.length}`);
    });
  }

  // --record <brokerUrl>: post each matched buyer's purchases to the broker,
  // which writes them to the contact timeline (the script has no database).
  const recordUrl = flag("--record");
  if (recordUrl) {
    const matched = results.filter((r) => r.out.contactId && r.out.action !== "error");
    let inserted = 0;
    for (let i = 0; i < matched.length; i += 200) {
      const buyers = matched.slice(i, i + 200).map((r) => ({ contactId: r.out.contactId, purchases: r.buyer.purchases }));
      const resp = await fetch(`${recordUrl.replace(/\/$/, "")}/api/dispo/purchases`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location_id: locationId, buyers }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) { console.error(`  ! purchases batch ${i}: ${resp.status} ${j.error || ""}`); break; }
      inserted += j.inserted || 0;
    }
    console.log(`purchases:  ${inserted} recorded on the timeline via ${recordUrl}`);
  }

  const outDir = process.env.OUT_DIR || path.join(process.cwd(), "tmp");
  const file = path.join(outDir, `dispo-retag-${live ? "live" : "preview"}-${Date.now()}.csv`);
  writeCsv(file, ["name", "phones", "emails", "purchases", "lastAt", "largest", "cities", "regions", "types", "states", "tags", "contactId", "matchedBy", "action", "reason"], results.map((r) => r.out));
  const skipFile = path.join(outDir, `dispo-retag-unnamed-${Date.now()}.csv`);
  writeCsv(skipFile, ["reason", "address", "lender"], skipped);
  console.log(`report:     ${file}\nunnamed:    ${skipFile}`);
  if (!live) console.log("Review it, then re-run with --live (add --limit 10 to test a slice first).");
}

main().catch((e) => { console.error(e); process.exit(1); });
