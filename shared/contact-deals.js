// contact-deals.js — every deal one person is on, and how they're on it.
//
// Matt, 2026-10-19: the companion window should show a person's deals, not
// only their offer. A deal is an offer with `deal` set, and people come to it
// several ways:
//   listing      the agent we wrote the offer to (offer.contactId)
//   buyer        on the deal's buyer list (deal.investors)
//   title, sellerAgent, buyerAgent, lender, assignee
//                named on the deal's Parties (deal.parties, set by hand)
//   walkthrough  an RSVP to the showing (deal.showing.rsvps)
//   pitched      got the deal's blast and answered it: the blast says the
//                scan saw a reply, or a text or call came in after it (the
//                rule buyer-pulse.js uses)
// Closed and fell-through deals are kept; live ones sort first.

import { LIVE_DEAL_STAGES } from "./offer-status.js";
import { PARTY_ROLES, PARTY_LABEL } from "./deal-parties.js";

export const ROLE_LABEL = {
  listing: "Listing agent",
  buyer: "Buyer",
  ...PARTY_LABEL,
  title: "Title",
  walkthrough: "Walkthrough",
  pitched: "Pitched",
};

const BUYER_SIDE = new Set(["buyer", "walkthrough", "pitched"]);
/** isBuyerSideRole(role) → true when the role makes them one of our buyers. */
export const isBuyerSideRole = (role) => BUYER_SIDE.has(role);

const ANSWER_TYPES = new Set(["text_summary", "call_summary"]);

/**
 * dealRolesFor(offer, contactId, { events }) → role keys, in the order above.
 * `events` are this contact's own record events (newest first or not).
 */
export function dealRolesFor(offer, contactId, { events = [] } = {}) {
  const d = offer?.deal;
  if (!d || !contactId) return [];
  const roles = [];
  const add = (r) => { if (!roles.includes(r)) roles.push(r); };
  if (offer.contactId === contactId) add("listing");
  if ((d.investors || []).some((i) => i?.contactId === contactId)) add("buyer");
  for (const role of PARTY_ROLES) {
    if (d.parties?.[role]?.contactId !== contactId) continue;
    // The listing agent named again as the seller's agent is still one role.
    if (role === "sellerAgent" && roles.includes("listing")) continue;
    add(role);
  }
  if ((d.showing?.rsvps || []).some((r) => r?.contactId === contactId)) add("walkthrough");
  const blasts = events.filter((e) => e?.type === "blast_sent" && e.offerId === offer.id && (!e.contactId || e.contactId === contactId));
  const answered = blasts.some((b) => b.data?.replied
    || events.some((e) => ANSWER_TYPES.has(e?.type) && String(e.at) > String(b.at)));
  if (answered) add("pitched");
  return roles;
}

const dealTime = (o) => String(o?.deal?.updatedAt || o?.deal?.createdAt || "");

/**
 * contactDealRows(rec) → [{ offerId, address, stage, live, roles, standing }]
 * One row per deal from a contact record (getContactRecord): their own offers
 * that became deals, and the deals they're on another way. Live first, then
 * newest first.
 */
export function contactDealRows(rec) {
  const byId = new Map();
  const put = (offer, roles, standing = null) => {
    if (!offer?.id || !offer.deal) return;
    const row = byId.get(offer.id);
    if (row) {
      for (const r of roles) if (!row.roles.includes(r)) row.roles.push(r);
      if (standing && !row.standing) row.standing = standing;
      return;
    }
    byId.set(offer.id, {
      offerId: offer.id, address: offer.address || "", stage: offer.deal.stage || null,
      live: LIVE_DEAL_STAGES.has(offer.deal.stage), roles: [...roles], standing, at: dealTime(offer),
    });
  };
  for (const o of rec?.offers || []) put(o, ["listing"]);
  for (const d of rec?.deals || []) put(d.offer, d.roles?.length ? d.roles : d.standing ? ["buyer"] : [], d.standing || null);
  return [...byId.values()]
    .sort((a, b) => (a.live === b.live ? b.at.localeCompare(a.at) : a.live ? -1 : 1))
    .map(({ at, ...row }) => row);
}
