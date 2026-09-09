// ghl-mirror.js — write the board onto GHL's Opportunities, one way.
//
// Runs on the broker's 15-minute tick for every location whose mirror is
// switched on: read the lean offers, ask shared/ghl-mirror.js where each
// belongs, and write only the ones whose remembered projection differs.
// GHL never moves a card; a stage dragged there is overwritten next tick.
// Best effort throughout: a failed write is a warning on the offer, never
// a failed anything else.

import { store as defaultStore } from "./store.js";
import { mirrorPlan, mirrorDiff, normalizeMirror } from "./shared/ghl-mirror.js";
import { searchOpportunities, createOpportunity, updateOpportunity } from "./ghl.js";

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
  if (r.wrote || r.errors.length) log(`ghl mirror ${locationId}: ${r.wrote} written of ${r.considered}${r.errors.length ? `, ${r.errors.length} error(s): ${r.errors[0]}` : ""}`);
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: new Date(now).toISOString(), doc: { wrote: r.wrote, considered: r.considered, errors: r.errors.slice(0, 5) } }).catch(() => {});
  return r;
}
