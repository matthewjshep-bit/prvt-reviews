// offers-refresh.js — the Offers table re-reads its rows while it's open
// (2026-11-23 audit, table-never-refreshes). The book loaded once: a status
// the bot set (countered, hot, passed), a new auto-underwritten offer or a
// deleted one didn't show until a reload, and a reload re-runs the heavy
// activity and follow-up read.
//
// The re-read is the light one (GET /api/offers?lean=1: the stored rows,
// nothing worked out per request), every few minutes while the tab shows
// (light-poll.js). It keeps each agent's Last activity and float time from
// the first load, and re-reads What's next only for the few agents whose rows
// changed, one at a time. Pure, so what it keeps is pinned.

import { effectiveStatus } from "@shared/offer-status.js";

// At most this many agents' What's next re-read per pass (one small read each).
export const MAX_CONTACT_REREADS = 5;

// What the first load worked out per request, not stored on the row.
const DERIVED = new Set(["lastActivity", "floatedAt", "nextFollowUp", "needsMatt"]);
// A lean row carries no updatedAt, so a row changed when anything stored on
// it did (status, counter, hot, sends, a newer row on its house…).
const stored = (o) => JSON.stringify(Object.keys(o).filter((k) => !DERIVED.has(k)).sort().map((k) => [k, o[k]]));
const changed = (a, b) => stored(a) !== stored(b);

/**
 * mergeLean(prev, fresh) → { rows, contacts }
 *   rows      the fresh book, each row keeping what only the first load had
 *             (lastActivity, floatedAt, nextFollowUp); What's next marked
 *             stale on a row whose status moved, as a status change from the
 *             page does
 *   contacts  agents whose rows changed, new or gone: theirs to re-read
 */
export function mergeLean(prev = [], fresh = []) {
  const before = new Map((prev || []).map((o) => [o.id, o]));
  const contacts = new Set();
  const rows = (fresh || []).map((o) => {
    const was = before.get(o.id);
    if (!was) { if (o.contactId) contacts.add(o.contactId); return o; }
    before.delete(o.id);
    const moved = changed(was, o);
    if (moved && o.contactId) contacts.add(o.contactId);
    const keep = { lastActivity: was.lastActivity, floatedAt: was.floatedAt,
      nextFollowUp: was.nextFollowUp && effectiveStatus(was) !== effectiveStatus(o) ? { stale: true } : was.nextFollowUp };
    for (const k of Object.keys(keep)) if (keep[k] === undefined) delete keep[k];
    return moved ? { ...o, ...keep } : was;
  });
  for (const gone of before.values()) if (gone.contactId) contacts.add(gone.contactId);
  return { rows, contacts: [...contacts] };
}

/**
 * applyLean(base, current, fresh) → mergeLean's result, or null to drop it.
 *   base     the table's rows when the re-read left
 *   current  the table's rows now
 * Null when the table changed while the read was out (a status, a send, a
 * delete from this page): that read is older than what Matt just did, so it
 * is dropped instead of putting the old row back, and the next one brings
 * whatever the bot changed.
 */
export function applyLean(base, current, fresh) {
  if (!current || current !== base) return null;
  return mergeLean(current, fresh);
}
