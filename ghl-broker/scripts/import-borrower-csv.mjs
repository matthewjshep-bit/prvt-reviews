// import-borrower-csv.mjs — one-off importer for a borrower/investor list CSV
// (the "enhanced borrower list builder" export) into GoHighLevel.
//
// These are hard-money borrowers pulled by zip — the dispositions audience. Each
// contact lands with a location tag (dispo-edmonds / dispo-issaquah) plus
// `investor`, which is what makes them visible to the dispo sync in routes/dispo.js.
//
// Dry run by default; --live is required to write. Same double gate every other
// write path in this repo uses.
//
//   node --env-file=.env scripts/import-borrower-csv.mjs <csv> [--live] [--limit N]
//
// The CSV carries the borrower's MOST RECENT recording, not the zip that
// qualified them for the pull, so a borrower whose last loan is in Tacoma may
// still be an Edmonds/Issaquah buyer. Those ambiguous rows get BOTH tags —
// an extra blast costs less than dropping a third of the list.

import fs from "node:fs";
import path from "node:path";
import {
  makeClient, findDuplicateContact, createContact, updateContact, addContactTags,
  searchContacts, findOrCreateCustomFieldByKey, removeContactTags,
} from "../ghl.js";
import { mapPool } from "../map-pool.js";
// The address title-caser the geocoder already uses — it knows that "SE" stays
// SE and "154TH" stays 154th, which a plain title-case gets wrong.
import { titleCase as streetCase, geocodeAddress } from "../geocode.js";

/* ---------- shared helpers (mirrored from routes/outreach.js + routes/dispo.js) ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a GHL call on 429 (2s, then 4s). Other errors propagate.
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.status !== 429 || attempt >= 2) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

const normPhone = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};
// GHL stores phones as E.164 — send +1XXXXXXXXXX, not bare digits.
const e164 = (phone) => (normPhone(phone) ? `+1${normPhone(phone)}` : "");
const normEmail = (s) => String(s || "").trim().toLowerCase();

// GHL tags are lowercase, hyphenated, and punctuation-free. Anything else
// silently becomes a DIFFERENT tag on their side, which would strand the blast.
const sanitizeTag = (s) =>
  String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

const titleCase = (s) =>
  String(s || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/* ---------- CSV ---------- */

// Minimal RFC4180 parser — the file is fully quoted with embedded commas, and
// ghl-broker has no CSV dependency worth adding for a one-off list.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

function writeCsv(file, headers, rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n") + "\n");
}

/* ---------- shaping rows into contacts ---------- */

const EDMONDS = "EDMONDS", ISSAQUAH = "ISSAQUAH";

// Same definition the outreach import uses (field-registry.js OUTREACH_FIELDS),
// so both features write the one field rather than each making their own.
const ADDRESS_FIELD = { key: "short_hand_property_address", name: "short hand property address", dataType: "TEXT" };

// Emails that belong to the LENDER's rep, not the borrower. Blasting these puts
// our dispo list in front of the lender. Contact still imports, phone intact.
const DROP_EMAILS = new Set(["ddawson@eastsidefunding.com", "nbierly@nai-psp.com"]);

const personKey = (r) => `${r["First Name"].trim().toLowerCase()}|${r["Last Name"].trim().toLowerCase()}`;
const blankKey = (r) => `blank|${r["Last Property Address"]}|${r["Last Recording Date"]}|${r["Last Lender"]}`;
const hasName = (r) => Boolean(r["First Name"].trim() || r["Last Name"].trim());
const recDate = (r) => r["Last Recording Date"] || r["Most Recent Recording"] || "";

// Every contact gets exactly ONE location tag — two tags on one person makes
// both blasts meaningless. When the property is plainly in one of the two
// cities that settles it; otherwise the property is geocoded and assigned to
// whichever anchor it is actually closer to. That is an approximation, and for
// an out-of-state property it is close to a coin flip, but a single tag is the point.
const ANCHORS = {
  edmonds: { lat: 47.8107, lng: -122.3774 },   // 98026
  issaquah: { lat: 47.5480, lng: -122.0090 },  // 98029
};

