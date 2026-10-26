// gatekeeper-sweep.js — the gatekeeper line's day (Matt, 2026-10-26).
//
// Once a weekday morning, when outreachAutopilot.gatekeepers is on:
//   1. read the probate notice alert email (when a sender is set);
//   2. import the day's best new gatekeepers to GHL (dailyNew), the ones we
//      can reach, through routes/gatekeepers.js — dry while `dryRun`;
//   3. for each one in GHL, the step that's due (shared/gatekeeper-sequence
//      .js): the first email, the text that follows it, a check-in when
//      there's something new. Each is claimed with an event, written by the
//      model about this person alone, checked for anything that reads like a
//      machine (written once more if so), and left as a draft for Matt —
//      it schedules itself only when `autoSend` is on and sends are live.
//
// The gating is the conversation audit's: the cursor is written before the
// run, a run that died is retried once stale, and the day's tries are
// capped. Results carry counts and keys, never a name.

import Anthropic from "@anthropic-ai/sdk";
import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { getContact, emailUnsubscribed, smsUnsubscribed } from "./ghl.js";
import { callDraftModel, conversationConfig, REPLY_MODEL } from "./reply-agent.js";
import { meterAi } from "./ai-spend.js";
import { spreadAcrossDay, machineHours } from "./conversation-scheduler.js";
import { workHour, isWorkday } from "./outreach-sweep.js";
import { readNoticeEmails } from "./gatekeeper-feed.js";
import { normalizeGatekeepers, rankGatekeepers, bestHook, GATEKEEPER_KIND_LABEL } from "./shared/gatekeeper.js";
import { nextStep, gatekeeperPrompt, draftFlags, DRAFT_SCHEMA, SEQUENCE_EVENT_TYPES, GATEKEEPER_EVENTS } from "./shared/gatekeeper-sequence.js";

export const CURSOR_NAME = "gatekeepers";
export const SWEEP_HOUR = 9;               // Pacific; before the agent sweep's own hour
const RETRY_WINDOW_HOURS = 6;
const MIN_GAP_MS = 20 * 3600000;
const STALE_RUN_MS = 45 * 60000;
const RETRY_GAP_MS = 20 * 60000;
const MAX_DAILY_TRIES = 4;
export const MAX_STEPS_PER_RUN = 60;
const STEP_KIND = { email: "gatekeeper_email", text: "gatekeeper_text", checkin: "gatekeeper_checkin" };

const iso = (t) => new Date(t).toISOString();
const jobs = new Map();
export const getGatekeeperJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }

