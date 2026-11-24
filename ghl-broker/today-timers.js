// today-timers.js — rows on Today the machine clears by itself after a wait.
//
// shared/pipeline.js `timerMoves` is the table (what, and when); the Today row
// reads it for its "Next:" line and this runner carries it out, so the two
// can never disagree. `conversationAi.driver.timers` (off by default; the
// autonomy dial turns it on at Normal). It rides the daytime pass
// (conversation-audit.js, mode "day"): one gate, one cursor, working hours.
//
//   float             deps.floatOffer — the step a finished underwrite takes,
//                     with its "our offer already went out" guard. Asks the
//                     brake first: it is the machine starting a text.
//   mark_no_response  deps.setOfferStatus, the door the board's own button
//                     uses, so tags, the GHL mirror and the promise settle all
//                     fire. Not braked: it ends a thread, it doesn't push one.
//   retry_underwrite  deps.startUnderwrite, once per failed run: the daily
//                     cap, queued if capped, a dry run unless the underwriter
//                     is live. Since 2026-11-23 (audit AH-2) also the book's
//                     "stopped early" drafts (shared/underwrite-retry.js
//                     storedRetries), which outlive a redeploy, and a key its
//                     provider rejected once the key check (key-health.js)
//                     says it's good again. Once per row (retriedAt), and
//                     never on a house with a number already on it.
//
// Every move is claimed first (`audit_action`), keyed on the offer or the
// run, so a second pass or a second broker starts nothing twice. This file
// reads no environment switch and sets none.

import { recordEvent } from "./contact-record.js";
import { conversationConfig } from "./reply-agent.js";
import { listJobs as listUnderwriteJobs, publicJob } from "./auto-underwrite.js";
import { buildPipeline, timerMoves } from "./shared/pipeline.js";
import { threadHealth } from "./shared/thread-health.js";
import { blockingDraft, blockingReason } from "./shared/follow-up.js";
import { holdFor } from "./bot-hold.js";
import { holdLine } from "./shared/bot-hold.js";
import { storedRetries, houseSettled } from "./shared/underwrite-retry.js";
import { KEY_HEALTH_CURSOR } from "./shared/machine-health.js";

const iso = (ms) => new Date(ms).toISOString();
const SPOKE_DAYS = 7;
const CLAIM_KEY = {
  float: (m) => `audit:timer_float:${m.offerId}`,
  mark_no_response: (m) => `audit:timer_quiet:${m.offerId}`,
  retry_underwrite: (m) => `audit:timer_uw_retry:${m.jobId}`,
  retry_stored: (m) => `audit:timer_uw_retry:offer:${m.offerId}`,
};

/**
 * runTodayTimers({ client, locationId, saved, store, deps, now })
 *   → { considered, started, results: [{ kind, move, status, reason }], reason }
 */
