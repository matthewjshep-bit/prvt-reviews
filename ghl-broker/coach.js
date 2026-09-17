// coach.js — the nightly coach's runner. The thinking is in shared/coach.js.
//
// An hour after the conversation audit, read what a person did with the
// day's drafts, ask the model once what the bot should learn from it, screen
// the answer, and leave the survivors on Today. It sends nothing, changes no
// setting and spends one model call — or none, on a day nobody edited,
// dismissed or broke anything.
//
// Apply / Reject / Revert / File are here too, because they are the only
// things that ever act on a proposal and each is a person's press.

import Anthropic from "@anthropic-ai/sdk";
import { store as defaultStore } from "./store.js";
import {
  gatherSignals, screenProposals, buildCoachContext, applyProposal, revertProposal, coachScorecard, issueFor,
  COACH_SYSTEM, COACH_SCHEMA, SCORECARD,
} from "./shared/coach.js";
import { draftStats } from "./shared/conversation-ai.js";
import { GRADUATION } from "./shared/graduation.js";
import { conversationConfig, saveConversationConfig, previewConversation } from "./reply-agent.js";
import { anthropicErrorToHttp } from "./rehab-scan.js";
import { workHour } from "./outreach-sweep.js";
import { CURSOR_NAME as AUDIT_CURSOR } from "./conversation-audit.js";
import { recordError } from "./app-errors.js";

export const CURSOR_NAME = "coach";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const RETRY_WINDOW_HOURS = 3;
export const RETRY_GAP_MS = 20 * 60 * 1000;
export const MAX_DAILY_TRIES = 3;
export const STALE_RUN_MS = 20 * 60 * 1000;
const LOOKBACK_MAX_MS = 72 * 3600 * 1000;      // a missed night is caught up; a missed week is not re-read
const iso = (ms) => new Date(ms).toISOString();

const jobs = new Map();
export const _resetJobs = () => jobs.clear();
export const getJob = (locationId) => jobs.get(locationId) || null;

/* ---------- the one model call ---------- */

export async function proposeWithModel({ signals, config, aiApiKey }) {
  const client = new Anthropic({ apiKey: aiApiKey, timeout: 180_000 });
  let response;
  try {
    response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 6000,
      thinking: { type: "adaptive" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: COACH_SYSTEM }],
      output_config: { effort: "high", format: { type: "json_schema", schema: COACH_SCHEMA } },
      messages: [{ role: "user", content: [{ type: "text", text: buildCoachContext({ signals, config }) }] }],
    });
  } catch (e) {
    throw anthropicErrorToHttp(e);
  }
  if (response.stop_reason === "max_tokens") throw Object.assign(new Error("the coach's answer was truncated"), { http: 502 });
  if (response.stop_reason === "refusal") throw Object.assign(new Error("the coach's answer was declined"), { http: 502 });
  const p = JSON.parse(response.content.find((b) => b.type === "text")?.text || "{}");
  return { summary: String(p.summary || "").trim().slice(0, 600), proposals: Array.isArray(p.proposals) ? p.proposals : [] };
}

/* ---------- a run ---------- */

/**
 * runCoach({ locationId, saved, store, deps, since, now, dryRun }) → result
 *
 * deps.propose replaces the model call in tests. A dry run screens and
 * reports but keeps nothing.
 */
