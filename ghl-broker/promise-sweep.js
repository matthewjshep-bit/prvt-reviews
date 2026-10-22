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
import { conversationConfig, startProactive, startReply, machineMayStartFor } from "./reply-agent.js";
import { listJobs as listUnderwriteJobs } from "./auto-underwrite.js";
import { addressKey } from "./shared/us-address.js";
import { aiHoldReasons, effectiveStatus } from "./shared/offer-status.js";
import { triageHeldUnderwrite } from "./shared/held-underwrites.js";
import { openPromises, resolvePromise, normalizePromiseDismissal, promiseWhat, endsWithQuestionToThem, PROMISE_WINDOW_HOURS } from "./shared/promise-resolver.js";
import { keepsOurWord, OWED_WINDOW_DAYS } from "./shared/promise-owed.js";
import { detectPromise, isConditionalPromise, PROMISE_DUE_HOURS, PERSON_PROMISES } from "./shared/follow-up.js";
import { driveOpenPromises, promiseClaimed } from "./promise-driver.js";
import { waitingReason } from "./outbox-guard.js";
import { callEventConnected } from "./shared/talked-to.js";
import { cadenceDays, requestStands, refusesAddress, notAHouse, CADENCE_MAX_DAYS } from "./shared/brush-offs.js";
import { leadCheckInPending, LEAD_MAX_DAYS, LEAD_STALE_DAYS } from "./shared/follow-up.js";
import { offerOwner } from "./shared/agent-pulse.js";
import { annotateCurrent } from "./shared/current-offer.js";
import { allEventsSince } from "./contact-events.js";

const HOUR_MS = 3600000;

/**
 * settlePromise({ store, locationId, contactId, address, by, reason, offerId, now }) → { settled }
 *
 * A promise closed by a person rather than by numbers going out: the offer on
 * that house was marked sent / passed / we passed, or the Today row was
 * dismissed. Writes the same `promise_kept` the sweep writes, so Today's
 * "Owed a number" row clears and the sweep never texts about it again.
 * With an `address`, only a promise about that house (or about no house in
 * particular) is settled — a status on one offer doesn't close what we owe
 * the same agent on another. A dismissal's `reason` ({ code, note }) rides on
 * the event with what we had said, which is what the nightly coach reads.
 */
export async function settlePromise({ store, locationId, contactId, address = "", by = "operator", reason = null, offerId = null, now = Date.now() }) {
  if (!contactId) return { settled: false };
  // As far back as Today's owed row reaches (promise-owed.js), so its
  // Dismiss, and an outcome on the house, close a promise a week old too.
  const back = Math.max(PROMISE_WINDOW_HOURS, OWED_WINDOW_DAYS * 24);
  const events = await store.listContactEventsSince(locationId, new Date(now - back * HOUR_MS).toISOString(), {
    types: ["promise_made", "promise_owed", "promise_kept"], limit: 5000,
  }).catch(() => []);
  const list = events.filter((e) => e?.contactId === contactId).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const lastKept = list.filter((e) => e.type === "promise_kept").at(-1)?.at || "";
  // A call, a time to walk it or the earnest money stays open through the
  // machine's own keeps (a price isn't a call): only a dismissal closes it.
  const personOpen = (e) => e.type === "promise_made" && PERSON_PROMISES.has(e.data?.what)
    && !list.some((k) => k.type === "promise_kept" && k.data?.by === "dismissed" && String(k.at) >= String(e.at));
  const open = list.filter((e) => e.type !== "promise_kept" && (String(e.at) >= lastKept || personOpen(e)));
  if (!open.length) return { settled: false };
  const key = address ? addressKey(address) : "";
  const street = (a) => addressKey(String(a || "").split(",")[0]);
  if (key && !open.some((e) => !e.address || addressKey(e.address) === key || street(e.address) === street(address))) return { settled: false };
  const at = new Date(now).toISOString();
  const why = normalizePromiseDismissal(reason);
  const said = [...open].reverse().find((e) => e.data?.text) || open.at(-1);
  const r = await recordEvent({
    store, locationId, contactId, party: "agent", type: "promise_kept", at, address: address || open.at(-1).address || "",
    offerId, source: "operator", dedupeKey: `promise_kept:${contactId}:${by}:${at}`,
    data: { by, ...(why ? { reason: why, ourText: String(said.data?.text || "").slice(0, 200), draftId: said.data?.draftId || null } : {}) },
  });
  return { settled: Boolean(r?.inserted) };
}
/**
 * notePromiseInHandText({ store, locationId, contactId, text, at, channel }) → { made, kept }
 *
 * A text you typed yourself (the composer, or GHL) is our word too
 * (2026-10-14: several of the numbers nobody delivered were promised by
 * hand). "I'll get back to you today with a number" opens a promise, a price
 * or a pass keeps one — the same events the bot's sends write. Only what
 * it was (number / the written offer / a call, a time to walk it, the
 * earnest money) is kept, never the words. Texts only:
 * an email carries the thread quoted under it.
 */
