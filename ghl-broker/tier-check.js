// tier-check.js — once a day, an agent's tier tag and their Acquisitions card agree.
//
// The bot keeps them together when it tags someone (routes/offers.js
// onTagsChanged). This catches everything else: a card dragged by hand in GHL,
// a tag edited by hand, a GHL workflow that moved a card, a hook that failed.
// On 2026-09-15, 32 agents were out of line.
//
// Which side wins:
//   - A card in Tier 1/2/3 is the truth. The tags become that one tier, unless the
//     bot tagged a different tier after the card last moved; then the card follows
//     that tag, because the hook missed it.
//   - A card at Offer Out or later is a deal in flight, so the tag is tier-1 alone.
//   - Anything else is left as it is: New Lead, Contacted, Passed on Offer, Lost,
//     a closed card, a contact who isn't an agent, or a contact whose cards disagree.
// Bounded per run; every tag change is on the contact's record.

import { store as defaultStore } from "./store.js";
import { listPipelines, addContactTags, removeContactTags, updateOpportunity } from "./ghl.js";
import { acquisitionsPipeline } from "./ghl-mirror.js";
import { recordEvent } from "./contact-record.js";
import { localHour } from "./promise-sweep.js";

export const CURSOR_NAME = "tierCheck";
export const CHECK_HOUR = 7;             // PT
// The operator chose the whole backlog in one run (2026-09-15: 174 agents);
// this is a ceiling against a bad read, not a pace.
export const MAX_CHANGES = 300;
const MIN_GAP_MS = 20 * 3600 * 1000;
const EVENT_LOOKBACK_MS = 3 * 86400000;
const TIERS = ["tier-1", "tier-2", "tier-3"];
const PAST_TIERS_RX = /^(offer out|negotiations?|contract sent|contract signed)\b/i;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * planTierFixes({ pipelines, opportunities, tagEvents }) → [{ contactId, name, opportunityId, add, remove, moveTo, from, why }]
 *
 * Pure. `opportunities` are GHL search rows (with `contact.tags`); `tagEvents`
 * are the app's recent tag_added events ({ contactId, at, data: { tag } }).
 */
export function planTierFixes({ pipelines = [], opportunities = [], tagEvents = [] } = {}) {
  const acq = acquisitionsPipeline(pipelines);
  if (!acq) return [];
  const stageName = new Map((acq.stages || []).map((s) => [s.id, String(s.name || "").trim()]));
  const tierOfStage = new Map(Object.entries(acq.tierStages).map(([tier, id]) => [id, tier]));

  const byContact = new Map();
  for (const o of opportunities || []) {
    if (o.pipelineId !== acq.id || !o.contactId) continue;
    if (!byContact.has(o.contactId)) byContact.set(o.contactId, []);
    byContact.get(o.contactId).push(o);
  }
  const lastBotTier = new Map();
  for (const e of tagEvents || []) {
    const tag = String(e?.data?.tag || "").toLowerCase();
    if (!TIERS.includes(tag) || !e.contactId) continue;
    const prev = lastBotTier.get(e.contactId);
    if (!prev || String(e.at) > prev.at) lastBotTier.set(e.contactId, { tag, at: String(e.at) });
  }

  const fixes = [];
  for (const [contactId, opps] of byContact) {
    const open = opps.filter((o) => (o.status || "open") === "open");
    if (!open.length) continue;
    // Where each open card says the agent is: a tier, "past" the tiers, or nowhere we manage.
    const reads = open.map((o) => {
      const tier = tierOfStage.get(o.pipelineStageId);
      if (tier) return { o, want: tier, past: false };
      if (PAST_TIERS_RX.test(stageName.get(o.pipelineStageId) || "")) return { o, want: "tier-1", past: true };
      return { o, want: null };
    }).filter((r) => r.want);
    if (!reads.length) continue;
    if (new Set(reads.map((r) => r.want)).size > 1) continue;
    const { o, want, past } = reads.find((r) => r.past) || reads[0];

    const tags = (o.contact?.tags || []).map((t) => String(t).toLowerCase());
    const isAgent = tags.includes("agent") || tags.some((t) => TIERS.includes(t));
    if (!isAgent) continue;
    const name = o.contact?.name || o.name || "";
    const have = TIERS.filter((t) => tags.includes(t));

    // The bot moved them after the card last moved: the card follows the tag.
    const bot = lastBotTier.get(contactId);
    const stageAt = String(o.lastStageChangeAt || o.updatedAt || "");
    if (!past && bot && bot.tag !== want && have.includes(bot.tag) && bot.at > stageAt) {
      const remove = have.filter((t) => t !== bot.tag);
      fixes.push({ contactId, name, opportunityId: o.id, add: [], remove, moveTo: acq.tierStages[bot.tag], from: stageName.get(o.pipelineStageId) || "",
        why: `the bot tagged ${bot.tag} after the card last moved` });
      continue;
    }

    const add = have.includes(want) ? [] : [want];
    const remove = have.filter((t) => t !== want);
    if (!add.length && !remove.length) continue;
    fixes.push({ contactId, name, opportunityId: o.id, add, remove, moveTo: null, from: stageName.get(o.pipelineStageId) || "",
      why: past ? `card at ${stageName.get(o.pipelineStageId)}: tier-1 only` : `card in ${stageName.get(o.pipelineStageId)}` });
  }
  return fixes;
}

