// conversation-audit.js — the day's threads, checked one by one at dusk.
//
// Fifteen ticks push pieces of the loop (ladders, promises, check-ins,
// chases, price watch, the offer-send retry). None of them stands back at
// the end of the day and asks, per conversation: did we answer? do we owe
// them something, and is it on a clock? is the deal state consistent, and
// is the next move queued? On 2026-09-16 three threads had gone quiet for
// three different reasons — a burst superseded the only reply (Colin Foote),
// a held draft nobody clocked (Thomas Rinow), a reply job that hung (Angela
// Jaeger) — and every one was invisible until Matt asked.
//
// Pure. Rows in, findings out; `now` is injected. Nothing here texts —
// each finding names the ONE existing mechanism that answers it (or none,
// and then it is Matt's), and the broker's runner claims and starts it. The
// file to read to know what the nightly sweep would and wouldn't do.

import { OPEN_STATUSES, DEAD_STATUSES, effectiveStatus, dealIsOver } from "./offer-status.js";
import { unansweredCheckIn, nextMorning } from "./follow-up.js";

export const AUDIT_WINDOW_HOURS = 24;
export const HELD_AGING_HOURS = 24;
export const COUNTER_STALL_HOURS = 48;
export const PROMISE_RETEXT_HOURS = 24;
export const FLOAT_STALL_DAYS = 3;
export const OFFER_QUIET_DAYS = 3;
export const CHASE_LAST_STEP = 5;
export const FOLLOW_UP_STALE_MS = 20 * 3600 * 1000;
export const MAX_REDRAFTS = 20;
export const RELEASE_MAX_AGE_HOURS = 72;   // a held reply older than this is stale, not sendable
export const REALM_SEND_GRACE_HOURS = 24; // a send just before the realm-yes stamp is the send it answered

// The audit's vocabulary, in the order Today shows it.
export const AUDIT_KINDS = [
  { key: "unanswered_inbound",   label: "Texts we never answered",                     severity: "now" },
  { key: "realm_yes_no_offer",   label: "They said the number works — no offer went",   severity: "now" },
  { key: "promise_open_overdue", label: "Still owed a number",                          severity: "now" },
  { key: "counter_stalled",      label: "Counters nobody moved on",                     severity: "soon" },
  { key: "send_gave_up",         label: "Offers that couldn't send themselves",         severity: "soon" },
  { key: "float_unanswered",     label: "Floated, never heard back",                    severity: "soon" },
  { key: "offer_no_followup",    label: "Offers with no follow-up clock",               severity: "soon" },
  { key: "held_aging",           label: "Held over a day",                              severity: "soon" },
  { key: "chase_exhausted",      label: "Ran out of asks",                              severity: "fyi" },
];
export const AUDIT_ACTION_KINDS = [{ key: "audit_owed", label: "From last night" }];
export const AUDIT_EVENT_TYPES = [
  "text_summary", "call_summary", "promise_owed", "promise_kept", "checkin_requested", "checkin_sent",
  "address_pending", "address_pending_closed", "address_chase_sent", "subject_property_set",
  "follow_up_sent", "offer_sent", "agent_estimate", "unsubscribed", "audit_action",
];

const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };
const iso = (t) => new Date(t).toISOString();
const clip = (s, n = 120) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const street = (a) => String(a || "").split(",")[0].trim();
const k = (n) => (Number(n) > 0 ? `${Math.round(Number(n) / 1000)}k` : "");
const QUIET_INTENTS = new Set(["opt_out", "small_talk", "media"]);
const HUMAN_TOOK_IT = /answered it yourself/i;

// One key per finding, stable across two runs on the same state and new
// when the thread moves: the anchor is the timestamp of the thing the
// finding is about (their text, their counter, our float).
export const auditDedupeKey = (f) => `audit:${f.kind}:${f.contactId || f.offerId}:${String(f.anchorAt || "").slice(0, 19)}`;

/**
 * auditConversations({ drafts, events, offers, ghlLast, pipelineActions, followUpCursorAt, config, now, hours })
 *   → { generatedAt, window, touched, findings, counts, quietWins, ghlRead }
 *
 *   drafts            reply drafts: the last 48h plus every open row (draft|scheduled|handled)
 *   events            contact events, oldest first, AUDIT_EVENT_TYPES, ~45 days
 *   offers            lean offer rows
 *   ghlLast           Map<contactId, { at, dir }> from GHL's conversation list, or null when it wasn't read
 *   pipelineActions   buildPipeline().actions (deal state is counted, not re-derived)
 *   followUpCursorAt  when the follow-up sweep last ran (ISO) — a stale one is started, not imitated
 *   config            the normalized Conversation AI config
 *
 * A finding: { id, kind, severity, contactId, contactName, party, address, offerId, draftId,
 *              anchorAt, dueAt, action: { type, ... } | null, why, evidence }
 */
