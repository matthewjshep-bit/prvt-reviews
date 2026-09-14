// promise-sweep.js — "I'll get back to you with a number", kept.
//
// On 2026-09-14 the bot told eleven agents it would come back with a number or
// an answer "today". For several of them nothing ran and nothing came back:
// Emily Cressey's structure question, Foster's "how much under 400k", Shawn
// Filer's house whose underwrite held on zero comps. The promise lived only in
// the text.
//
// Now a sent reply that promises something leaves a `promise_made` event with
// a due time (reply-agent.js sendReplyDraft, shared/follow-up.js
// detectPromise). This sweep, on the broker's 15-minute tick, reads the open
// promises per contact:
//
//   kept    numbers went out after the promise (a realm check, a take check,
//           an offer) → `promise_kept`, and the Today row clears.
//   waiting not due yet, or an underwrite for them is still running.
//   owed    due and nothing went out → `promise_owed` (Today, "Owed a
//           number") and a `promise_due` text that keeps our word honestly —
//           asking for their value and repairs when our underwrite held.
//
// One owed text per open promise run, claimed by a unique dedupe key, so a
// second broker or a second tick can never send it twice.

import { recordEvent } from "./contact-record.js";
import { conversationConfig, startProactive } from "./reply-agent.js";
import { listJobs as listUnderwriteJobs } from "./auto-underwrite.js";
import { addressKey } from "./shared/us-address.js";
import { aiHoldReasons, effectiveStatus } from "./shared/offer-status.js";

const HOUR_MS = 3600000;
// Older than this, the thread has moved on and a "we owe you" would be odd.
export const PROMISE_WINDOW_HOURS = 72;
// An underwrite still running past the due time gets this long to land.
export const RUNNING_GRACE_HOURS = 8;
// Texts only go out in the working day.
export const PROMISE_HOURS = { start: 8, end: 19, timeZone: "America/Los_Angeles" };

// What counts as having kept a promise: our numbers went out.
const NUMBER_KINDS = new Set(["realm_check", "take_check"]);

const iso = (ms) => new Date(ms).toISOString();

export function localHour(now, timeZone = PROMISE_HOURS.timeZone) {
  return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(new Date(now)));
}

/**
 * runPromiseSweep({ client, locationId, saved, store, sendsEnabled, deps, now })
 *   → { considered, kept, waiting, owed, started, results }
 */
export async function runPromiseSweep({ client, locationId, saved = {}, store, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const out = { considered: 0, kept: 0, waiting: 0, owed: 0, started: 0, results: [] };
  const config = conversationConfig(saved || {});
  if (!config.enabled || !config.parties?.agent?.followUp?.enabled) return out;

  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;
  const jobsFor = typeof deps.listUnderwriteJobs === "function" ? deps.listUnderwriteJobs : listUnderwriteJobs;

  const events = await store.listContactEventsSince(locationId, iso(now - PROMISE_WINDOW_HOURS * HOUR_MS), {
    types: ["promise_made", "promise_owed", "promise_kept", "offer_sent"], limit: 5000,
  }).catch(() => []);
  const byContact = new Map();
  for (const e of events) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }

  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const lastKept = list.filter((e) => e.type === "promise_kept").at(-1)?.at || "";
    const open = list.filter((e) => e.type === "promise_made" && String(e.at) > lastKept);
    const owed = list.filter((e) => e.type === "promise_owed" && String(e.at) >= lastKept).at(-1) || null;
    if (!open.length && !owed) continue;
    out.considered++;
    const since = open[0]?.at || owed.at;
    const address = [...open].reverse().find((p) => p.address)?.address || owed?.address || "";

    // Kept: our numbers went out after the earliest open promise.
    const sent = await store.listReplyDrafts(locationId, { contactId, status: "sent", limit: 30 }).catch(() => []);
    const numbers = sent.find((d) => d?.status === "sent" && NUMBER_KINDS.has(d.outbound?.kind || d.intent)
      && String(d.sentAt || d.updatedAt || "") > String(since));
    const offer = list.find((e) => e.type === "offer_sent" && String(e.at) > String(since));
    if (numbers || offer) {
      await recordEvent({
        store, locationId, contactId, party: "agent", type: "promise_kept", at: iso(now), address,
        source: "conversation", ref: numbers?.id || offer?.id || null,
        dedupeKey: `promise_kept:${contactId}:${since}`,
        data: { by: numbers ? (numbers.outbound?.kind || numbers.intent) : "offer_sent" },
      });
      out.kept++;
      out.results.push({ contactId, address, status: "kept" });
      continue;
    }
    // Already said so once. Today carries it from here; no second text.
    if (owed) { out.results.push({ contactId, address, status: "owed", reason: "already told them" }); continue; }

    const due = open.find((p) => Date.parse(p.data?.dueAt || "") <= now);
    if (!due) { out.waiting++; out.results.push({ contactId, address, status: "waiting", reason: "not due yet" }); continue; }

    const live = (jobsFor(locationId, { contactId }) || []).find((j) => j?.status === "running" || j?.status === "queued");
    if (live && now - Date.parse(due.data.dueAt) < RUNNING_GRACE_HOURS * HOUR_MS) {
      out.waiting++;
      out.results.push({ contactId, address, status: "waiting", reason: "the underwrite is still running" });
      continue;
    }

    // Why our numbers are stuck, when they are: a held underwrite on that house.
    const key = address ? addressKey(address) : "";
    const book = await store.listOffers(locationId, { contactId, limit: 50, lean: true }).catch(() => []);
    const held = (book || []).find((o) => o && effectiveStatus(o) === "draft" && (!key || addressKey(o.address || "") === key) && aiHoldReasons(o).length);
    const heldReason = held ? String(aiHoldReasons(held)[0]).split(" — ")[0].slice(0, 120) : "";
    const what = open.some((p) => p.data?.what === "number") ? "number" : "answer";

    const claim = await recordEvent({
      store, locationId, contactId, party: "agent", type: "promise_owed", at: iso(now), address,
      offerId: held?.id || null, source: "conversation", ref: due.ref || null,
      dedupeKey: `promise_owed:${contactId}:${since}`,
      data: { what, heldReason, text: String(due.data?.text || "").slice(0, 200), draftId: due.data?.draftId || null, dueAt: due.data?.dueAt || null },
    });
    if (!claim.inserted) continue;
    out.owed++;

    const r = await start({
      client, locationId, saved, store, contactId, kind: "promise_due", offer: null,
      subject: { address, what, heldReason, promisedText: String(due.data?.text || "").slice(0, 160), running: Boolean(live) },
      sendsEnabled, deps,
    }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
    if (r?.skipped) {
      out.results.push({ contactId, address, status: "owed", reason: `no text: ${r.skipped}` });
    } else {
      out.started++;
      out.results.push({ contactId, address, status: "owed", jobId: r?.job?.id || null });
    }
  }
  return out;
}

