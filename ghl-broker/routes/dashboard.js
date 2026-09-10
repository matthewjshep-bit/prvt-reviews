// routes/dashboard.js — read-only aggregates for the standalone Dashboard page.
// Mounted at /api/dashboard.
//
//   GET /api/dashboard/summary        local metrics: offers/sends/outreach per day
//   GET /api/dashboard/ghl/tags       live GHL contact counts per tag
//   GET /api/dashboard/ghl/messages   GHL calls/texts/emails per day (bounded scan)
//   GET /api/dashboard/ghl/contacts   GHL contacts created per day (dateAdded)
//
// The three endpoints are deliberately separate: /summary is pure local DB and
// fast; the two /ghl endpoints hit GoHighLevel and each degrades independently
// to { ok: true, scopeMissing: true } when the location's Private Integration
// token lacks the needed scope (contacts.readonly / conversations.readonly),
// so the frontend shows a warning banner instead of an error. A slow scan
// answers { ok: true, pending: true } and keeps running server-side — the
// client polls until the cached result lands.
//
// All bucketing happens here in JS from lean store rows — the store's Postgres
// and JSON-file backends stay trivially in parity that way. Buckets are the
// VIEWER's local calendar days: the client passes tz_offset (minutes, from
// Date.getTimezoneOffset()) and every timestamp is shifted before slicing the
// day. Daily arrays are dense (one zero-filled entry per day in the window) so
// chart components never handle gaps.

import express from "express";
import { store } from "../store.js";
import {
  countContactsByTag, searchConversations, listConversationMessages, searchContactsCreatedSince,
} from "../ghl.js";
import { offerFunnel, counterSpread, passReasons, followUpPerformance } from "../shared/funnel.js";
import { buildPipeline } from "../shared/pipeline.js";
import { autopilotSummary, graduationReport, GRADUATION } from "../shared/graduation.js";
import { buildFlow } from "../shared/flow.js";
import { listPipelines } from "../ghl.js";
import { reconcileLocation, CURSOR_NAME as MIRROR_CURSOR } from "../ghl-mirror.js";
import { listJobs as listUnderwriteJobs, publicJob as publicUnderwriteJob, AUTO_UNDERWRITE_ENABLED } from "../auto-underwrite.js";
import { draftStats } from "../shared/conversation-ai.js";
import { conversationConfig } from "../reply-agent.js";

// Same expression routes/offers.js reads: the broker's one send gate. The
// pipeline only REPORTS it, so the console can say whether a draft's Send
// would actually send.
const CARD_SENDS_ENABLED = process.env.CARD_SENDS_ENABLED === "true";
// How far back the board looks for blasts, opens and replies. A blast older
// than this is not a live disposition, it is history.
const PIPELINE_EVENT_DAYS = 90;
const PIPELINE_EVENT_LIMIT = 5000;
const PIPELINE_EVENT_TYPES = [
  "blast_sent", "dataroom_sent", "dataroom_viewed",
  "investor_evaluating", "investor_committed", "investor_passed",
  "follow_up_sent", "text_summary", "call_summary",
  "outreach_sent",
];

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

// The reporting window: UTC start/end instants + the dense list of local day
// keys. Ends on the viewer's "today" unless endKey ("YYYY-MM-DD", a local
// day) asks for a window ending on a past day — the date-picker view.
function windowFor(days, tzOffset, endKey) {
  const todayLocal = Math.floor((Date.now() - tzOffset * 60000) / DAY_MS);
  let endLocal = todayLocal;
  if (endKey) {
    const d = Math.floor(Date.parse(`${endKey}T00:00:00Z`) / DAY_MS);
    if (Number.isFinite(d)) endLocal = clamp(d, todayLocal - 365, todayLocal);
  }
  const startLocalDay = endLocal - days + 1;
  const startMs = startLocalDay * DAY_MS + tzOffset * 60000;
  const endMs = (endLocal + 1) * DAY_MS + tzOffset * 60000; // exclusive
  const dates = [];
  for (let d = startLocalDay; d <= endLocal; d++) {
    dates.push(new Date(d * DAY_MS).toISOString().slice(0, 10));
  }
  return { startMs, endMs, startIso: new Date(startMs).toISOString(), dates };
}

