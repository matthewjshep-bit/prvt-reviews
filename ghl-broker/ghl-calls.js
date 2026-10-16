// ghl-calls.js — Today's calls into GHL's Manual Actions queue.
//
// Matt dials from his computer in GHL's Manual Actions, not from Today
// (2026-10-15). GHL's API can't create a Manual Action — only a workflow step
// can — so Matt keeps one workflow ("App: call today") with a single Manual
// call step. GHL's newer Manual call step has no instructions box (Matt,
// 2026-10-16), so what the call is for and what to say go on a contact note,
// which GHL shows beside the call; the two contact fields
// (contact.app_call_why / contact.app_call_say) carry the same words. GHL
// records the call on the contact, call-intake reads it, and the Desk's call
// row clears itself.
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
import { getContact, updateContact, createContactNote, addContactToWorkflow, removeContactFromWorkflow, findOrCreateCustomFieldByKey } from "./ghl.js";
import { normalizeDesk } from "./shared/call-list.js";
import { ghlCallRows, ghlCallsDue } from "./shared/desk.js";
import { callFields, ghlCallsOn, ghlCallWindow, GHL_CALL_FIELDS, GHL_CALL_EVENT_TYPES, liveGhlQueues, ghlCallClaimKey } from "./shared/ghl-calls.js";
import { callEventConnected } from "./shared/talked-to.js";
import { isWorkday } from "./outreach-sweep.js";

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
      // The note Matt reads beside the Manual Action. Best-effort: a note
      // that doesn't land never takes the call back out.
      const noted = await createContactNote(client, p.contactId, { body: ghlCallNote({ why, say }) }).then(() => true).catch(() => false);
      out.queued.push({ ...row, why, say, status: "in GHL", ...(noted ? {} : { note: "the note didn't save" }) });
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

/** ghlCallNote({ why, say }) → the contact note Matt reads beside the Manual Action. */
export const ghlCallNote = ({ why = "", say = "" } = {}) =>
  ["App call today", `Why: ${String(why).trim()}`, say ? `Say: ${String(say).trim()}` : ""].filter(Boolean).join("\n");

/* ---------- the tick: the day's list at 8:30, the urgent ones until 5pm ---------- */

// The morning's gating is the nightly audit's (conversation-audit.js
// maybeRunConversationAudit): the cursor is written before the run, a run
// that died under a deploy is retried once it's stale, and the day's tries
// are capped. The day is the Pacific date, so a morning that only got going
// late is still the day's one.
export const MAX_MORNING_TRIES = 4;
export const RETRY_GAP_MS = 20 * 60 * 1000;
export const STALE_RUN_MS = 30 * 60 * 1000;

const jobs = new Map();
const pending = new Map();
export const getGhlCallsJob = (locationId) => jobs.get(locationId) || null;
/** For tests and the hand run: the location's run in flight, settled. */
export const ghlCallsSettled = (locationId) => pending.get(locationId) || Promise.resolve();
export function _resetGhlCalls() { jobs.clear(); pending.clear(); noPhone.clear(); }

const pacificHours = (t) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return (Number(p.hour) % 24) + Number(p.minute) / 60;
};

// What a run did, for the cursor and the route: who, not what was said.
export const summarizeRun = (job) => ({
  id: job.id, mode: job.mode, trigger: job.trigger, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error || null,
  picked: job.result?.picked ?? 0,
  queued: (job.result?.queued || []).map((q) => ({ contactId: q.contactId, kind: q.kind, status: q.status })),
  skipped: (job.result?.skipped || []).map((q) => ({ contactId: q.contactId, kind: q.kind, why: q.why })),
  failed: (job.result?.failed || []).map((q) => ({ contactId: q.contactId, kind: q.kind, stage: q.stage, error: q.error })),
  withdrawn: (job.result?.withdrawn || []).map((q) => ({ contactId: q.contactId, kind: q.kind, status: q.status })),
});

