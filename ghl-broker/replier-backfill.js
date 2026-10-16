// replier-backfill.js — one time: agents who texted us back before the app
// saw replies join the agent check-in.
//
// 2026-10-14: of the 1,049 agents we texted who sit outside the check-in
// pool, 104 had written back — most of them to a GHL workflow text before
// the app read inbound webhooks, so the app's record has no reply and no
// profile for them, and nothing would ever text them again. This reads each
// outreach agent's GHL thread (shared/agent-pulse.js classifyReplierThread)
// and, with `write`:
//   engaged    an agent profile, and their last word on the timeline (a
//              text_summary, or a call_summary for a call, source "backfill",
//              one per contact by its dedupe key) so the check-in counts
//              from it — and spreads their first check-in from this run
//              (data.joinedAt, shared/agent-pulse.js firstCheckInAt);
//   opted_out  the stop path every other opt-out takes (markUnsubscribed);
//   anything else is left alone.
// Without `write` it only reads (GHL and the store) and counts. The result
// is counts only: no names, phones or words of theirs.
//
// `includePool` (2026-10-16): agents already IN the pool that the app thinks
// never replied are read too. 59+ of them had written back in GHL (mostly to
// the old workflow texts in August and September), so the check-in held
// them as "cold" and texted them only about a fresh listing of theirs. The
// same marker makes them engaged, on the regular cadence, their first
// check-in spread from the run; the same stop path takes the opted out.
//
// Run by ghl-broker/scripts/backfill-replier-profiles.mjs, or as a job from
// POST /api/outreach/repliers/backfill (startReplierBackfill, below).

import { store as defaultStore } from "./store.js";
import { ensureProfile, recordEvent } from "./contact-record.js";
import { getContact, searchConversations, listConversationMessages } from "./ghl.js";
import { conversationConfig, markUnsubscribed } from "./reply-agent.js";
import { loadPulseAgents, pulseTierCards } from "./agent-pulse.js";
import { mapPool } from "./map-pool.js";
import { withRetry } from "./buyer-import.js";
import { classifyReplierThread, agentSegment, agentStops } from "./shared/agent-pulse.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GHL's 100 messages a page; a cold outreach thread is a handful.
const MAX_CONVERSATIONS = 3;
const MAX_PAGES = 3;

/** Every contact id the outreach pull has for an agent, across all batches. */
export async function outreachContactIds(store, locationId) {
  const ids = new Set();
  let rows = 0;
  for (const b of (await store.listOutreachBatches(locationId)) || []) {
    for (const a of (await store.listOutreachAgents(locationId, { batchId: b.id, limit: 50000 })) || []) {
      rows++;
      const id = a?.contactId || a?.doc?.ghl?.contactId;
      if (id) ids.add(String(id));
    }
  }
  return { ids, rows };
}

async function readThread({ client, locationId, contactId, deps }) {
  const search = deps.searchConversations || ((id) => searchConversations(client, locationId, { contactId: id, limit: 10 }));
  const list = deps.listConversationMessages || ((convId, opts) => listConversationMessages(client, convId, { ...opts, limit: 100 }));
  // A 429 waits and tries again (twice); anything else fails this contact.
  const { conversations = [] } = (await withRetry(() => search(contactId))) || {};
  const messages = [];
  for (const c of conversations.slice(0, MAX_CONVERSATIONS)) {
    let lastMessageId;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await withRetry(() => list(c.id, { lastMessageId }))) || {};
      messages.push(...(r.messages || []));
      if (!r.nextPage || !r.lastMessageId) break;
      lastMessageId = r.lastMessageId;
    }
  }
  return messages;
}

/**
 * poolNeverReplied({ agents, investors, config, now }) → [contactId]
 *
 * The pool agents the app has no reply from: nothing inbound on their
 * timeline or their drafts, and no offer only their answer could have moved
 * (agentSegment "cold"). Never a buyer, and never one already stopped
 * (opted out, a do-not-text or bot-off tag, a stop on the thread): there is
 * nothing to change for them.
 */
