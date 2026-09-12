// outreach-followup.js — the second text, for agents who never answered the first.
//
// When the daily outreach sweep enrolls new agents straight into a GHL
// workflow (outreachAutopilot.firstTouch "workflow"), GHL does the texting
// and the app never sees an outreach_sent. What it does write is an
// `outreach_enrolled` event (data.kind "first") per contact. This reads those
// back once a day: enrolled at least `followUpDays` ago, nothing heard from
// them since, not already followed up → into `followUpWorkflowId`.
//
// "Nothing heard" is two checks. The record: no text_summary / call_summary
// (and no offer, realm-yes, or deal) after the enrollment. Then GHL itself,
// because the app only records replies the Conversation AI saw: if the
// contact's latest message is inbound, they wrote back and we leave them be.
// Without the conversations scope we can't ask, so we enroll nobody.
//
// Same shape as the other sweeps: rides the broker's 15-minute tick, fires in
// one UTC hour, durable cursor written before the run. The claim is a
// contact event with a fixed dedupe key, written BEFORE the enroll — a crash
// between the two loses one follow-up, which beats texting someone twice.

import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { addContactToWorkflow, getLastMessageDate } from "./ghl.js";
import { normalizeOutreachAutopilot, isWorkday } from "./outreach-sweep.js";

export const CURSOR_NAME = "outreachFollowUp";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const OUTREACH_FOLLOWUP_UTC_HOUR = Number(process.env.OUTREACH_FOLLOWUP_UTC_HOUR || 17); // ≈ 9–10am Pacific
// Longer than the longest followUpDays (90), so the enrollment is still in view.
export const WINDOW_DAYS = 120;
export const MAX_PER_RUN = 100;
const PACE_MS = 150;
const DAY_MS = 86400000;

// Anything after the first enrollment that means this is no longer a cold agent.
const ENDED_BY = new Set(["text_summary", "call_summary", "offer_sent", "realm_yes", "deal_promoted"]);
export const EVENT_TYPES = ["outreach_enrolled", ...ENDED_BY];

const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const followUpDedupeKey = (contactId) => `outreach_enrolled:followup:${contactId}`;

/**
 * followUpCandidates(events, { days, now }) → [{ contactId, enrolledAt, address }]
 *
 * Pure. Oldest enrollment first, so a backlog clears in order.
 */
export function followUpCandidates(events = [], { days, now = Date.now() } = {}) {
  const byContact = new Map();
  for (const e of events) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }
  const out = [];
  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const enrolls = list.filter((e) => e.type === "outreach_enrolled");
    if (enrolls.some((e) => e.data?.kind === "followup")) continue;
    const first = enrolls.find((e) => e.data?.kind !== "followup");
    if (!first) continue;
    if (now - Date.parse(first.at) < days * DAY_MS) continue;
    if (list.some((e) => ENDED_BY.has(e.type) && String(e.at) > String(first.at))) continue;
    out.push({ contactId, enrolledAt: first.at, address: first.address || "" });
  }
  return out.sort((a, b) => String(a.enrolledAt).localeCompare(String(b.enrolledAt)));
}

/* ---------- job registry (in memory, like the other sweeps) ---------- */

const jobs = new Map();
export const getOutreachFollowUpJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }

/**
 * startOutreachFollowUp({ locationId, client, saved, store, trigger, dryRun, now }) → job
 */
export function startOutreachFollowUp({ locationId, client, saved = {}, store = defaultStore, trigger = "manual", dryRun = false, now = Date.now(), paceMs = PACE_MS }) {
  if (jobs.get(locationId)?.status === "running") {
    throw Object.assign(new Error("an outreach follow-up is already running for this location"), { http: 409 });
  }
  const job = {
    id: `of-${Date.now().toString(36)}`, locationId, trigger, dryRun,
    status: "running", startedAt: iso(now), finishedAt: null,
    candidates: 0, enrolled: 0, skipped: 0, warnings: [], results: [], error: null,
  };
  jobs.set(locationId, job);
  run(job, { locationId, client, saved, store, now, paceMs }).catch((e) => {
    job.status = "error";
    job.error = String(e?.message || e).slice(0, 300);
  }).finally(() => { job.finishedAt = new Date().toISOString(); if (job.status === "running") job.status = "done"; });
  return job;
}

async function run(job, { locationId, client, saved, store, now, paceMs }) {
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  if (!oa.followUpWorkflowId) throw new Error("no follow-up workflow picked — pick it in Settings");

  const events = await store.listContactEventsSince(locationId, iso(now - WINDOW_DAYS * DAY_MS), { types: EVENT_TYPES, limit: 5000 });
  const candidates = followUpCandidates(events, { days: oa.followUpDays, now });
  job.candidates = candidates.length;
  if (candidates.length > MAX_PER_RUN) job.warnings.push(`${candidates.length} due — ${MAX_PER_RUN} today, the rest tomorrow`);

  for (const c of candidates.slice(0, MAX_PER_RUN)) {
    const result = { contactId: c.contactId, address: c.address, enrolledAt: c.enrolledAt };
    job.results.push(result);
    if (paceMs) await sleep(paceMs);

    let last;
    try {
      last = await getLastMessageDate(client, locationId, c.contactId);
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) {
        job.warnings.push("the token lacks conversations.readonly — can't tell who replied, so nobody was followed up");
        result.skipped = "no conversations scope"; job.skipped++;
        return;
      }
      result.skipped = `conversation check: ${String(e?.message || e).slice(0, 120)}`; job.skipped++;
      continue;
    }
    if (last?.direction === "inbound") { result.skipped = "they wrote back"; job.skipped++; continue; }
    if (job.dryRun) { result.action = "would enroll"; continue; }

    const claim = await recordEvent({
      store, locationId, contactId: c.contactId, party: "agent", type: "outreach_enrolled", source: "sweep",
      address: c.address, ref: c.contactId, dedupeKey: followUpDedupeKey(c.contactId),
      data: { kind: "followup", workflowId: oa.followUpWorkflowId, firstEnrolledAt: c.enrolledAt },
    });
    if (!claim.inserted) { result.skipped = "already claimed"; job.skipped++; continue; }
    try {
      await addContactToWorkflow(client, c.contactId, oa.followUpWorkflowId);
      result.action = "enrolled"; job.enrolled++;
    } catch (e) {
      result.error = String(e?.message || e).slice(0, 200);
      job.warnings.push(`${c.contactId}: workflow: ${result.error}`);
    }
  }
}

/**
 * maybeStartOutreachFollowUp({ locationId, client, saved, store, utcHour, now }) → boolean
 *
 * The tick's decision. Gates: the hour, the outreach autopilot AND its
 * follow-up switch (the autonomy dial's Off stops this too), a workflow, no
 * run in progress, and the durable cursor at least MIN_GAP_MS old.
 */
export async function maybeStartOutreachFollowUp({ locationId, client, saved = {}, store = defaultStore, utcHour = OUTREACH_FOLLOWUP_UTC_HOUR, now = Date.now(), paceMs }) {
  if (new Date(now).getUTCHours() !== utcHour) return false;
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  if (!oa.enabled || !oa.followUpEnabled || !oa.followUpWorkflowId) return false;
  if (oa.weekdaysOnly && !isWorkday(now)) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  if (cursor?.at && now - Date.parse(cursor.at) < MIN_GAP_MS) return false;
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: {} }).catch(() => {});
  startOutreachFollowUp({ locationId, client, saved, store, trigger: "daily", now, paceMs });
  return true;
}
