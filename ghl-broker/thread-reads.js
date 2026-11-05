// thread-reads.js — the nightly read of every conversation that moved (auto-underwrite v2, 2026-11-04).
//
// The rules are shared/thread-read.js (pure). Each night, while settings.pricingV2.reads is on,
// this finds every GHL conversation that moved since the last run, reads each agent's and
// investor's whole thread (every page, every call transcript — investor-thread.js), asks the model
// once what it says about the houses and the deals, and stores the read on `thread_reads`. What it
// says about each house goes onto that house's record (house_pricing.evidence), beside the offer
// engine's answer, where the scorecard and the calibration read it. Nothing is sent and no offer
// is touched.
//
// The 2026-11-04 backfill (every thread since 7/27, read once) imports through importThreadReads,
// with no model call, so the loop starts with a hundred days behind it.
//
// Gated like every daily job (daily-gate.js), cursor "threadReads". `MAX_PER_RUN` bounds one
// night's model calls. Metered as "thread_read". No names, phones or message text are logged.

import Anthropic from "@anthropic-ai/sdk";
import { store as defaultStore } from "./store.js";
import { readInvestorThread as defaultReadThread } from "./investor-thread.js";
import { searchConversations as ghlSearch } from "./ghl.js";
import { resolveParty } from "./conversation-party.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { hasTheirWords, readIsStale } from "./shared/investor-read.js";
import { AGENT_READ_SCHEMA, INVESTOR_READ_SCHEMA, AGENT_READ_SYSTEM, INVESTOR_READ_SYSTEM, threadReadPrompt, normalizeThreadRead, evidenceRows, mergeEvidence } from "./shared/thread-read.js";
import { normalizePricingV2 } from "./shared/price-engine.js";
import { ENRICH_MODEL } from "./enrich.js";
import { anthropicErrorToHttp } from "./rehab-scan.js";
import { meterAi } from "./ai-spend.js";
import { claimDailyRun, closeDailyRun } from "./daily-gate.js";
import { localHour } from "./promise-sweep.js";
import { recordError } from "./app-errors.js";

export const CURSOR_NAME = "threadReads";
export const READ_MODEL = ENRICH_MODEL;
export const READ_HOUR = 6; // after the 5am investor read
export const MAX_PER_RUN = 150;
const LOOKBACK_MS = 26 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- the one model call ---------- */

export async function readWithModel({ thread, name, party, aiApiKey }) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 300_000 });
  const investor = party === "investor";
  let response;
  try {
    response = await client.messages.create({
      model: READ_MODEL,
      max_tokens: 12000,
      thinking: { type: "adaptive" },
      system: investor ? INVESTOR_READ_SYSTEM : AGENT_READ_SYSTEM,
      output_config: { format: { type: "json_schema", schema: investor ? INVESTOR_READ_SCHEMA : AGENT_READ_SCHEMA } },
      messages: [{ role: "user", content: threadReadPrompt(thread, { party, name }) }],
    });
    meterAi("thread_read", response, { model: READ_MODEL });
  } catch (e) {
    throw anthropicErrorToHttp(e);
  }
  if (response.stop_reason === "max_tokens") throw Object.assign(new Error("the read was cut off"), { http: 502 });
  if (response.stop_reason === "refusal") throw Object.assign(new Error("the read was declined"), { http: 502 });
  return JSON.parse(response.content.find((b) => b.type === "text")?.text || "{}");
}

/** applyEvidence({ store, locationId, contactId, read }) → houses touched. Each house's record keeps one row per contact. */
export async function applyEvidence({ store = defaultStore, locationId, contactId, read }) {
  let n = 0;
  for (const { houseKey, address, row } of evidenceRows(read, { contactId })) {
    const rec = await store.getHousePricing(locationId, houseKey).catch(() => null);
    const doc = rec?.doc || { houseKey, address, firstAt: row.at, reads: null, v2: null, history: [], outcome: null, evidence: [] };
    await store.upsertHousePricing(locationId, houseKey, { ...doc, evidence: mergeEvidence(doc.evidence, row) });
    n++;
  }
  return n;
}

