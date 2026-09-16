// conversation-audit.js — the nightly sweep of the day's threads.
//
// The analysis is shared/conversation-audit.js (pure). This is the runner:
// read the store, ask GHL one cached question, apply each finding's remedy
// through the SAME door the daytime uses — startReply / startProactive →
// gates → the dial → the 30-second scheduler at the next open minute — under
// a claim-first dedupe key, and leave the result where a restart can't lose
// it (the outreach sweep's cursor pattern: `run` while going, `last` when
// over, a stale run retried). Nothing texts at night; whatever it starts
// lands next morning. Matt, 2026-09-16.

import { store as defaultStore } from "./store.js";
import { auditConversations, auditDedupeKey, AUDIT_EVENT_TYPES } from "./shared/conversation-audit.js";
import { buildPipeline } from "./shared/pipeline.js";
import { conversationConfig, startReply as defaultStartReply } from "./reply-agent.js";
import { startFollowUpSweep as defaultStartFollowUpSweep } from "./follow-up-sweep.js";
import { recordEvent } from "./contact-record.js";
import { workHour } from "./outreach-sweep.js";
import { nextSendTime } from "./conversation-scheduler.js";
import { startProactive as defaultStartProactive } from "./reply-agent.js";
import { sweepHeldUnderwrites } from "./held-underwrites.js";

export const CURSOR_NAME = "conversationAudit";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const RETRY_WINDOW_HOURS = 3;          // the evening: hour..hour+3 Pacific
export const RETRY_GAP_MS = 20 * 60 * 1000;
export const MAX_DAILY_TRIES = 4;
export const STALE_RUN_MS = 30 * 60 * 1000;
export const EVENTS_DAYS = 45;
export const PACE_MS = 150;
const iso = (ms) => new Date(ms).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// iMessage/Android reactions as GHL relays them: an emoji or a verb, then
// the quoted text. Nothing to answer.
export const isReaction = (body) => /^\s*(?:[\u{1F44D}\u{1F44E}\u{2764}\u{1F602}\u{203C}\u{2753}\u{1F60D}\u{1F64F}]\uFE0F?|Liked|Loved|Laughed at|Emphasized|Disliked|Questioned)\s*(?:to\s*)?[“"']/u.test(String(body || "").replace(/[\u200B\uFEFF]/g, ""));

const jobs = new Map();
export const getAuditJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }
export function publicAuditJob(job) { return job ? { ...job } : null; }

/**
 * runConversationAudit({ client, locationId, saved, store, sendsEnabled, deps, now, dryRun, job })
 *   → { result, acted: [{ contactId, kind, action, status, reason, jobId }] }
 *
 * `deps` are the offers router's conversationDeps (ghlLastMessages,
 * latestInbound, queueOfferSend, requoteFromAgentNumbers, …) plus, for
 * tests, `startReply` and `startFollowUpSweep`. A dry run analyses and
 * writes nothing. With the bot switched off the audit still reports —
 * findings are findings — but starts nothing.
 */
