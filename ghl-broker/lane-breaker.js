// lane-breaker.js — a send lane whose texts get blocked or STOPped pauses
// itself (2026-11-23 audit, AH-4). Rules: shared/lane-breaker.js.
//
// Every 15-minute tick (gated like the nightly audit: the cursor written
// before the run, a stale run retried, the day's tries capped) it looks at
// each guarded kind of machine text (lot owner first texts and follow-ups,
// agent first texts and nudges, agent and buyer check-ins, deal texts,
// gatekeeper texts):
//
//   - today's first sends, the last fifty, and the last fifty old enough for
//     a STOP to have come, from the store; only what went since the breaker
//     started watching the kind (`since`, stamped on its first run, so the
//     blocks from before it existed never trip it on deploy day) and since
//     Matt last cleared it;
//   - how the young ones went, read from GHL the way the delivery check reads
//     them (ghl.js getMessage), at most LANE_MAX_READS a run, ~300 ms apart,
//     from 5 minutes after the send. The verdict goes on the draft as
//     `laneRead`, never `delivery`, so the delivery check still does its own
//     work on it later (the failure event, the lot owner's one retry, a dead
//     number);
//   - the STOPs (`unsubscribed` events) that came within 72 hours of one.
//
// A kind that trips: its trip goes on the cursor first (from then the send
// loop holds any of that kind that comes due, conversation-scheduler.js
// `heldKindsFor`), every one of its texts still scheduled goes back to a
// draft with the reason on it (only while still scheduled: never one the send
// loop has claimed), and one Slack line @Matt says which lane and the counts.
// Each later run holds anything of that kind scheduled since. It stays so
// until Matt clears it (routes/lane-breaker.js). Nothing is deleted and
// nothing is ever sent from here.
//
// On by default (conversationAi.laneBreaker.enabled): it only stops sends.
// Off, nothing is read from GHL and nothing new is held; the tick only marks
// the cursor (`offAt`) so that, switched back on, it starts watching afresh.
// A trip that stood when it was switched off stays on the strip for Matt to
// clear. Counts, kinds and ids in the cursor and the logs; never a name, a
// number or what was said.

import { store as defaultStore } from "./store.js";
import { getMessage as defaultGetMessage } from "./ghl.js";
import { recordError, scrubMessage } from "./app-errors.js";
import { slackApi } from "./slack-notify.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { normalizeSlack, slackOn, streamOn } from "./shared/slack-notify.js";
import { deliveryVerdict } from "./shared/delivery.js";
import { answersInbound } from "./shared/follow-up.js";
import { spreadAcrossDay, machineHours } from "./conversation-scheduler.js";
import {
  LANE_BREAKER_CURSOR, LANE_MAX_READS, LANE_MIN_AGE_MS, LANE_MAX_AGE_MS,
  laneVerdict, laneSince, laneRunGate, stoppedSends, sendRead, heldKinds, heldDraft, releasedDraft, slackTripLine, laneLabel,
  baselineDoc, goesBackOnClock, backOnClockDraft,
} from "./shared/lane-breaker.js";

export const CURSOR_NAME = LANE_BREAKER_CURSOR;
export const PACE_MS = 300;
const HISTORY_KEEP = 20;
const SENT_SETTLE_MS = 60 * 60000;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/** breakerConfig(saved) → the normalised conversationAi.laneBreaker. */
export const breakerConfig = (saved = {}) => normalizeConversationAi(saved?.conversationAi).laneBreaker;

async function readDoc(store, locationId) {
  return (await store.getJobCursor?.(locationId, CURSOR_NAME).catch(() => null))?.doc || {};
}
// Read, change, write: the clear route and the run both write this cursor,
// so neither writes back a copy it read before the other's change.
async function patchDoc(store, locationId, fn, now = Date.now()) {
  const doc = await readDoc(store, locationId);
  const next = fn(doc) || doc;
  await store.setJobCursor?.(locationId, CURSOR_NAME, { at: iso(now), doc: next }).catch(() => {});
  return next;
}

/**
 * laneHoldsFor({ store, locationId, saved }) → Map(kind → trip)
 *
 * What the send loop holds: the kinds the breaker has stopped, while it is
 * on. A read that fails holds nothing new (the run holds them on its next
 * pass); it never blocks the loop.
 */
