// last-activity.js — when we last actually spoke to someone, and who spoke.
//
// The offers table groups by agent but said nothing about temperature: an
// agent you talked to this morning and one who has never answered a text
// looked identical. This answers "when did we last communicate" for every
// contact in one pass.
//
// Two rules decide what counts.
//
// A COMMUNICATION is a message, not a record-keeping side effect. A tag
// landing, a fact learned, an enrichment run and an import all touch a
// contact without anyone saying anything, and counting them would make a
// dead agent read as "2h ago · you". So the vocabulary below is short and
// deliberate: things a person on the other end could have seen.
//
// DIRECTION is theirs or ours, and ours splits again. Most of our outbound
// is the bot — labelling an auto-sent follow-up "you" would be a lie, and
// the one thing worth knowing about a cold agent is whether a human has
// ever actually touched them. So `machine` rides along, decided by the same
// machineDid() the Flow river uses, so both features mean the same thing by
// "the machine".
//
// Pure. Rows in, Map out.

import { machineDid } from "./flow.js";

// Their message. These two are the only event types that ARE a record of
// something the other side said — everything else on the timeline is us, or
// us writing something down.
export const INBOUND_EVENT_TYPES = ["text_summary", "call_summary"];

// Ours. A booked call is included: it is a thing they agreed to and can see
// on their calendar, which is a conversation by any useful definition.
export const OUTBOUND_EVENT_TYPES = [
  "outreach_sent", "follow_up_sent", "offer_sent", "offer_revised", "blast_sent", "dataroom_sent", "call_booked",
];

export const LAST_ACTIVITY_TYPES = [...INBOUND_EVENT_TYPES, ...OUTBOUND_EVENT_TYPES];

const INBOUND = new Set(INBOUND_EVENT_TYPES);
const OUTBOUND = new Set(OUTBOUND_EVENT_TYPES);

const newer = (a, b) => String(a || "").localeCompare(String(b || "")) > 0;

/**
 * lastActivityFromEvents(rows) → Map<contactId, { at, dir, type, machine }>
 *
 * `rows` is whatever the store hands back — order doesn't matter, newest
 * wins either way. Rows outside the vocabulary are ignored rather than
 * filtered by the caller, so a caller that over-fetches still gets a
 * correct answer.
 */
export function lastActivityFromEvents(rows = []) {
  const out = new Map();
  for (const e of rows) {
    if (!e?.contactId || !e.at) continue;
    const dir = INBOUND.has(e.type) ? "in" : OUTBOUND.has(e.type) ? "out" : null;
    if (!dir) continue;
    const prev = out.get(e.contactId);
    if (prev && !newer(e.at, prev.at)) continue;
    // Their own message is never "the machine" — the bot reading a text does
    // not make the text automated.
    out.set(e.contactId, { at: e.at, dir, type: e.type, machine: dir === "in" ? false : machineDid(e) });
  }
  return out;
}

/**
 * mergeDraftActivity(map, drafts) → the same map, mutated.
 *
 * Why this exists: an agent's inbound text is summarised onto the timeline
 * by a model call that can fail, but a reply-draft row is written for every
 * inbound without exception (see follow-up-sweep.js, which relies on the
 * same thing). Skipping this pass would report "never heard from them" for
 * precisely the agents whose summariser fell over — the ones most worth
 * looking at.
 */
export function mergeDraftActivity(map, drafts = []) {
  for (const d of drafts) {
    if (!d?.contactId) continue;
    const consider = (at, dir, type, machine) => {
      if (!at) return;
      const prev = map.get(d.contactId);
      if (prev && !newer(at, prev.at)) return;
      map.set(d.contactId, { at, dir, type, machine });
    };
    // A draft exists because something came in — the inbound text is on the
    // row itself, stamped when we received it.
    if (String(d.inbound || "").trim()) consider(d.createdAt, "in", "text_summary", false);
    if (d.status === "sent") consider(d.sentAt || d.updatedAt, "out", "text_summary", Boolean(d.autoSent));
  }
  return map;
}
