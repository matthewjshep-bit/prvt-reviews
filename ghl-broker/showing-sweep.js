// showing-sweep.js — the walkthrough texts: see you tomorrow, and how did it look.
//
// A buyer who walks a house buys a house (shared/showing.js). Two texts the
// walkthrough never had: the afternoon before, a reminder to each buyer who
// said they're coming; two hours to two days after, one follow-up to each who
// came or said they would. What each deal owes is shared/showing.js
// showingTouches; this reads the deals, claims each text and starts it.
//
// Off the 15-minute tick, every tick: each text is its own claim (one per
// buyer per window, ever), so running again finds nothing new. A buyer with
// their own text waiting on you is skipped BEFORE the claim, so the next tick
// tries again once you've answered. Switches: dispoAutopilot.showings
// .remindDayBefore / .followUpAfter, both off; drafts until .autoSend.
// Confirming a time stays a person's: `wants_walkthrough` is NEVER_AUTO.

import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { conversationConfig, startProactive, markUnsubscribed } from "./reply-agent.js";
import { getContact, smsUnsubscribed } from "./ghl.js";
import { normalizeDispoAutopilot } from "./dispo-autopilot.js";
import { draftWaitingOnYou } from "./outbox-guard.js";
import { showingTouches } from "./shared/showing.js";

// Buyers are texted only when the broker may text buyers at all.
const DISPO_BLASTS_ENABLED = process.env.DISPO_BLASTS_ENABLED === "true";
const iso = (ms) => new Date(ms).toISOString();
const running = new Set();

/**
 * runShowingSweep({ client, locationId, saved, store, sendsEnabled, blastsEnabled, now, deps, dryRun })
 *   → { owed, started, skipped, results }
 *
 * `deps.startProactive` and `deps.getContact` are injectable for tests.
 */
export async function runShowingSweep({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, blastsEnabled = DISPO_BLASTS_ENABLED, now = Date.now(), deps = {}, dryRun = false }) {
  const s = normalizeDispoAutopilot(saved.dispoAutopilot).showings;
  const out = { owed: 0, started: 0, skipped: 0, results: [] };
  if (!s.remindDayBefore && !s.followUpAfter) return out;
  const deals = await store.listDeals(locationId).catch(() => []);
  const touches = deals.flatMap((offer) => showingTouches(offer, { now, remindDayBefore: s.remindDayBefore, followUpAfter: s.followUpAfter }).map((t) => ({ ...t, offer })));
  out.owed = touches.length;
  if (!touches.length) return out;
  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;
  const read = typeof deps.getContact === "function" ? deps.getContact : (id) => getContact(client, id);
  const live = Boolean(sendsEnabled && blastsEnabled);
  const skip = (t, reason) => { out.skipped++; out.results.push({ kind: t.kind, offerId: t.offer.id, contactId: t.contactId, status: "skipped", reason }); };
  for (const t of touches) {
    if (dryRun) { out.results.push({ kind: t.kind, offerId: t.offer.id, contactId: t.contactId, window: t.windowLabel, status: "would draft" }); continue; }
    // Already claimed: one of each per buyer per window, ever.
    const done = await store.listContactEvents(locationId, t.contactId, { types: [`${t.kind}_sent`], limit: 20 }).catch(() => null);
    if (done === null) { skip(t, "couldn't read their timeline"); continue; }
    if (done.some((e) => e.data?.key === t.key)) continue;
    // Their text is waiting on you: not now, and not claimed, so the next
    // tick tries again once it's answered.
    const waiting = await draftWaitingOnYou({ store, locationId, contactId: t.contactId }).catch(() => null);
    if (waiting) { skip(t, "their text is waiting on you"); continue; }
    let contact = null;
    try { contact = await read(t.contactId); } catch (e) { skip(t, `couldn't read the contact (${String(e?.message || e).slice(0, 80)})`); continue; }
    if (smsUnsubscribed(contact)) {
      await markUnsubscribed({ client, store, locationId, contactId: t.contactId, party: "investor", now }).catch(() => {});
      skip(t, "they unsubscribed");
      continue;
    }
    const claim = await recordEvent({
      store, locationId, contactId: t.contactId, party: "investor", type: `${t.kind}_sent`, at: iso(now), source: "deal",
      offerId: t.offer.id, address: t.offer.address || "", dedupeKey: t.key, data: { key: t.key, windowStart: t.windowStart },
    });
    if (!claim.inserted) continue;
    const r = await start({
      client, locationId, saved, store, contactId: t.contactId, kind: t.kind, offer: t.offer,
      subject: { address: t.offer.address, street: t.street, windowLabel: t.windowLabel, windowStart: t.windowStart },
      sendsEnabled: live,
      deps: { ...deps, releaseHeld: s.autoSend, releaseReason: "walkthrough texts may send themselves (Settings → Dispositions)" },
    }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
    if (r?.skipped) skip(t, r.skipped);
    else { out.started++; out.results.push({ kind: t.kind, offerId: t.offer.id, contactId: t.contactId, status: "drafting", jobId: r?.job?.id || null }); }
  }
  return out;
}

/**
 * maybeRunShowingSweep(args) → result | null
 *
 * Off the tick. Nothing unless a switch is on and Conversation AI is; never
 * two at once for a location.
 */
export async function maybeRunShowingSweep(args) {
  const { locationId, saved = {} } = args;
  const s = normalizeDispoAutopilot(saved.dispoAutopilot).showings;
  if ((!s.remindDayBefore && !s.followUpAfter) || !conversationConfig(saved).enabled) return null;
  if (running.has(locationId)) return null;
  running.add(locationId);
  try { return await runShowingSweep(args); } finally { running.delete(locationId); }
}
