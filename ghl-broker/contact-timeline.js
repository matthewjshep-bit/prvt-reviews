// contact-timeline.js — the work pane's header, read for one person: what
// happened on this house (shared/deal-moments.js), what the machine does
// next (shared/next-follow-up.js), and whether you stopped the bot on them
// or changed their pace (shared/bot-hold.js).
//
// Per-person reads only, and no GHL call: the pane asks about one person at
// a time, as you move through Today or Offers, so this has to be cheap. The
// tags it reads are the profile's, as last seen in GHL — shown, never acted on.

import { dealMoments } from "./shared/deal-moments.js";
import { nextFollowUp } from "./shared/next-follow-up.js";
import { focusOf } from "./shared/agent-focus.js";
import { botHold, paceOf, mergeEvents } from "./shared/bot-hold.js";
import { annotateCurrent } from "./shared/current-offer.js";
import { botEventsFor } from "./bot-hold.js";
import { conversationConfig } from "./reply-agent.js";
import { matchTagPatterns } from "./conversation-party.js";
import { FOLLOW_UP_UTC_HOUR } from "./follow-up-sweep.js";

const RECENT_EVENTS = 300;
const RECENT_DRAFTS = 60;

/**
 * contactTimeline({ store, locationId, contactId, offerId, party, now })
 *   → { now, offerId, moments, total, next, bot }
 *
 *   offerId  the offer the pane is showing (its house's moments); none:
 *            only what isn't about a house
 *   party    "investor" for a buyer: no agent follow-up is worked out
 *   bot      { held, kind, since, until, reason, pace, paceSince,
 *              botOffTag, unsubscribed, conversationEnabled, unread }
 */
export async function contactTimeline({ store, locationId, contactId, offerId = null, party = null, now = Date.now() }) {
  const [profile, book, windowed, stops, drafts, saved, full] = await Promise.all([
    store.getContactProfile(locationId, contactId).catch(() => null),
    store.listOffers(locationId, { contactId, limit: 50, lean: true }).catch(() => []),
    store.listContactEvents(locationId, contactId, { limit: RECENT_EVENTS }).catch(() => []),
    // Their stops however old (ghl-broker/bot-hold.js). A read that fails is
    // said so — the pane must not show "Bot on" when it couldn't look.
    botEventsFor({ store, locationId, contactId }).catch(() => null),
    store.listReplyDrafts(locationId, { contactId, limit: RECENT_DRAFTS }).catch(() => []),
    store.getOfferSettings(locationId).catch(() => null),
    offerId && typeof store.getOffer === "function" ? store.getOffer(offerId).catch(() => null) : null,
  ]);
  const offer0 = full && full.locationId === locationId ? full : null;
  const events = mergeEvents(windowed || [], stops || []);
  const theirDrafts = (drafts || []).filter((d) => d?.contactId === contactId)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  // Which row on its house is current, for the follow-up's "superseded".
  const mine = (book || []).filter((o) => o?.contactId === contactId);
  const annotated = offer0 ? annotateCurrent(mine.some((o) => o.id === offer0.id) ? mine.map((o) => (o.id === offer0.id ? offer0 : o)) : [offer0, ...mine]).find((o) => o.id === offer0.id) : null;
  const offer = offer0 ? { ...offer0, isCurrent: annotated?.isCurrent, supersededBy: annotated?.supersededBy || null } : null;

  const config = conversationConfig(saved || {});
  const { moments, total } = dealMoments({ contactId, offer, events, drafts: theirDrafts, now });
  const agentsOffer = offer && offer.contactId === contactId && party !== "investor";
  const next = agentsOffer
    ? nextFollowUp({ offer, drafts: theirDrafts.slice(0, 20), events, config, now, sweepHour: FOLLOW_UP_UTC_HOUR, focus: focusOf(mine, { contactId }) })
    : null;

  const hold = botHold({ events, now });
  const pace = paceOf({ events });
  const botOffTag = (matchTagPatterns(profile?.tags || [], config.routing?.botOffTags || []) || [])[0] || null;
  return {
    now: new Date(now).toISOString(),
    offerId: offer?.id || null,
    moments, total, next,
    bot: {
      held: stops == null ? true : hold.held,
      kind: stops == null ? "unread" : hold.kind,
      since: hold.since, until: hold.until, reason: hold.reason,
      pace: pace.pace, paceSince: pace.since,
      botOffTag,
      unsubscribed: events.some((e) => e?.type === "unsubscribed"),
      conversationEnabled: Boolean(config.enabled),
      unread: stops == null,
    },
  };
}
