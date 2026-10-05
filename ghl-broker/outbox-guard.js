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
import { holdFor } from "./bot-hold.js";
import { holdLine } from "./shared/bot-hold.js";

/**
 * draftWaitingOnYou({ store, locationId, contactId, continues }) → draft | null
 *
 * `continues`: the draft this text carries on from, which it may replace.
 */
export async function draftWaitingOnYou({ store, locationId, contactId, continues = null, kind = null }) {
  if (!contactId || typeof store?.listReplyDrafts !== "function") return null;
  const open = [];
  for (const status of ["draft", "scheduled"]) {
    const rows = await store.listReplyDrafts(locationId, { contactId, status, limit: 10 }).catch(() => []);
    open.push(...(rows || []).filter((d) => d?.contactId === contactId || !d?.contactId));
  }
  return blockingDraft(open, { continues, kind });
}

/**
 * waitingReason({ store, locationId, contactId, continues, hold, now }) → reason | ""
 *
 * The reason a skipped row shows, or "" when nothing is waiting. You having
 * stopped the bot on them (shared/bot-hold.js) is asked first: every caller
 * asks before it claims, so a stop spends no rung, no check-in and no ask —
 * they go after Resume. `hold: false` for a caller that wants its claim
 * written anyway (the promise sweep: Today carries what we owe them).
 */
export async function waitingReason({ hold = true, now = Date.now(), ...args } = {}) {
  if (hold && args.contactId) {
    const h = await holdFor({ store: args.store, locationId: args.locationId, contactId: args.contactId, now });
    if (h.held) return holdLine(h);
  }
  const d = await draftWaitingOnYou(args);
  return d ? blockingReason(d) : "";
}
