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

import { blastMessage, blastSubject, dealFacts, bundleMessage } from "./shared/blast-text.js";
import { dealNumbers, applyNumberOverrides, issueDataroomInvite } from "./dataroom.js";
import { walkthroughAsk } from "./shared/showing.js";

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
 *   → { text, subject, price, invite, room } | null
 *
 * `subject` is set for an emailed blast: the kind of house, the city and
 * the price as they stand now. The how-we-found-you line the draft was
 * queued with (`outbound.intro`) stays.
 *
 * null when there is no deal to read (the queued text goes as written).
 * Throws when the deal is there but its price can't be put together — the
 * caller holds the text rather than send a number it couldn't check.
 */
/**
 * blastFactsFor({ store, locationId, draft }) → { offer, settings, room, price, facts } | null
 *
 * A queued deal text's deal as it stands now: the price off the deal (and
 * any figure pinned on its package), the house, and the operator's line.
 * null when there is no deal to read; throws when its price can't be put
 * together. The single text and the combined one (two deals, one text) both
 * read their deals here, so they quote the same numbers.
 */
export async function blastFactsFor({ store, locationId, draft }) {
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
  const facts = dealFacts(offer, { price, note: draft.outbound?.note || room?.snapshot?.headline || "" });
  if (numbers.arv > 0) facts.arv = numbers.arv;
  if (numbers.repairs > 0) facts.repairs = numbers.repairs;
  return { offer, settings, room, price, facts };
}

export async function refreshBlastText({ store, client, locationId, draft, baseUrl = defaultDataroomBaseUrl() }) {
  const read = await blastFactsFor({ store, locationId, draft });
  if (!read) return null;
  const { offer, settings, room, price, facts } = read;

  // Links wait for their answer (dispoAutopilot.blastLink "on_reply"): a link
  // in a text is what the carriers block most, so the text asks if they want
  // the details and the reply agent sends the link when they do. An email
  // still carries it.
  const linkLater = draft.channel !== "email" && settings?.dispoAutopilot?.blastLink === "on_reply";
  let invite = null, link = "";
  if (room && baseUrl && !linkLater) {
    const out = await issueDataroomInvite({ store, client, room, contactId: draft.contactId, name: draft.contactName || "", baseUrl, send: false });
    invite = out.invite;
    link = out.link;
  }
  // The walkthrough question, read now too: a window set after the blast
  // queued is in every text that hasn't left yet.
  // (dispoAutopilot.showings.askInBlast, on unless switched off — read here
  // rather than through dispo-autopilot.js, which imports reply-agent.js.)
  const ask = settings?.dispoAutopilot?.showings?.askInBlast === false ? "" : walkthroughAsk({ showing: offer.deal?.showing || null });
  const text = blastMessage({ ...facts, firstName: draft.contactName || "", variant: blastVariant(draft), link, ask, intro: draft.outbound?.intro || "", linkOnReply: linkLater });
  const subject = draft.channel === "email" ? blastSubject(facts) : "";
  return { text, subject, price, invite, room, withoutLink: linkLater };
}

/**
 * refreshBundleText({ store, locationId, draft, others }) → { text, price, withoutLink, bundle } | null
 *
 * Two or three deals waiting for one buyer, as one text (Matt, 2026-10-05:
 * "we have this one and this one available"). Each deal is read as it
 * stands now, exactly as its own text would be. A deal that can't be priced
 * is left out and goes on its own later. No link and no walkthrough question:
 * whichever deal they answer about brings those (linkOwed in reply-agent.js).
 * null when fewer than two deals could be read — the caller sends the one.
 */
export async function refreshBundleText({ store, locationId, draft, others = [] }) {
  const own = await blastFactsFor({ store, locationId, draft });
  if (!own) return null;
  const parts = [{ draft, ...own }];
  for (const o of others) {
    try {
      const r = await blastFactsFor({ store, locationId, draft: o });
      if (r) parts.push({ draft: o, ...r });
    } catch { /* unpriced: it waits and goes on its own */ }
  }
  if (parts.length < 2) return null;
  const text = bundleMessage(parts.map((p) => p.facts), {
    firstName: draft.contactName || "", linkOnReply: true, intro: draft.outbound?.intro || "", variant: blastVariant(draft),
  });
  return {
    text, price: own.price, withoutLink: true,
    bundle: parts.map((p) => ({ draftId: p.draft.id, offerId: p.offer.id, address: p.offer.address || "", price: p.price })),
  };
}