/**
 * readContact({ client, locationId, contactId, party, name, store, saved, deps, now }) → { status, read, houses }
 * deps.readThread replaces the GHL read and deps.read the model call (tests).
 */
export async function readContact({ client, locationId, contactId, party = "agent", name = "", store = defaultStore, saved = {}, deps = {}, now = Date.now() }) {
  const thread = await (deps.readThread || ((c, l, id) => defaultReadThread(c, l, id)))(client, locationId, contactId);
  const at = iso(now);
  if (!hasTheirWords(thread)) {
    const read = normalizeThreadRead({}, thread, { party, by: "empty", at });
    await store.upsertThreadRead(locationId, contactId, read);
    return { status: "empty", read, houses: 0 };
  }
  const aiApiKey = String(saved.aiApiKey || "").trim();
  if (!deps.read && !aiApiKey) throw Object.assign(new Error("no AI key in settings"), { http: 400 });
  const raw = await (deps.read || readWithModel)({ thread, name, party, aiApiKey });
  const read = normalizeThreadRead(raw, thread, { party, by: `model:${READ_MODEL}`, at });
  await store.upsertThreadRead(locationId, contactId, read);
  return { status: "read", read, houses: await applyEvidence({ store, locationId, contactId, read }) };
}

/**
 * planThreadReads({ client, locationId, store, saved, since, deps, limit }) → [{ contactId, party, why }]
 * Every conversation whose last message is after `since`, an agent's or an investor's by the live
 * routing (an untagged contact is read as an agent; the read says who they are), whose read is
 * missing or behind the thread. Newest first.
 */
export async function planThreadReads({ client, locationId, store = defaultStore, saved = {}, since, deps = {}, limit = MAX_PER_RUN }) {
  const search = deps.searchConversations || ghlSearch;
  const routing = normalizeConversationAi(saved?.conversationAi || {}).routing || {};
  const from = Date.parse(since);
  const moved = new Map();
  let after;
  for (let page = 0; page < 60; page++) {
    const r = await search(client, locationId, { limit: 100, ...(after ? { startAfterDate: after } : {}) });
    const cs = r?.conversations || [];
    if (!cs.length) break;
    let done = false;
    for (const c of cs) {
      if (Number(c.lastMessageDate) < from) { done = true; break; }
      if (!c.contactId || moved.has(c.contactId)) continue;
      const p = resolveParty({ tags: c.tags || [], routing });
      moved.set(c.contactId, { contactId: c.contactId, party: p?.party === "investor" ? "investor" : "agent", lastMessageAt: iso(Number(c.lastMessageDate)) });
    }
    if (done) break;
    after = cs.at(-1).sort?.[0] ?? cs.at(-1).lastMessageDate;
  }
  const reads = new Map(((await store.listThreadReads(locationId).catch(() => [])) || []).map((r) => [r.contactId, r]));
  const plan = [];
  for (const m of moved.values()) {
    const read = reads.get(m.contactId);
    const why = !read ? "never_read" : readIsStale({ through: read.throughAt || read.doc?.through }, m.lastMessageAt) ? "moved" : null;
    if (why) plan.push({ ...m, why });
  }
  return limit > 0 ? plan.slice(0, limit) : plan;
}

/* ---------- a run ---------- */

const jobs = new Map();
export const getThreadReadJob = (locationId) => jobs.get(locationId) || null;
export function _resetThreadReadJobs() { jobs.clear(); }

/**
 * startThreadReads({ client, locationId, store, saved, deps, since, limit, dryRun, trigger, pace }) → job
 * In the background; the status route reads the job. A dry run plans and reports, reading nothing.
 */