export function auditConversations({
  drafts = [], events = [], offers = [], ghlLast = null, pipelineActions = [], followUpCursorAt = null,
  config = {}, now = Date.now(), hours = AUDIT_WINDOW_HOURS,
} = {}) {
  const from = now - hours * 3600000;
  const inWin = (v) => { const t = ms(v); return t != null && t >= from && t <= now; };
  const hoursAgo = (v) => { const t = ms(v); return t == null ? 0 : Math.round((now - t) / 3600000); };
  const pb = config?.parties?.agent || {};
  const ladderOn = Boolean(pb.followUp?.enabled && pb.followUp?.ladders?.offer_nudge?.enabled);
  const followUpStale = !followUpCursorAt || now - (ms(followUpCursorAt) ?? 0) > FOLLOW_UP_STALE_MS;
  const sendOfferAuto = Boolean(pb.sendOffer?.onClearUnderwrite)
    || (pb.intentRules?.realm_yes?.actions || []).some((a) => a?.type === "send_offer" && (a.mode === "auto" || pb.intentRules.realm_yes.mode === "auto"));
  const requoteOn = pb.requote?.enabled === true;
  const loose = config?.nightlyAudit?.loose !== false;

  /* --- indexes --- */
  const draftsBy = new Map();
  const names = new Map();
  for (const d of drafts) {
    if (!d?.contactId) continue;
    if (!draftsBy.has(d.contactId)) draftsBy.set(d.contactId, []);
    draftsBy.get(d.contactId).push(d);
    if (d.contactName) names.set(d.contactId, d.contactName);
  }
  for (const list of draftsBy.values()) list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const eventsBy = new Map();
  for (const e of events) {
    if (!e?.contactId) continue;
    if (!eventsBy.has(e.contactId)) eventsBy.set(e.contactId, []);
    eventsBy.get(e.contactId).push(e);
  }
  for (const o of offers) if (o?.contactId && o.contactName && !names.has(o.contactId)) names.set(o.contactId, o.contactName);
  const who = (id) => names.get(id) || "";
  const ev = (c, type) => (eventsBy.get(c) || []).filter((e) => e.type === type);
  const last = (list) => (list.length ? list[list.length - 1] : null);
  const excluded = (c) => ev(c, "unsubscribed").length > 0 || (draftsBy.get(c) || []).some((d) => d.intent === "opt_out");

  // When they last spoke, and when we last did — from our own rows first,
  // GHL's list where we have it.
  const lastInbound = (c) => {
    const ds = (draftsBy.get(c) || []).filter((d) => String(d.inbound || "").trim()).map((d) => ms(d.createdAt));
    const es = [...ev(c, "text_summary"), ...ev(c, "call_summary")].map((e) => ms(e.at));
    const g = ghlLast?.get(c); if (g?.dir === "in") es.push(ms(g.at));
    const all = [...ds, ...es].filter((t) => t != null);
    return all.length ? Math.max(...all) : null;
  };
  const lastSent = (c) => {
    const ds = (draftsBy.get(c) || []).filter((d) => d.status === "sent").map((d) => ms(d.sentAt || d.updatedAt));
    const es = [...ev(c, "offer_sent"), ...ev(c, "follow_up_sent")].map((e) => ms(e.at));
    const all = [...ds, ...es].filter((t) => t != null);
    return all.length ? Math.max(...all) : null;
  };
  const scheduledAfter = (c, t) => (draftsBy.get(c) || []).some((d) => d.status === "scheduled" && (ms(d.createdAt) ?? 0) >= t);
  // A person answered after our last text: the thread is theirs, not ours to audit.
  const humanOwns = (c) => {
    const g = ghlLast?.get(c);
    if (g?.dir === "out" && (ms(g.at) ?? 0) > (lastSent(c) ?? 0) + 5 * 60000) return true;
    return (draftsBy.get(c) || []).some((d) => d.status === "dismissed" && (d.flags || []).some((f) => HUMAN_TOOK_IT.test(f)));
  };
  // A check-in already waiting to fire — the audit never overwrites one
  // (runCheckInSweep reads only the newest request per contact).
  const checkInPending = (c) => {
    const req = last(ev(c, "checkin_requested"));
    if (!req) return false;
    if (ev(c, "checkin_sent").some((s) => s.data?.requestAt === req.at)) return false;
    return (ms(req.data?.dueAt) ?? 0) > now;
  };

  const findings = [];
  const seen = new Set();
  const add = (f) => {
    const kind = AUDIT_KINDS.find((x) => x.key === f.kind);
    const row = { severity: kind?.severity || "fyi", action: null, evidence: {}, ...f, id: auditDedupeKey(f) };
    if (seen.has(row.id)) return; seen.add(row.id);
    findings.push(row);
  };

  /* --- who spoke today --- */
  const touched = new Set();
  for (const [c, list] of draftsBy) if (list.some((d) => String(d.inbound || "").trim() && inWin(d.createdAt))) touched.add(c);
  if (ghlLast) for (const [c, g] of ghlLast) if (g?.dir === "in" && inWin(g.at)) touched.add(c);

  /* --- 1. texts we never answered --- */
  // Today's threads, plus anyone with a draft still open: a text held longer
  // than the window is exactly the one nobody is looking at any more.
  const candidates = new Set(touched);
  for (const [c, list] of draftsBy) if (list.some((d) => d.status === "draft" || d.status === "handled")) candidates.add(c);
  let redrafts = 0;
  for (const c of candidates) {
    if (excluded(c) || humanOwns(c)) continue;
    const inAt = lastInbound(c);
    if (inAt == null) continue;
    const list = draftsBy.get(c) || [];
    const after = list.filter((d) => (ms(d.createdAt) ?? 0) >= inAt - 5 * 60000);
    const answered = (lastSent(c) ?? 0) >= inAt || scheduledAfter(c, inAt - 5 * 60000);
    if (answered) continue;
    const newest = after[0] || null;
    // (a) no row at all, or only rows a burst replaced: the reply job never
    // produced anything — draft it again, the way the redraft button does.
    if (!newest || after.every((d) => d.status === "superseded")) {
      const g = ghlLast?.get(c);
      const text = newest?.inbound || "";
      add({ kind: "unanswered_inbound", contactId: c, contactName: who(c), party: newest?.party || "agent", address: newest?.propertyAddress || "",
        anchorAt: iso(inAt), dueAt: iso(now),
        action: redrafts < MAX_REDRAFTS ? { type: "redraft" } : null,
        why: newest ? "a later text replaced the only reply before it went" : "they texted and nothing was drafted",
        evidence: { inbound: clip(text), ghlAt: g?.at || null } });
      if (redrafts < MAX_REDRAFTS) redrafts++;
      continue;
    }
    // (c) a person's job by design: the agent wants a call or a walkthrough.
    if (newest.status === "handled") {
      add({ kind: "unanswered_inbound", contactId: c, contactName: who(c), party: newest.party, address: newest.propertyAddress || "",
        anchorAt: iso(inAt), dueAt: iso(now), draftId: newest.id,
        why: `${(newest.intent || "their text").replace(/_/g, " ")} — yours to answer`, evidence: { inbound: clip(newest.inbound), intent: newest.intent } });
      continue;
    }
    // (b) held for a person. Old: aging. New: make sure the clock is set.
    if (newest.status === "draft" && !QUIET_INTENTS.has(newest.intent)) {
      const clock = last(ev(c, "checkin_requested").filter((e) => (ms(e.at) ?? 0) >= (ms(newest.createdAt) ?? 0)));
      const age = hoursAgo(newest.createdAt);
      const reason = newest.autoSend?.reason || (newest.flags || [])[0] || "held";
      // Loose: a holding reply the money guard passed, that the model didn't
      // flag for a person, held only because of its intent — send it. The
      // gates, needsHuman, "you have the thread" and age stay in the way.
      const releasable = loose && (newest.gateClean === true || newest.autoSendable === true) && !newest.needsHuman && age <= RELEASE_MAX_AGE_HOURS
        && !/you replied to them/.test(reason) && !/^needs a person:/.test(reason);
      add({ kind: age >= HELD_AGING_HOURS ? "held_aging" : "unanswered_inbound", contactId: c, contactName: who(c), party: newest.party,
        address: newest.propertyAddress || "", anchorAt: newest.createdAt, draftId: newest.id,
        dueAt: releasable ? iso(now) : clock?.data?.dueAt || unansweredCheckIn(now).dueAt,
        action: releasable ? { type: "release", draftId: newest.id }
          : clock || checkInPending(c) ? null : { type: "book_checkin", kind: "unanswered", dueAt: unansweredCheckIn(now).dueAt, draftId: newest.id },
        why: releasable ? `${reason} — a holding reply the guard passed; sending it` : clock ? `${reason} · check-in set for ${String(clock.data?.dueAt || "").slice(0, 10)}` : reason,
        evidence: { inbound: clip(newest.inbound), reply: clip(newest.reply, 100), age } });
    }
  }

  /* --- 2. still owed a number --- */
  for (const [c, list] of eventsBy) {
    if (excluded(c) || humanOwns(c)) continue;
    const owed = last(list.filter((e) => e.type === "promise_owed"));
    if (!owed) continue;
    const at = ms(owed.at) ?? 0;
    if (list.some((e) => e.type === "promise_kept" && (ms(e.at) ?? 0) > at)) continue;
    if ((lastInbound(c) ?? 0) > at || (lastSent(c) ?? 0) > at) continue;
    const age = hoursAgo(owed.at);
    // The promise sweep already texted once; a second text is a nag. Past
    // two days with no word either way, the morning check-in picks it up.
    const book = age >= PROMISE_RETEXT_HOURS && !checkInPending(c);
    add({ kind: "promise_open_overdue", contactId: c, contactName: who(c), party: "agent", address: owed.address || "",
      anchorAt: owed.at, dueAt: book ? nextMorning(now) : iso(at + PROMISE_RETEXT_HOURS * 3600000),
      action: book ? { type: "book_checkin", kind: "promise", dueAt: nextMorning(now) } : null,
      why: `we said we'd come back with ${owed.data?.what === "number" ? "a number" : "an answer"} ${age}h ago and haven't`,
      evidence: { what: owed.data?.what, heldReason: owed.data?.heldReason || "", age } });
  }

  /* --- 3. the offer book --- */
  let sweepAsked = false;
  const askSweep = () => { if (sweepAsked || !ladderOn || !followUpStale) return null; sweepAsked = true; return { type: "run_follow_up_sweep" }; };
  // One row per property: the newest open offer on it speaks for the rest
  // (revisions and re-quotes sit beside it in the book). Same rule as the
  // follow-up sweep's isTheOfferToAskAbout — Allan Ponio's Vashon house was
  // seven rows on the first dry run, 2026-09-16.
  const newestByProperty = new Map();
  for (const o of offers) {
    if (!o?.contactId || !o.address || o.deal) continue;
    const key = `${o.contactId}|${street(o.address).toLowerCase()}`;
    const cur = newestByProperty.get(key);
    if (!cur || String(o.createdAt || "") > String(cur.createdAt || "")) newestByProperty.set(key, o);
  }
  for (const o of newestByProperty.values()) {
    if (!o?.contactId || !o.address || o.deal || excluded(o.contactId) || humanOwns(o.contactId)) continue;
    const status = effectiveStatus(o);
    if (DEAD_STATUSES.has(status) || status === "draft" || status === "accepted") continue;
    const c = o.contactId;
    const base = { contactId: c, contactName: o.contactName || who(c), party: "agent", address: o.address, offerId: o.id };
    const inAt = lastInbound(c) ?? 0;
    const sentAt = lastSent(c) ?? 0;

    // They said yes to the number and nothing went.
    if (o.realm?.answer === "yes") {
      const at = ms(o.realm.ts) ?? 0;
      // The send that answered a realm-yes is often stamped a few minutes
      // BEFORE the yes (James G Smith, 2026-09-16: sent 19:13, yes 19:17).
      const since = at - REALM_SEND_GRACE_HOURS * 3600000;
      const went = (o.sends || []).some((s) => (ms(s.ts) ?? 0) >= since && Object.values(s.results || {}).some((r) => r?.ok))
        || ev(c, "offer_sent").some((e) => (ms(e.at) ?? 0) >= since);
      if (!went) {
        add({ ...base, kind: "realm_yes_no_offer", anchorAt: o.realm.ts, dueAt: nextMorning(now),
          action: (sendOfferAuto || loose) && ["new", "sent"].includes(status) ? { type: "queue_offer_send" } : null,
          why: `they said ${k(o.cashAmount)} is in the realm ${hoursAgo(o.realm.ts)}h ago; the written offer never went`,
          evidence: { ours: o.cashAmount || 0 } });
        continue;
      }
    }

    // A counter nobody moved on.
    if (status === "countered") {
      const counterAt = o.counter?.at || (o.statusHistory || []).filter((h) => h.status === "countered").map((h) => h.ts).pop();
      const at = ms(counterAt) ?? 0;
      const moved = Boolean(o.counterBand?.acceptedAt || (o.requotes || []).length || o.declinedOnce?.at) || sentAt > at;
      if (at && !moved && now - at >= COUNTER_STALL_HOURS * 3600000) {
        const take = ev(c, "agent_estimate").some((e) => (ms(e.at) ?? 0) >= at - 7 * 86400000);
        const theirs = o.counter?.amount || 0;
        add({ ...base, kind: "counter_stalled", anchorAt: counterAt, dueAt: nextMorning(now),
          action: take && requoteOn ? { type: "requote" } : loose ? { type: "nudge_counter" } : null,
          why: `countered${theirs ? ` at ${k(theirs)}` : ""} against our ${k(o.cashAmount)} ${Math.round((now - at) / 86400000)}d ago; nobody came back`,
          evidence: { theirs, ours: o.cashAmount || 0, gap: theirs && o.cashAmount ? theirs - o.cashAmount : null, take } });
        continue;
      }
    }

    // Never sent itself.
    if (o.autoSendGaveUp?.at && OPEN_STATUSES.has(status)) {
      add({ ...base, kind: "send_gave_up", anchorAt: o.autoSendGaveUp.at, dueAt: nextMorning(now),
        why: `the offer never sent itself — ${o.autoSendGaveUp.reason || "gave up"}`, evidence: { reason: o.autoSendGaveUp.reason || "" } });
      continue;
    }

    // Floated, no answer.
    const floatAt = ms(o.proactive?.realmCheckAt) ?? ms(o.proactive?.takeCheckAt);
    if (status === "new" && floatAt && !o.realm && inAt < floatAt && now - floatAt >= FLOAT_STALL_DAYS * 86400000) {
      add({ ...base, kind: "float_unanswered", anchorAt: iso(floatAt), dueAt: nextMorning(now),
        action: askSweep() || (loose && ladderOn ? { type: "nudge_offer" } : null),
        why: `floated ${o.proactive?.realmCheckAt ? k(o.cashAmount) : "our read"} ${Math.round((now - floatAt) / 86400000)}d ago; no word${ladderOn ? "" : " — the offer ladder is off"}`,
        evidence: { ladderOn } });
      continue;
    }

    // An offer out with no follow-up clock. A countered offer is a
    // negotiation, not a wait — its silence is counter_stalled's, above.
    if (status !== "countered" && OPEN_STATUSES.has(status) && !(o.followUps || []).length) {
      const touch = Math.max(ms((o.sends || []).map((s) => s.ts).pop()) ?? ms(o.statusAt) ?? ms(o.createdAt) ?? 0, sentAt);
      if (touch && inAt < touch && now - touch >= OFFER_QUIET_DAYS * 86400000) {
        const days = Math.round((now - touch) / 86400000);
        // The ladder "has it" only while its first rung is still ahead. Past
        // that with nothing sent, the ladder skipped this one (its candidate
        // rules, not ours), and saying otherwise hides the offer for good.
        const ladderMissed = ladderOn && days > OFFER_QUIET_DAYS + 2;
        add({ ...base, kind: "offer_no_followup", anchorAt: iso(touch), dueAt: nextMorning(now),
          severity: ladderOn && !ladderMissed ? "fyi" : "soon", action: ladderMissed ? (loose ? { type: "nudge_offer" } : null) : askSweep(),
          why: !ladderOn ? `${days}d quiet and the offer follow-up ladder is off`
            : ladderMissed ? `${days}d quiet and the ladder never fired on it`
            : `${days}d quiet; the ladder ${followUpStale ? "is being started" : "has it"}`,
          evidence: { ladderOn, followUpStale, ladderMissed, days } });
      }
    }
  }

  /* --- 4. chases that ran out --- */
  for (const [c, list] of eventsBy) {
    if (excluded(c)) continue;
    const pend = last(list.filter((e) => e.type === "address_pending"));
    if (pend) {
      const at = ms(pend.at) ?? 0;
      const closed = list.some((e) => (e.type === "address_pending_closed" || e.type === "subject_property_set") && (ms(e.at) ?? 0) >= at);
      const lastStep = last(list.filter((e) => e.type === "address_chase_sent" && (ms(e.at) ?? 0) >= at));
      if (!closed && lastStep && Number(lastStep.data?.step) >= CHASE_LAST_STEP && now - (ms(lastStep.at) ?? 0) >= 2 * 86400000) {
        add({ kind: "chase_exhausted", contactId: c, contactName: who(c), party: "agent", address: "", anchorAt: pend.at, dueAt: iso(now),
          action: { type: "close_chase", pendingAt: pend.at },
          why: `asked six times for the address of the ${clip(pend.data?.hint, 60) || "property they mentioned"}; nothing came`, evidence: { hint: pend.data?.hint || "" } });
      }
    }
    const src = last(list.filter((e) => e.type === "checkin_requested" && e.data?.kind === "source"));
    if (src && Number(src.data?.left) === 0 && list.some((e) => e.type === "checkin_sent" && e.data?.requestAt === src.at)) {
      add({ kind: "chase_exhausted", contactId: c, contactName: who(c), party: "agent", address: "", anchorAt: src.at, dueAt: iso(now),
        why: "six weekly check-ins with a deal source and nothing came of them", evidence: { source: true } });
    }
  }

  /* --- the rest --- */
  const flagged = new Set(findings.map((f) => f.contactId));
  const quietWins = [...touched].filter((c) => !flagged.has(c) && !excluded(c)).map((c) => ({ contactId: c, contactName: who(c) }));
  const dealLag = pipelineActions.filter((a) => ["stage_lag", "closing_soon", "deal_no_buyers", "blast_no_opens"].includes(a?.kind)).length;
  const byKind = Object.fromEntries(AUDIT_KINDS.map((x) => [x.key, findings.filter((f) => f.kind === x.key).length]));
  const order = Object.fromEntries(AUDIT_KINDS.map((x, i) => [x.key, i]));
  findings.sort((a, b) => (order[a.kind] ?? 99) - (order[b.kind] ?? 99) || String(a.anchorAt).localeCompare(String(b.anchorAt)));
  return {
    generatedAt: iso(now),
    window: { from: iso(from), to: iso(now), hours },
    touched: touched.size,
    findings,
    quietWins,
    ghlRead: Boolean(ghlLast),
    counts: {
      touched: touched.size,
      answered: quietWins.length,
      queued: findings.filter((f) => f.action && ["redraft", "run_follow_up_sweep", "queue_offer_send", "requote", "release", "nudge_counter", "nudge_offer"].includes(f.action.type)).length,
      clocked: findings.filter((f) => f.action && ["book_checkin", "close_chase"].includes(f.action.type)).length,
      owed: findings.filter((f) => f.severity !== "fyi" && (!f.action || f.action.type === "book_checkin")).length,
      dealLag, byKind,
    },
  };
}

