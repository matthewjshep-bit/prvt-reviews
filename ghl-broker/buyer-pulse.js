// buyer-pulse.js — the check-in between deals, once a workday, on its own.
//
// shared/buyer-pulse.js decides who; this reads the book, claims each buyer
// with a `pulse_sent` event BEFORE anything is drafted (so a crash or a second
// broker can't text the same person twice), and hands them to the
// Conversation AI as a `buyer_pulse` message. The bot reads the thread, the
// tags and the record itself, holds for anyone who asked to be left alone or
// has a person in the thread, and writes one text per buyer.
//
// Two switches, both off (dispoAutopilot.pulse): `enabled` puts the day's
// drafts in the outbox; `autoSend` lets a draft the money guard passed go on
// its own, spread across the day like every other machine-started text. The
// broker's own gates still hold: CARD_SENDS_ENABLED and DISPO_BLASTS_ENABLED.
//
// Gating is conversation-audit.js's: the cursor is written before the run, a
// run that died is retried once it is stale, and the day's tries are capped.

import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { conversationConfig, startProactive, markUnsubscribed } from "./reply-agent.js";
import { getContact, smsUnsubscribed } from "./ghl.js";
import { workHour, isWorkday } from "./outreach-sweep.js";
import { normalizeBuyerPulse, pickPulseBuyers } from "./shared/buyer-pulse.js";
import { botEventsByContact } from "./bot-hold.js";
import { botHold, paceOf, MAX_PACE } from "./shared/bot-hold.js";

export const CURSOR_NAME = "buyerPulse";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const RETRY_WINDOW_HOURS = 5;
export const RETRY_GAP_MS = 20 * 60 * 1000;
export const MAX_DAILY_TRIES = 3;
export const STALE_RUN_MS = 45 * 60 * 1000;
const DISPO_BLASTS_ENABLED = process.env.DISPO_BLASTS_ENABLED === "true";
const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const pacificDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(ms));

const jobs = new Map();
export const getBuyerPulseJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }

export const pulseSettings = (saved = {}) => normalizeBuyerPulse(saved?.dispoAutopilot?.pulse);

/**
 * planBuyerPulse({ locationId, saved, store, deps, now }) → { picks, counts, settings }
 *
 * Pure read: who would get one today. `deps.book(locationId)` is the dispo
 * router's scored book (markets, purchases, engagement, live deals).
 */
export async function planBuyerPulse({ locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() }) {
  const settings = pulseSettings(saved);
  const investors = await deps.book(locationId);
  // × MAX_PACE: a buyer you asked to hear from less waits up to twice the
  // cadence, and a pulse that old still has to count.
  const lookback = Math.max(settings.everyDays, settings.quietEveryDays) * MAX_PACE;
  const events = await store.listContactEventsSince(locationId, iso(now - lookback * DAY_MS), { types: ["pulse_sent", "pulse_voided"], limit: 20000 }).catch(() => []);
  // A claim that drafted nothing (the bot stood down, a waiting reply, a
  // failure) is voided: it neither starts the buyer's cadence nor takes a
  // seat. Until 2026-09-29 it did both — a DND buyer cost a seat and 30 days.
  const voided = new Set(events.filter((e) => e?.type === "pulse_voided").map((e) => e.data?.claimKey).filter(Boolean));
  const pulsedAt = new Map();
  const triedToday = new Set();
  let claimedToday = 0;
  for (const e of events) {
    if (!e?.contactId || e.type !== "pulse_sent") continue;
    const today = pacificDay(Date.parse(e.at)) === pacificDay(now);
    if (today) triedToday.add(e.contactId);
    if (voided.has(e.dedupeKey)) continue;
    if (today) claimedToday++;
    if (String(e.at) > String(pulsedAt.get(e.contactId) || "")) pulsedAt.set(e.contactId, e.at);
  }
  const openDraftIds = new Set();
  for (const status of ["draft", "scheduled"]) {
    const rows = await store.listReplyDrafts(locationId, { status, limit: 1000 }).catch(() => []);
    for (const d of rows) if (d?.contactId) openDraftIds.add(d.contactId);
  }
  // The cap is the DAY's, not the run's: a retry after a run that died half
  // way, or a second press of Run now, only gets the seats still empty.
  const left = Math.max(0, settings.dailyCap - claimedToday);
  // Buyers you stopped the bot on (shared/bot-hold.js), with no time window.
  // Not caught: a plan that can't tell who is stopped texts no one.
  const stopped = new Set();
  const paceBy = new Map();
  for (const [id, list] of await botEventsByContact({ store, locationId })) {
    if (botHold({ events: list, now }).held) stopped.add(id);
    const p = paceOf({ events: list });
    if (p.pace !== "normal") paceBy.set(id, p.factor);
  }
  // Tried today already (a voided claim): tomorrow, not twice today.
  const plan = pickPulseBuyers({ investors: investors.filter((i) => !triedToday.has(i.contactId)), pulsedAt, openDraftIds, stopped, paceBy, settings, now });
  const line = [...plan.picks, ...(plan.spares || [])];
  return { picks: line.slice(0, left), spares: line.slice(left, left + Math.max(5, Math.ceil(settings.dailyCap / 2))), counts: { ...plan.counts, claimedToday, seatsLeft: left }, settings };
}

/**
 * startBuyerPulse({ client, locationId, saved, store, sendsEnabled, deps, trigger, dryRun, limit, now }) → job
 *
 * A dry run picks and reports; it claims nobody and drafts nothing. `limit`
 * (a run by hand) can only lower the day's cap.
 */
