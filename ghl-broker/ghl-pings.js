// ghl-pings.js — the few things only Matt can do, told to him through GHL.
//
// Matt, 2026-10-20: no Today. Paperwork to sign, an agreed number to approve,
// a closing task: each pings him once, through his GHL workflow "App: needs
// Matt" (an Internal notification step, re-entry on). GHL's API can't send
// him a notification itself, so the app puts the contact in that workflow,
// with the why in contact.app_ping_why and on a contact note.
//
// shared/hand-off.js decides which rows ping (pingReasons); shared/ghl-pings.js
// has the words and the claim key. This reads, claims, and writes to GHL.
//
//   - One ping per thing, ever: a `ghl_ping_sent` event is the claim, written
//     BEFORE anything goes to GHL; its unique key is the concurrency story.
//   - A GHL write that fails is a durable error and a `ghl_ping_failed` event
//     against the claim. The claim stands: a ping is a nicety, not a duty.
//   - At most MAX_PER_RUN a run, so a short read can't ping everything at once.
//
// Never sends a text to anyone. Off unless desk.ghlPings is on with a workflow.

import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { recordError, scrubMessage } from "./app-errors.js";
import { updateContact, createContactNote, addContactToWorkflow, removeContactFromWorkflow, findOrCreateCustomFieldByKey } from "./ghl.js";
import { normalizeDesk } from "./shared/call-list.js";
import { pingReasons } from "./shared/hand-off.js";
import { ghlPingsOn, pingWhy, pingClaimKey, ghlPingNote, GHL_PING_FIELD, GHL_PING_EVENT_TYPES } from "./shared/ghl-pings.js";

export const CURSOR_NAME = "ghlPings";
export const MAX_PER_RUN = 10;
export const STALE_RUN_MS = 30 * 60 * 1000;
// How far back a claim is looked for. A thing still waiting after this long
// pings again, once.
const LEDGER_DAYS = 60;
const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString();

async function patchCursor(store, locationId, patch) {
  const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(Date.now()), doc: { ...(cur?.doc || {}), ...patch } }).catch(() => {});
}

// The contact field's id: off the cursor, else found or made in GHL once.
async function fieldId({ store, locationId, client }) {
  const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  if (cur?.doc?.fieldId) return { id: cur.doc.fieldId, cached: true };
  const id = await findOrCreateCustomFieldByKey(client, locationId, GHL_PING_FIELD.key, GHL_PING_FIELD.name, "TEXT");
  if (!id) throw new Error("GHL didn't return the App ping why field");
  await patchCursor(store, locationId, { fieldId: id });
  return { id, cached: false };
}

/**
 * runGhlPings({ store, locationId, client, saved, deps, now, dryRun, trigger })
 *   → { dryRun, picked, pinged, skipped, failed, finishedAt, error }
 *
 *   deps.pipelineFor  routes/dashboard.js router.pipelineFor — Today's read
 *   dryRun            lists who would be pinged and why; writes nothing
 */