const milesBetween = (a, b) => {
  const R = 3959, t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

function citySide(cities) {
  const ed = cities.has(EDMONDS), iss = cities.has(ISSAQUAH);
  if (ed && !iss) return "edmonds";
  if (iss && !ed) return "issaquah";
  return null;
}

// Resolves each contact's single side, geocoding only the ones the city column
// can't settle. Sets tags and the losing tag to strip.
async function resolveSides(contacts) {
  const stats = { city: 0, geocoded: 0, fallback: 0 };
  for (const c of contacts) {
    if (c.side) {
      c.sideSource = "city";
      stats.city++;
    } else {
      const q = [c.address, c.city, c.state].filter(Boolean).join(", ");
      let geo = null;
      if (q) { try { geo = await geocodeAddress(q, { minPrecision: "city" }); } catch { /* fall through */ } }
      if (geo) {
        c.side = milesBetween(geo, ANCHORS.edmonds) <= milesBetween(geo, ANCHORS.issaquah) ? "edmonds" : "issaquah";
        c.sideSource = "geocoded";
        stats.geocoded++;
      } else {
        // No address and no city — nothing to go on. Edmonds is the larger half
        // of this list, so it is the less-wrong default. Reported, not hidden.
        c.side = "edmonds";
        c.sideSource = "fallback";
        stats.fallback++;
      }
    }
    c.tags = [sanitizeTag(`dispo-${c.side}`), "investor"];
    c.dropTag = sanitizeTag(`dispo-${c.side === "edmonds" ? "issaquah" : "edmonds"}`);
  }
  return stats;
}

function buildContacts(rows) {
  // An email shared by two different people can't be a dedupe key — the second
  // person would match the first and the two would collapse into one contact.
  const emailOwners = new Map();
  for (const r of rows) {
    const e = normEmail(r.Email);
    if (!e || !hasName(r)) continue;
    if (!emailOwners.has(e)) emailOwners.set(e, new Set());
    emailOwners.get(e).add(personKey(r));
  }
  const sharedEmails = new Set([...emailOwners].filter(([, v]) => v.size > 1).map(([k]) => k));
  const emailClaimed = new Set();

  const groups = new Map();
  for (const r of rows) {
    const k = hasName(r) ? personKey(r) : blankKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const notes = [];
  const contacts = [];
  for (const [key, group] of groups) {
    // Newest recording wins for the identity fields.
    const sorted = [...group].sort((a, b) => recDate(b).localeCompare(recDate(a)));
    const primary = sorted[0];
    const cities = new Set(group.map((r) => r["Last Property City"]).filter(Boolean));
    const named = hasName(primary);

    const phone = e164(sorted.map((r) => r["Primary Phone"]).find((p) => normPhone(p)) || "");

    let email = normEmail(sorted.map((r) => r.Email).find(Boolean) || "");
    let dedupeByEmail = true;
    if (email && DROP_EMAILS.has(email)) {
      notes.push(`${key}: dropped lender-side email ${email} (kept phone)`);
      email = "";
    } else if (email && sharedEmails.has(email)) {
      // First person to claim it keeps it; the rest match on phone only.
      dedupeByEmail = false;
      if (emailClaimed.has(email)) {
        notes.push(`${key}: email ${email} already used by another person in this file — imported by phone only`);
        email = "";
      } else {
        emailClaimed.add(email);
        notes.push(`${key}: email ${email} is shared with another person — not used as a dedupe key`);
      }
    }

    // Most recent NON-EMPTY address: a borrower's latest recording sometimes has
    // no address on it while an earlier one does.
    const address = sorted.map((r) => r["Last Property Address"]).find(Boolean) || "";
    contacts.push({
      key,
      named,
      // Blank-name rows are LLCs/co-borrowers with no name in the record; without
      // a synthetic one they'd all be indistinguishable in GHL.
      firstName: named ? titleCase(primary["First Name"]) : "Owner",
      lastName: named ? titleCase(primary["Last Name"]) : titleCase(address) || "Unknown Address",
      companyName: named ? "" : titleCase(primary["Last Lender"] || ""),
      phone,
      email,
      dedupeByEmail,
      tags: [],
      side: citySide(cities),
      city: primary["Last Property City"] || "",
      state: primary["Last Property State"] || "",
      cities: [...cities].join("/"),
      address,
      // Street portion only, matching how the outreach import fills this field
      // ("1911 9th Ave W", not the full mailing address).
      shortHandAddress: address ? streetCase(address.split(",")[0].trim()) : "",
      rowCount: group.length,
    });
  }
  return { contacts, notes };
}

/* ---------- name fallback ---------- */

// 36 of these contacts have neither phone nor email, so findDuplicateContact has
// nothing to search on and would create them fresh on every run. Falling back to
// an exact name match keeps the import idempotent. It also covers the case where
// GHL's duplicate index hasn't caught up with a contact we created moments ago.
//
// Only used when there is no phone to match on, so two different people who share
// a name can't be merged as long as either has a number.
async function findByExactName(client, locationId, firstName, lastName) {
  const want = `${firstName} ${lastName}`.trim().toLowerCase();
  let found = [];
  try {
    found = await searchContacts(client, locationId, want);
  } catch { return null; }
  const hits = (found || []).filter(
    (c) => `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase() === want
  );
  // Ambiguous — two live contacts with this exact name. Leave it to a human
  // rather than guess which one to tag.
  if (hits.length !== 1) return null;
  return { id: hits[0].id, matchedBy: "name" };
}

// True when two or more live contacts already share this exact name. Only
// consulted for rows with no phone and no email, where a wrong guess is the
// difference between tagging a stranger and creating a third duplicate.
async function nameIsAmbiguous(client, locationId, firstName, lastName) {
  const want = `${firstName} ${lastName}`.trim().toLowerCase();
  try {
    const found = await searchContacts(client, locationId, want);
    return (found || []).filter(
      (c) => `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase() === want
    ).length > 1;
  } catch { return false; }
}

// Seed known contact ids from a previous live report. Two people in this list
// share a name with an existing contact, so the ambiguity guard refuses to
// guess — but we already know which contact is theirs from the run that created
// them. Passing --ids <report.csv> resolves those directly instead of skipping.
function loadKnownIds(file) {
  const map = new Map();
  if (!file) return map;
  for (const r of parseCsv(fs.readFileSync(file, "utf8"))) {
    if (r.contactId) map.set(`${r.firstName}|${r.lastName}|${r.address}`, r.contactId);
  }
  return map;
}

/* ---------- main ---------- */

async function main() {
  const argv = process.argv.slice(2);
  const live = argv.includes("--live");
  const limitArg = argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) : 0;
  const idsArg = argv.indexOf("--ids");
  const knownIds = loadKnownIds(idsArg >= 0 ? argv[idsArg + 1] : "");
  const consumed = new Set([String(limit), idsArg >= 0 ? argv[idsArg + 1] : ""]);
  const csvPath = argv.find((a) => !a.startsWith("--") && !consumed.has(a)) ||
    `${process.env.HOME}/Downloads/enhanced_borrower_list_builder_20260908T220506.csv`;
  const outDir = process.env.OUT_DIR || path.join(process.cwd(), "tmp");

  const token = process.env.GHL_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) {
    console.error("GHL_TOKEN and GHL_LOCATION_ID must be set (run with --env-file=.env)");
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  let { contacts, notes } = buildContacts(rows);
  if (limit > 0) contacts = contacts.slice(0, limit);

  // Geocodes the contacts the city column can't settle, so this is the slow part.
  const sideStats = await resolveSides(contacts);
  const split = { edmonds: 0, issaquah: 0 };
  for (const c of contacts) split[c.side]++;

  console.log(`csv:        ${csvPath}`);
  console.log(`rows:       ${rows.length}  ->  contacts: ${contacts.length}` +
    ` (${contacts.filter((c) => c.named).length} named, ${contacts.filter((c) => !c.named).length} unnamed)`);
  console.log(`tags:       dispo-edmonds ${split.edmonds} | dispo-issaquah ${split.issaquah}  (one each)`);
  console.log(`            by city ${sideStats.city} | by geocode ${sideStats.geocoded} | no data, defaulted ${sideStats.fallback}`);
  console.log(`contactable: ${contacts.filter((c) => c.phone).length} phone, ${contacts.filter((c) => c.email).length} email,` +
    ` ${contacts.filter((c) => !c.phone && !c.email).length} neither`);
  if (notes.length) console.log(`\nemail adjustments:\n${notes.map((n) => "  - " + n).join("\n")}`);
  console.log(`\nmode:       ${live ? "LIVE — will write to GHL" : "DRY RUN (pass --live to write)"}\n`);

  const client = makeClient(token);

  // Pre-existing field in this location (contact.short_hand_property_address).
  // findOrCreateCustomFieldByKey matches on key OR name, so this reuses the
  // existing definition rather than creating a second one.
  const addressFieldId = await withRetry(() =>
    findOrCreateCustomFieldByKey(client, locationId, ADDRESS_FIELD.key, ADDRESS_FIELD.name, ADDRESS_FIELD.dataType)
  );
  console.log(`short hand property address -> custom field ${addressFieldId}\n`);

  const results = await mapPool(contacts, 2, async (c) => {
    const out = { ...c, tags: c.tags.join(" "), action: "", contactId: "", matchedBy: "", addressWritten: "", error: "" };
    try {
      await sleep(150);
      const seeded = knownIds.get(`${c.firstName}|${c.lastName}|${c.address}`);
      let match = seeded ? { id: seeded, matchedBy: "known-id" } : null;
      if (!match) match = (c.phone || (c.email && c.dedupeByEmail))
        ? await withRetry(() => findDuplicateContact(client, locationId, {
            email: c.dedupeByEmail ? c.email : "",
            phone: c.phone,
          }))
        : null;
      // No phone to key on and nothing found yet — fall back to an exact name match
      // so re-running doesn't create a second copy.
      let ambiguous = false;
      if (!match && !c.phone) {
        const byName = await withRetry(() => findByExactName(client, locationId, c.firstName, c.lastName));
        if (byName) match = byName;
        else ambiguous = !c.email && (await withRetry(() => nameIsAmbiguous(client, locationId, c.firstName, c.lastName)));
      }
      // Nothing to dedupe on AND more than one contact already answers to this
      // name — creating would just add a third. Report it for a human instead.
      if (ambiguous) {
        out.action = "ambiguous-skip";
        return out;
      }

      if (match) {
        out.contactId = match.id;
        out.matchedBy = match.matchedBy;
        // Fill blanks only — never overwrite what's already on a live contact.
        // A seeded id says WHICH contact, not which field already matched, so
        // it buys no permission to touch identity fields: tags and the address
        // field only.
        const patch = {};
        if (match.matchedBy !== "known-id") {
          if (c.email && match.matchedBy !== "email") patch.email = c.email;
          if (c.phone && match.matchedBy !== "phone") patch.phone = c.phone;
        }
        out.action = Object.keys(patch).length ? "matched+filled" : "matched";
        if (c.shortHandAddress) {
          patch.customFields = [{ id: addressFieldId, value: c.shortHandAddress }];
          out.addressWritten = c.shortHandAddress;
        }
        if (live && Object.keys(patch).length) await withRetry(() => updateContact(client, match.id, patch));
      } else {
        out.action = "create";
        if (live) {
          const body = {
            firstName: c.firstName,
            lastName: c.lastName,
            source: "borrower list 98026/98029 2026-09-08",
          };
          if (c.phone) body.phone = c.phone;
          if (c.email) body.email = c.email;
          if (c.companyName) body.companyName = c.companyName;
          if (c.shortHandAddress) {
            body.customFields = [{ id: addressFieldId, value: c.shortHandAddress }];
            out.addressWritten = c.shortHandAddress;
          }
          out.contactId = await withRetry(() => createContact(client, locationId, body));
        }
      }

      if (live && out.contactId) {
        await withRetry(() => addContactTags(client, out.contactId, c.tags));
        // An earlier run tagged the undecidable ones with BOTH cities, which
        // makes either blast meaningless. Strip whichever side lost.
        await withRetry(() => removeContactTags(client, out.contactId, [c.dropTag]));
      } else if (!live) out.action += " (dry)";
    } catch (e) {
      out.action = "error";
      out.error = `${e.status || ""} ${e.message}`.trim();
      console.error(`  ! ${c.firstName} ${c.lastName}: ${out.error}`);
    }
    return out;
  });

  const tally = results.reduce((a, r) => ((a[r.action] = (a[r.action] || 0) + 1), a), {});
  console.log("\nresult:", tally);

  const file = path.join(outDir, `borrower-import-${live ? "live" : "preview"}-${Date.now()}.csv`);
  writeCsv(file, ["firstName", "lastName", "companyName", "phone", "email", "tags", "side", "sideSource", "dropTag", "cities", "address", "shortHandAddress", "addressWritten", "rowCount", "action", "matchedBy", "contactId", "error"], results);
  console.log(`\nreport: ${file}`);
  if (!live) console.log("Review it, then re-run with --live (add --limit 5 to test a slice first).");
}

main().catch((e) => { console.error(e); process.exit(1); });
