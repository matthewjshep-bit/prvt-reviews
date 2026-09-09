// dispo-autopilot.js — the selling side, on its own.
//
// Three things that used to be clicks, and one workflow the app could not
// see:
//
//   The blast. Until now "Tag & blast" applied a GHL tag and a workflow
//   template texted the list, so the app learned who was pitched only by
//   scanning conversations afterwards (the Edmonds package counted 12 buyers
//   when 1,337 had been texted). Now a blast is a set of outbound drafts —
//   one per buyer, the deal in one text — staggered over the auto-send hours
//   and sent by the same 30-second scheduler that sends replies. Hold works,
//   quiet hours work, and every send is a blast_sent event.
//
//   Blast on promote: a deal is minted → the strong buy-box fits are blasted.
//   Second wave: no committed buyer after N hours → the possible fits.
//   The guarded dataroom invite and the assignment on commit live in the
//   offers router's deps; this file holds the settings and the queue.

import { store as defaultStore } from "./store.js";
import { blastMessage, dealFacts } from "./shared/blast-text.js";
import { dealNumbers } from "./dataroom.js";
import { conversationConfig } from "./reply-agent.js";
import { nextSendTime } from "./conversation-scheduler.js";

export const CURSOR_NAME = "dispo";
export const MIN_GAP_MS = 20 * 3600 * 1000;
export const DISPO_SWEEP_UTC_HOUR = Number(process.env.DISPO_SWEEP_UTC_HOUR || 17); // ≈ 9–10am Pacific
const DISPO_BLASTS_ENABLED = process.env.DISPO_BLASTS_ENABLED === "true";
const iso = (ms) => new Date(ms).toISOString();

export function normalizeDispoAutopilot(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const n = (x, d, lo, hi) => { const k = Math.round(Number(x)); return Number.isFinite(k) ? Math.min(hi, Math.max(lo, k)) : d; };
  return {
    sendWith: o.sendWith === "ghl" ? "ghl" : "app",
    spreadSec: n(o.spreadSec, 60, 5, 900),        // seconds between two blast texts
    autoBlastOnPromote: o.autoBlastOnPromote === true,
    autoBlastCount: n(o.autoBlastCount, 25, 1, 200),
    secondWaveHours: n(o.secondWaveHours, 48, 6, 720),
    secondWaveCount: n(o.secondWaveCount, 25, 1, 200),
    autoInvite: o.autoInvite === true,
    paperworkOnCommit: o.paperworkOnCommit === true,
  };
}

/**
 * queueBlastDrafts({ store, locationId, offer, investors, saved, now, dryRun })
 *   → { queued, drafted, dryRun, rows: [{ contactId, name, status, sendAt, text }] }
 *
 * One outbound draft per buyer. Scheduled (sends itself) only when the
 * broker may send, blasts are enabled, and blast_open is on the investor
 * allowlist; otherwise a plain draft in the outbox — the shakedown. Send
 * times are staggered `spreadSec` apart from the next open minute, so a
 * blast never lands as a burst and never at night.
 */
export async function queueBlastDrafts({ store = defaultStore, locationId, offer, investors = [], saved = {}, now = Date.now(), dryRun = false, sendsEnabled = false, blastsEnabled = DISPO_BLASTS_ENABLED, label = "" }) {
  const da = normalizeDispoAutopilot(saved.dispoAutopilot);
  const config = conversationConfig(saved);
  const pb = config.parties.investor;
  const allowed = Boolean(pb.autoSend?.enabled && (pb.autoSend.intents || []).includes("blast_open"));
  const live = !dryRun && sendsEnabled && blastsEnabled;
  const willSchedule = live && config.enabled && allowed;
  const reason = !live ? (dryRun ? "dry run" : !sendsEnabled ? "sends are off on the broker (CARD_SENDS_ENABLED)" : "blasts are off on the broker (DISPO_BLASTS_ENABLED)")
    : !config.enabled ? "Conversation AI is switched off" : !allowed ? "'sent them a deal' is not on the investor auto-send list" : "";

  const numbers = dealNumbers({ offer, settings: saved });
  const facts = dealFacts(offer, { price: numbers.investorPrice });
  const rows = [];
  let queued = 0, drafted = 0, i = 0;
  // Cumulative: each text lands at least `spreadSec` after the one before,
  // plus a little jitter so the gaps aren't a metronome. nextSendTime rolls
  // anything past the close into the next open window.
  let cursor = Date.parse(nextSendTime({ now, delayMs: 0, quietHours: config.autoSend.quietHours }));
  for (const inv of investors) {
    const contactId = inv.contactId;
    if (!contactId) continue;
    const name = inv.name || inv.doc?.name || "";
    const text = blastMessage({ ...facts, firstName: name, variant: i });
    if (i > 0) cursor += da.spreadSec * 1000 + Math.round(Math.random() * 15000);
    const sendAt = nextSendTime({ now: cursor, delayMs: 0, quietHours: config.autoSend.quietHours });
    cursor = Date.parse(sendAt);
    i++;
    if (dryRun) { rows.push({ contactId, name, status: "would queue", sendAt: willSchedule ? sendAt : null, text }); continue; }
    // One open blast per buyer per deal: a second click supersedes the first.
    const open = await store.listReplyDrafts(locationId, { contactId, status: ["draft", "scheduled"], limit: 5 }).catch(() => []);
    for (const old of open.filter((d) => d.outbound?.kind === "blast_open" && d.outbound?.offerId === offer.id)) {
      await store.updateReplyDraft(old.id, { ...old, status: "superseded", sendAt: null, updatedAt: iso(now) }).catch(() => {});
    }
    const ts = iso(now);
    const record = await store.createReplyDraft({
      locationId, contactId, contactName: name, status: willSchedule ? "scheduled" : "draft", channel: "sms", jobId: null,
      inbound: "", outbound: { kind: "blast_open", offerId: offer.id, address: offer.address, label: label || "" },
      reply: text, intent: "blast_open", confidence: "high", needsHuman: false, humanReason: "",
      summary: `Puts ${offer.address} in front of ${name || "a buyer"} at ${facts.price ? `$${facts.price.toLocaleString("en-US")}` : "the buyer price"}.`,
      propertyAddress: offer.address || "", counterAmount: null, autoSendable: true, flags: [], party: "investor", partySource: "deal",
      matchedTags: { agent: [], investor: [] }, contextSummary: { deal: offer.id }, offersInContext: 0,
      autoSend: { decided: willSchedule, reason: willSchedule ? "" : reason }, humanActive: null, actions: [],
      supersededIds: open.map((o) => o.id), warnings: [], noteOnAutoSend: config.notes?.onAutoSend !== false, promptVersion: 3,
      ...(willSchedule ? { sendAt, scheduledAt: ts } : {}), updatedAt: ts,
    });
    if (willSchedule) queued++; else drafted++;
    rows.push({ contactId, name, status: willSchedule ? "scheduled" : "draft", draftId: record.id, sendAt: willSchedule ? sendAt : null, text });
  }
  return { queued, drafted, dryRun: Boolean(dryRun), scheduled: willSchedule, reason, rows, price: facts.price };
}

