// conversation-scheduler.js — when an approved reply actually goes out.
//
// A reply that lands two seconds after the text reads as a bot. One that
// lands in a few minutes, during the hours a person would be at their phone,
// reads as a person — and the gap is also the window in which the operator
// can Hold it from the strip. So an auto-send is never immediate: it is
// scheduled (`sendAt` on the draft, status "scheduled") and a ticker sends it
// when due. State lives in the store, so a redeploy loses nothing and a draft
// scheduled before a restart still goes out on time.

import { answersInbound, MACHINE_STARTED_KINDS, SERVICE_KINDS } from "./shared/follow-up.js";
import { machineWorkday } from "./shared/follow-up-engine.js";
import { scrubMessage } from "./app-errors.js";

// A send GHL refused without taking it goes again after these waits
// (minutes), then comes back to a person like any other failure.
export const SEND_RETRY_MINUTES = [10, 30, 60];
const refusedUnsent = (e) => [429, 503].includes(Number(e?.status)) || /-> (429|503)\b/.test(String(e?.message || ""));

const DAY_MS = 86400000;
export const STUCK_SENDING_MS = 5 * 60 * 1000;

// Which intents a person answers fast, and which they sit with.
export const QUICK_INTENTS = new Set(["question", "small_talk", "status_check", "media", "realm_yes", "interested", "looking_for_deals", "buybox_update", "scheduling", "wants_call", "wants_walkthrough"]);
export const SLOW_INTENTS = new Set(["deal_available", "new_property", "investor_open", "counter", "acceptance", "rejection", "price_pushback", "wants_to_buy", "passing", "proof_of_funds"]);
// Nobody types faster than this; a 300-character reply that lands in 40
// seconds is a bot however long the band says.
export const TYPING_CHARS_PER_SEC = 4;

// A delay somewhere in the band for this intent, never shorter than the
// reply takes to type. `random` is injectable for tests.
export function pickDelayMs(config, random = Math.random, { intent = "", replyLength = 0 } = {}) {
  const a = config?.autoSend || {};
  let min = Math.max(0, Number(a.delayMinSec) || 0);
  let max = Math.max(min, Number(a.delayMaxSec) || min);
  if (QUICK_INTENTS.has(intent) && a.quick) { min = Math.max(0, Number(a.quick.minSec) || 0); max = Math.max(min, Number(a.quick.maxSec) || min); }
  else if (SLOW_INTENTS.has(intent) && a.slow) { min = Math.max(0, Number(a.slow.minSec) || 0); max = Math.max(min, Number(a.slow.maxSec) || min); }
  const picked = min + (max - min) * random();
  const typing = Math.max(0, Number(replyLength) || 0) / TYPING_CHARS_PER_SEC;
  return Math.round(Math.max(picked, typing) * 1000);
}

// Saturday or Sunday, on the wall clock of the zone.
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export const weekdayIn = (ms, timeZone = "UTC") => WEEKDAY_INDEX[new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(ms))];

export function isWeekend(ms, timeZone = "UTC") {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(ms));
  return day === "Sat" || day === "Sun";
}

/**
 * spreadAcrossDay({ now, quietHours, hours, random, weekends, offDays }) → ISO string
 *
 * Somewhere in the first `hours` of the next open window — for the things
 * the machine STARTS (nudges, cold opens, blasts), so a sweep at 9am does
 * not put forty texts on forty phones at 9:02. With weekends "replies_only"
 * or "none", Saturday and Sunday are skipped, and a day on `offDays`
 * ("YYYY-MM-DD", autoSend.offDays) is skipped whatever `weekends` says.
 */
