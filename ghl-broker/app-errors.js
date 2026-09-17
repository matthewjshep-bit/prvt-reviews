// app-errors.js — a failure that used to live only in Render's log, kept.
//
// recordError never throws and never blocks: an error about an error helps
// nobody, and the job that failed has already told its own caller. What goes
// in is safe to show a person or a coding agent the next morning — the
// message with phone numbers and emails knocked out, and a context of ids
// only. Never a message body, a name or a number.

import crypto from "node:crypto";

// The only context keys kept. Everything else (text, names, transcripts) is dropped.
const CONTEXT_KEYS = ["contactId", "offerId", "draftId", "jobId", "kind", "intent", "party", "trigger", "route", "status", "stage"];

const PHONE = /\+?\d[\d\s().-]{8,}\d/g;
const EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi;

export function scrubMessage(v) {
  return String(v?.message ?? v ?? "").replace(EMAIL, "<email>").replace(PHONE, "<phone>").replace(/\s+/g, " ").trim().slice(0, 300);
}

export function safeContext(ctx = {}) {
  const out = {};
  for (const k of CONTEXT_KEYS) {
    const v = ctx?.[k];
    if (v == null || typeof v === "object") continue;
    out[k] = String(v).slice(0, 80);
  }
  return out;
}

// The same failure on two contacts is one row: ids, numbers and quoted values
// are flattened before hashing, so "no such draft 8f3a…" counts up rather
// than filling the table.
export function fingerprintOf(area, message) {
  const shape = String(message).toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "#")
    .replace(/"[^"]*"|'[^']*'/g, "'…'")
    .replace(/\d+/g, "#");
  return crypto.createHash("sha1").update(`${area}|${shape}`).digest("hex").slice(0, 16);
}

export async function recordError(store, { locationId, area, err, context = {}, now = Date.now() } = {}) {
  try {
    if (!store?.recordAppError || !locationId || !area) return null;
    const message = scrubMessage(err) || "unknown error";
    const row = { fingerprint: fingerprintOf(area, message), area: String(area).slice(0, 60), message, context: safeContext(context), at: new Date(now).toISOString() };
    await store.recordAppError(locationId, row);
    return row;
  } catch { return null; }
}