async function listAcquisitionOpportunities(client, locationId, pipelineId, { maxPages = 30 } = {}) {
  const rows = [];
  let after = "";
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ location_id: locationId, pipeline_id: pipelineId, limit: "100" });
    if (after) { q.set("startAfter", after.startAfter); q.set("startAfterId", after.startAfterId); }
    const r = await client.call(`/opportunities/search?${q.toString()}`);
    const batch = Array.isArray(r?.opportunities) ? r.opportunities : [];
    rows.push(...batch);
    const m = r?.meta || {};
    if (!batch.length || !m.startAfterId || !m.nextPage) break;
    after = { startAfter: String(m.startAfter), startAfterId: String(m.startAfterId) };
    await sleep(150);
  }
  return rows;
}

/**
 * runTierCheck({ client, locationId, store, ghl, dryRun, limit, now }) → { considered, planned, applied, fixes, errors }
 */
export async function runTierCheck({ client, locationId, store = defaultStore, ghl = null, dryRun = false, limit = MAX_CHANGES, now = Date.now() }) {
  const api = ghl || { listPipelines, addContactTags, removeContactTags, updateOpportunity, listAcquisitionOpportunities };
  const out = { considered: 0, planned: 0, applied: 0, fixes: [], errors: [] };
  const pipelines = await api.listPipelines(client, locationId);
  const acq = acquisitionsPipeline(pipelines);
  if (!acq) { out.errors.push("no pipeline with Tier 1/2/3 stages"); return out; }
  const [opportunities, tagEvents] = await Promise.all([
    api.listAcquisitionOpportunities(client, locationId, acq.id),
    store.listContactEventsSince?.(locationId, iso(now - EVENT_LOOKBACK_MS), { types: ["tag_added"], limit: 5000 }).catch(() => []) || [],
  ]);
  out.considered = opportunities.length;
  const fixes = planTierFixes({ pipelines, opportunities, tagEvents });
  out.planned = fixes.length;
  for (const f of fixes.slice(0, limit)) {
    if (dryRun) { out.fixes.push({ ...f, applied: false }); continue; }
    try {
      if (f.remove.length) await api.removeContactTags(client, f.contactId, f.remove);
      if (f.add.length) await api.addContactTags(client, f.contactId, f.add);
      if (f.moveTo) await api.updateOpportunity(client, f.opportunityId, { stageId: f.moveTo });
      const events = [...f.remove.map((tag) => ["tag_removed", tag]), ...f.add.map((tag) => ["tag_added", tag])];
      await Promise.all(events.map(([type, tag]) => recordEvent({ store, locationId, contactId: f.contactId, party: "agent", type, source: "tier_check", data: { tag } })));
      out.applied++;
      out.fixes.push({ ...f, applied: true });
      await sleep(120);
    } catch (e) {
      out.errors.push(`${f.name || f.contactId}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  return out;
}

/** The tick's call: once a day from 7am PT. */
export async function maybeRunTierCheck({ client, locationId, store = defaultStore, ghl = null, now = Date.now() }) {
  if (localHour(now) < CHECK_HOUR || localHour(now) >= 20) return null;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  if (cursor?.at && now - Date.parse(cursor.at) < MIN_GAP_MS) return null;
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: {} }).catch(() => {});
  try {
    const r = await runTierCheck({ client, locationId, store, ghl, now });
    const summary = { considered: r.considered, planned: r.planned, applied: r.applied, errors: r.errors.slice(0, 5),
      fixes: r.fixes.slice(0, 40).map((f) => ({ name: f.name, add: f.add, remove: f.remove, moved: !!f.moveTo, why: f.why })) };
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: summary }).catch(() => {});
    return r;
  } catch (e) {
    return { considered: 0, planned: 0, applied: 0, fixes: [], errors: [String(e?.message || e).slice(0, 160)] };
  }
}

export { listAcquisitionOpportunities };