export async function runGhlPings({ store = defaultStore, locationId, client, saved = {}, deps = {}, now = Date.now(), dryRun = false, trigger = "manual" } = {}) {
  const cfg = normalizeDesk(saved?.desk).ghlPings;
  const out = { dryRun, trigger, startedAt: iso(now), finishedAt: null, picked: 0, pinged: [], skipped: [], failed: [], error: null };
  const done = () => { out.finishedAt = iso(Date.now()); return out; };
  if (!dryRun && !ghlPingsOn(cfg)) { out.error = "off: switch it on and paste the GHL workflow link in Settings"; return done(); }
  if (typeof deps.pipelineFor !== "function") throw new Error("runGhlPings needs deps.pipelineFor");

  const read = await deps.pipelineFor({ locationId, client, now });
  const picks = pingReasons(read.deskAll?.rows || read.desk?.rows || [], { drafts: read.drafts || [] });
  out.picked = picks.length;
  const ledger = await store.listContactEventsSince(locationId, iso(now - LEDGER_DAYS * DAY_MS), { types: GHL_PING_EVENT_TYPES, limit: 5000 }).catch(() => []);
  const claimed = new Set(ledger.filter((e) => e?.type === "ghl_ping_sent").map((e) => e.dedupeKey));
  let field = null;
  for (const r of picks) {
    const key = pingClaimKey(r);
    const row = { contactId: r.contactId, kind: r.kind, offerId: r.offerId || null };
    if (claimed.has(key)) { out.skipped.push({ ...row, why: "already pinged" }); continue; }
    if (out.pinged.length >= MAX_PER_RUN) { out.skipped.push({ ...row, why: "next run" }); continue; }
    const why = pingWhy(r);
    if (dryRun) { out.pinged.push({ ...row, why, status: "would ping" }); continue; }

    // Claim first. A second tick, broker or hand run finds the key taken.
    const claim = await recordEvent({ store, locationId, contactId: r.contactId, type: "ghl_ping_sent", at: iso(now), source: "sweep",
      address: r.address || "", offerId: row.offerId, dedupeKey: key, data: { kind: r.kind, why, trigger, workflowId: cfg.workflowId } });
    if (!claim.inserted) { out.skipped.push({ ...row, why: "already pinged" }); continue; }
    try {
      field = field || await fieldId({ store, locationId, client });
      await updateContact(client, r.contactId, { customFields: [{ id: field.id, value: why }] });
      // Out first, so a contact still in the workflow from an earlier ping
      // goes through it again with today's words.
      await removeContactFromWorkflow(client, r.contactId, cfg.workflowId).catch(() => null);
      await addContactToWorkflow(client, r.contactId, cfg.workflowId);
      const noted = await createContactNote(client, r.contactId, { body: ghlPingNote(why) }).then(() => true).catch(() => false);
      out.pinged.push({ ...row, why, status: "pinged", ...(noted ? {} : { note: "the note didn't save" }) });
    } catch (e) {
      const error = scrubMessage(e).slice(0, 160);
      await recordError(store, { locationId, area: "ghl-pings", err: e, context: { contactId: r.contactId, kind: r.kind } });
      await recordEvent({ store, locationId, contactId: r.contactId, type: "ghl_ping_failed", at: iso(now), source: "sweep",
        dedupeKey: `ghl_ping_failed:${key}`, data: { claimKey: key, kind: r.kind, error } });
      out.failed.push({ ...row, error });
      if (field?.cached) { await patchCursor(store, locationId, { fieldId: null }); field = null; }
    }
  }
  return done();
}

/* ---------- the tick: every 15 minutes, from..until Pacific ---------- */

const pacificHour = (t) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date(t))) % 24;
const running = new Set();
export function _resetGhlPings() { running.clear(); }

// What a run did, for the cursor: who and what kind, not what was said.
export const summarizePings = (r) => ({
  startedAt: r?.startedAt || null, finishedAt: r?.finishedAt || null, error: r?.error || null, picked: r?.picked ?? 0,
  pinged: (r?.pinged || []).map((p) => ({ contactId: p.contactId, kind: p.kind, status: p.status })),
  failed: (r?.failed || []).map((p) => ({ contactId: p.contactId, kind: p.kind, error: p.error })),
});

/**
 * maybeRunGhlPings({ client, locationId, saved, store, deps, now }) → { ran } | null
 *
 * Off the 15-minute tick, the nightly audit's gating (conversation-audit.js
 * maybeRunConversationAudit): the cursor is written before the run, and a
 * run that died under a deploy is retried once it's stale. Every tick runs;
 * the claims keep each thing to one ping.
 */
export async function maybeRunGhlPings({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() }) {
  const cfg = normalizeDesk(saved?.desk).ghlPings;
  if (!ghlPingsOn(cfg)) return null;
  const h = pacificHour(now);
  if (h < cfg.from || h >= cfg.until) return null;
  if (running.has(locationId)) return null;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const started = Date.parse(cursor?.doc?.run?.startedAt || "");
  if (Number.isFinite(started) && now - started < STALE_RUN_MS) return null;
  await patchCursor(store, locationId, { run: { startedAt: iso(now) } });
  running.add(locationId);
  try {
    const r = await runGhlPings({ store, locationId, client, saved, deps, now, trigger: "tick" });
    await patchCursor(store, locationId, { run: null, last: summarizePings(r) });
  } catch (e) {
    await recordError(store, { locationId, area: "ghl-pings", err: e, context: { stage: "tick" } });
    await patchCursor(store, locationId, { run: null, last: { error: scrubMessage(e).slice(0, 200), finishedAt: iso(Date.now()) } });
  } finally {
    running.delete(locationId);
  }
  return { ran: true };
}