export async function laneHoldsFor({ store = defaultStore, locationId, saved = null }) {
  try {
    const s = saved || (await store.getOfferSettings?.(locationId)) || {};
    const cfg = breakerConfig(s);
    if (!cfg.enabled) return new Map();
    return heldKinds(await readDoc(store, locationId), cfg);
  } catch { return new Map(); }
}

/**
 * holdScheduled({ store, locationId, trips, now }) → { [kind]: n }
 *
 * Every text of a stopped kind still waiting to go by itself goes back to a
 * draft (shared/lane-breaker.js heldDraft). An answer to their own text is
 * never touched. The write only lands while the row is still "scheduled".
 */
export async function holdScheduled({ store = defaultStore, locationId, trips, now = Date.now() }) {
  const held = {};
  const kinds = trips instanceof Map ? trips : new Map(Object.entries(trips || {}));
  if (!kinds.size) return held;
  const rows = await store.listReplyDrafts(locationId, { status: "scheduled", limit: 5000 }).catch(() => []);
  for (const d of rows) {
    const kind = d?.outbound?.kind;
    if (!kind || !kinds.has(kind) || answersInbound(d)) continue;
    const next = heldDraft(d, kind, kinds.get(kind), now);
    const wrote = typeof store.updateReplyDraftIf === "function"
      ? await store.updateReplyDraftIf(d.id, "scheduled", next).catch(() => false)
      : await store.updateReplyDraft(d.id, next).catch(() => false);
    if (wrote) held[kind] = (held[kind] || 0) + 1;
  }
  return held;
}

// The young sends with no verdict yet, read from GHL. Today's first sends of
// every kind first, then the rest of the window, newest first.
async function readYoung({ client, store, locationId, lanes, now, read, pace, out }) {
  const copies = new Map();
  const queue = [];
  const consider = (s) => {
    if (!copies.has(s.id)) copies.set(s.id, []);
    copies.get(s.id).push(s);
    if (copies.get(s.id).length > 1 || sendRead(s) || s.laneRead || !s.ghlMessageId) return;
    const age = now - (ms(s.sentAt) ?? now);
    if (age < LANE_MIN_AGE_MS || age > LANE_MAX_AGE_MS) return;
    queue.push(s);
  };
  for (const l of lanes) for (const s of l.early) consider(s);
  for (const l of lanes) for (const s of l.recent) consider(s);
  for (const [i, s] of queue.slice(0, LANE_MAX_READS).entries()) {
    if (i > 0 && pace > 0) await sleep(pace);
    let verdict;
    try {
      const v = deliveryVerdict(await read(client, s.ghlMessageId));
      out.reads++;
      // "sent" is GHL handing it to the carrier, not the carrier's answer:
      // looked at again next run while the send is under an hour old.
      if (v.pending || (v.status === "sent" && now - (ms(s.sentAt) ?? now) < SENT_SETTLE_MS)) continue;
      verdict = { status: v.status, code: v.code, checkedAt: iso(now) };
    } catch (e) {
      if (Number(e?.status) !== 404) {
        out.readErrors++;
        if (out.readErrors === 1) await recordError(store, { locationId, area: "lane-breaker", err: e, context: { draftId: s.id, stage: "read" } });
        continue;
      }
      verdict = { status: "unknown", code: null, checkedAt: iso(now) };
    }
    for (const c of copies.get(s.id) || []) c.laneRead = verdict;
    // Merged in one write, only while no verdict is on it (store.setLaneRead),
    // without touching updatedAt: the verdict is not an edit, and the delivery
    // check writing the same draft on its own tick never loses its own.
    if (typeof store.setLaneRead === "function") {
      await store.setLaneRead(s.id, verdict).catch(() => {});
    } else {
      const fresh = await store.getReplyDraft(s.id).catch(() => null);
      if (fresh && !fresh.delivery && !fresh.laneRead) await store.updateReplyDraft(s.id, { ...fresh, laneRead: verdict }).catch(() => {});
    }
  }
}

/**
 * runLaneBreaker({ client, locationId, saved, store, now, deps, pace })
 *   → { kinds, reads, readErrors, tripped: [{ kind, rule }], held: { kind: n }, posted, finishedAt }
 *
 * deps.getMessage, deps.slackApi — stubs in tests.
 */