export function startBuyerPulse({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, blastsEnabled = DISPO_BLASTS_ENABLED, deps = {}, trigger = "manual", dryRun = false, limit = null, now = Date.now() }) {
  if (jobs.get(locationId)?.status === "running") throw Object.assign(new Error("a buyer pulse run is already going"), { http: 409 });
  const job = {
    id: `bp-${Date.now().toString(36)}`, locationId, trigger, dryRun: Boolean(dryRun), status: "running", startedAt: iso(now), finishedAt: null,
    picked: 0, started: 0, skipped: 0, counts: null, autoSend: false, results: [], error: null,
  };
  jobs.set(locationId, job);
  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;
  const finish = async (patch) => {
    Object.assign(job, patch, { finishedAt: new Date().toISOString() });
    if (trigger !== "daily") return;
    const last = { id: job.id, status: job.status, picked: job.picked, started: job.started, skipped: job.skipped, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt };
    const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
    const { run: _run, ...doc } = cursor?.doc || {};
    await store.setJobCursor?.(locationId, CURSOR_NAME, { at: cursor?.at || iso(now), doc: { ...doc, last, failed: job.status === "error" } }).catch(() => {});
  };
  (async () => {
    const plan = await planBuyerPulse({ locationId, saved, store, deps, now });
    const picks = limit != null ? plan.picks.slice(0, Math.max(0, Math.round(Number(limit)) || 0)) : plan.picks;
    job.counts = plan.counts;
    job.picked = picks.length;
    // It sends itself only when the pulse's own switch says so AND the broker
    // may send buyers anything at all. Otherwise: a draft in the outbox.
    const live = Boolean(sendsEnabled && blastsEnabled);
    job.autoSend = Boolean(plan.settings.autoSend && live && conversationConfig(saved).enabled);
    // A different way in for each text, continuing across the day's runs so
    // two batches don't open alike.
    let n = Number(plan.counts.claimedToday) || 0;
    const read = typeof deps.getContact === "function" ? deps.getContact : (id) => getContact(client, id);
    const seats = picks.length;
    let claimed = 0;
    // The day's picks, then the spares: a buyer skipped before being claimed
    // (unsubscribed in GHL) gives the seat to the next in line.
    for (const p of [...picks, ...(dryRun ? [] : plan.spares || [])]) {
      if (claimed >= seats) break;
      p.subject = { ...p.subject, variant: n++ };
      if (dryRun) { job.results.push({ contactId: p.contactId, name: p.name, group: p.group, status: "would draft", clues: p.subject }); continue; }
      if (!deps.skipPreflight) {
        let contact = null;
        try { contact = await read(p.contactId); } catch (e) { job.skipped++; job.results.push({ contactId: p.contactId, group: p.group, status: "skipped", reason: `couldn't read the contact (${String(e?.message || e).slice(0, 80)})` }); continue; }
        if (smsUnsubscribed(contact)) {
          await markUnsubscribed({ client, store, locationId, contactId: p.contactId, party: "investor", now }).catch(() => {});
          job.skipped++; job.results.push({ contactId: p.contactId, group: p.group, status: "skipped", reason: "they unsubscribed" });
          continue;
        }
      }
      const claimKey = `pulse_sent:${p.contactId}:${pacificDay(now)}`;
      const claim = await recordEvent({
        store, locationId, contactId: p.contactId, party: "investor", type: "pulse_sent", at: iso(now), source: "conversation",
        dedupeKey: claimKey, data: { group: p.group, trigger },
      });
      if (!claim.inserted) { job.skipped++; job.results.push({ contactId: p.contactId, group: p.group, status: "skipped", reason: "already claimed today" }); continue; }
      claimed++;
      let voidedOnce = false;
      const voidClaim = async (why) => {
        if (voidedOnce) return;
        voidedOnce = true;
        await recordEvent({ store, locationId, contactId: p.contactId, party: "investor", type: "pulse_voided", at: iso(Date.now()), source: "conversation",
          dedupeKey: `pulse_voided:${claimKey}`, data: { claimKey, why: String(why || "").slice(0, 160) } }).catch(() => {});
      };
      const r = await start({
        client, locationId, saved, store, contactId: p.contactId, kind: "buyer_pulse", offer: null, subject: p.subject,
        sendsEnabled: live,
        deps: { ...deps, releaseHeld: plan.settings.autoSend, releaseReason: "the pulse check may send itself (Settings → Dispositions)",
          onSettled: (j) => { if (!j?.draftId) voidClaim(j?.heldReason || j?.error || "nothing was drafted"); } },
      }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
      if (r?.skipped) { await voidClaim(r.skipped); job.skipped++; job.results.push({ contactId: p.contactId, group: p.group, status: "skipped", reason: r.skipped }); }
      else { job.started++; job.results.push({ contactId: p.contactId, group: p.group, status: "drafting", jobId: r?.job?.id || null }); }
    }
    await finish({ status: "done" });
  })().catch((e) => finish({ status: "error", error: String(e?.message || e).slice(0, 300) }));
  return job;
}

/**
 * maybeRunBuyerPulse({ client, locationId, saved, store, sendsEnabled, deps, now }) → boolean
 *
 * Off the 15-minute tick. Fires in the pulse's Pacific hour on a workday;
 * a failed or vanished run comes back up to three times that afternoon.
 */
export async function maybeRunBuyerPulse({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, blastsEnabled = DISPO_BLASTS_ENABLED, deps = {}, now = Date.now() }) {
  const s = pulseSettings(saved);
  if (!s.enabled || !conversationConfig(saved).enabled) return false;
  if (s.weekdaysOnly && !isWorkday(now)) return false;
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
  startBuyerPulse({ client, locationId, saved, store, sendsEnabled, blastsEnabled, deps, trigger: "daily", now });
  return true;
}
