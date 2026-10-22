// needs-matt.js — puts an agent's card in GHL's "Needs Matt" stage while
// something only he can do is open, and takes it out when it's done.
//
// Matt, 2026-10-22: "Instead of ping to me they land there." The list of what
// lands there is shared/needs-matt.js (kept short on purpose); the move itself
// is shared/ghl-stages.js planCard's `needsMatt`, applied by tier-check.js
// syncAgentCard. This reads the pipeline (the read Today used), keeps the
// list on the `needsMatt` cursor for the 7am plan and every card sync, and
// syncs the cards whose need started or ended since the last read.
//
//   - Off unless ghlStages.mode is "on" and the Acquisitions pipeline has a
//     stage named "Needs Matt". No stage: the cursor is still kept (a
//     report), nothing moves.
//   - The cursor is written before any card moves; a run a deploy killed is
//     retried once it's stale (conversation-audit.js gating).
//   - The why goes on the card once per thing: the App ping why field and a
//     contact note, claimed by a `needs_matt_noted` event first.
//
// Never sends a text to anyone. Ids and kinds in the cursor and logs, no names.

import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { recordError, scrubMessage } from "./app-errors.js";
import { updateContact, createContactNote } from "./ghl.js";
import { acquisitionsPipeline, pipelinesFor } from "./ghl-mirror.js";
import { syncAgentCard } from "./tier-check.js";
import { fieldId } from "./ghl-pings.js";
import { normalizeGhlStages, stageKeys } from "./shared/ghl-stages.js";
import { needsMattByContact, needsMattFromCursor, NEEDS_MATT_CURSOR, NEEDS_MATT_EVENT } from "./shared/needs-matt.js";
import { ghlPingNote } from "./shared/ghl-pings.js";

export const STALE_RUN_MS = 30 * 60 * 1000;
export const MAX_SYNCS_PER_RUN = 40;
// Pacific hours the cards move: he isn't reading the board at 2am.
export const NEEDS_MATT_FROM = 7;
export const NEEDS_MATT_UNTIL = 21;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (n) => new Promise((r) => setTimeout(r, n));

async function patchCursor(store, locationId, patch) {
  const cur = await store.getJobCursor?.(locationId, NEEDS_MATT_CURSOR).catch(() => null);
  await store.setJobCursor?.(locationId, NEEDS_MATT_CURSOR, { at: iso(Date.now()), doc: { ...(cur?.doc || {}), ...patch } }).catch(() => {});
}

// What the cursor keeps per agent: kind, why, when, the claim key. No names.
// `placed`: the card was synced for this need (moved, already there, a
// person's drag that stands, or a skip); one a GHL error stopped is tried
// again next tick.
const keep = (v, placed = false) => ({ kind: v.kind, rowKind: v.rowKind || "", why: v.why || "", at: v.at || null, key: v.key, offerId: v.offerId || null, placed });

/**
 * runNeedsMatt({ store, locationId, client, saved, deps, now, dryRun, ghl })
 *   → { dryRun, stage, needs, entered, left, synced, moved, noted, errors, finishedAt }
 *
 *   deps.pipelineFor  routes/dashboard.js router.pipelineFor
 *   deps.syncAgentCard  tier-check.js syncAgentCard (tests stub it)
 */
