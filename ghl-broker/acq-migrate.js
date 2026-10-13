// acq-migrate.js — the one-time move of GHL's Acquisitions cards off the
// stages that go away (Matt's four-stage board, 2026-10-13).
//
// A report until `apply` is true; then at most `limit` cards a press, so
// Matt presses it again until it reports nothing left. Each move is on the
// contact's record. The last run's summary is kept on the `pipelineMigrate`
// cursor — ids and stage names, never a name or a message. Once the old
// stages are empty, Matt deletes them in GHL by hand (the API can't).
//
// The plan is shared/ghl-stages.js planMigration.

import { store as defaultStore } from "./store.js";
import { listPipelines, updateOpportunity, listWorkflows } from "./ghl.js";
import { acquisitionsPipeline } from "./ghl-mirror.js";
import { listAcquisitionOpportunities } from "./tier-check.js";
import { recordEvent } from "./contact-record.js";
import { planMigration, normalizeGhlStages } from "./shared/ghl-stages.js";
import { offerHasTheirAnswer } from "./shared/tiers.js";
import { INBOUND_EVENT_TYPES } from "./shared/last-activity.js";

export const MIGRATE_CURSOR = "pipelineMigrate";
export const MIGRATE_MAX = 300;
const NURTURE_RX = /nurture/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * runMigration({ client, locationId, store, ghl, apply, limit, now }) → { apply, counts, applied, moves, manual, errors }
 */
export async function runMigration({ client, locationId, store = defaultStore, ghl = null, apply = false, limit = MIGRATE_MAX, now = Date.now() }) {
  const api = ghl || { listPipelines, updateOpportunity, listWorkflows, listAcquisitionOpportunities };
  const out = { apply, counts: {}, applied: 0, moves: [], manual: [], errors: [] };
  const acq = acquisitionsPipeline(await api.listPipelines(client, locationId));
  if (!acq) { out.errors.push("no Acquisitions pipeline with Tier 1 and Tier 2 stages"); return out; }
  const [opportunities, offers, lastRows, workflows, saved] = await Promise.all([
    api.listAcquisitionOpportunities(client, locationId, acq.id),
    store.listOffers(locationId, { limit: 5000, lean: true }).catch(() => []),
    store.lastContactActivity?.(locationId, { types: INBOUND_EVENT_TYPES, inboundOnly: true }).catch(() => []) || [],
    (api.listWorkflows ? api.listWorkflows(client, locationId) : Promise.resolve(null)).catch(() => null),
    store.getOfferSettings(locationId).catch(() => null),
  ]);
  const replied = new Set([
    ...(lastRows || []).map((r) => r.contactId),
    ...(offers || []).filter(offerHasTheirAnswer).map((o) => o.contactId),
  ].filter(Boolean));
  const nurtureLive = workflows == null
    ? [{ id: "?", name: "a nurture workflow (GHL's list couldn't be read)" }]
    : (workflows || []).filter((w) => w?.id && NURTURE_RX.test(String(w.name || "")) && !/dispo/i.test(String(w.name || "")) && String(w.status || "").toLowerCase() !== "draft")
      .map((w) => ({ id: String(w.id), name: String(w.name || "") }));
  const plan = planMigration({ acq, opportunities, offers, replied, nurtureLive, settings: normalizeGhlStages(saved?.ghlStages), now });
  out.counts = plan.counts;
  out.manual = plan.manual.slice(0, 50);
  let left = Math.max(0, Math.min(MIGRATE_MAX, limit));
  for (const m of plan.moves) {
    const row = { contactId: m.contactId, opportunityId: m.opportunityId, from: m.from, to: m.to, why: m.why, ...(m.status ? { status: m.status } : {}), ...(m.blocked ? { blocked: m.blocked } : {}) };
    if (apply && !m.blocked && left > 0) {
      try {
        await api.updateOpportunity(client, m.opportunityId, { stageId: m.toStageId, ...(m.status ? { status: m.status } : {}) });
        await recordEvent({ store, locationId, contactId: m.contactId, party: "agent", type: "ghl_stage_moved", source: "pipeline_migrate",
          data: { from: m.from, to: m.to, why: m.why, ...(m.status ? { status: m.status } : {}) } }).catch(() => {});
        row.applied = true; out.applied++; left--;
        await sleep(120);
      } catch (e) { out.errors.push(`${m.opportunityId}: ${String(e?.message || e).slice(0, 160)}`); }
    }
    if (out.moves.length < 100) out.moves.push(row);
  }
  out.left = plan.counts.planned - out.applied;
  console.log(`pipeline migrate loc=${locationId} apply=${apply} old=${plan.counts.old} planned=${plan.counts.planned} blocked=${plan.counts.blocked} manual=${plan.counts.manual} applied=${out.applied}`);
  await store.setJobCursor?.(locationId, MIGRATE_CURSOR, { at: new Date(now).toISOString(),
    doc: { apply, counts: out.counts, applied: out.applied, left: out.left, errors: out.errors.slice(0, 5) } }).catch(() => {});
  return out;
}
