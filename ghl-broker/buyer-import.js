// buyer-import.js — reading a borrower list (the "enhanced borrower list
// builder" export) into buyers: one person, every property they financed,
// and the market/strategy tags that follow from those properties.
//
// Pure except for the GHL helpers at the bottom. Used by the retag script and
// the Dispositions import route, so both read a list the same way.

import fs from "node:fs";
import path from "node:path";
import { tagsForPurchases, strategyFor } from "./shared/dispo-regions.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a GHL call on 429 (2s, then 4s). Other errors propagate.
export async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (e.status !== 429 || attempt >= 2) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

export const normPhone = (s) => { const d = String(s || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
export const e164 = (phone) => (normPhone(phone) ? `+1${normPhone(phone)}` : "");
export const normEmail = (s) => String(s || "").trim().toLowerCase();
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/* ---------- CSV ---------- */

// Minimal RFC4180 parser — the export is fully quoted with embedded commas.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const src = String(text).replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() || []).map((h) => h.trim());
  return rows.filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

export function writeCsv(file, headers, rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n") + "\n");
}

/* ---------- rows → buyers ---------- */

// Emails that belong to the LENDER's rep, not the borrower.
const LENDER_EMAILS = new Set(["ddawson@eastsidefunding.com", "nbierly@nai-psp.com"]);

const money = (v) => { const n = Number(String(v || "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : 0; };

/** purchaseFromRow(row) → one financed property, in the shape the tags and the timeline read. */
export function purchaseFromRow(r) {
  const p = {
    address: r["Last Property Address"] || "",
    city: r["Last Property City"] || "",
    state: r["Last Property State"] || "",
    lender: r["Last Lender"] || "",
    amount: money(r["Last Loan Amount ($)"]),
    largest: money(r["Largest Origination ($)"]),
    maturity: r["Next Maturity Date"] || "",
    recordedAt: r["Last Recording Date"] || r["Most Recent Recording"] || "",
  };
  p.strategy = strategyFor(p);
  return p;
}

/**
 * groupBuyers(rows) → { buyers, skipped }
 *
 * One buyer per named person (first|last). Rows with no name are LLC or
 * co-borrower recordings with nobody to text — reported, not guessed at.
 */
export function groupBuyers(rows) {
  const groups = new Map();
  const skipped = [];
  for (const r of rows) {
    const first = (r["First Name"] || "").trim(), last = (r["Last Name"] || "").trim();
    if (!first && !last) { skipped.push({ reason: "no name on the recording", address: r["Last Property Address"] || "", lender: r["Last Lender"] || "" }); continue; }
    const key = `${first.toLowerCase()}|${last.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { key, firstName: titleCase(first), lastName: titleCase(last), phones: new Set(), emails: new Set(), purchases: [] });
    const g = groups.get(key);
    const ph = normPhone(r["Primary Phone"]); if (ph) g.phones.add(ph);
    const em = normEmail(r.Email); if (em && !LENDER_EMAILS.has(em)) g.emails.add(em);
    const p = purchaseFromRow(r);
    // The same recording listed twice (it happens) is one purchase.
    if (!g.purchases.some((x) => x.address === p.address && x.recordedAt === p.recordedAt && x.amount === p.amount)) g.purchases.push(p);
  }
  const buyers = [...groups.values()].map((g) => {
    const purchases = g.purchases.sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
    const market = tagsForPurchases(purchases);
    return {
      key: g.key, firstName: g.firstName, lastName: g.lastName,
      phones: [...g.phones], emails: [...g.emails], purchases, ...market,
      lastAt: purchases[0]?.recordedAt || "",
      largest: Math.max(0, ...purchases.map((p) => Math.max(p.amount, p.largest))),
    };
  });
  return { buyers, skipped };
}

/** The timeline rows for a buyer's purchases — dedupe keyed so a re-run adds nothing. */
export const purchaseEvents = (purchases) => purchases.filter((p) => p.address || p.city).map((p) => ({
  type: "property_financed", at: p.recordedAt ? new Date(p.recordedAt).toISOString() : new Date().toISOString(),
  address: [p.address, p.city, p.state].filter(Boolean).join(", "),
  source: "import", ref: "borrower-list",
  data: { city: p.city, state: p.state, lender: p.lender, amount: p.amount, maturity: p.maturity, strategy: p.strategy },
  dedupeKey: `financed:${String(p.address || p.city).toLowerCase()}:${p.recordedAt}`,
}));

/* ---------- matching against GHL ---------- */

/**
 * contactIndex(contacts) → { byPhone, byEmail, byName } — maps to arrays of contact ids.
 * Built once from a tag pull so matching 2,000 buyers is 0 extra API calls.
 */
export function contactIndex(contacts = []) {
  const add = (m, k, id) => { if (!k) return; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(id); };
  const byPhone = new Map(), byEmail = new Map(), byName = new Map();
  for (const c of contacts) {
    add(byPhone, normPhone(c.phone), c.id);
    add(byEmail, normEmail(c.email), c.id);
    add(byName, `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase(), c.id);
  }
  return { byPhone, byEmail, byName };
}

/**
 * matchBuyer(buyer, index) → { id, matchedBy } | { id: null, reason }
 * Phone, then email, then name — each only when it names exactly one contact.
 */
export function matchBuyer(b, { byPhone, byEmail, byName }) {
  const one = (sets) => { const ids = new Set(); for (const s of sets) if (s) for (const id of s) ids.add(id); return ids; };
  const phoneIds = one(b.phones.map((p) => byPhone.get(p)));
  if (phoneIds.size === 1) return { id: [...phoneIds][0], matchedBy: "phone" };
  const emailIds = one(b.emails.map((e) => byEmail.get(e)));
  if (emailIds.size === 1) return { id: [...emailIds][0], matchedBy: "email" };
  const nameIds = byName.get(`${b.firstName} ${b.lastName}`.trim().toLowerCase());
  if (nameIds?.size === 1) return { id: [...nameIds][0], matchedBy: "name" };
  if (phoneIds.size > 1 || emailIds.size > 1 || nameIds?.size > 1) return { id: null, reason: "more than one contact matches" };
  return { id: null, reason: "not found in GHL" };
}
