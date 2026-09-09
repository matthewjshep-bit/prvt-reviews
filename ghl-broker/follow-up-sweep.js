// follow-up-sweep.js — the clock. Once a day, per location: who did we speak
// to and never hear back from, and is today the day we say something.
//
// It sends nothing itself. Every nudge it decides on goes through
// startProactive, which means it inherits — rather than reimplements — the
// hands-off tags, the live-deal hold, the "a person is in this thread" check,
// the money guard, quiet hours, the per-contact daily cap, the send gate and
// the outbox. The sweep's only job is deciding WHO and WHICH RUNG.
//
// Two things about the concurrency, both load-bearing:
//
//   The claim is a row in contact_events with a unique dedupe key, written
//   BEFORE the draft is started. Two ticks racing, two processes, a redeploy
//   mid-sweep — the second write is a no-op and that candidate is skipped.
//   The failure mode this chooses is "a crash between claim and draft loses
//   one nudge". The other order costs a duplicate text, which is worse.
//
//   The cursor in job_cursors stops a SCAN, not a send. The nightly enrich
//   sweep keeps its equivalent in memory and can therefore re-run after a
//   redeploy; for enrichment that wastes money, and here it would text people.
//   The dedupe key is still the real defence — the cursor just stops us
//   spending model calls on drafts that would be superseded anyway.

import { OPEN_STATUSES, effectiveStatus, isExpired } from "./shared/offer-status.js";
import { dueStep, exhausted, followUpDedupeKey, FOLLOW_UP_KINDS, kindsFor } from "./shared/follow-up.js";
import { recordEvent } from "./contact-record.js";
import { conversationConfig, startProactive } from "./reply-agent.js";

const DAY_MS = 86400000;
// GHL's burst cap is 100 req / 10s per location; the same pace the enrichment
// sweep keeps. Nothing here is in a hurry.
const PACE_MS = 150;
// How far back the investor scan reads. A blast older than this is not a
// follow-up any more, it is a new conversation.
export const INVESTOR_WINDOW_DAYS = 30;
export const CURSOR_NAME = "followUp";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const FOLLOW_UP_UTC_HOUR = Number(process.env.FOLLOW_UP_SWEEP_UTC_HOUR || 16); // ≈ 8–9am Pacific

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();
const parse = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/* ---------- the job registry ---------- */
// In memory, like the enrichment sweep: a restart loses the job list and
// corrupts nothing, because every durable decision is a contact_events row.

const jobs = new Map();   // locationId -> the current or most recent job

export const getFollowUpJob = (locationId) => jobs.get(locationId) || null;
export function cancelFollowUpSweep(locationId) {
  const job = jobs.get(locationId);
  if (!job || job.status !== "running") return false;
  job.cancelRequested = true;
  return true;
}
export function publicFollowUpJob(job) {
  if (!job) return null;
  const { cancelRequested, ...rest } = job;
  return { ...rest, stopping: Boolean(cancelRequested && job.status === "running") };
}
// For tests: the registry is process-wide.
export function _resetJobs() { jobs.clear(); }

/* ---------- finding candidates ---------- */

/**
 * agentCandidates({ store, locationId, config, now }) → [candidate]
 *
 * Open offers whose status hasn't moved since the earliest rung could have
 * come due. One indexed read (listOffersForFollowUp), then the full doc is
 * consulted per row — the status column narrows, it never decides.
 */
