// bot-hold.js — reads a person's Stop / Pause / Resume (and pace) presses for
// shared/bot-hold.js to judge.
//
// No time window, on purpose: the other timeline reads keep a few months or
// the newest few hundred events, and a stop pressed in June must still hold
// in October. Reads only — nothing here sends, writes or calls GHL.
//
// A read that fails is not "not stopped". holdFor answers { held: true,
// kind: "unread" }: a database hiccup costs a person one Send by hand,
// never a text to someone who asked us to stop. The send-time backstop
// returns an unread draft to wait rather than binning it.

import { BOT_EVENT_TYPES, botHold, mergeEvents } from "./shared/bot-hold.js";

const EPOCH = "1970-01-01T00:00:00.000Z";

/** botEventsFor({ store, locationId, contactId }) → this person's stop, resume, pace and unsubscribe events. */
export async function botEventsFor({ store, locationId, contactId }) {
  if (!contactId || typeof store?.listContactEvents !== "function") return [];
  return (await store.listContactEvents(locationId, contactId, { types: BOT_EVENT_TYPES, limit: 200 })) || [];
}

/**
 * holdFor({ store, locationId, contactId, offerId, now }) → botHold(...)
 * With `error` and kind "unread" when the read failed.
 */
export async function holdFor({ store, locationId, contactId, offerId = null, now = Date.now() }) {
  try {
    const events = await botEventsFor({ store, locationId, contactId });
    return botHold({ events, offerId, now });
  } catch (e) {
    return { held: true, kind: "unread", since: null, until: null, endedAt: null, reason: "", error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * botEventsByContact({ store, locationId }) → Map<contactId, events>
 *
 * The whole location's stop events in one read, for the sweeps and planners
 * that walk many people. A failed read throws: a sweep that can't tell who
 * is stopped doesn't run.
 */
export async function botEventsByContact({ store, locationId }) {
  const by = new Map();
  if (typeof store?.listContactEventsSince !== "function") return by;
  const rows = (await store.listContactEventsSince(locationId, EPOCH, { types: BOT_EVENT_TYPES, limit: 20000 })) || [];
  for (const e of rows) {
    if (!e?.contactId) continue;
    if (!by.has(e.contactId)) by.set(e.contactId, []);
    by.get(e.contactId).push(e);
  }
  return by;
}

/**
 * withBotEvents({ store, locationId, contactId, events }) → events
 *
 * A windowed timeline read with this person's stop events added back, so a
 * brake that reads "the newest 300" never loses an old stop.
 */
export async function withBotEvents({ store, locationId, contactId, events = [] }) {
  const extra = await botEventsFor({ store, locationId, contactId }).catch(() => []);
  return mergeEvents(events, extra);
}
