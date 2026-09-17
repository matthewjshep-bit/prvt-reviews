// promise-resolver.js — what the machine does about a promise we made.
//
// On 2026-09-17 Today carried ten "we owe them a number / an answer" rows and
// every one of them offered a single button: Dismiss. Some were not owed at
// all (our text ended by asking THEM something), some had a priced offer
// sitting unfloated, some had an underwrite held on thin comps that the
// agent's own numbers would clear, and some had no underwrite ever started.
// A person had to work out which, ten times.
//
// This module works it out. Pure: the promise, the contact's offers, drafts
// and jobs go in, one move comes out. The Today row (shared/pipeline.js) shows
// the move and offers its button; the promise sweep (ghl-broker/
// promise-sweep.js) uses `not_owed` to stop texting "we owe you" to somebody
// we asked a question.

import { sameStreet } from "./us-address.js";
import { aiHoldReasons, effectiveStatus, OPEN_STATUSES } from "./offer-status.js";
import { detectPromise } from "./follow-up.js";

const HOUR_MS = 3600000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

export const PROMISE_MOVES = ["send_number", "start_underwrite", "ask_numbers", "rerun", "wait", "not_owed", "yours"];

// promise_made keeps the first 200 characters of what we said
// (reply-agent.js sendReplyDraft). A text that long may have been cut before
// its last sentence, so its ending proves nothing.
export const PROMISE_TEXT_KEPT = 200;

// "…sound good?" hands nothing back: the promise still stands.
const TAG_QUESTION = /^(?:does\s+that\s+|would\s+that\s+|will\s+that\s+|that\s+)?(?:sound\s+(?:good|ok(?:ay)?|fair)|work(?:s)?(?:\s+for\s+you)?|make\s+sense|ok(?:ay)?|fair(?:\s+enough)?|cool|deal|alright|all\s+right|good)\s*\?$/i;

/**
 * endsWithQuestionToThem(text) → boolean
 *
 * Whether the last thing we said was a real question for them to answer:
 * the ball is in their court, and we owe nothing until they hit it back.
 */
export function endsWithQuestionToThem(text = "") {
  const t = String(text || "").trim();
  if (!t.endsWith("?")) return false;
  const last = t.split(/(?<=[.!?])\s+/).filter(Boolean).at(-1) || "";
  // "I'll get back to you today, sound good?" — the question is only the tail.
  const tail = last.split(/[,;—-]\s*/).filter(Boolean).at(-1) || last;
  if (TAG_QUESTION.test(tail.trim())) return false;
  return true;
}

/**
 * openPromises(events, { now, windowHours }) → [{ contactId, since, address, what, text, draftId, asksThem, owedAt }]
 *
 * One per contact: everything promised since their last `promise_kept`.
 * `since` is the earliest open promise, `owedAt` when the sweep said so.
 * The same derivation the sweep, settlePromise and Today each did by hand.
 */
export function openPromises(events = [], { now = Date.now(), windowHours = 72 } = {}) {
  const floor = now - windowHours * HOUR_MS;
  const byContact = new Map();
  for (const e of events) {
    if (!e?.contactId || !["promise_made", "promise_owed", "promise_kept"].includes(e.type)) continue;
    if ((ms(e.at) ?? 0) < floor) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }
  const out = [];
  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const lastKept = list.filter((e) => e.type === "promise_kept").at(-1)?.at || "";
    const made = list.filter((e) => e.type === "promise_made" && String(e.at) > lastKept);
    const owed = list.filter((e) => e.type === "promise_owed" && String(e.at) >= lastKept).at(-1) || null;
    if (!made.length && !owed) continue;
    const newest = made.at(-1) || owed;
    out.push({
      contactId,
      since: made[0]?.at || owed.at,
      address: [...made].reverse().find((p) => p.address)?.address || owed?.address || "",
      what: [...made, owed].some((p) => p?.data?.what === "number") ? "number" : "answer",
      text: String(newest.data?.text || ""),
      draftId: newest.data?.draftId || null,
      asksThem: newest.data?.asksThem === true,
      owedAt: owed?.at || null,
    });
  }
  return out;
}

// Enough of an address to price: a house number, a street, and a city or ZIP.
const fullAddress = (a) => /^\s*\d+\s+\S+/.test(String(a || "")) && /,|\b\d{5}\b/.test(String(a || ""));
// Replies that answer nothing.
const QUIET_INTENTS = new Set(["small_talk", "media", "opt_out"]);

/**
 * resolvePromise({ promise, offers, drafts, jobs, heldTriage, now })
 *   → { move, reason, offerId, kind?, needs? }
 *
 *   promise     one row of openPromises()
 *   offers      this contact's offers (lean rows are enough)
 *   drafts      this contact's reply drafts, any status
 *   jobs        this contact's auto-underwrite jobs
 *   heldTriage  triageHeldUnderwrite()'s verdict for the held draft on that
 *               house, when there is one — handed in so both stay pure
 *   heldTriageByOffer  the same, keyed by offer id, when the caller has several
 */
