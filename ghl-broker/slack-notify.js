// slack-notify.js — the app's news, told to Slack.
//
// Matt, 2026-10-24: one place he (and later a VA) can watch the app work —
// Tier 1 houses, underwrites, offers, deals, the machine. The app is the
// source; shared/slack-notify.js has which event goes to which channel and
// the words. This reads, claims, and posts.
//
//   - Events: every minute, the contact_events of the last few hours that a
//     stream hears about. A house keeps one thread per channel; an underwrite
//     run keeps one message, edited as it goes.
//   - Needs Matt: every tick, what's on GHL's Needs Matt list (needs-matt.js
//     keeps it on its cursor, stage or no stage), once each. With the stage
//     rule off, the rows the GHL pings read (pingReasons) instead.
//   - Machine: every tick, a new kind of app error, or a job whose last run
//     failed, once each.
//   - Daily: the morning numbers and the evening loose ends, once a day each
//     (daily-gate.js).
//
// One post per thing: the claim is written to the job cursor BEFORE the post,
// so a second loop, a hand run or a restart finds it taken. A post that fails
// keeps its claim (a message is a nicety, not a duty) and is a durable error;
// Slack's rate limit gives the claim back and stops the run.
//
// Never texts anyone. Off unless saved.slack is on with a bot token and the
// stream has a channel. Ids, house and first name only — never a phone, an
// email or what anyone wrote.

import { store as defaultStore } from "./store.js";
import { recordError, scrubMessage } from "./app-errors.js";
import { claimDailyRun, closeDailyRun } from "./daily-gate.js";
import { pingReasons } from "./shared/hand-off.js";
import { pingClaimKey } from "./shared/ghl-pings.js";
import { buildDigest } from "./shared/digest.js";
import { lineJobs, errorsByArea } from "./shared/line.js";
import { addressKey } from "./shared/us-address.js";
import { getContact } from "./ghl.js";
import { contactName } from "./contact-record.js";
import { normalizeGhlStages } from "./shared/ghl-stages.js";
import { NEEDS_MATT_CURSOR } from "./shared/needs-matt.js";
import {
  fullName, normalizeSlack, slackOn, streamOn, routeEvent, threadKeyFor, foldBlasts, renderEvent, renderBlasts, renderPing, renderNeed,
  renderError, renderJobFailed, renderMorning, renderEvening, morningCounts, slackClaimKey, firstName,
  SLACK_EVENT_TYPES, MORNING_EVENT_TYPES, SLACK_STREAMS, SLACK_STREAM_LABEL,
} from "./shared/slack-notify.js";

export const CURSOR_NAME = "slack";
export const PINGS_CURSOR = "slackPings";
export const MORNING_CURSOR = "slackMorning";
export const EVENING_CURSOR = "slackEvening";
export const MAX_PER_RUN = 30;
export const STALE_RUN_MS = 10 * 60 * 1000;
// How far back the event sweep reads. A claim is kept a while past it, so an
// event can't come round again as the window slides.
const LOOKBACK_MS = 6 * 3600 * 1000;
// A backfill (by hand, POST /slack/run { since }) reads at most this far back.
const BACKFILL_MAX_MS = 48 * 3600 * 1000;
const CLAIM_KEEP_MS = 2 * 86400000;
const THREAD_KEEP_MS = 90 * 86400000;
const PING_KEEP_MS = 60 * 86400000;
const SUMMARY_MAX_AGE_MS = 3 * 86400000;
const iso = (ms) => new Date(ms).toISOString();
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/* ---------- Slack's Web API ---------- */

/**
 * slackApi(token, method, body) → Slack's reply. Throws on !ok with
 * err.slack (Slack's error code) and err.retryAfter on a rate limit.
 */
export async function slackApi(token, method, body = {}) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429 || !r.ok || !j?.ok) {
    const code = r.status === 429 ? "rate_limited" : j?.error || `http_${r.status}`;
    const err = new Error(`slack ${method}: ${code}`);
    err.slack = code;
    if (code === "rate_limited") err.retryAfter = Number(r.headers?.get?.("retry-after")) || 30;
    throw err;
  }
  return j;
}

const post = (token, channel, msg, extra = {}) => slackApi(token, "chat.postMessage", { channel, text: msg.text, blocks: msg.blocks, unfurl_links: false, unfurl_media: false, ...extra });
const edit = (token, channel, ts, msg) => slackApi(token, "chat.update", { channel, ts, text: msg.text, blocks: msg.blocks });

