// opt-out.js — the reads and writes behind shared/opt-out.js.
//
// Matt, 2026-11-09: an opt-out on any channel (a STOP, "take me off your
// list" by text or email, an email unsubscribe, GHL DND on either channel, a
// dnc or unsubscribed tag) stops every text and email the machine starts, for
// good. His own texts still go: nothing here is asked when a person presses
// Send, and nothing here sets DND in GHL (that would block him too).
//
//   optedOutFor        one contact: their GHL contact, their `unsubscribed`
//                      events and their opt-out drafts → { via, at } | null
//   optedOutContactIds the whole location in two reads, for a list (a wave)
//   recordOptOut       the durable record: one `unsubscribed` event per
//                      contact (the same dedupe key markUnsubscribed uses)
//   runOptOutBackfill  the past, once: every handled opt-out and every
//                      dnc / unsubscribed tag in GHL gets the event, and the
//                      machine texts and emails waiting for them are binned
//
// Results and logs carry counts and ids, never a name, a phone or a word.

import { recordEvent } from "./contact-record.js";
import { allEventsSince } from "./contact-events.js";
import { searchAllContactsByTags } from "./ghl.js";
import { optedOut, dndOn, optOutTag, OPT_OUT_EVENT, OPT_OUT_INTENT } from "./shared/opt-out.js";
import { MACHINE_STARTED_KINDS } from "./shared/follow-up.js";

const EPOCH = "1970-01-01T00:00:00.000Z";
const iso = (t) => new Date(t).toISOString();
// A store read a test double (or an old store) doesn't have reads as nothing.
const read = async (store, method, ...args) => (typeof store?.[method] === "function" ? (await store[method](...args).catch(() => null)) || [] : []);

/**
 * optedOutFor({ store, locationId, contactId, contact, readContact, events, optOutTags, exceptDraftId })
 *   → { via, at, tag? } | null
 *
 * `contact` is the GHL contact when the caller has it; left undefined, it is
 * read with `readContact(contactId)` when one is given (a failed read is no
 * contact: the timeline still answers). `events` adds what the caller already
 * read. `exceptDraftId` leaves out the draft being sent. Reads that fail read
 * as nothing; the send-time check behind every machine send asks again.
 */
export async function optedOutFor({ store, locationId, contactId, contact = undefined, readContact = null, events = [], optOutTags = [], exceptDraftId = null } = {}) {
  if (!contactId) return null;
  let c = contact;
  if (c === undefined) c = typeof readContact === "function" ? await readContact(contactId).catch(() => null) : null;
  const [unsub, handled, open] = await Promise.all([
    read(store, "listContactEvents", locationId, contactId, { types: [OPT_OUT_EVENT], limit: 5 }),
    read(store, "listReplyDrafts", locationId, { contactId, status: "handled", intent: OPT_OUT_INTENT, limit: 5 }),
    read(store, "listReplyDrafts", locationId, { contactId, status: "draft", limit: 20 }),
  ]);
  return optedOut({
    contact: c,
    events: [...(events || []), ...unsub],
    drafts: [...handled.filter((d) => d?.intent === OPT_OUT_INTENT), ...open.filter((d) => d?.id !== exceptDraftId)],
    optOutTags,
  });
}

/**
 * optedOutContactIds({ store, locationId }) → Set<contactId>
 *
 * Everyone on the record as opted out: an `unsubscribed` event (the whole
 * timeline, paged) or an opt-out the reply agent handled. Throws when a read
 * fails, so a caller can tell "nobody" from "couldn't tell".
 */
export async function optedOutContactIds({ store, locationId }) {
  const { events } = await allEventsSince(store, locationId, EPOCH, { types: [OPT_OUT_EVENT] });
  const drafts = await store.listReplyDrafts(locationId, { status: "handled", intent: OPT_OUT_INTENT, limit: 50000 });
  const ids = new Set();
  // By type as well: a store that ignores the filter (a test double) mustn't
  // turn a Stop or a note into an opt-out.
  for (const e of events || []) if (e?.contactId && e.type === OPT_OUT_EVENT) ids.add(e.contactId);
  for (const d of drafts || []) if (d?.contactId && d.intent === OPT_OUT_INTENT) ids.add(d.contactId);
  return ids;
}

/**
 * bookDnd(contact, unsubscribedIds) → true for a buyer the deal texts skip
 *
 * The book row's `dnd` (routes/dispo.js syncBook): a STOP (SMS DND), an
 * email unsubscribe (Email DND) or an `unsubscribed` event. Until 2026-11-09
 * it was SMS DND alone, so a buyer who unsubscribed from our email still got
 * every deal by text.
 */
export function bookDnd(contact, unsubscribedIds = null) {
  return dndOn(contact, "sms") || dndOn(contact, "email") || Boolean(contact?.id && unsubscribedIds?.has?.(contact.id));
}

