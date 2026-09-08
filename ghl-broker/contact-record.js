// contact-record.js — the one door into a person's record.
//
// Every writer that used to talk only to GoHighLevel now comes through here
// first: recordEvent for something that happened, learnFacts for something
// we came to know. The app's tables are the record; GHL's custom fields are
// a digest projected from them. In the first cut every existing GHL write is
// left exactly as it was and merely gains a call in here beside it — so the
// digest keeps saying what it always said while the record fills up behind
// it. projectToGhl re-renders a field from the record and is reached only by
// an operator's edit in the drawer; nothing re-projects on its own.
//
// Never throws. A record that cannot be written is logged and the caller's
// GHL write goes ahead — exactly the discipline appendDealHistory has today.
// The pure half (vocabulary, keys, merges) is shared/contact-record.js.

import { getContact, updateContact, findOrCreateCustomFieldByKey, customFieldIdKeyMapForDefs, contactCustomRecord } from "./ghl.js";
import { enrichFieldDefs, mergeHistory, mergeFacts, SUBJECT_PROPERTY_FIELD } from "./enrich.js";
import { OUTREACH_FIELDS } from "./field-registry.js";
import { toListOffer } from "./shared/offer-status.js";
import {
  FACT_KEYS, factKeysFor, addFact, removeFact, currentFacts, factsEmpty, renderFactField,
  eventDedupeKey, eventFromLedgerLine, ledgerEvents, renderLedger, factsFromCustom,
} from "./shared/contact-record.js";
import { investorStatus } from "./shared/offer-status.js";

const log = (what, e) => console.error(`contact-record: ${what}:`, e?.message || e);
const nowIso = () => new Date().toISOString();

// Every custom-field definition the record projects into or reads from, so
// one id→key map covers both parties and the outreach fields. GHL derives a
// field's key from its display name, so reading by our key without this map
// silently sees nothing (ghl.js:112).
export const RECORD_FIELD_DEFS = [
  ...enrichFieldDefs("agent"), ...enrichFieldDefs("investor"), ...OUTREACH_FIELDS, SUBJECT_PROPERTY_FIELD,
].filter((d, i, all) => all.findIndex((x) => x.key === d.key) === i);
const defByKey = new Map(RECORD_FIELD_DEFS.map((d) => [d.key, d]));

