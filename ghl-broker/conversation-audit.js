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
import { auditConversations, auditDedupeKey, AUDIT_EVENT_TYPES, HELD_SWEEP_KINDS } from "./shared/conversation-audit.js";
import { buildPipeline } from "./shared/pipeline.js";
import { conversationConfig, startReply as defaultStartReply } from "./reply-agent.js";
import { startFollowUpSweep as defaultStartFollowUpSweep } from "./follow-up-sweep.js";
import { recordEvent } from "./contact-record.js";
import { workHour } from "./outreach-sweep.js";
import { nextSendTime } from "./conversation-scheduler.js";
import { startProactive as defaultStartProactive } from "./reply-agent.js";
import { sweepHeldUnderwrites } from "./held-underwrites.js";
import { liveDealHold } from "./conversation-context.js";
import { threadHealth, STOP_LABEL } from "./shared/thread-health.js";

export const CURSOR_NAME = "conversationAudit";
// The daytime pass keeps its own cursor: `last` on the night's cursor is what
// Today's "From last night" reads, and a noon run must never overwrite it.
export const DAY_CURSOR_NAME = "daytimeDriver";
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
// What the machine starts by itself, as opposed to answering something.
const DRIVING_REMEDIES = new Set(["requote", "nudge_counter", "nudge_offer"]);
const jobKey = (locationId, mode) => (mode === "day" ? `${locationId}|day` : locationId);
export const getAuditJob = (locationId, mode = "night") => jobs.get(jobKey(locationId, mode)) || null;
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
export async function runConversationAudit({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now(), dryRun = false, job = null, pace = PACE_MS, mode = "night" }) {
  const config = conversationConfig(saved);
  // The daytime pass (driver.daytime): the same findings, claims and remedies,
  // with a narrower hand. It never releases a person's call or a reply held
  // for less than releaseMinAgeMin, leaves the follow-up sweep and (unless
  // asked) the held underwrites to the night, and asks the thread's brake
  // before it nudges anybody.
  const day = mode === "day";
  const daytime = config.driver?.daytime || {};
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
  const result = auditConversations({ drafts, events, offers, ghlLast, pipelineActions, followUpCursorAt: fuCursor?.at || null, config, now,
    mode, releaseMinAgeMin: day ? Number(daytime.releaseMinAgeMin) || 120 : 0 });

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
  if (!day || daytime.heldSweep === true) try {
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

  // A redraft the reply agent would only stand down from, or that would answer
  // the wrong words, is Matt's — found out before the claim is spent, and put
  // on his queue rather than "started" night after night (2026-09-16: Christian
  // Simonson, under contract; Tim Tilbury, a photo with no text after an
  // answered text; Julie Leonard, our own email echoed back as inbound).
  const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  const redraftIsYours = async (f, latest) => {
    const hold = await liveDealHold({ store, locationId, contactId: f.contactId, mode: config.routing?.holdOnLiveDeal }).catch(() => null);
    if (hold) return hold.role === "buyer" ? `a buyer on your live deal at ${hold.address} — the bot stays out` : `${hold.address} is under contract with them — the bot stays out`;
    if (!latest?.body) return "";
    if ((Date.parse(latest.at) || 0) < (Date.parse(f.anchorAt) || 0) - 10 * 60000) return "their newest message has no text (a photo or attachment?) — the last one with words was answered";
    const said = norm(latest.body);
    if (said.length > 20 && drafts.some((d) => d.contactId === f.contactId && d.status === "sent" && norm(d.reply) === said)) return "their newest message reads as our own text echoed back — look at it in GHL";
    return "";
  };
  const handToMatt = (f, row, why) => {
    row.status = "yours"; row.reason = why; f.action = null; f.why = why;
    result.counts.owed += 1; result.counts.queued = Math.max(0, result.counts.queued - 1);
  };

  for (const f of result.findings) {
    if (!f.action) continue;
    // The held sweep already carried out its own findings above.
    if (HELD_SWEEP_KINDS.has(f.kind)) continue;
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
          autoSend: { decided: true, reason: `released by the ${day ? "daytime pass" : "nightly audit"} — a holding reply, nothing committed` },
          flags: [...(d.flags || []), `released by the ${day ? "daytime pass" : "nightly audit"}`] });
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
      if (day && a.type === "run_follow_up_sweep") { row.status = "skipped"; row.reason = "the follow-up sweep keeps its own hour"; continue; }
      // By day, anything the machine STARTS asks the brake first: a thread
      // that is annoyed, dead, stopped or a person's is not nudged.
      if (day && DRIVING_REMEDIES.has(a.type)) {
        const health = threadHealth({ offer: offers.find((o) => o.id === f.offerId) || null, drafts: drafts.filter((d) => d.contactId === f.contactId), events: events.filter((e) => e.contactId === f.contactId), now });
        if (!health.drive) { row.status = "stopped"; row.reason = `${health.reason}: ${STOP_LABEL[health.reason] || health.detail}`; continue; }
      }
      let latest = null;
      if (a.type === "redraft") {
        latest = typeof deps.latestInbound === "function" ? await deps.latestInbound(f.contactId).catch(() => null) : null;
        const why = await redraftIsYours(f, latest);
        if (why) { handToMatt(f, row, why); continue; }
      }
      // Everything that ends in a text is claimed first, so a second audit
      // the same night — or the morning sweep — starts nothing twice.
      const c = await claim(f, "audit_action", { dedupeKey: auditDedupeKey(f), data: { kind: f.kind, action: a.type, why: f.why } });
      if (!c.inserted) {
        // Tried on an earlier run and the text is still unanswered: whatever
        // that attempt came to, it wasn't a reply.
        if (a.type === "redraft") handToMatt(f, row, "drafting was tried on an earlier run and nothing came of it");
        else row.status = "claimed";
        continue;
      }
      if (a.type === "redraft") {
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
export function startConversationAudit({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, trigger = "manual", dryRun = false, now = Date.now(), pace = PACE_MS, mode = "night" }) {
  const cursorName = mode === "day" ? DAY_CURSOR_NAME : CURSOR_NAME;
  const existing = jobs.get(jobKey(locationId, mode));
  if (existing?.status === "running") throw Object.assign(new Error("a conversation audit is already running for this location"), { http: 409 });
  const job = { id: `${mode === "day" ? "dd" : "ca"}-${Date.now().toString(36)}`, locationId, mode, trigger, dryRun, status: "running", phase: "reading", startedAt: iso(now), finishedAt: null, counts: null, findings: [], acted: [], error: null };
  jobs.set(jobKey(locationId, mode), job);
  const stamp = async (patch) => {
    const cur = await store.getJobCursor?.(locationId, cursorName).catch(() => null);
    await store.setJobCursor?.(locationId, cursorName, { at: cur?.at || iso(now), doc: { ...(cur?.doc || {}), ...patch } }).catch(() => {});
  };
  const summary = () => ({
    id: job.id, trigger, dryRun, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt,
    counts: job.counts, ghlRead: job.ghlRead ?? null, findings: job.findings.slice(0, 150), acted: job.acted.slice(0, 150),
    quietWins: (job.quietWins || []).slice(0, 100), error: job.error, reason: job.reason || "",
  });
  stamp({ run: { id: job.id, trigger, startedAt: job.startedAt } })
    .then(() => runConversationAudit({ client, locationId, saved, store, sendsEnabled, deps, now, dryRun, job, pace, mode }))
    .then(async ({ result, acted, reason }) => {
      job.counts = result.counts; job.findings = result.findings; job.acted = acted; job.quietWins = result.quietWins; job.ghlRead = result.ghlRead; job.reason = reason;
      job.status = "done"; job.phase = ""; job.finishedAt = new Date().toISOString();
      await stamp({ run: null, last: summary() });
    })
    .catch(async (e) => {
      job.status = "error"; job.phase = ""; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = new Date().toISOString();
      await stamp({ run: null, last: summary(), ...(trigger === "daily" || trigger === "daytime" ? { failed: true, error: job.error } : {}) });
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

/**
 * maybeRunDaytimeDriver({ client, locationId, saved, store, sendsEnabled, deps, now }) → boolean
 *
 * The audit's acting pass by day (driver.daytime, off by default; the dial
 * turns it on at Normal): every `everyHours` between `startHour` and
 * `endHour` Pacific, on its own cursor. The same gating as the night's: the
 * cursor is written before the run, a run that died is retried once it is
 * stale, and the day's tries are capped. Weekends are skipped unless the
 * auto-send setting says machine-started texts may go then, because
 * everything this starts is machine-started.
 */
export async function maybeRunDaytimeDriver({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const config = conversationConfig(saved);
  const dt = config.driver?.daytime;
  if (!config.enabled || !dt?.enabled) return false;
  const h = workHour(now);
  if (h < dt.startHour || h >= dt.endHour) return false;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/Los_Angeles" }).format(new Date(now));
  if ((weekday === "Sat" || weekday === "Sun") && config.autoSend?.weekends !== "all") return false;
  if (jobs.get(jobKey(locationId, "day"))?.status === "running" || jobs.get(jobKey(locationId, "night"))?.status === "running") return false;

  const cursor = await store.getJobCursor?.(locationId, DAY_CURSOR_NAME).catch(() => null);
  const doc = cursor?.doc || {};
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(now));
  const triesToday = doc.day === today ? Number(doc.tries) || 0 : 0;
  const maxTries = Math.ceil((dt.endHour - dt.startHour) / dt.everyHours) + 2;
  if (triesToday >= maxTries) return false;
  const lastRun = doc.lastRun ? Date.parse(doc.lastRun) : null;
  const stale = doc.run?.startedAt && now - Date.parse(doc.run.startedAt) >= STALE_RUN_MS;
  const due = lastRun == null || now - lastRun >= dt.everyHours * 3600000;
  // A run still on the cursor and not yet stale may simply be going (another
  // broker, or this one a minute ago): leave it.
  if (doc.run && !stale) return false;
  if (!due && !(stale || doc.failed)) return false;
  if (!due && now - lastRun < RETRY_GAP_MS) return false;

  await store.setJobCursor?.(locationId, DAY_CURSOR_NAME, { at: iso(now), doc: { day: today, tries: triesToday + 1, lastRun: iso(now), last: doc.last || null, ...(stale ? { staleRun: doc.run } : {}) } }).catch(() => {});
  startConversationAudit({ client, locationId, saved, store, sendsEnabled, deps, trigger: "daytime", now, mode: "day" });
  return true;
}