const readWindow = (req) => ({
  days: clamp(parseInt(req.query.days, 10) || 30, 1, 180),
  tzOffset: clamp(parseInt(req.query.tz_offset, 10) || 0, -840, 840),
  end: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.end || "")) ? String(req.query.end) : null,
});

// 10-minute cache for the GHL scans (a busy window is minutes of paced API
// calls), plus in-flight dedupe so a double-mounted React effect doesn't scan
// twice. A scan that outlives SOFT_WAIT_MS keeps running in the background and
// the route answers { pending: true } — the client polls until the cache is
// warm. Without that, Render's edge kills the long-hanging response and the
// scan's work is thrown away. Failures are cached briefly so a broken
// location doesn't rescan on every poll.
const SCAN_TTL_MS = 10 * 60 * 1000;
const SCAN_ERR_TTL_MS = 60 * 1000;
const SOFT_WAIT_MS = 25 * 1000;
const PENDING = Symbol("pending");
const scanCache = new Map(); // key -> { at, payload?, error? }
const scanInflight = new Map(); // key -> Promise<payload>
async function cachedScan(key, run) {
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < (hit.error ? SCAN_ERR_TTL_MS : SCAN_TTL_MS)) {
    if (hit.error) throw hit.error;
    return hit.payload;
  }
  if (!scanInflight.has(key)) {
    const job = run()
      .then(
        (payload) => { scanCache.set(key, { at: Date.now(), payload }); return payload; },
        (error) => { scanCache.set(key, { at: Date.now(), error }); throw error; }
      )
      .finally(() => scanInflight.delete(key));
    job.catch(() => {}); // the route may have answered pending and moved on
    scanInflight.set(key, job);
  }
  return Promise.race([scanInflight.get(key), sleep(SOFT_WAIT_MS).then(() => PENDING)]);
}

// GHL rate limit is a per-location burst (100 req / 10s). Two guards: scans
// for the same location run one at a time (the dashboard fires the messages
// and contacts scans together on page load), and every page call retries
// 429s with exponential backoff.
const scanQueue = new Map(); // locationId -> promise tail
function serialized(locationId, run) {
  const tail = scanQueue.get(locationId) || Promise.resolve();
  const next = tail.catch(() => {}).then(run);
  scanQueue.set(locationId, next);
  return next;
}
async function ghlPage(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 429 && attempt < 3) {
        await sleep(3000 * 2 ** attempt);
        continue;
      }
      // GHL throws the odd transient 401/403 during long scans; retrying
      // separates those from a genuinely missing scope (which fails every
      // time and would otherwise paint the whole scan as scope-missing).
      if ((err.status === 401 || err.status === 403) && attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}
const PACE_MS = 150; // ≈ 66 req / 10s, comfortably under the burst cap

