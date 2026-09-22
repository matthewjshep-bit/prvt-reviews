// row-feedback.js — record "what should the bot have done?" said on a Today row.
//
// The vocabulary and the readers are in shared/row-feedback.js; this is the
// one write. The row's own context (what they said, what the bot wrote, the
// party, the intent) is read from the draft here, never taken from the
// client. The row's title and detail ride along in `data` as a fallback for
// rows with no draft; the coach is shown the detail and the kind, not the
// title. Nothing here is logged: the note is the owner's words about a
// named person.

import crypto from "node:crypto";
import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import {
  normalizeRowFeedback, publicRowFeedback, rowFeedbackDedupeKey,
  ROW_FEEDBACK_EVENT, ROW_FEEDBACK_SENTINEL_CONTACT,
} from "./shared/row-feedback.js";

const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
const idish = (v, n = 64) => clip(v, n);

/**
 * recordRowFeedback({ store, locationId, body, now }) → { ok, feedback }
 *
 * Throws { http: 400 } when the category is not one of ours or the row has
 * no id. Append-only: a second save on the same row is a newer event.
 */
export async function recordRowFeedback({ store = defaultStore, locationId, body = {}, now = Date.now() } = {}) {
  const fb = normalizeRowFeedback(body);
  if (!fb) throw Object.assign(new Error("category must be one of: should_have_replied, should_have_acted, wrong_read, right_to_hand_over"), { http: 400 });
  const rowId = clip(body.rowId, 200);
  if (!rowId) throw Object.assign(new Error("rowId is required"), { http: 400 });

  const draftId = idish(body.draftId);
  const draft = draftId && typeof store.getReplyDraft === "function" ? await store.getReplyDraft(draftId).catch(() => null) : null;
  const mine = draft && draft.locationId === locationId ? draft : null;
  const contactId = idish(body.contactId) || mine?.contactId || "";
  const party = mine?.party || (["agent", "investor"].includes(body.party) ? body.party : null);

  const at = new Date(now).toISOString();
  const event = {
    id: crypto.randomUUID(),
    party, type: ROW_FEEDBACK_EVENT, at,
    address: clip(body.address || mine?.propertyAddress, 200),
    offerId: idish(body.offerId) || mine?.outbound?.offerId || null,
    source: "operator",
    dedupeKey: rowFeedbackDedupeKey(rowId, at),
    data: {
      rowId, rowKind: clip(body.rowKind, 40), category: fb.category, note: fb.note,
      title: clip(body.title, 200), detail: clip(body.detail, 200),
      draftId: mine ? mine.id : draftId || null, offerId: idish(body.offerId) || mine?.outbound?.offerId || null,
      jobId: idish(body.jobId) || null, auditKind: clip(body.auditKind, 40),
      intent: mine?.intent || null, party,
      theySaid: clip(mine?.inbound, 300), botWrote: clip(mine?.reply, 300),
    },
  };

  let inserted = false;
  if (contactId) {
    const r = await recordEvent({ store, locationId, contactId, ...event });
    inserted = Boolean(r?.inserted);
  } else {
    // A row with no contact (a blast): filed under the sentinel, so no
    // profile is made up for it.
    const r = await store.appendContactEvents(locationId, ROW_FEEDBACK_SENTINEL_CONTACT, [event]);
    inserted = (r?.inserted || 0) > 0;
  }
  return { ok: true, recorded: inserted, feedback: publicRowFeedback({ ...event, data: event.data }) };
}