export async function runTodayTimers({ client = null, locationId, saved = {}, store, deps = {}, now = Date.now() }) {
  const out = { considered: 0, started: 0, results: [], reason: "" };
  const config = conversationConfig(saved || {});
  if (!config.enabled) return { ...out, reason: "Conversation AI is switched off" };
  if (!config.driver?.timers?.enabled) return { ...out, reason: "the timers are switched off" };

  const jobsFor = typeof deps.listUnderwriteJobs === "function" ? deps.listUnderwriteJobs : (loc) => listUnderwriteJobs(loc, { limit: 100 }).map(publicJob);
  // The held drafts on their own, as Today's read takes them (routes/dashboard.js,
  // 2026-11-09): a blast's hundreds of scheduled texts never push one out.
  const [offers, held, scheduled, spoke] = await Promise.all([
    store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []),
    store.listReplyDrafts(locationId, { status: "draft", limit: 5000 }).catch(() => []),
    store.listReplyDrafts(locationId, { status: "scheduled", limit: 500 }).catch(() => []),
    // Your own texts and the calls of the last week (2026-11-09): the
    // pipeline's "you already texted them" guard reads these, so the timer
    // never floats a rough first pass after you gave them a number.
    Promise.resolve(store.listContactEventsSince?.(locationId, iso(now - SPOKE_DAYS * 86400000), { types: ["hand_reply", "call_summary"], limit: 5000 })).catch(() => []),
  ]);
  const drafts = [...held, ...scheduled];
  const events = (spoke || []).filter((e) => e?.contactId).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const actions = buildPipeline({ offers, drafts, events, jobs: jobsFor(locationId) || [], config, now }).actions;
  // The key check's last word on each paid key (key-health.js): a run that
  // died on a rejected key is retried only once that key is good again.
  const keyHealth = (await Promise.resolve(store.getJobCursor?.(locationId, KEY_HEALTH_CURSOR)).catch(() => null))?.doc || {};
  // A retry stamps its row first, so the run's own redraft keeps the stamp
  // and the book's pass below never runs it a second time.
  const stampRetried = async (offerId) => {
    if (!offerId) return;
    const full = await Promise.resolve(store.getOffer?.(offerId)).catch(() => null);
    if (!full || full.locationId !== locationId) return;
    await store.updateOffer(full.id, { ...full, autoUnderwrite: { ...(full.autoUnderwrite || {}), retriedAt: iso(now) } });
  };
  const retried = new Set();

  for (const m of timerMoves(actions, { config, now, keyHealth })) {
    out.considered++;
    const row = { kind: m.kind, move: m.move, offerId: m.offerId, jobId: m.jobId, contactId: m.contactId, status: "", reason: "" };
    out.results.push(row);
    try {
      if (!m.due) { row.status = "waiting"; row.reason = `due ${m.dueAt}`; continue; }
      // You stopped the bot on them (shared/bot-hold.js): nothing floats, and
      // the offer isn't marked "no response" while you hold the thread. Not
      // claimed — each claim is once ever — so it happens after Resume.
      if (m.contactId && (m.move === "float" || m.move === "mark_no_response")) {
        const hold = await holdFor({ store, locationId, contactId: m.contactId, offerId: m.offerId || null, now });
        if (hold.held) { row.status = "stopped"; row.reason = holdLine(hold); continue; }
      }
      // A house with a number on it already — Matt's, a later row's, one
      // that went out, or a pass — is never underwritten again (2026-11-23):
      // a second engine number could quote above what they were sent.
      if (m.move === "retry_underwrite") {
        const self = offers.find((o) => o.id === m.offerId) || { id: m.offerId || null, contactId: m.contactId, address: m.address, createdAt: iso(now) };
        const settled = houseSettled(self, offers);
        if (settled) { row.status = "skipped"; row.reason = settled; continue; }
      }
      if (m.move === "float") {
        const [theirs, timeline] = await Promise.all([
          store.listReplyDrafts(locationId, { contactId: m.contactId, limit: 40 }).catch(() => []),
          store.listContactEvents(locationId, m.contactId, { limit: 300 }).catch(() => []),
        ]);
        const health = threadHealth({ offer: offers.find((o) => o.id === m.offerId) || null, drafts: theirs, events: timeline, now });
        if (!health.drive) { row.status = "stopped"; row.reason = health.reason; continue; }
        // Their text (or your own draft) waiting in the outbox holds the float,
        // unclaimed: the next pass floats it once that row is dealt with.
        const waiting = blockingDraft(theirs.filter((d) => !d?.contactId || d.contactId === m.contactId));
        if (waiting) { row.status = "waiting"; row.reason = blockingReason(waiting); continue; }
      }
      const claim = await recordEvent({
        store, locationId, contactId: m.contactId, party: "agent", type: "audit_action", at: iso(now), address: m.address || "",
        offerId: m.offerId || null, source: "sweep", dedupeKey: CLAIM_KEY[m.move](m), data: { kind: `timer_${m.move}`, action: m.move, why: m.what },
      }).catch(() => ({ inserted: false }));
      if (!claim.inserted) { row.status = "claimed"; continue; }

      if (m.move === "float") {
        if (typeof deps.floatOffer !== "function") { row.status = "skipped"; row.reason = "the float is not wired"; continue; }
        const r = await deps.floatOffer({ offerId: m.offerId });
        if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; } else { row.status = "started"; out.started++; }
      } else if (m.move === "mark_no_response") {
        if (typeof deps.setOfferStatus !== "function") { row.status = "skipped"; row.reason = "offer statuses are not wired"; continue; }
        const r = await deps.setOfferStatus({ contactId: m.contactId, addressHint: m.address, status: "no_response", note: `gone quiet ${config.driver.timers.goneQuietDays}+ days, marked by the timers` });
        if (r?.ok === false) { row.status = "skipped"; row.reason = r.reason || "the status was refused"; } else { row.status = "started"; out.started++; }
      } else {
        if (typeof deps.startUnderwrite !== "function") { row.status = "skipped"; row.reason = "the underwriter is not wired"; continue; }
        if (m.offerId) retried.add(m.offerId);
        await stampRetried(m.offerId);
        const r = await deps.startUnderwrite({ contactId: m.contactId, message: "", address: m.address, askingPrice: m.askingPrice || 0, replaceOfferId: m.offerId || null });
        if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; } else { row.status = r?.queued ? "queued" : "started"; out.started++; }
      }
    } catch (e) {
      row.status = "error"; row.reason = String(e?.message || e).slice(0, 160);
    }
  }

  // The book's stopped-early drafts (2026-11-23 audit, AH-2): the runs above
  // are only the ones still in memory, and a redeploy forgets them.
  for (const m of storedRetries(offers, { keyHealth, now })) {
    if (retried.has(m.offerId)) continue;
    out.considered++;
    const row = { kind: "underwrite_stopped_early", move: "retry_underwrite", offerId: m.offerId, jobId: null, contactId: m.contactId, status: "", reason: "" };
    out.results.push(row);
    try {
      if (typeof deps.startUnderwrite !== "function") { row.status = "skipped"; row.reason = "the underwriter is not wired"; continue; }
      const claim = await recordEvent({
        store, locationId, contactId: m.contactId, party: "agent", type: "audit_action", at: iso(now), address: m.address,
        offerId: m.offerId, source: "sweep", dedupeKey: CLAIM_KEY.retry_stored(m),
        data: { kind: "timer_retry_underwrite", action: "retry_underwrite", why: m.failure.auth ? "its key is good again" : "the provider failed, not the house" },
      }).catch(() => ({ inserted: false }));
      if (!claim.inserted) { row.status = "claimed"; continue; }
      await stampRetried(m.offerId);
      const r = await deps.startUnderwrite({ contactId: m.contactId, message: "", address: m.address, askingPrice: m.askingPrice || 0, replaceOfferId: m.offerId });
      if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; } else { row.status = r?.queued ? "queued" : "started"; out.started++; }
    } catch (e) {
      row.status = "error"; row.reason = String(e?.message || e).slice(0, 160);
    }
  }
  return out;
}