export function poolNeverReplied({ agents = [], investors = new Set(), config = {}, now = Date.now() } = {}) {
  const botOffTags = config?.routing?.botOffTags || [];
  return (agents || []).filter((a) => a?.contactId && !investors.has(a.contactId) && !a.lastInboundAt
    && !(a.drafts || []).some((d) => String(d?.inbound || "").trim())
    && agentSegment({ offers: a.offers || a.current || [] }) === "cold"
    && !agentStops({ drafts: a.drafts || [], events: a.events || [], tags: a.tags || [], botOffTags, now }))
    .map((a) => a.contactId);
}

/**
 * runReplierBackfill({ client, locationId, store, write, includePool, deps, concurrency, limit, now, onProgress })
 *   → { outreachRows, outreachContacts, alreadyInPool, investors, candidates, read, failed, kinds, why, written, pool? }
 *
 * `pool` (with `includePool`): { candidates, hadReply, read, kinds } for the
 * pool agents read — `hadReply` were skipped because a draft holds a reply.
 * `limit` caps the whole read, the agents outside the pool first.
 *
 * `deps` (tests): getContact, searchConversations(contactId),
 * listConversationMessages(conversationId, { lastMessageId }),
 * markUnsubscribed, tierCards, paceMs.
 */
export async function runReplierBackfill({
  client, locationId, store = defaultStore, write = false, includePool = false, deps = {}, concurrency = 3, limit = 0, now = Date.now(), onProgress = null,
}) {
  const saved = (await store.getOfferSettings(locationId)) || {};
  const optOut = conversationConfig(saved).optOut;
  const pace = deps.paceMs ?? 250;
  const readContact = deps.getContact || ((id) => getContact(client, id));
  const unsubscribe = deps.markUnsubscribed || markUnsubscribed;

  // Who the check-in already has (with the Tier 2/3 cards), and the buyers.
  const tierCards = await pulseTierCards(client, locationId, deps);
  const { agents, config } = await loadPulseAgents({ locationId, saved, store, now, tierCards });
  const pool = new Set(agents.map((a) => a.contactId));
  const investors = new Set(((await store.listContactProfiles(locationId, { party: "investor", limit: 50000 })) || []).map((p) => p.contactId));
  const { ids, rows } = await outreachContactIds(store, locationId);

  const out = {
    outreachRows: rows, outreachContacts: ids.size, alreadyInPool: 0, investors: 0, candidates: 0, read: 0, failed: 0,
    kinds: {}, why: {}, written: { profiles: 0, markers: 0, optedOut: 0 },
  };
  let candidates = [];
  for (const id of ids) {
    if (pool.has(id)) out.alreadyInPool++;
    else if (investors.has(id)) out.investors++;
    else candidates.push(id);
  }
  out.candidates = candidates.length;
  const inPool = new Set(includePool ? poolNeverReplied({ agents, investors, config, now }) : []);
  if (includePool) {
    out.pool = { candidates: inPool.size, hadReply: 0, read: 0, kinds: {} };
    candidates.push(...inPool);
  }
  if (limit > 0) candidates = candidates.slice(0, limit);

  const joinedAt = new Date(now).toISOString();
  await mapPool(candidates, Math.max(1, concurrency), async (contactId) => {
    try {
      // A pool agent with a reply in their drafts: the app saw them answer,
      // whatever the timeline lacks. Not read, not written.
      if (inPool.has(contactId)) {
        const drafts = (await store.listReplyDrafts(locationId, { contactId, limit: 50 }).catch(() => [])) || [];
        if (drafts.some((d) => String(d?.inbound || "").trim())) {
          out.pool.hadReply++;
          try { onProgress?.(out); } catch { /* the caller's */ }
          return;
        }
      }
      const messages = await readThread({ client, locationId, contactId, deps });
      // Their GHL record only when they wrote back: DND and do-not-text tags.
      let v = classifyReplierThread({ messages, optOut });
      if (v.kind !== "none") v = classifyReplierThread({ messages, contact: await withRetry(() => readContact(contactId)), optOut });
      out.read++;
      out.kinds[v.kind] = (out.kinds[v.kind] || 0) + 1;
      out.why[v.why] = (out.why[v.why] || 0) + 1;
      if (inPool.has(contactId)) { out.pool.read++; out.pool.kinds[v.kind] = (out.pool.kinds[v.kind] || 0) + 1; }
      if (write && v.kind === "engaged") {
        await ensureProfile({ store, locationId, contactId, party: "agent" });
        out.written.profiles++;
        const text = v.lastText || "";
        const r = await recordEvent({
          store, locationId, contactId, party: "agent", type: text ? "text_summary" : "call_summary", at: v.lastInboundAt, source: "backfill",
          dedupeKey: `replier_backfill:${contactId}`,
          data: { summary: text ? "They texted back (read from GHL by the replier backfill)" : "They called us (read from GHL by the replier backfill)",
            ...(text ? { inbound: text } : {}), backfill: true, joinedAt },
        });
        if (r.inserted) out.written.markers++;
      } else if (write && v.kind === "opted_out") {
        await unsubscribe({ client, store, locationId, contactId, party: "agent", now });
        out.written.optedOut++;
      }
    } catch (e) {
      out.failed++;
      out.why[`failed ${e?.status || "error"}`] = (out.why[`failed ${e?.status || "error"}`] || 0) + 1;
    }
    try { onProgress?.(out); } catch { /* the caller's */ }
    if (pace) await sleep(pace);
  });
  return out;
}

