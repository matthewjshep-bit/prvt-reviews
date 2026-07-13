#!/usr/bin/env node
// seed-home-templates.mjs — one-shot: create the four Card Studio templates the
// Home page resolves by name, through the broker's template CRUD (never GHL
// directly). Idempotent: a template whose name already exists is left alone.
//
// Usage:
//   node scripts/seed-home-templates.mjs <LOCATION_ID> [BROKER_URL]
//   BROKER_URL defaults to https://prvt-reviews-1.onrender.com
//
// Templates seeded (must match ghl-broker/home-config.js SECTIONS):
//   Quote Follow-Up   (quotes)   — parcel aerial + quote amount/expiry
//   Review Request    (reviews)  — the classic review card
//   Property Card     (winback)  — parcel aerial + address + lot badge
//   Offer Terms       (offers)   — dark per-tier terms card (data.tier.*)

import {
  quoteFollowUpStarter,
  reviewRequestStarter,
  propertyCardStarter,
  offerTermsStarter,
} from "../shared/starters.js";

const locationId = process.argv[2];
const brokerUrl = (process.argv[3] || process.env.BROKER_URL || "https://prvt-reviews-1.onrender.com").replace(/\/$/, "");

if (!locationId) {
  console.error("usage: node scripts/seed-home-templates.mjs <LOCATION_ID> [BROKER_URL]");
  process.exit(1);
}

const WANTED = [
  { name: "Quote Follow-Up", build: quoteFollowUpStarter },
  { name: "Review Request", build: reviewRequestStarter },
  { name: "Property Card", build: propertyCardStarter },
  { name: "Offer Terms", build: offerTermsStarter },
];

async function j(res) {
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || text.slice(0, 200)}${data.detail ? ` — ${JSON.stringify(data.detail).slice(0, 300)}` : ""}`);
  return data;
}

const existing = await j(await fetch(`${brokerUrl}/api/templates?location_id=${encodeURIComponent(locationId)}`));
const byName = new Map((existing.templates || []).map((t) => [String(t.name || "").toLowerCase(), t]));

let created = 0;
for (const { name, build } of WANTED) {
  const hit = byName.get(name.toLowerCase());
  if (hit) {
    console.log(`= exists   ${name}  (id ${hit.id}, v${hit.version})`);
    continue;
  }
  const doc = build({ locationId });
  const res = await j(await fetch(`${brokerUrl}/api/templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...doc, location_id: locationId }),
  }));
  console.log(`+ created  ${name}  (id ${res.template.id})`);
  created++;
}

console.log(`\ndone — ${created} created, ${WANTED.length - created} already existed.`);
console.log("They're editable in Card Studio (?view=studio); the Home page resolves them by name.");
