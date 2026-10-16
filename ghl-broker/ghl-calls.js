// ghl-calls.js — Today's calls into GHL's Manual Actions queue.
//
// Matt dials from his computer in GHL's Manual Actions, not from Today
// (2026-10-15). GHL's API can't create a Manual Action — only a workflow step
// can — so Matt keeps one workflow ("App: call today") with a single Manual
// Action → Phone Call step whose instructions read {{contact.app_call_why}}
// and {{contact.app_call_say}}. For each call this fills those two contact
// fields and puts the contact in that workflow. GHL records the call on the
// contact, call-intake reads it, and the Desk's call row clears itself.
//
// shared/desk.js decides which rows go (ghlCallRows) and which have gone
// (ghlCallsDue); shared/ghl-calls.js has the words and the ledger. This reads,
// claims, writes to GHL, and takes back a call whose reason is gone.
//
//   - One call per person per Pacific day: a `ghl_call_queued` event is the
//     claim, written BEFORE anything goes to GHL; its unique key is the whole
//     concurrency story (two brokers in a deploy, a tick and a hand run).
//   - A contact GHL has no phone for is never claimed: their row stays on Today.
//   - A GHL write that fails is a durable error and a `ghl_call_failed` event
//     against the claim: the row stays on Today for the day.
//   - A call still in GHL whose row is gone, with no call since it went in,
//     is taken out of the workflow (`ghl_call_withdrawn`). Best-effort.
//
// Never sends a text. Off unless desk.ghlCalls is on with a workflow.

import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { recordError, scrubMessage } from "./app-errors.js";
import { getContact, updateContact, addContactToWorkflow, removeContactFromWorkflow, findOrCreateCustomFieldByKey } from "./ghl.js";
import { normalizeDesk } from "./shared/call-list.js";
import { ghlCallRows, ghlCallsDue } from "./shared/desk.js";
import { callFields, ghlCallsOn, GHL_CALL_FIELDS, GHL_CALL_EVENT_TYPES, liveGhlQueues, ghlCallClaimKey } from "./shared/ghl-calls.js";
import { callEventConnected } from "./shared/talked-to.js";

export const CURSOR_NAME = "ghlCalls";
// How far back a call still in GHL is looked for: a week covers a weekend
// and a missed morning.
const LEDGER_DAYS = 7;
// Calls taken back in one run, at most. A read that came back short would
// otherwise read as every reason gone at once; the rest wait a tick.
const MAX_WITHDRAW_PER_RUN = 10;
const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
export const pacificDay = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(t));
// GHL saying "not in that workflow" (or no such contact) is a take-back that already happened.
const gone = (e) => [400, 404, 422].includes(Number(e?.status));

// Contacts GHL had no phone for today: asked once a day, not every tick.
const noPhone = new Set();
let noPhoneDay = "";

/** The cursor, merged: other keys (the morning's run, the field ids) are kept. */
export async function patchCursor(store, locationId, patch) {
  const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: cur?.at || iso(Date.now()), doc: { ...(cur?.doc || {}), ...patch } }).catch(() => {});
}

// The two contact fields' ids: off the cursor, else found or made in GHL once.
async function fieldIds({ store, locationId, client }) {
  const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const cached = cur?.doc?.fields;
  if (cached?.why && cached?.say) return { why: cached.why, say: cached.say, cached: true };
  const ids = {};
  for (const f of GHL_CALL_FIELDS) ids[f.role] = await findOrCreateCustomFieldByKey(client, locationId, f.key, f.name, "TEXT");
  if (!ids.why || !ids.say) throw new Error("GHL didn't return the App call why / App call say fields");
  await patchCursor(store, locationId, { fields: { why: ids.why, say: ids.say } });
  return { ...ids, cached: false };
}

// A call happened since `at`: one that connected, or one we placed (a ring
// with no answer still means the Manual Action was worked).
const calledSince = (events, contactId, at) => {
  const from = ms(at) ?? 0;
  return (events || []).some((e) => e?.contactId === contactId && (ms(e.at) ?? 0) >= from
    && (callEventConnected(e) || (e.type === "call_attempt" && e.data?.direction !== "inbound")));
};

/**
 * runGhlCalls({ store, locationId, client, saved, deps, mode, now, dryRun, trigger })
 *   → { mode, dryRun, picked, queued, skipped, failed, withdrawn, finishedAt, error }
 *
 *   deps.pipelineFor  routes/dashboard.js router.pipelineFor — Today's read
 *   mode              "morning" (the day's list + urgent) | "urgent"
 *   dryRun            reads (GHL contacts included) and lists who would go
 *                     and who would be taken back; writes nothing
 */