/**
 * auditActions(last, { now }) → pipeline-shaped actions for Today's queue
 *
 * Only the rows that are Matt's: a finding the machine can't answer — no
 * remedy, or only a clock (a check-in is a net under a held draft, not a
 * reply to it). Not the merely informational. One group, "From last night";
 * the row's title says which kind it is.
 */
const STILL_YOURS = new Set(["book_checkin"]);
export function auditActions(last, { now = Date.now() } = {}) {
  if (!last?.findings) return [];
  const labelOf = Object.fromEntries(AUDIT_KINDS.map((x) => [x.key, x.label]));
  return last.findings
    .filter((f) => f.severity !== "fyi" && (!f.action || STILL_YOURS.has(f.action.type)))
    .map((f) => ({
      id: f.id, kind: "audit_owed", severity: f.severity, contactId: f.contactId, contactName: f.contactName || "",
      address: f.address || "", offerId: f.offerId || null, draftId: f.draftId || null,
      title: `${f.contactName || "An agent"}${f.address ? ` · ${street(f.address)}` : ""}: ${labelOf[f.kind] || f.kind}`,
      detail: f.why, dueAt: f.dueAt, since: last.finishedAt || last.generatedAt || null,
      ops: f.draftId ? [{ key: "open_outbox", label: "Open the draft", intent: "primary" }]
        : f.offerId ? [{ key: "open_offer", label: "Open the offer", intent: "primary" }]
        : [{ key: "open_contact", label: "Open the thread", intent: "primary" }],
    }));
}

// One line for the card header.
export function summarize(result) {
  if (!result?.counts) return "";
  const c = result.counts;
  return `checked ${c.touched} thread${c.touched === 1 ? "" : "s"} · ${c.answered} answered · ${c.queued} queued for the morning · ${c.clocked} put on a clock · ${c.owed} need you`;
}
