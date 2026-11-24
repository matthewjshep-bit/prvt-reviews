// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// lane-breaker.js — a send lane whose texts get blocked or STOPped pauses
// itself (2026-11-23 audit, AH-4).
//
// Every machine lane texts from the one business number: lot owners, agent
// first texts and nudges, the agent and buyer check-ins, deal texts. On
// 11-23 the first 49 lot-owner texts had 15 carrier blocks (Error 30007)
// before the wording changed, and nothing stopped the lane: the delivery
// check (delivery.js) reads sends 2 to 26 hours old, so on a 6-hour spread
// most of the day had gone before anyone saw it. A carrier that keeps
// blocking a number's texts, or a STOP rate that jumps, is what puts every
// lane on that number at risk, agents' answers included.
//
// The breaker looks at one kind of text at a time:
//
//   - early: the first `earlySends` (20) sent today. `earlyBlocked` (4) of
//     them carrier-blocked, or `earlyStops` (4) STOPs, trips it — as soon as
//     the count is reached, so a bad morning trips by the fourth block, not
//     after the twentieth send;
//   - rolling: the last `rollingSends` (50), once `rollingMin` (20) have a
//     verdict. 30007 on `rollingBlockedPct` (10%) of those read, or a STOP
//     within `stopHours` (72) after `rollingStopPct` (8%) of those sent,
//     trips it. Never on fewer than `minCount` (4) of either.
//
// A STOP counts against the newest text of a guarded kind we sent them in
// the `stopHours` before it: a STOP the day after a nudge is the nudge's,
// not the first text's. An answer to their own text is never a lane send.
// Only 30007 counts as a block: a dead number or a landline is the list,
// not the carrier's view of us, and the delivery check already stops those.
//
// A tripped kind's queued texts go back to drafts with the reason on them,
// and none of that kind goes by itself until Matt clears it. The breaker only
// stops sends; it never starts one. It ships ON (Matt can switch it off:
// conversationAi.laneBreaker.enabled). Counts, kinds and ids here; never a
// name, a number or what was said.
//
// Pure. The runner is ghl-broker/lane-breaker.js.

const MIN_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

export const LANE_BREAKER_CURSOR = "laneBreaker";

// The kinds the breaker watches, in the words Matt reads them.
export const LANE_LABEL = Object.freeze({
  lot_owner_open: "lot owner first texts",
  lot_owner_follow: "lot owner follow-ups",
  outreach_open: "agent first texts",
  outreach_nudge: "agent nudges",
  agent_pulse: "agent check-ins",
  buyer_pulse: "buyer check-ins",
  blast_open: "deal texts",
  blast_nudge: "deal follow-up texts",
  gatekeeper_text: "gatekeeper texts",
});
export const LANE_KINDS = Object.freeze(Object.keys(LANE_LABEL));
export const laneLabel = (kind) => LANE_LABEL[kind] || String(kind || "texts").replace(/_/g, " ");

// Why these numbers (RUNBOOK "A lane that gets blocked pauses itself"):
// healthy agent texts run ~0.6% 30007 and ~2.3% STOP; the bad days ran 30%
// (lot owners 11-23) and 11% STOP (recent listers). By chance, a healthy
// lane shows 4 blocks in 20 under 1 time in 100,000, 4 STOPs in 20 about 1
// in 1,000 and 4 STOPs in 50 about 1 in 35; a lane blocking 30% shows 4 in
// its first 20 nine times in ten, and an 11% STOP lane 4 in 50 eight in ten.
// The floor of 4 keeps an unlucky day from pausing a lane that is fine.
export const LANE_BREAKER_DEFAULTS = Object.freeze({
  enabled: true,
  kinds: LANE_KINDS,
  earlySends: 20,
  earlyBlocked: 4,
  earlyStops: 4,
  rollingSends: 50,
  rollingMin: 20,
  rollingBlockedPct: 10,
  rollingStopPct: 8,
  minCount: 4,
  stopHours: 72,
  // How far back the rolling window reaches.
  rollingDays: 14,
});

const int = (v, def, lo, hi) => {
  const n = Math.round(Number(v));
  return v == null || v === "" || !Number.isFinite(n) ? def : Math.min(hi, Math.max(lo, n));
};

