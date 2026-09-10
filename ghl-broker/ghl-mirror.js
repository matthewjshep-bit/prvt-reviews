// ghl-mirror.js — write the board onto GHL's Opportunities, one way.
//
// Runs on the broker's 15-minute tick for every location whose mirror is
// switched on: read the lean offers, ask shared/ghl-mirror.js where each
// belongs, and write only the ones whose remembered projection differs.
// GHL never moves a card; a stage dragged there is overwritten next tick.
// Best effort throughout: a failed write is a warning on the offer, never
// a failed anything else.

import { store as defaultStore } from "./store.js";
import { mirrorPlan, mirrorDiff, normalizeMirror, tierFrom, agentPlan } from "./shared/ghl-mirror.js";
import { searchOpportunities, createOpportunity, updateOpportunity, getContact } from "./ghl.js";
import { LIVE_DEAL_STAGES, OPEN_STATUSES, effectiveStatus } from "./shared/offer-status.js";

export const CURSOR_NAME = "ghlMirror";
export const MAX_WRITES_PER_TICK = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * mirrorOffer({ client, locationId, offer, config, store, ghl }) → { wrote: [side], skipped: [side], errors: [] }
 *
 * `offer` is the full doc (it is written back). `ghl` is injectable for tests.
 */
export async function mirrorOffer({ client, locationId, offer, config, store = defaultStore, ghl = null, now = Date.now() }) {
  const api = ghl || { searchOpportunities, createOpportunity, updateOpportunity };
  const plan = mirrorPlan({ offer, config });
  const out = { wrote: [], skipped: [], errors: [] };
  const mirror = { ...(offer.mirror || {}) };
  let changed = false;
  for (const side of ["acquisitions", "dispositions"]) {
    const target = plan[side];
    if (!target) continue;
    const current = mirror[side] || null;
    if (!mirrorDiff(current, target)) { out.skipped.push(side); continue; }
    try {
      let id = current?.id || "";
      if (!id && offer.contactId) {
        // Something may already be there — made by hand, or by us before
        // the offer remembered it. Same pipeline, same address: adopt it.
        const found = await api.searchOpportunities(client, locationId, { contactId: offer.contactId, pipelineId: target.pipelineId }).catch(() => []);
        const same = found.find((o) => o.name.trim().toLowerCase() === target.name.trim().toLowerCase()) || (found.length === 1 ? found[0] : null);
        if (same) id = same.id;
      }
      if (id) {
        await api.updateOpportunity(client, id, { name: target.name, stageId: target.stageId || "", status: target.status, value: target.value });
      } else {
        if (!offer.contactId) { out.errors.push(`${side}: no contact to attach the opportunity to`); continue; }
        ({ id } = await api.createOpportunity(client, { locationId, pipelineId: target.pipelineId, contactId: offer.contactId, name: target.name, stageId: target.stageId || "", status: target.status, value: target.value }));
      }
      mirror[side] = { id, pipelineId: target.pipelineId, stageId: target.stageId || current?.stageId || null, status: target.status, value: target.value, at: new Date(now).toISOString() };
      changed = true;
      out.wrote.push(side);
    } catch (e) {
      out.errors.push(`${side}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  if (changed) {
    offer.mirror = mirror;
    await store.updateOffer(offer.id, offer).catch((e) => out.errors.push(`save: ${e.message}`));
  }
  return out;
}

/* ---------- the agents, by tier ---------- */

const TIER_EVENT_DAYS = 180;
const TAG_REFRESH_MS = 24 * 3600 * 1000;
export const MAX_TAG_REFRESH_PER_TICK = 30;
const agentCursor = (contactId) => `mirror:agent:${contactId}`;

/**
 * agentTruth({ store, locationId, contactId, profile, events, offers, refresh, api, client })
 *   → { tier, name, openOffers, hasLiveDeal }
 *
 * What the agent's opportunity should say. Tags from the profile's GHL
 * snapshot, refreshed from GHL when it is a day old and the budget allows,
 * with the app's later tag events replayed on top (shared/ghl-mirror.js).
 */
async function agentTruth({ store, locationId, contactId, profile, events = [], offers = [], refresh = false, api, client }) {
  let tags = Array.isArray(profile?.tags) ? profile.tags : [];
  let ghlSeenAt = profile?.ghlSeenAt || null;
  let name = profile?.name || "";
  if (refresh) {
    try {
      const c = await api.getContact(client, contactId);
      tags = Array.isArray(c?.tags) ? c.tags : tags;
      ghlSeenAt = new Date().toISOString();
      name = name || [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.name || "";
      await store.upsertContactProfile?.(locationId, contactId, { party: "agent", tags, ghlSeenAt, name: name || null }).catch(() => {});
    } catch { /* the snapshot we have is still the best we have */ }
  }
  const mine = offers.filter((o) => o.contactId === contactId);
  const hasLiveDeal = mine.some((o) => o.deal && LIVE_DEAL_STAGES.has(o.deal.stage));
  const openOffers = mine.filter((o) => !o.deal && OPEN_STATUSES.has(effectiveStatus(o)));
  if (!name) name = mine.find((o) => o.contactName)?.contactName || "";
  return { tier: tierFrom({ tags, events, ghlSeenAt, hasLiveDeal }), name, openOffers, hasLiveDeal };
}

/**
 * mirrorAgent({ client, locationId, contactId, config, store, ghl, profile, events, offers, refresh })
 *   → { wrote, skipped, error }
 *
 * One agent's opportunity, written only when the tier (or the value) moved.
 * What was written is remembered in job_cursors under mirror:agent:<id>.
 */
export async function mirrorAgent({ client, locationId, contactId, config, store = defaultStore, ghl = null, profile = null, events = [], offers = [], refresh = false, now = Date.now() }) {
  const api = ghl || { searchOpportunities, createOpportunity, updateOpportunity, getContact };
  const truth = await agentTruth({ store, locationId, contactId, profile, events, offers, refresh, api, client });
  const target = agentPlan({ contactId, name: truth.name, tier: truth.tier, openOffers: truth.openOffers, config });
  const current = (await store.getJobCursor?.(locationId, agentCursor(contactId)).catch(() => null))?.doc || null;
  if (!target) {
    // An unmapped tier (usually "none"): leave whatever is there alone.
    return { wrote: false, skipped: true, tier: truth.tier };
  }
  if (!mirrorDiff(current, target)) return { wrote: false, skipped: true, tier: truth.tier };
  try {
    let id = current?.id || "";
    if (!id) {
      const found = await api.searchOpportunities(client, locationId, { contactId, pipelineId: target.pipelineId }).catch(() => []);
      // The agent's own opportunity on this pipeline: theirs by name, else
      // the single one there is.
      const same = found.find((o) => o.name.trim().toLowerCase() === target.name.trim().toLowerCase()) || (found.length === 1 ? found[0] : null);
      if (same) id = same.id;
    }
    if (id) await api.updateOpportunity(client, id, { name: target.name, stageId: target.stageId, status: target.status, value: target.value });
    else ({ id } = await api.createOpportunity(client, { locationId, pipelineId: target.pipelineId, contactId, name: target.name, stageId: target.stageId, status: target.status, value: target.value }));
    await store.setJobCursor?.(locationId, agentCursor(contactId), { at: new Date(now).toISOString(), doc: { id, pipelineId: target.pipelineId, stageId: target.stageId, status: target.status, value: target.value, tier: target.tier } }).catch(() => {});
    return { wrote: true, skipped: false, tier: truth.tier, id };
  } catch (e) {
    return { wrote: false, skipped: false, tier: truth.tier, error: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * reconcileAgents({ client, locationId, saved, store, ghl, limit }) → { considered, wrote, refreshed, errors }
 *
 * Every agent the app knows — a profile, or an offer — through mirrorAgent.
 * Tag snapshots older than a day are refreshed from GHL, a bounded number
 * per pass, so the board never drifts more than a day from GHL's own tags
 * even for agents the app never tagged itself.
 */
export async function reconcileAgents({ client, locationId, saved = {}, store = defaultStore, ghl = null, limit = MAX_WRITES_PER_TICK, refreshLimit = MAX_TAG_REFRESH_PER_TICK, now = Date.now() }) {
  const config = normalizeMirror(saved.ghlMirror);
  const out = { considered: 0, wrote: 0, refreshed: 0, errors: [] };
  if (!config.enabled || config.acquisitions.mode !== "tiers" || !config.acquisitions.pipelineId) return out;
  const [profiles, offers, events] = await Promise.all([
    store.listContactProfiles?.(locationId, { party: "agent", limit: 5000 }).catch(() => []) || [],
    store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []),
    store.listContactEventsSince(locationId, new Date(now - TIER_EVENT_DAYS * 86400000).toISOString(), { types: ["tag_added", "tag_removed"], limit: 5000 }).catch(() => []),
  ]);
  const byContact = new Map(profiles.map((p) => [p.contactId, p]));
  for (const o of offers) if (o.contactId && !byContact.has(o.contactId)) byContact.set(o.contactId, null);
  const evByContact = new Map();
  for (const e of events) { if (!e?.contactId) continue; if (!evByContact.has(e.contactId)) evByContact.set(e.contactId, []); evByContact.get(e.contactId).push(e); }
  out.considered = byContact.size;
  let writes = 0, refreshes = 0;
  for (const [contactId, profile] of byContact) {
    if (writes >= limit) break;
    const stale = !profile?.ghlSeenAt || now - Date.parse(profile.ghlSeenAt) > TAG_REFRESH_MS;
    const refresh = stale && refreshes < refreshLimit;
    if (refresh) refreshes++;
    const r = await mirrorAgent({ client, locationId, contactId, config, store, ghl, profile, events: evByContact.get(contactId) || [], offers, refresh, now });
    if (r.wrote) { writes++; out.wrote++; await sleep(120); }
    if (r.error) out.errors.push(`${profile?.name || contactId}: ${r.error}`);
  }
  out.refreshed = refreshes;
  return out;
}

/**
 * reconcileLocation({ client, locationId, saved, store, ghl, limit }) → { considered, wrote, errors }
 *
 * Lean rows in, full docs only for the ones that need a write. Bounded per
 * tick so a first switch-on over two hundred offers spreads across a few
 * ticks rather than hammering the API once.
 */
export async function reconcileLocation({ client, locationId, saved = {}, store = defaultStore, ghl = null, limit = MAX_WRITES_PER_TICK, now = Date.now() }) {
  const config = normalizeMirror(saved.ghlMirror);
  const out = { considered: 0, wrote: 0, errors: [] };
  if (!config.enabled) return out;
  const rows = await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []);
  out.considered = rows.length;
  let writes = 0;
  for (const lean of rows) {
    if (writes >= limit) break;
    const plan = mirrorPlan({ offer: lean, config });
    const needs = ["acquisitions", "dispositions"].some((side) => plan[side] && mirrorDiff(lean.mirror?.[side] || null, plan[side]));
    if (!needs) continue;
    const full = await store.getOffer(lean.id).catch(() => null);
    if (!full) continue;
    const r = await mirrorOffer({ client, locationId, offer: full, config, store, ghl, now });
    if (r.wrote.length) { writes++; out.wrote++; }
    if (r.errors.length) out.errors.push(`${lean.address || lean.id}: ${r.errors.join("; ")}`);
    await sleep(120);
  }
  return out;
}

/**
 * maybeMirror({ client, locationId, saved, store, now }) — the tick's call.
 * Every tick, not once a day: a stage a person moved in the app should show
 * in GHL within the quarter hour.
 */
export async function maybeMirror({ client, locationId, saved = {}, store = defaultStore, ghl = null, now = Date.now(), log = () => {} }) {
  const config = normalizeMirror(saved.ghlMirror);
  if (!config.enabled) return null;
  const r = await reconcileLocation({ client, locationId, saved, store, ghl, now });
  const a = await reconcileAgents({ client, locationId, saved, store, ghl, now });
  if (r.wrote || a.wrote || r.errors.length || a.errors.length) {
    log(`ghl mirror ${locationId}: ${r.wrote} propert${r.wrote === 1 ? "y" : "ies"} + ${a.wrote} agent${a.wrote === 1 ? "" : "s"} written${a.refreshed ? `, ${a.refreshed} tag snapshot(s) refreshed` : ""}${r.errors.length + a.errors.length ? `, ${r.errors.length + a.errors.length} error(s): ${(r.errors[0] || a.errors[0])}` : ""}`);
  }
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: new Date(now).toISOString(), doc: { wrote: r.wrote + a.wrote, properties: r.wrote, agents: a.wrote, considered: r.considered + a.considered, refreshed: a.refreshed, errors: [...r.errors, ...a.errors].slice(0, 5) } }).catch(() => {});
  return { ...r, agents: a };
}