// Days off can run into a weekend (Christmas Eve to the Sunday after), and
// the list holds at most 60: this many rolls always gets past them.
const MAX_DAYS_ROLLED = 70;
export function spreadAcrossDay({ now = Date.now(), quietHours = {}, hours = 8, random = Math.random, weekends = "all", offDays = [] } = {}) {
  const tz = quietHours.timeZone || "UTC";
  let open = Date.parse(nextSendTime({ now, delayMs: 0, quietHours }));
  // Roll to the NEXT day's opening (not the same wall time tomorrow) until
  // it is a day the machine works ("sun_to_fri": Saturday is off) and not a
  // day off.
  let guard = 0;
  while (!machineWorkday(open, { weekends, offDays, tz }) && guard++ < MAX_DAYS_ROLLED) {
    const p = zonedParts(open, tz);
    const nextMidnight = zonedToUtc({ y: p.y, m: p.m, d: p.d, hh: 0, mm: 0 }, tz) + DAY_MS + 60000;
    open = Date.parse(nextSendTime({ now: nextMidnight, delayMs: 0, quietHours }));
  }
  const start = Math.max(open, now);
  // The spread stays inside the day's window: a noon sweep spread over eight
  // hours in a window that shuts at 5pm fills the afternoon instead of
  // rolling a third of its texts onto 8:00 tomorrow in one burst.
  const close = windowCloseAfter(open, quietHours);
  const end = Math.max(start, Math.min(open + Math.max(0, Number(hours) || 0) * 3600000, close ?? Infinity));
  const at = start + (end - start) * random();
  return nextSendTime({ now: at, delayMs: 0, quietHours });
}

// When the sending window that `ms` falls in shuts (a minute early, so a
// text placed there is still inside). Null with no window, or an overnight
// one, where the old rolling still applies. Under two minutes left (a
// one-minute window, 08:00 to 08:01): `ms` itself, so the text goes in what
// is left of it. Until 2026-11 that read as "no close", the spread ran past
// the window, and the text rolled two days instead of one (the 10/12 pause).
function windowCloseAfter(ms, quietHours = {}) {
  const tz = quietHours.timeZone || "UTC";
  const start = hhmmToMinutes(quietHours.start);
  const end = hhmmToMinutes(quietHours.end);
  if (start == null || end == null || start >= end) return null;
  const p = zonedParts(ms, tz);
  const shut = zonedToUtc({ y: p.y, m: p.m, d: p.d, hh: Math.floor(end / 60), mm: end % 60 }, tz);
  const close = shut - 60000;
  if (close > ms) return close;
  return shut > ms ? ms : null;
}

/**
 * machineHours(autoSend) → quietHours
 *
 * The sending window for texts the machine starts on its own: the page's
 * window, shut at `machineUntil` when that comes first (Matt, 2026-10-05:
 * "not send outreach texts after 5pm"). Replies to their texts keep the
 * whole window.
 */
export function machineHours(autoSend = {}) {
  const q = autoSend?.quietHours || {};
  const cut = hhmmToMinutes(autoSend?.machineUntil);
  if (cut == null) return q;
  const start = hhmmToMinutes(q.start);
  const end = hhmmToMinutes(q.end);
  if (start == null || end == null || start === end) return { ...q, start: "08:00", end: autoSend.machineUntil };
  if (start > end || cut <= start || cut >= end) return q;
  return { ...q, end: autoSend.machineUntil };
}

// Wall-clock parts of an instant in a zone, via Intl — the one tz-aware thing
// Node ships. hour12:false can yield "24" for midnight on some ICU builds, so
// it is folded back to 0.
export function zonedParts(ms, timeZone) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = value;
  const hour = Number(p.hour) % 24;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: hour, mm: Number(p.minute), minutes: hour * 60 + Number(p.minute) };
}

// The instant at which a zone's wall clock reads y-m-d hh:mm. Two rounds of
// "guess in UTC, read back in the zone, correct by the difference" converge
// everywhere except inside a DST gap, where the hour doesn't exist and the
// answer is an hour off — accepted, and the operator can always Hold.
export function zonedToUtc({ y, m, d, hh, mm }, timeZone) {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, timeZone);
    guess += want - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  }
  return guess;
}

const hhmmToMinutes = (s) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * nextSendTime({ now, delayMs, quietHours }) → ISO string
 *
 * now + delay when that lands inside the sending window; otherwise the next
 * window opening plus the delay, so the first reply of the morning still
 * doesn't arrive at 08:00:00 sharp. start === end means no window (always
 * open). An overnight window (start > end) is honoured too.
 */
export function nextSendTime({ now = Date.now(), delayMs = 0, quietHours = {} } = {}) {
  const tz = quietHours.timeZone || "UTC";
  const start = hhmmToMinutes(quietHours.start);
  const end = hhmmToMinutes(quietHours.end);
  const candidate = now + delayMs;
  if (start == null || end == null || start === end) return new Date(candidate).toISOString();

  const p = zonedParts(candidate, tz);
  const inside = start < end ? p.minutes >= start && p.minutes < end : p.minutes >= start || p.minutes < end;
  if (inside) return new Date(candidate).toISOString();

  // Before today's opening → today's opening; at or past the close → tomorrow's.
  // An overnight window closed for the day reopens at `start` today.
  const opensToday = start < end ? p.minutes < start : true;
  const day = opensToday ? { y: p.y, m: p.m, d: p.d } : (() => {
    const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + DAY_MS);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  })();
  const open = zonedToUtc({ ...day, hh: Math.floor(start / 60), mm: start % 60 }, tz);
  return new Date(Math.max(open + delayMs, candidate)).toISOString();
}