/* ---------- cursors ---------- */

async function readDoc(store, locationId, name) {
  const cur = await store.getJobCursor?.(locationId, name).catch(() => null);
  return cur?.doc || {};
}
async function patchCursor(store, locationId, name, patch) {
  const doc = await readDoc(store, locationId, name);
  await store.setJobCursor?.(locationId, name, { at: iso(Date.now()), doc: { ...doc, ...patch } }).catch(() => {});
}
const prune = (map = {}, keepMs, now, at = (v) => v) => Object.fromEntries(Object.entries(map || {}).filter(([, v]) => { const t = ms(at(v)); return t != null && now - t < keepMs; }));

/* ---------- who and which house, for the words ---------- */

// The contact's name, the house's live offer, the latest summary. One read
// per contact per run; any of it may be missing. A name the record doesn't
// have is read from GHL, when there's a client to read it with.
function contextReader({ store, locationId, cfg, now, client = null }) {
  const cache = new Map();
  return async (ev) => {
    const id = ev?.contactId;
    if (!id) return { appUrl: cfg.appUrl, appLink: cfg.appLink, locationId };
    if (!cache.has(id)) {
      cache.set(id, (async () => {
        const [profile, offers, summaries] = await Promise.all([
          store.getContactProfile?.(locationId, id).catch(() => null),
          store.listOffers?.(locationId, { contactId: id, limit: 20, lean: true }).catch(() => []),
          store.listContactEvents?.(locationId, id, { types: ["text_summary"], limit: 5 }).catch(() => []),
        ]);
        const latest = (summaries || []).filter((e) => e?.data?.summary).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
        const fresh = latest && now - (ms(latest.at) ?? 0) < SUMMARY_MAX_AGE_MS ? latest.data.summary : "";
        let name = profile?.name || "";
        if (!name && client) name = contactName(await getContact(client, id).catch(() => null));
        return { name: firstName(name), full: fullName(name), offers: offers || [], summary: fresh };
      })());
    }
    const c = await cache.get(id);
    const house = addressKey(ev.address || "");
    const offer = (ev.offerId && c.offers.find((o) => o.id === ev.offerId))
      || (house && c.offers.find((o) => addressKey(o.address || "") === house))
      || (!ev.address ? c.offers.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] : null)
      || null;
    return {
      appUrl: cfg.appUrl, appLink: cfg.appLink, locationId, firstName: c.name, fullName: c.full, summary: c.summary,
      address: ev.address || offer?.address || "", offerId: ev.offerId || offer?.id || null,
      ours: Number(offer?.cashAmount) > 0 ? Number(offer.cashAmount) : null,
    };
  };
}

/* ---------- events: every minute ---------- */

/**
 * runSlackEvents({ store, locationId, saved, now, dryRun, since, max, paceMs }) → { posted, skipped, failed, error }
 *
 * The first run after Slack is switched on only marks where it starts: no
 * history is posted. A backfill passes `since` (at most 48 hours back) to
 * post what happened before that; the claims keep it from posting anything
 * twice. `max` posts a run, `paceMs` between posts (Slack's rate limit).
 */
