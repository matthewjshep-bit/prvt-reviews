// price-v2.js — the offer engine prices every named house in the shadow (auto-underwrite v2, 2026-11-04).
//
// Matt chose "shadow two weeks first": the engine (shared/price-engine.js) prices each house the
// conversation names, beside the live path, and writes its answer to the house's record
// (house_pricing). It sends nothing, floats nothing and changes nothing on the draft or the
// thread; it only reads what the run already bought (Bricked's read, the Zillow listing, the comps
// and the photo scope when a full run took them) and the agent's own words on file. The daily
// scorecard (shared/price-scorecard.js) measures it against what really happened.
//
// Switch: settings.pricingV2.shadow, off. No names, numbers or message text are logged here.

import { priceHouse, normalizePricingV2 } from "./shared/price-engine.js";
import { KC_FLIP_RATIOS } from "./shared/kc-flip-ratios.js";
import { houseKey } from "./shared/current-offer.js";

export const ENGINE_VERSION = "v2.0";
const HISTORY_MAX = 10;
const TEXT_MAX = 1500;

export const shadowOn = (saved) => normalizePricingV2(saved?.pricingV2).shadow;

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const zipOf = (address) => (String(address || "").match(/\b(\d{5})(?:-\d{4})?\s*$/) || String(address || "").match(/\b(9[789]\d{3})\b/) || [])[1] || "";
const clip = (s) => String(s || "").slice(0, TEXT_MAX);

/**
 * readsFrom({ address, message, listPrice, askingPrice, b, listing, facts, subject, comps, scope, events })
 *   → the engine's reads for one house, from what a run already holds.
 *
 *   b        Bricked's read (price-bricked.js normalizeBricked), or null
 *   facts    the Zillow listing's facts { sqft, yearBuilt, lotSqft, homeType }
 *   subject  Bricked's subject, when there are no Zillow facts
 *   comps    { arv, n } — a full run's own comps
 *   scope    { total, photos } — a full run's photo scope
 *   events   the contact's property_details / agent_estimate events (their numbers)
 */
export function readsFrom({ address = "", message = "", listPrice = 0, askingPrice = 0, b = null, listing = null, facts = null, subject = null, comps = null, scope = null, events = [] } = {}) {
  const key = houseKey(address);
  const mine = (events || []).filter((e) => !e?.address || houseKey(e.address) === key);
  const newest = (type, field) => mine.filter((e) => e?.type === type && num(e?.data?.[field]))
    .sort((x, y) => String(y.at || "").localeCompare(String(x.at || "")))[0]?.data?.[field];
  const s = subject || b?.subject || {};
  return {
    list: num(listPrice) || num(listing?.listPrice) || num(askingPrice),
    sellerNumber: num(newest("property_details", "sellerAsk")),
    theirRepairs: num(newest("agent_estimate", "rehab")),
    zip: zipOf(address),
    sqft: num(facts?.sqft) || num(s.sqft),
    yearBuilt: num(facts?.yearBuilt) || num(s.yearBuilt),
    lotSqft: num(facts?.lotSqft),
    homeType: facts?.homeType || "",
    bricked: b && num(b.arv)
      ? { arv: num(b.arv), arvConfidence: Number(b.arvConfidence) || 0, asIs: num(b.asIs), repairs: num(b.repairs), described: num(b.repairs) > 0,
        condition: Number(b.subject?.condition) || null, comps: (b.comps || []).map((c) => ({ use: c.use, renovated: c.renovated ?? null, renovationScore: c.renovationScore ?? null })) }
      : null,
    comps: comps && num(comps.arv) ? { arv: num(comps.arv), n: Number(comps.n) || 0 } : null,
    scope: scope && num(scope.total) ? { total: num(scope.total), photos: Number(scope.photos) || 0 } : null,
    said: clip(message),
    remarks: clip(listing?.remarks),
  };
}

/**
 * nextRecord(prev, { address, contactId, offerId, leadSource, reads, v2, at }) → the house's record
 * The answer replaces the last one; the last HISTORY_MAX answers are kept so the scorecard can see
 * a number move. Outcome and evidence (filled by price-outcomes.js and thread-reads.js) are kept.
 */
export function nextRecord(prev = null, { address = "", contactId = null, offerId = null, leadSource = null, reads = {}, v2 = {}, at = new Date().toISOString() } = {}) {
  const p = prev || {};
  const point = { at, grade: v2.grade, walkAway: v2.walkAway, open: v2.open, arv: v2.arv, rehab: v2.rehab };
  return {
    houseKey: houseKey(address), address: address || p.address || "",
    contactId: contactId || p.contactId || null, offerId: offerId || p.offerId || null, leadSource: leadSource || p.leadSource || null,
    firstAt: p.firstAt || at,
    reads, v2: { ...v2, version: ENGINE_VERSION, at },
    history: [...(p.history || []), point].slice(-HISTORY_MAX),
    outcome: p.outcome || null,
    evidence: p.evidence || [],
  };
}

/**
 * shadowPrice({ store, locationId, saved, job, address, b, listing, facts, subject, comps, scope, listPrice })
 *   → the record written, or null (switch off, nothing to price, or a failure — never thrown).
 */
export async function shadowPrice({ store, locationId, saved = {}, job = {}, address = "", b = null, listing = null, facts = null, subject = null, comps = null, scope = null, listPrice = 0, now = Date.now() } = {}) {
  if (!shadowOn(saved) || !address || !store?.upsertHousePricing) return null;
  try {
    const key = houseKey(address);
    if (!key) return null;
    const events = job.contactId
      ? (await store.listContactEvents?.(locationId, job.contactId, { types: ["property_details", "agent_estimate"], limit: 100 }).catch(() => [])) || []
      : [];
    const reads = readsFrom({ address, message: job.message, listPrice, askingPrice: job.askingPrice, b, listing, facts, subject, comps, scope, events });
    const v2 = priceHouse(reads, saved.pricingV2 || {}, { ratios: KC_FLIP_RATIOS });
    const prev = await store.getHousePricing(locationId, key).catch(() => null);
    const doc = nextRecord(prev?.doc, { address, contactId: job.contactId, offerId: job.offerId, leadSource: job.leadSource, reads, v2, at: new Date(now).toISOString() });
    await store.upsertHousePricing(locationId, key, doc);
    return doc;
  } catch (e) {
    job.warnings?.push?.(`shadow price: ${String(e?.message || e).slice(0, 120)}`);
    return null;
  }
}