/* ---------- the second wave ---------- */

const jobs = new Map();
export const getDispoJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }

/**
 * secondWaveCandidates({ store, locationId, saved, now }) → [{ offer, blastedAt }]
 *
 * Live deals blasted once from the app, with nobody committed, whose blast
 * is older than the wave delay. Pure read.
 */
export async function secondWaveCandidates({ store = defaultStore, locationId, saved = {}, now = Date.now() }) {
  const da = normalizeDispoAutopilot(saved.dispoAutopilot);
  const deals = await store.listDeals(locationId).catch(() => []);
  const out = [];
  for (const o of deals) {
    const d = o.deal || {};
    if (!["under_contract"].includes(d.stage)) continue;
    const blasts = Array.isArray(d.blasts) ? d.blasts : [];
    if (blasts.length !== 1) continue;
    if ((d.investors || []).some((i) => i.status === "committed")) continue;
    const at = Date.parse(blasts[0].at || "");
    if (!Number.isFinite(at) || now - at < da.secondWaveHours * 3600000) continue;
    out.push({ offer: o, blastedAt: blasts[0].at });
  }
  return out;
}

/**
 * startDispoSweep({ locationId, client, saved, store, deps, now }) → job
 *
 * `deps.matchForDeal(locationId, offer, { fit })` and `deps.blastFromApp(...)`
 * are the dispo router's own functions.
 */
export function startDispoSweep({ locationId, client, saved = {}, store = defaultStore, deps = {}, trigger = "manual", now = Date.now() }) {
  const existing = jobs.get(locationId);
  if (existing?.status === "running") throw Object.assign(new Error("a dispo sweep is already running"), { http: 409 });
  const job = { id: `ds-${Date.now().toString(36)}`, locationId, trigger, status: "running", startedAt: iso(now), finishedAt: null, deals: 0, blasted: 0, results: [], error: null };
  jobs.set(locationId, job);
  (async () => {
    const da = normalizeDispoAutopilot(saved.dispoAutopilot);
    const cands = await secondWaveCandidates({ store, locationId, saved, now });
    job.deals = cands.length;
    for (const { offer } of cands) {
      try {
        const m = await deps.matchForDeal(locationId, offer, { fits: ["possible"], exclude: "blasted" });
        const picked = (m.results || []).slice(0, da.secondWaveCount);
        if (!picked.length) { job.results.push({ offerId: offer.id, address: offer.address, blasted: 0, reason: "no possible fits left" }); continue; }
        const r = await deps.blastFromApp({ locationId, client, offer, investors: picked, saved, now, wave: 2 });
        job.blasted += r.queued + r.drafted;
        job.results.push({ offerId: offer.id, address: offer.address, blasted: r.queued + r.drafted, scheduled: r.scheduled, reason: r.reason });
      } catch (e) {
        job.results.push({ offerId: offer.id, address: offer.address, blasted: 0, reason: String(e?.message || e).slice(0, 160) });
      }
    }
    job.status = "done"; job.finishedAt = new Date().toISOString();
  })().catch((e) => { job.status = "error"; job.error = String(e?.message || e).slice(0, 300); job.finishedAt = new Date().toISOString(); });
  return job;
}

export async function maybeStartDispoSweep({ locationId, client, saved = {}, store = defaultStore, deps = {}, utcHour = DISPO_SWEEP_UTC_HOUR, now = Date.now() }) {
  if (new Date(now).getUTCHours() !== utcHour) return false;
  const da = normalizeDispoAutopilot(saved.dispoAutopilot);
  if (!da.autoBlastOnPromote) return false;
  if (jobs.get(locationId)?.status === "running") return false;
  const cursor = await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null);
  if (cursor?.at && now - Date.parse(cursor.at) < MIN_GAP_MS) return false;
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: {} }).catch(() => {});
  startDispoSweep({ locationId, client, saved, store, deps, trigger: "daily", now });
  return true;
}
