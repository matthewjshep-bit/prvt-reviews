// investor-price.js — the price one buyer was given on one deal.
//
// The investor band (shared/auto-accept.js evaluateInvestorBand) says yes to a
// buyer's own number; this writes it down: on that buyer's row
// (`deal.investors[i].agreedPrice`), so the next message quotes it and the
// assignment drafts at it, and on the deal (`deal.investorBand`), which is
// what makes "once per deal" true. The deal's contract price and its own
// assignment fee are never touched: those are the asking price's.
//
// It re-checks the two things that must never be wrong, even though the band
// already did: the amount is not under contract price plus the hard minimum
// fee, and the deal has not come down before. Belt and braces, on purpose.

import { recordEvent } from "./contact-record.js";
import { INVESTOR_MIN_FEE_FLOOR } from "./shared/auto-accept.js";

const round = (v) => Math.round(Number(v) || 0);

/**
 * agreeInvestorPrice({ store, locationId, contactId, contactName, offerId, amount, draftId, now })
 *   → { ok, address, amount, asking } | { ok: false, reason }
 */
export async function agreeInvestorPrice({ store, locationId, contactId, contactName = "", offerId, amount, draftId = null, now = Date.now() }) {
  const offer = await store.getOffer(offerId).catch(() => null);
  if (!offer?.deal || offer.locationId !== locationId) return { ok: false, reason: "no such deal" };
  const deal = offer.deal;
  if (deal.stage !== "under_contract") return { ok: false, reason: `the deal is ${String(deal.stage).replace(/_/g, " ")} now` };
  if (deal.investorBand?.at) return { ok: false, reason: "this deal already came down once" };
  const price = round(amount);
  const contract = round(deal.contractPrice) || round(offer.cashAmount);
  const asking = contract + round(deal.assignmentFee);
  if (!(contract > 0) || price < contract + INVESTOR_MIN_FEE_FLOOR) return { ok: false, reason: "under the floor: contract price plus the minimum fee" };
  if (asking > 0 && price >= asking) return { ok: false, reason: "not under the asking price, so there is nothing to agree" };

  const ts = new Date(now).toISOString();
  deal.investors = deal.investors || [];
  let inv = deal.investors.find((i) => i.contactId === contactId);
  if (!inv) { inv = { contactId, name: contactName || contactId, status: "evaluating", addedAt: ts, updatedAt: ts }; deal.investors.push(inv); }
  inv.agreedPrice = { amount: price, at: ts, via: "investor_band", draftId };
  inv.updatedAt = ts;
  deal.investorBand = { at: ts, contactId, amount: price, asking };
  deal.updatedAt = ts;
  await store.updateOffer(offer.id, offer);
  await recordEvent({
    store, locationId, contactId, party: "investor", type: "investor_price_agreed", at: ts, address: offer.address || "", offerId: offer.id,
    source: "conversation", ref: draftId, dedupeKey: `investor_price_agreed:${offer.id}`, data: { amount: price, asking, via: "investor_band" },
  }).catch(() => {});
  return { ok: true, address: offer.address || "the deal", amount: price, asking };
}
