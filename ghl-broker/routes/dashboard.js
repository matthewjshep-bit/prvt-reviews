// routes/dashboard.js — read-only aggregates for the standalone Dashboard page.
// Mounted at /api/dashboard.
//
//   GET /api/dashboard/summary        local metrics: offers/sends/outreach per day
//   GET /api/dashboard/ghl/tags       live GHL contact counts per tag
//   GET /api/dashboard/ghl/messages   GHL calls/texts/emails per day (bounded scan)
//
// The three endpoints are deliberately separate: /summary is pure local DB and
// fast; the two /ghl endpoints hit GoHighLevel and each degrades independently
// to { ok: true, scopeMissing: true } when the location's Private Integration
// token lacks the needed scope (contacts.readonly / conversations.readonly),
// so the frontend shows a warning banner instead of an error.
//
// All bucketing happens here in JS from lean store rows — the store's Postgres
// and JSON-file backends stay trivially in parity that way. Buckets are the
// VIEWER's local calendar days: the client passes tz_offset (minutes, from
// Date.getTimezoneOffset()) and every timestamp is shifted before slicing the
// day. Daily arrays are dense (one zero-filled entry per day in the window) so
// chart components never handle gaps.

import express from "express";
import { store } from "../store.js";
import { countContactsByTag, searchConversations, listConversationMessages } from "../ghl.js";

const DAY_MS = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// Epoch ms from a GHL timestamp that may be a number, numeric string, or ISO.
const msOf = (v) => {
  if (v === null || v === undefined || v === "") return NaN;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
};

// The viewer-local day key ("2026-08-05") for a timestamp.
const dayKey = (ts, tzOffset) => new Date(ts - tzOffset * 60000).toISOString().slice(0, 10);

// The reporting window: UTC start instant + the dense list of local day keys,
// ending on the viewer's "today".
function windowFor(days, tzOffset) {
  const todayLocal = Math.floor((Date.now() - tzOffset * 60000) / DAY_MS);
  const startLocalDay = todayLocal - days + 1;
  const startMs = startLocalDay * DAY_MS + tzOffset * 60000;
  const dates = [];
  for (let d = startLocalDay; d <= todayLocal; d++) {
    dates.push(new Date(d * DAY_MS).toISOString().slice(0, 10));
  }
  return { startMs, startIso: new Date(startMs).toISOString(), dates };
}

const readWindow = (req) => ({
  days: clamp(parseInt(req.query.days, 10) || 30, 1, 180),
  tzOffset: clamp(parseInt(req.query.tz_offset, 10) || 0, -840, 840),
});

// 10-minute cache for the GHL messages scan (it can take ~100s of API calls),
// plus in-flight dedupe so a double-mounted React effect doesn't scan twice.
const MSG_TTL_MS = 10 * 60 * 1000;
const msgCache = new Map(); // key -> { at, payload }
const msgInflight = new Map(); // key -> Promise<payload>