export async function notePromiseInHandText({ store, locationId, contactId, text, at = new Date().toISOString(), channel = "sms" }) {
  const body = String(text || "");
  if (!contactId || channel !== "sms" || !body.trim()) return { made: false, kept: false };
  const keeps = keepsOurWord(body);
  let kept = false;
  if (keeps) {
    const r = await recordEvent({
      store, locationId, contactId, party: "agent", type: "promise_kept", at: new Date(Date.parse(at) - 1).toISOString(), address: "",
      source: "operator", dedupeKey: `promise_kept:${contactId}:you:${at}`, data: { by: `you_${keeps}` },
    }).catch(() => ({ inserted: 0 }));
    kept = Boolean(r?.inserted);
  }
  const what = detectPromise(body);
  if (what !== "number" && what !== "paper" && !PERSON_PROMISES.has(what)) return { made: false, kept };
  const r = await recordEvent({
    store, locationId, contactId, party: "agent", type: "promise_made", at, address: "",
    source: "operator", dedupeKey: `promise_made:${contactId}:you:${at}`,
    data: { what, by: "you", dueAt: new Date(Date.parse(at) + PROMISE_DUE_HOURS * HOUR_MS).toISOString(), asksThem: endsWithQuestionToThem(body), ...(isConditionalPromise(body) ? { conditional: true } : {}) },
  }).catch(() => ({ inserted: 0 }));
  return { made: Boolean(r?.inserted), kept };
}

/**
 * heldTriageForPromises({ store, locationId, offers, events, config, now }) → { offerId: verdict }
 *
 * For Today: the held-underwrite triage for every held draft an owed promise
 * is waiting on, from local reads only (the contact's timeline and drafts).
 * GHL is not asked, so the triage's tag and stage checks are skipped here;
 * the nightly sweep makes those calls before anything is actually done.
 */
export async function heldTriageForPromises({ store, locationId, offers = [], events = [], config = null, now = Date.now() }) {
  const out = {};
  const botOffTags = (config?.routing?.botOffTags || []).map((t) => String(t).toLowerCase());
  for (const p of openPromises(events, { now, windowHours: PROMISE_WINDOW_HOURS })) {
    if (!p.owedAt) continue;
    const siblings = offers.filter((o) => o?.contactId === p.contactId);
    const held = siblings.filter((o) => effectiveStatus(o) === "draft" && aiHoldReasons(o).length);
    if (!held.length) continue;
    const [timeline, drafts] = await Promise.all([
      store.listContactEvents(locationId, p.contactId, { limit: 300 }).catch(() => []),
      store.listReplyDrafts(locationId, { contactId: p.contactId, limit: 40 }).catch(() => []),
    ]);
    for (const o of held) out[o.id] = triageHeldUnderwrite({ offer: o, siblings, events: timeline, drafts, contact: null, opportunities: [], botOffTags, now });
  }
  return out;
}

