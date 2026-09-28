// blast-refresh.js — a blast text is written again the moment it sends.
//
// A blast is queued the instant a deal is promoted, and the deal's numbers
// are often still being typed in. 7034 S K St, 2026-09-28: the deal was
// minted with the default 30k fee, the blast queued at contract + 30k, the
// fee was set to 11k two minutes later, and fifteen buyers were texted 349k
// on a 329k deal. So the price is read off the deal (and any figure pinned on
// its package) when the text leaves, not when it was queued — and the text
// carries the buyer's own tracked package link, issued at that moment so a
// held or dismissed text never mints one.

import { blastMessage, dealFacts } from "./shared/blast-text.js";
import { dealNumbers, applyNumberOverrides, issueDataroomInvite } from "./dataroom.js";

export const defaultDataroomBaseUrl = () =>
  String(process.env.DATAROOM_BASE_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

// The phrasing the queued text used, so the refresh keeps it. Drafts queued
// before `outbound.variant` existed are read by their closing line.
export function blastVariant(draft = {}) {
  const v = Number(draft.outbound?.variant);
  if (Number.isInteger(v) && v >= 0) return v % 3;
  const t = String(draft.reply || "").trim();
  if (/Want the details\?$/.test(t)) return 0;
  if (/Interested\?$/.test(t)) return 1;
  return 2;
}

/**
 * refreshBlastText({ store, client, locationId, draft, baseUrl })
 *   → { text, price, invite, room } | null
 *
 * null when there is no deal to read (the queued text goes as written).
 * Throws when the deal is there but its price can't be put together — the
 * caller holds the text rather than send a number it couldn't check.
 */
export async function refreshBlastText({ store, client, locationId, draft, baseUrl = defaultDataroomBaseUrl() }) {
  const offerId = draft?.outbound?.offerId;
  if (!offerId || typeof store.getOffer !== "function") return null;
  const offer = await store.getOffer(offerId);
  if (!offer?.deal || offer.locationId !== locationId) return null;

  const settings = (await store.getOfferSettings?.(locationId).catch(() => null)) || {};
  const rooms = (await store.listDatarooms?.(locationId, { offerId, limit: 5 }).catch(() => [])) || [];
  const room = rooms.find((r) => r.status === "active" && r.kind !== "portfolio" && r.kind !== "offer") || null;

  // The deal's contract + fee, with a price pinned on the package laid over
  // it — the same number the buyer will see when they open the link.
  const base = dealNumbers({ offer, settings });
  const { numbers } = applyNumberOverrides(base, room?.snapshot?.overrides || {});
  const price = Math.round(Number(numbers.investorPrice) || 0);
  if (!(price > 0)) throw new Error("the deal has no buyer price");

  let invite = null, link = "";
  if (room && baseUrl) {
    const out = await issueDataroomInvite({ store, client, room, contactId: draft.contactId, name: draft.contactName || "", baseUrl, send: false });
    invite = out.invite;
    link = out.link;
  }
  const facts = dealFacts(offer, { price, note: draft.outbound?.note || room?.snapshot?.headline || "" });
  if (numbers.arv > 0) facts.arv = numbers.arv;
  if (numbers.repairs > 0) facts.repairs = numbers.repairs;
  const text = blastMessage({ ...facts, firstName: draft.contactName || "", variant: blastVariant(draft), link });
  return { text, price, invite, room };
}