export default function createDashboardRouter({ resolveLocation }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("dashboard error:", code, err.message, err.detail || "");
    res.status(code).json({ error: err.message, detail: err.detail });
  };
  const scopeMissing = (err) => err.status === 401 || err.status === 403;

  /* ---------- local metrics: offers, sends, outreach funnel ---------- */
  router.get("/summary", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const { days, tzOffset } = readWindow(req);
      const { startMs, startIso, dates } = windowFor(days, tzOffset);
      const skeleton = (fields) =>
        new Map(dates.map((date) => [date, { date, ...fields }]));

      // Offers are fetched from well before the window: a send can land on an
      // offer created months earlier, and sends are stored on the offer row.
      const horizonIso = new Date(startMs - 365 * DAY_MS).toISOString();
      const offerRows = await store.listOffersSince(locationId, horizonIso);

      const offersDaily = skeleton({ count: 0, cash: 0 });
      let offersTotal = 0, cashTotal = 0;
      const sendsDaily = skeleton({ sms: 0, email: 0 });
      let totalSms = 0, totalEmail = 0;
      for (const row of offerRows) {
        const createdMs = msOf(row.createdAt);
        if (row.status !== "draft" && createdMs >= startMs) {
          const b = offersDaily.get(dayKey(createdMs, tzOffset));
          if (b) {
            b.count += 1;
            b.cash += Number(row.cashAmount) || 0;
            offersTotal += 1;
            cashTotal += Number(row.cashAmount) || 0;
          }
        }
        for (const send of row.sends || []) {
          const ts = msOf(send.ts);
          if (!(ts >= startMs)) continue;
          const b = sendsDaily.get(dayKey(ts, tzOffset));
          if (!b) continue;
          // Only successful channel sends count as "sent" (failures stay in
          // the offer's send history but not in the chart).
          if (send.results?.sms?.ok) { b.sms += 1; totalSms += 1; }
          if (send.results?.email?.ok) { b.email += 1; totalEmail += 1; }
        }
      }

      // Outreach funnel: pulls + request usage per day, new agents per
      // first_seen day, imports per imported_at day.
      const outreachDaily = skeleton({ pulls: 0, requestsUsed: 0, newAgents: 0, imported: 0 });
      const pulls = await store.listOutreachPulls(locationId, { limit: 200 });
      for (const p of pulls) {
        const ts = msOf(p.createdAt);
        if (!(ts >= startMs)) continue;
        const b = outreachDaily.get(dayKey(ts, tzOffset));
        if (!b) continue;
        b.pulls += 1;
        b.requestsUsed += Number(p.doc?.requestsUsed) || 0;
      }
      const activity = await store.listOutreachActivity(locationId, startIso);
      for (const a of activity) {
        const seen = msOf(a.firstSeen);
        if (seen >= startMs) {
          const b = outreachDaily.get(dayKey(seen, tzOffset));
          if (b) b.newAgents += 1;
        }
        const imported = msOf(a.importedAt);
        if (imported >= startMs) {
          const b = outreachDaily.get(dayKey(imported, tzOffset));
          if (b) b.imported += 1;
        }
      }

      // Month-to-date RentCast request usage (same reduce the outreach page uses).
      const monthStart = new Date();
      monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const requestsThisMonth = pulls
        .filter((p) => new Date(p.createdAt) >= monthStart)
        .reduce((s, p) => s + (Number(p.doc?.requestsUsed) || 0), 0);

      res.json({
        ok: true,
        days,
        offers: { total: offersTotal, cashTotal, daily: [...offersDaily.values()] },
        sends: { totalSms, totalEmail, daily: [...sendsDaily.values()] },
        outreach: {
          daily: [...outreachDaily.values()],
          usage: { requestsThisMonth, limit: 50, lastPullAt: pulls[0]?.createdAt || null },
        },
      });
    } catch (err) { fail(res, err); }
  });

  /* ---------- live GHL contact counts per tag ---------- */
  router.get("/ghl/tags", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const tags = String(req.query.tags || "")
        .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12);
      if (!tags.length) return res.json({ ok: true, counts: [] });
      const counts = [];
      for (const tag of tags) {
        counts.push({ tag, count: await countContactsByTag(client, locationId, tag) });
        await sleep(80);
      }
      res.json({ ok: true, counts });
    } catch (err) {
      if (scopeMissing(err)) return res.json({ ok: true, scopeMissing: true });
      fail(res, err);
    }
  });

  /* ---------- GHL message/call volume (bounded conversation scan) ---------- */
  // One /conversations/search page (100 newest-activity conversations), then
  // up to 3 message pages per active conversation, bucketed by type. Calls
  // count both directions; SMS/email count outbound only ("sent per day").
  // Bounded by design: high-volume locations undercount and report
  // approx.capped — honest truncation beats an unbounded scan of the whole
  // location. ~120ms pacing keeps well under GHL's burst rate limit.
  async function scanMessages(client, locationId, days, tzOffset) {
    const { startMs, dates } = windowFor(days, tzOffset);
    const daily = new Map(dates.map((date) => [date, { date, calls: 0, sms: 0, email: 0 }]));
    const { conversations, total } = await searchConversations(client, locationId, { limit: 100 });
    const active = conversations.filter((c) => msOf(c.lastMessageDate) >= startMs);
    let truncated = false;

    for (const convo of active) {
      let lastMessageId = null;
      let pages = 0;
      paging: while (pages < 3) {
        pages += 1;
        const page = await listConversationMessages(client, convo.id, { lastMessageId, limit: 100 });
        for (const m of page.messages) {
          const ts = msOf(m.dateAdded);
          if (!Number.isFinite(ts)) continue;
          if (ts < startMs) break paging; // pages are newest-first
          const bucket = daily.get(dayKey(ts, tzOffset));
          if (!bucket) continue;
          const type = String(m.messageType || m.type || "").toUpperCase();
          const outbound = String(m.direction || "").toLowerCase() === "outbound";
          if (type.includes("CALL")) bucket.calls += 1;
          else if (type.includes("SMS") && outbound) bucket.sms += 1;
          else if (type.includes("EMAIL") && outbound) bucket.email += 1;
        }
        if (!page.nextPage || !page.lastMessageId) break;
        if (pages === 3) truncated = true;
        lastMessageId = page.lastMessageId;
        await sleep(120);
      }
      await sleep(120);
    }

    return {
      ok: true,
      daily: [...daily.values()],
      approx: {
        conversationsScanned: active.length,
        conversationsTotal: total,
        // capped: the newest-100 page was all still inside the window (older
        // active conversations exist beyond it), or a conversation hit the
        // per-conversation page cap.
        capped: truncated || (conversations.length >= 100 && active.length === conversations.length),
      },
      cachedAt: new Date().toISOString(),
    };
  }

  router.get("/ghl/messages", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const { days, tzOffset } = readWindow(req);
      const key = `${locationId}:${days}:${tzOffset}`;
      const hit = msgCache.get(key);
      if (hit && Date.now() - hit.at < MSG_TTL_MS) return res.json(hit.payload);
      if (!msgInflight.has(key)) {
        msgInflight.set(
          key,
          scanMessages(client, locationId, days, tzOffset).finally(() => msgInflight.delete(key))
        );
      }
      const payload = await msgInflight.get(key);
      msgCache.set(key, { at: Date.now(), payload });
      res.json(payload);
    } catch (err) {
      if (scopeMissing(err)) return res.json({ ok: true, scopeMissing: true });
      fail(res, err);
    }
  });

  return router;
}