export async function runLaneBreaker({ client, locationId, saved = {}, store = defaultStore, now = Date.now(), deps = {}, pace = PACE_MS } = {}) {
  const cfg = breakerConfig(saved);
  const out = { kinds: {}, reads: 0, readErrors: 0, tripped: [], held: {}, posted: 0, finishedAt: null };
  if (!cfg.enabled) return { ...out, off: true, finishedAt: iso(Date.now()) };
  const read = deps.getMessage || defaultGetMessage;
  // 0. What it watches starts from when it started watching: the first run
  // stamps `since` on every kind before judging any (and a kind added later,
  // or every kind after it was switched back on).
  let start = await readDoc(store, locationId);
  if (baselineDoc(start, cfg.kinds, now)) {
    start = await patchDoc(store, locationId, (d) => baselineDoc(d, cfg.kinds, now) || d, now);
    out.baselined = true;
  }

  // 1. Each kind's sends: today's first, the last ones, and the last ones a
  // STOP has had time to come for.
  const lanes = [];
  for (const kind of cfg.kinds) {
    const since = laneSince(start, kind, { now, cfg });
    const recent = await store.listLaneSends(locationId, kind, { sinceIso: since.rollingFrom, order: "desc", limit: cfg.rollingSends });
    const early = await store.listLaneSends(locationId, kind, { sinceIso: since.earlyFrom, order: "asc", limit: cfg.earlySends });
    const settled = since.settledBefore < since.rollingFrom ? []
      : await store.listLaneSends(locationId, kind, { sinceIso: since.rollingFrom, untilIso: since.settledBefore, order: "desc", limit: cfg.rollingSends });
    lanes.push({ kind, recent, early, settled });
  }

  // 2. How the young ones went.
  await readYoung({ client, store, locationId, lanes, now, read, pace, out });

  // 3. The STOPs, each against the newest guarded text before it.
  const all = new Map();
  for (const l of lanes) for (const s of [...l.recent, ...l.early, ...l.settled]) all.set(s.id, s);
  const oldest = [...all.values()].reduce((m, s) => (String(s.sentAt) < m ? String(s.sentAt) : m), iso(now));
  const stops = all.size && typeof store.listContactEventsSince === "function"
    ? await store.listContactEventsSince(locationId, oldest, { types: ["unsubscribed"], limit: 5000 }).catch(() => []) : [];
  const stopped = stoppedSends([...all.values()], stops, { stopHours: cfg.stopHours });

  // 4. The verdict on each kind not already stopped.
  const fresh = [];
  for (const l of lanes) {
    const v = laneVerdict({ kind: l.kind, early: l.early, recent: l.recent, settled: l.settled, stopped, cfg });
    out.kinds[l.kind] = { ...v.counts, trip: v.trip ? v.rule : "" };
    if (v.trip && !start.trips?.[l.kind]) fresh.push({ kind: l.kind, rule: v.rule, why: v.why, counts: v.counts });
  }

  // 5. The trip on the cursor before anything is held: from here the send
  // loop holds that kind whatever happens to this run. A kind Matt cleared
  // while this run was reading is left alone.
  const startedAt = iso(now);
  let doc = await patchDoc(store, locationId, (d) => {
    const trips = { ...(d.trips || {}) };
    for (const t of fresh) {
      if (trips[t.kind] || (d.cleared?.[t.kind]?.at && d.cleared[t.kind].at > startedAt)) continue;
      trips[t.kind] = { at: startedAt, rule: t.rule, why: t.why, counts: t.counts, held: 0 };
      out.tripped.push({ kind: t.kind, rule: t.rule });
    }
    return { ...d, trips };
  }, now);

  // 6. Everything of a stopped kind still scheduled goes back to drafts:
  // the new trips, and whatever was scheduled since an older one.
  const holding = heldKinds(doc, cfg);
  out.held = await holdScheduled({ store, locationId, trips: holding, now });
  if (Object.keys(out.held).length) {
    doc = await patchDoc(store, locationId, (d) => {
      const trips = { ...(d.trips || {}) };
      for (const [kind, n] of Object.entries(out.held)) if (trips[kind]) trips[kind] = { ...trips[kind], held: (Number(trips[kind].held) || 0) + n };
      return { ...d, trips };
    }, now);
  }

  // 7. One line to Matt for each new trip.
  out.posted = await postTrips({ store, locationId, saved, doc, tripped: out.tripped, now, deps });
  out.finishedAt = iso(Date.now());
  return out;
}