/* ---------- check-ins they asked for ---------- */

// A request stands this long; "in a month" is the longest one we read.
export const CHECKIN_WINDOW_DAYS = 45;
// A deal source hears from us weekly, this many times, until they reply.
export const SOURCE_REPEAT_DAYS = 7;
export const SOURCE_TOUCHES = 6;

/**
 * runCheckInSweep({ client, locationId, saved, store, sendsEnabled, deps, now })
 *   → { considered, sent, answered, results }
 *
 * `checkin_requested` events come from the reply agent: a day they named
 * ("this Wednesday"), or an agent who offered to send us deals (weekly). When
 * one is due and they haven't texted since it was made, one `checkin_due` text
 * goes, claimed by `checkin_sent`. A source's next week is written as it goes.
 */
export async function runCheckInSweep({ client, locationId, saved = {}, store, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const out = { considered: 0, sent: 0, answered: 0, results: [] };
  const config = conversationConfig(saved || {});
  if (!config.enabled || !config.parties?.agent?.followUp?.enabled) return out;
  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;

  const events = await store.listContactEventsSince(locationId, iso(now - CHECKIN_WINDOW_DAYS * 86400000), {
    types: ["checkin_requested", "checkin_sent", "text_summary", "call_summary"], limit: 5000,
  }).catch(() => []);
  const byContact = new Map();
  for (const e of events) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }

  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const req = list.filter((e) => e.type === "checkin_requested").at(-1);
    if (!req) continue;
    if (list.some((e) => e.type === "checkin_sent" && e.data?.requestAt === req.at)) continue;
    if (Date.parse(req.data?.dueAt || "") > now) continue;
    out.considered++;
    // They came back on their own after asking: nothing to chase.
    if (list.some((e) => (e.type === "text_summary" || e.type === "call_summary") && String(e.at) > String(req.at))) {
      out.answered++;
      out.results.push({ contactId, status: "answered" });
      continue;
    }
    const claim = await recordEvent({
      store, locationId, contactId, party: "agent", type: "checkin_sent", at: iso(now), address: req.address || "",
      source: "conversation", dedupeKey: `checkin_sent:${contactId}:${req.at}`,
      data: { requestAt: req.at, kind: req.data?.kind || "date", phrase: req.data?.phrase || "" },
    });
    if (!claim.inserted) continue;
    const r = await start({
      client, locationId, saved, store, contactId, kind: "checkin_due", offer: null,
      subject: { address: req.address || "", phrase: req.data?.phrase || "", sourceKind: req.data?.kind || "date" },
      sendsEnabled, deps,
    }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
    if (r?.skipped) out.results.push({ contactId, status: "skipped", reason: r.skipped });
    else { out.sent++; out.results.push({ contactId, status: "sent", jobId: r?.job?.id || null }); }
    // A deal source's next week.
    const left = Number(req.data?.left) || 0;
    if (req.data?.kind === "source" && left > 0) {
      await recordEvent({
        store, locationId, contactId, party: "agent", type: "checkin_requested", at: iso(now), address: req.address || "",
        source: "conversation", dedupeKey: `checkin_requested:source:${contactId}:${iso(now).slice(0, 10)}`,
        data: { kind: "source", phrase: "", dueAt: iso(now + SOURCE_REPEAT_DAYS * 86400000), left: left - 1 },
      });
    }
  }
  return out;
}

const inFlight = new Set();

/**
 * maybeRunPromiseSweep(...) → result | null
 *
 * The tick's decision: working hours only, one at a time per location.
 */
export async function maybeRunPromiseSweep({ client, locationId, saved = {}, store, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const h = localHour(now);
  if (h < PROMISE_HOURS.start || h >= PROMISE_HOURS.end) return null;
  if (inFlight.has(locationId)) return null;
  inFlight.add(locationId);
  try {
    const promises = await runPromiseSweep({ client, locationId, saved, store, sendsEnabled, deps, now });
    const checkins = await runCheckInSweep({ client, locationId, saved, store, sendsEnabled, deps, now });
    return { ...promises, checkins: checkins.sent };
  } finally {
    inFlight.delete(locationId);
  }
}
