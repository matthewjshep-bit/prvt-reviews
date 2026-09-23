// investor-row.js — one investor's row in the Dispositions book, kept current
// between syncs.
//
// The book (`investors`) is a search cache of GHL that a sync rebuilds. What
// an investor tells us is filed on the contact record the moment we learn it
// (reply agent, drawer, enrichment sweep, buy-box editor), but until
// 2026-09-23 the book only saw it at the next manual Sync: ten days stale,
// with 112 investors talked to in between. So every fact the record learns or
// forgets re-renders that investor's row here.
//
// A row carries two views: `doc.custom` is GHL's fields as the sync read them,
// `doc.record` is the record's facts in the same shape. Search, the table and
// the AI ranking all read `buyboxCustom(doc)`: the record where it has a
// value, GHL filling the gaps (the contact-record precedence rule).
//
// Never throws; a row that can't be refreshed waits for the next sync.

import { factsAsCustom } from "./shared/contact-record.js";
import { buildBuyboxProfile, normalizeBuybox } from "./shared/buybox.js";

export const buyboxCustom = (doc) => ({ ...(doc?.custom || {}), ...(doc?.record || {}) });

// The paragraph the ranker reads (`investors.buybox_text`), record-first.
export function investorProfileText(doc) {
  const custom = buyboxCustom(doc);
  return buildBuyboxProfile({ ...doc, custom, buybox: normalizeBuybox(custom) });
}

/**
 * refreshInvestorRow({ store, locationId, contactId, facts }) → boolean
 *
 * Re-render the row from the record. `facts` is the record's facts doc when
 * the caller already holds it. A contact who isn't in the book is left out:
 * the book is whoever carries a buyer tag, and only a sync decides that.
 * `synced_at` is left alone, so "last synced" still means the last GHL read.
 */
export async function refreshInvestorRow({ store, locationId, contactId, facts = null } = {}) {
  if (!store?.getInvestor || !store?.updateInvestorDoc || !locationId || !contactId) return false;
  try {
    const row = await store.getInvestor(locationId, contactId);
    if (!row) return false;
    const f = facts || (await store.getContactProfile?.(locationId, contactId))?.facts || {};
    const doc = { ...(row.doc || {}), record: factsAsCustom(f) };
    return await store.updateInvestorDoc(locationId, contactId, doc, investorProfileText(doc), { synced: false });
  } catch (e) {
    console.error(`investor row: refresh failed contact=${contactId}:`, e?.message);
    return false;
  }
}
