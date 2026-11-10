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
import { theirYesIn, asksForPaper } from "./conversation-ai.js";
import { effectiveStatus, isHot } from "./offer-status.js";
import { houseKey } from "./current-offer.js";

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
  call_gatekeeper_replied: "call", call_gatekeeper: "call",
  referral: "ping", email_check: "ping",
  // Last night's audit (shared/conversation-audit.js auditActions).
  audit_owed: "machine",
  // Their yes on a house our row says is closed (shared/pipeline.js, 2026-11-09).
  their_yes: "ping",
});

// Held replies with nothing to answer (shared/conversation-audit.js quietHolds).
const QUIET = new Set(["opt_out", "small_talk", "media"]);
const UNKNOWN_CONTACT_RX = /unknown contact never auto-sends/;
// Audit findings about a number we owe: the house is his to price.
const OWED_A_NUMBER = new Set(["promise_open_overdue"]);

/* ---------- their yes, an ask for the paper (2026-11-09) ---------- */

// The audit, 2026-11-09: 45 contacts had a held reply and their text
// unanswered. The ones closest to a contract (a seller at our own number with
// our terms quoted back, "what do you want me to write up", proof of funds on
// our offer) were all owned by the machine here, so nothing told Matt.

// Our number is out on it: sent, countered, accepted, or hot.
const LIVE_FOR_PAPER = new Set(["sent", "countered", "accepted"]);
export const offerIsOut = (o) => Boolean(o) && (Boolean(o.deal) || LIVE_FOR_PAPER.has(effectiveStatus(o)) || Boolean(o.floatSentAt) || isHot(o));
// Not a yes whatever the words: they said no, or pushed back.
const NOT_A_YES = new Set(["rejection", "opt_out", "we_passed", "price_pushback"]);

const byContactCache = new WeakMap();
function offersOfContact(offersById, contactId) {
  if (!contactId || !(offersById instanceof Map)) return [];
  let idx = byContactCache.get(offersById);
  if (!idx) {
    idx = new Map();
    for (const o of offersById.values()) {
      if (!o?.contactId) continue;
      if (!idx.has(o.contactId)) idx.set(o.contactId, []);
      idx.get(o.contactId).push(o);
    }
    byContactCache.set(offersById, idx);
  }
  return idx.get(contactId) || [];
}

/**
 * houseRowsOf({ contactId, address, offerId }, { offersById }) → the agent's
 * rows on the house a reason is about: by its address, else the row the
 * pipeline pinned it to, else every row of theirs.
 */
export function houseRowsOf({ contactId = "", address = "", offerId = null } = {}, { offersById = new Map() } = {}) {
  const all = offersOfContact(offersById, contactId);
  const key = houseKey(address || "");
  if (key) {
    const same = all.filter((o) => houseKey(o.address || "") === key);
    if (same.length) return same;
  }
  const pinned = offerId && offersById instanceof Map ? offersById.get(offerId) : null;
  return pinned ? [pinned] : all;
}

/**
 * closeSignal(draft, { offers }) → { kind: "yes" | "paper", reason } | null
 *
 * A held agent reply only Matt can answer, from their own words:
 *
 *   yes    quotes_terms   our cash number with the terms of a written offer
 *                         (shared/conversation-ai.js quotesOurTerms)
 *          writing_up     they're writing it up: "what do you want me to
 *                         write up", "who do I make it out to" (dealSignal)
 *   paper  proof_of_funds they asked for proof of funds or a bank letter
 *          paper_ask      earnest, inspection days, the entity, ID, a buyer
 *                         agency form, "send it signed", on a house where
 *                         our number is out (`offers` holds one)
 *
 * "I'll present it to the seller" is none of these: the bot keeps it. A
 * counter stays on the counter hold unless it is our own number with terms.
 * Buyers are never here: their paper is on Deals.
 */