export async function runConversationAudit({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now(), dryRun = false, job = null, pace = PACE_MS }) {
  const config = conversationConfig(saved);
  const phase = (p) => { if (job) job.phase = p; };

  phase("reading");
  const since48 = iso(now - 48 * 3600000);
  const [recent, open, events, offers, fuCursor] = await Promise.all([
    store.listReplyDrafts(locationId, { since: since48, limit: 2000 }).catch(() => []),
    store.listReplyDrafts(locationId, { status: ["draft", "scheduled", "handled"], limit: 1000 }).catch(() => []),
    store.listContactEventsSince(locationId, iso(now - EVENTS_DAYS * 86400000), { types: AUDIT_EVENT_TYPES, limit: 5000 }).catch(() => []),
    store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []),
    store.getJobCursor?.(locationId, "followUp").catch(() => null),
  ]);
  const byId = new Map();
  for (const d of [...recent, ...open]) if (d?.id) byId.set(d.id, d);
  const drafts = [...byId.values()];
  let pipelineActions = [];
  try { pipelineActions = buildPipeline({ offers, drafts: open, events, jobs: [], config, contactNames: {}, now }).actions || []; } catch { /* counted only */ }

  // The one GHL read: who spoke last, per conversation. Cached ten minutes
  // in the offers router; a failure just means "no row at all" can't be seen
  // tonight, and the result says so.
  let ghlLast = null;
  if (typeof deps.ghlLastMessages === "function") ghlLast = await deps.ghlLastMessages().catch(() => null);

  phase("auditing");
  const result = auditConversations({ drafts, events, offers, ghlLast, pipelineActions, followUpCursorAt: fuCursor?.at || null, config, now });

  const acted = [];
  const may = !dryRun && config.enabled;
  // Loose: what the audit starts may send a holding reply the guard passed
  // even when its intent is a person's call (releaseForAudit in reply-agent.js).
  const loose = config.nightlyAudit?.loose !== false;
  const runDeps = { ...deps, releaseHeld: loose };

  // The held underwrites, same pass: dropped, closed out, re-run on the
  // agent's numbers, or asked about (held-underwrites.js). Its findings ride
  // on the same result so the card and the queue read one list.
  phase("held underwrites");
  try {
    const h = await sweepHeldUnderwrites({ client, locationId, saved, store, sendsEnabled, deps: runDeps, now, dryRun: !may, pace });
    result.findings.push(...h.findings);
    result.counts.held = h.counts;
    result.counts.queued += h.findings.filter((f) => f.action && ["ask_take", "rerun_held"].includes(f.action.type)).length;
    result.counts.owed += h.counts.yours;
    for (const k of ["held_rerun", "held_ask", "held_yours", "held_over", "held_junk"]) result.counts.byKind[k] = h.findings.filter((f) => f.kind === k).length;
    acted.push(...h.acted);
  } catch (e) {
    result.counts.held = { error: String(e?.message || e).slice(0, 160) };
  }
  if (!may) return { result, acted, reason: dryRun ? "dry run" : "Conversation AI is switched off — reported, nothing started" };

  phase("acting");
  const startReply = typeof deps.startReply === "function" ? deps.startReply : defaultStartReply;
  const startSweep = typeof deps.startFollowUpSweep === "function" ? deps.startFollowUpSweep : defaultStartFollowUpSweep;
  const startProactive = typeof deps.startProactive === "function" ? deps.startProactive : defaultStartProactive;
  const offerFor = async (f) => (f.offerId && typeof store.getOffer === "function" ? store.getOffer(f.offerId).catch(() => null) : null);
  const claim = async (f, type, extra = {}) => recordEvent({
    store, locationId, contactId: f.contactId, party: f.party || "agent", type, at: iso(now),
    address: f.address || "", offerId: f.offerId || null, source: "sweep", ...extra,
  }).catch(() => ({ inserted: false }));

  for (const f of result.findings) {
    if (!f.action) continue;
    const row = { contactId: f.contactId, contactName: f.contactName, address: f.address, kind: f.kind, action: f.action.type, status: "started", reason: "", jobId: null };
    acted.push(row);
    try {
      const a = f.action;
      if (a.type === "book_checkin") {
        // Same key format as the reply agent's own clock (4c‴), so the two
        // can never both set one for the same day.
        const c = await claim(f, "checkin_requested", {
          dedupeKey: `checkin_requested:${a.kind}:${f.contactId}:${String(a.dueAt).slice(0, 10)}`,
          data: { kind: a.kind, phrase: "", dueAt: a.dueAt, draftId: a.draftId || f.draftId || null, by: "audit" },
        });
        row.status = c.inserted ? "clocked" : "already";
        continue;
      }
      if (a.type === "release") {
        // The held reply itself, scheduled at the next open minute. The
        // scheduler's own checks (a person answered since, sends off) still
        // apply at send time.
        const d = await store.getReplyDraft(a.draftId).catch(() => null);
        if (!d || d.status !== "draft") { row.status = "skipped"; row.reason = d ? `the draft is ${d.status}` : "draft gone"; continue; }
        const ts = iso(now);
        const sendAt = nextSendTime({ now, delayMs: 60000, quietHours: config.autoSend.quietHours });
        await store.updateReplyDraft(d.id, { ...d, status: "scheduled", sendAt, scheduledAt: ts, updatedAt: ts,
          autoSend: { decided: true, reason: "released by the nightly audit — a holding reply, nothing committed" },
          flags: [...(d.flags || []), "released by the nightly audit"] });
        row.status = "queued"; row.reason = `sends ${sendAt.slice(11, 16)}Z`;
        continue;
      }
      if (a.type === "close_chase") {
        const c = await claim(f, "address_pending_closed", {
          dedupeKey: `address_pending_closed:${f.contactId}:${a.pendingAt}:exhausted`, data: { reason: "exhausted", by: "audit" },
        });
        row.status = c.inserted ? "closed" : "already";
        continue;
      }
      // Everything that ends in a text is claimed first, so a second audit
      // the same night — or the morning sweep — starts nothing twice.
      const c = await claim(f, "audit_action", { dedupeKey: auditDedupeKey(f), data: { kind: f.kind, action: a.type, why: f.why } });
      if (!c.inserted) { row.status = "claimed"; continue; }
      if (a.type === "redraft") {
        const latest = typeof deps.latestInbound === "function" ? await deps.latestInbound(f.contactId) : null;
        if (!latest?.body) { row.status = "skipped"; row.reason = "no inbound text to answer"; continue; }
        // A tapback ("👍 to 'Sounds good…'") is them closing the thread, not
        // asking anything — two of seven on the first dry run, 2026-09-16.
        if (isReaction(latest.body)) { row.status = "skipped"; row.reason = "a reaction, not a text"; continue; }
        const r = await startReply({
          client, locationId, saved, store, contactId: f.contactId, message: String(latest.body).slice(0, 4000),
          channel: /email/i.test(latest.type || "") ? "email" : "sms", attachments: latest.attachments, sendsEnabled, deps: runDeps,
        });
        if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; } else row.jobId = r?.job?.id || null;
      } else if (a.type === "queue_offer_send") {
        if (typeof deps.queueOfferSend !== "function") { row.status = "skipped"; row.reason = "offer sends are not wired"; continue; }
        await deps.queueOfferSend({ offerId: f.offerId, reason: "the agent said the number works and nothing went (nightly audit)" });
        row.status = "queued";
      } else if (a.type === "requote") {
        if (typeof deps.requoteFromAgentNumbers !== "function") { row.status = "skipped"; row.reason = "re-quoting is not wired"; continue; }
        const r = await deps.requoteFromAgentNumbers({ contactId: f.contactId, addressHint: f.address });
        if (r?.ok === false) {
          // Nothing to re-run on after all (their take predates our last
          // price — Mike Renard, 2026-09-16): keep it alive the other way.
          row.reason = r.reason || "re-quote declined";
          const offer = await offerFor(f);
          if (offer && loose) {
            const n = await startProactive({ client, locationId, saved, store, contactId: f.contactId, kind: "counter_nudge", offer, subject: { address: f.address }, sendsEnabled, deps: runDeps });
            if (n?.skipped) { row.status = "skipped"; row.reason += `; nudge: ${n.skipped}`; } else { row.action = "nudge_counter"; row.jobId = n?.job?.id || null; }
          } else row.status = "skipped";
        }
      } else if (a.type === "nudge_counter" || a.type === "nudge_offer") {
        const offer = await offerFor(f);
        if (!offer) { row.status = "skipped"; row.reason = "offer gone"; continue; }
        const kind = a.type === "nudge_counter" ? "counter_nudge" : "offer_nudge";
        const r = await startProactive({ client, locationId, saved, store, contactId: f.contactId, kind, offer, subject: { address: f.address }, sendsEnabled, deps: runDeps });
        if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; } else row.jobId = r?.job?.id || null;
      } else if (a.type === "run_follow_up_sweep") {
        try {
          const j = startSweep({ client, locationId, saved, store, sendsEnabled, deps: runDeps, trigger: "audit", now });
          row.jobId = j?.id || null;
        } catch (e) { row.status = "skipped"; row.reason = String(e?.message || e).slice(0, 120); }
      } else {
        row.status = "skipped"; row.reason = `no remedy wired for ${a.type}`;
      }
    } catch (e) {
      row.status = "error"; row.reason = String(e?.message || e).slice(0, 160);
    }
    if (pace > 0) await wait(pace);
  }
  return { result, acted, reason: "" };
}

