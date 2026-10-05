// buyer-touch.js — the broker's side of the weekly limit per buyer
// (shared/buyer-touch.js has the rules and the why). One read of the
// buyer's sent drafts and their record events; nothing written.

import { touchLimit, normalizeTouchBudget } from "./shared/buyer-touch.js";

const TALK_TYPES = ["text_summary", "call_summary", "investor_evaluating", "investor_committed"];

/**
 * buyerTouchLimit({ store, locationId, contactId, budget, now })
 *   → { open, at, used, allowed, talking }
 *
 * A read that fails reads as "open": the limit holds texts back, so a
 * hiccup in the store must not hold every deal text in the book.
 */
export async function buyerTouchLimit({ store, locationId, contactId, budget = {}, now = Date.now() }) {
  const b = normalizeTouchBudget(budget);
  if (!b.enabled || !contactId) return { open: true, at: now, used: 0, allowed: 0, talking: false };
  try {
    const [drafts, events] = await Promise.all([
      store.listReplyDrafts(locationId, { contactId, status: "sent", limit: 60 }),
      typeof store.listContactEvents === "function"
        ? store.listContactEvents(locationId, contactId, { types: TALK_TYPES, limit: 100 })
        : Promise.resolve([]),
    ]);
    return touchLimit({ drafts, events, now, budget: b });
  } catch {
    return { open: true, at: now, used: 0, allowed: 0, talking: false };
  }
}

// "Tue Oct 7" — when a held deal text goes, for the flag on the row.
export function slotWord(at) {
  return new Date(at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}
