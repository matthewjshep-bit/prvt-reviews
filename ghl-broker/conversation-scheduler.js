// conversation-scheduler.js — when an approved reply actually goes out.
//
// A reply that lands two seconds after the text reads as a bot. One that
// lands in a few minutes, during the hours a person would be at their phone,
// reads as a person — and the gap is also the window in which the operator
// can Hold it from the strip. So an auto-send is never immediate: it is
// scheduled (`sendAt` on the draft, status "scheduled") and a ticker sends it
// when due. State lives in the store, so a redeploy loses nothing and a draft
// scheduled before a restart still goes out on time.

const DAY_MS = 86400000;
export const STUCK_SENDING_MS = 5 * 60 * 1000;

// A delay somewhere in the configured band. `random` is injectable for tests.
export function pickDelayMs(config, random = Math.random) {
  const min = Math.max(0, Number(config?.autoSend?.delayMinSec) || 0);
  const max = Math.max(min, Number(config?.autoSend?.delayMaxSec) || min);
  return Math.round((min + (max - min) * random()) * 1000);
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
export async function sendDueDrafts({ store, locations = [], live = false, now = Date.now(), send, log = () => {} }) {
  const out = { sent: 0, failed: 0, recovered: 0, returned: 0 };
  for (const { locationId, client } of locations) {
    let scheduled = [];
    let sending = [];
    try {
      scheduled = await store.listReplyDrafts(locationId, { status: "scheduled", limit: 50 });
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
    for (const d of scheduled) {
      const due = Date.parse(d.sendAt || "");
      if (!Number.isFinite(due) || due > now || inFlight.has(d.id)) continue;
      if (!live) {
        await store.updateReplyDraft(d.id, {
          ...d, status: "draft", sendAt: null,
          flags: [...(d.flags || []), "sends are off on the broker (CARD_SENDS_ENABLED) — send it by hand"],
          updatedAt: new Date(now).toISOString(),
        }).catch(() => {});
        out.returned++;
        continue;
      }
      inFlight.add(d.id);
      try {
        // Claim first, so an overlapping tick (or a second process) sees
        // "sending" and leaves it alone.
        await store.updateReplyDraft(d.id, { ...d, status: "sending", sendingAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
        await send({ client, store, locationId, draftId: d.id, live: true, auto: true });
        out.sent++;
        log(`scheduler: auto-sent ${d.id} (${d.party || "agent"} · ${d.intent}) for ${locationId}`);
      } catch (e) {
        out.failed++;
        const fresh = (await store.getReplyDraft(d.id).catch(() => null)) || d;
        await store.updateReplyDraft(d.id, {
          ...fresh, status: "draft", sendAt: null, sendingAt: null,
          flags: [...(fresh.flags || []), `auto-send failed: ${String(e?.message || e).slice(0, 160)}`],
          updatedAt: new Date().toISOString(),
        }).catch(() => {});
        log(`scheduler: auto-send failed for ${d.id}: ${e?.message}`);
      } finally {
        inFlight.delete(d.id);
      }
    }
  }
  return out;
}
