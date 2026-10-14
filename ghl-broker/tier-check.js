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
//
// With `ghlStages.mode` "on" (Matt's four-stage board, 2026-10-13) the card
// follows the offers instead (shared/ghl-stages.js), and the tags follow the
// card: Tier 1, Offer Out and Contract are tier-1, Tier 2 is tier-2, and a tag
// the bot added never moves a card.

import { store as defaultStore } from "./store.js";
import { listPipelines, addContactTags, removeContactTags, updateOpportunity, createOpportunity, searchOpportunities, listWorkflows } from "./ghl.js";
import { acquisitionsPipeline, pipelinesFor } from "./ghl-mirror.js";
import { recordEvent } from "./contact-record.js";
import { localHour } from "./promise-sweep.js";
import { claimDailyRun, closeDailyRun } from "./daily-gate.js";
import { planStageMoves, planCard, normalizeGhlStages, stageKeys } from "./shared/ghl-stages.js";
import { offerStageAt } from "./shared/offer-stage.js";
import { openPromises } from "./shared/promise-resolver.js";
import { INBOUND_EVENT_TYPES } from "./shared/last-activity.js";
import { runTierOneScreen } from "./tier-one.js";

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
 * planTierFixes({ pipelines, opportunities, tagEvents, followsOffers }) → [{ contactId, name, opportunityId, add, remove, moveTo, from, why }]
 *
 * Pure. `opportunities` are GHL search rows (with `contact.tags`); `tagEvents`
 * are the app's recent tag_added events ({ contactId, at, data: { tag } }).
 * `followsOffers`: the card follows the offers, so the tags only follow the
 * card — never the other way round.
 */
