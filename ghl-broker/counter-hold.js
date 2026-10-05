// counter-hold.js — after we hold our number on a counter: check in, then pass.
//
// Matt, 2026-10-04: a counter above our number should not sit on his Desk.
// "Hold, then pass": the reply agent sends our number once, held — never more
// (reply-agent.js, counterHold) — and this keeps the clock that follows. A
// check-in on the normal spacing (minHoursBetween, 72h); after `checkIns` of
// them, or replies that didn't move, with nothing new from them, the house
// is marked we_passed through the operator's own path (deps.passHeldCounter).
//
// Rides the morning follow-up sweep, after the ladders, so it shares that
// run's one-text-a-morning rule. Off unless parties.agent.counterHold is on.

import { effectiveStatus, OPEN_STATUSES, priceAgreed, isHot } from "./shared/offer-status.js";
import { currentOffers } from "./shared/current-offer.js";
import { threadHealth } from "./shared/thread-health.js";
import { botHold } from "./shared/bot-hold.js";
import { recordEvent } from "./contact-record.js";
import { holdState } from "./shared/counter-hold.js";

export { holdState };

const iso = (t) => new Date(t).toISOString();

/**
 * runCounterHolds({ client, locationId, saved, store, config, sendsEnabled, deps, now, dryRun, startedFor, ignoreSwitch })
 *   → [{ contactId, address, kind, status, reason }]
 */
export async function runCounterHolds({ client, locationId, saved, store, config, sendsEnabled = false, deps = {}, now = Date.now(), dryRun = false, startedFor = new Map(), ignoreSwitch = false }) {
  const out = [];
  const pb = config?.parties?.agent;
  const hold = pb?.counterHold;
  // A preview may ask what it WOULD do with the switch off (dry runs only).
  // The check-ins ride the follow-up clock: without it the hold is off too.
  if (!(dryRun && ignoreSwitch) && (!config?.enabled || !hold?.enabled || !pb?.followUp?.enabled)) return out;
  const gapHours = Number(pb?.followUp?.minHoursBetween) || 72;
  const rows = await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []);
  const held = currentOffers(rows).filter((o) => o?.counterHold?.at && o.contactId && !o.deal
    && OPEN_STATUSES.has(effectiveStatus(o)) && !priceAgreed(o) && !isHot(o));
  for (const o of held) {
    const base = { contactId: o.contactId, address: o.address, kind: "counter_hold" };
    const drafts = await store.listReplyDrafts(locationId, { contactId: o.contactId, limit: 20 }).catch(() => []);
    const lastInboundAt = drafts.filter((d) => String(d.inbound || "").trim()).map((d) => d.createdAt).sort().at(-1) || null;
    const lastOutboundAt = drafts.filter((d) => d.status === "sent").map((d) => d.sentAt || d.updatedAt || d.createdAt).filter(Boolean).sort().at(-1) || null;
    const s = holdState(o, { lastInboundAt, lastOutboundAt, checkIns: hold?.checkIns || 2, gapHours, now });
    if (s.next === "wait" || s.next === "none") continue;
    // The brake every driver asks: annoyed, opted out, stopped, a person's.
    const events = typeof store.listContactEvents === "function" ? await store.listContactEvents(locationId, o.contactId, { limit: 300 }).catch(() => []) : [];
    if (botHold({ events, offerId: o.id, now }).held) { out.push({ ...base, status: "skipped", reason: "you stopped the bot on them" }); continue; }
    const health = threadHealth({ offer: o, drafts, events, now });
    if (s.next === "pass") {
      // You picked the thread up since the hold: the pass is yours to make.
      if (health.reason === "person_has_it") { out.push({ ...base, status: "skipped", reason: "you have the thread — not passed" }); continue; }
      if (dryRun) { out.push({ ...base, status: "would_pass", reason: s.why }); continue; }
      const r = typeof deps.passHeldCounter === "function" ? await deps.passHeldCounter({ offerId: o.id, note: s.why }).catch((e) => ({ ok: false, reason: e.message })) : { ok: false, reason: "passing is not wired" };
      out.push({ ...base, status: r?.ok ? "passed" : "skipped", reason: r?.ok ? s.why : r?.reason });
      continue;
    }
    // A check-in. The brake's "two unanswered" doesn't apply — the hold
    // counts its own — but everything else it says does.
    if (!health.drive && health.reason !== "two_unanswered" && health.reason !== "rejected") {
      out.push({ ...base, status: "skipped", reason: `${health.reason}: ${health.detail}` });
      continue;
    }
    if (startedFor.has(o.contactId)) { out.push({ ...base, status: "skipped", reason: `one text a morning — ${startedFor.get(o.contactId)} went to them first` }); continue; }
    if (dryRun) { out.push({ ...base, status: "would_nudge", reason: s.why }); continue; }
    const n = ((o.counterHold.nudges || []).length + (o.counterHold.replies || []).length) + 1;
    // No claim before the text: a skip (their reply waiting on you, the
    // spacing) leaves the rung for tomorrow instead of spending it. The
    // morning sweep runs once a day (daily-gate.js), so nothing doubles.
    const full = await store.getOffer(o.id).catch(() => null);
    const start = deps.startProactive;
    const r = typeof start === "function"
      ? await start({ client, locationId, saved, store, contactId: o.contactId, kind: "counter_nudge", offer: full || o,
        subject: { address: o.address, held: { ours: o.counterHold.ours, step: n, of: hold?.checkIns || 2 } }, sendsEnabled, deps }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }))
      : { skipped: "check-ins are not wired" };
    if (r?.skipped) { out.push({ ...base, status: "skipped", reason: r.skipped }); continue; }
    await deps.markCounterHoldNudge?.({ offerId: o.id }).catch(() => {});
    await recordEvent({
      store, locationId, contactId: o.contactId, party: "agent", type: "follow_up_sent", at: iso(now), address: o.address, offerId: o.id,
      source: "conversation", dedupeKey: `counter_hold:${o.id}:${o.counterHold.at}:${n}`, data: { kind: "counter_hold", step: n },
    }).catch(() => {});
    startedFor.set(o.contactId, "a check-in after our hold");
    out.push({ ...base, status: "started", reason: s.why, jobId: r?.job?.id || null });
  }
  return out;
}