export async function runSlackEvents({ store = defaultStore, locationId, client = null, saved = {}, now = Date.now(), dryRun = false, since = null, max = MAX_PER_RUN, paceMs = 0, refresh = false } = {}) {
  const cfg = normalizeSlack(saved?.slack);
  const token = String(saved?.slackBotToken || "").trim();
  const out = { dryRun, startedAt: iso(now), finishedAt: null, read: 0, posted: [], skipped: 0, failed: [], error: null };
  const done = () => { out.finishedAt = iso(Date.now()); return out; };
  if (!slackOn(cfg, token)) { out.error = "off: switch Slack on and paste the bot token in Settings"; return done(); }

  const doc = await readDoc(store, locationId, CURSOR_NAME);
  const backfillFrom = ms(since);
  if (!doc.since && backfillFrom == null) {
    if (!dryRun) await patchCursor(store, locationId, CURSOR_NAME, { since: iso(now), posted: {}, threads: {} });
    out.error = "started: events from now on";
    return done();
  }
  const from = backfillFrom != null
    ? iso(Math.max(backfillFrom, now - BACKFILL_MAX_MS))
    : iso(Math.max(ms(doc.since) ?? 0, now - LOOKBACK_MS));
  const events = (await store.listContactEventsSince(locationId, from, { types: SLACK_EVENT_TYPES, limit: 3000 }).catch(() => []))
    .slice().sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  out.read = events.length;
  let posted = prune(doc.posted, CLAIM_KEEP_MS, now);
  let threads = prune(doc.threads, THREAD_KEEP_MS, now, (v) => v?.at);

  // What's owed, oldest first: one item per event per stream, and one per
  // deal for the buyer texts of a wave.
  const items = [];
  for (const e of events) {
    if (e.type === "blast_sent") continue;
    for (const route of routeEvent(e)) {
      if (!streamOn(cfg, route.stream)) continue;
      const key = slackClaimKey("ev", `${e.id}:${route.stream}`);
      if (!posted[key]) items.push({ keys: [key], ev: e, route });
      // A backfill with `refresh` re-renders the posts that opened a thread
      // (a new format, 2026-10-25), editing them in place.
      else if (refresh && route.opensOnly) items.push({ keys: [key], ev: e, route, refresh: true });
    }
  }
  if (streamOn(cfg, "dispositions")) {
    const unclaimed = events.filter((e) => e.type === "blast_sent" && !posted[slackClaimKey("ev", `${e.id}:dispositions`)]);
    for (const g of foldBlasts(unclaimed)) {
      items.push({ keys: g.ids.map((id) => slackClaimKey("ev", `${id}:dispositions`)), blasts: g,
        ev: { type: "blast_sent", offerId: g.offerId, address: g.address, at: g.at }, route: { stream: "dispositions", kind: "waves", thread: "deal" } });
    }
    items.sort((a, b) => String(a.ev.at).localeCompare(String(b.ev.at)));
  }

  const ctxFor = contextReader({ store, locationId, cfg, now, client });
  const refreshed = new Set();
  for (const it of items) {
    if (out.posted.length >= max) { out.skipped++; out.more = true; continue; }
    const ctx = await ctxFor(it.ev);
    const msg = it.blasts ? renderBlasts(it.blasts, ctx) : renderEvent(it.route, it.ev, ctx);
    const channel = cfg.channels[it.route.stream];
    const tk = threadKeyFor(it.route, it.ev, ctx);
    const th = tk && threads[tk]?.channel === channel ? threads[tk] : null;
    const row = { stream: it.route.stream, kind: it.route.kind, contactId: it.ev.contactId || null, type: it.ev.type };
    if (it.refresh) {
      if (!th || th.ts === "dry-run" || refreshed.has(tk)) { out.skipped++; continue; }
      refreshed.add(tk);
      if (dryRun) { out.posted.push({ ...row, status: "would refresh", house: String(ctx.address || it.ev.address || "").split(",")[0] }); continue; }
      if (paceMs > 0 && out.posted.length) await new Promise((r) => setTimeout(r, paceMs));
      try {
        await edit(token, channel, th.ts, msg);
        out.posted.push({ ...row, status: "refreshed" });
      } catch (e) {
        if (e?.slack === "rate_limited") { out.error = "rate limited: the rest next run"; break; }
        out.failed.push({ ...row, error: scrubMessage(e).slice(0, 160) });
      }
      continue;
    }
    // Nothing to reply to, or a house already open: claimed and let go, so
    // it isn't weighed again.
    if ((it.route.replyOnly && !th) || (it.route.opensOnly && th)) {
      out.skipped++;
      if (!dryRun) for (const k of it.keys) posted[k] = iso(now);
      continue;
    }
    if (dryRun) {
      // What this run would open, so the preview threads like the real one.
      if (tk && !th) threads = { ...threads, [tk]: { ts: "dry-run", channel, at: iso(now) } };
      out.posted.push({ ...row, status: th ? (it.route.update ? "would edit" : "would reply") : "would post", house: String(ctx.address || it.ev.address || "").split(",")[0] });
      continue;
    }
    if (paceMs > 0 && out.posted.length) await new Promise((r) => setTimeout(r, paceMs));

    // Claim first.
    const at = iso(now);
    for (const k of it.keys) posted[k] = at;
    await patchCursor(store, locationId, CURSOR_NAME, { posted });
    try {
      let ts = th?.ts || null;
      if (it.route.update && th) await edit(token, channel, th.ts, msg);
      else if (th && it.route.thread !== "run") await post(token, channel, msg, { thread_ts: th.ts, ...(it.route.broadcast ? { reply_broadcast: true } : {}) });
      else ts = (await post(token, channel, msg))?.ts || null;
      if (tk && ts) {
        threads = { ...threads, [tk]: { ts, channel, at } };
        await patchCursor(store, locationId, CURSOR_NAME, { threads });
      }
      out.posted.push({ ...row, status: th ? (it.route.update ? "edited" : "replied") : "posted" });
    } catch (e) {
      if (e?.slack === "rate_limited") {
        for (const k of it.keys) delete posted[k];
        await patchCursor(store, locationId, CURSOR_NAME, { posted });
        out.error = `rate limited: the rest next run`;
        break;
      }
      const error = scrubMessage(e).slice(0, 160);
      await recordError(store, { locationId, area: "slack", err: e, context: { contactId: row.contactId, stage: `${row.stream}:${row.kind}` } });
      out.failed.push({ ...row, error });
    }
  }
  if (!dryRun) await patchCursor(store, locationId, CURSOR_NAME, { posted });
  return done();
}

