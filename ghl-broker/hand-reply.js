// hand-reply.js — a text a person typed on Today's work pane, with no bot draft.
//
// 2026-09-23: Today became one pane per row (offer · conversation · coach).
// When the bot has a draft open, the composer IS that draft and goes out
// through sendReplyDraft, so an edit still reaches the coach. When it has
// none, a person can still answer, and this is that send.
//
// A person typing is a person having the thread:
//   - the contact's open drafts stand aside (dismissed, answeredBy "you"),
//     the same mark sendReplyDraft's auto path leaves;
//   - a `hand_reply` event goes on the timeline, which threadHealth reads as
//     person_has_it for three days, so the drivers leave the thread alone.
//
// Dry run unless CARD_SENDS_ENABLED, like every other send. SMS only. The
// words are in GHL's thread; neither the event nor any log carries them.

import { sendSms as defaultSendSms, removeContactTags as defaultRemoveContactTags } from "./ghl.js";
import { recordEvent } from "./contact-record.js";
import { RA_TAGS } from "./reply-agent.js";
import { HAND_REPLY_EVENT } from "./shared/thread-health.js";

export const HAND_REPLY_MAX = 1600;
const OPEN = ["draft", "scheduled"];
const idish = (v) => String(v == null ? "" : v).trim().slice(0, 64);

/**
 * sendHandReply({ client, store, locationId, contactId, text, offerId, live, deps, now })
 *   → { ok, dryRun, preview? , standAside, messageId? }
 *
 * Throws { http: 400 } for no contact or an empty/overlong text. A GHL
 * failure throws before anything is written.
 */
export async function sendHandReply({ client = null, store, locationId, contactId, text, offerId = null, live = false, deps = {}, now = Date.now() }) {
  const who = idish(contactId);
  const body = String(text == null ? "" : text).trim();
  if (!who) throw Object.assign(new Error("contactId is required"), { http: 400 });
  if (!body) throw Object.assign(new Error("type the text first"), { http: 400 });
  if (body.length > HAND_REPLY_MAX) throw Object.assign(new Error(`that's over ${HAND_REPLY_MAX} characters`), { http: 400 });

  if (!live) return { ok: true, dryRun: true, preview: { channel: "sms", to: who, message: body }, standAside: 0 };

  const sendSms = deps.sendSms || defaultSendSms;
  const removeContactTags = deps.removeContactTags || defaultRemoveContactTags;
  const result = await sendSms(client, { contactId: who, message: body });

  const ts = new Date(now).toISOString();
  const open = await store.listReplyDrafts(locationId, { contactId: who, status: OPEN, limit: 50 }).catch(() => []);
  for (const d of open) {
    await store.updateReplyDraft(d.id, {
      ...d, status: "dismissed", answeredBy: "you", sendAt: null, sendingAt: null, dismissedAt: ts, updatedAt: ts,
      flags: [...(d.flags || []), "you answered it yourself — the bot stood aside"],
    });
  }
  if (open.length) await removeContactTags(client, who, [RA_TAGS.draft]).catch(() => {});

  const messageId = result?.messageId || result?.id || null;
  await recordEvent({
    store, locationId, contactId: who, type: HAND_REPLY_EVENT, at: ts, offerId: idish(offerId) || null,
    source: "operator", ref: messageId, dedupeKey: `hand_reply:${who}:${messageId || ts}`,
    data: { messageId, chars: body.length, stoodAside: open.map((d) => d.id) },
  });
  return { ok: true, dryRun: false, standAside: open.length, messageId };
}