/**
 * normalizeLaneBreaker(v) → { enabled, kinds, earlySends, earlyBlocked, earlyStops,
 *   rollingSends, rollingMin, rollingBlockedPct, rollingStopPct, minCount, stopHours, rollingDays }
 *
 * On unless it says `enabled: false`. A threshold can be made stricter or
 * looser by a save, but never off: each has a floor.
 */
export function normalizeLaneBreaker(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const D = LANE_BREAKER_DEFAULTS;
  const kinds = Array.isArray(o.kinds)
    ? [...new Set(o.kinds.map((k) => String(k || "").trim()).filter((k) => LANE_KINDS.includes(k)))]
    : [...D.kinds];
  const earlySends = int(o.earlySends, D.earlySends, 5, 100);
  const rollingSends = int(o.rollingSends, D.rollingSends, 10, 500);
  return {
    enabled: o.enabled !== false,
    kinds,
    earlySends,
    earlyBlocked: int(o.earlyBlocked, D.earlyBlocked, 1, earlySends),
    earlyStops: int(o.earlyStops, D.earlyStops, 1, earlySends),
    rollingSends,
    rollingMin: int(o.rollingMin, D.rollingMin, 5, rollingSends),
    rollingBlockedPct: int(o.rollingBlockedPct, D.rollingBlockedPct, 1, 100),
    rollingStopPct: int(o.rollingStopPct, D.rollingStopPct, 1, 100),
    minCount: int(o.minCount, D.minCount, 1, 50),
    stopHours: int(o.stopHours, D.stopHours, 1, 24 * 14),
    rollingDays: int(o.rollingDays, D.rollingDays, 1, 60),
  };
}

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

/** The verdict a send carries: the delivery check's (`delivery`) or the breaker's own early read (`laneRead`). */
export const sendVerdict = (s) => (s?.delivery && typeof s.delivery === "object" ? s.delivery : s?.laneRead && typeof s.laneRead === "object" ? s.laneRead : null);
const FAILED = new Set(["failed", "undelivered", "error", "bounced", "rejected"]);
/** Whether we know how the send went: delivered or failed (one GHL has no record of is not read). */
export const sendRead = (s) => { const st = String(sendVerdict(s)?.status || "").toLowerCase(); return Boolean(st) && st !== "unknown"; };
/** The carrier blocked it (Error 30007). */
export const carrierBlocked = (s) => {
  const v = sendVerdict(s);
  return Boolean(v) && String(v.code || "") === "30007" && (FAILED.has(String(v.status || "").toLowerCase()) || !v.status);
};

/**
 * stoppedSends(sends, stops, { stopHours }) → Set of send ids a STOP counts against
 *
 * `sends`: guarded sends of every kind ({ id, contactId, sentAt }). `stops`:
 * their `unsubscribed` events ({ contactId, at, data }). Each STOP goes to the
 * newest send to that contact at or before it, within `stopHours`. A STOP a
 * backfill wrote (its time is the backfill's, not theirs) and an email
 * unsubscribe count against nothing.
 */
export function stoppedSends(sends = [], stops = [], { stopHours = LANE_BREAKER_DEFAULTS.stopHours } = {}) {
  const byContact = new Map();
  for (const s of sends || []) {
    if (!s?.contactId || ms(s.sentAt) == null) continue;
    if (!byContact.has(s.contactId)) byContact.set(s.contactId, []);
    byContact.get(s.contactId).push(s);
  }
  const out = new Set();
  for (const e of stops || []) {
    const at = ms(e?.at);
    if (!e?.contactId || at == null) continue;
    if (e.data?.via === "backfill" || e.data?.channel === "email") continue;
    const mine = (byContact.get(e.contactId) || []).filter((s) => ms(s.sentAt) <= at && at - ms(s.sentAt) <= stopHours * HOUR_MS);
    if (!mine.length) continue;
    const newest = mine.reduce((a, b) => (ms(b.sentAt) > ms(a.sentAt) ? b : a));
    out.add(newest.id);
  }
  return out;
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * laneVerdict({ kind, early, recent, stopped, cfg }) → { trip, rule, why, counts }
 *
 * `early`: today's first sends of the kind, oldest first (only the first
 * `earlySends` are read). `recent`: its last sends, newest first (only the
 * first `rollingSends`). Both only since Matt last cleared the kind.
 * `stopped`: stoppedSends' Set. `rule` is early_blocked | early_stops |
 * rolling_blocked | rolling_stops, or "" with no trip.
 */
