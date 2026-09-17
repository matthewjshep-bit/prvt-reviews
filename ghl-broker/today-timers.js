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
//                     is live.
//
// Every move is claimed first (`audit_action`), keyed on the offer or the
// run, so a second pass or a second broker starts nothing twice. This file
// reads no environment switch and sets none.

import { recordEvent } from "./contact-record.js";
import { conversationConfig } from "./reply-agent.js";
import { listJobs as listUnderwriteJobs, publicJob } from "./auto-underwrite.js";
import { buildPipeline, timerMoves } from "./shared/pipeline.js";
import { threadHealth } from "./shared/thread-health.js";

const iso = (ms) => new Date(ms).toISOString();
const CLAIM_KEY = {
  float: (m) => `audit:timer_float:${m.offerId}`,
  mark_no_response: (m) => `audit:timer_quiet:${m.offerId}`,
  retry_underwrite: (m) => `audit:timer_uw_retry:${m.jobId}`,
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
  const [offers, drafts] = await Promise.all([
    store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []),
    store.listReplyDrafts(locationId, { status: ["draft", "scheduled"], limit: 500 }).catch(() => []),
  ]);
  const actions = buildPipeline({ offers, drafts, events: [], jobs: jobsFor(locationId) || [], config, now }).actions;

  for (const m of timerMoves(actions, { config, now })) {
    out.considered++;
    const row = { kind: m.kind, move: m.move, offerId: m.offerId, jobId: m.jobId, contactId: m.contactId, status: "", reason: "" };
    out.results.push(row);
    try {
      if (!m.due) { row.status = "waiting"; row.reason = `due ${m.dueAt}`; continue; }
      if (m.move === "float") {
        const [theirs, timeline] = await Promise.all([
          store.listReplyDrafts(locationId, { contactId: m.contactId, limit: 40 }).catch(() => []),
          store.listContactEvents(locationId, m.contactId, { limit: 300 }).catch(() => []),
        ]);
        const health = threadHealth({ offer: offers.find((o) => o.id === m.offerId) || null, drafts: theirs, events: timeline, now });
        if (!health.drive) { row.status = "stopped"; row.reason = health.reason; continue; }
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
        const r = await deps.startUnderwrite({ contactId: m.contactId, message: "", address: m.address, askingPrice: m.askingPrice || 0, replaceOfferId: m.offerId || null });
        if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; } else { row.status = r?.queued ? "queued" : "started"; out.started++; }
      }
    } catch (e) {
      row.status = "error"; row.reason = String(e?.message || e).slice(0, 160);
    }
  }
  return out;
}
