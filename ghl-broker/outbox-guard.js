// outbox-guard.js — one voice at a time.
//
// A text the machine starts (a nudge, a check-in, a float) never replaces a
// reply to their text, or anything a person wrote, that is waiting in the
// outbox. The rule is shared/follow-up.js blockingDraft; this is the one read
// every caller makes. The sweeps ask BEFORE they claim a rung, so a text that
// stands down spends nothing; startProactive asks again, and runProactive a
// last time at save, because the model call in between takes seconds and the
// agent may text in the meantime.
//
// Its own module so the sweeps can use it without importing reply-agent.js.

import { blockingDraft, blockingReason } from "./shared/follow-up.js";

/**
 * draftWaitingOnYou({ store, locationId, contactId, continues }) → draft | null
 *
 * `continues`: the draft this text carries on from, which it may replace.
 */
export async function draftWaitingOnYou({ store, locationId, contactId, continues = null }) {
  if (!contactId || typeof store?.listReplyDrafts !== "function") return null;
  const open = [];
  for (const status of ["draft", "scheduled"]) {
    const rows = await store.listReplyDrafts(locationId, { contactId, status, limit: 10 }).catch(() => []);
    open.push(...(rows || []).filter((d) => d?.contactId === contactId || !d?.contactId));
  }
  return blockingDraft(open, { continues });
}

/** The reason a skipped row shows, or "" when nothing is waiting. */
export async function waitingReason(args) {
  const d = await draftWaitingOnYou(args);
  return d ? blockingReason(d) : "";
}