export async function agentCandidates({ store, locationId, config, now = Date.now() }) {
  const pb = config?.parties?.agent;
  const ladder = pb?.followUp?.ladders?.offer_nudge;
  if (!pb?.followUp?.enabled || !ladder?.enabled || !ladder.steps?.length) return [];
  const earliest = Math.min(...ladder.steps);
  const rows = await store.listOffersForFollowUp(locationId, {
    statuses: [...OPEN_STATUSES], before: iso(now - earliest * DAY_MS), limit: 200,
  }).catch(() => []);

  const out = [];
  for (const o of rows) {
    if (!o?.contactId || !o.address) continue;
    if (o.deal) continue;                                  // it became a deal; not our business
    if (!OPEN_STATUSES.has(effectiveStatus(o))) continue;  // the mirror was stale
    // An expired offer's follow-up is a re-offer, and that is a person's call.
    if (isExpired(o, new Date(now))) continue;   // isExpired wants a Date, not ms
    // Count from the last time we actually put it in front of them.
    const lastSend = (o.sends || []).filter((s) => s?.ts).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
    const startedAt = lastSend?.ts || o.statusAt || o.createdAt;
    if (!startedAt) continue;
    out.push({
      kind: "offer_nudge", party: "agent", contactId: o.contactId, subjectId: o.id,
      offerId: o.id, address: o.address, startedAt,
      sentSteps: (o.followUps || []).filter((f) => f?.kind === "offer_nudge").map((f) => f.step),
      ladder,
    });
  }
  return out;
}

/**
 * investorCandidates({ store, locationId, config, now }) → [candidate]
 *
 * One location-wide event read, grouped by contact. A blast or a dataroom open
 * with nothing from them since is a candidate; a pass or a commitment ends it.
 * When both apply to the same buyer the dataroom ladder wins — somebody who
 * opened the package is a warmer thing to write to than somebody who didn't.
 */
export async function investorCandidates({ store, locationId, config, now = Date.now() }) {
  const pb = config?.parties?.investor;
  if (!pb?.followUp?.enabled) return [];
  const ladders = pb.followUp.ladders || {};
  const live = kindsFor("investor").filter((k) => ladders[k]?.enabled && ladders[k].steps?.length);
  if (!live.length) return [];

  const since = iso(now - INVESTOR_WINDOW_DAYS * DAY_MS);
  const events = await store.listContactEventsSince(locationId, since, {
    types: ["blast_sent", "dataroom_viewed", "investor_passed", "investor_committed", "investor_evaluating",
            "follow_up_sent", "text_summary", "call_summary"],
    limit: 5000,
  }).catch(() => []);

  const byContact = new Map();
  for (const e of events) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }

  const out = [];
  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    // Anything they said, or any outcome we already have, ends the ladder.
    const lastInboundAt = list.filter((e) => e.type === "text_summary" || e.type === "call_summary").at(-1)?.at || null;
    const settled = list.some((e) => e.type === "investor_passed" || e.type === "investor_committed");
    if (settled) continue;
    const lastTouchAt = list.filter((e) => e.type === "follow_up_sent").at(-1)?.at || null;

    // The trigger: the newest open/blast, dataroom first.
    const trigger = ["dataroom_nudge", "blast_nudge"]
      .filter((k) => live.includes(k))
      .map((kind) => {
        const type = FOLLOW_UP_KINDS[kind].trigger;
        const ev = list.filter((e) => e.type === type).at(-1);
        return ev ? { kind, ev } : null;
      })
      .find(Boolean);
    if (!trigger) continue;

    const { kind, ev } = trigger;
    out.push({
      kind, party: "investor", contactId, subjectId: ev.offerId || ev.address || contactId,
      offerId: ev.offerId || null, address: ev.address || "", startedAt: ev.at,
      sentSteps: list.filter((e) => e.type === "follow_up_sent" && e.data?.kind === kind).map((e) => Number(e.data?.step)),
      lastInboundAt, lastTouchAt,
      ...(kind === "dataroom_nudge" ? { viewedAt: ev.at } : { blastedAt: ev.at }),
      ladder: ladders[kind],
    });
  }
  return out;
}

/* ---------- the sweep ---------- */

/**
 * startFollowUpSweep({ client, locationId, saved, store, sendsEnabled, now, deps, trigger })
 *   → job
 *
 * Returns synchronously; the work runs on its own. `deps.startProactive` and
 * `deps.setOfferStatus` are injected so the whole thing is exercisable offline.
 */