/* ---------- needs Matt and the machine: every tick ---------- */

/**
 * runSlackPings({ store, locationId, saved, deps, now, dryRun }) → { posted, skipped, failed }
 *
 * Needs Matt is the list needs-matt.js keeps (it runs first on the tick):
 * the same things GHL's Needs Matt stage holds, said the same way.
 *
 *   deps.pipelineFor  routes/dashboard.js router.pipelineFor — only with the
 *                     stage rule off, for the rows the GHL pings read
 */
export async function runSlackPings({ store = defaultStore, locationId, saved = {}, deps = {}, now = Date.now(), dryRun = false } = {}) {
  const cfg = normalizeSlack(saved?.slack);
  const token = String(saved?.slackBotToken || "").trim();
  const out = { dryRun, startedAt: iso(now), finishedAt: null, posted: [], skipped: 0, failed: [], error: null };
  const done = () => { out.finishedAt = iso(Date.now()); return out; };
  if (!slackOn(cfg, token)) { out.error = "off"; return done(); }
  const doc = await readDoc(store, locationId, PINGS_CURSOR);
  let claimed = prune(doc.claimed, PING_KEEP_MS, now);

  const owed = [];
  if (streamOn(cfg, "needsMatt") && normalizeGhlStages(saved?.ghlStages).mode === "on") {
    const list = await readDoc(store, locationId, NEEDS_MATT_CURSOR);
    for (const [contactId, v] of Object.entries(list.needs || {})) {
      if (!v?.key) continue;
      const key = slackClaimKey("need", v.key);
      if (!claimed[key]) owed.push({ key, stream: "needsMatt", contactId, kind: v.kind, msg: renderNeed({ ...v, contactId }, { ...cfg, locationId }) });
    }
  } else if (streamOn(cfg, "needsMatt") && typeof deps.pipelineFor === "function") {
    const read = await deps.pipelineFor({ locationId, client: deps.client, now });
    for (const r of pingReasons(read.deskAll?.rows || read.desk?.rows || [], { drafts: read.drafts || [] })) {
      const key = slackClaimKey("ping", pingClaimKey(r));
      if (!claimed[key]) owed.push({ key, stream: "needsMatt", contactId: r.contactId || null, kind: r.kind, msg: renderPing(r, { ...cfg, locationId }) });
    }
  }
  if (streamOn(cfg, "machine")) {
    const errors = await store.listAppErrorsSince?.(locationId, iso(now - 86400000), { limit: 100 }).catch(() => []) || [];
    for (const e of errors) {
      // A Slack error told to Slack goes nowhere useful; it's on the switchboard.
      if (e?.area === "slack" || !e?.fingerprint) continue;
      if ((ms(e.firstAt) ?? 0) < now - 86400000) continue;
      const key = slackClaimKey("err", e.fingerprint);
      if (!claimed[key]) owed.push({ key, stream: "machine", kind: "error", msg: renderError(e) });
    }
    const cursors = await store.listJobCursors?.(locationId).catch(() => []) || [];
    for (const j of lineJobs(cursors, { now })) {
      if (!j.failed || !j.lastRunAt) continue;
      const key = slackClaimKey("job", `${j.name}:${j.lastRunAt}`);
      if (!claimed[key]) owed.push({ key, stream: "machine", kind: "job", msg: renderJobFailed(j) });
    }
  }

  for (const o of owed) {
    if (out.posted.length >= MAX_PER_RUN) { out.skipped++; continue; }
    const row = { stream: o.stream, kind: o.kind, contactId: o.contactId || null };
    if (dryRun) { out.posted.push({ ...row, status: "would post" }); continue; }
    claimed = { ...claimed, [o.key]: iso(now) };
    await patchCursor(store, locationId, PINGS_CURSOR, { claimed });
    try {
      await post(token, cfg.channels[o.stream], o.msg);
      out.posted.push({ ...row, status: "posted" });
    } catch (e) {
      if (e?.slack === "rate_limited") {
        const { [o.key]: _gone, ...rest } = claimed;
        claimed = rest;
        await patchCursor(store, locationId, PINGS_CURSOR, { claimed });
        out.error = "rate limited: the rest next run";
        break;
      }
      await recordError(store, { locationId, area: "slack", err: e, context: { contactId: row.contactId, stage: `${row.stream}:${row.kind}` } });
      out.failed.push({ ...row, error: scrubMessage(e).slice(0, 160) });
    }
  }
  return done();
}

