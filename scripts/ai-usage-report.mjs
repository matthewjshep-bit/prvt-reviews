// ai-usage-report.mjs — what the reply drafts cost, and how the shadow model
// compares. Read-only: it GETs the draft history and writes nothing to the
// broker.
//
//   node scripts/ai-usage-report.mjs                 last 7 days
//   node scripts/ai-usage-report.mjs --days 3
//   node scripts/ai-usage-report.mjs --pairs out.md  also write side-by-side
//                                                   drafts for reading
//
// Every draft since 2026-09-25 carries `usage` (its own tokens and dollars,
// shared/ai-cost.js) and, while config.ai.shadowUntil lasts, `shadow`: the
// shadow model's draft of the same message, judged by the same gates, never
// sent. Drafts from before then have neither and are counted as "unmetered".
// Contacts are printed by id; the pairs file carries message text, so keep it
// local.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, "ghl-broker", ".env"), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const DAYS = Number(arg("--days", 7)) || 7;
const PAIRS = arg("--pairs", "");
const BROKER = process.env.BROKER_URL || "https://offers.shepflips.com";

const r = await fetch(`${BROKER}/api/offers/automations/conversation/history?location_id=${encodeURIComponent(env.GHL_LOCATION_ID)}&days=${DAYS}`);
if (!r.ok) { console.error(`history: HTTP ${r.status}`); process.exit(1); }
const drafts = (await r.json()).drafts || [];

const $ = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "—");
const kindOf = (d) => d.outbound?.kind || (d.inbound ? "reply" : "other");

/* ---------- spend ---------- */
const metered = drafts.filter((d) => d.usage && d.usage.costUsd != null);
const byDay = new Map();
const byKind = new Map();
let read = 0, fresh = 0, batched = 0, spend = 0;
for (const d of metered) {
  const u = d.usage;
  const day = String(d.createdAt || "").slice(0, 10);
  byDay.set(day, (byDay.get(day) || 0) + u.costUsd);
  const k = kindOf(d);
  const row = byKind.get(k) || { n: 0, cost: 0 };
  row.n++; row.cost += u.costUsd; byKind.set(k, row);
  read += u.cacheRead; fresh += u.cacheWrite5m + u.cacheWrite1h;
  if (u.batched) batched++;
  spend += u.costUsd;
}
console.log(`\n${drafts.length} drafts in ${DAYS} days · ${metered.length} metered · ${drafts.length - metered.length} unmetered (before usage logging)`);
if (metered.length) {
  console.log(`drafting spend ${$(spend)} · ${$(spend / metered.length)} per draft · system-prompt cache hits ${pct(read, read + fresh)} of cached tokens · ${batched} batched (${pct(batched, metered.length)})`);
  console.log("\nby day:");
  for (const [day, c] of [...byDay].sort()) console.log(`  ${day}  ${$(c)}`);
  console.log("\nby kind:");
  for (const [k, v] of [...byKind].sort((a, b) => b[1].cost - a[1].cost)) console.log(`  ${k.padEnd(16)} ${String(v.n).padStart(4)} drafts  ${$(v.cost).padStart(8)}  ${$(v.cost / v.n)} each`);
}

/* ---------- the shadow ---------- */
const pairs = drafts.filter((d) => d.shadow && !d.shadow.error && d.usage);
const failed = drafts.filter((d) => d.shadow?.error);
if (pairs.length) {
  const model = pairs[0].shadow.model;
  const same = (f) => pairs.filter(f).length;
  const realCost = pairs.reduce((s, d) => s + (d.usage.costUsd || 0), 0);
  const shadowCost = pairs.reduce((s, d) => s + (d.shadow.usage?.costUsd || 0), 0);
  const realOk = same((d) => d.autoSendable);
  const shadowOk = same((d) => d.shadow.gateOk);
  console.log(`\nshadow (${model}) on ${pairs.length} drafts${failed.length ? ` · ${failed.length} shadow calls failed` : ""}:`);
  console.log(`  same intent           ${pct(same((d) => d.shadow.intent === d.intent), pairs.length)}`);
  console.log(`  same needs-a-person   ${pct(same((d) => Boolean(d.shadow.needsHuman) === Boolean(d.needsHuman || d.autoSend?.reason?.startsWith("needs a person"))), pairs.length)}`);
  console.log(`  passes the gates      real ${pct(realOk, pairs.length)} · shadow ${pct(shadowOk, pairs.length)}`);
  console.log(`  gate verdict differs  ${same((d) => Boolean(d.autoSendable) !== Boolean(d.shadow.gateOk))} drafts`);
  console.log(`  cost                  real ${$(realCost)} · shadow ${$(shadowCost)} (${pct(shadowCost, realCost)} of real)`);
  if (PAIRS) {
    const q = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const md = [`# Shadow drafts — ${model} beside the real drafts\n`, `${pairs.length} pairs, ${DAYS} days. Never sent; judged by the same gates.\n`];
    for (const d of pairs) {
      md.push(`## ${String(d.createdAt).slice(0, 16).replace("T", " ")} · ${kindOf(d)} · contact ${d.contactId}`);
      if (d.inbound) md.push(`**They said:** ${q(d.inbound)}\n`);
      md.push(`**Real (${d.usage.model}, ${d.intent}, ${d.confidence}${d.autoSendable ? "" : ", held by the gates"}):** ${q(d.sentText || d.reply)}\n`);
      md.push(`**Shadow (${d.shadow.intent}, ${d.shadow.confidence}${d.shadow.gateOk ? "" : `, held: ${(d.shadow.flags || []).join("; ")}`}):** ${q(d.shadow.reply)}\n`);
    }
    fs.writeFileSync(PAIRS, md.join("\n"));
    console.log(`\n  side-by-side drafts written to ${PAIRS}`);
  }
} else {
  console.log(`\nno shadow drafts yet${failed.length ? ` (${failed.length} failed: ${failed[0].shadow.error})` : ""}`);
}