export function startFollowUpSweep({ client, locationId, saved, store, sendsEnabled = false, now = Date.now(), deps = {}, trigger = "manual", dryRun = false }) {
  const existing = jobs.get(locationId);
  if (existing?.status === "running") {
    throw Object.assign(new Error("a follow-up sweep is already running for this location"), { http: 409 });
  }
  const job = {
    id: `fu-${Date.now().toString(36)}`, locationId, trigger, dryRun,
    status: "running", phase: "collecting",
    startedAt: iso(now), finishedAt: null,
    considered: 0, due: 0, started: 0, skipped: 0, exhaustedCount: 0, errors: 0,
    results: [], error: null, cancelRequested: false,
  };
  jobs.set(locationId, job);
  runSweep(job, { client, locationId, saved, store, sendsEnabled, now, deps }).catch((e) => {
    job.status = "error";
    job.error = String(e?.message || e).slice(0, 300);
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

async function runSweep(job, ctx) {
  const { client, locationId, saved, store, sendsEnabled, now, deps } = ctx;
  const config = conversationConfig(saved);
  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;
  // Injectable so a test suite isn't paced at GHL's rate limit.
  const pace = Number.isFinite(deps.paceMs) ? deps.paceMs : PACE_MS;

  const push = (row) => {
    job.results.push(row);
    if (job.results.length > 200) job.results.shift();
  };

  const candidates = [
    ...(await agentCandidates({ store, locationId, config, now })),
    ...(await investorCandidates({ store, locationId, config, now })),
  ];
  job.considered = candidates.length;
  job.phase = "nudging";

  // How many nudges this contact has already had this week, so one person
  // working several of our properties doesn't get a text a day.
  const weekCount = new Map();

  for (const c of candidates) {
    if (job.cancelRequested) break;
    const pb = config.parties[c.party];
    const fu = pb.followUp;

    // An agent candidate's inbound isn't on the event stream — a draft row
    // exists for every inbound, so one indexed read answers it.
    let lastInboundAt = c.lastInboundAt ?? null;
    let lastTouchAt = c.lastTouchAt ?? null;
    if (c.party === "agent") {
      try {
        const rows = await store.listReplyDrafts(locationId, { contactId: c.contactId, limit: 20 });
        lastInboundAt = rows.filter((d) => d.inbound).map((d) => d.createdAt).sort().at(-1) || null;
        lastTouchAt = rows.filter((d) => d.outbound?.kind && d.status === "sent").map((d) => d.updatedAt || d.createdAt).sort().at(-1) || null;
      } catch { /* no drafts to read is not a reason to skip a nudge */ }
    }

    const d = dueStep({
      steps: c.ladder.steps, startedAt: c.startedAt, sentSteps: c.sentSteps,
      lastInboundAt, lastTouchAt, now,
      stopOnAnyInbound: fu.stopOnAnyInbound, minHoursBetween: fu.minHoursBetween,
    });

    if (!d.due) {
      // The ladder is over. Write down what the silence meant — but only when
      // we actually said something into it. A ladder that only ever produced
      // drafts nobody sent proves nothing about the agent.
      if (c.kind === "offer_nudge" && c.ladder.onExhausted === "mark_no_response" && c.sentSteps.length
          && exhausted({ steps: c.ladder.steps, sentSteps: c.sentSteps, startedAt: c.startedAt, now })) {
        if (!job.dryRun && typeof deps.setOfferStatus === "function") {
          const r = await deps.setOfferStatus({
            contactId: c.contactId, addressHint: c.address, status: "no_response",
            note: `no reply after ${c.sentSteps.length} follow-up${c.sentSteps.length === 1 ? "" : "s"}`,
          }).catch((e) => ({ ok: false, reason: e.message }));
          if (r?.ok) job.exhaustedCount++;
          push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "exhausted", reason: r?.ok ? "marked no response" : r?.reason });
        } else {
          job.exhaustedCount++;
          push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "exhausted", reason: "would mark no response" });
        }
        continue;
      }
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "skipped", reason: d.reason });
      continue;
    }

    job.due++;
    const already = weekCount.get(c.contactId) || 0;
    if (already >= fu.maxPerContactPerWeek) {
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, status: "skipped", reason: "they've had enough from us this week" });
      continue;
    }

    if (job.dryRun) {
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "would send" });
      continue;
    }

    // Claim first. See the header: the unique dedupe key is the whole
    // concurrency story, and a lost race must cost a nudge, never a duplicate.
    const claim = await recordEvent({
      store, locationId, contactId: c.contactId, party: c.party, type: "follow_up_sent",
      at: iso(now), address: c.address, offerId: c.offerId, source: "conversation",
      ref: `${c.kind}:${c.subjectId}:${d.step}`,
      dedupeKey: followUpDedupeKey({ kind: c.kind, subjectId: c.subjectId, step: d.step }),
      data: { kind: c.kind, step: d.step, dayOffset: d.dayOffset, ladder: c.ladder.steps },
    });
    if (!claim.inserted) {
      job.skipped++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "skipped", reason: "already claimed" });
      continue;
    }

    try {
      const offer = c.offerId ? await store.getOffer(c.offerId).catch(() => null) : null;
      const r = await start({
        client, locationId, saved, store, contactId: c.contactId, kind: c.kind,
        offer: c.kind === "offer_nudge" ? offer : null,
        subject: { address: c.address, step: d.step, steps: c.ladder.steps,
                   viewedAt: c.viewedAt || null, blastedAt: c.blastedAt || null, lastTouchAt },
        sendsEnabled, deps,
      });
      if (r?.skipped) {
        job.skipped++;
        push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "skipped", reason: r.skipped });
      } else {
        job.started++;
        weekCount.set(c.contactId, already + 1);
        // The offer remembers its own rungs so History can show them without
        // reading the timeline. The event is still the authority.
        if (c.kind === "offer_nudge" && c.offerId) {
          const full = await store.getOffer(c.offerId).catch(() => null);
          if (full) {
            full.followUps = [...(full.followUps || []), { kind: c.kind, step: d.step, at: iso(now), jobId: r?.job?.id || null }];
            await store.updateOffer(full.id, full).catch(() => {});
          }
        }
        push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "started", jobId: r?.job?.id || null });
      }
    } catch (e) {
      // One contact's failure is not the sweep's. A credential that would fail
      // identically for everyone is marked fatal by its thrower and rethrown.
      if (e?.fatal) throw e;
      job.errors++;
      push({ contactId: c.contactId, address: c.address, kind: c.kind, step: d.step, status: "error", reason: String(e?.message || e).slice(0, 160) });
    }
    if (pace > 0) await sleep(pace);
  }

  job.status = job.cancelRequested ? "canceled" : "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
}