export function planTierFixes({ pipelines = [], opportunities = [], tagEvents = [], followsOffers = false } = {}) {
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
    if (!followsOffers && !past && bot && bot.tag !== want && have.includes(bot.tag) && bot.at > stageAt) {
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
export async function runTierCheck({ client, locationId, store = defaultStore, ghl = null, saved = {}, dryRun = false, limit = MAX_CHANGES, now = Date.now() }) {
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
  // The stage plan reads the same cards (runStagePlan); not part of the summary.
  Object.defineProperty(out, "read", { value: { pipelines, opportunities }, enumerable: false });
  const followsOffers = normalizeGhlStages(saved?.ghlStages).mode === "on";
  const fixes = planTierFixes({ pipelines, opportunities, tagEvents, followsOffers });
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

// A published "Tier 2+3 nurture" style workflow: GHL starts it by itself
// when a card lands in Tier 2/3, and it texts (shared/agent-pulse.js tierDrips).
// The agent nurture GHL starts on a Tier 2/3 stage move ("Tier 2+3 nurture").
// Not every workflow called a nurture: "Not Now Nurture" is a seller drip
// with nothing to do with the Acquisitions board (Matt, 2026-10-13).
const NURTURE_RX = /^(?=.*nurture)(?=.*tier)/i;
const nurtureWorkflows = (list) => (Array.isArray(list) ? list : [])
  .filter((w) => w?.id && NURTURE_RX.test(String(w.name || "")) && !/dispo/i.test(String(w.name || "")) && String(w.status || "").toLowerCase() !== "draft")
  .map((w) => ({ id: String(w.id), name: String(w.name || "") }));

// What the app does to a card: its own moves, and the GHL workflows the bot
// puts someone in (TIER 1 moved the card by itself, seconds later).
export const APP_MOVE_EVENT_TYPES = ["ghl_stage_moved", "workflow_enrolled"];
export function appMovesByContact(events = []) {
  const out = new Map();
  for (const e of events || []) {
    if (!e?.contactId || !e.at || !APP_MOVE_EVENT_TYPES.includes(e.type)) continue;
    if (!out.has(e.contactId)) out.set(e.contactId, []);
    out.get(e.contactId).push(e.at);
  }
  return out;
}

/**
 * runStagePlan({ client, locationId, store, saved, ghl, read, dryRun, now }) → { mode, planned, blocked, applied, moves, errors }
 *
 * Where each agent's Acquisitions card should sit by the app's record
 * (shared/ghl-stages.js), and — only with `ghlStages.mode` "on" and not a dry
 * run — the moves themselves, capped per run. The report keeps contact and
 * card ids and stage names, never a name or a message.
 */
export async function runStagePlan({ client, locationId, store = defaultStore, saved = {}, ghl = null, read = null, dryRun = true, now = Date.now() }) {
  const api = ghl || { listPipelines, updateOpportunity, createOpportunity, listAcquisitionOpportunities, listWorkflows };
  const cfg = normalizeGhlStages(saved?.ghlStages);
  const out = { mode: cfg.mode, planned: 0, blocked: 0, applied: 0, moves: [], byMove: {}, errors: [] };
  const pipelines = read?.pipelines || await api.listPipelines(client, locationId);
  const acq = acquisitionsPipeline(pipelines);
  if (!acq) { out.errors.push("no pipeline with Tier 1/2/3 stages"); return out; }
  const [opportunities, offers, promiseEvents, moveEvents, lastRows, workflows] = await Promise.all([
    read?.opportunities || api.listAcquisitionOpportunities(client, locationId, acq.id),
    store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []),
    store.listContactEventsSince?.(locationId, iso(now - 7 * 86400000), { types: ["promise_made", "promise_owed", "promise_kept"], limit: 5000 }).catch(() => []) || [],
    // Card moves the app made, so "newest wins" never reads one as yours.
    store.listContactEventsSince?.(locationId, iso(now - 60 * 86400000), { types: APP_MOVE_EVENT_TYPES, limit: 20000 }).catch(() => []) || [],
    store.lastContactActivity?.(locationId, { types: INBOUND_EVENT_TYPES, inboundOnly: true }).catch(() => []) || [],
    (api.listWorkflows ? api.listWorkflows(client, locationId) : Promise.resolve(null)).catch(() => null),
  ]);
  const plan = planStageMoves({
    acq, opportunities, offers, now, settings: cfg,
    lastIn: new Map((lastRows || []).map((r) => [r.contactId, r.at])),
    openPromiseContacts: new Set(openPromises(promiseEvents || [], { now }).map((p) => p.contactId)),
    appMoves: appMovesByContact(moveEvents),
    // Can't read the workflow list: assume the nurture is live, so nothing moves into Tier 2 blind.
    nurtureLive: workflows == null ? [{ id: "?", name: "a nurture workflow (GHL's list couldn't be read)" }] : nurtureWorkflows(workflows),
  });
  out.planned = plan.counts.planned;
  out.blocked = plan.counts.blocked;
  out.created = 0;
  out.byMove = plan.counts.byMove;
  out.youMoved = plan.youMoved.slice(0, 40).map((m) => ({ contactId: m.contactId, opportunityId: m.opportunityId, from: m.from, wanted: m.wanted }));
  out.counts = plan.counts;
  const go = cfg.mode === "on" && !dryRun;
  let left = cfg.maxMovesPerRun;
  for (const m of plan.moves) {
    const row = { contactId: m.contactId, opportunityId: m.opportunityId, from: m.from, to: m.to, why: m.why, ...(m.status ? { status: m.status } : {}), ...(m.blocked ? { blocked: m.blocked } : {}) };
    if (go && !m.blocked && left > 0) {
      try {
        await applyCardPlan({ client, locationId, store, api, acq, plan: { move: m }, source: "ghl_stages" });
        row.applied = true; out.applied++; left--;
        await sleep(120);
      } catch (e) { out.errors.push(`${m.opportunityId}: ${String(e?.message || e).slice(0, 160)}`); }
    }
    if (out.moves.length < 80) out.moves.push(row);
  }
  out.creates = [];
  for (const c of plan.creates) {
    const row = { contactId: c.contactId, to: c.to, why: c.why };
    if (go && left > 0) {
      try {
        await applyCardPlan({ client, locationId, store, api, acq, plan: { create: c }, source: "ghl_stages" });
        row.applied = true; out.created++; left--;
        await sleep(120);
      } catch (e) { out.errors.push(`create ${c.contactId}: ${String(e?.message || e).slice(0, 160)}`); }
    }
    if (out.creates.length < 40) out.creates.push(row);
  }
  return out;
}

/**
 * applyCardPlan({ client, locationId, store, api, acq, plan, source }) → { opportunityId, from, to } | null
 *
 * Writes one planCard result to GHL and the contact's record. Throws on a GHL
 * failure (the callers count it). Ids and stage names only.
 */
async function applyCardPlan({ client, locationId, store, api, acq, plan, source }) {
  if (plan.move && !plan.move.blocked) {
    const m = plan.move;
    await api.updateOpportunity(client, m.opportunityId, { stageId: m.toStageId, ...(m.status ? { status: m.status } : {}) });
    await recordEvent({ store, locationId, contactId: m.contactId, party: "agent", type: "ghl_stage_moved", source,
      data: { from: m.from, to: m.to, why: m.why, ...(m.status ? { status: m.status } : {}) } }).catch(() => {});
    return { opportunityId: m.opportunityId, from: m.from, to: m.to };
  }
  if (plan.create) {
    const c = plan.create;
    const made = await api.createOpportunity(client, { locationId, pipelineId: acq.id, contactId: c.contactId, name: c.name, stageId: c.toStageId });
    await recordEvent({ store, locationId, contactId: c.contactId, party: "agent", type: "ghl_stage_moved", source,
      data: { from: "", to: c.to, why: c.why, created: true } }).catch(() => {});
    return { opportunityId: made?.id || "", from: "", to: c.to };
  }
  return null;
}

// GHL's workflow list, once an hour per location: a Tier 2 move checks it.
const WORKFLOW_TTL_MS = 3600 * 1000;
const workflowCache = new Map();
async function liveNurture(client, locationId, api, now) {
  const hit = workflowCache.get(locationId);
  if (hit && now - hit.at < WORKFLOW_TTL_MS) return hit.live;
  const list = await (api.listWorkflows ? api.listWorkflows(client, locationId) : Promise.resolve(null)).catch(() => null);
  const live = list == null ? [{ id: "?", name: "a nurture workflow (GHL's list couldn't be read)" }] : nurtureWorkflows(list);
  workflowCache.set(locationId, { at: now, live });
  return live;
}
export function _resetWorkflowCache() { workflowCache.clear(); }

/**
 * syncAgentCard({ client, locationId, contactId, store, saved, ghl, now }) → planCard's result, plus { applied } | { skip } | { error }
 *
 * One agent's card, right after their offers moved (shared/ghl-stages.js
 * planCard). Only with `ghlStages.mode` "on". Never throws.
 */
export async function syncAgentCard({ client, locationId, contactId, store = defaultStore, saved = null, ghl = null, now = Date.now() }) {
  const api = ghl || { listPipelines, searchOpportunities, updateOpportunity, createOpportunity, listWorkflows };
  try {
    if (!contactId) return { skip: "no contact" };
    const settings = saved || (await store.getOfferSettings(locationId).catch(() => null)) || {};
    const cfg = normalizeGhlStages(settings.ghlStages);
    if (cfg.mode !== "on") return { skip: "GHL doesn't follow the offers (ghlStages off)" };
    const acq = acquisitionsPipeline(await pipelinesFor(client, locationId, { ghl: api, now }));
    if (!acq) return { skip: "no Acquisitions pipeline" };
    const [cards, offers] = await Promise.all([
      api.searchOpportunities(client, locationId, { contactId, pipelineId: acq.id }),
      store.listOffers(locationId, { contactId, limit: 100, lean: true }).catch(() => []),
    ]);
    const plan = planCard({
      acq, keys: stageKeys(acq), contactId, offers, settings: cfg, now,
      cards: (cards || []).map((c) => ({ ...c, pipelineStageId: c.pipelineStageId || c.stageId })),
      name: (offers || []).find((o) => o?.contactName)?.contactName || "",
      nurtureLive: await liveNurture(client, locationId, api, now),
    });
    if (plan.skip || plan.youMoved || plan.move?.blocked) return plan;
    const applied = await applyCardPlan({ client, locationId, store, api, acq, plan, source: "offers" });
    console.log(`card follows offers loc=${locationId} contact=${contactId} ${applied?.from || "new"} → ${applied?.to}`);
    return { ...plan, applied };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * syncChangedCards({ client, locationId, store, saved, ghl, now, limit }) → { since, contacts, moved, errors } | null
 *
 * The 15-minute tick: every agent whose offers moved since the last run gets
 * syncAgentCard. Status writes come from a dozen places (the conversation,
 * the sweeps, the timers, the triage); reading what changed catches them all.
 * The cursor is written before the run; a contact past `limit` waits for the
 * 7am sweep. Only with `ghlStages.mode` "on".
 */
export const CARD_SYNC_CURSOR = "cardSync";
const cardSyncRunning = new Set();
export async function syncChangedCards({ client, locationId, store = defaultStore, saved = {}, ghl = null, now = Date.now(), limit = 40 }) {
  if (normalizeGhlStages(saved?.ghlStages).mode !== "on" || cardSyncRunning.has(locationId)) return null;
  cardSyncRunning.add(locationId);
  try {
    const cur = await store.getJobCursor?.(locationId, CARD_SYNC_CURSOR).catch(() => null);
    // First run: nothing to catch up on — the morning sweep has the book.
    const since = Date.parse(cur?.doc?.since || "") || now;
    await store.setJobCursor?.(locationId, CARD_SYNC_CURSOR, { at: iso(now), doc: { since: iso(now), prev: iso(since) } });
    const offers = await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []);
    const changed = [...new Set((offers || []).filter((o) => o?.contactId
      && Math.max(offerStageAt(o) ?? 0, Date.parse(o.updatedAt || "") || 0) > since).map((o) => o.contactId))];
    const out = { since: iso(since), contacts: changed.length, moved: 0, errors: [] };
    for (const contactId of changed.slice(0, limit)) {
      const r = await syncAgentCard({ client, locationId, contactId, store, saved, ghl, now });
      if (r?.applied) out.moved++;
      if (r?.error) out.errors.push(`${contactId}: ${r.error}`);
      await sleep(100);
    }
    return out;
  } finally {
    cardSyncRunning.delete(locationId);
  }
}

/** The tick's call: once a day from 7am PT. */
const inFlight = new Set();
export async function maybeRunTierCheck({ client, locationId, store = defaultStore, ghl = null, saved = {}, operatorStatus = null, tierOneDeps = null, now = Date.now() }) {
  // Once a day; a run a deploy killed, or one that failed, comes back later
  // that day (daily-gate.js).
  const gate = await claimDailyRun({ store, locationId, cursorName: CURSOR_NAME, now, hourNow: localHour(now), startHour: CHECK_HOUR,
    windowHours: 20 - CHECK_HOUR, running: inFlight.has(locationId), minGapMs: MIN_GAP_MS });
  if (!gate.go) return null;
  inFlight.add(locationId);
  try {
    const r = await runTierCheck({ client, locationId, store, ghl, saved, now });
    // Where the cards should sit (shared/ghl-stages.js): always planned and
    // kept as a report, moved only with ghlStages.mode "on".
    const stageMoves = await runStagePlan({ client, locationId, store, saved, ghl, read: r.read, dryRun: false, now })
      .catch((e) => ({ errors: [String(e?.message || e).slice(0, 160)] }));
    // GHL's Tier 1 stage screened (ghl-broker/tier-one.js): sure misses are
    // planned every morning and taken off only with tierOne.autoKick on.
    const tierOne = await runTierOneScreen({ client, locationId, saved, store, read: r.read, now,
      deps: { ...(tierOneDeps || {}), ...(operatorStatus ? { operatorStatus } : {}) } })
      .catch((e) => ({ errors: [String(e?.message || e).slice(0, 160)] }));
    const summary = { considered: r.considered, planned: r.planned, applied: r.applied, errors: r.errors.slice(0, 5),
      fixes: r.fixes.slice(0, 40).map((f) => ({ name: f.name, add: f.add, remove: f.remove, moved: !!f.moveTo, why: f.why })),
      stageMoves: { ...stageMoves, at: iso(now) }, tierOne: { ...tierOne, at: iso(now) } };
    await closeDailyRun({ store, locationId, cursorName: CURSOR_NAME, last: summary });
    return r;
  } catch (e) {
    const error = String(e?.message || e).slice(0, 160);
    await closeDailyRun({ store, locationId, cursorName: CURSOR_NAME, failed: true, error });
    return { considered: 0, planned: 0, applied: 0, fixes: [], errors: [error] };
  } finally {
    inFlight.delete(locationId);
  }
}

export { listAcquisitionOpportunities };