// Older than this, the thread has moved on and a "we owe you" would be odd
// (shared/promise-resolver.js owns the number).
export { PROMISE_WINDOW_HOURS };
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
    types: ["promise_made", "promise_owed", "promise_kept", "offer_sent", "audit_action"], limit: 5000,
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
    // A promise you typed yourself is yours to keep: no "still working on
    // it" text in your name. Today's owed row carries it (promise-owed.js).
    // A call, a time to walk it, the earnest money: a person keeps those, and
    // Today carries them (shared/promise-owed.js owedPersonPromises).
    const open = list.filter((e) => e.type === "promise_made" && e.data?.by !== "you" && !PERSON_PROMISES.has(e.data?.what) && String(e.at) > lastKept);
    const owed = list.filter((e) => e.type === "promise_owed" && String(e.at) >= lastKept).at(-1) || null;
    if (!open.length && !owed) continue;
    out.considered++;
    const since = open[0]?.at || owed.at;
    const address = [...open].reverse().find((p) => p.address)?.address || owed?.address || "";

    // What we owe: a number, the written offer ("can have it over today"), or an answer.
    const what = promiseWhat([...open, ...(owed ? [owed] : [])]);
    // Kept: our numbers went out after the earliest open promise. The written
    // offer is kept only by the written offer (an offer_sent), not a float.
    const sent = await store.listReplyDrafts(locationId, { contactId, status: "sent", limit: 30 }).catch(() => []);
    const numbers = what === "paper" ? null : sent.find((d) => d?.status === "sent" && NUMBER_KINDS.has(d.outbound?.kind || d.intent)
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
    // Never owed: our text ended by asking THEM something, or it was an
    // answer we have since given. No "we owe you" text, no Today row, and a
    // row already there clears.
    const mine = openPromises(list, { now, windowHours: PROMISE_WINDOW_HOURS })[0] || null;
    if (mine && resolvePromise({ promise: mine, drafts: sent, now }).move === "not_owed") {
      await recordEvent({
        store, locationId, contactId, party: "agent", type: "promise_kept", at: iso(now), address,
        source: "conversation", dedupeKey: `promise_kept:${contactId}:${since}`, data: { by: "not_owed" },
      });
      out.results.push({ contactId, address, status: "not_owed" });
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

    // Their text (or your own draft) is waiting in the outbox: whoever answers
    // it keeps the promise or says so. Nothing is claimed; the next tick looks again.
    // A stop is not asked here: the claim is what puts "we owe them" on
    // Today, and the text after it is refused at startProactive.
    const waitingOn = await waitingReason({ store, locationId, contactId, hold: false });
    if (waitingOn) { out.waiting++; out.results.push({ contactId, address, status: "waiting", reason: waitingOn }); continue; }
    // A live thread (they texted in the last 48h about a house): the text
    // would be refused at startProactive, and a claim spent on a refusal was
    // never tried again (2026-10-22 audit: most "back to you with a number"
    // promises on houses agents surfaced went unkept this way). Asked first,
    // unclaimed; the next tick asks again.
    const mayStart = typeof deps.machineMayStart === "function" ? deps.machineMayStart : machineMayStartFor;
    const gate = await mayStart({ store, locationId, contactId, kind: "promise_due", address, now }).catch(() => ({ ok: true }));
    if (gate && gate.ok === false && gate.rule === "live_thread") {
      out.waiting++;
      out.results.push({ contactId, address, status: "waiting", reason: gate.reason });
      continue;
    }

    const claim = await recordEvent({
      store, locationId, contactId, party: "agent", type: "promise_owed", at: iso(now), address,
      offerId: held?.id || null, source: "conversation", ref: due.ref || null,
      dedupeKey: `promise_owed:${contactId}:${since}`,
      data: { what, heldReason, text: String(due.data?.text || "").slice(0, 200), draftId: due.data?.draftId || null, dueAt: due.data?.dueAt || null },
    });
    if (!claim.inserted) continue;
    out.owed++;
    // The driver (promise-driver.js) has already moved on this one: floated
    // the number, started the underwrite, asked for theirs. One voice at a
    // time; Today still carries the row, where it reads as waiting.
    if (mine && promiseClaimed(list, mine)) { out.results.push({ contactId, address, status: "owed", reason: "the driver is on it" }); continue; }
    // The written offer is kept by sending it, not by a text saying we're
    // still on it: the driver (when it's on) sends it.
    if (what === "paper") { out.results.push({ contactId, address, status: "owed", reason: "the written offer is owed — the driver sends it" }); continue; }

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
// The furthest back a request can still stand: the longest cadence an agent
// can ask for, plus the two weeks past due it stays good for.
export const CHECKIN_LONGEST_DAYS = CADENCE_MAX_DAYS + 21;
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

  const reply = typeof deps.startReply === "function" ? deps.startReply : startReply;
  const events = await store.listContactEventsSince(locationId, iso(now - CHECKIN_WINDOW_DAYS * 86400000), {
    types: ["checkin_requested", "checkin_sent", "text_summary", "call_summary", "hand_reply"], limit: 5000,
  }).catch(() => []);
  const byContact = new Map();
  for (const e of events) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }
  // A request older than the window that still stands — "check back in a
  // couple months" is due at day 60 (shared/brush-offs.js requestStands) —
  // brings that contact's own events since it was made.
  const windowStart = iso(now - CHECKIN_WINDOW_DAYS * 86400000);
  const longReqs = await store.listContactEventsSince(locationId, iso(now - CHECKIN_LONGEST_DAYS * 86400000), { types: ["checkin_requested"], limit: 5000 }).catch(() => []);
  const newestReq = new Map();
  // (A lead with a date reads its own thirteen months, below.)
  for (const e of longReqs) if (e?.contactId && e.data?.kind !== "lead" && String(e.at) > String(newestReq.get(e.contactId)?.at || "")) newestReq.set(e.contactId, e);
  for (const [contactId, req] of newestReq) {
    if (String(req.at) >= windowStart || !requestStands(req, now)) continue;
    const since = await store.listContactEvents?.(locationId, contactId, { since: req.at, types: ["checkin_sent", "text_summary", "call_summary", "hand_reply"], limit: 500 }).catch(() => []) || [];
    const seen = new Set();
    byContact.set(contactId, [req, ...since, ...(byContact.get(contactId) || [])].filter((e) => {
      const k = e?.id || e?.dedupeKey || `${e?.type}:${e?.at}`;
      return e && !seen.has(k) && seen.add(k);
    }));
  }

  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    // A lead with a date has its own track, below: it neither replaces this
    // one nor is replaced by it.
    const req = list.filter((e) => e.type === "checkin_requested" && e.data?.kind !== "lead").at(-1);
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
    // "If neither of us comes back": one of us did. Gabe Spruell (2026-09-18)
    // got the held nudge Matt sent at 10:14 and this check-in at 10:18 — the
    // sweep only looked for THEIR text, never ours. Claimed, so it is settled
    // rather than asked again every tick.
    if (req.data?.kind === "unanswered") {
      const ours = await store.listReplyDrafts(locationId, { contactId, status: "sent", limit: 20 }).catch(() => []);
      // You answered it yourself (the composer, or typed in GHL): covered too.
      const typed = list.some((e) => e.type === "hand_reply" && String(e.at) > String(req.at));
      if (typed || ours.some((d) => String(d.sentAt || d.updatedAt || "") > String(req.at))) {
        await recordEvent({
          store, locationId, contactId, party: "agent", type: "checkin_sent", at: iso(now), address: req.address || "",
          source: "conversation", dedupeKey: `checkin_sent:${contactId}:${req.at}`,
          data: { requestAt: req.at, kind: "unanswered", covered: true },
        });
        out.answered++;
        out.results.push({ contactId, status: "covered" });
        continue;
      }
    }
    // The "unanswered" check-in is the net under the reply held for a person:
    // it may take THAT draft's place, and no other waiting row's. Anything
    // else waiting holds it, unclaimed, for a later tick.
    const continues = req.data?.kind === "unanswered" ? (req.data?.draftId || null) : null;
    const waitingOn = await waitingReason({ store, locationId, contactId, continues });
    if (waitingOn) { out.results.push({ contactId, status: "waiting", reason: waitingOn }); continue; }
    // Nothing went back to them, and their text is still the last word: it
    // is OUR turn, and a "where do things stand?" check-in answers nothing.
    // 1010 Bellevue (2026-10-04): the agent asked twice for us to come
    // closer to the sellers' number; both replies were held, and both times
    // this clock sent "any chance you can get a real number?" over the top.
    // Their text goes back through the reply path instead, where the
    // counter hold and the auto-send rules decide what goes. The clock is
    // not booked again if it holds a second time: then it is a person's.
    if (req.data?.kind === "unanswered" && req.data?.draftId) {
      const held = await store.getReplyDraft?.(req.data.draftId).catch(() => null);
      if (held && held.contactId === contactId && String(held.inbound || "").trim() && held.dismissedBy !== "you" && held.status !== "sent") {
        const claim = await recordEvent({
          store, locationId, contactId, party: held.party || "agent", type: "checkin_sent", at: iso(now), address: req.address || "",
          source: "conversation", dedupeKey: `checkin_sent:${contactId}:${req.at}`,
          data: { requestAt: req.at, kind: "unanswered", answered: "their text, again" },
        });
        if (!claim.inserted) continue;
        const r = await reply({
          client, locationId, saved, store, contactId, message: String(held.inbound).slice(0, 4000), channel: held.channel === "email" ? "email" : "sms",
          party: held.party || "", sendsEnabled, deps, fromCheckIn: true,
        }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
        if (r?.skipped) out.results.push({ contactId, status: "skipped", reason: r.skipped });
        else { out.sent++; out.results.push({ contactId, status: "re-answered", jobId: r?.job?.id || null }); }
        continue;
      }
    }
    const claim = await recordEvent({
      store, locationId, contactId, party: "agent", type: "checkin_sent", at: iso(now), address: req.address || "",
      source: "conversation", dedupeKey: `checkin_sent:${contactId}:${req.at}`,
      data: { requestAt: req.at, kind: req.data?.kind || "date", phrase: req.data?.phrase || "" },
    });
    if (!claim.inserted) continue;
    const r = await start({
      client, locationId, saved, store, contactId, kind: "checkin_due", offer: null, continues,
      subject: { address: req.address || "", phrase: req.data?.phrase || "", sourceKind: req.data?.kind || "date" },
      sendsEnabled, deps,
    }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
    if (r?.skipped) out.results.push({ contactId, status: "skipped", reason: r.skipped });
    else { out.sent++; out.results.push({ contactId, status: "sent", jobId: r?.job?.id || null }); }
    // A deal source's next week.
    // Not when they've since told us how often to check in: the weekly chain
    // ends and the agent check-in keeps their cadence (checkinEvery).
    const left = Number(req.data?.left) || 0;
    const asked = req.data?.kind === "source" && left > 0
      ? cadenceDays((await store.getContactProfile?.(locationId, contactId).catch(() => null))?.facts) : 0;
    if (req.data?.kind === "source" && left > 0 && !asked) {
      await recordEvent({
        store, locationId, contactId, party: "agent", type: "checkin_requested", at: iso(now), address: req.address || "",
        source: "conversation", dedupeKey: `checkin_requested:source:${contactId}:${iso(now).slice(0, 10)}`,
        data: { kind: "source", phrase: "", dueAt: iso(now + SOURCE_REPEAT_DAYS * 86400000), left: left - 1 },
      });
    }
  }

  /* --- a lead they told us the timing of --- */
  // "Relisting in the spring", "should know by end of the month" (reply-agent.js,
  // shared/follow-up.js detectLeadTiming). Booked up to thirteen months out, so
  // read that far back; their texts and calls come from the window above.
  const leadRead = await allEventsSince(store, locationId, iso(now - (LEAD_MAX_DAYS + LEAD_STALE_DAYS) * 86400000),
    { types: ["checkin_requested", "checkin_sent"] }, { ceiling: 100000 }).catch(() => ({ events: [] }));
  const leadsBy = new Map();
  for (const e of leadRead.events || []) {
    if (!e?.contactId) continue;
    if (!leadsBy.has(e.contactId)) leadsBy.set(e.contactId, []);
    leadsBy.get(e.contactId).push(e);
  }
  for (const [contactId, mine] of leadsBy) {
    if (!mine.some((e) => e.type === "checkin_requested" && e.data?.kind === "lead")) continue;
    const talk = (byContact.get(contactId) || []).filter((e) => ["text_summary", "call_summary", "hand_reply"].includes(e.type));
    const all = [...mine, ...talk];
    const req = leadCheckInPending(all, now);
    if (!req || Date.parse(req.data?.dueAt || "") > now) continue;
    out.considered++;
    // One check-in at a time: another went to them in the last three days.
    const recent = all.some((e) => e.type === "checkin_sent" && Date.parse(e.at) > now - 3 * 86400000);
    if (recent || out.results.some((x) => x.contactId === contactId && (x.status === "sent" || x.status === "re-answered"))) {
      out.results.push({ contactId, status: "waiting", reason: "another check-in just went to them" });
      continue;
    }
    // An offer's own clock (a live deal, an open offer being asked about, a
    // held underwrite) keeps them; the lead goes after it lets go.
    const rows = await store.listOffers(locationId, { contactId, limit: 50, lean: true }).catch(() => []);
    const current = annotateCurrent(rows || []).filter((o) => o && o.isCurrent !== false && o.contactId === contactId);
    const drafts = await store.listReplyDrafts(locationId, { contactId, limit: 20 }).catch(() => []);
    // (The lead itself is not an offer's clock: without this it would wait on itself.)
    const offerEvents = [...(byContact.get(contactId) || [])].filter((e) => !(e.type === "checkin_requested" && e.data?.kind === "lead"));
    const holder = offerOwner({ offers: current, drafts, events: offerEvents, config, now });
    if (holder) { out.results.push({ contactId, status: "waiting", reason: holder }); continue; }
    const waitingOn = await waitingReason({ store, locationId, contactId, continues: null });
    if (waitingOn) { out.results.push({ contactId, status: "waiting", reason: waitingOn }); continue; }
    const claim = await recordEvent({
      store, locationId, contactId, party: "agent", type: "checkin_sent", at: iso(now), address: req.address || "",
      source: "conversation", dedupeKey: `checkin_sent:${contactId}:${req.at}`,
      data: { requestAt: req.at, kind: "lead", phrase: req.data?.phrase || "" },
    });
    if (!claim.inserted) continue;
    const r = await start({
      client, locationId, saved, store, contactId, kind: "checkin_due", offer: null, continues: null,
      subject: { address: req.address || "", phrase: req.data?.phrase || "", sourceKind: "lead", lead: { ...(req.data?.lead || {}), toldAt: req.at } },
      sendsEnabled, deps,
    }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
    if (r?.skipped) out.results.push({ contactId, status: "skipped", reason: r.skipped });
    else { out.sent++; out.results.push({ contactId, status: "sent", kind: "lead", jobId: r?.job?.id || null }); }
  }
  return out;
}

/* ---------- the address they haven't sent yet ---------- */

// Alexandria Goforth (2026-09-15): "I will likely have one in Spanaway soon ...
// seller will want it sold asap once contract with property management company
// ends." A property is coming and we don't have the address. `address_pending`
// (reply-agent.js) starts this ladder; it ends when an address lands on the
// contact (`subject_property_set`), they opt out, or the rungs run out.
export const ADDRESS_CHASE_DAYS = [2, 5, 9, 14, 21, 30];
export const ADDRESS_CHASE_WINDOW_DAYS = 60;
// They're mid-conversation, so the bot is already talking to them.
export const ADDRESS_CHASE_QUIET_HOURS = 36;
// A person working the thread: your own text, or a call (Kyle R.,
// 2026-10-05 — Matt gave a number by phone and text; the chase kept asking).
// A call counts when it connected or when we placed it; their missed call
// (a bare call_summary and an inbound call_attempt) doesn't.
const YOU_TOOK_IT = ["hand_reply", "call_summary", "call_attempt"];
const youTookIt = (e) => e.type === "hand_reply"
  || (e.type === "call_summary" && callEventConnected(e))
  || (e.type === "call_attempt" && (e.source === "operator" || e.data?.direction === "outbound"));
const DAY_MS = 86400000;

// When each rung falls: days from the message, or from the time they named.
export function addressChaseRungs(pending) {
  const made = Date.parse(pending?.at || "");
  const first = Date.parse(pending?.data?.firstDueAt || "");
  if (Number.isFinite(first)) return ADDRESS_CHASE_DAYS.map((d) => first + (d - ADDRESS_CHASE_DAYS[0]) * DAY_MS);
  return ADDRESS_CHASE_DAYS.map((d) => made + d * DAY_MS);
}

/**
 * runAddressChase({ client, locationId, saved, store, sendsEnabled, deps, now })
 *   → { considered, sent, found, waiting, results }
 *
 * One `address_chase` text per rung, claimed by `address_chase_sent`. A sweep
 * that starts late sends only the latest rung that's due, never a backlog.
 */
export async function runAddressChase({ client, locationId, saved = {}, store, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const out = { considered: 0, sent: 0, found: 0, waiting: 0, results: [] };
  const config = conversationConfig(saved || {});
  if (!config.enabled || !config.parties?.agent?.followUp?.enabled) return out;
  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;

  const events = await store.listContactEventsSince(locationId, iso(now - ADDRESS_CHASE_WINDOW_DAYS * DAY_MS), {
    types: ["address_pending", "address_pending_closed", "address_chase_sent", "subject_property_set", "text_summary", "call_summary", ...YOU_TOOK_IT], limit: 5000,
  }).catch(() => []);
  const byContact = new Map();
  for (const e of events) {
    if (!e?.contactId) continue;
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId).push(e);
  }

  for (const [contactId, list] of byContact) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const pending = list.filter((e) => e.type === "address_pending").at(-1);
    if (!pending) continue;
    out.considered++;
    const after = (e) => String(e.at) > String(pending.at);
    if (list.some((e) => after(e) && (e.type === "subject_property_set" || e.type === "address_pending_closed"))) {
      out.found++;
      out.results.push({ contactId, status: "closed" });
      continue;
    }
    // You called or texted them yourself since: the house is yours to work,
    // and the machine asking again talks over you. Written down, so the Desk,
    // the tiers and the audit read it closed too.
    const yours = list.find((e) => after(e) && youTookIt(e));
    if (yours) {
      await recordEvent({
        store, locationId, contactId, party: "agent", type: "address_pending_closed", at: iso(now), address: "",
        source: "conversation", dedupeKey: `address_pending_closed:${contactId}:${pending.at}:you`,
        data: { reason: "you_took_it", by: yours.type, pendingAt: pending.at },
      }).catch(() => {});
      out.found++;
      out.results.push({ contactId, status: "closed", reason: `you ${yours.type === "hand_reply" ? "texted" : "called"} them yourself` });
      continue;
    }
    // Their newest text since says no to giving it (2026-10-14: "Please don't
    // keep asking me" got two more asks; "No, you can see them when they're on
    // the market" got another), or what's coming is land, not a house. The
    // chase ends, on the record; the agent check-in has them from here.
    const lastText = list.filter((e) => after(e) && e.type === "text_summary" && String(e.data?.inbound || "").trim()).at(-1);
    const refused = lastText ? refusesAddress(lastText.data.inbound) : null;
    const land = !refused && notAHouse(pending.data?.hint || "");
    if (refused || land) {
      await recordEvent({
        store, locationId, contactId, party: "agent", type: "address_pending_closed", at: iso(now), address: "",
        source: "conversation", dedupeKey: `address_pending_closed:${contactId}:${pending.at}:${refused ? "refused" : "land"}`,
        data: { reason: refused ? "they_refused" : "not_a_house", why: refused || "it's land, not a house", pendingAt: pending.at },
      }).catch(() => {});
      out.found++;
      out.results.push({ contactId, status: "closed", reason: refused || "it's land, not a house" });
      continue;
    }
    const rungs = addressChaseRungs(pending);
    let due = -1;
    rungs.forEach((t, i) => { if (t <= now) due = i; });
    if (due < 0) { out.waiting++; out.results.push({ contactId, status: "waiting", reason: "not due yet" }); continue; }
    const sentSteps = new Set(list.filter((e) => e.type === "address_chase_sent" && e.data?.pendingAt === pending.at).map((e) => Number(e.data?.step)));
    if (sentSteps.has(due)) continue;
    const lastTalk = list.filter((e) => (e.type === "text_summary" || e.type === "call_summary") && after(e)).at(-1);
    if (lastTalk && now - Date.parse(lastTalk.at) < ADDRESS_CHASE_QUIET_HOURS * HOUR_MS) {
      out.waiting++;
      out.results.push({ contactId, status: "waiting", reason: "they're mid-conversation" });
      continue;
    }
    const waitingOn = await waitingReason({ store, locationId, contactId });
    if (waitingOn) { out.waiting++; out.results.push({ contactId, status: "waiting", reason: waitingOn }); continue; }
    const claim = await recordEvent({
      store, locationId, contactId, party: "agent", type: "address_chase_sent", at: iso(now), address: "",
      source: "conversation", dedupeKey: `address_chase:${contactId}:${pending.at}:${due}`,
      data: { pendingAt: pending.at, step: due, of: rungs.length },
    });
    if (!claim.inserted) continue;
    const r = await start({
      client, locationId, saved, store, contactId, kind: "address_chase", offer: null,
      subject: { address: "", hint: pending.data?.hint || "", phrase: pending.data?.phrase || "", rung: due + 1, rungs: rungs.length,
        houses: Array.isArray(pending.data?.houses) ? pending.data.houses : [] },
      sendsEnabled, deps,
    }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
    if (r?.skipped) out.results.push({ contactId, status: "skipped", reason: r.skipped });
    else { out.sent++; out.results.push({ contactId, status: "sent", rung: due + 1, jobId: r?.job?.id || null }); }
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
    // The driver goes first: a number that is ready goes out instead of
    // "still working on it". A no-op unless driver.promises is switched on.
    const driven = await driveOpenPromises({ client, locationId, saved, store, sendsEnabled, deps, now })
      .catch((e) => ({ started: 0, results: [], reason: String(e?.message || e).slice(0, 160) }));
    const promises = await runPromiseSweep({ client, locationId, saved, store, sendsEnabled, deps, now });
    const checkins = await runCheckInSweep({ client, locationId, saved, store, sendsEnabled, deps, now });
    const chases = await runAddressChase({ client, locationId, saved, store, sendsEnabled, deps, now });
    return { ...promises, driven: driven.started || 0, checkins: checkins.sent, addressChases: chases.sent };
  } finally {
    inFlight.delete(locationId);
  }
}
