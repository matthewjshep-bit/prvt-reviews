// investor-read.js — the runner behind "In their words" on Dispositions.
//
// The rules are shared/investor-read.js (pure). This reads an investor's whole
// thread out of GHL (investor-thread.js), asks the model once what they said
// about how they buy, keeps only the quotes found word for word in their own
// messages, and stores the read on `investor_reads`. Nothing is sent and the
// buy box the deals go out on (the contact record) is not touched: "Add to buy
// box" on the page is a person's press.
//
// Who is read: investors in the book who ever wrote back or spoke on the phone
// (a thread of only our texts has nothing to read), whose thread moved past
// their last read. A thread with nothing in their words is stored as an empty
// read without a model call, so it isn't asked about again until it moves.
//
// Nightly (dispoAutopilot.reads, off by default): after the 4am book sync,
// which is what tells us whose thread moved. Gated like investor-sync.js —
// cursor written before the run, a stale run retried, the night's tries
// capped — and `maxPerRun` bounds the model calls one night can make.

import Anthropic from "@anthropic-ai/sdk";
import { store as defaultStore } from "./store.js";
import { readInvestorThread as defaultReadThread } from "./investor-thread.js";
import { READ_SYSTEM, READ_SCHEMA, readPrompt, normalizeRead, hasTheirWords, readIsStale } from "./shared/investor-read.js";
import { ENRICH_MODEL } from "./enrich.js";
import { anthropicErrorToHttp } from "./rehab-scan.js";
import { meterAi } from "./ai-spend.js";
import { workHour } from "./outreach-sweep.js";
import { recordError } from "./app-errors.js";

export const CURSOR_NAME = "investorReads";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const RETRY_WINDOW_HOURS = 4;
export const RETRY_GAP_MS = 20 * 60 * 1000;
export const MAX_DAILY_TRIES = 3;
export const STALE_RUN_MS = 60 * 60 * 1000;
export const READ_MODEL = ENRICH_MODEL; // the extraction model the enrichment sweep already uses
const iso = (ms) => new Date(ms).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeInvestorReads(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const hour = Math.round(Number(o.hour));
  const max = Math.round(Number(o.maxPerRun));
  return {
    enabled: o.enabled === true,
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 5,
    maxPerRun: Number.isFinite(max) && max > 0 ? Math.min(1000, max) : 150,
  };
}
export const investorReadSettings = (saved = {}) => normalizeInvestorReads(saved?.dispoAutopilot?.reads);

/* ---------- the one model call ---------- */

export async function readWithModel({ thread, name, aiApiKey }) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 300_000 });
  let response;
  try {
    response = await client.messages.create({
      model: READ_MODEL,
      max_tokens: 12000,
      thinking: { type: "adaptive" },
      system: READ_SYSTEM,
      output_config: { format: { type: "json_schema", schema: READ_SCHEMA } },
      messages: [{ role: "user", content: readPrompt(thread, { name }) }],
    });
    meterAi("investor_read", response, { model: READ_MODEL });
  } catch (e) {
    throw anthropicErrorToHttp(e);
  }
  if (response.stop_reason === "max_tokens") throw Object.assign(new Error("the read was cut off"), { http: 502 });
  if (response.stop_reason === "refusal") throw Object.assign(new Error("the read was declined"), { http: 502 });
  return JSON.parse(response.content.find((b) => b.type === "text")?.text || "{}");
}

/**
 * readInvestor({ client, locationId, contactId, name, store, saved, deps, now })
 *   → { contactId, status: "read" | "empty", read }
 *
 * deps.readThread replaces the GHL read and deps.read the model call (tests).
 */
export async function readInvestor({ client, locationId, contactId, name = "", store = defaultStore, saved = {}, deps = {}, now = Date.now() }) {
  const thread = await (deps.readThread || ((c, l, id) => defaultReadThread(c, l, id)))(client, locationId, contactId);
  const at = iso(now);
  if (!hasTheirWords(thread)) {
    const read = normalizeRead({}, thread, { by: "empty", at });
    await store.upsertInvestorRead(locationId, contactId, read);
    return { contactId, status: "empty", read };
  }
  const aiApiKey = String(saved.aiApiKey || "").trim();
  if (!deps.read && !aiApiKey) throw Object.assign(new Error("no AI key in settings"), { http: 400 });
  const raw = await (deps.read || readWithModel)({ thread, name, aiApiKey });
  const read = normalizeRead(raw, thread, { by: `model:${READ_MODEL}`, at });
  await store.upsertInvestorRead(locationId, contactId, read);
  return { contactId, status: "read", read };
}

// Who has ever written back or talked: what the book sync counted.
const hasTalked = (row) => {
  const t = row?.doc?.talk || {};
  return Number(t.replies) > 0 || Number(t.calls) > 0 || Boolean(row?.doc?.lastRepliedAt);
};

/**
 * planReads({ store, locationId, contactIds, limit }) → [{ contactId, name, why }]
 *
 * contactIds given: those, read again whatever their state. Otherwise every
 * investor who has talked and whose read is missing or behind their thread,
 * the most recently active first.
 */