/**
 * maybeStartFollowUpSweep({ client, locationId, saved, store, sendsEnabled, utcHour, now })
 *   → boolean
 *
 * Called from the broker's 15-minute tick. Four gates and a durable cursor —
 * the cursor is written BEFORE the sweep runs, so a crash mid-sweep does not
 * re-spend model calls the same hour.
 */
export async function maybeStartFollowUpSweep({ client, locationId, saved, store, sendsEnabled = false, utcHour = FOLLOW_UP_UTC_HOUR, now = Date.now(), deps = {} }) {
  if (new Date(now).getUTCHours() !== utcHour) return false;
  if (!String(saved?.aiApiKey || "").trim()) return false;
  const config = conversationConfig(saved);
  if (!config.enabled) return false;
  const anyLadder = ["agent", "investor"].some((p) => {
    const fu = config.parties[p]?.followUp;
    return fu?.enabled && Object.values(fu.ladders || {}).some((l) => l.enabled && l.steps?.length);
  });
  if (!anyLadder) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  if (cursor?.at && now - Date.parse(cursor.at) < MIN_GAP_MS) return false;
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: {} }).catch(() => {});
  startFollowUpSweep({ client, locationId, saved, store, sendsEnabled, now, deps, trigger: "daily" });
  return true;
}
