// offers-split.js — the Offers page's split: open an offer and the table
// shrinks to a rail on the left, and the offer is worked in the same pane as
// a Today row (Matt, 2026-10-01: "the offer and the person's contact were 2-3
// separate pages"). Pure, so the stand-in row and the keys are pinned.

import { keyIntent } from "./work-queue.js";

/**
 * offerPaneItem(offer) → a Today-row stand-in the pane's parts read
 * (PaneParts.jsx): who, which offer, which house. No ops, no group.
 */
export function offerPaneItem(o) {
  return {
    id: `offer:${o?.id}`, kind: "offer", severity: "fyi", group: "yours",
    contactId: o?.contactId || null, contactName: o?.contactName || "",
    offerId: o?.id || null, address: o?.address || "", title: "", detail: "", ops: [],
  };
}

const typing = (t) => {
  const tag = String(t?.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(t?.isContentEditable);
};

/**
 * splitKey(e, { blocked, doc }) → "next" | "prev" | "reply" | "teach" | "offer" | "close" | null
 *
 * Today's keys (work-queue.js keyIntent) plus Esc to go back to the table.
 * Nothing fires while you type, while a menu or dialog is open, or while
 * the page has a window open over it (`blocked`: the Send, PSA and other
 * modals on this page don't all say they are modal).
 */
export function splitKey(e, { blocked = false, doc = typeof document !== "undefined" ? document : null } = {}) {
  if (!e || blocked) return null;
  if (doc?.querySelector?.('[aria-modal="true"],[role="menu"],[role="dialog"]')) return null;
  if (e.key === "Escape") return e.metaKey || e.ctrlKey || e.altKey || typing(e.target) ? null : "close";
  const k = keyIntent(e);
  // D (dismiss) and ? are Today's; an offer isn't dismissed from a queue.
  return k === "dismiss" || k === "help" ? null : k;
}

/**
 * railStep(rows, openId, dir) → id | null
 * One step along the rail (+1 down, -1 up) from the open offer; the rail's
 * first row when the open one isn't on it (a filter moved it off).
 */
export function railStep(rows = [], openId, dir = 1) {
  const i = (rows || []).findIndex((o) => o?.id === openId);
  if (i < 0) return rows?.[0]?.id ?? null;
  return rows[i + dir]?.id ?? null;
}

/** The offer open in the split, kept in `?offer=<id>` (not `?offer_id=`, the editor's). */
export const readOfferParam = () => {
  try { return new URLSearchParams(window.location.search).get("offer") || null; } catch { return null; }
};
export const writeOfferParam = (id) => {
  try {
    const p = new URLSearchParams(window.location.search);
    if (id) p.set("offer", id); else p.delete("offer");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${p}`);
  } catch { /* the GHL iframe can refuse history calls */ }
};