export async function planReads({ store = defaultStore, locationId, contactIds = null, limit = 0 }) {
  const book = await store.listInvestors(locationId);
  const reads = new Map((await store.listInvestorReads(locationId)).map((r) => [r.contactId, r]));
  let picked;
  if (Array.isArray(contactIds) && contactIds.length) {
    const want = new Set(contactIds.map(String));
    picked = book.filter((r) => want.has(r.contactId)).map((r) => ({ row: r, why: "asked" }));
  } else {
    picked = book
      .filter((r) => r.status !== "archived" && hasTalked(r))
      .map((r) => {
        const read = reads.get(r.contactId);
        return { row: r, why: !read ? "never_read" : readIsStale({ through: read.doc?.through || read.throughAt }, r.doc?.lastMessageAt) ? "moved" : null };
      })
      .filter((x) => x.why)
      .sort((a, b) => String(b.row.doc?.lastMessageAt || "").localeCompare(String(a.row.doc?.lastMessageAt || "")));
  }
  if (limit > 0) picked = picked.slice(0, limit);
  return picked.map(({ row, why }) => ({ contactId: row.contactId, name: row.name || "", why }));
}

/* ---------- a run ---------- */

const jobs = new Map();
export const getReadJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }
export const publicReadJob = (job) => (job ? { ...job, failures: (job.failures || []).slice(0, 20) } : null);

/**
 * startInvestorReads({ client, locationId, store, saved, deps, contactIds, limit, dryRun, trigger, pace, now }) → job
 *
 * In the background; GET /api/dispo/reads/status reads the job. A dry run
 * plans and reports, reading nothing. A thread that fails is recorded on the
 * job (contact id and status only) and the run goes on.
 */
export function startInvestorReads({ client, locationId, store = defaultStore, saved = {}, deps = {}, contactIds = null, limit = 0, dryRun = false, trigger = "manual", pace = 300, now = Date.now() }) {
  if (jobs.get(locationId)?.status === "running") throw Object.assign(new Error("a read is already going"), { http: 409 });
  const job = { id: `ir-${Date.now().toString(36)}`, locationId, trigger, dryRun, status: "running", startedAt: iso(now), finishedAt: null, planned: 0, read: 0, empty: 0, failed: 0, failures: [], why: {}, error: null };
  jobs.set(locationId, job);
  const finish = async (patch) => {
    Object.assign(job, patch, { finishedAt: new Date().toISOString() });
    if (trigger !== "daily") return;
    const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
    const { run: _run, ...doc } = cursor?.doc || {};
    const last = { id: job.id, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, planned: job.planned, read: job.read, empty: job.empty, failed: job.failed, error: job.error };
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: cursor?.at || iso(now), doc: { ...doc, last, failed: job.status === "error" } }).catch(() => {});
  };
  (async () => {
    const plan = await planReads({ store, locationId, contactIds, limit });
    job.planned = plan.length;
    for (const p of plan) job.why[p.why] = (job.why[p.why] || 0) + 1;
    if (dryRun) return finish({ status: "done" });
    for (const p of plan) {
      try {
        const r = await readInvestor({ client, locationId, contactId: p.contactId, name: p.name, store, saved, deps });
        if (r.status === "empty") job.empty++; else job.read++;
      } catch (e) {
        job.failed++;
        job.failures.push({ contactId: p.contactId, status: e?.status || e?.http || null });
        // No key, or the model refusing every call: stop rather than burn the list.
        if (e?.http === 400 || e?.status === 401) throw e;
      }
      if (pace) await wait(pace);
    }
    await finish({ status: "done" });
  })().catch(async (e) => {
    await recordError(store, { locationId, area: "investor-read", err: e });
    await finish({ status: "error", error: String(e?.message || e).slice(0, 300) });
  });
  return job;
}

/**
 * maybeRunInvestorReads({ client, locationId, saved, store, deps, now }) → boolean
 *
 * Off the 15-minute tick, in its Pacific hour (5am, after the 4am book sync).
 */
export async function maybeRunInvestorReads({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() }) {
  const s = investorReadSettings(saved);
  if (!s.enabled) return false;
  if (!deps.read && !String(saved.aiApiKey || "").trim()) return false;
  const h = workHour(now);
  if (h < s.hour || h >= s.hour + RETRY_WINDOW_HOURS) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const doc = cursor?.doc || {};
  const dailyAt = doc.lastDaily ? Date.parse(doc.lastDaily) : null;
  const ranToday = dailyAt != null && now - dailyAt < MIN_GAP_MS;
  const stale = doc.run?.startedAt && now - Date.parse(doc.run.startedAt) > STALE_RUN_MS;
  let tries = 1;
  if (ranToday) {
    const triedSoFar = Number(doc.tries) || 1;
    if (!(doc.failed || stale) || triedSoFar >= MAX_DAILY_TRIES || now - dailyAt < RETRY_GAP_MS) return false;
    tries = triedSoFar + 1;
  } else if (h !== s.hour) {
    return false;
  }
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { tries, lastDaily: iso(now), run: { startedAt: iso(now) }, last: doc.last || null } }).catch(() => {});
  startInvestorReads({ client, locationId, store, saved, deps, limit: s.maxPerRun, trigger: "daily", now });
  return true;
}
