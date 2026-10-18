// follow-up-engine.js — every follow-up the app sends, the ones that went and
// the ones coming, by the mechanism that sends it. Reports → Follow-up
// (2026-10-17).
//
// Matt: "I can't understand right now how the system is generating follow-up
// and what follow-up is queued for any specific thing." The answer was spread
// over the Offers column (offers only, next touch only), the check-in plan,
// the follow-ups preview and the Line, and buyers had nothing. This is one
// page of it, in his sketch's blocks: agent outreach, agent follow-up, offer
// follow-up (sent and passed), and buyers.
//
// Every row is one mechanism (FOLLOW_UP_MECHANISMS), keyed to the
// `outbound.kind` its drafts carry, so a number here is the count of texts
// that kind sent — never a guess from wording. Three states:
//   sent     it went (a send event that is never pruned, or the outbox row)
//   queued   written, with a send time (reply_drafts status scheduled)
//   planned  what the next sweep would start, worked out by that sweep's own
//            planner (ghl-broker/follow-up-engine.js) — a plan, not a promise
// and `held`: a machine draft waiting on a person.
//
// Pure. The reads are ghl-broker/follow-up-engine.js. `now` is passed in.

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const TZ = "America/Los_Angeles";
const ms = (v) => { if (typeof v === "number") return Number.isFinite(v) ? v : null; const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const iso = (t) => new Date(t).toISOString();

/* ---------- Pacific calendar ---------- */

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23",
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** pacificParts(t) → { y, m (1-12), d, h, wd (0 = Sunday) } */
export function pacificParts(t) {
  const p = Object.fromEntries(PARTS.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WEEKDAYS[p.weekday] ?? 0 };
}

const offsetAt = (t) => {
  const p = pacificParts(t);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
};

/**
 * pacificMidnight(y, m0, d) → epoch ms of midnight Pacific on that day.
 * Month and day may overflow (Date.UTC normalises them). The offset is read
 * at 08:00 UTC that day — midnight PST, 1am PDT — which is before either 2am
 * switch, so both DST Sundays land on their true midnight.
 */
export function pacificMidnight(y, m0, d) {
  const day = new Date(Date.UTC(y, m0, d));
  const guess = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - offsetAt(guess);
}

/** pacificDayKey(t) → "YYYY-MM-DD", the Pacific calendar day. */
export function pacificDayKey(t) {
  const p = pacificParts(t);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export const FOLLOW_UP_PERIODS = ["today", "week", "month", "ytd"];
// YTD has no "rest of the period" worth showing; it looks this far ahead.
export const YTD_AHEAD_DAYS = 30;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

/**
 * periodWindow(period, now) → { period, start, end, unit, buckets: [{ key, start, end, label }] }
 *
 * The calendar period in Pacific time that holds `now`: today (by the hour),
 * this week Monday to Sunday and this month (by the day), the year to date
 * (by the week, Jan 1 onward) plus the next 30 days. Buckets step by calendar
 * day, never by 24 hours, so a DST week still has seven days.
 */
export function periodWindow(period = "week", now = Date.now()) {
  const p = pacificParts(now);
  const buckets = [];
  const dayBucket = (y, m0, d) => {
    const start = pacificMidnight(y, m0, d);
    const end = pacificMidnight(y, m0, d + 1);
    const q = pacificParts(start + 12 * HOUR_MS);
    buckets.push({ key: pacificDayKey(start + 12 * HOUR_MS), start, end, label: `${DAYS[q.wd]} ${q.d}` });
  };
  if (period === "today") {
    const start = pacificMidnight(p.y, p.m - 1, p.d);
    const end = pacificMidnight(p.y, p.m - 1, p.d + 1);
    for (let h = 0, t = start; t < end; h++) {
      // An hour at a time from midnight; the DST day has 23 or 25 of them.
      const next = Math.min(end, t + HOUR_MS);
      buckets.push({ key: `h${h}`, start: t, end: next, label: hourLabel(pacificParts(t).h) });
      t = next;
    }
    return { period, start, end, unit: "hour", buckets };
  }
  if (period === "month") {
    const days = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) dayBucket(p.y, p.m - 1, d);
    return { period, start: buckets[0].start, end: buckets.at(-1).end, unit: "day", buckets };
  }
  if (period === "ytd") {
    const yearStart = pacificMidnight(p.y, 0, 1);
    const end = pacificMidnight(p.y, p.m - 1, p.d + 1 + YTD_AHEAD_DAYS);
    for (let k = 0; ; k++) {
      const start = pacificMidnight(p.y, 0, 1 + 7 * k);
      if (start >= end) break;
      const stop = Math.min(end, pacificMidnight(p.y, 0, 8 + 7 * k));
      const q = pacificParts(start + 12 * HOUR_MS);
      buckets.push({ key: `w${k}`, start, end: stop, label: `${MONTHS[q.m - 1]} ${q.d}` });
    }
    return { period, start: yearStart, end, unit: "week", buckets };
  }
  // week: Monday to Sunday
  const back = (p.wd + 6) % 7;
  for (let i = 0; i < 7; i++) dayBucket(p.y, p.m - 1, p.d - back + i);
  return { period: "week", start: buckets[0].start, end: buckets.at(-1).end, unit: "day", buckets };
}

/* ---------- daily jobs: when a due thing actually goes ---------- */

/** pacificWallTime(y, m0, d, hour) → epoch ms of that wall-clock hour in Pacific. */
export function pacificWallTime(y, m0, d, hour = 0) {
  const guess = Date.UTC(y, m0, d, hour);
  // The offset read a few hours on from the guess: past 2am, so it is the
  // day's own offset on both DST Sundays.
  return guess - offsetAt(guess + 8 * HOUR_MS);
}

/**
 * runsBetween({ hour, weekdaysOnly, from, until }) → [ms]
 *
 * Each day's run of a once-a-day job at `hour` Pacific, in [from, until).
 */
export function runsBetween({ hour = 12, weekdaysOnly = true, from, until } = {}) {
  const out = [];
  const p = pacificParts(from);
  for (let i = 0; i < 800; i++) {
    const day = pacificMidnight(p.y, p.m - 1, p.d + i);
    if (day >= until) break;
    const q = pacificParts(day + 12 * HOUR_MS);
    if (weekdaysOnly && (q.wd === 0 || q.wd === 6)) continue;
    const t = pacificWallTime(q.y, q.m - 1, q.d, hour);
    if (t >= from && t < until) out.push(t);
  }
  return out;
}

/**
 * rollOntoRuns(items, { hour, weekdaysOnly, cap, firstCap, now, until, ranToday, windowHours })
 *   → items with `at` = the run that takes them
 *
 * A once-a-day job (the agent check-in, the buyer check-in, the GHL
 * follow-up enrolment) takes what is due at its run, up to `cap` (0 or
 * Infinity: no cap), oldest due first; the rest wait for the next run.
 * `firstCap` is today's seats left. Today's run counts until its retry
 * window closes, unless it already ran (`ranToday`). Items with no run
 * before `until` are left out — beyond the page.
 */
export function rollOntoRuns(items = [], { hour = 12, weekdaysOnly = true, cap = Infinity, firstCap = null, now = Date.now(), until, ranToday = false, windowHours = 5 } = {}) {
  const p = pacificParts(now);
  const from = ranToday ? pacificMidnight(p.y, p.m - 1, p.d + 1) : pacificMidnight(p.y, p.m - 1, p.d);
  const runs = runsBetween({ hour, weekdaysOnly, from, until }).filter((r) => now <= r + windowHours * HOUR_MS);
  const limit = (x) => (x > 0 && Number.isFinite(x) ? x : Infinity);
  const sorted = [...items].filter((x) => ms(x.due) != null).sort((a, b) => ms(a.due) - ms(b.due));
  const out = [];
  let i = 0;
  runs.forEach((r, k) => {
    const at = Math.max(r, now);
    const room = k === 0 && firstCap != null ? Math.max(0, firstCap) : limit(cap);
    for (let n = 0; i < sorted.length && ms(sorted[i].due) <= at && n < room; n++, i++) out.push({ ...sorted[i], at: iso(at) });
  });
  return out;
}

/* ---------- the catalog ---------- */

export const FOLLOW_UP_GROUPS = [
  { key: "outreach", label: "Agent outreach", hint: "New agents, texted for the first time" },
  { key: "agent", label: "Agent follow-up", hint: "Keeping every agent warm and keeping our word" },
  { key: "offer_live", label: "Offer follow-up · sent", hint: "Offers out, waiting on an answer" },
  { key: "offer_passed", label: "Offer follow-up · passed", hint: "Houses they passed on, or that came back" },
  { key: "buyer", label: "Buyers", hint: "Keeping buyers warm and moving deals" },
];

/**
 * FOLLOW_UP_MECHANISMS — one row per thing the app sends on its own.
 *
 *   kinds       the `outbound.kind` values its drafts carry (mechanismOf)
 *   sentFrom    "event": counted from a send event (never pruned), so YTD is
 *               whole; "draft": from the outbox row's sentAt, which is kept
 *               `retentionDays`
 *   ahead       "plan": the engine forecasts it from the sweep's own planner;
 *               "event": it fires on something that hasn't happened yet (a
 *               price drop, a held underwrite) — only what's already queued
 *               shows, never a made-up count
 *   followUp    false for a first touch (a first text, a float, a deal's
 *               first blast): shown, but not in the follow-up totals
 *   ghl         GHL sends it (a workflow), not the app's outbox
 */
export const FOLLOW_UP_MECHANISMS = [
  { key: "outreach_open", group: "outreach", label: "First text", kinds: ["outreach_open"], sentFrom: "event", ahead: "event", followUp: false,
    fires: "when the daily sweep imports a new agent" },
  { key: "ghl_first", group: "outreach", label: "First text by GHL workflow", kinds: [], sentFrom: "event", ahead: "event", followUp: false, ghl: true,
    fires: "when an import goes to the GHL first-text workflow" },

  { key: "agent_pulse", group: "agent", label: "Agent check-in", kinds: ["agent_pulse"], sentFrom: "event", ahead: "plan", followUp: true },
  { key: "matts_fifteen", group: "agent", label: "Matt's 15", kinds: [], sentFrom: "event", ahead: "plan", followUp: true },
  { key: "outreach_nudge", group: "agent", label: "Cold-agent follow-up", kinds: ["outreach_nudge"], sentFrom: "draft", ahead: "plan", followUp: true },
  { key: "ghl_followup", group: "agent", label: "GHL follow-up workflow", kinds: [], sentFrom: "event", ahead: "plan", followUp: true, ghl: true },
  { key: "checkin_due", group: "agent", label: "Check-in they asked for", kinds: ["checkin_due"], sentFrom: "draft", ahead: "plan", followUp: true },
  { key: "promise_due", group: "agent", label: "Promise we made", kinds: ["promise_due"], sentFrom: "draft", ahead: "plan", followUp: true },
  { key: "address_chase", group: "agent", label: "Address chase", kinds: ["address_chase"], sentFrom: "draft", ahead: "plan", followUp: true },
  { key: "held_underwrite", group: "agent", label: "Held underwrite ask / pass", kinds: ["take_ask", "kind_pass"], sentFrom: "draft", ahead: "event", followUp: true,
    fires: "when the nightly audit finds an underwrite held on missing facts" },

  { key: "offer_nudge", group: "offer_live", label: "Offer nudge", kinds: ["offer_nudge"], sentFrom: "draft", ahead: "plan", followUp: true },
  { key: "hot_push", group: "offer_live", label: "Push to paper", kinds: ["hot_push"], sentFrom: "draft", ahead: "plan", followUp: true },
  { key: "counter_nudge", group: "offer_live", label: "Counter hold check-in", kinds: ["counter_nudge"], sentFrom: "draft", ahead: "plan", followUp: true },
  { key: "paper_after_float", group: "offer_live", label: "Written offer after a float", kinds: [], sentFrom: "event", ahead: "plan", followUp: true },
  { key: "float", group: "offer_live", label: "Float our number", kinds: ["take_check", "realm_check"], sentFrom: "draft", ahead: "plan", followUp: false },

  { key: "passed_checkin", group: "offer_passed", label: "Relisted house check-in", kinds: ["passed_checkin"], sentFrom: "draft", ahead: "plan", followUp: true },
  { key: "second_look", group: "offer_passed", label: "Second look", kinds: ["second_look"], sentFrom: "event", ahead: "plan", followUp: true },
  { key: "price_drop", group: "offer_passed", label: "Price drop", kinds: ["price_drop"], sentFrom: "draft", ahead: "event", followUp: true,
    fires: "when the price watch sees a house we offered on drop" },

  { key: "buyer_pulse", group: "buyer", label: "Buyer check-in", kinds: ["buyer_pulse"], sentFrom: "event", ahead: "plan", followUp: true },
  { key: "blast_first", group: "buyer", label: "Deal blast · first wave", kinds: [], sentFrom: "event", ahead: "event", followUp: false,
    fires: "when an offer becomes a deal, or you press Blast" },
  { key: "blast_wave", group: "buyer", label: "Deal blast · next waves", kinds: [], sentFrom: "event", ahead: "plan", followUp: true },
  { key: "deal_followup", group: "buyer", label: "Deal follow-up", kinds: ["deal_followup"], sentFrom: "draft", ahead: "plan", followUp: true },
  { key: "showing", group: "buyer", label: "Walkthrough reminder / follow-up", kinds: ["showing_reminder", "showing_followup"], sentFrom: "draft", ahead: "plan", followUp: true },
];

export const MECHANISM_BY_KEY = Object.fromEntries(FOLLOW_UP_MECHANISMS.map((m) => [m.key, m]));

// Kinds that are a person's own text, or retired: never on this page.
//   check_in        a check-in Matt or Claude wrote by hand
//   partner_answer  a person pressed the button
//   showing_ask     the ask to the listing agent for access, sent on promote
//   blast_nudge, dataroom_nudge  retired 2026-10-05 (shared/follow-up.js)
export const EXCLUDED_KINDS = new Set(["check_in", "partner_answer", "showing_ask", "blast_nudge", "dataroom_nudge"]);

const KIND_TO_MECH = new Map();
for (const m of FOLLOW_UP_MECHANISMS) for (const k of m.kinds) KIND_TO_MECH.set(k, m.key);

/**
 * mechanismOf(draft, { wave }) → mechanism key, or null (a reply, a person's
 * text, a kind this page doesn't show).
 *
 * A check-in drafted for Matt's 15 is his; a deal blast is the first wave or
 * a later one (`wave`, from the deal's blasts — the draft doesn't carry it).
 */
export function mechanismOf(d = {}, { wave = 1 } = {}) {
  const kind = d?.outbound?.kind;
  if (!kind || EXCLUDED_KINDS.has(kind)) return null;
  if (kind === "agent_pulse" && d.outbound.forMatt) return "matts_fifteen";
  if (kind === "blast_open") return wave > 1 ? "blast_wave" : "blast_first";
  return KIND_TO_MECH.get(kind) || null;
}

/* ---------- what each one does, in words, from the live settings ---------- */

const days = (steps = []) => {
  const s = (steps || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!s.length) return "";
  return s.length === 1 ? `day ${s[0]}` : `days ${s.slice(0, -1).join(", ")} and ${s.at(-1)}`;
};
const hourText = (h) => { const n = Number(h); if (!Number.isFinite(n)) return ""; return n === 0 ? "midnight" : n < 12 ? `${n}am` : n === 12 ? "noon" : `${n - 12}pm`; };

/**
 * describeMechanism(key, s) → one sentence: what starts it and how often.
 *
 *   s  { fu, ifu, agentPulse, buyerPulse, dispo, outreach, afterFloat, counterHold, timers, secondLook }
 *      — the normalised settings the sweeps read (the runner gathers them)
 */
export function describeMechanism(key, s = {}) {
  const fu = s.fu || {}, L = fu.ladders || {};
  const ap = s.agentPulse || {}, bp = s.buyerPulse || {}, da = s.dispo || {}, oa = s.outreach || {};
  const ladder = (l, after) => {
    if (!l?.steps?.length) return `${after}: no rungs set`;
    const rep = Number(l.repeatEvery) > 0 ? `, then every ${l.repeatEvery} days` : "";
    return `${after}: ${days(l.steps)}${rep}`;
  };
  switch (key) {
    case "outreach_open": return `The app texts each agent the daily sweep imports (weekdays from 10am)${oa.firstTouch && oa.firstTouch !== "app" ? `; first touch is set to ${oa.firstTouch === "ghl" ? "GHL" : "a GHL workflow"}, so GHL sends it` : ""}.`;
    case "ghl_first": return "Imports set to GHL's first-text workflow: GHL sends the first text, outside the app's outbox.";
    case "agent_pulse": return `Every agent who has replied, every ${ap.everyDays ?? 21} days; a cold agent only about a fresh listing (${ap.coldEveryDays ?? 60} days apart, dropped after ${ap.coldMaxUnanswered ?? 3} unanswered). Weekdays at ${hourText(ap.hour ?? 12)}${ap.dailyCap > 0 ? `, up to ${ap.dailyCap} a day` : ", no daily cap"}.`;
    case "matts_fifteen": return `Once a week, your ${ap.mattsFifteen?.size ?? 15} best agents' check-ins are drafted for you to make your own and send. Never sends itself.`;
    case "outreach_nudge": return ladder(L.outreach_nudge, "An agent who never answered the first text");
    case "ghl_followup": return `GHL's follow-up workflow, ${oa.followUpDays ?? 14} days after a first text nobody answered (the app enrols them at 11am).`;
    case "checkin_due": return "On the day they named (\"next week\", \"in the spring\", a date), the bot checks back in about it.";
    case "promise_due": return "The bot said we'd get back to them with a number or an answer: if nothing has gone out by then, it follows through.";
    case "address_chase": return "They said a house is coming but gave no address: days 2, 5, 9, 14, 21 and 30, until they give it, say no, or you take it.";
    case "held_underwrite": return "An underwrite held on missing facts: the nightly audit asks the agent for their read, or passes kindly.";
    case "offer_nudge": return ladder(L.offer_nudge, "Our offer is out and they haven't answered") + ` (from the last reply we dealt with, at least ${fu.minHoursBetween ?? 72} hours apart).`;
    case "hot_push": return ladder(L.hot_push, "A price is agreed; push them to write it up");
    case "counter_nudge": return `We held our number on their counter: ${s.counterHold?.checkIns ?? 2} check-ins, ${fu.minHoursBetween ?? 72} hours apart, then we pass.`;
    case "paper_after_float": return `The written offer follows a texted number nobody answered, after ${s.afterFloat?.silenceHours ?? 24} working hours${s.afterFloat?.withFloat ? " (or straight after the float)" : ""}${s.afterFloat?.dailyCap ? `, up to ${s.afterFloat.dailyCap} a day` : ""}.`;
    case "float": return `A priced offer whose number hasn't gone out: the timer floats it ${s.timers?.floatAfterHours ?? 4} hours after pricing (a first touch, not counted as follow-up).`;
    case "passed_checkin": return ladder(L.passed_checkin, "A house they passed on comes back on the market");
    case "second_look": return `A strong past offer, ${s.secondLook?.afterDays ?? 21} days on and every ${s.secondLook?.everyDays ?? 45} after, at most ${s.secondLook?.maxPerHouse ?? 2} per house. Picked each morning.`;
    case "price_drop": return "The price watch sees a house we offered on drop at least $5k and 2%.";
    case "buyer_pulse": return `Every buyer about every ${bp.everyDays ?? 90} days, ${bp.dailyCap ?? 10} a weekday, from ${hourText(bp.hour ?? 11)}.`;
    case "blast_first": return "A deal's first wave to buyers: the best-fit buyers ten minutes after promote, or whoever you pick when you press Blast.";
    case "blast_wave": return `Nobody committed: the next wave ${da.secondWaveHours ?? 48} hours after the last, up to ${da.maxWaves ?? 2} waves.`;
    case "deal_followup": return ladder(s.ifu?.ladders?.deal_followup ? { ...s.ifu.ladders.deal_followup, repeatEvery: 0, steps: (s.ifu.ladders.deal_followup.steps || []).slice(0, 1) } : null, "A buyer spoke up on a deal and went quiet") + " (once per house).";
    case "showing": return `The afternoon before a walkthrough to buyers coming${da.showings?.followUpAfter ? ", and a follow-up two hours after it" : ""}.`;
    default: return "";
  }
}

/* ---------- status ---------- */

export const STATUS_LABEL = { on: "On", drafts: "Drafts only", off: "Off", ghl: "GHL sends it" };

/* ---------- planned vs queued ---------- */

// One text a contact a morning from the follow-up sweep, picked in this order
// (follow-up-sweep.js runSweep: hot first, then offers, then the rest).
const SWEEP_ORDER = ["hot_push", "offer_nudge", "counter_nudge", "passed_checkin", "second_look", "outreach_nudge"];

/**
 * dedupePlanned(planned, open) → planned
 *
 *   open  queued and held drafts (items)
 *
 * A plan is dropped when something for the same contact is already written:
 * the same offer, or (with no offer) the same mechanism — that draft IS the
 * next touch. Then one follow-up-sweep text per contact per Pacific day,
 * the sweep's own order.
 */
export function dedupePlanned(planned = [], open = []) {
  const written = (p) => open.some((q) => q.contactId && q.contactId === p.contactId
    && (p.offerId && q.offerId ? q.offerId === p.offerId : q.mech === p.mech));
  const kept = planned.filter((p) => !p.contactId || !written(p));
  const byDay = new Map();
  const out = [];
  for (const p of kept) {
    const rank = SWEEP_ORDER.indexOf(p.mech);
    if (rank < 0 || !p.contactId) { out.push(p); continue; }
    const k = `${p.contactId}|${pacificDayKey(ms(p.at))}`;
    const cur = byDay.get(k);
    if (!cur || rank < SWEEP_ORDER.indexOf(cur.mech)) byDay.set(k, p);
  }
  return [...out, ...byDay.values()];
}

/* ---------- replies ---------- */

export const REPLY_WINDOW_HOURS = 72;

/**
 * attributeReplies(sends, inbound) → Set of send ids that got a reply
 *
 *   sends    [{ id, contactId, at }] — every counted send, any mechanism
 *   inbound  [{ contactId, at }] — their texts and calls
 *
 * A send is answered when they wrote or called within 72 hours of it and
 * before our next send to them: last touch gets the credit, so one reply
 * never counts for two texts.
 */
export function attributeReplies(sends = [], inbound = [], { windowHours = REPLY_WINDOW_HOURS } = {}) {
  const inBy = new Map();
  for (const e of inbound) {
    const t = ms(e?.at);
    if (!e?.contactId || t == null) continue;
    if (!inBy.has(e.contactId)) inBy.set(e.contactId, []);
    inBy.get(e.contactId).push(t);
  }
  const sendBy = new Map();
  for (const s of sends) {
    if (!s?.contactId || ms(s.at) == null) continue;
    if (!sendBy.has(s.contactId)) sendBy.set(s.contactId, []);
    sendBy.get(s.contactId).push(s);
  }
  const answered = new Set();
  for (const [c, list] of sendBy) {
    const ins = (inBy.get(c) || []).sort((a, b) => a - b);
    if (!ins.length) continue;
    list.sort((a, b) => ms(a.at) - ms(b.at));
    list.forEach((s, i) => {
      const t0 = ms(s.at);
      const nextAt = i + 1 < list.length ? ms(list[i + 1].at) : Infinity;
      const until = Math.min(t0 + windowHours * HOUR_MS, nextAt);
      if (ins.some((t) => t > t0 && t <= until)) answered.add(s.id);
    });
  }
  return answered;
}

/* ---------- the page ---------- */

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const ITEM_FIELDS = ["mech", "state", "at", "contactId", "name", "offerId", "address", "who", "count", "note", "replied", "overdue"];
const slim = (x) => Object.fromEntries(ITEM_FIELDS.filter((k) => x[k] !== undefined && x[k] !== null && x[k] !== "").map((k) => [k, x[k]]));

/**
 * buildFollowUpEngine(input) → the page
 *
 *   period      today | week | month | ytd
 *   sent        [item] every send the runner found (event- and draft-sourced;
 *               each mechanism keeps only its own source, `src`)
 *   queued      [item] drafts with a send time
 *   held        [item] machine drafts waiting on a person
 *   planned     [item] the planners' forecasts
 *   inbound     [{ contactId, at }] their texts and calls since the period began
 *   cohort      { firstTexted, replied } — Flow's own numbers for the period
 *   status      { [mech]: { state: on|drafts|off|ghl, why } }
 *   lastRuns    { [mech]: ISO } the job behind it last ran
 *   settings    for describeMechanism
 *   nothingScheduled  { count, rows } — live offers with nothing coming (the Line's leak)
 *   retentionDays     how long the outbox keeps a sent row
 *   truncated   a read hit its ceiling
 *
 * item: { mech, state, at, contactId, name, offerId, address, who, count, src, note }
 */
export function buildFollowUpEngine({
  period = "week", now = Date.now(), sent = [], queued = [], held = [], planned = [], inbound = [],
  cohort = null, status = {}, lastRuns = {}, settings = {}, nothingScheduled = null, retentionDays = 180, truncated = false,
} = {}) {
  const win = periodWindow(FOLLOW_UP_PERIODS.includes(period) ? period : "week", now);
  const draftsFrom = retentionDays > 0 ? now - retentionDays * DAY_MS : -Infinity;
  const floors = {};
  if (win.start < draftsFrom) floors.draftsFrom = iso(draftsFrom);

  // Each mechanism counted from its one source, inside [start, now].
  const sends = sent.filter((x) => {
    const m = MECHANISM_BY_KEY[x.mech];
    const t = ms(x.at);
    return m && t != null && t >= win.start && t <= now && (x.src || "draft") === m.sentFrom;
  }).map((x, i) => ({ ...x, id: x.id || `s${i}`, state: "sent" }));
  const answered = attributeReplies(sends, inbound);
  for (const s of sends) s.replied = answered.has(s.id);

  // Ahead: (now, end]. A plan already overdue is due now — the next sweep has it.
  const open = [...queued, ...held];
  const ahead = [
    ...queued.filter((x) => MECHANISM_BY_KEY[x.mech]).map((x) => ({ ...x, state: "queued" })),
    ...dedupePlanned(planned.filter((x) => MECHANISM_BY_KEY[x.mech] && ms(x.at) != null), open)
      .map((x) => (ms(x.at) < now ? { ...x, at: iso(now), overdue: true, state: "planned" } : { ...x, state: "planned" })),
  ].filter((x) => { const t = ms(x.at); return t != null && t >= now - 60000 && t < win.end; });
  const heldIn = held.filter((x) => MECHANISM_BY_KEY[x.mech]).map((x) => ({ ...x, state: "held" }));

  const n = (x) => Math.max(1, Number(x.count) || 1);
  const sum = (xs) => xs.reduce((a, x) => a + n(x), 0);

  // Buckets: sent by when it went, ahead by when it goes.
  const buckets = win.buckets.map((b) => ({ ...b, past: b.end <= now, current: b.start <= now && now < b.end, byGroup: {} }));
  const bucketOf = (t) => buckets.find((b) => t >= b.start && t < b.end) || null;
  const bump = (x, field) => {
    const b = bucketOf(ms(x.at));
    if (!b) return;
    const g = MECHANISM_BY_KEY[x.mech].group;
    const cell = b.byGroup[g] || (b.byGroup[g] = { sent: 0, queued: 0, planned: 0 });
    cell[field] += n(x);
  };
  for (const x of sends) bump(x, "sent");
  for (const x of ahead) bump(x, x.state);

  const groups = FOLLOW_UP_GROUPS.map((g) => {
    const mechanisms = FOLLOW_UP_MECHANISMS.filter((m) => m.group === g.key).map((m) => {
      const mine = (xs) => xs.filter((x) => x.mech === m.key);
      const s = mine(sends), q = mine(ahead).filter((x) => x.state === "queued"), p = mine(ahead).filter((x) => x.state === "planned"), h = mine(heldIn);
      const next = [...q, ...p].sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] || null;
      const st = status[m.key] || { state: m.ghl ? "ghl" : "off", why: "" };
      return {
        key: m.key, label: m.label, what: describeMechanism(m.key, settings), followUp: m.followUp, ghl: Boolean(m.ghl),
        status: st.state, statusLabel: STATUS_LABEL[st.state] || st.state, statusWhy: st.why || "",
        lastRun: lastRuns[m.key] || null,
        sent: sum(s), replied: s.filter((x) => x.replied).length,
        queued: sum(q), planned: sum(p), held: sum(h),
        // Event-driven: nothing to forecast honestly. Only what's queued.
        ahead: m.ahead, fires: m.fires || "",
        next: next ? { at: next.at, state: next.state, who: next.who || "machine", name: next.name || "", address: next.address || "", count: n(next) } : null,
        // The 180-day outbox: a YTD count from drafts starts at the cut-off.
        countedFrom: m.sentFrom === "draft" && floors.draftsFrom ? floors.draftsFrom : null,
      };
    });
    const t = { sent: 0, replied: 0, queued: 0, planned: 0, held: 0 };
    for (const m of mechanisms) if (m.followUp) for (const k of Object.keys(t)) t[k] += m[k];
    return { ...g, totals: t, mechanisms };
  });

  const followUps = (xs) => xs.filter((x) => MECHANISM_BY_KEY[x.mech].followUp);
  const fuSends = followUps(sends);
  const fuAhead = followUps(ahead);
  const kpis = {
    reached: cohort?.firstTexted ?? null,
    responded: cohort?.replied ?? null,
    respondedPct: cohort ? pct(cohort.replied, cohort.firstTexted) : null,
    sent: sum(fuSends),
    replied: fuSends.filter((x) => x.replied).length,
    repliedPct: pct(fuSends.filter((x) => x.replied).length, fuSends.length),
    queued: sum(fuAhead.filter((x) => x.state === "queued")),
    planned: sum(fuAhead.filter((x) => x.state === "planned")),
    waitingOnYou: sum(heldIn),
    nothingScheduled: nothingScheduled?.count ?? null,
  };

  const items = [...sends, ...ahead, ...heldIn]
    .map((x) => ({ ...slim(x), group: MECHANISM_BY_KEY[x.mech].group, bucket: x.state === "held" ? null : bucketOf(ms(x.at))?.key || null }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return {
    period: win.period, now: iso(now), window: { start: iso(win.start), end: iso(win.end), unit: win.unit },
    kpis, groups,
    buckets: buckets.map((b) => ({ key: b.key, label: b.label, start: iso(b.start), end: iso(b.end), past: b.past, current: b.current, byGroup: b.byGroup })),
    items, nothingScheduled: nothingScheduled || { count: 0, rows: [] },
    floors, truncated: Boolean(truncated),
  };
}