export async function runCoach({ locationId, saved = {}, store = defaultStore, deps = {}, since = null, now = Date.now(), dryRun = false }) {
  const config = conversationConfig(saved);
  const from = Math.max(since ? Date.parse(since) || 0 : 0, now - LOOKBACK_MAX_MS) || now - 24 * 3600 * 1000;
  const windowFrom = iso(now - GRADUATION.windowDays * 86400000);
  const [recent, auditCursor, errors, existing, promiseEvents] = await Promise.all([
    store.listReplyDrafts(locationId, { since: windowFrom, limit: 2000 }).catch(() => []),
    store.getJobCursor?.(locationId, AUDIT_CURSOR).catch(() => null),
    store.listAppErrorsSince?.(locationId, iso(from)).catch(() => []) || [],
    store.listCoachProposals?.(locationId, { since: iso(now - 120 * 86400000), limit: 500 }).catch(() => []) || [],
    store.listContactEventsSince?.(locationId, iso(from), { types: ["promise_kept"], limit: 500 }).catch(() => []) || [],
  ]);
  const signals = gatherSignals({ drafts: recent, audit: auditCursor?.doc?.last || null, stats: draftStats(recent), errors, promiseEvents, since: iso(from), now });
  const out = { since: signals.since, until: signals.until, counts: signals.counts, summary: "", proposed: 0, kept: [], dropped: [], skipped: "", dryRun };
  if (signals.empty) return { ...out, skipped: "nothing to learn from — nobody edited, dismissed or broke anything" };

  const aiApiKey = String(saved.aiApiKey || "").trim();
  if (!deps.propose && !aiApiKey) throw Object.assign(new Error("no AI key in settings"), { http: 400 });
  const answer = await (deps.propose || proposeWithModel)({ signals, config, aiApiKey });
  const screened = screenProposals(answer.proposals, { config, knownIds: signals.knownIds, existing, now });
  out.summary = answer.summary || ""; out.proposed = (answer.proposals || []).length; out.dropped = screened.dropped;

  for (const p of screened.kept) {
    const row = { ...p, locationId, status: "open", runAt: iso(now) };
    out.kept.push(dryRun ? row : await store.createCoachProposal(row));
  }
  return out;
}

export function startCoach({ locationId, saved = {}, store = defaultStore, deps = {}, trigger = "manual", dryRun = false, now = Date.now() }) {
  if (jobs.get(locationId)?.status === "running") throw Object.assign(new Error("the coach is already running for this location"), { http: 409 });
  const job = { id: `co-${Date.now().toString(36)}`, locationId, trigger, dryRun, status: "running", startedAt: iso(now), finishedAt: null, result: null, error: null };
  jobs.set(locationId, job);
  const stamp = async (patch) => {
    const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: cur?.at || iso(now), doc: { ...(cur?.doc || {}), ...patch } }).catch(() => {});
  };
  // What Today shows of the run: counts and the model's summary. The proposals
  // themselves live in coach_proposals; a dry run's are carried here instead.
  const summary = () => ({
    id: job.id, trigger, dryRun, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
    ...(job.result ? { since: job.result.since, counts: job.result.counts, summary: job.result.summary, proposed: job.result.proposed, kept: job.result.kept.length, dropped: job.result.dropped, skipped: job.result.skipped, ...(dryRun ? { preview: job.result.kept } : {}) } : {}),
  });
  job.done = (async () => {
    try {
      const cur = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
      await stamp({ run: { id: job.id, trigger, startedAt: job.startedAt } });
      // Pick up where the last real run stopped, so a skipped night is read the next one.
      job.result = await runCoach({ locationId, saved, store, deps, since: cur?.doc?.coachedThrough || null, now, dryRun });
      job.status = "done"; job.finishedAt = new Date().toISOString();
      await stamp({ run: null, last: summary(), failed: false, error: null, ...(dryRun ? {} : { coachedThrough: iso(now) }) });
    } catch (e) {
      job.status = "error"; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = new Date().toISOString();
      await recordError(store, { locationId, area: "coach", err: e, context: { jobId: job.id, trigger } });
      await stamp({ run: null, last: summary(), ...(trigger === "daily" ? { failed: true, error: job.error } : {}) });
    }
    return job;
  })();
  return job;
}

/**
 * maybeRunCoach({ locationId, saved, store, deps, now }) → boolean
 *
 * The audit's gate, verbatim: once a night in its Pacific hour, the cursor
 * written BEFORE the run so a crash can't buy the model call twice, a failed
 * or vanished run retried through the evening.
 */