/**
 * startConversationAudit({ client, locationId, saved, store, sendsEnabled, deps, trigger, dryRun, now }) → job
 *
 * The outreach sweep's pattern verbatim: one job per location, the run on
 * the cursor while it goes, the summary there when it's over.
 */
export function startConversationAudit({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, trigger = "manual", dryRun = false, now = Date.now(), pace = PACE_MS }) {
  const existing = jobs.get(locationId);
  if (existing?.status === "running") throw Object.assign(new Error("a conversation audit is already running for this location"), { http: 409 });
  const job = { id: `ca-${Date.now().toString(36)}`, locationId, trigger, dryRun, status: "running", phase: "reading", startedAt: iso(now), finishedAt: null, counts: null, findings: [], acted: [], error: null };
  jobs.set(locationId, job);
  const stamp = async (patch) => {
    const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: cur?.at || iso(now), doc: { ...(cur?.doc || {}), ...patch } }).catch(() => {});
  };
  const summary = () => ({
    id: job.id, trigger, dryRun, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt,
    counts: job.counts, ghlRead: job.ghlRead ?? null, findings: job.findings.slice(0, 150), acted: job.acted.slice(0, 150),
    quietWins: (job.quietWins || []).slice(0, 100), error: job.error, reason: job.reason || "",
  });
  stamp({ run: { id: job.id, trigger, startedAt: job.startedAt } })
    .then(() => runConversationAudit({ client, locationId, saved, store, sendsEnabled, deps, now, dryRun, job, pace }))
    .then(async ({ result, acted, reason }) => {
      job.counts = result.counts; job.findings = result.findings; job.acted = acted; job.quietWins = result.quietWins; job.ghlRead = result.ghlRead; job.reason = reason;
      job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
      await stamp({ run: null, last: summary() });
    })
    .catch(async (e) => {
      job.status = "error"; job.phase = ""; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = new Date().toISOString();
      await stamp({ run: null, last: summary(), ...(trigger === "daily" ? { failed: true, error: job.error } : {}) });
    });
  return job;
}

