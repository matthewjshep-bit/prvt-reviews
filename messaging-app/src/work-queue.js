// work-queue.js — the order Today's rows are worked in, and what each row
// points at. Pure, so the rail, the pane and the keys agree, and the tests
// can pin it without a browser.
//
// The order is the one the old list rendered: Your call, then Stuck, then
// The machine is on it; inside each, kind by kind in ACTION_KINDS order
// (then the audit's), and the builder's own order within a kind.

import { ACTION_GROUPS, ACTION_KINDS } from "@shared/pipeline.js";
import { AUDIT_ACTION_KINDS } from "@shared/conversation-audit.js";

export const GROUP_ORDER = ["yours", "stuck", "machine"];
export const ALL_KINDS = [...ACTION_KINDS, ...AUDIT_ACTION_KINDS];
const KIND_RANK = Object.fromEntries(ALL_KINDS.map((k, i) => [k.key, i]));
export const KIND_LABEL = Object.fromEntries(ALL_KINDS.map((k) => [k.key, k.label]));
export const GROUP_LABEL = Object.fromEntries(ACTION_GROUPS.map((g) => [g.key, g.label]));

// An action with no group (an older broker) is yours.
export const groupOf = (a) => (GROUP_ORDER.includes(a?.group) ? a.group : "yours");

/** orderRows(actions) → actions, in the order they are worked. */
export function orderRows(actions = []) {
  return (actions || [])
    .map((a, i) => ({ a, i }))
    .sort((x, y) => GROUP_ORDER.indexOf(groupOf(x.a)) - GROUP_ORDER.indexOf(groupOf(y.a))
      || (KIND_RANK[x.a.kind] ?? 999) - (KIND_RANK[y.a.kind] ?? 999)
      || x.i - y.i)
    .map(({ a }) => a);
}

/** neighborId(list, id, dir) → the id one step away (dir +1 / -1), or null at an end. */
export function neighborId(list = [], id, dir = 1) {
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return list[0]?.id ?? null;
  return list[i + dir]?.id ?? null;
}

/**
 * nextAfterRemoval(prevList, nextList, id) → id
 *
 * After a refresh: the same row if it is still there; if it was resolved,
 * the row that came after it (or, at the end, the one before it); the first
 * row when nothing else fits.
 */
export function nextAfterRemoval(prevList = [], nextList = [], id) {
  const still = new Set(nextList.map((r) => r.id));
  if (id && still.has(id)) return id;
  const i = prevList.findIndex((r) => r.id === id);
  if (i >= 0) {
    for (let j = i + 1; j < prevList.length; j++) if (still.has(prevList[j].id)) return prevList[j].id;
    for (let j = i - 1; j >= 0; j--) if (still.has(prevList[j].id)) return prevList[j].id;
  }
  return nextList[0]?.id ?? null;
}

const INVESTOR_KINDS = new Set(["deal_no_buyers", "blast_no_opens", "investor_price_agreed", "closing_soon"]);
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
    offerId: item.offerId || draft?.outbound?.offerId || null,
    draftId: draft?.id || null,
    draft,
  };
}

// The Teach control's row id. A draft row is taught under its draft (the
// same key the outbox uses), every other row under its own id.
export const DRAFT_ROW_KINDS = new Set(["draft_waiting", "draft_scheduled"]);
export const teachRowId = (item) => (DRAFT_ROW_KINDS.has(item?.kind) && item.draftId ? `draft:${item.draftId}` : item?.id);

/** What the rail calls a row: the street, else the person, else the title. */
export function railLabel(item) {
  const street = String(item?.address || "").split(",")[0].trim();
  return street || item?.contactName || item?.title || "Untitled";
}

/**
 * keyIntent(e) → "next" | "prev" | "reply" | "teach" | "offer" | "help" | null
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
    case "?": return "help";
    default: return null;
  }
}

export const KEYS_HELP = [
  ["J  ↓", "next row"], ["K  ↑", "previous row"], ["R", "reply"], ["T", "teach the bot"], ["O", "open the offer"], ["⌘ ↵", "send what you typed"], ["?", "these keys"],
];

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