export default function createDashboardRouter({ resolveLocation }) {
  const router = express.Router();
  const fail = (res, err) => {
    const code = err.http || err.status || 500;
    if (code >= 500) console.error("dashboard error:", code, err.message, err.detail || "");
    res.status(code).json({ error: err.message, detail: err.detail });
  };
  const scopeMissing = (err) => err.status === 401 || err.status === 403;

  /* ---------- local metrics: offers, sends, outreach funnel ---------- */
  // The outcome report: what happened to the offers we sent, how far apart we
  // and the agents actually are, why buyers said no, and whether the nudges
  // worked.
  //
  // READ ONLY, on purpose. Nothing here writes, and nothing here feeds back
  // into the offer math or the follow-up ladder. It is the operator's evidence
  // for a decision, not an input to one the machine makes quietly.
  //
  // Local DB only — no GHL calls — so it stays in the fast tier beside
  // /summary and needs none of the caching the /ghl endpoints carry.
  router.get("/funnel", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const { days, tzOffset, end } = readWindow(req);
      const { startMs, startIso } = windowFor(days, tzOffset, end);
      // Same reasoning as /summary: a status lands on an offer created long
      // before the window, so the rows are fetched from well behind it.
      const horizonIso = new Date(startMs - 365 * DAY_MS).toISOString();
      const rows = await store.listOfferOutcomesSince(locationId, horizonIso);

      // The event window IS the window — a nudge sent before it is not this
      // report's business. Note this is the only place a location-wide event
      // query is asked for; nothing needed one before the follow-up clock.
      const events = await store.listContactEventsSince(locationId, startIso, {
        types: ["follow_up_sent", "text_summary", "call_summary"], limit: 5000,
      }).catch(() => []);
      const nudges = events.filter((e) => e.type === "follow_up_sent");
      const inbound = events.filter((e) => e.type !== "follow_up_sent");

      const inWindow = rows.filter((o) => msOf(o.createdAt) >= startMs ||
        (o.statusHistory || []).some((h) => msOf(h.ts) >= startMs));

      res.json({
        ok: true,
        window: { days, startIso, end },
        funnel: offerFunnel(inWindow),
        counters: counterSpread(inWindow),
        passReasons: {
          deal: passReasons(inWindow, { by: "deal" }),
          area: passReasons(inWindow, { by: "area" }),
          priceBand: passReasons(inWindow, { by: "priceBand" }),
          buyer: passReasons(inWindow, { by: "buyer" }),
        },
        followUps: followUpPerformance(nudges, inbound),
      });
    } catch (err) { fail(res, err); }
  });

  // The board: one card per property and where it stands, plus the queue of
  // things the self-driving system stopped short of doing. All local reads —
  // the offer book (lean), the open drafts, ninety days of events, the
  // in-memory underwrite jobs — and one pure function over them. The console
  // polls this every fifteen seconds, so it has to stay cheap.
  // The switchboard, the same way for every route that shows it.
  function autopilotFor({ saved, config, recentDrafts = [] }) {
    const autopilot = autopilotSummary({
      config, sendsEnabled: CARD_SENDS_ENABLED, underwriteLive: AUTO_UNDERWRITE_ENABLED,
      underwriteWired: Boolean(process.env.AUTO_UNDERWRITE_SECRET || process.env.GHL_LOCATION_KEYS),
      outreach: saved?.outreachAutopilot || null, importsEnabled: process.env.OUTREACH_IMPORTS_ENABLED === "true",
      dispo: saved?.dispoAutopilot || null, blastsEnabled: process.env.DISPO_BLASTS_ENABLED === "true",
      mirror: saved?.ghlMirror || null,
    });
    autopilot.readyToGraduate = graduationReport({ stats: draftStats(recentDrafts), config }).ready;
    autopilot.windowDays = GRADUATION.windowDays;
    return autopilot;
  }

  // The river: how work moved stage to stage in the window, the machine's
  // share of each hop, the switchboard, the queue counts, and the feed.
  // Same uncached local tier as /funnel and /pipeline.
  const FLOW_EVENT_TYPES = [
    "import", "outreach_sent", "text_summary", "call_summary", "offer_sent", "offer_revised", "offer_countered", "offer_passed",
    "offer_no_response", "realm_yes", "realm_no", "deal_promoted", "deal_stage", "blast_sent", "dataroom_sent", "dataroom_viewed",
    "investor_evaluating", "investor_committed", "investor_passed", "feedback", "follow_up_sent", "call_booked", "agent_estimate",
  ];
  router.get("/flow", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const { days, tzOffset, end } = readWindow(req);
      const { startMs, endMs, startIso } = windowFor(days, tzOffset, end);
      const now = Date.now();
      const gradSince = new Date(now - GRADUATION.windowDays * DAY_MS).toISOString();
      const [offers, events, drafts, saved, openDrafts, recentDrafts, investors] = await Promise.all([
        store.listOffers(locationId, { limit: 2000, lean: true }),
        store.listContactEventsSince(locationId, startIso, { types: FLOW_EVENT_TYPES, limit: 5000 }).catch(() => []),
        store.listReplyDrafts(locationId, { since: startIso, limit: 1000 }).catch(() => []),
        store.getOfferSettings(locationId).catch(() => null),
        store.listReplyDrafts(locationId, { status: ["draft", "scheduled"], limit: 500 }).catch(() => []),
        store.listReplyDrafts(locationId, { since: gradSince, limit: 1000 }).catch(() => []),
        store.listInvestors(locationId, { limit: 2000 }).catch(() => []),
      ]);
      const config = conversationConfig(saved || {});
      const jobs = listUnderwriteJobs(locationId, { limit: 100 }).map(publicUnderwriteJob);
      const flow = buildFlow({ offers, events, drafts, jobs, now, windowStartMs: startMs, windowEndMs: endMs });
      // Buyer names for the feed come from the investor book.
      const names = {};
      for (const i of investors) if (i?.contactId && i.name) names[i.contactId] = i.name;
      for (const f of flow.feed) if (!f.contactName && names[f.contactId]) f.contactName = names[f.contactId];
      const pipeline = buildPipeline({ offers, drafts: openDrafts, events: events.filter((e) => PIPELINE_EVENT_TYPES.includes(e.type)), jobs, config, contactNames: names, now });
      res.json({
        ok: true, now: new Date(now).toISOString(), window: { days, startIso, end },
        ...flow,
        autopilot: autopilotFor({ saved, config, recentDrafts }),
        queue: pipeline.counts.actions,
        conversationEnabled: config.enabled,
      });
    } catch (err) { fail(res, err); }
  });

  router.get("/pipeline", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const now = Date.now();
      const since = new Date(now - PIPELINE_EVENT_DAYS * DAY_MS).toISOString();
      const gradSince = new Date(now - GRADUATION.windowDays * DAY_MS).toISOString();
      const [offers, drafts, events, saved, investors, recentDrafts] = await Promise.all([
        store.listOffers(locationId, { limit: 2000, lean: true }),
        store.listReplyDrafts(locationId, { status: ["draft", "scheduled"], limit: 500 }),
        store.listContactEventsSince(locationId, since, { types: PIPELINE_EVENT_TYPES, limit: PIPELINE_EVENT_LIMIT }).catch(() => []),
        store.getOfferSettings(locationId).catch(() => null),
        store.listInvestors(locationId, { limit: 2000 }).catch(() => []),
        // The graduation window, for the "N intents are ready" line on the
        // autopilot card. One indexed read; the verdicts themselves live on
        // the Conversation AI tab.
        store.listReplyDrafts(locationId, { since: gradSince, limit: 1000 }).catch(() => []),
      ]);
      const config = conversationConfig(saved || {});
      const autopilot = autopilotFor({ saved, config, recentDrafts });
      const contactNames = {};
      for (const i of investors) if (i?.contactId && i.name) contactNames[i.contactId] = i.name;
      const jobs = listUnderwriteJobs(locationId, { limit: 100 }).map(publicUnderwriteJob);
      const out = buildPipeline({ offers, drafts, events, jobs, config, contactNames, now, eventsLimit: PIPELINE_EVENT_LIMIT });
      res.json({
        ok: true,
        now: new Date(now).toISOString(),
        sendsEnabled: CARD_SENDS_ENABLED,
        conversationEnabled: config.enabled,
        ladders: { agent: config.parties.agent.followUp, investor: config.parties.investor.followUp },
        autopilot,
        // The open drafts verbatim — the console renders them with the same
        // row the outbox uses, so send/edit/dismiss/apply come for free.
        drafts,
        ...out,
      });
    } catch (err) { fail(res, err); }
  });

  router.get("/summary", async (req, res) => {
    try {
      const { locationId } = resolveLocation(req);
      const { days, tzOffset, end } = readWindow(req);
      const { startMs, startIso, dates } = windowFor(days, tzOffset, end);
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
  // The GHL pipelines the mirror may write to, with their stages. Degrades
  // like the workflow list when the token lacks opportunities.readonly.
  router.get("/ghl/pipelines", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      try {
        const cursor = await store.getJobCursor?.(locationId, MIRROR_CURSOR).catch(() => null);
        res.json({ ok: true, pipelines: await listPipelines(client, locationId), lastRun: cursor || null });
      } catch (e) {
        if (scopeMissing(e)) return res.json({ ok: false, scopeMissing: true, pipelines: [], error: "the token lacks the opportunities.readonly scope — add it (and opportunities.write) to the Private Integration" });
        res.json({ ok: false, pipelines: [], error: e?.message || "could not list pipelines" });
      }
    } catch (err) { fail(res, err); }
  });

  // Reconcile now, by hand. Same bounded pass the tick runs.
  router.post("/ghl/mirror/run", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const saved = (await store.getOfferSettings(locationId)) || {};
      const r = await reconcileLocation({ client, locationId, saved, store, limit: Number(req.body?.limit) > 0 ? Math.min(500, Number(req.body.limit)) : 200 });
      await store.setJobCursor?.(locationId, MIRROR_CURSOR, { at: new Date().toISOString(), doc: { wrote: r.wrote, considered: r.considered, errors: r.errors.slice(0, 5), manual: true } }).catch(() => {});
      res.json({ ok: true, ...r });
    } catch (err) { fail(res, err); }
  });

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
  // Page /conversations/search (newest activity first, cursor = the previous
  // page's oldest lastMessageDate) until activity predates the window or the
  // conversation cap, then tally each active conversation's messages per
  // local day. Calls count both directions; SMS/email count outbound only
  // ("sent per day"). Conversations are deduped by id and collection stops
  // when a page yields nothing new, so a repeated or stuck cursor can never
  // count the same conversation twice.
  //
  // Past days never change, so tallies are cached PER CONVERSATION (keyed by
  // its lastMessageDate): a conversation's messages are only re-fetched when
  // it has new activity since the last scan. First load pays full price;
  // after that a scan costs the conversation listing plus a handful of
  // fetches, so range switches and the date picker resolve in seconds.
  // Message fetches run in small concurrent chunks paced under GHL's
  // 100-req/10s burst. Sized for real volume (~6k contacts / 30 days here):
  // beyond the cap the tiles show "N+" (partial).
  const MAX_CONVERSATIONS = 2000;
  const MSG_CHUNK = 8;            // concurrent per-conversation message fetches
  const MSG_CHUNK_PACE_MS = 1000; // ≈ 8 req/s ≈ 80 req / 10s worst case
  const TALLY_HORIZON_DAYS = 90;  // how far back a conversation is tallied
  const TALLY_CACHE_MAX = 30000;  // conversations kept per location+tz
  // `${locationId}:${tzOffset}` -> Map(convoId -> { last, h, days, truncated })
  // days: { "2026-08-06": { calls, sms, email } } for everything since h.
  const convoTallies = new Map();
  async function scanMessages(client, locationId, days, tzOffset, endKey) {
    const { startMs, dates } = windowFor(days, tzOffset, endKey);
    // Tally back to the standard horizon, or the window start if it's older
    // (a date-picker view into deep history).
    const horizonStart = Math.min(Date.now() - TALLY_HORIZON_DAYS * DAY_MS, startMs);
    const tallyKey = `${locationId}:${tzOffset}`;
    if (!convoTallies.has(tallyKey)) convoTallies.set(tallyKey, new Map());
    const tallies = convoTallies.get(tallyKey);

    const seen = new Set();
    const active = [];
    let total = 0;
    let cursor = null;
    let sawWindowEnd = false;
    while (active.length < MAX_CONVERSATIONS) {
      const page = await ghlPage(() => searchConversations(client, locationId, { limit: 100, startAfterDate: cursor }));
      if (!total) total = page.total;
      if (!page.conversations.length) { sawWindowEnd = true; break; }
      const before = active.length;
      for (const c of page.conversations) {
        if (!c.id || seen.has(c.id)) continue;
        seen.add(c.id);
        const ts = msOf(c.lastMessageDate);
        // A missing lastMessageDate says nothing about the window — skip the
        // conversation rather than mistaking it for the end of the window.
        if (!Number.isFinite(ts)) continue;
        if (ts >= startMs) active.push(c);
        else sawWindowEnd = true;
      }
      if (sawWindowEnd || page.conversations.length < 100) { sawWindowEnd = true; break; }
      // A page of pure repeats means the cursor is stuck — stop instead of
      // spinning; approx.capped keeps the truncation honest.
      if (active.length === before) break;
      cursor = msOf(page.conversations[page.conversations.length - 1].lastMessageDate);
      if (!Number.isFinite(cursor)) break;
      // Overlap the boundary by 1ms: bulk sends give many conversations the
      // same lastMessageDate, and if the API pages with a strict "older
      // than", ties sitting exactly on the cursor would be skipped forever.
      // Re-fetched boundary rows are dropped by the id dedupe instead.
      cursor += 1;
      await sleep(PACE_MS);
    }

    // Cache-valid: same last activity, and tallied at least as far back as
    // this window needs.
    let cacheHits = 0;
    async function tallyConversation(convo) {
      const last = msOf(convo.lastMessageDate);
      const hit = tallies.get(convo.id);
      if (hit && hit.last === last && hit.h <= startMs) { cacheHits++; return; }
      const entry = { last, h: horizonStart, days: {}, truncated: false };
      let lastMessageId = null;
      let pages = 0;
      while (pages < 3) {
        pages += 1;
        const page = await ghlPage(() => listConversationMessages(client, convo.id, { lastMessageId, limit: 100 }));
        // Pages run newest-first, but a single page may interleave the odd
        // out-of-order record — so tally the whole page and only stop paging
        // once it reached back past the horizon.
        let reachedHorizon = false;
        for (const m of page.messages) {
          const ts = msOf(m.dateAdded);
          if (!Number.isFinite(ts)) continue;
          if (ts < horizonStart) { reachedHorizon = true; continue; }
          const type = String(m.messageType || m.type || "").toUpperCase();
          const outbound = String(m.direction || "").toLowerCase() === "outbound";
          const kind = type.includes("CALL") ? "calls"
            : type.includes("SMS") && outbound ? "sms"
            : type.includes("EMAIL") && outbound ? "email"
            : null;
          if (!kind) continue;
          const key = dayKey(ts, tzOffset);
          const d = entry.days[key] || (entry.days[key] = { calls: 0, sms: 0, email: 0 });
          d[kind] += 1;
        }
        if (reachedHorizon || !page.nextPage || !page.lastMessageId) break;
        if (pages === 3) { entry.truncated = true; break; }
        lastMessageId = page.lastMessageId;
        await sleep(PACE_MS);
      }
      tallies.delete(convo.id); // re-insert so Map order stays oldest-first
      tallies.set(convo.id, entry);
      if (tallies.size > TALLY_CACHE_MAX) tallies.delete(tallies.keys().next().value);
    }
    for (let i = 0; i < active.length; i += MSG_CHUNK) {
      const chunk = active.slice(i, i + MSG_CHUNK);
      const hitsBefore = cacheHits;
      await Promise.all(chunk.map(tallyConversation));
      // Pace only when the chunk actually hit the API — cached chunks are free.
      if (cacheHits - hitsBefore < chunk.length && i + MSG_CHUNK < active.length)
        await sleep(MSG_CHUNK_PACE_MS);
    }

    // The window's daily series is a sum over the active conversations' tallies.
    const daily = new Map(dates.map((date) => [date, { date, calls: 0, sms: 0, email: 0 }]));
    let truncatedConvo = false;
    for (const c of active) {
      const e = tallies.get(c.id);
      if (!e) continue;
      if (e.truncated) truncatedConvo = true;
      for (const [key, v] of Object.entries(e.days)) {
        const b = daily.get(key);
        if (!b) continue;
        b.calls += v.calls; b.sms += v.sms; b.email += v.email;
      }
    }

    return {
      ok: true,
      daily: [...daily.values()],
      approx: {
        conversationsScanned: active.length,
        conversationsTotal: total,
        // capped: the conversation cap, a stuck cursor, or a per-conversation
        // page cap cut the scan short — activity inside the window may be
        // undercounted.
        capped: !sawWindowEnd || truncatedConvo,
      },
      cachedAt: new Date().toISOString(),
    };
  }

  /* ---------- GHL contacts created per day (dateAdded) ---------- */
  // Cursor-pages the filtered contact search (dateAdded >= window start,
  // newest first) and buckets by creation day. `total` is exact from the API
  // even when the page cap is hit.
  const MAX_CONTACT_PAGES = 100; // × 100 = 10,000 contacts per scan
  async function scanContacts(client, locationId, days, tzOffset, endKey) {
    const { startMs, endMs, dates } = windowFor(days, tzOffset, endKey);
    const sinceIso = new Date(startMs).toISOString();
    const untilIso = new Date(endMs).toISOString();
    const daily = new Map(dates.map((date) => [date, { date, count: 0 }]));
    let total = 0;
    let scanned = 0;
    let cursor = null;
    let sawEnd = false;
    for (let p = 0; p < MAX_CONTACT_PAGES; p++) {
      const page = await ghlPage(() => searchContactsCreatedSince(client, locationId, {
        sinceIso, untilIso, pageLimit: 100, searchAfter: cursor,
      }));
      total = page.total || total;
      for (const c of page.contacts) {
        const ts = msOf(c.dateAdded);
        if (!Number.isFinite(ts)) continue;
        const b = daily.get(dayKey(ts, tzOffset));
        if (b) b.count += 1;
        scanned += 1;
      }
      if (page.contacts.length < 100 || !page.searchAfter) { sawEnd = true; break; }
      cursor = page.searchAfter;
      await sleep(PACE_MS);
    }
    return {
      ok: true,
      daily: [...daily.values()],
      total,
      approx: { contactsScanned: scanned, capped: !sawEnd },
      cachedAt: new Date().toISOString(),
    };
  }

  router.get("/ghl/contacts", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const { days, tzOffset, end } = readWindow(req);
      const result = await cachedScan(`contacts:${locationId}:${days}:${tzOffset}:${end || "now"}`,
        () => serialized(locationId, () => scanContacts(client, locationId, days, tzOffset, end)));
      res.json(result === PENDING ? { ok: true, pending: true } : result);
    } catch (err) {
      if (scopeMissing(err)) return res.json({ ok: true, scopeMissing: true });
      fail(res, err);
    }
  });

  router.get("/ghl/messages", async (req, res) => {
    try {
      const { locationId, client } = resolveLocation(req);
      const { days, tzOffset, end } = readWindow(req);
      const result = await cachedScan(`messages:${locationId}:${days}:${tzOffset}:${end || "now"}`,
        () => serialized(locationId, () => scanMessages(client, locationId, days, tzOffset, end)));
      res.json(result === PENDING ? { ok: true, pending: true } : result);
    } catch (err) {
      if (scopeMissing(err)) return res.json({ ok: true, scopeMissing: true });
      fail(res, err);
    }
  });

  return router;
}