export function laneVerdict({ kind, early = [], recent = [], stopped = new Set(), cfg = LANE_BREAKER_DEFAULTS } = {}) {
  const c = normalizeLaneBreaker(cfg);
  const e = (early || []).slice(0, c.earlySends);
  const r = (recent || []).slice(0, c.rollingSends);
  const eRead = e.filter(sendRead).length;
  const eBlocked = e.filter(carrierBlocked).length;
  const eStops = e.filter((s) => stopped.has(s.id)).length;
  const rRead = r.filter(sendRead).length;
  const rBlocked = r.filter(carrierBlocked).length;
  const rStops = r.filter((s) => stopped.has(s.id)).length;
  const counts = {
    early: { sent: e.length, read: eRead, blocked: eBlocked, stops: eStops },
    rolling: { sent: r.length, read: rRead, blocked: rBlocked, stops: rStops, blockedPct: pct(rBlocked, rRead), stopPct: pct(rStops, r.length) },
  };
  const label = laneLabel(kind);
  const trip = (rule, why) => ({ trip: true, rule, why, counts });
  if (eBlocked >= c.earlyBlocked) return trip("early_blocked", `${eBlocked} of the first ${e.length} ${label} today were blocked by the carrier (30007)`);
  if (eStops >= c.earlyStops) return trip("early_stops", `${eStops} of the first ${e.length} ${label} today got a STOP`);
  const needBlocked = Math.max(c.minCount, Math.ceil((c.rollingBlockedPct * rRead) / 100));
  if (rRead >= c.rollingMin && rBlocked >= needBlocked) return trip("rolling_blocked", `${rBlocked} of the last ${rRead} ${label} we could read were blocked by the carrier (30007)`);
  const needStops = Math.max(c.minCount, Math.ceil((c.rollingStopPct * r.length) / 100));
  if (r.length >= c.rollingMin && rStops >= needStops) return trip("rolling_stops", `${rStops} of the last ${r.length} ${label} got a STOP within ${c.stopHours} hours`);
  return { trip: false, rule: "", why: "", counts };
}

/* ---------- the hold ---------- */

export const HOLD_PREFIX = "held: the lane breaker stopped";
/** holdFlag(kind, why) → the flag a held draft wears. */
export const holdFlag = (kind, why = "") => `${HOLD_PREFIX} ${laneLabel(kind)}${why ? ` — ${why}` : ""}. Nothing sent; clear it on the Offers page to let the lane go again`;
export const isHoldFlag = (f) => String(f || "").startsWith(HOLD_PREFIX);

/**
 * heldDraft(draft, kind, trip, now) → the draft turned back into a draft:
 * status "draft", no send time, the breaker's flag (one, the newest), the
 * reason where the outbox shows why it waits, and `laneHold` so clearing the
 * lane finds it again. Nothing else on it changes; nothing is deleted.
 */
export function heldDraft(d = {}, kind, trip = {}, now = Date.now()) {
  const ts = new Date(now).toISOString();
  const flag = holdFlag(kind, trip.why || "");
  return {
    ...d, status: "draft", sendAt: null, sendingAt: null, heldAt: ts,
    laneHold: { kind, at: trip.at || ts, rule: trip.rule || "" },
    autoSend: { ...(d.autoSend || {}), decided: false, reason: flag },
    flags: [...(d.flags || []).filter((f) => !isHoldFlag(f)), flag],
    updatedAt: ts,
  };
}

/**
 * releasedDraft(draft, now) → the held draft once Matt clears its lane: the
 * breaker's flag and marker come off and it stays a draft. Nothing is
 * scheduled: a lane that redrafts its own unsent texts (the lot finder's
 * first text) picks it up again on its next run; any other waits for Send.
 */
export function releasedDraft(d = {}, now = Date.now()) {
  const ts = new Date(now).toISOString();
  const { laneHold, ...rest } = d;
  return {
    ...rest,
    laneCleared: { kind: laneHold?.kind || "", heldAt: laneHold?.at || null, clearedAt: ts },
    autoSend: { ...(d.autoSend || {}), decided: false, reason: "the lane breaker held it and the lane was cleared: send it or let it go" },
    flags: (d.flags || []).filter((f) => !isHoldFlag(f)),
    updatedAt: ts,
  };
}