export async function maybeRunCoach({ locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() }) {
  const config = conversationConfig(saved);
  if (!config.coach?.enabled) return false;
  if (!deps.propose && !String(saved.aiApiKey || "").trim()) return false;
  const hour = config.coach.hour;
  const h = workHour(now);
  if (h < hour || h >= hour + RETRY_WINDOW_HOURS) return false;
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
  } else if (h !== hour) {
    return false;
  }
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { ...doc, run: null, tries, lastDaily: iso(now), ...(stale ? { staleRun: doc.run } : {}) } }).catch(() => {});
  startCoach({ locationId, saved, store, deps, trigger: "daily", now });
  return true;
}

/* ---------- a person's press ---------- */

async function mine(store, locationId, id) {
  const p = await store.getCoachProposal(id);
  if (!p || p.locationId !== locationId) throw Object.assign(new Error("no such proposal"), { http: 404 });
  return p;
}

export async function applyCoachProposal({ store = defaultStore, locationId, id, now = Date.now() }) {
  const p = await mine(store, locationId, id);
  if (p.status !== "open") throw Object.assign(new Error(`that proposal was already ${p.status}`), { http: 409 });
  if (p.kind === "code_gap") throw Object.assign(new Error("a code gap is filed, not applied"), { http: 400 });
  const saved = (await store.getOfferSettings(locationId)) || {};
  const { config, undo } = applyProposal(conversationConfig(saved), p);
  await saveConversationConfig(store, locationId, config);
  return store.updateCoachProposal(id, { ...p, status: "applied", appliedAt: iso(now), undo });
}

export async function rejectCoachProposal({ store = defaultStore, locationId, id, now = Date.now() }) {
  const p = await mine(store, locationId, id);
  if (p.status !== "open") throw Object.assign(new Error(`that proposal was already ${p.status}`), { http: 409 });
  return store.updateCoachProposal(id, { ...p, status: "rejected", rejectedAt: iso(now) });
}

export async function revertCoachProposal({ store = defaultStore, locationId, id, now = Date.now() }) {
  const p = await mine(store, locationId, id);
  if (p.status !== "applied" || !p.undo) throw Object.assign(new Error("only an applied proposal can be reverted"), { http: 409 });
  const saved = (await store.getOfferSettings(locationId)) || {};
  await saveConversationConfig(store, locationId, revertProposal(conversationConfig(saved), p.undo));
  return store.updateCoachProposal(id, { ...p, status: "reverted", revertedAt: iso(now) });
}

export const PREVIEW_DRAFTS = 3;

/**
 * previewCoachProposal — before you press Apply: the messages the proposal
 * came from, drafted again with and without it, beside what you actually sent.
 *
 * A voice check, not a full replay. The live thread now holds the answer you
 * sent, so reading it would hand the model your words; each message is
 * drafted cold instead — the inbound text and the party, no contact, no deal
 * book. Saves nothing, sends nothing. Two model calls a draft, so it is
 * capped at PREVIEW_DRAFTS and only ever runs on a press.
 */
export async function previewCoachProposal({ client = null, store = defaultStore, locationId, id, deps = {} }) {
  const p = await mine(store, locationId, id);
  if (p.kind === "code_gap") throw Object.assign(new Error("a code gap has nothing to preview"), { http: 400 });
  if (p.status !== "open") throw Object.assign(new Error(`that proposal was already ${p.status}`), { http: 409 });
  const saved = (await store.getOfferSettings(locationId)) || {};
  const now = conversationConfig(saved);
  const withIt = { ...saved, conversationAi: applyProposal(now, p).config };
  const without = { ...saved, conversationAi: now };
  const preview = deps.preview || previewConversation;
  const rows = [];
  for (const draftId of (p.evidence || []).slice(0, PREVIEW_DRAFTS)) {
    const d = await store.getReplyDraft(draftId).catch(() => null);
    if (!d || d.locationId !== locationId || !String(d.inbound || "").trim()) continue;
    const ask = (s) => preview({ client, locationId, saved: s, store, contactId: "", message: d.inbound, channel: d.channel || "sms", fakeParty: d.party || "agent", deps })
      .then((r) => r?.draft?.reply || r?.reason || "").catch((e) => `(couldn't draft: ${String(e?.message || e).slice(0, 120)})`);
    const [before, after] = await Promise.all([ask(without), ask(withIt)]);
    rows.push({ draftId, theySaid: d.inbound, botWroteThen: d.reply || "", youSent: d.sentText || "", before, after });
  }
  return { proposalId: id, rows, note: "Drafted cold from the message alone — no thread, no deal book — so it shows the voice, not the numbers." };
}