export async function runNeedsMatt({ store = defaultStore, locationId, client, saved = {}, deps = {}, now = Date.now(), dryRun = false, ghl = null } = {}) {
  const out = { dryRun, stage: false, needs: 0, byKind: {}, entered: [], left: [], synced: 0, moved: 0, noted: 0, errors: [], finishedAt: null };
  const done = () => { out.finishedAt = iso(Date.now()); return out; };
  if (typeof deps.pipelineFor !== "function") throw new Error("runNeedsMatt needs deps.pipelineFor");
  const cfg = normalizeGhlStages(saved?.ghlStages);
  const acq = acquisitionsPipeline(await pipelinesFor(client, locationId, { ghl, now }));
  out.stage = Boolean(acq && stageKeys(acq).needsMatt);

  const read = await deps.pipelineFor({ locationId, client, now });
  const rows = [...(read.shownActions || []), ...(read.shownCalls || [])];
  const needs = needsMattByContact(rows, { drafts: read.drafts || [], now });
  out.needs = needs.size;
  for (const v of needs.values()) out.byKind[v.kind] = (out.byKind[v.kind] || 0) + 1;

  const cur = await store.getJobCursor?.(locationId, NEEDS_MATT_CURSOR).catch(() => null);
  const prev = needsMattFromCursor(cur?.doc);
  const entered = [...needs.keys()].filter((id) => prev.get(id)?.key !== needs.get(id).key || prev.get(id)?.placed === false);
  const left = [...prev.keys()].filter((id) => !needs.has(id));
  out.entered = entered.map((id) => ({ contactId: id, kind: needs.get(id).kind }));
  out.left = left.map((id) => ({ contactId: id }));
  if (dryRun) return done();

  // The list first: the 7am plan and every card sync read it from here.
  const kept = Object.fromEntries([...needs].map(([id, v]) => [id, keep(v, prev.get(id)?.key === v.key ? prev.get(id)?.placed !== false : false)]));
  await patchCursor(store, locationId, { needs: kept, readAt: iso(now) });
  if (!out.stage || cfg.mode !== "on") return done();

  const sync = deps.syncAgentCard || syncAgentCard;
  const work = [...entered.map((id) => ({ id, need: needs.get(id) })), ...left.map((id) => ({ id, need: null }))].slice(0, MAX_SYNCS_PER_RUN);
  let field = null;
  for (const { id, need } of work) {
    const r = await sync({ client, locationId, contactId: id, store, saved, ghl, needsMatt: need ? keep(need) : null, now });
    out.synced++;
    if (r?.applied) out.moved++;
    if (r?.error) out.errors.push(`${id}: ${r.error}`);
    // Only a GHL error is tried again: a skip (two open cards, not an agent)
    // stays one until the 7am plan reads it fresh.
    const placed = Boolean(r && !r.error);
    if (need && placed) kept[id] = { ...kept[id], placed: true };
    // Into the stage: say why on the card, once per thing.
    if (need && (r?.applied || /already in needs matt/i.test(String(r?.skip || "")))) {
      const claim = await recordEvent({ store, locationId, contactId: id, type: NEEDS_MATT_EVENT, at: iso(now), source: "sweep",
        offerId: need.offerId || null, dedupeKey: need.key, data: { kind: need.kind, rowKind: need.rowKind || "" } }).catch(() => null);
      if (claim?.inserted) {
        try {
          field = field || await fieldId({ store, locationId, client });
          await updateContact(client, id, { customFields: [{ id: field.id, value: need.why }] });
          await createContactNote(client, id, { body: ghlPingNote(need.why) }).catch(() => null);
          out.noted++;
        } catch (e) {
          await recordError(store, { locationId, area: "needs-matt", err: e, context: { contactId: id, kind: need.kind } });
          out.errors.push(`${id}: ${scrubMessage(e).slice(0, 120)}`);
          field = null;
        }
      }
    }
    await sleep(100);
  }
  await patchCursor(store, locationId, { needs: kept });
  return done();
}

/* ---------- the tick: every 15 minutes, 7am–9pm Pacific ---------- */

const pacificHour = (t) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date(t))) % 24;
const running = new Set();
export function _resetNeedsMatt() { running.clear(); }

// What a run did, for the cursor: ids and kinds, never what was said.
export const summarizeNeedsMatt = (r) => ({
  finishedAt: r?.finishedAt || null, stage: Boolean(r?.stage), needs: r?.needs ?? 0, byKind: r?.byKind || {},
  entered: (r?.entered || []).length, left: (r?.left || []).length, moved: r?.moved ?? 0, noted: r?.noted ?? 0,
  errors: (r?.errors || []).slice(0, 5),
});

/**
 * maybeRunNeedsMatt({ client, locationId, saved, store, deps, now }) → { ran } | null
 *
 * Only with ghlStages.mode "on". Every tick in the hours; a run that died
 * under a deploy is retried once it's stale.
 */
export async function maybeRunNeedsMatt({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() }) {
  if (normalizeGhlStages(saved?.ghlStages).mode !== "on") return null;
  const h = pacificHour(now);
  if (h < NEEDS_MATT_FROM || h >= NEEDS_MATT_UNTIL) return null;
  if (running.has(locationId)) return null;
  const cursor = await store.getJobCursor?.(locationId, NEEDS_MATT_CURSOR).catch(() => null);
  const started = Date.parse(cursor?.doc?.run?.startedAt || "");
  if (Number.isFinite(started) && now - started < STALE_RUN_MS) return null;
  await patchCursor(store, locationId, { run: { startedAt: iso(now) } });
  running.add(locationId);
  try {
    const r = await runNeedsMatt({ store, locationId, client, saved, deps, now });
    await patchCursor(store, locationId, { run: null, last: summarizeNeedsMatt(r) });
  } catch (e) {
    await recordError(store, { locationId, area: "needs-matt", err: e, context: { stage: "tick" } });
    await patchCursor(store, locationId, { run: null, last: { error: scrubMessage(e).slice(0, 200), finishedAt: iso(Date.now()) } });
  } finally {
    running.delete(locationId);
  }
  return { ran: true };
}