export async function runGhlCalls({ store = defaultStore, locationId, client, saved = {}, deps = {}, mode = "morning", now = Date.now(), dryRun = false, trigger = "manual" } = {}) {
  const cfg = normalizeDesk(saved?.desk).ghlCalls;
  const out = { mode, dryRun, trigger, startedAt: iso(now), finishedAt: null, picked: 0, queued: [], skipped: [], failed: [], withdrawn: [], error: null };
  const done = () => { out.finishedAt = iso(Date.now()); return out; };
  if (!dryRun && !ghlCallsOn(cfg)) { out.error = "off: switch it on and paste the GHL workflow link in Settings"; return done(); }
  if (typeof deps.pipelineFor !== "function") throw new Error("runGhlCalls needs deps.pipelineFor");

  const read = await deps.pipelineFor({ locationId, client, now });
  const drafts = read.drafts || [];
  const draftsById = new Map(drafts.filter((d) => d?.id).map((d) => [d.id, d]));
  const day = pacificDay(now);
  if (noPhoneDay !== day) { noPhone.clear(); noPhoneDay = day; }
  const ledger = await store.listContactEventsSince(locationId, iso(now - LEDGER_DAYS * DAY_MS), { types: GHL_CALL_EVENT_TYPES, limit: 2000 }).catch(() => []);
  const live = liveGhlQueues(ledger);
  const claimedToday = new Set(ledger.filter((e) => e?.type === "ghl_call_queued" && e.dedupeKey === ghlCallClaimKey(e.contactId, day)).map((e) => e.contactId));

  /* Taken back: in GHL's queue, its reason gone, and nobody has called since. */
  // Only off a whole read: with no timeline at all, every call would look gone.
  const due = ghlCallsDue([...(read.shownActions || []), ...(read.shownCalls || [])], { drafts });
  const wholeRead = (read.events || []).length > 0;
  for (const [contactId, q] of wholeRead ? live : []) {
    if (due.has(contactId) || calledSince(read.events, contactId, q.at)) continue;
    if (out.withdrawn.length >= MAX_WITHDRAW_PER_RUN) break;
    const row = { contactId, kind: q.kind, queuedAt: q.at };
    if (dryRun) { out.withdrawn.push({ ...row, status: "would take back" }); continue; }
    try {
      await removeContactFromWorkflow(client, contactId, q.workflowId || cfg.workflowId);
    } catch (e) {
      if (!gone(e)) {
        await recordError(store, { locationId, area: "ghl-calls", err: e, context: { contactId, kind: q.kind, stage: "withdraw" } });
        out.failed.push({ ...row, stage: "withdraw", error: scrubMessage(e).slice(0, 160) });
        continue;
      }
    }
    await recordEvent({ store, locationId, contactId, type: "ghl_call_withdrawn", at: iso(now), source: "sweep",
      dedupeKey: `ghl_call_withdrawn:${q.claimKey}`, data: { claimKey: q.claimKey, kind: q.kind, why: "the call's row is gone from Today and nobody called" } });
    out.withdrawn.push({ ...row, status: "taken back" });
  }

  /* Put in: the Desk's calls not yet in GHL today. */
  const picks = ghlCallRows(read.deskAll?.rows || read.desk?.rows || [], { mode, drafts });
  out.picked = picks.length;
  let fields = null;
  for (const p of picks) {
    const r = p.reason;
    const row = { contactId: p.contactId, kind: r.kind, urgent: p.urgent, offerId: r.offerId || null, address: r.address || "" };
    const skip = (why) => out.skipped.push({ ...row, why });
    if (claimedToday.has(p.contactId)) { skip(live.has(p.contactId) ? "already in GHL today" : "tried earlier today (it failed, or was taken back) — on Today until tomorrow"); continue; }
    if (noPhone.has(`${locationId}|${p.contactId}`)) { skip("no phone in GHL — stays on Today"); continue; }
    let contact = null;
    try { contact = await getContact(client, p.contactId); } catch (e) { skip(`couldn't read the contact (${scrubMessage(e).slice(0, 80)})`); continue; }
    if (!String(contact?.phone || "").trim()) { noPhone.add(`${locationId}|${p.contactId}`); skip("no phone in GHL — stays on Today"); continue; }
    const draft = r.kind === "draft_waiting" ? draftsById.get(r.draftId) : null;
    const { why, say } = callFields(r, { draft });
    if (dryRun) { out.queued.push({ ...row, why, say, status: "would go to GHL" }); continue; }

    // Claim first. A second tick, broker or hand run finds the key taken.
    const claimKey = ghlCallClaimKey(p.contactId, day);
    const claim = await recordEvent({ store, locationId, contactId: p.contactId, party: draft?.party || null, type: "ghl_call_queued", at: iso(now), source: "sweep",
      address: row.address, offerId: row.offerId, dedupeKey: claimKey,
      data: { kind: r.kind, why, opener: say, offerId: row.offerId, address: row.address, mode, trigger, workflowId: cfg.workflowId } });
    if (!claim.inserted) { skip("already in GHL today"); continue; }
    try {
      fields = fields || await fieldIds({ store, locationId, client });
      // Still in the workflow from an earlier day (the Manual Action was
      // never worked, or worked without a call): out first, so GHL holds
      // one action for them, with today's words.
      const prior = live.get(p.contactId);
      if (prior && prior.claimKey !== claimKey) await removeContactFromWorkflow(client, p.contactId, prior.workflowId || cfg.workflowId).catch(() => null);
      await updateContact(client, p.contactId, { customFields: [{ id: fields.why, value: why }, { id: fields.say, value: say }] });
      await addContactToWorkflow(client, p.contactId, cfg.workflowId);
      out.queued.push({ ...row, why, say, status: "in GHL" });
    } catch (e) {
      const error = scrubMessage(e).slice(0, 160);
      await recordError(store, { locationId, area: "ghl-calls", err: e, context: { contactId: p.contactId, kind: r.kind, stage: "queue" } });
      await recordEvent({ store, locationId, contactId: p.contactId, type: "ghl_call_failed", at: iso(now), source: "sweep",
        dedupeKey: `ghl_call_failed:${claimKey}`, data: { claimKey, kind: r.kind, failed: true, error } });
      out.failed.push({ ...row, stage: "queue", error });
      // Field ids from an earlier run may be stale (a field deleted in GHL): look them up again next time.
      if (fields?.cached) { await patchCursor(store, locationId, { fields: null }); fields = null; }
    }
  }
  return done();
}
