// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// hand-off.js — who owns each thing that used to wait on Today.
//
// Matt, 2026-10-20: "Today really shouldn't just exist. These things should
// be automatically handled by the app." He prices houses (they sit in GHL's
// Tier 1 until he does); everything else is the machine's, a call (booked on
// his calendar or put in GHL's Manual Actions), or one of the few things
// only he can do, which pings him through GHL and lives on its own page.
//
// Every reason the pipeline, the call list or last night's audit can make
// has exactly one owner here. hand-off.test.mjs fails on a kind with none,
// so nothing new can quietly need a person again.
//
//   machine  the bot sends it, or it closes itself
//   price    Matt sets the number (the GHL Tier 1 card)
//   call     the calendar, or GHL's Manual Actions
//   ping     GHL tells Matt; the thing lives on Offers → Hot or Deals
//   drop     nothing to do; closed quietly, a note in GHL at most
//
// Pure.

import { CALL_INTENTS, isCounterDraft } from "./desk.js";

export const OWNERS = ["machine", "price", "call", "ping", "drop"];

// By kind, before anything about the row itself is read (ownerOf refines
// draft_waiting, audit_owed and promise_owed).
export const OWNER_OF_KIND = Object.freeze({
  // Pipeline actions (shared/pipeline.js ACTION_KINDS).
  promise_owed: "price", number_owed: "price", call_owed: "call", draft_waiting: "machine",
  handoff: "ping", investor_price_agreed: "ping", closing_soon: "ping", closing_task_due: "ping",
  hot_stalled: "machine", pre_contract: "ping", price_it: "price", underwrite_held: "price",
  offer_ready: "machine", no_fit: "price", approve_number: "ping", ladder_exhausted: "machine",
  showing_soon: "machine", showing_no_window: "ping", deal_no_buyers: "machine", blast_no_opens: "machine",
  deal_interest_stalled: "machine", deal_no_dataroom: "ping", draft_scheduled: "machine", stage_lag: "machine",
  gone_quiet: "machine", underwrite_failed: "machine", underwrite_dropped: "machine", texts_elsewhere: "drop",
  // The call list (shared/call-list.js CALL_KINDS).
  call_hot: "call", call_brought: "call", paper_to_sign: "ping", hot_machine: "machine", counter_held: "machine",
  call_missed: "call", call_counter: "call", call_gap: "call", call_first_reply: "call", call_turnkey_week: "call",
  call_quiet: "call", call_phone_only: "call", call_partner: "call", call_investor: "call", call_partner_terms: "call",
  referral: "ping", email_check: "ping",
  // Last night's audit (shared/conversation-audit.js auditActions).
  audit_owed: "machine",
});

// Held replies with nothing to answer (shared/conversation-audit.js quietHolds).
const QUIET = new Set(["opt_out", "small_talk", "media"]);
const UNKNOWN_CONTACT_RX = /unknown contact never auto-sends/;
// Audit findings about a number we owe: the house is his to price.
const OWED_A_NUMBER = new Set(["promise_open_overdue"]);

/**
 * ownerOf(reason, { draftsById }) → one of OWNERS, or null for a kind nobody
 * owns (the test makes sure there is none)
 */
export function ownerOf(a, { draftsById = new Map() } = {}) {
  const kind = String(a?.kind || "");
  if (kind === "draft_waiting") {
    const d = draftsById.get(a.draftId) || null;
    if (CALL_INTENTS.has(d?.intent)) return "call";
    if (QUIET.has(d?.intent) || UNKNOWN_CONTACT_RX.test(d?.autoSend?.reason || "")) return "drop";
    // A counter goes to the counter hold: our number, never above it.
    if (isCounterDraft(d)) return "machine";
    return "machine";
  }
  if (kind === "audit_owed") {
    if (CALL_INTENTS.has(a.intent)) return "call";
    if (OWED_A_NUMBER.has(a.findingKind)) return "price";
    return "machine";
  }
  if (kind === "promise_owed") {
    // The written offer goes on its own once there's a number (afterFloat);
    // an answer only Matt has (a partner's question) is his to give.
    if (a.what === "paper") return "machine";
    if (a.what && a.what !== "number") return "ping";
    return "price";
  }
  return OWNER_OF_KIND[kind] || null;
}

/**
 * handOffs(reasons, { drafts }) → { counts: { machine, price, call, ping, drop, unowned }, byKind: { kind: { owner, n } } }
 *
 * What used to be on Today, by who has it now. No names.
 */
export function handOffs(reasons = [], { drafts = [] } = {}) {
  const draftsById = new Map((drafts || []).filter((d) => d?.id).map((d) => [d.id, d]));
  const counts = Object.fromEntries([...OWNERS, "unowned"].map((o) => [o, 0]));
  const byKind = {};
  for (const a of reasons || []) {
    if (!a?.kind) continue;
    const owner = ownerOf(a, { draftsById }) || "unowned";
    counts[owner]++;
    const k = `${a.kind}:${owner}`;
    byKind[k] = { kind: a.kind, owner, n: (byKind[k]?.n || 0) + 1 };
  }
  return { counts, byKind: Object.values(byKind).sort((x, y) => y.n - x.n) };
}

/**
 * pingReasons(rows, { drafts }) → [{ ...reason, contactId }] — the reasons
 * that ping Matt (owner "ping"), one per reason, from Today's folded rows
 * (each row and what's folded under it). A reason with nobody to hang it on
 * in GHL is left out.
 */
export function pingReasons(rows = [], { drafts = [] } = {}) {
  const draftsById = new Map((drafts || []).filter((d) => d?.id).map((d) => [d.id, d]));
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    for (const r of [row, ...(row?.also || [])]) {
      const contactId = r?.contactId || row?.contactId;
      if (!r?.id || !contactId || seen.has(r.id)) continue;
      if (ownerOf(r, { draftsById }) !== "ping") continue;
      seen.add(r.id);
      out.push({ ...r, contactId, contactName: r.contactName || row.contactName || "" });
    }
  }
  return out;
}