export function closeSignal(d, { offers = [] } = {}) {
  if (!d || d.party !== "agent" || NOT_A_YES.has(d.intent)) return null;
  const words = String(d.inbound || "");
  const yes = theirYesIn(words, offers);
  if (yes === "quotes_terms") return { kind: "yes", reason: yes };
  if (!isCounterDraft(d) && (yes === "writing_up" || d.dealSignal === "writing_up")) return { kind: "yes", reason: "writing_up" };
  if (d.intent === "proof_of_funds") return { kind: "paper", reason: "proof_of_funds" };
  if (!isCounterDraft(d) && asksForPaper(words) && (offers || []).some(offerIsOut)) return { kind: "paper", reason: "paper_ask" };
  return null;
}

/** closeSignalFor(row, draft, { offersById }) → closeSignal on the house the row is about. */
export function closeSignalFor(a, d, { offersById = new Map() } = {}) {
  if (!d) return null;
  const offers = houseRowsOf({ contactId: d.contactId || a?.contactId, address: d.propertyAddress || a?.address || "", offerId: a?.offerId || null }, { offersById });
  return closeSignal(d, { offers });
}

/** termsCallOwed(row, { offersById }) → true for a call we owe about their terms, on a house where our number is out. */
export function termsCallOwed(a, { offersById = new Map() } = {}) {
  if (a?.kind !== "call_owed" || !a.aboutTerms) return false;
  return houseRowsOf({ contactId: a.contactId, address: a.address || "", offerId: a.offerId || null }, { offersById }).some(offerIsOut);
}

/**
 * ownerOf(reason, { draftsById, offersById }) → one of OWNERS, or null for a
 * kind nobody owns (the test makes sure there is none)
 *
 * `offersById` lets a held reply that quotes our terms, or asks for the paper
 * on a house where our number is out, be read as his (closeSignal). Without
 * it, a write-up or a proof of funds ask still is.
 */
export function ownerOf(a, { draftsById = new Map(), offersById = new Map() } = {}) {
  const kind = String(a?.kind || "");
  if (kind === "call_owed" && termsCallOwed(a, { offersById })) return "ping";
  if (kind === "draft_waiting") {
    const d = draftsById.get(a.draftId) || null;
    if (closeSignalFor(a, d, { offersById })) return "ping";
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
const offersMap = (offers) => new Map((offers || []).filter((o) => o?.id).map((o) => [o.id, o]));
export function handOffs(reasons = [], { drafts = [], offers = [] } = {}) {
  const draftsById = new Map((drafts || []).filter((d) => d?.id).map((d) => [d.id, d]));
  const offersById = offersMap(offers);
  const counts = Object.fromEntries([...OWNERS, "unowned"].map((o) => [o, 0]));
  const byKind = {};
  for (const a of reasons || []) {
    if (!a?.kind) continue;
    const owner = ownerOf(a, { draftsById, offersById }) || "unowned";
    counts[owner]++;
    const k = `${a.kind}:${owner}`;
    byKind[k] = { kind: a.kind, owner, n: (byKind[k]?.n || 0) + 1 };
  }
  return { counts, byKind: Object.values(byKind).sort((x, y) => y.n - x.n) };
}

/**
 * pingReasons(rows, { drafts, offers }) → [{ ...reason, contactId }] — the reasons
 * that ping Matt (owner "ping"), one per reason, from Today's folded rows
 * (each row and what's folded under it). A reason with nobody to hang it on
 * in GHL is left out.
 */
export function pingReasons(rows = [], { drafts = [], offers = [] } = {}) {
  const draftsById = new Map((drafts || []).filter((d) => d?.id).map((d) => [d.id, d]));
  const offersById = offersMap(offers);
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    for (const r of [row, ...(row?.also || [])]) {
      const contactId = r?.contactId || row?.contactId;
      if (!r?.id || !contactId || seen.has(r.id)) continue;
      if (ownerOf(r, { draftsById, offersById }) !== "ping") continue;
      seen.add(r.id);
      out.push({ ...r, contactId, contactName: r.contactName || row.contactName || "" });
    }
  }
  return out;
}
