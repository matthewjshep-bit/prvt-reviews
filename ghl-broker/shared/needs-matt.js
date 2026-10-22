// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// needs-matt.js — the few things only Matt can do, as a GHL stage.
//
// Matt, 2026-10-22, after the follow-up audit: "Can we just have another
// stage in GHL opp pipeline as a catch all for everything else. But I want
// it minimize what those things are and have the app handle most things …
// Instead of ping to me they land there." Today is gone (2026-10-20) and the
// ping workflow was never built, so an acceptance sat 15 hours, three
// counters up to 46, and an agreed number a week, with nothing telling him.
//
// The agent's Acquisitions card moves to a stage named "Needs Matt" while one
// of these is open, and back to where the offers put it once it's done:
//
//   yes        they said yes (an acceptance held for him, a yes after we
//              passed) or agreed a number he hasn't approved
//   counter    a counter the machine hasn't taken in COUNTER_WAIT_HOURS
//   paper      paper to sign, a pre-contract warning, a hand-off only he
//              can do, an answer only he has
//   price      a house an agent surfaced that has waited PRICE_WAIT_HOURS
//              for his number
//
// Everything else stays the machine's: booked calls (booking), calls (the
// GHL dialer, desk.ghlCalls), passes (the pass note), promises (the promise
// sweep), held check-ins (the gates), closing tasks (the card sits in
// Contract), buyers (Deals). Keep this list short: a stage that fills up is
// one nobody reads.
//
// Pure. The runner is ghl-broker/needs-matt.js; the stage move is
// shared/ghl-stages.js planCard's `needsMatt`.

import { ownerOf } from "./hand-off.js";
import { isCounterDraft } from "./desk.js";

export const NEEDS_MATT_STAGE_RX = /^needs\s+matt\b/i;
export const NEEDS_MATT_STAGE_NAME = "Needs Matt";
export const PRICE_WAIT_HOURS = 24;
export const COUNTER_WAIT_HOURS = 12;
export const NEEDS_MATT_CURSOR = "needsMatt";
export const NEEDS_MATT_EVENT = "needs_matt_noted";

// Most pressing first: one per agent, the top one names the card's note.
export const NEEDS_MATT_KINDS = Object.freeze(["yes", "counter", "paper", "price"]);
const RANK = Object.fromEntries(NEEDS_MATT_KINDS.map((k, i) => [k, i]));

// Pipeline row kinds that are his on sight (hand-off.js says "ping" for
// them; buyers' and closing rows stay on Deals).
const PAPER_KINDS = new Set(["paper_to_sign", "pre_contract", "handoff"]);
// A house waiting on his number: the draft he prices, a number we owe.
const PRICE_KINDS = new Set(["price_it", "number_owed"]);

const HOUR_MS = 3600000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const street = (a) => String(a || "").split(",")[0].trim();
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const k$ = (n) => { const v = Math.round(Number(n) || 0); return v ? `${Math.round(v / 1000)}K` : ""; };

/**
 * needsMattKind(row, { draftsById, now }) → "yes" | "counter" | "paper" | "price" | null
 *
 * `row` is one action from the pipeline read (shared/pipeline.js) or a call
 * list row; `draftsById` the open drafts the read came with.
 */
export function needsMattKind(row, { draftsById = new Map(), now = Date.now() } = {}) {
  const kind = String(row?.kind || "");
  if (kind === "approve_number") return "yes";
  if (kind === "draft_waiting") {
    const d = draftsById.get(row.draftId) || null;
    if (!d || d.party === "investor") return null;
    if (row.yesAfterPass || d.yesAfterPass?.offerId || d.intent === "acceptance") return "yes";
    if (isCounterDraft(d)) {
      const at = ms(d.createdAt);
      return at != null && now - at >= COUNTER_WAIT_HOURS * HOUR_MS ? "counter" : null;
    }
    return null;
  }
  if (PAPER_KINDS.has(kind)) return "paper";
  if (kind === "promise_owed") {
    const owner = ownerOf(row);
    if (owner === "ping") return "paper";
    if (owner !== "price") return null;
    const at = ms(row.owedAt);
    return at != null && now - at >= PRICE_WAIT_HOURS * HOUR_MS ? "price" : null;
  }
  if (PRICE_KINDS.has(kind)) {
    const at = ms(row.readyAt || row.promisedAt);
    return at != null && now - at >= PRICE_WAIT_HOURS * HOUR_MS ? "price" : null;
  }
  return null;
}

/** needsMattWhy(item) → the card's one line: what it is and what to do. */
export function needsMattWhy(x = {}) {
  const on = street(x.address);
  const at = on ? ` on ${on}` : "";
  if (x.kind === "yes") {
    if (x.rowKind === "approve_number") return clip(`They agreed${at}${x.amount ? ` at ${k$(x.amount)}` : ""}: approve the number in Offers → Hot, then the machine asks for the write-up`, 300);
    return clip(`They said yes${at}: the bot's reply is held for you`, 300);
  }
  if (x.kind === "counter") return clip(`A counter${at} is waiting on you${x.title ? `: ${x.title}` : ""}`, 300);
  if (x.kind === "paper") return clip(`${x.title || "Something only you can do"}${x.title && on && !String(x.title).includes(on) ? ` (${on})` : ""}`, 300);
  if (x.kind === "price") {
    const hours = Math.max(1, Math.round(((x.now ?? Date.now()) - (ms(x.since) ?? Date.now())) / HOUR_MS));
    const waited = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
    return clip(`Price it${at}: the agent has waited ${waited} for our number`, 300);
  }
  return "";
}

/**
 * needsMattByContact(rows, { drafts, now }) → Map contactId → { kind, why, at, key, rowKind, offerId, address }
 *
 * From the pipeline read's folded rows (each row and its `also`), the most
 * pressing open thing per agent. `at` is when it started (the stage move
 * reads it as "newest wins" against a person's drag); `key` is stable per
 * thing, so the card's note is written once.
 */
export function needsMattByContact(rows = [], { drafts = [], now = Date.now() } = {}) {
  const draftsById = new Map((drafts || []).filter((d) => d?.id).map((d) => [d.id, d]));
  const out = new Map();
  for (const row of rows || []) {
    for (const r of [row, ...(row?.also || [])]) {
      const contactId = r?.contactId || row?.contactId;
      if (!contactId) continue;
      const kind = needsMattKind(r, { draftsById, now });
      if (!kind) continue;
      const d = r.draftId ? draftsById.get(r.draftId) : null;
      const since = r.owedAt || r.readyAt || r.promisedAt || d?.createdAt || r.at || null;
      const item = { kind, rowKind: r.kind, offerId: r.offerId || null, address: r.address || d?.propertyAddress || "",
        amount: r.amount || null, title: r.title || "", since, now };
      const prev = out.get(contactId);
      if (prev && RANK[prev.kind] <= RANK[kind]) continue;
      out.set(contactId, { kind, rowKind: r.kind, offerId: item.offerId, address: item.address, at: since,
        why: needsMattWhy(item), key: `${NEEDS_MATT_EVENT}:${r.id || `${r.kind}:${contactId}`}` });
    }
  }
  return out;
}

/** needsMattFromCursor(doc) → Map contactId → item, from the runner's last read. */
export function needsMattFromCursor(doc = null) {
  const m = new Map();
  for (const [id, v] of Object.entries(doc?.needs || {})) if (id && v?.kind) m.set(id, v);
  return m;
}