// One Slack line @Matt a trip, claimed on the cursor before the post, to
// #needs-matt (or #machine when that is the only stream on).
async function postTrips({ store, locationId, saved, doc, tripped, now, deps }) {
  if (!tripped.length) return 0;
  const cfg = normalizeSlack(saved?.slack);
  const token = String(saved?.slackBotToken || "").trim();
  if (!slackOn(cfg, token)) return 0;
  const stream = streamOn(cfg, "needsMatt") ? "needsMatt" : streamOn(cfg, "machine") ? "machine" : "";
  if (!stream) return 0;
  const post = deps.slackApi || slackApi;
  let posted = 0;
  for (const { kind } of tripped) {
    const trip = doc.trips?.[kind];
    if (!trip) continue;
    const key = `${kind}:${trip.at}`;
    let mine = false;
    await patchDoc(store, locationId, (d) => {
      const claims = { ...(d.posted || {}) };
      if (claims[key]) return d;
      claims[key] = iso(now);
      mine = true;
      // Claims older than two weeks go.
      for (const [k, at] of Object.entries(claims)) if (now - (ms(at) ?? 0) > 14 * 86400000) delete claims[k];
      return { ...d, posted: claims };
    }, now);
    if (!mine) continue;
    try {
      await post(token, "chat.postMessage", { channel: cfg.channels[stream], text: slackTripLine({ kind, why: trip.why, held: Number(trip.held) || 0, mattUserId: cfg.mattUserId }), unfurl_links: false, unfurl_media: false });
      posted++;
    } catch (e) {
      await recordError(store, { locationId, area: "lane-breaker", err: e, context: { kind, stage: "slack" } });
    }
  }
  return posted;
}

/**
 * clearLane({ store, locationId, kind, now, backOnClock, saved, random }) → { cleared, kind, released, rescheduled }
 *
 * Matt's click: the kind may send by itself again, and it is judged afresh
 * from now (the sends that tripped it no longer count). The drafts it held
 * lose the breaker's flag. With `backOnClock` (the strip's "Let it send
 * again"), each one held in the last four days goes back to "scheduled",
 * spread across the machine's day the way the dial's undo spreads them
 * (spreadAcrossDay, its hours, weekends and days off): the send loop still
 * runs every check of its own when each comes due. Older ones, and every one
 * without `backOnClock` (the strip's "keep them as drafts"), stay drafts. A
 * lane that redrafts its own unsent texts (the lot finder's first text)
 * picks a draft up on its next run. Nothing is sent from here.
 */
export async function clearLane({ store = defaultStore, locationId, kind, now = Date.now(), backOnClock = false, saved = null, random = Math.random }) {
  let was = null;
  await patchDoc(store, locationId, (d) => {
    const trips = { ...(d.trips || {}) };
    was = trips[kind] || null;
    delete trips[kind];
    const history = was ? [{ kind, ...was, clearedAt: iso(now) }, ...(d.history || [])].slice(0, HISTORY_KEEP) : d.history || [];
    return { ...d, trips, cleared: { ...(d.cleared || {}), [kind]: { at: iso(now) } }, history };
  }, now);
  let released = 0;
  let rescheduled = 0;
  let a = null;
  if (backOnClock) {
    const s = saved || (await store.getOfferSettings?.(locationId).catch(() => null)) || {};
    a = normalizeConversationAi(s?.conversationAi).autoSend || {};
  }
  const drafts = await store.listReplyDrafts(locationId, { status: "draft", limit: 5000 }).catch(() => []);
  for (const d of drafts) {
    if (d?.laneHold?.kind !== kind) continue;
    const clock = a && goesBackOnClock(d, now);
    const next = clock
      ? backOnClockDraft(d, spreadAcrossDay({ now, quietHours: machineHours(a), hours: a.nudgeSpreadHours ?? 8, random, weekends: a.weekends || "all", offDays: a.offDays || [] }), now)
      : releasedDraft(d, now);
    const wrote = typeof store.updateReplyDraftIf === "function"
      ? await store.updateReplyDraftIf(d.id, "draft", next).catch(() => false)
      : await store.updateReplyDraft(d.id, next).catch(() => false);
    if (wrote) { released++; if (clock) rescheduled++; }
  }
  return { cleared: Boolean(was), kind, released, rescheduled };
}