/* ---------- the day: morning numbers, evening loose ends ---------- */

/** postMorning({ store, locationId, saved, now }) → { posted, counts } */
export async function postMorning({ store = defaultStore, locationId, saved = {}, now = Date.now() } = {}) {
  const cfg = normalizeSlack(saved?.slack);
  const token = String(saved?.slackBotToken || "").trim();
  const since = iso(now - 86400000);
  const events = await store.listContactEventsSince(locationId, since, { types: MORNING_EVENT_TYPES, limit: 20000 }).catch(() => []);
  const counts = morningCounts(events, { since, until: iso(now) });
  await post(token, cfg.channels.daily, renderMorning(counts, { ...cfg, locationId, dayLabel: "the last 24 hours" }));
  return { posted: true, counts };
}

/** postEvening({ store, locationId, saved, now }) → { posted, open } */
export async function postEvening({ store = defaultStore, locationId, saved = {}, now = Date.now() } = {}) {
  const cfg = normalizeSlack(saved?.slack);
  const token = String(saved?.slackBotToken || "").trim();
  const since = iso(now - 86400000);
  // The digest route's own reads (routes/dashboard.js GET /digest).
  const [drafts, events, offers, cursors, errors] = await Promise.all([
    store.listReplyDrafts?.(locationId, { since, limit: 1000 }).catch(() => []),
    store.listContactEventsSince(locationId, since, { types: ["promise_owed", "promise_kept"], limit: 2000 }).catch(() => []),
    store.listOffers(locationId, { limit: 1000, lean: true }).catch(() => []),
    store.listJobCursors?.(locationId).catch(() => []),
    store.listAppErrorsSince?.(locationId, since, { limit: 100 }).catch(() => []),
  ]);
  const digest = buildDigest({ drafts: drafts || [], events: events || [], offers: offers || [], now, hours: 24 });
  const msg = renderEvening(digest, { jobs: lineJobs(cursors || [], { now }), errors: errorsByArea((errors || []).filter((e) => e?.area !== "slack")) }, { ...cfg, locationId });
  await post(token, cfg.channels.daily, msg);
  return { posted: true, open: (digest.sections || []).reduce((a, s) => a + (s.items?.length || 0), 0) };
}

/* ---------- the test button ---------- */

/** testSlack({ saved }) → { results: [{ stream, channel, ok, error }] } — one hello per channel set, on or off. */
export async function testSlack({ saved = {} } = {}) {
  const cfg = normalizeSlack(saved?.slack);
  const token = String(saved?.slackBotToken || "").trim();
  if (!token) return { results: [], error: "paste the bot token first" };
  const results = [];
  for (const s of SLACK_STREAMS) {
    const channel = cfg.channels[s];
    if (!channel) continue;
    try {
      await post(token, channel, { text: `Shep Flips is connected — this channel gets ${SLACK_STREAM_LABEL[s]}.`, blocks: undefined });
      results.push({ stream: s, channel, ok: true });
    } catch (e) {
      results.push({ stream: s, channel, ok: false, error: e?.slack || scrubMessage(e).slice(0, 120) });
    }
  }
  return { results };
}

/* ---------- the loops ---------- */

const pacificHour = (t) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date(t))) % 24;
const running = new Set();
export function _resetSlack() { running.clear(); }