const parseJson = (response) => {
  const text = (response?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  try { return JSON.parse(text); } catch { return null; }
};

/**
 * writeGatekeeperDraft({ aiApiKey, step, gk, hook, priorHook, saved, examples }) → { subject, body, flags }
 *
 * The model writes it from the facts alone (shared/gatekeeper-sequence.js
 * gatekeeperPrompt). A draft that gives itself away is written once more
 * with what gave it away named; the second one stands, flags and all.
 */
export async function writeGatekeeperDraft({ aiApiKey, step, gk, hook, priorHook = null, saved = {}, examples = [], model = REPLY_MODEL }) {
  const company = saved?.company || {};
  const p = gatekeeperPrompt({ step, gk, hook, priorHook, signer: company.signer || "Matt Shepherd", company: company.name || "", phone: company.phone || "", examples });
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 120_000 });
  const ask = async (extra = "") => {
    const { response } = await callDraftModel(client, {
      model, max_tokens: 2000, thinking: { type: "adaptive" },
      system: [{ type: "text", text: p.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      output_config: { effort: "low", format: { type: "json_schema", schema: DRAFT_SCHEMA } },
      messages: [{ role: "user", content: [{ type: "text", text: p.user + extra }] }],
    });
    meterAi("gatekeeper_draft", response, { model });
    const j = parseJson(response) || {};
    return { subject: String(j.subject || "").trim(), body: String(j.body || "").trim() };
  };
  let d = await ask();
  let flags = draftFlags({ step, ...d, gk, hook });
  if (flags.length) {
    d = await ask(`\n\nYour last draft had: ${flags.join(", ")}. Write it again without them.`);
    flags = draftFlags({ step, ...d, gk, hook });
  }
  return { ...d, flags };
}

const flatHook = (h) => ({ ...h.doc, hookKey: h.hookKey, gkKey: h.gkKey, kind: h.kind, firstSeen: h.firstSeen });

/**
 * runGatekeeperSweep({ client, locationId, saved, store, sendsEnabled, deps, now, dryRun }) → summary
 *
 * deps: { importGatekeepers, write, getContact, gmail, houseLookups } — the
 * import (routes/gatekeepers.js), the model and GHL, injectable for tests.
 */
export async function runGatekeeperSweep({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now(), dryRun = null }) {
  const g = normalizeGatekeepers(saved?.outreachAutopilot?.gatekeepers);
  dryRun = dryRun ?? g.dryRun;
  const out = { dryRun, mail: null, imported: null, steps: { drafted: 0, scheduled: 0, would: 0, skipped: 0 }, rows: [] };

  // 1. The notice alert email.
  if (g.noticeEmailFrom) out.mail = await readNoticeEmails({ store, locationId, settings: saved, deps }).catch((e) => ({ error: e.message }));

  // 2. The day's new ones: reachable, of a kind that's on, best first.
  if (g.dailyNew > 0 && typeof deps.importGatekeepers === "function") {
    const [rows, hooks] = await Promise.all([store.listGatekeepers(locationId, { status: "new" }), store.listGatekeeperHooks(locationId)]);
    const pick = rankGatekeepers(rows.map((r) => ({ ...r.doc, gkKey: r.gkKey, kind: r.kind })), hooks.map(flatHook), { now })
      .filter((x) => g.kinds[x.kind] && (x.email || x.phone))
      .slice(0, g.dailyNew)
      .map((x) => x.gkKey);
    out.imported = pick.length
      ? await deps.importGatekeepers({ locationId, client, gkKeys: pick, dryRun }).then((r) => ({ dryRun: r.dryRun, created: r.created, updated: r.updated, failed: r.results.filter((x) => !x.ok).length }))
        .catch((e) => ({ error: e.message }))
      : { picked: 0 };
  }

  // 3. The sequence, for everyone already in GHL.
  const aiApiKey = String(saved?.aiApiKey || "").trim();
  const write = deps.write || ((args) => writeGatekeeperDraft({ aiApiKey, saved, examples: g.voiceExamples, ...args }));
  const read = deps.getContact || ((id) => getContact(client, id));
  const config = conversationConfig(saved);
  const schedule = !dryRun && g.autoSend && sendsEnabled && config.enabled;
  const imported = await store.listGatekeepers(locationId, { status: "imported" });
  const allHooks = (await store.listGatekeeperHooks(locationId)).map(flatHook);
  let started = 0;
  for (const row of imported) {
    if (started >= MAX_STEPS_PER_RUN) break;
    if (!row.contactId || !g.kinds[row.kind]) continue;
    const gk = { ...row.doc, kind: row.kind, gkKey: row.gkKey };
    const hooks = allHooks.filter((h) => h.gkKey === row.gkKey);
    const events = await store.listContactEvents(locationId, row.contactId, { types: SEQUENCE_EVENT_TYPES, limit: 200 }).catch(() => null);
    if (!events) { out.steps.skipped++; out.rows.push({ gkKey: row.gkKey, skipped: "couldn't read their timeline" }); continue; }
    const contact = await read(row.contactId).catch(() => null);
    if (!contact) { out.steps.skipped++; out.rows.push({ gkKey: row.gkKey, skipped: "couldn't read the contact in GHL" }); continue; }
    const hasEmail = Boolean(String(contact.email || "").trim()) && !emailUnsubscribed(contact);
    const hasPhone = Boolean(String(contact.phone || "").trim()) && !smsUnsubscribed(contact);
    const next = nextStep({ events, hooks, settings: g, hasEmail, hasPhone, now });
    if (!next.step) { out.rows.push({ gkKey: row.gkKey, waiting: next.stop || next.why }); continue; }
    const hook = next.hook || bestHook(hooks);
    if (dryRun) { out.steps.would++; out.rows.push({ gkKey: row.gkKey, would: next.step, hookKey: hook?.hookKey || null }); continue; }

    const ts = iso(now);
    const claimed = await recordEvent({ store, locationId, contactId: row.contactId, party: "gatekeeper", type: GATEKEEPER_EVENTS.queued, at: ts,
      address: hook?.house?.address || hook?.address || "", source: "gatekeeper", ref: `gatekeeper:${row.gkKey}`,
      dedupeKey: `gatekeeper:${row.contactId}:${next.step}:${hook?.hookKey || "none"}`,
      data: { step: next.step, hookKey: hook?.hookKey || null, why: next.why } });
    if (!claimed?.inserted) { out.steps.skipped++; out.rows.push({ gkKey: row.gkKey, skipped: "already claimed" }); continue; }
    started++;

    let d;
    try {
      const prior = next.step === "checkin" ? bestHook(hooks.filter((h) => h.hookKey !== hook?.hookKey)) : null;
      d = await write({ step: next.step, gk, hook, priorHook: prior });
    } catch (e) {
      out.steps.skipped++;
      out.rows.push({ gkKey: row.gkKey, step: next.step, error: `writing: ${String(e?.message || e).slice(0, 120)}` });
      continue;
    }
    if (!d?.body) { out.steps.skipped++; out.rows.push({ gkKey: row.gkKey, step: next.step, error: "the model wrote nothing" }); continue; }

    const flagged = (d.flags || []).length > 0;
    const goes = schedule && !flagged;
    const channel = next.step === "text" ? "sms" : "email";
    const sendAt = goes ? spreadAcrossDay({ now, quietHours: machineHours(config.autoSend || {}), hours: 6, weekends: "none" }) : null;
    const name = gk.name || gk.firm || "";
    const record = await store.createReplyDraft({
      locationId, contactId: row.contactId, contactName: name, status: goes ? "scheduled" : "draft", channel, jobId: null,
      inbound: "", outbound: { kind: STEP_KIND[next.step], step: next.step, hookKey: hook?.hookKey || null, gkKey: row.gkKey,
        address: hook?.house?.address || hook?.address || "", ...(channel === "email" ? { subject: d.subject } : {}) },
      reply: d.body, intent: STEP_KIND[next.step], confidence: "high", needsHuman: flagged, humanReason: flagged ? `reads like a machine: ${d.flags.join(", ")}` : "",
      summary: `${GATEKEEPER_KIND_LABEL[row.kind] || "Gatekeeper"} · ${next.step}${hook ? ` · ${hook.kind === "estate" ? `Estate of ${hook.decedent || hook.caseNo}` : hook.address || ""}` : ""}`,
      propertyAddress: hook?.house?.address || hook?.address || "", counterAmount: null, autoSendable: !flagged, flags: (d.flags || []).map((f) => `reads like a machine: ${f}`),
      party: "gatekeeper", partySource: "gatekeeper", matchedTags: { agent: [], investor: [] }, contextSummary: {}, offersInContext: 0,
      autoSend: { decided: goes, reason: goes ? "" : flagged ? "it waits for you: it reads like a machine" : !g.autoSend ? "gatekeeper notes wait for you (Autopilot → Gatekeepers)" : !sendsEnabled ? "sends are off on the broker (CARD_SENDS_ENABLED)" : "Conversation AI is switched off" },
      humanActive: null, actions: [], supersededIds: [], warnings: [], noteOnAutoSend: false, promptVersion: 1,
      ...(goes ? { sendAt, scheduledAt: ts } : {}), updatedAt: ts,
    });
    if (goes) out.steps.scheduled++; else out.steps.drafted++;
    out.rows.push({ gkKey: row.gkKey, step: next.step, draftId: record?.id || null, status: goes ? "scheduled" : "draft", flags: d.flags || [] });
  }
  return out;
}

/** startGatekeeperSweep(...) → job: runs in the background, the cursor says how it went. */
export function startGatekeeperSweep({ client, locationId, saved, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now(), dryRun = null, trigger = "daily" }) {
  const job = { id: `gk-${now.toString(36)}`, trigger, status: "running", startedAt: iso(now), finishedAt: null, result: null, error: null };
  jobs.set(locationId, job);
  const stamp = async (patch) => {
    const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: cur?.at || iso(now), doc: { ...(cur?.doc || {}), ...patch } }).catch(() => {});
  };
  const summary = () => ({ id: job.id, trigger, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
    ...(job.result ? { dryRun: job.result.dryRun, mail: job.result.mail, imported: job.result.imported, steps: job.result.steps } : {}) });
  job.done = stamp({ run: { id: job.id, trigger, startedAt: job.startedAt } })
    .then(() => runGatekeeperSweep({ client, locationId, saved, store, sendsEnabled, deps, now, dryRun }))
    .then(async (result) => {
      job.result = result; job.status = "done"; job.finishedAt = iso(Date.now());
      console.log(`gatekeepers: ${result.steps.drafted} drafted, ${result.steps.scheduled} scheduled, ${result.steps.would} would, imported ${JSON.stringify(result.imported)}`);
      await stamp({ run: null, last: summary() });
    })
    .catch(async (e) => {
      job.status = "error"; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = iso(Date.now());
      await stamp({ run: null, last: summary(), ...(trigger === "daily" ? { failed: true, error: job.error } : {}) });
    });
  return job;
}

