// buyer-objections-report.mjs — why buyers pass, from their own words. The
// repeatable version of the 2026-10-02 read of every buyer thread that led to
// the buyer-view checks (shared/underwrite-checks.js). Read-only: it GETs the
// investor book and each replied buyer's thread, and writes nothing anywhere
// unless asked for a local quotes file.
//
//   node scripts/buyer-objections-report.mjs                every buyer who ever replied
//   node scripts/buyer-objections-report.mjs --limit 100    the first 100 of them
//   node scripts/buyer-objections-report.mjs --quotes out.md  also write each quote to a LOCAL file
//   node scripts/buyer-objections-report.mjs --calls        count call transcripts too (unlabelled speakers — noisier)
//
// Reads GHL_TOKEN + GHL_LOCATION_ID from ghl-broker/.env and the broker at
// BROKER_URL (default https://offers.shepflips.com). Each "no" in a buyer's
// texts (and the buyer's side of a call) is coded with the same ladder the
// deal feedback package uses (shared/deal-feedback.js inferReason), recoded
// onto the reasons the 2026-10-02 split added, and counted once per buyer per
// reason. The questions buyers ask before they decide are tallied too — the
// package should answer them up front. Stdout carries counts and contact ids,
// never names or message text; --quotes writes the buyers' words to a file on
// this machine only.

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
const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const LIMIT = Number(arg("--limit", 0)) || Infinity;
const QUOTES = arg("--quotes");
// Call transcripts don't say who's speaking, so a call carries our words too.
// Texts only unless asked.
const CALLS = process.argv.includes("--calls");

const { inferReason, PASS_RE, parseThread } = await import(path.join(root, "shared", "deal-feedback.js"));
const { recodePassReason, PASS_REASON_LABEL } = await import(path.join(root, "shared", "conversation-ai.js"));
const { buildTranscript } = await import(path.join(root, "ghl-broker", "enrich.js"));
const { makeClient } = await import(path.join(root, "ghl-broker", "ghl.js"));

// The questions buyers asked before they'd decide (the package should answer).
const QUESTIONS = [
  ["septic or sewer", /septic|sewer/i],
  ["how the rehab / ARV was figured", /how (did you|do you) (get|come up with|figure)|send (me )?(your|the) (repair|rehab|comps|underwriting)|where('d| did) (the|that) (arv|rehab)/i],
  ["occupied / access", /occupied|vacant|lock ?box|can (i|we) get in|access/i],
  ["photos", /photos?|pics?|pictures/i],
  ["lot size / zoning", /lot size|how big is the lot|zoning|zoned|how much can be built/i],
  ["permits", /permit/i],
  ["who are you / is it under contract", /who is this|who are you|under contract\?|still available|is it available/i],
];

const r = await fetch(`${BROKER}/api/dispo/investors?location_id=${encodeURIComponent(LOC)}&limit=5000`);
if (!r.ok) { console.error(`investor book: HTTP ${r.status}`); process.exit(1); }
const { investors = [] } = await r.json();
const replied = investors.filter((i) => i.relationship === "talking" || i.relationship === "replied").slice(0, LIMIT);
console.log(`${replied.length} buyers who have replied (of ${investors.length} in the book)`);

const client = makeClient(env.GHL_TOKEN);
const byCode = new Map();
const asked = new Map();
const quotes = [];
let read = 0;
const queue = [...replied];
async function worker() {
  while (queue.length) {
    const inv = queue.shift();
    let text = "";
    try { text = (await buildTranscript(client, LOC, inv.contactId, { maxCallTranscripts: 4 }))?.text || ""; }
    catch { /* a thread that won't load is skipped, not guessed */ }
    read++;
    if (read % 50 === 0) console.log(`  read ${read}/${replied.length}`);
    const lines = parseThread(text);
    const said = new Set();
    const ask = new Set();
    for (const l of lines) {
      const theirs = l.dir === "THEM" && l.channel !== "call" ? [l.body] : CALLS && l.channel === "call" ? (l.transcript || []).map((t) => t.text) : [];
      for (const body of theirs) {
        if (!body || /^(liked|loved|emphasized|reacted|laughed at)\b/i.test(body)) continue;
        for (const [label, re] of QUESTIONS) if (re.test(body) && /\?/.test(body)) ask.add(label);
        if (!PASS_RE.test(body) && !/^\s*(no|nope|pass)\b/i.test(body)) continue;
        const code = recodePassReason(inferReason(body, null)).code;
        if (code === "other") continue;
        if (!said.has(code)) {
          said.add(code);
          if (QUOTES) quotes.push(`${code}\t${String(inv.contactId).slice(0, 8)}\t${l.at || ""}\t${body.replace(/\s+/g, " ").slice(0, 200)}`);
        }
      }
    }
    for (const c of said) { if (!byCode.has(c)) byCode.set(c, new Set()); byCode.get(c).add(inv.contactId); }
    for (const a of ask) { if (!asked.has(a)) asked.set(a, new Set()); asked.get(a).add(inv.contactId); }
    await new Promise((res) => setTimeout(res, 400));
  }
}
await Promise.all([worker(), worker()]);

const house = ["price", "arv", "rehab_scope", "condition", "layout", "location", "legal", "exposure", "property_type"];
const rows = [...byCode.entries()].map(([code, ids]) => ({ code, n: ids.size })).sort((a, b) => b.n - a.n);
console.log("\nWhy buyers passed (distinct buyers per reason):");
for (const { code, n } of rows) {
  console.log(`  ${(PASS_REASON_LABEL[code] || code).padEnd(30)} ${String(n).padStart(4)}  ${house.includes(code) ? "house" : "buyer"}`);
}
console.log("\nWhat buyers asked before deciding (distinct buyers):");
for (const [label, ids] of [...asked.entries()].sort((a, b) => b[1].size - a[1].size)) console.log(`  ${label.padEnd(36)} ${String(ids.size).padStart(4)}`);
if (QUOTES) {
  fs.writeFileSync(QUOTES, `code\tcontact\tat\tquote\n${quotes.join("\n")}\n`);
  console.log(`\n${quotes.length} quotes written to ${QUOTES} (this machine only — never commit it)`);
}