/* ---------- the ticker ---------- */

const inFlight = new Set();

/** inFlightSends() → how many sends this broker has started and not finished (the SIGTERM drain waits on them). */
export const inFlightSends = () => inFlight.size;

// The claim on one due draft: scheduled → sending, and the draft back only
// to the first caller (store.claimReplyDraft, a conditional update in both
// backends). During a deploy the old broker and the new one both run this
// loop for a minute; until 2026-11-09 both could read "scheduled" and both
// send. A store without the conditional claim (a test double) reads and
// writes, which is only safe inside one process.
async function claimDue(store, d, now) {
  const at = new Date(now).toISOString();
  if (typeof store.claimReplyDraft === "function") return store.claimReplyDraft(d.id, "scheduled", { at, dueBy: at });
  // Read it again before claiming: the list is from the top of the tick, and
  // a text sent since may have taken this one with it (two deals for one
  // buyer go as one text — reply-agent.js) or put it off to the buyer's next
  // open day. Claiming the stale copy would undo that and send it twice.
  const fresh = typeof store.getReplyDraft === "function" ? await store.getReplyDraft(d.id).catch(() => null) : null;
  if (fresh && (fresh.status !== "scheduled" || Date.parse(fresh.sendAt || "") > now)) return null;
  const next = { ...(fresh || d), status: "sending", sendingAt: at, updatedAt: at };
  await store.updateReplyDraft(d.id, next);
  return next;
}

/**
 * sendDueDrafts({ store, locations, live, now, send, log })
 *
 * For every location: send the scheduled drafts whose time has come, and put
 * any draft stuck in "sending" (a crash mid-send) back where a person can see
 * it. `send` is reply-agent.js's sendReplyDraft, injected to keep this module
 * free of that import (and testable with a stub).
 *
 * A failed send goes back to "draft" with the reason as a flag — never
 * retried silently, because the second attempt could be the one that sends
 * twice. When the broker's send gate is off, due drafts are returned to the
 * outbox with a flag rather than left counting down to nothing.
 */
export const MAX_SENDS_PER_TICK = 20;
// Texts the machine started that may leave in one tick. A pile due at the
// same moment (a spread that rolled onto the morning's opening, a backlog
// after a restart) is the burst carriers and agents both notice: 80 check-ins
// sat at 8:00:00 on 2026-10-06. The rest are spread across the hours left.
export const MACHINE_BURST = 5;
export const PACE_MS = 2500;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * waitsForAWorkday(draft) → whether a queued text waits out a weekend the
 * page keeps, or a day off: one the machine started on its own
 * (MACHINE_STARTED_KINDS) or a deal text, that answers nothing they sent.
 * A buyer's showing reminder and follow-up (SERVICE_KINDS) serve a time they
 * booked, and a person's own text (a check-in you wrote, your answer to
 * their question, the walkthrough ask) is yours, so those keep their time.
 */
export function waitsForAWorkday(d) {
  const kind = d?.outbound?.kind;
  if (!kind || answersInbound(d) || SERVICE_KINDS.has(kind)) return false;
  return MACHINE_STARTED_KINDS.has(kind) || kind === "blast_open";
}