/**
 * heldKinds(doc, cfg) → Map(kind → trip) of the kinds the breaker has
 * stopped. Empty while the breaker is switched off: off, it holds nothing.
 */
export function heldKinds(doc = {}, cfg = LANE_BREAKER_DEFAULTS) {
  const c = normalizeLaneBreaker(cfg);
  const out = new Map();
  if (!c.enabled) return out;
  for (const [kind, t] of Object.entries(doc?.trips || {})) if (t && typeof t === "object" && t.at) out.set(kind, t);
  return out;
}

/** slackTripLine({ kind, why, held, mattUserId }) → the one #needs-matt line. Counts, never a person. */
export function slackTripLine({ kind, why = "", held = 0, mattUserId = "" } = {}) {
  const at = mattUserId ? `<@${mattUserId}> ` : "";
  const queued = held === 1 ? "1 queued text went" : `${held} queued texts went`;
  return `${at}Lane breaker: ${laneLabel(kind)} are stopped. ${why ? `${why[0].toUpperCase()}${why.slice(1)}. ` : ""}${queued} back to drafts and nothing more of that kind sends by itself. Nothing was sent. Clear it on the Offers page when you want the lane back.`;
}

/* ---------- the tick's gate ---------- */

export const LANE_EVERY_MS = 14 * MIN_MS;
export const LANE_STALE_RUN_MS = 10 * MIN_MS;
export const LANE_RETRY_GAP_MS = 5 * MIN_MS;
export const LANE_MAX_DAILY_TRIES = 110;
// What one run reads from GHL, and how young a send may be before it is read
// (the carrier answers within a minute or two; a pending one is read again).
export const LANE_MAX_READS = 60;
export const LANE_MIN_AGE_MS = 5 * MIN_MS;
export const LANE_MAX_AGE_MS = 26 * HOUR_MS;

const PT_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
const PT_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" });
export const pacificDay = (t) => PT_DAY.format(new Date(t));

/** pacificDayStart(now) → the ms of midnight Pacific that began `now`'s day. */
export function pacificDayStart(now = Date.now()) {
  const day = pacificDay(now);
  for (const off of [7, 8]) {
    const t = Date.parse(`${day}T0${off}:00:00Z`);
    if (pacificDay(t) === day && Number(PT_HOUR.format(new Date(t))) % 24 === 0) return t;
  }
  return Date.parse(`${day}T08:00:00Z`);
}

/**
 * laneRunGate(doc, now) → { go, why, day, tries, stale }
 *
 * Every tick (the gating of conversation-audit.js and delivery.js): a run
 * still on the cursor waits until it is stale, then it is retried; a failed
 * run after LANE_RETRY_GAP_MS; never more than LANE_MAX_DAILY_TRIES a
 * Pacific day.
 */
export function laneRunGate(doc = {}, now = Date.now()) {
  const d = doc && typeof doc === "object" ? doc : {};
  const day = pacificDay(now);
  const triesToday = d.day === day ? Number(d.tries) || 0 : 0;
  const no = (why) => ({ go: false, why, day, tries: triesToday, stale: false });
  if (triesToday >= LANE_MAX_DAILY_TRIES) return no(`${LANE_MAX_DAILY_TRIES} tries today`);
  const started = ms(d.run?.startedAt);
  const stale = started != null && now - started >= LANE_STALE_RUN_MS;
  if (started != null && !stale) return no("a run is going");
  const last = ms(d.lastRun);
  const due = last == null || now - last >= LANE_EVERY_MS;
  if (!due && !(stale || d.failed)) return no("not due");
  if (!due && now - last < LANE_RETRY_GAP_MS) return no("retried too recently");
  return { go: true, why: "", day, tries: triesToday + 1, stale };
}

/** The window a kind is judged on: since Matt last cleared it, and no further back than `rollingDays`. */
export function laneSince(doc = {}, kind, { now = Date.now(), cfg = LANE_BREAKER_DEFAULTS } = {}) {
  const c = normalizeLaneBreaker(cfg);
  const cleared = ms(doc?.cleared?.[kind]?.at);
  const rolling = now - c.rollingDays * DAY_MS;
  const early = pacificDayStart(now);
  return {
    rollingFrom: new Date(Math.max(rolling, cleared ?? 0)).toISOString(),
    earlyFrom: new Date(Math.max(early, cleared ?? 0)).toISOString(),
  };
}
