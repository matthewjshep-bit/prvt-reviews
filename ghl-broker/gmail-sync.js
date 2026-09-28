// gmail-sync.js — new mail in Matt's Gmail, onto the contacts it is with.
//
// Every 15-minute tick, when conversationAi.gmail is on and the GMAIL_* env
// is set: ask Gmail what arrived since the cursor's historyId, keep the mail
// a person wrote, look each address up as a GHL contact, and write one
// email_received / email_sent event per contact it is with (keyed on the
// Gmail message id, so a replay writes nothing). Mail with nobody we know is
// dropped — not stored, not logged. The reply agent reads those events as
// "EMAIL WITH THEM" (shared/gmail.js emailContextText). Read-only: nothing
// here sends, and nothing here starts a reply. Matt, 2026-09-28.
//
// Gating is the conversation audit's: the cursor is written before the run
// (`run`), a run left on it past STALE_RUN_MS is retried, the day's failed
// or stale retries are capped, and `last` keeps counts only — no addresses,
// subjects or words.

import { store as defaultStore } from "./store.js";
import { searchContacts } from "./ghl.js";
import { recordEvent } from "./contact-record.js";
import { gmailEnv, makeGmail } from "./gmail-api.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { isPersonMail, summarizeMessage, emailEvent, addressInEmail } from "./shared/gmail.js";

export const CURSOR_NAME = "gmail";
export const STALE_RUN_MS = 30 * 60 * 1000;
export const MAX_DAILY_RETRIES = 6;
export const MAX_MESSAGES_PER_RUN = 300;
export const MAX_LOOKUPS_PER_RUN = 120;
export const MAX_ADDRESSES_PER_MESSAGE = 6;
export const FALLBACK_DAYS = 2;             // a historyId Gmail can no longer replay
const LOOKUP_HIT_MS = 24 * 3600000;
const LOOKUP_MISS_MS = 12 * 3600000;
const iso = (ms) => new Date(ms).toISOString();
const pacificDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(ms));
const SEARCH_NOISE = "-in:chats -category:promotions -category:social";

const jobs = new Map();
export const getGmailJob = (locationId) => jobs.get(locationId) || null;
const lookups = new Map();   // `${locationId}|${email}` → { id|null, at }
export function _reset() { jobs.clear(); lookups.clear(); }

/**
 * contactIdForEmail({ client, locationId, email, deps, now }) → contactId | null
 *
 * GHL's contact search by the address, with an exact compare: the duplicate
 * endpoint misses known contacts by email (2026-09-28, dispo-talked-to).
 * Remembered a day for a hit and half a day for a miss, so a busy inbox
 * doesn't re-ask GHL about the same stranger every tick.
 */
export async function contactIdForEmail({ client, locationId, email, deps = {}, now = Date.now() }) {
  const key = `${locationId}|${email}`;
  const hit = lookups.get(key);
  if (hit && now - hit.at < (hit.id ? LOOKUP_HIT_MS : LOOKUP_MISS_MS)) return { id: hit.id, cached: true };
  const search = deps.searchContacts || searchContacts;
  const rows = await search(client, locationId, email);
  const same = (v) => String(v || "").trim().toLowerCase() === email;
  const found = (rows || []).find((c) => same(c?.email) || (c?.additionalEmails || []).some((a) => same(a?.email ?? a)));
  const id = found?.id || null;
  lookups.set(key, { id, at: now });
  return { id, cached: false };
}

/**
 * runGmailSync({ client, locationId, saved, store, deps, now, doc })
 *   → { historyId, counts }
 *
 * `doc` is the cursor as it was before this run. `deps.gmail` stands in for
 * the Gmail client in tests; `deps.searchContacts` for GHL's search.
 */