export async function sendDueDrafts({ store, locations = [], live = false, now = Date.now(), send, enabledFor = null, windowFor = null, log = () => {}, maxPerTick = MAX_SENDS_PER_TICK, paceMs = PACE_MS, random = Math.random, stopping = () => false }) {
  const out = { sent: 0, failed: 0, recovered: 0, returned: 0, deferred: 0, afterHours: 0 };
  for (const { locationId, client } of locations) {
    // Two texts never leave in the same second, and a tick sends at most a
    // score: a blast to two hundred buyers takes the morning, as it would.
    let sentThisTick = 0;
    let scheduled = [];
    let sending = [];
    try {
      // Only what's due, longest-due first (store.js `dueBy`): a deal text
      // waiting days for a buyer's week must not crowd out one due now.
      scheduled = await store.listReplyDrafts(locationId, { status: "scheduled", dueBy: new Date(now).toISOString(), limit: 50 });
      sending = await store.listReplyDrafts(locationId, { status: "sending", limit: 50 });
    } catch (e) {
      log(`scheduler: could not list drafts for ${locationId}: ${e.message}`);
      continue;
    }
    for (const d of sending) {
      const since = Date.parse(d.sendingAt || d.updatedAt || 0);
      if (inFlight.has(d.id) || !(now - since > STUCK_SENDING_MS)) continue;
      await store.updateReplyDraft(d.id, {
        ...d, status: "draft", sendAt: null, sendingAt: null,
        flags: [...(d.flags || []), "auto-send was interrupted — send it by hand"],
        updatedAt: new Date(now).toISOString(),
      }).catch(() => {});
      out.recovered++;
    }
    // Belt and braces behind the kill switch: the route that switches the
    // bot off already holds what was counting down, but a config written any
    // other way must not leave a scheduled reply free to go out.
    let switchedOff = false;
    if (enabledFor && scheduled.some((d) => Date.parse(d.sendAt || "") <= now)) {
      switchedOff = !(await enabledFor(locationId).catch(() => true));
    }
    // A text the machine started, due outside its hours (scheduled before
    // the 5pm cut, or by a path that read the wider window), waits for the
    // next opening instead of going out tonight. Replies are never held here.
    const auto = windowFor && scheduled.some((d) => !answersInbound(d) && Date.parse(d.sendAt || "") <= now)
      ? await windowFor(locationId).catch(() => null) : null;
    const machineWin = auto ? machineHours(auto) : null;
    const respread = new Set();
    // A text the machine started, due on a day it doesn't work (a weekend
    // the page keeps, a day off), goes to the next working morning. This
    // also catches what was queued before the setting changed, and a deal
    // wave that ran past Friday's close. Their texts' answers and a buyer's
    // showing texts still go (2026-11: 49 weekend texts in two weekends).
    if (machineWin && !machineWorkday(now, { weekends: auto.weekends || "all", offDays: auto.offDays || [], tz: machineWin.timeZone || "UTC" })) {
      for (const d of scheduled) {
        if (!waitsForAWorkday(d) || !(Date.parse(d.sendAt || "") <= now) || inFlight.has(d.id)) continue;
        const sendAt = spreadAcrossDay({ now, quietHours: machineWin, hours: auto.nudgeSpreadHours ?? 8, random, weekends: auto.weekends || "all", offDays: auto.offDays || [] });
        await store.updateReplyDraft(d.id, { ...d, sendAt, updatedAt: new Date(now).toISOString() }).catch(() => {});
        respread.add(d.id);
        out.offDay = (out.offDay || 0) + 1;
      }
    }
    if (machineWin) {
      const pile = scheduled.filter((d) => !answersInbound(d) && Date.parse(d.sendAt || "") <= now && !inFlight.has(d.id) && !respread.has(d.id))
        .sort((x, y) => String(x.sendAt).localeCompare(String(y.sendAt)));
      for (const d of pile.slice(MACHINE_BURST)) {
        // Outside its hours it is moved below anyway; inside, spread the rest of the day.
        if (Date.parse(nextSendTime({ now, delayMs: 0, quietHours: machineWin })) > now) continue;
        const sendAt = spreadAcrossDay({ now, quietHours: machineWin, hours: auto.nudgeSpreadHours ?? 8, random, weekends: auto.weekends || "all", offDays: auto.offDays || [] });
        await store.updateReplyDraft(d.id, { ...d, sendAt, updatedAt: new Date(now).toISOString() }).catch(() => {});
        respread.add(d.id);
        out.respread = (out.respread || 0) + 1;
      }
    }
    for (const d of scheduled) {
      const due = Date.parse(d.sendAt || "");
      if (!Number.isFinite(due) || due > now || inFlight.has(d.id) || respread.has(d.id)) continue;
      if (machineWin && !answersInbound(d) && Date.parse(nextSendTime({ now, delayMs: 0, quietHours: machineWin })) > now) {
        const sendAt = spreadAcrossDay({ now, quietHours: machineWin, hours: auto.nudgeSpreadHours ?? 8, random, weekends: auto.weekends || "all", offDays: auto.offDays || [] });
        await store.updateReplyDraft(d.id, { ...d, sendAt, updatedAt: new Date(now).toISOString() }).catch(() => {});
        out.afterHours++;
        continue;
      }
      if (sentThisTick >= maxPerTick) { out.deferred++; continue; }
      if (switchedOff) {
        await store.updateReplyDraft(d.id, {
          ...d, status: "draft", sendAt: null,
          flags: [...(d.flags || []), "held: the Conversation AI was switched off"],
          updatedAt: new Date(now).toISOString(),
        }).catch(() => {});
        out.returned++;
        continue;
      }
      if (!live) {
        await store.updateReplyDraft(d.id, {
          ...d, status: "draft", sendAt: null,
          flags: [...(d.flags || []), "sends are off on the broker (CARD_SENDS_ENABLED) — send it by hand"],
          updatedAt: new Date(now).toISOString(),
        }).catch(() => {});
        out.returned++;
        continue;
      }
      // A deploy is draining this broker (SIGTERM): the send under way
      // finishes, nothing new is claimed. What's left stays "scheduled" for
      // the broker that replaces this one.
      if (stopping()) { out.leftForNext = (out.leftForNext || 0) + 1; continue; }
      inFlight.add(d.id);
      try {
        // Claim first, so an overlapping tick (or a second process) sees
        // "sending" and leaves it alone. Only a claimed row is sent.
        const claimed = await claimDue(store, d, now);
        if (!claimed) { out.claimedElsewhere = (out.claimedElsewhere || 0) + 1; continue; }
        const r = await send({ client, store, locationId, draftId: d.id, live: true, auto: true });
        if (r?.skipped) {
          out.stoodAside = (out.stoodAside || 0) + 1;
          log(`scheduler: stood aside on ${d.id} — ${r.skipped}`);
        } else {
          out.sent++;
          sentThisTick++;
          log(`scheduler: auto-sent ${d.id} (${d.party || "agent"} · ${d.intent}) for ${locationId}`);
          if (paceMs > 0 && !stopping()) await wait(Math.round(paceMs * (0.6 + 0.8 * random())));
        }
      } catch (e) {
        const fresh = (await store.getReplyDraft(d.id).catch(() => null)) || d;
        // "Cannot send message as +1… has unsubscribed": there is no send a
        // person could make either. Dismissed, not handed back as "Needs you".
        if (/unsubscribed/i.test(String(e?.message || e))) {
          out.unsubscribed = (out.unsubscribed || 0) + 1;
          await store.updateReplyDraft(d.id, {
            ...fresh, status: "dismissed", sendAt: null, sendingAt: null, dismissedAt: new Date().toISOString(),
            flags: [...(fresh.flags || []), "they unsubscribed — not sent"],
            updatedAt: new Date().toISOString(),
          }).catch(() => {});
          log(`scheduler: ${d.id} not sent — the contact unsubscribed`);
          continue;
        }
        // GHL turned it away before taking it (429 too many requests, 503):
        // nothing went, so it goes again shortly instead of waiting on a
        // person who isn't looking (2026-10-22: three check-ins from 10/19 and
        // a reply sat "held" after the 9am rush hit GHL's limit). A timeout or
        // any other error may have sent it, so those still come back to you.
        const tries = Number(fresh.sendRetries) || 0;
        if (refusedUnsent(e) && tries < SEND_RETRY_MINUTES.length) {
          out.retried = (out.retried || 0) + 1;
          await store.updateReplyDraft(d.id, {
            ...fresh, status: "scheduled", sendingAt: null, sendRetries: tries + 1,
            sendAt: new Date(now + SEND_RETRY_MINUTES[tries] * 60000).toISOString(),
            updatedAt: new Date().toISOString(),
          }).catch(() => {});
          log(`scheduler: GHL refused ${d.id} (${e?.status || "busy"}), trying again in ${SEND_RETRY_MINUTES[tries]} min`);
          continue;
        }
        out.failed++;
        await store.updateReplyDraft(d.id, {
          ...fresh, status: "draft", sendAt: null, sendingAt: null,
          // Scrubbed, here and in the log: GHL's error text can carry their email or number.
          flags: [...(fresh.flags || []), `auto-send failed: ${scrubMessage(e).slice(0, 160)}`],
          updatedAt: new Date().toISOString(),
        }).catch(() => {});
        log(`scheduler: auto-send failed for ${d.id}: ${scrubMessage(e)}`);
      } finally {
        inFlight.delete(d.id);
      }
    }
  }
  return out;
}