export const contactName = (c) => [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim() || c?.name || c?.contactName || "";

/**
 * ensureProfile({ store, locationId, contactId, party, name, email, phone, tags })
 *
 * Identity only — never facts. Safe to call on every touch; a null field
 * never overwrites a known one.
 */
export async function ensureProfile({ store, locationId, contactId, party = null, name = null, email = null, phone = null, tags, ghlSeenAt } = {}) {
  if (!store?.upsertContactProfile || !locationId || !contactId) return null;
  try {
    const patch = { party: party || null, name: name || null, email: email || null, phone: phone || null };
    if (Array.isArray(tags)) patch.tags = tags;
    if (ghlSeenAt) patch.ghlSeenAt = ghlSeenAt;
    return await store.upsertContactProfile(locationId, contactId, patch);
  } catch (e) { log(`profile ${contactId}`, e); return null; }
}

/**
 * recordEvent({ store, locationId, contactId, party, type, at, address, offerId, dealId, data, source, ref, dedupeKey })
 *   → { event, inserted }
 *
 * One thing that happened. The dedupe key defaults to the shared scheme, so
 * a replay of the same action is a no-op rather than a second row.
 */
export async function recordEvent({ store, locationId, contactId, party = null, type, at = nowIso(), address = "", offerId = null, dealId = null, data = {}, source = "operator", ref = null, dedupeKey } = {}) {
  const event = { party, type, at, address: address || "", offerId, dealId, data: data || {}, source, ref };
  event.dedupeKey = dedupeKey !== undefined ? dedupeKey : eventDedupeKey(event);
  if (!store?.appendContactEvents || !locationId || !contactId || !type) return { event, inserted: false };
  try {
    await ensureProfile({ store, locationId, contactId, party });
    const r = await store.appendContactEvents(locationId, contactId, [event]);
    return { event, inserted: r.inserted > 0 };
  } catch (e) { log(`event ${type} ${contactId}`, e); return { event, inserted: false }; }
}

export async function recordEvents({ store, locationId, contactId, party = null, events = [] } = {}) {
  if (!store?.appendContactEvents || !locationId || !contactId || !events.length) return { inserted: 0, skipped: events.length };
  try {
    await ensureProfile({ store, locationId, contactId, party });
    const rows = events.map((e) => ({ ...e, party: e.party ?? party, dedupeKey: e.dedupeKey !== undefined ? e.dedupeKey : eventDedupeKey(e) }));
    return await store.appendContactEvents(locationId, contactId, rows);
  } catch (e) { log(`events ${contactId}`, e); return { inserted: 0, skipped: events.length }; }
}

/**
 * learnFacts({ store, locationId, contactId, party, facts: [{ key, value, source, at, ref }] })
 *   → { profile, added: [{ key, value }] }
 *
 * Something we came to know. Each fact that is actually new also leaves a
 * fact_learned event, so the timeline shows when we learned it and from what.
 */
export async function learnFacts({ store, locationId, contactId, party = null, facts = [] } = {}) {
  if (!store?.getContactProfile || !locationId || !contactId || !facts.length) return { profile: null, added: [] };
  try {
    const prev = await store.getContactProfile(locationId, contactId);
    let doc = prev?.facts || {};
    const added = [];
    for (const f of facts) {
      if (!f?.key || !FACT_KEYS[f.key]) continue;
      if (party && FACT_KEYS[f.key].party !== "both" && FACT_KEYS[f.key].party !== party) continue;
      const r = addFact(doc, f.key, { value: f.value, source: f.source || "operator", at: f.at || nowIso(), ref: f.ref || null });
      if (r.added) { doc = r.facts; added.push({ key: f.key, value: doc[f.key][doc[f.key].length - 1].value, source: f.source || "operator", at: f.at || nowIso(), ref: f.ref || null }); }
    }
    if (!added.length) return { profile: prev, added };
    const profile = await store.upsertContactProfile(locationId, contactId, { party: party || prev?.party || null, facts: doc });
    await store.appendContactEvents(locationId, contactId, added.map((a) => {
      const ev = { party: party || prev?.party || null, type: "fact_learned", at: a.at, source: a.source, ref: a.ref, data: { key: a.key, value: a.value } };
      return { ...ev, dedupeKey: eventDedupeKey(ev) };
    }));
    return { profile, added };
  } catch (e) { log(`facts ${contactId}`, e); return { profile: null, added: [] }; }
}

export async function forgetFact({ store, locationId, contactId, party = null, key, value, source = "operator", ref = null } = {}) {
  if (!store?.getContactProfile || !locationId || !contactId || !key) return { profile: null, removed: false };
  try {
    const prev = await store.getContactProfile(locationId, contactId);
    const r = removeFact(prev?.facts || {}, key, value);
    // The tombstone is written even when there was nothing to remove: an
    // operator saying "never this" before the sweep has said it is exactly
    // the case the tombstone exists for.
    const profile = await store.upsertContactProfile(locationId, contactId, { facts: r.facts });
    if (!r.removed) return { profile, removed: false };
    const ev = { party: party || prev?.party || null, type: "fact_removed", at: nowIso(), source, ref, data: { key, value } };
    await store.appendContactEvents(locationId, contactId, [{ ...ev, dedupeKey: eventDedupeKey(ev) }]);
    return { profile, removed: true };
  } catch (e) { log(`forget ${contactId}`, e); return { profile: null, removed: false }; }
}

/* ---------- GHL: the digest ---------- */

async function readCustom({ client, locationId, contactId, contact = null }) {
  const c = contact || await getContact(client, contactId);
  const idKeyMap = await customFieldIdKeyMapForDefs(client, locationId, RECORD_FIELD_DEFS);
  return { contact: c, custom: contactCustomRecord(c, idKeyMap), idKeyMap };
}

/**
 * projectToGhl({ client, store, locationId, contactId, party, keys, custom })
 *   → { written: [keys], skipped: [keys] }
 *
 * Re-render the named GHL fields from the record. Ledger fields go through
 * mergeHistory with the CURRENT GHL value on the left and every ledger event
 * on the right — the same merge every writer uses — so nothing already on
 * the contact is lost and the caps behave as they always have. Fact fields
 * are rendered from currentFacts; a list key is merged with mergeFacts at
 * its cap, a scalar is the newest value. An empty rendering never blanks a
 * field: removing the last fact is an operator's job in the drawer, and that
 * path passes `blankIfEmpty`.
 *
 * Reached only from operator edits. The chokepoints keep their own writes.
 */
export async function projectToGhl({ client, store, locationId, contactId, party = null, keys = null, custom = null, blankIfEmpty = false } = {}) {
  const written = [];
  const skipped = [];
  if (!client || !store || !locationId || !contactId) return { written, skipped };
  try {
    const profile = await store.getContactProfile(locationId, contactId);
    const p = party || profile?.party || null;
    const cur = custom || (await readCustom({ client, locationId, contactId })).custom;
    const wanted = keys?.length ? keys : [...factKeysFor(p || "agent"), p === "investor" ? "investor_deal_history" : "agent_deal_history"];
    const fieldWrites = [];
    for (const key of wanted) {
      let value = null;
      if (key === "agent_deal_history" || key === "investor_deal_history") {
        const events = await store.listContactEvents(locationId, contactId, { limit: 2000 });
        const lines = renderLedger(ledgerEvents(events.slice().reverse(), key === "agent_deal_history" ? "agent" : "investor")).split("\n").filter(Boolean);
        value = mergeHistory(cur[key] || "", lines);
      } else if (FACT_KEYS[key]) {
        const rendered = renderFactField(profile?.facts, key);
        if (!rendered && !blankIfEmpty) { skipped.push(key); continue; }
        value = FACT_KEYS[key].kind === "list" && !blankIfEmpty
          ? mergeFacts(cur[key] || "", rendered, FACT_KEYS[key].ghlMax || 1500)
          : rendered;
      } else { skipped.push(key); continue; }
      if (String(value ?? "") === String(cur[key] ?? "").trim()) { skipped.push(key); continue; }
      const def = defByKey.get(key);
      const id = await findOrCreateCustomFieldByKey(client, locationId, key, def?.name || key, def?.dataType || "TEXT",
        def?.folderSibling ? { siblingKey: def.folderSibling } : {});
      if (!id) { skipped.push(key); continue; }
      fieldWrites.push({ id, value });
      written.push(key);
    }
    if (fieldWrites.length) {
      await updateContact(client, contactId, { customFields: fieldWrites });
      await store.upsertContactProfile(locationId, contactId, { projectedAt: nowIso() });
    }
  } catch (e) { log(`project ${contactId}`, e); }
  return { written, skipped };
}

/**
 * reconcileFromGhl({ store, locationId, contactId, party, contact, custom, idKeyMap })
 *   → { facts: n, events: n }
 *
 * Someone typed into GHL directly, or the record predates the app's memory.
 * GHL fills the gaps: a field value the record has no entry for becomes a
 * fact with source "operator" (a person put it there), and a ledger line the
 * timeline lacks becomes an event. The record wins where it already has a
 * value, and GHL never deletes anything here — deletion is a drawer action.
 */
export async function reconcileFromGhl({ store, locationId, contactId, party = null, client = null, contact = null, custom = null, idKeyMap = null } = {}) {
  if (!store?.getContactProfile || !locationId || !contactId) return { facts: 0, events: 0 };
  try {
    let c = contact;
    let cu = custom;
    if (!cu && c && idKeyMap) cu = contactCustomRecord(c, idKeyMap);
    if (!cu) {
      if (!client) return { facts: 0, events: 0 };
      ({ contact: c, custom: cu } = await readCustom({ client, locationId, contactId, contact }));
    }
    const prev = await store.getContactProfile(locationId, contactId);
    const p = party || prev?.party || null;
    const at = cu.last_convo_date ? `${String(cu.last_convo_date).slice(0, 10)}T12:00:00.000Z` : (prev?.createdAt || nowIso());
    await ensureProfile({
      store, locationId, contactId, party: p,
      name: c ? contactName(c) : null, email: c?.email || null, phone: c?.phone || null,
      tags: Array.isArray(c?.tags) ? c.tags : undefined, ghlSeenAt: c ? nowIso() : undefined,
    });
    const known = currentFacts(prev?.facts || {});
    const candidates = factsFromCustom(cu, p || "agent", { source: "operator", at, ref: "ghl" })
      // App wins where it has a value: a scalar the record already holds is
      // not overwritten by GHL's; a list value the record lacks is added.
      .filter((f) => FACT_KEYS[f.key].kind === "list" || known[f.key] == null);
    const learned = await learnFacts({ store, locationId, contactId, party: p, facts: candidates });
    const ledgerKey = p === "investor" ? "investor_deal_history" : "agent_deal_history";
    const lines = String(cu[ledgerKey] || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const events = lines.map((l) => eventFromLedgerLine(l, { party: p || "agent", source: "operator", ref: "ghl" })).filter(Boolean);
    const r = events.length ? await recordEvents({ store, locationId, contactId, party: p, events }) : { inserted: 0 };
    return { facts: learned.added.length, events: r.inserted };
  } catch (e) { log(`reconcile ${contactId}`, e); return { facts: 0, events: 0 }; }
}

/* ---------- the whole record, for the drawer and the prompt ---------- */

const LIVE_DEAL_STAGES = new Set(["under_contract", "buyer_found", "assigned"]);

/**
 * getContactRecord({ store, locationId, contactId, party })
 *   → { profile, facts, entries, events, offers, deals, feedback, drafts, invites, investor }
 *
 * Everything the app knows about one person, in one call. Offers are the
 * agent's own (lean rows); deals are the ones this contact is a buyer on,
 * with their standing and the feedback they gave. Never throws: a store
 * that lacks a table answers with an empty section.
 */
export async function getContactRecord({ store, locationId, contactId, party = null } = {}) {
  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
  const profile = await safe(() => store.getContactProfile(locationId, contactId), null);
  const events = await safe(() => store.listContactEvents(locationId, contactId, { limit: 500 }), []);
  const offers = (await safe(() => store.listOffers(locationId, { contactId, limit: 100, lean: true }), [])).map(toListOffer);
  const allDeals = await safe(() => store.listDeals(locationId), []);
  const deals = [];
  const feedback = [];
  for (const o of allDeals) {
    const link = (o?.deal?.investors || []).find((i) => i.contactId === contactId);
    const fb = (o?.deal?.feedback || []).filter((f) => f.contactId === contactId);
    if (!link && !fb.length) continue;
    deals.push({
      offer: toListOffer(o), live: LIVE_DEAL_STAGES.has(o.deal?.stage),
      standing: link ? { status: investorStatus(link.status), reason: link.reason || null, addedAt: link.addedAt, updatedAt: link.updatedAt } : null,
      feedback: fb,
    });
    for (const f of fb) feedback.push({ ...f, address: o.address, offerId: o.id });
  }
  const drafts = await safe(() => store.listReplyDrafts(locationId, { contactId, limit: 20 }), []);
  const invites = await safe(() => store.listDataroomInvitesByContact(locationId, contactId, { limit: 50 }), []);
  const investor = await safe(() => store.getInvestor(locationId, contactId), null);
  const resolvedParty = party || profile?.party || (offers.length && !deals.length ? "agent" : deals.length || investor ? "investor" : null);
  return {
    profile, party: resolvedParty,
    facts: currentFacts(profile?.facts || {}), entries: profile?.facts || {}, factsEmpty: factsEmpty(profile?.facts || {}),
    events, offers, deals, feedback, drafts, invites, investor,
  };
}