export async function runGmailSync({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now(), doc = {} }) {
  const cfg = normalizeConversationAi(saved?.conversationAi || {}).gmail;
  const gmail = deps.gmail || makeGmail(gmailEnv());
  const profile = await gmail.profile();
  const self = [String(profile.emailAddress || "").toLowerCase(), ...(deps.selfEmails || [])].filter(Boolean);
  const counts = { messages: 0, bulk: 0, noContact: 0, recorded: 0, duplicate: 0, lookups: 0, lookupCapped: 0, truncated: 0, mode: "" };

  let ids = [];
  let historyId = String(profile.historyId || "");
  if (!doc.historyId) {
    counts.mode = "backfill";
    if (cfg.backfillDays > 0) ids = await gmail.list(`newer_than:${cfg.backfillDays}d ${SEARCH_NOISE}`, { max: MAX_MESSAGES_PER_RUN });
  } else {
    try {
      const h = await gmail.history(doc.historyId);
      ids = h.ids;
      historyId = h.historyId || historyId;
      counts.mode = h.complete ? "history" : "history-partial";
    } catch (e) {
      if (e?.status !== 404) throw e;
      counts.mode = "history-expired";
      ids = await gmail.list(`newer_than:${FALLBACK_DAYS}d ${SEARCH_NOISE}`, { max: MAX_MESSAGES_PER_RUN });
    }
  }
  if (ids.length > MAX_MESSAGES_PER_RUN) { counts.truncated = ids.length - MAX_MESSAGES_PER_RUN; ids = ids.slice(-MAX_MESSAGES_PER_RUN); }

  const offersFor = new Map();
  for (const id of ids) {
    let msg;
    try { msg = await gmail.message(id); } catch (e) { if (e?.status === 404) continue; throw e; }
    counts.messages++;
    if (!isPersonMail(msg)) { counts.bulk++; continue; }
    const s = summarizeMessage(msg, { self });
    if (!s.id || !s.at) continue;
    const contactIds = new Set();
    for (const email of s.others.slice(0, MAX_ADDRESSES_PER_MESSAGE)) {
      const known = lookups.get(`${locationId}|${email}`);
      if (!known && counts.lookups >= MAX_LOOKUPS_PER_RUN) { counts.lookupCapped++; continue; }
      const r = await contactIdForEmail({ client, locationId, email, deps, now });
      if (!r.cached) counts.lookups++;
      if (r.id) contactIds.add(r.id);
    }
    if (!contactIds.size) { counts.noContact++; continue; }
    for (const contactId of contactIds) {
      if (!offersFor.has(contactId)) offersFor.set(contactId, await store.listOffers?.(locationId, { contactId, limit: 25, lean: true }).catch(() => []) || []);
      const offers = offersFor.get(contactId);
      const address = addressInEmail(s, offers.map((o) => o?.address).filter(Boolean));
      const offer = address ? offers.find((o) => o?.address === address) : null;
      const { inserted } = await recordEvent({ store, locationId, ...emailEvent(s, { contactId, address, offerId: offer?.id || null }) });
      if (inserted) counts.recorded++; else counts.duplicate++;
    }
  }
  return { historyId, counts };
}

/**
 * maybeSyncGmail({ client, locationId, saved, store, deps, now, env, log }) → boolean started
 */
export async function maybeSyncGmail({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now(), env = process.env, log = () => {} }) {
  const cfg = normalizeConversationAi(saved?.conversationAi || {}).gmail;
  if (!cfg.enabled) return false;
  if (!deps.gmail && !gmailEnv(env)) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  const doc = cursor?.doc || {};
  const today = pacificDay(now);
  const stale = doc.run?.startedAt && now - Date.parse(doc.run.startedAt) >= STALE_RUN_MS;
  if (doc.run && !stale) return false;           // going, here or on another broker
  const retries = doc.day === today ? Number(doc.retries) || 0 : 0;
  const retrying = stale || doc.failed;
  if (retrying && retries >= MAX_DAILY_RETRIES) return false;

  const run = { startedAt: iso(now) };
  const base = { historyId: doc.historyId || null, last: doc.last || null, day: today, retries: retrying ? retries + 1 : retries };
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: { ...base, run, ...(stale ? { staleRun: doc.run } : {}) } }).catch(() => {});
  const job = { locationId, status: "running", startedAt: run.startedAt };
  jobs.set(locationId, job);

  const finish = async (patch) => {
    job.status = patch.failed ? "error" : "done";
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(Date.now()), doc: { ...base, ...patch } }).catch(() => {});
  };
  job.done = (async () => {
    try {
      const r = await runGmailSync({ client, locationId, saved, store, deps, now, doc });
      await finish({ historyId: r.historyId || base.historyId, failed: false, last: { at: iso(Date.now()), startedAt: run.startedAt, ...r.counts } });
      if (r.counts.recorded) log(`gmail sync ${locationId}: ${r.counts.recorded} email${r.counts.recorded === 1 ? "" : "s"} onto the record`);
    } catch (e) {
      // Status only: a Gmail error message can quote a query or an id.
      await finish({ failed: true, last: { at: iso(Date.now()), startedAt: run.startedAt, error: `HTTP ${e?.status || "?"}` } });
      log(`gmail sync ${locationId} failed: HTTP ${e?.status || "?"}${e?.status === 401 || e?.status === 400 ? " (refresh token revoked or GOOGLE_CLIENT_* wrong?)" : ""}`);
    }
  })();
  return true;
}