/**
 * fileCoachProposal — a code gap becomes a GitHub issue labelled `coach`,
 * which is what the scheduled coding agent reads. Scrubbed on the way out
 * (shared/coach.js issueFor): an issue leaves the app.
 *
 * Settings: githubRepo ("owner/name") and githubToken (fine-grained, Issues
 * read/write on that one repo, nothing else).
 */
export async function fileCoachProposal({ store = defaultStore, locationId, id, now = Date.now(), fetchImpl = globalThis.fetch }) {
  const p = await mine(store, locationId, id);
  if (p.kind !== "code_gap") throw Object.assign(new Error("only a code gap is filed"), { http: 400 });
  if (p.status !== "open") throw Object.assign(new Error(`that proposal was already ${p.status}`), { http: 409 });
  const saved = (await store.getOfferSettings(locationId)) || {};
  const repo = String(saved.githubRepo || "").trim(), token = String(saved.githubToken || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) throw Object.assign(new Error("add the GitHub repo and an issues-only token in settings first"), { http: 400 });
  // Full names we hold for the contacts behind the evidence, so they can be cut to first names.
  const names = [];
  for (const draftId of p.evidence || []) {
    const d = await store.getReplyDraft(draftId).catch(() => null);
    if (d?.contactName) names.push(d.contactName);
  }
  const issue = issueFor(p, { names });
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "shepflips-coach" },
    body: JSON.stringify(issue),
  });
  if (!res.ok) throw Object.assign(new Error(`GitHub said ${res.status} — check the token can write issues on ${repo}`), { http: 502 });
  const made = await res.json();
  return store.updateCoachProposal(id, { ...p, status: "filed", filedAt: iso(now), issue: { number: made.number, url: made.html_url } });
}

/** coachReport — what GET /api/dashboard/coach returns: the run, the open ones, and the applied ones scored. */
export async function coachReport({ store = defaultStore, locationId, saved = {}, now = Date.now() }) {
  const config = conversationConfig(saved);
  const [cursor, proposals] = await Promise.all([
    store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null),
    store.listCoachProposals(locationId, { since: iso(now - 90 * 86400000), limit: 300 }).catch(() => []),
  ]);
  const applied = proposals.filter((p) => p.status === "applied");
  let drafts = [];
  if (applied.length) {
    const oldest = Math.min(...applied.map((p) => Date.parse(p.appliedAt) || now));
    drafts = await store.listReplyDrafts(locationId, { since: iso(oldest - SCORECARD.windowDays * 86400000), limit: 5000 }).catch(() => []);
  }
  const live = jobs.get(locationId);
  return {
    enabled: Boolean(config.coach?.enabled), hour: config.coach?.hour ?? 20,
    canFile: Boolean(String(saved.githubRepo || "").trim() && String(saved.githubToken || "").trim()),
    run: live?.status === "running" ? { id: live.id, startedAt: live.startedAt } : null,
    last: cursor?.doc?.last || null, failed: Boolean(cursor?.doc?.failed), error: cursor?.doc?.error || null,
    open: proposals.filter((p) => p.status === "open"),
    applied: applied.map((p) => ({ ...p, scorecard: coachScorecard({ proposal: p, drafts, now }) })),
    settled: proposals.filter((p) => ["rejected", "reverted", "filed"].includes(p.status)).slice(0, 30),
  };
}