/**
 * laneBreakerStatus({ store, locationId, saved }) → { enabled, trips: [{ kind, label, at, rule, why, held, counts }], last, history }
 *
 * A trip that stood when the breaker was switched off is still listed (and
 * `enabled` says it's off): its texts are still drafts with the flag on, and
 * the strip is where Matt clears them.
 */
export async function laneBreakerStatus({ store = defaultStore, locationId, saved = {} }) {
  const cfg = breakerConfig(saved);
  const doc = await readDoc(store, locationId);
  const trips = Object.entries(doc.trips || {}).filter(([, t]) => t?.at)
    .map(([kind, t]) => ({ kind, label: laneLabel(kind), at: t.at, rule: t.rule || "", why: t.why || "", held: Number(t.held) || 0, counts: t.counts || null }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { enabled: cfg.enabled, trips, standing: trips.length, last: doc.last || null, history: (doc.history || []).slice(0, 5) };
}

/* ---------- the tick ---------- */

const running = new Set();
export function _resetLaneBreaker() { running.clear(); }

// What a run did, for the cursor: counts and kinds only.
export const summarizeLaneBreaker = (r) => ({
  finishedAt: r?.finishedAt || null, reads: r?.reads ?? 0, readErrors: r?.readErrors ?? 0,
  tripped: (r?.tripped || []).map((t) => t.kind), held: r?.held || {}, posted: r?.posted ?? 0,
  kinds: Object.fromEntries(Object.entries(r?.kinds || {}).map(([k, v]) => [k, { early: v.early, rolling: v.rolling, trip: v.trip }])),
});

/**
 * maybeRunLaneBreaker({ client, locationId, saved, store, now, deps }) → null | { started: true, tries, done }
 *
 * Off when conversationAi.laneBreaker.enabled is false: nothing is read
 * from GHL or the drafts. The tick only marks the cursor once (`offAt`), so
 * the first run after it is switched back on starts every kind afresh
 * (baselineDoc) instead of judging what went while it wasn't watching.
 * The run goes on in the background (`done` settles when it's over).
 */
export async function maybeRunLaneBreaker({ client, locationId, saved = {}, store = defaultStore, now = Date.now(), deps = {}, pace = PACE_MS }) {
  if (!breakerConfig(saved).enabled) {
    const doc = await readDoc(store, locationId);
    if (doc.since && !doc.offAt) await patchDoc(store, locationId, (d) => (d.offAt ? d : { ...d, offAt: iso(now) }), now);
    return null;
  }
  if (running.has(locationId)) return null;
  const doc = await readDoc(store, locationId);
  const gate = laneRunGate(doc, now);
  if (!gate.go) return null;
  // The cursor first, so a deploy mid-run leaves a run to retry, not a gap.
  await patchDoc(store, locationId, (d) => ({
    ...d, day: gate.day, tries: gate.tries, lastRun: iso(now), run: { startedAt: iso(now) }, failed: false, error: "",
    ...(gate.stale ? { staleRun: d.run } : {}),
  }), now);
  running.add(locationId);
  const done = runLaneBreaker({ client, locationId, saved, store, now, deps, pace })
    .then(async (r) => {
      await patchDoc(store, locationId, (d) => ({ ...d, run: null, failed: false, last: summarizeLaneBreaker(r) }));
      if (r.tripped.length) console.log(`lane breaker ${locationId}: stopped ${r.tripped.map((t) => `${t.kind} (${t.rule})`).join(", ")}; held ${JSON.stringify(r.held)}`);
      return r;
    })
    .catch(async (e) => {
      const error = scrubMessage(e).slice(0, 200);
      await recordError(store, { locationId, area: "lane-breaker", err: e, context: { stage: "run" } });
      await patchDoc(store, locationId, (d) => ({ ...d, run: null, failed: true, error, last: { status: "error", error, finishedAt: iso(Date.now()) } }));
      return null;
    })
    .finally(() => running.delete(locationId));
  return { started: true, tries: gate.tries, done };
}