/**
 * recordOptOut({ store, locationId, contactId, party, via, channel, confidence, now }) → { inserted }
 *
 * via: "sms_keyword" | "email" | "model" | "you" | "asked_left_alone" | "backfill"
 * One per contact, ever: the dedupe key is the contact's, shared with the
 * DND flag (reply-agent.js markUnsubscribed), so the first record stands.
 */
export async function recordOptOut({ store, locationId, contactId, party = null, via, channel = "sms", confidence = null, now = Date.now() }) {
  const who = ["agent", "investor", "gatekeeper"].includes(party) ? party : null;
  return recordEvent({
    store, locationId, contactId, party: who, type: OPT_OUT_EVENT, at: iso(now), address: "", source: "conversation",
    dedupeKey: `${OPT_OUT_EVENT}:${contactId}`,
    data: { via: String(via || "opted_out"), channel: channel === "email" ? "email" : "sms", ...(confidence ? { confidence } : {}) },
  });
}

/** A text or email the machine started, with nothing of theirs in it to answer. */
export const machineStarted = (d) => (MACHINE_STARTED_KINDS.has(d?.outbound?.kind) || d?.outbound?.kind === "blast_open") && !String(d?.inbound || "").trim();

/**
 * runOptOutBackfill({ client, store, locationId, optOutTags, dryRun, now, deps })
 *   → { dryRun, contacts, fromDrafts, fromTags, alreadyMarked, eventsWritten, draftsDismissed, tagsRead, truncated }
 *
 * Matt's rule for the past (routes/outreach.js POST /opt-outs/backfill): every
 * contact with an opt-out the reply agent handled, or a tag in GHL that says
 * do not contact (the page's opt-out tags, `unsubscribed`, `dnc`), gets an
 * `unsubscribed` event (via "backfill"), and the machine texts and emails
 * waiting for anyone opted out are dismissed (dismissedBy "opt_out"). A
 * reply to them waits for Matt as it was. A bot-off tag is left out: it is
 * yours to take off again. A dry run reads and counts, and writes nothing.
 * Counts only. Run twice, it does nothing twice.
 *
 * deps.searchByTags(tags) → { contacts, truncated } stands in for GHL.
 */
export async function runOptOutBackfill({ client = null, store, locationId, optOutTags = [], dryRun = true, now = Date.now(), deps = {} }) {
  const tags = [...new Set([...(optOutTags || []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean), "unsubscribed", "dnc"])];
  const search = typeof deps.searchByTags === "function" ? deps.searchByTags
    : client ? (t) => searchAllContactsByTags(client, locationId, t) : null;

  const handled = (await store.listReplyDrafts(locationId, { status: "handled", intent: OPT_OUT_INTENT, limit: 50000 }) || [])
    .filter((d) => d?.contactId && d.intent === OPT_OUT_INTENT);
  const partyOf = new Map();
  const fromDrafts = new Set();
  for (const d of handled) { fromDrafts.add(d.contactId); if (d.party && !partyOf.has(d.contactId)) partyOf.set(d.contactId, d.party); }

  const fromTags = new Set();
  let truncated = false;
  if (search) {
    const found = await search(tags);
    truncated = Boolean(found?.truncated);
    for (const c of found?.contacts || []) {
      if (c?.id && optOutTag(c.tags || [], optOutTags)) fromTags.add(c.id);
    }
  }

  const { events } = await allEventsSince(store, locationId, EPOCH, { types: [OPT_OUT_EVENT] });
  const marked = new Set((events || []).filter((e) => e?.type === OPT_OUT_EVENT).map((e) => e.contactId).filter(Boolean));
  const contacts = new Set([...fromDrafts, ...fromTags]);

  let eventsWritten = 0;
  for (const id of contacts) {
    if (marked.has(id)) continue;
    if (dryRun) { eventsWritten++; continue; }
    const r = await recordOptOut({ store, locationId, contactId: id, party: partyOf.get(id) || null, via: "backfill", now });
    if (r?.inserted) eventsWritten++;
  }

  const everyone = new Set([...contacts, ...marked]);
  const open = (await store.listReplyDrafts(locationId, { status: ["draft", "scheduled"], limit: 50000 }) || [])
    .filter((d) => d && everyone.has(d.contactId) && (d.status === "draft" || d.status === "scheduled") && machineStarted(d));
  let draftsDismissed = 0;
  for (const d of open) {
    if (!dryRun) {
      const ts = iso(now);
      await store.updateReplyDraft(d.id, {
        ...d, status: "dismissed", dismissedBy: "opt_out", dismissedAt: ts, sendAt: null, sendingAt: null, updatedAt: ts,
        flags: [...(d.flags || []), "they opted out, not sent"],
      });
    }
    draftsDismissed++;
  }

  return {
    dryRun: Boolean(dryRun), contacts: contacts.size, fromDrafts: fromDrafts.size, fromTags: fromTags.size,
    alreadyMarked: [...contacts].filter((id) => marked.has(id)).length, eventsWritten, draftsDismissed,
    tagsRead: Boolean(search), truncated,
  };
}
