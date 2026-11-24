// work-queue.js — what a work-pane row points at, its keys, and the all-in
// ratio. Pure, so the pane, the companion and the tests agree. The Desk's
// rail order and groups went with the Desk (retired 2026-10-20; the code,
// 2026-11-23).

import { annotateCurrent, houseKey } from "@shared/current-offer.js";
import { OPEN_STATUSES, effectiveStatus } from "@shared/offer-status.js";

const INVESTOR_KINDS = new Set(["deal_no_buyers", "blast_no_opens", "deal_interest_stalled", "deal_no_dataroom", "investor_price_agreed", "closing_soon", "showing_soon"]);
const OPEN_DRAFT = new Set(["draft", "scheduled"]);

/**
 * rowTargets(item, drafts) → { contactId, party, offerId, draftId, draft }
 *
 * Who the conversation is with, which offer the left side shows, and the
 * open bot draft (if any) the composer should be. The row's own draft wins;
 * otherwise the newest open draft for the same person, so a row about a
 * promise still lets you send the reply the bot already wrote.
 * investor_price_agreed carries the investor as its contact.
 */
export function rowTargets(item, drafts = []) {
  if (!item) return { contactId: null, party: "agent", offerId: null, draftId: null, draft: null };
  const byId = new Map((drafts || []).map((d) => [d.id, d]));
  let draft = item.draftId ? byId.get(item.draftId) || null : null;
  if (draft && !OPEN_DRAFT.has(draft.status || "draft")) draft = null;
  if (!draft && item.contactId) {
    draft = (drafts || [])
      .filter((d) => d.contactId === item.contactId && OPEN_DRAFT.has(d.status || "draft"))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
  }
  const party = draft?.party || (INVESTOR_KINDS.has(item.kind) || String(item.kind || "").startsWith("deal") ? "investor" : "agent");
  return {
    contactId: item.contactId || draft?.contactId || null,
    party,
    // A draft whose paper was held names the offer it would have sent.
    offerId: item.offerId || draft?.paperHold?.offerId || draft?.outbound?.offerId || null,
    draftId: draft?.id || null,
    draft,
  };
}

/**
 * defaultOfferFor(offers, address) → offer | null
 *
 * The offer to show beside a row that doesn't name one: a held reply to "go
 * through my business partner" carries no house, and the pane used to say
 * "No offer yet" beside a thread about one of theirs (Jeffrey Valcik,
 * 2026-09-29). Of their current offers: the one on the house the row names,
 * else the most recently active live one, else the most recent of any.
 * A draft comes after a real offer, but before "No offer yet": the draft-only
 * underwriter leaves one for Matt to price (Matt, 2026-10-19: "ALSO show
 * Offer DRAFTS in the companion").
 */
export function defaultOfferFor(offers = [], address = "") {
  const rows = (offers || []).filter(Boolean);
  const current = annotateCurrent(rows.filter((o) => o.status !== "draft")).filter((o) => !o.supersededBy);
  const byRecent = (list) => [...list].sort((a, b) => String(b.statusAt || b.createdAt || "").localeCompare(String(a.statusAt || a.createdAt || "")));
  const drafts = byRecent(rows.filter((o) => o.status === "draft"));
  const want = address ? houseKey(address) : "";
  const onHouse = (o) => houseKey(o.address || "") === want;
  const named = want ? current.find(onHouse) || drafts.find(onHouse) : null;
  if (named) return named;
  const recent = byRecent(current);
  return recent.find((o) => !o.deal && OPEN_STATUSES.has(effectiveStatus(o))) || recent[0] || drafts[0] || null;
}

// The Teach control's row id. A draft row is taught under its draft (the
// same key the outbox uses), every other row under its own id.
export const DRAFT_ROW_KINDS = new Set(["draft_waiting", "draft_scheduled"]);
export const teachRowId = (item) => (DRAFT_ROW_KINDS.has(item?.kind) && item.draftId ? `draft:${item.draftId}` : item?.id);

/**
 * keyIntent(e) → "next" | "prev" | "reply" | "teach" | "offer" | "dismiss" | "help" | null
 *
 * Typing is never a shortcut: nothing fires from a text box, a select, an
 * open menu, or with a modifier held.
 */
export function keyIntent(e) {
  if (!e || e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = e.target;
  const tag = String(t?.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return null;
  if (typeof t?.closest === "function" && t.closest('[role="menu"],[role="dialog"]')) return null;
  switch (e.key) {
    case "j": case "J": case "ArrowDown": return "next";
    case "k": case "K": case "ArrowUp": return "prev";
    case "r": case "R": return "reply";
    case "t": case "T": return "teach";
    case "o": case "O": return "offer";
    case "d": case "D": return "dismiss";
    case "?": return "help";
    default: return null;
  }
}

// Put words in the work pane's reply box — the bot's draft or the hand
// reply, whichever is showing — for a person to read and Send. detail: { text }.
export const COMPOSE_EVENT = "work-compose";

/**
 * composeInReplyBox(text, target) → true when a reply box on screen took the
 * words. Each reply box (HandReply, DraftComposer) takes them with
 * takeCompose, which marks them taken; with none mounted nothing does, and
 * the caller says so instead of pointing at a box that isn't there.
 */
export function composeInReplyBox(text, target = typeof window !== "undefined" ? window : null) {
  if (!target || !text) return false;
  const detail = { text: String(text), taken: false };
  target.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail }));
  return detail.taken;
}

/** takeCompose(e) → the words for this reply box (marked taken), or null. */
export function takeCompose(e) {
  const text = e?.detail?.text;
  if (!text) return null;
  e.detail.taken = true;
  return String(text);
}

/**
 * allInPct({ price, repairs, arv }) → number | null
 *
 * What a buyer is in for, as a share of the after-repair value. Buyers pay
 * about 70% of ARV all-in; the three deals that fell through asked 74–82%
 * (the 2026-09-10 post-mortem).
 */
export function allInPct({ price, repairs = 0, arv }) {
  const p = Number(price) || 0, a = Number(arv) || 0;
  if (p <= 0 || a <= 0) return null;
  return Math.round(((p + (Number(repairs) || 0)) / a) * 1000) / 10;
}
export const allInTone = (pct) => (pct == null ? "none" : pct <= 70 ? "good" : pct <= 74 ? "close" : "over");