/* ---------- as a job (POST /api/outreach/repliers/backfill) ---------- */

// In memory, like the other jobs: a restart loses the job and corrupts
// nothing, and a rerun is safe (the marker has a dedupe key, and the written
// agents have a reply on record and are not read again).
const jobs = new Map();
export const getReplierBackfillJob = (locationId) => jobs.get(locationId) || null;
export function _resetReplierBackfillJobs() { jobs.clear(); }

/**
 * startReplierBackfill({ client, locationId, store, dryRun, includePool, limit, deps, now }) → job
 *
 * The backfill without the Render Shell. A dry run (the default) reads GHL
 * and counts, writing nothing. The job carries counts only — `progress`
 * while it reads, `result` (runReplierBackfill's counts) when done — never a
 * name, a phone or a word of theirs. Three threads at a time, paced, as the
 * script reads them.
 */
export function startReplierBackfill({ client, locationId, store = defaultStore, dryRun = true, includePool = true, limit = 0, deps = {}, now = Date.now() }) {
  if (jobs.get(locationId)?.status === "running") {
    throw Object.assign(new Error("a replier backfill is already running for this location"), { http: 409 });
  }
  const job = {
    id: `rb-${Date.now().toString(36)}`, locationId, dryRun: dryRun !== false, includePool: includePool !== false,
    limit: Math.max(0, Math.round(Number(limit)) || 0),
    status: "running", startedAt: new Date().toISOString(), finishedAt: null,
    progress: { read: 0, failed: 0 }, result: null, error: null,
  };
  jobs.set(locationId, job);
  runReplierBackfill({
    client, locationId, store, write: !job.dryRun, includePool: job.includePool, limit: job.limit, deps, now,
    onProgress: (o) => { job.progress = { read: o.read, failed: o.failed, ...(o.pool ? { poolHadReply: o.pool.hadReply } : {}) }; },
  }).then((r) => { job.result = r; job.status = "done"; })
    .catch((e) => { job.status = "error"; job.error = String(e?.message || e).slice(0, 300); })
    .finally(() => { job.finishedAt = new Date().toISOString(); });
  return job;
}