/**
 * maybeRunGatekeeperSweep({ client, locationId, saved, store, sendsEnabled, deps, now }) → boolean
 *
 * Weekdays at SWEEP_HOUR Pacific, once; a failed or vanished run retried
 * through the morning, MAX_DAILY_TRIES at most. Off unless
 * outreachAutopilot.gatekeepers.enabled.
 */
export async function maybeRunGatekeeperSweep({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const g = normalizeGatekeepers(saved?.outreachAutopilot?.gatekeepers);
  if (!g.enabled) return false;
  if (!isWorkday(now)) return false;
  const h = workHour(now);
  if (h < SWEEP_HOUR || h >= SWEEP_HOUR + RETRY_WINDOW_HOURS) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const doc = (await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null))?.doc || {};
  const dailyAt = doc.lastDaily ? Date.parse(doc.lastDaily) : null;
  const ranToday = dailyAt != null && now - dailyAt < MIN_GAP_MS;
  const stale = doc.run?.startedAt && now - Date.parse(doc.run.startedAt) > STALE_RUN_MS;
  let tries = 1;
  if (ranToday) {
    const triedSoFar = Number(doc.tries) || 1;
    if (!(doc.failed || stale) || triedSoFar >= MAX_DAILY_TRIES || now - dailyAt < RETRY_GAP_MS) return false;
    tries = triedSoFar + 1;
  } else if (h !== SWEEP_HOUR) {
    return false;
  }
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { tries, lastDaily: iso(now), last: doc.last || null, ...(stale ? { staleRun: doc.run } : {}) } }).catch(() => {});
  startGatekeeperSweep({ client, locationId, saved, store, sendsEnabled, deps, now, trigger: "daily" });
  return true;
}