export function resolvePromise({ promise, offers = [], drafts = [], jobs = [], heldTriage = null, heldTriageByOffer = null, now = Date.now() } = {}) {
  const p = promise || {};
  const address = String(p.address || "").trim();
  const onHouse = (a) => !address || (Boolean(a) && sameStreet(a, address));
  const mine = (offers || []).filter((o) => o && (!p.contactId || o.contactId === p.contactId) && onHouse(o.address));
  const held = mine.find((o) => effectiveStatus(o) === "draft" && aiHoldReasons(o).length) || null;
  const base = { offerId: null };

  // 1. They wrote, and we gave them a real answer. Only an owed ANSWER closes
  //    this way: a promised number is kept by a number.
  if (p.what !== "number") {
    const answered = (drafts || []).find((d) => d && d.status === "sent" && String(d.inbound || "").trim()
      && String(d.sentAt || d.createdAt || "") > String(p.since || "")
      && !QUIET_INTENTS.has(d.intent) && d.outbound?.kind !== "promise_due"
      && !detectPromise(d.reply || d.body || ""));
    if (answered) return { ...base, move: "not_owed", reason: "they wrote back and we answered" };
  }

  // 2. We ended on a question to them.
  const text = String(p.text || "");
  if (p.asksThem === true || (text.length < PROMISE_TEXT_KEPT && endsWithQuestionToThem(text))) {
    return { ...base, move: "not_owed", reason: "our text ended with a question to them" };
  }

  // 3. The number exists and nobody floated it.
  const floated = (o) => Math.max(ms(o.proactive?.takeCheckAt) ?? 0, ms(o.proactive?.realmCheckAt) ?? 0) > (ms(p.since) ?? 0);
  const priced = mine.find((o) => OPEN_STATUSES.has(effectiveStatus(o)) && Number(o.cashAmount) > 0 && !(o.sends || []).length && !floated(o));
  if (priced) return { move: "send_number", offerId: priced.id, reason: "the offer is priced and nothing has gone out" };

  // 4. It is on its way.
  const live = (jobs || []).find((j) => j && (j.status === "running" || j.status === "queued") && j.contactId && j.contactId === p.contactId);
  if (live) return { ...base, move: "wait", reason: "the underwrite is still running" };

  // 5. Held: the nightly triage already knows what clears it.
  if (held) {
    const t = heldTriage || heldTriageByOffer?.[held.id] || null;
    const reason = String(t?.reason || aiHoldReasons(held)[0] || "").split(" — ")[0].slice(0, 160);
    if (t?.action === "rerun") return { move: "rerun", offerId: held.id, needs: t.needs || [], askingPrice: Number(t.askingPrice) || Number(held.askingPrice) || 0, reason };
    if (t?.action === "ask") return { move: "ask_numbers", offerId: held.id, needs: t.needs || [], reason };
    if (t?.action === "wait") return { move: "wait", offerId: held.id, needs: t.needs || [], reason };
    return { move: "yours", offerId: held.id, reason: reason || "the underwrite held" };
  }

  // 6. Nothing ever ran on that house.
  if (p.what === "number" && fullAddress(address)) return { ...base, move: "start_underwrite", reason: "no underwrite has run on this house" };

  // 7. A person's.
  if (p.what !== "number") return { ...base, move: "yours", kind: "partner_answer", reason: "a question the bot couldn't answer" };
  return { ...base, move: "yours", reason: address ? "there isn't enough of an address to price" : "we never learned which house" };
}

/* ---------- why a row was dismissed ---------- */

export const PROMISE_DISMISS_REASONS = ["handled_by_call", "not_a_promise", "they_went_quiet", "deal_dead", "other"];
export const PROMISE_DISMISS_LABEL = {
  handled_by_call: "Handled it by phone",
  not_a_promise: "We didn't owe anything",
  they_went_quiet: "They went quiet",
  deal_dead: "Not a deal",
  other: "Something else",
};

/**
 * normalizePromiseDismissal(v) → { code, note } | null
 * Same shape as a draft's feedback (shared/conversation-ai.js), so the coach
 * reads both the same way.
 */
export function normalizePromiseDismissal(v) {
  if (!v) return null;
  const raw = typeof v === "string" ? { code: v } : v;
  if (typeof raw !== "object") return null;
  const code = PROMISE_DISMISS_REASONS.includes(raw.code) ? raw.code : "other";
  return { code, note: String(raw.note || "").trim().slice(0, 200) };
}

/* ---------- the answer box ---------- */

/**
 * answerNamesMoney(text) → boolean
 * A dollar figure in a standing answer means every reply that repeats it
 * waits for a person: the money guard only passes numbers from the offer
 * book. Day counts and percentages are fine. The box says so before Send.
 */
export const answerNamesMoney = (text = "") => /\$\s?\d|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?(?:k|m|mm|grand)\b/i.test(String(text || ""));
