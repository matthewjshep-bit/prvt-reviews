// next-follow-up.js — the Offers tab's "Next follow-up" column, fed.
//
// The rules are pure and live in shared/next-follow-up.js. This is the I/O:
// two location-wide reads (reply drafts and the timeline events the clocks
// use), grouped by contact, then one answer per offer row. Never a read per
// row — the book is a few hundred offers and the page loads it whole.

import { nextFollowUp } from "./shared/next-follow-up.js";
import { conversationConfig } from "./reply-agent.js";
import { FOLLOW_UP_UTC_HOUR } from "./follow-up-sweep.js";

const DAY_MS = 86400000;
// Far enough back for the check-in ladder's last rung (day 120) to still see
// what happened on the thread that started it.
export const NEXT_WINDOW_DAYS = 130;
// The sweep reads a contact's newest twenty drafts; the column reads the same.
const DRAFTS_PER_CONTACT = 20;
export const NEXT_EVENT_TYPES = [
  "promise_made", "promise_owed", "promise_kept",
  "checkin_requested", "checkin_sent", "text_summary", "call_summary",
  "listing_off_market", "drive_stopped", "drive_resumed", "unsubscribed", "hand_reply",
];

const groupBy = (rows, cap = Infinity) => {
  const m = new Map();
  for (const r of rows || []) {
    if (!r?.contactId) continue;
    if (!m.has(r.contactId)) m.set(r.contactId, []);
    const list = m.get(r.contactId);
    if (list.length < cap) list.push(r);
  }
  return m;
};

/**
 * attachNextFollowUps({ store, locationId, saved, offers, drafts?, now })
 *   → offers (each gains `nextFollowUp`)
 *
 * `drafts` may be handed in when the caller already read them (the activity
 * column reads the same table). Newest first, as the store returns them.
 * A read that fails leaves the column saying less, never the table down.
 */
export async function attachNextFollowUps({ store, locationId, saved = {}, offers = [], drafts = null, now = Date.now() }) {
  const since = new Date(now - NEXT_WINDOW_DAYS * DAY_MS).toISOString();
  const [draftRows, events] = await Promise.all([
    drafts || store.listReplyDrafts(locationId, { since, limit: 4000 }).catch(() => []),
    typeof store.listContactEventsSince === "function"
      ? store.listContactEventsSince(locationId, since, { types: NEXT_EVENT_TYPES, limit: 20000 }).catch(() => [])
      : [],
  ]);
  const draftsBy = groupBy(draftRows, DRAFTS_PER_CONTACT);
  const eventsBy = groupBy(events);
  const config = conversationConfig(saved || {});
  for (const o of offers) {
    if (!o) continue;
    o.nextFollowUp = nextFollowUp({
      offer: o, config, now, sweepHour: FOLLOW_UP_UTC_HOUR,
      drafts: draftsBy.get(o.contactId) || [], events: eventsBy.get(o.contactId) || [],
    });
  }
  return offers;
}
