// deal-ledger.js — who already has a deal, read back from the threads.
//
// 2026-11-09: after 10/21 Matt's scripts texted deals to about 1,140 buyers
// through the hand-text route, which then recorded only that a person had
// texted them. The app's newest "sent" was 10/20, so a Resume on 4334 130th
// Pl SE, or the next morning catch-up, would have texted about 200 builders
// the same deal again. Hand texts record deal_hand_sent from now on
// (hand-reply.js); this writes it for the ones already sent.
//
// It reads every thread with activity since the deal was made, and a buyer
// we sent a text or email naming the deal's street is a buyer who has it.
// Not the listing agent, not the deal's other parties (title, the TC), not
// someone outside the buyer book, and not a text the carrier blocked: that
// one never reached them. Dry unless told otherwise. The job keeps counts
// only, never a name or a word anyone wrote.
//
// Same shape as feedback-scan.js: an in-memory job, GHL's pace, a thread
// that fails is counted and passed over, a fatal error stops it.

import { searchConversations, listConversationMessages } from "./ghl.js";
import { recordEvent } from "./contact-record.js";
import { pitchPatterns } from "./feedback-scan.js";
import { DEAL_HAND_SENT, DEAL_SENT_TYPES, sentTo } from "./shared/buyer-score.js";

const PACE_MS = 120;
const MAX_CONVERSATION_PAGES = 40;   // ×100 conversations
const MAX_MESSAGE_PAGES = 3;
const FAILED_SEND = new Set(["failed", "undelivered", "bounced"]);
const jobs = new Map();               // offerId -> job

export const getLedgerJob = (offerId) => jobs.get(offerId) || null;
export function _resetLedgerJobs() { jobs.clear(); }

/**
 * dealTextIn(messages, { pats, since }) → { at, messageId } | { failed: true } | null
 *
 * Our earliest text or email since `since` that names the deal (pats from
 * feedback-scan.js pitchPatterns) and wasn't marked failed or undelivered.
 * `{ failed: true }` when every one that named it failed. Pure.
 */
export function dealTextIn(messages = [], { pats = [], since = 0 } = {}) {
  let best = null, failed = false;
  for (const m of messages || []) {
    if (String(m?.direction || "").toLowerCase() !== "outbound") continue;
    const type = String(m.messageType || "");
    if (type && !/SMS|EMAIL/i.test(type)) continue;
    const ts = Date.parse(m.dateAdded || "");
    if (!Number.isFinite(ts) || ts < since) continue;
    if (!pats.some((p) => p.test(String(m.body || "")))) continue;
    if (FAILED_SEND.has(String(m.status || "").toLowerCase())) { failed = true; continue; }
    if (!best || ts < best.ts) best = { ts, messageId: m.id || null };
  }
  if (best) return { at: new Date(best.ts).toISOString(), messageId: best.messageId };
  return failed ? { failed: true } : null;
}

/**
 * startLedgerBackfill({ client, store, locationId, offer, dryRun, now, deps }) → job
 *
 * `job` counts: conversations read, `buyers` the deal is on record for now
 * (or would be, dry), `written` events actually written, and why the others
 * were left out (`skipped`). Throws { http: 400 } for an offer that isn't a
 * deal and { http: 409 } while one is already running for it.
 */
export function startLedgerBackfill({ client, store, locationId, offer, dryRun = true, now = Date.now(), deps = {} }) {
  if (!offer?.deal) throw Object.assign(new Error("not a deal"), { http: 400 });
  const existing = jobs.get(offer.id);
  if (existing?.status === "running") throw Object.assign(new Error("a backfill is already running for this deal"), { http: 409 });
  const job = {
    id: `lb-${Date.now().toString(36)}`, offerId: offer.id, status: "running", dryRun: dryRun !== false,
    startedAt: new Date(now).toISOString(), finishedAt: null, conversations: 0, scanned: 0, named: 0,
    buyers: 0, written: 0, skipped: { listingAgent: 0, dealParties: 0, failedSend: 0, notInBook: 0, already: 0 },
    errors: 0, truncated: false, error: null,
  };
  jobs.set(offer.id, job);
  runBackfill(job, { client, store, locationId, offer, deps }).catch((e) => {
    job.status = "error"; job.error = String(e?.message || e).slice(0, 200); job.finishedAt = new Date().toISOString();
  });
  return job;
}