/**
 * maybeRunConversationAudit({ client, locationId, saved, store, sendsEnabled, deps, now }) → boolean
 *
 * The tick's decision: once a day in its Pacific hour (config
 * nightlyAudit.hour, 19 by default — after the promise window closes), a
 * failed or vanished run retried through the evening, never twice a day.
 */
export async function maybeRunConversationAudit({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const config = conversationConfig(saved);
  if (!config.nightlyAudit?.enabled) return false;
  const hour = config.nightlyAudit.hour;
  const h = workHour(now);
  if (h < hour || h >= hour + RETRY_WINDOW_HOURS) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const doc = cursor?.doc || {};
  // The night's run is its own clock (`lastDaily`), not the cursor's `at`:
  // a run by hand at noon — three of them on 2026-09-16 — must not read as
  // "already ran tonight" and skip the 7pm one.
  const dailyAt = doc.lastDaily ? Date.parse(doc.lastDaily) : null;
  const ranToday = dailyAt != null && now - dailyAt < MIN_GAP_MS;
  const stale = doc.run?.startedAt && now - Date.parse(doc.run.startedAt) > STALE_RUN_MS;
  let tries = 1;
  if (ranToday) {
    const triedSoFar = Number(doc.tries) || 1;
    if (!(doc.failed || stale) || triedSoFar >= MAX_DAILY_TRIES || now - dailyAt < RETRY_GAP_MS) return false;
    tries = triedSoFar + 1;
  } else if (h !== hour) {
    return false;
  }
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { tries, lastDaily: iso(now), last: doc.last || null, ...(stale ? { staleRun: doc.run } : {}) } }).catch(() => {});
  startConversationAudit({ client, locationId, saved, store, sendsEnabled, deps, trigger: "daily", now });
  return true;
}