// What a run did, for the cursor: kinds and ids, not words.
export const summarizeSlack = (r) => ({
  startedAt: r?.startedAt || null, finishedAt: r?.finishedAt || null, error: r?.error || null, read: r?.read ?? null,
  posted: (r?.posted || []).length, skipped: r?.skipped || 0,
  failed: (r?.failed || []).map((p) => ({ stream: p.stream, kind: p.kind, error: p.error })),
});

// The audit's gating (conversation-audit.js maybeRunConversationAudit): the
// cursor is stamped before the run, a run that died under a deploy is
// retried once it's stale, one at a time in this broker.
async function gated({ store, locationId, cursorName, now, run }) {
  const key = `${locationId}:${cursorName}`;
  if (running.has(key)) return null;
  const doc = await readDoc(store, locationId, cursorName);
  const started = ms(doc.run?.startedAt);
  if (started != null && now - started < STALE_RUN_MS) return null;
  await patchCursor(store, locationId, cursorName, { run: { startedAt: iso(now) } });
  running.add(key);
  try {
    const r = await run();
    await patchCursor(store, locationId, cursorName, { run: null, last: summarizeSlack(r) });
    return r;
  } catch (e) {
    await recordError(store, { locationId, area: "slack", err: e, context: { stage: cursorName } });
    await patchCursor(store, locationId, cursorName, { run: null, last: { error: scrubMessage(e).slice(0, 200), finishedAt: iso(Date.now()) } });
    return null;
  } finally {
    running.delete(key);
  }
}

/**
 * runSlackEventsNow(opts) → the run, or { busy: true } — a hand run (a
 * backfill) under the minute loop's own lock, so the two never write the
 * thread map over each other.
 */
export async function runSlackEventsNow({ store = defaultStore, locationId, now = Date.now(), ...opts } = {}) {
  if (opts.dryRun) return runSlackEvents({ store, locationId, now, ...opts });
  const r = await gated({ store, locationId, cursorName: CURSOR_NAME, now, run: () => runSlackEvents({ store, locationId, now, ...opts }) });
  return r || { busy: true, error: "the minute loop is posting: try again in a minute" };
}

/** maybeRunSlackEvents({ locationId, client, saved, store, now }) → the run, or null — the minute loop. */
export async function maybeRunSlackEvents({ locationId, client = null, saved = {}, store = defaultStore, now = Date.now() }) {
  if (!slackOn(normalizeSlack(saved?.slack), saved?.slackBotToken)) return null;
  return gated({ store, locationId, cursorName: CURSOR_NAME, now, run: () => runSlackEvents({ store, locationId, client, saved, now }) });
}

/**
 * maybeRunSlack({ client, locationId, saved, store, deps, now }) → { pings, morning, evening } | null
 *
 * Off the 15-minute tick: needs-Matt rows and the machine every tick, the
 * morning numbers from morningHour and the evening loose ends from
 * eveningHour (Pacific), once a day each.
 */
export async function maybeRunSlack({ client, locationId, saved = {}, store = defaultStore, deps = {}, now = Date.now() }) {
  const cfg = normalizeSlack(saved?.slack);
  if (!slackOn(cfg, saved?.slackBotToken)) return null;
  const out = { pings: null, morning: null, evening: null };
  if (streamOn(cfg, "needsMatt") || streamOn(cfg, "machine")) {
    out.pings = await gated({ store, locationId, cursorName: PINGS_CURSOR, now, run: () => runSlackPings({ store, locationId, saved, deps: { ...deps, client }, now }) });
  }
  if (streamOn(cfg, "daily")) {
    const hourNow = pacificHour(now);
    for (const [name, startHour, fn] of [[MORNING_CURSOR, cfg.morningHour, postMorning], [EVENING_CURSOR, cfg.eveningHour, postEvening]]) {
      const gate = await claimDailyRun({ store, locationId, cursorName: name, now, hourNow, startHour, windowHours: 2, running: running.has(`${locationId}:${name}`) });
      if (!gate.go) continue;
      running.add(`${locationId}:${name}`);
      try {
        const r = await fn({ store, locationId, saved, now });
        await closeDailyRun({ store, locationId, cursorName: name, last: { ...r, finishedAt: iso(Date.now()) } });
        out[name === MORNING_CURSOR ? "morning" : "evening"] = r;
      } catch (e) {
        await recordError(store, { locationId, area: "slack", err: e, context: { stage: name } });
        await closeDailyRun({ store, locationId, cursorName: name, failed: true, error: scrubMessage(e) });
      } finally {
        running.delete(`${locationId}:${name}`);
      }
    }
  }
  return out;
}
