// promise-driver.js — the machine keeping its own promises.
//
// shared/promise-resolver.js says what should happen to a promise we made; on
// Today that is a row with a button. With `conversationAi.driver.promises`
// on (off by default; the autonomy dial turns it on at Normal) the machine
// presses the button itself:
//
//   send_number       the offer is priced and nothing went out → float it, the
//                     way a finished underwrite floats it (deps.floatOffer)
//   start_underwrite  we promised a number and nothing ever ran → start it
//                     (deps.startUnderwrite: daily cap, queue if capped, a dry
//                     run unless AUTO_UNDERWRITE_ENABLED)
//   ask_numbers       held on something their numbers answer, never asked →
//   rerun             one take_ask / a re-run on the numbers they gave. Both
//                     through carryOutHeldVerdict, so the claim is the nightly
//                     held sweep's own and neither can repeat the other.
//
// `wait`, `not_owed` and `yours` are left exactly where they are.
//
// Everything it starts is a draft in the ordinary lane: the gates, the
// auto-send list, the daily caps and CARD_SENDS_ENABLED decide whether it
// leaves. Runs on the promise sweep's tick and working hours, and straight
// away for one contact when an underwrite finishes (`only`).
//
// Log lines and results carry ids and move names only.

import { recordEvent } from "./contact-record.js";
import { conversationConfig } from "./reply-agent.js";
import { listJobs as listUnderwriteJobs } from "./auto-underwrite.js";
import { getContact as ghlGetContact, searchOpportunities as ghlSearchOpportunities, smsUnsubscribed } from "./ghl.js";
import { carryOutHeldVerdict } from "./held-underwrites.js";
import { triageHeldUnderwrite } from "./shared/held-underwrites.js";
import { aiHoldReasons, effectiveStatus } from "./shared/offer-status.js";
import { openPromises, resolvePromise, PROMISE_WINDOW_HOURS } from "./shared/promise-resolver.js";

const HOUR_MS = 3600000;
const iso = (ms) => new Date(ms).toISOString();

// The reply agent may start the underwrite itself in the minute after it
// promises a number ("number first"); give it room before starting another.
export const DRIVER_GRACE_MIN = 30;
const ACTING = new Set(["send_number", "start_underwrite", "ask_numbers", "rerun"]);

/**
 * driveOpenPromises({ client, locationId, saved, store, sendsEnabled, deps, now, only })
 *   → { considered, started, results, reason }
 *
 * `only` is a contactId: drive that contact's promise and nobody else's.
 */