/**
 * startGhlCalls({ store, locationId, client, saved, deps, mode, trigger, dryRun, now, onDone }) → job
 *
 * One run per location at a time, in the background; `onDone(job)` when it ends.
 */
export function startGhlCalls({ store = defaultStore, locationId, client, saved = {}, deps = {}, mode = "morning", trigger = "manual", dryRun = false, now = Date.now(), onDone = null }) {
  if (jobs.get(locationId)?.status === "running") throw Object.assign(new Error("GHL calls are already running for this location"), { http: 409 });
  const job = { id: `gc-${Date.now().toString(36)}`, locationId, mode, trigger, dryRun, status: "running", startedAt: iso(now), finishedAt: null, result: null, error: null };
  jobs.set(locationId, job);
  const p = runGhlCalls({ store, locationId, client, saved, deps, mode, now, dryRun, trigger })
    .then((r) => { job.result = r; job.status = "done"; })
    .catch((e) => { job.status = "error"; job.error = scrubMessage(e).slice(0, 300); })
    .then(async () => {
      job.finishedAt = iso(Date.now());
      if (job.status === "error") await recordError(store, { locationId, area: "ghl-calls", err: job.error, context: { trigger, stage: mode } });
      if (typeof onDone === "function") await Promise.resolve(onDone(job)).catch(() => {});
    })
    .finally(() => { if (pending.get(locationId) === p) pending.delete(locationId); });
  pending.set(locationId, p);
  return job;
}

/**
 * maybeRunGhlCalls({ client, locationId, saved, store, deps, now }) → { mode } | null
 *
 * Off the 15-minute tick. Only with desk.ghlCalls on and a workflow, on a
 * workday (unless weekdaysOnly is off), from hour:minute Pacific until
 * `until`: the first tick of the day sends the day's list ("morning"), and
 * every tick after it the urgent ones ("urgent").
 */
export async function maybeRunGhlCalls({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() }) {
  const cfg = normalizeDesk(saved?.desk).ghlCalls;
  if (!ghlCallsOn(cfg)) return null;
  if (cfg.weekdaysOnly && !isWorkday(now)) return null;
  const { start, end } = ghlCallWindow(cfg);
  const h = pacificHours(now);
  if (h < start || h >= end) return null;
  if (jobs.get(locationId)?.status === "running") return null;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const doc = cursor?.doc || {};
  const today = pacificDay(now);
  const triesToday = doc.day === today ? Number(doc.tries) || 0 : 0;
  const stale = Boolean(doc.run?.startedAt) && now - Date.parse(doc.run.startedAt) > STALE_RUN_MS;
  let mode = "urgent";
  if (doc.day !== today) mode = "morning";
  // A morning the cursor says is going, and not yet stale: going (here or on another broker).
  else if (doc.run?.startedAt && !stale) return null;
  else if ((doc.failed || stale) && triesToday < MAX_MORNING_TRIES && now - (Date.parse(doc.lastDaily || "") || 0) >= RETRY_GAP_MS) mode = "morning";
  if (mode === "morning") {
    await patchCursor(store, locationId, { day: today, tries: triesToday + 1, lastDaily: iso(now), run: { startedAt: iso(now) }, failed: false, error: null, ...(stale ? { staleRun: doc.run } : {}) });
    startGhlCalls({ store, locationId, client, saved, deps, mode, trigger: "daily", now,
      onDone: (job) => patchCursor(store, locationId, { run: null, failed: job.status === "error", error: job.error || null, last: summarizeRun(job) }) });
  } else {
    // A morning that died and is out of tries still clears its run, so the day goes on.
    if (doc.run?.startedAt && stale) await patchCursor(store, locationId, { run: null, failed: true, error: doc.error || "the morning's run died" });
    startGhlCalls({ store, locationId, client, saved, deps, mode, trigger: "urgent", now,
      onDone: (job) => patchCursor(store, locationId, { urgent: { at: job.finishedAt, last: summarizeRun(job) } }) });
  }
  return { mode };
}

