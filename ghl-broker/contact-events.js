// contact-events.js — a whole window of the location's timeline.
//
// store.listContactEventsSince caps its read (keeping the newest rows and
// saying so). A reader that must see ALL of a window — the Flow tab's counts,
// the Line view — walks it a page at a time instead, up to a ceiling, and is
// told when the ceiling cut it short.

/**
 * allEventsSince(store, locationId, sinceIso, { types, notParty }, { ceiling, pageSize })
 *   → { events, truncated }
 *
 * Oldest first. A store without paging (a test double) answers with one
 * capped read.
 */
export async function allEventsSince(store, locationId, sinceIso, opts = {}, { ceiling = 50000, pageSize = 2000 } = {}) {
  const { types = null, notParty = null } = opts || {};
  if (typeof store?.listContactEventsPage !== "function") {
    const rows = await store.listContactEventsSince(locationId, sinceIso, { types, notParty, limit: ceiling });
    return { events: [...rows], truncated: Boolean(rows?.truncated) };
  }
  const events = [];
  let after = null;
  while (events.length < ceiling) {
    const { rows, next } = await store.listContactEventsPage(locationId, sinceIso, {
      types, notParty, after, limit: Math.min(pageSize, ceiling - events.length),
    });
    events.push(...rows);
    if (!next || !rows.length) return { events, truncated: false };
    after = next;
  }
  // At the ceiling: cut short only if there is really more.
  const probe = await store.listContactEventsPage(locationId, sinceIso, { types, notParty, after, limit: 1 });
  return { events, truncated: probe.rows.length > 0 };
}
