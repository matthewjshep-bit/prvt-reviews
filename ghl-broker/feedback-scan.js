// feedback-scan.js — who was this house actually sent to?
//
// The app's blast route tags and records every recipient. A blast fired from
// a GHL workflow or a bulk action does neither, and the first Edmonds package
// counted 12 buyers when the pitch had gone to 1,337 people. So this reads
// the conversations directly: every thread with an OUTBOUND message naming
// the house since the deal was minted is a recipient, and gets a blast_sent
// event with the offer id on it. Run once per deal; the events are the
// durable record and the package is built from them from then on.
//
// Same shape as the other sweeps: an in-memory job registry, a synchronous
// start, GHL's pace, per-thread errors captured and a fatal one rethrown.

import { searchConversations, listConversationMessages } from "./ghl.js";
import { recordEvent } from "./contact-record.js";

const PACE_MS = 120;
const MAX_CONVERSATION_PAGES = 40;   // ×100 conversations
const MAX_MESSAGE_PAGES = 3;
const jobs = new Map();               // offerId -> job

export const getScanJob = (offerId) => jobs.get(offerId) || null;
export function publicScanJob(job) { if (!job) return null; const { cancelRequested, ...rest } = job; return rest; }
export function _resetScanJobs() { jobs.clear(); }

// How the house is named in a text: the street line with the suffix both
// ways ("Avenue West" / "Avenue W"), the house number + street, and the
// "City (zip)" the short pitch uses.
export function pitchPatterns(address) {
  const street = String(address || "").split(",")[0].trim();
  const parts = String(address || "").split(",").map((s) => s.trim());
  const city = parts[1] || "";
  // The LAST five-digit group: a house number is five digits too.
  const zip = (String(address || "").match(/\b\d{5}\b/g) || []).at(-1) || "";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const short = street.replace(/\b(West|East|North|South)\b/gi, (w) => w[0]);
  const long = street.replace(/\b([WENS])\b/g, (w) => ({ W: "West", E: "East", N: "North", S: "South" }[w.toUpperCase()]));
  const pats = [street, short, long].filter(Boolean).map((s) => new RegExp(esc(s).replace(/\s+/g, "\\s+"), "i"));
  if (city && zip) pats.push(new RegExp(`${esc(city)}\\s*\\(${zip}\\)`, "i"));
  return pats;
}

/**
 * startFeedbackScan({ client, locationId, store, offer, now }) → job
 */
export function startFeedbackScan({ client, locationId, store, offer, now = Date.now(), deps = {} }) {
  const existing = jobs.get(offer.id);
  if (existing?.status === "running") throw Object.assign(new Error("a scan is already running for this deal"), { http: 409 });
  const job = { id: `fs-${Date.now().toString(36)}`, offerId: offer.id, locationId, status: "running", phase: "conversations",
    startedAt: new Date(now).toISOString(), finishedAt: null, conversations: 0, scanned: 0, recipients: 0, replied: 0, recorded: 0, errors: 0, error: null, cancelRequested: false };
  jobs.set(offer.id, job);
  runScan(job, { client, locationId, store, offer, now, deps }).catch((e) => {
    job.status = "error"; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = new Date().toISOString();
  });
  return job;
}

async function runScan(job, { client, locationId, store, offer, now, deps }) {
  const pace = Number.isFinite(deps.paceMs) ? deps.paceMs : PACE_MS;
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const since = (Date.parse(offer.deal?.createdAt || offer.statusAt || 0) || now) - 86400000;
  const pats = pitchPatterns(offer.address);

  // Every conversation with activity since the deal, newest first, paged on
  // lastMessageDate until we're past the window.
  let startAfterDate; const convos = [];
  for (let page = 0; page < MAX_CONVERSATION_PAGES; page++) {
    if (job.cancelRequested) break;
    const r = await searchConversations(client, locationId, { limit: 100, startAfterDate });
    const list = r.conversations || [];
    if (!list.length) break;
    const stamp = (c) => Number(c.lastMessageDate) || Date.parse(c.lastMessageDate) || 0;
    for (const c of list) if (stamp(c) >= since && !convos.some((x) => x.id === c.id)) convos.push(c);
    const oldest = Math.min(...list.map(stamp));
    if (oldest < since) break;
    startAfterDate = oldest;
    await sleep(pace);
  }
  job.conversations = convos.length;
  job.phase = "messages";

  for (const c of convos) {
    if (job.cancelRequested) break;
    job.scanned++;
    try {
      let lastMessageId; let sentAt = null; let repliedAt = null;
      for (let p = 0; p < MAX_MESSAGE_PAGES; p++) {
        const r = await listConversationMessages(client, c.id, { lastMessageId, limit: 100 });
        for (const m of r.messages || []) {
          const ts = new Date(m.dateAdded || 0).getTime();
          if (!(ts >= since)) continue;
          const inbound = String(m.direction || "").toLowerCase() === "inbound";
          const body = String(m.body || "");
          if (!inbound && pats.some((p) => p.test(body)) && (!sentAt || ts < Date.parse(sentAt))) sentAt = new Date(ts).toISOString();
          if (inbound && body.trim() && (!repliedAt || ts > Date.parse(repliedAt))) repliedAt = new Date(ts).toISOString();
        }
        if (!r.nextPage || !r.messages?.length) break;
        lastMessageId = r.messages[r.messages.length - 1].id;
        await sleep(pace);
      }
      if (sentAt && c.contactId) {
        job.recipients++;
        const replied = Boolean(repliedAt && Date.parse(repliedAt) >= Date.parse(sentAt));
        if (replied) job.replied++;
        const r = await recordEvent({ store, locationId, contactId: c.contactId, party: "investor", type: "blast_sent", at: sentAt,
          address: String(offer.address || "").split(",")[0], offerId: offer.id, source: "blast",
          ref: `scan:${offer.id}`, dedupeKey: `blast:${offer.id}:${c.contactId}`,
          data: { via: "scan", name: c.contactName || c.fullName || "", replied, repliedAt: replied ? repliedAt : null } });
        if (r.inserted) job.recorded++;
      }
    } catch (e) {
      if (e?.fatal || e?.status === 401) throw e;
      job.errors++;
    }
    await sleep(pace);
  }
  job.status = job.cancelRequested ? "canceled" : "done";
  job.phase = "";
  job.finishedAt = new Date().toISOString();
}
