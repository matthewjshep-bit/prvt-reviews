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
// Run by ghl-broker/scripts/backfill-replier-profiles.mjs.

import { store as defaultStore } from "./store.js";
import { ensureProfile, recordEvent } from "./contact-record.js";
import { getContact, searchConversations, listConversationMessages } from "./ghl.js";
import { conversationConfig, markUnsubscribed } from "./reply-agent.js";
import { loadPulseAgents, pulseTierCards } from "./agent-pulse.js";
import { mapPool } from "./map-pool.js";
import { withRetry } from "./buyer-import.js";
import { classifyReplierThread } from "./shared/agent-pulse.js";

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
 * runReplierBackfill({ client, locationId, store, write, deps, concurrency, limit, now, onProgress })
 *   → { outreachRows, outreachContacts, alreadyInPool, investors, candidates, read, failed, kinds, why, written }
 *
 * `deps` (tests): getContact, searchConversations(contactId),
 * listConversationMessages(conversationId, { lastMessageId }),
 * markUnsubscribed, tierCards, paceMs.
 */
export async function runReplierBackfill({
  client, locationId, store = defaultStore, write = false, deps = {}, concurrency = 3, limit = 0, now = Date.now(), onProgress = null,
}) {
  const saved = (await store.getOfferSettings(locationId)) || {};
  const optOut = conversationConfig(saved).optOut;
  const pace = deps.paceMs ?? 250;
  const readContact = deps.getContact || ((id) => getContact(client, id));
  const unsubscribe = deps.markUnsubscribed || markUnsubscribed;

  // Who the check-in already has (with the Tier 2/3 cards), and the buyers.
  const tierCards = await pulseTierCards(client, locationId, deps);
  const { agents } = await loadPulseAgents({ locationId, saved, store, now, tierCards });
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
  if (limit > 0) candidates = candidates.slice(0, limit);

  const joinedAt = new Date(now).toISOString();
  await mapPool(candidates, Math.max(1, concurrency), async (contactId) => {
    try {
      const messages = await readThread({ client, locationId, contactId, deps });
      // Their GHL record only when they wrote back: DND and do-not-text tags.
      let v = classifyReplierThread({ messages, optOut });
      if (v.kind !== "none") v = classifyReplierThread({ messages, contact: await withRetry(() => readContact(contactId)), optOut });
      out.read++;
      out.kinds[v.kind] = (out.kinds[v.kind] || 0) + 1;
      out.why[v.why] = (out.why[v.why] || 0) + 1;
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