export function startThreadReads({ client, locationId, store = defaultStore, saved = {}, deps = {}, since = null, limit = MAX_PER_RUN, dryRun = false, trigger = "manual", pace = 300, now = Date.now() }) {
  if (jobs.get(locationId)?.status === "running") throw Object.assign(new Error("a read is already going"), { http: 409 });
  const job = { id: `tr-${Date.now().toString(36)}`, locationId, trigger, dryRun, status: "running", startedAt: iso(now), finishedAt: null, planned: 0, read: 0, empty: 0, failed: 0, houses: 0, failures: [], why: {}, error: null };
  jobs.set(locationId, job);
  const finish = async (patch) => {
    Object.assign(job, patch, { finishedAt: new Date().toISOString() });
    if (trigger === "daily") {
      await closeDailyRun({ store, locationId, cursorName: CURSOR_NAME, failed: job.status === "error", error: job.error,
        last: { id: job.id, status: job.status, planned: job.planned, read: job.read, empty: job.empty, failed: job.failed, houses: job.houses, through: since } });
    }
  };
  (async () => {
    const plan = await planThreadReads({ client, locationId, store, saved, since: since || iso(now - LOOKBACK_MS), deps, limit });
    job.planned = plan.length;
    for (const p of plan) job.why[p.why] = (job.why[p.why] || 0) + 1;
    if (dryRun) return finish({ status: "done" });
    for (const p of plan) {
      try {
        const r = await readContact({ client, locationId, contactId: p.contactId, party: p.party, store, saved, deps });
        if (r.status === "empty") job.empty++; else job.read++;
        job.houses += r.houses || 0;
      } catch (e) {
        job.failed++;
        job.failures.push({ contactId: p.contactId, status: e?.status || e?.http || null });
        if (e?.http === 400 || e?.status === 401) throw e; // no key: stop, don't burn the list
      }
      if (pace) await wait(pace);
    }
    await finish({ status: "done" });
  })().catch(async (e) => {
    await recordError(store, { locationId, area: "thread-read", err: e }).catch(() => {});
    await finish({ status: "error", error: String(e?.message || e).slice(0, 300) });
  });
  return job;
}

/**
 * maybeRunThreadReads({ client, locationId, saved, store, deps, now }) → the job, or null.
 * Off the 15-minute tick, in its Pacific hour, while pricingV2.reads is on. Reads what moved since
 * the last night's run (or the last 26 hours).
 */
export async function maybeRunThreadReads({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() }) {
  if (!normalizePricingV2(saved?.pricingV2).reads) return null;
  if (!deps.read && !String(saved.aiApiKey || "").trim()) return null;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const gate = await claimDailyRun({ store, locationId, cursorName: CURSOR_NAME, now, hourNow: localHour(now), startHour: READ_HOUR, windowHours: 4,
    running: jobs.get(locationId)?.status === "running" });
  if (!gate.go) return null;
  const lastRan = cursor?.doc?.lastDaily ? Date.parse(cursor.doc.lastDaily) : null;
  const since = iso(Math.min(now - LOOKBACK_MS, lastRan && Number.isFinite(lastRan) ? lastRan - 3600000 : now - LOOKBACK_MS));
  return startThreadReads({ client, locationId, store, saved, deps, since, trigger: "daily", now });
}

/**
 * importThreadReads({ store, locationId, rows, by, dryRun, through }) → { imported, houses, skipped, byParty }
 * The 2026-11-04 backfill (the reader brief's rows: { contactId, party, kind, houses | deals, … }).
 * Dry by default: counts what would land.
 */
export async function importThreadReads({ store = defaultStore, locationId, rows = [], by = "import", dryRun = true, through = null, now = Date.now() }) {
  // What the backfill covered: its threads were pulled whole up to `through`, so a thread is read
  // again only once it moves past that (not the first night, all 1,288 of them).
  const covered = through && Number.isFinite(Date.parse(through)) ? iso(Date.parse(through)) : iso(now);
  const out = { imported: 0, houses: 0, skipped: 0, byParty: {} };
  for (const r of Array.isArray(rows) ? rows : []) {
    const contactId = String(r?.contactId || "").trim();
    if (!contactId) { out.skipped++; continue; }
    const party = r.party === "investor" && Array.isArray(r.deals) ? "investor" : "agent";
    const read = normalizeThreadRead({ ...r, through: r.through || covered }, null, { party, by: `import:${String(by).slice(0, 60)}`, at: r.readAt || iso(now) });
    out.byParty[party] = (out.byParty[party] || 0) + 1;
    const rows_ = evidenceRows(read, { contactId });
    out.houses += rows_.length;
    out.imported++;
    if (dryRun) continue;
    await store.upsertThreadRead(locationId, contactId, read);
    await applyEvidence({ store, locationId, contactId, read });
  }
  return out;
}