async function runBackfill(job, { client, store, locationId, offer, deps }) {
  const pace = Number.isFinite(deps.paceMs) ? deps.paceMs : PACE_MS;
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const since = Date.parse(offer.deal.createdAt || offer.statusAt || "") || 0;
  const pats = pitchPatterns(offer.address);
  const parties = new Set(Object.values(offer.deal.parties || {}).map((p) => p?.contactId).filter(Boolean));
  const had = sentTo(offer, await store.listContactEventsSince(locationId, new Date(since).toISOString(), { types: DEAL_SENT_TYPES, limit: 20000 }).catch(() => []));

  // Every conversation with activity since the deal, newest first.
  let startAfterDate; const convos = [];
  for (let page = 0; page < MAX_CONVERSATION_PAGES; page++) {
    const r = await searchConversations(client, locationId, { limit: 100, startAfterDate });
    const list = r.conversations || [];
    if (!list.length) break;
    const stamp = (c) => Number(c.lastMessageDate) || Date.parse(c.lastMessageDate) || 0;
    for (const c of list) if (stamp(c) >= since && c.contactId && !convos.some((x) => x.id === c.id)) convos.push(c);
    const oldest = Math.min(...list.map(stamp));
    if (oldest < since) break;
    if (page === MAX_CONVERSATION_PAGES - 1) job.truncated = true;
    startAfterDate = oldest;
    await sleep(pace);
  }
  job.conversations = convos.length;

  // What each contact's threads say: a send that arrived beats one that failed.
  const found = new Map();
  for (const c of convos) {
    job.scanned++;
    try {
      const messages = [];
      let lastMessageId;
      for (let p = 0; p < MAX_MESSAGE_PAGES; p++) {
        const r = await listConversationMessages(client, c.id, { lastMessageId, limit: 100 });
        messages.push(...(r.messages || []));
        if (!r.nextPage || !r.messages?.length) break;
        lastMessageId = r.messages[r.messages.length - 1].id;
        await sleep(pace);
      }
      const hit = dealTextIn(messages, { pats, since });
      const prev = found.get(c.contactId);
      if (hit && (!prev || prev.failed || (!hit.failed && Date.parse(hit.at) < Date.parse(prev.at)))) found.set(c.contactId, hit);
    } catch (e) {
      if (e?.fatal || e?.status === 401) throw e;
      job.errors++;
    }
    await sleep(pace);
  }

  for (const [contactId, hit] of found) {
    job.named++;
    if (contactId === offer.contactId) { job.skipped.listingAgent++; continue; }
    if (parties.has(contactId)) { job.skipped.dealParties++; continue; }
    if (hit.failed) { job.skipped.failedSend++; continue; }
    const inv = await store.getInvestor?.(locationId, contactId).catch(() => null);
    if (!inv) { job.skipped.notInBook++; continue; }
    if (had.has(contactId)) { job.skipped.already++; continue; }
    job.buyers++;
    if (job.dryRun) continue;
    const r = await recordEvent({
      store, locationId, contactId, party: "investor", type: DEAL_HAND_SENT, at: hit.at,
      address: String(offer.address || "").split(",")[0].trim(), offerId: offer.id, source: "operator", ref: hit.messageId,
      dedupeKey: `deal_hand:${offer.id}:${contactId}`, data: { messageId: hit.messageId, via: "backfill" },
    });
    if (r.inserted) job.written++;
  }
  job.status = "done";
  job.finishedAt = new Date().toISOString();
}