export async function driveOpenPromises({ client = null, locationId, saved = {}, store, sendsEnabled = false, deps = {}, now = Date.now(), only = null }) {
  const out = { considered: 0, started: 0, results: [], reason: "" };
  const config = conversationConfig(saved || {});
  if (!config.enabled) return { ...out, reason: "Conversation AI is switched off" };
  if (!config.driver?.promises?.enabled) return { ...out, reason: "the promise driver is switched off" };

  const jobsFor = typeof deps.listUnderwriteJobs === "function" ? deps.listUnderwriteJobs : listUnderwriteJobs;
  const getContact = typeof deps.getContact === "function" ? deps.getContact : (id) => ghlGetContact(client, id);
  const searchOpps = typeof deps.searchOpportunities === "function" ? deps.searchOpportunities : (q) => ghlSearchOpportunities(client, locationId, q);
  const botOffTags = (config.routing?.botOffTags || []).map((t) => String(t).toLowerCase());

  const events = await store.listContactEventsSince(locationId, iso(now - PROMISE_WINDOW_HOURS * HOUR_MS), {
    types: ["promise_made", "promise_owed", "promise_kept"], limit: 5000,
  }).catch(() => []);

  for (const p of openPromises(events, { now, windowHours: PROMISE_WINDOW_HOURS })) {
    if (only && p.contactId !== only) continue;
    out.considered++;
    const row = { contactId: p.contactId, move: null, status: "", reason: "", jobId: null };
    out.results.push(row);
    try {
      if (now - Date.parse(p.since) < DRIVER_GRACE_MIN * 60000) { row.status = "waiting"; row.reason = "just promised"; continue; }

      const [offers, drafts, timeline] = await Promise.all([
        store.listOffers(locationId, { contactId: p.contactId, limit: 50, lean: true }).catch(() => []),
        store.listReplyDrafts(locationId, { contactId: p.contactId, limit: 40 }).catch(() => []),
        store.listContactEvents(locationId, p.contactId, { limit: 300 }).catch(() => []),
      ]);
      // The brake, in its smallest form: nobody who told us to stop is driven.
      if (timeline.some((e) => e?.type === "unsubscribed")) { row.status = "stopped"; row.reason = "they unsubscribed"; continue; }

      // The held triage needs GHL's word on them (unsubscribed, bot-off tag, a
      // lost opportunity) before anything is asked or re-run: the same two
      // reads the nightly sweep makes, and only when a hold is in the way.
      const held = offers.filter((o) => effectiveStatus(o) === "draft" && aiHoldReasons(o).length);
      const heldTriageByOffer = {};
      if (held.length) {
        let contact = null, opportunities = [];
        try { const c = await getContact(p.contactId); contact = { tags: c?.tags || [], dnd: typeof c?.dnd === "boolean" ? c.dnd : smsUnsubscribed(c) }; } catch { contact = null; }
        try { opportunities = (await searchOpps({ contactId: p.contactId })) || []; } catch { opportunities = []; }
        if (contact?.dnd) { row.status = "stopped"; row.reason = "they unsubscribed"; continue; }
        for (const o of held) heldTriageByOffer[o.id] = triageHeldUnderwrite({ offer: o, siblings: offers, events: timeline, drafts, contact, opportunities, botOffTags, now });
      }

      const jobs = (jobsFor(locationId, { contactId: p.contactId }) || []).map((j) => ({ ...j, contactId: j.contactId || p.contactId }));
      const v = resolvePromise({ promise: p, offers, drafts, jobs, heldTriageByOffer, now });
      row.move = v.move;
      if (!ACTING.has(v.move)) { row.status = "left"; row.reason = v.reason || ""; continue; }

      if (v.move === "ask_numbers" || v.move === "rerun") {
        const offer = offers.find((o) => o.id === v.offerId);
        const r = await carryOutHeldVerdict({ client, locationId, saved, store, sendsEnabled, deps, offer, triage: heldTriageByOffer[v.offerId], now });
        row.status = r.status; row.reason = r.reason || ""; row.jobId = r.jobId;
        if (r.status === "started" || r.status === "queued") out.started++;
        continue;
      }

      // Claimed first, keyed on the promise: a second broker or the next tick
      // can never float or start it twice.
      const claim = await recordEvent({
        store, locationId, contactId: p.contactId, party: "agent", type: "audit_action", at: iso(now), address: p.address || "",
        offerId: v.offerId || null, source: "sweep", dedupeKey: `audit:promise_${v.move}:${p.contactId}:${p.since}`,
        data: { kind: `promise_${v.move}`, action: v.move, why: v.reason || "" },
      }).catch(() => ({ inserted: false }));
      if (!claim.inserted) { row.status = "claimed"; continue; }

      if (v.move === "send_number") {
        if (typeof deps.floatOffer !== "function") { row.status = "skipped"; row.reason = "the float is not wired"; continue; }
        const r = await deps.floatOffer({ offerId: v.offerId });
        if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; } else { row.status = "started"; row.jobId = r?.job?.id || null; out.started++; }
      } else {
        if (typeof deps.startUnderwrite !== "function") { row.status = "skipped"; row.reason = "the underwriter is not wired"; continue; }
        const r = await deps.startUnderwrite({ contactId: p.contactId, message: "", address: p.address, askingPrice: 0, replaceOfferId: null });
        if (r?.skipped) { row.status = "skipped"; row.reason = r.skipped; }
        else { row.status = r?.queued ? "queued" : "started"; row.jobId = r?.job?.id || null; out.started++; }
      }
    } catch (e) {
      row.status = "error";
      row.reason = String(e?.message || e).slice(0, 160);
    }
  }
  return out;
}

/**
 * promiseClaimed(events, promise) → boolean
 * Whether the driver has already moved on this promise, so the promise sweep
 * doesn't also text "still working on it" in the same hour.
 */
export function promiseClaimed(events = [], promise) {
  const since = String(promise?.since || "");
  return events.some((e) => e?.type === "audit_action" && e.contactId === promise?.contactId && String(e.at) >= since
    && (String(e.dedupeKey || "").startsWith("audit:promise_") || e.data?.kind === "held_ask" || e.data?.kind === "held_rerun"));
}
