// agent-pulse.js — every agent on a clock, once a workday, on its own.
//
// shared/agent-pulse.js decides who and why; this reads, claims and starts.
// Each agent is claimed with an `agent_pulse_sent` event BEFORE anything is
// drafted (plus a `listing_pinged` when the reason is their listing), so a
// crash or a second broker can't text the same person twice, and handed to
// the Conversation AI as an `agent_pulse` message. The bot reads the thread
// and the record itself and holds for anyone who asked to be left alone or
// has a person in the thread. A claim that drafted nothing is voided, so the
// day's seat and the listing come back.
//
// Two switches, both off (outreachAutopilot.pulse): `enabled` puts the day's
// drafts in the outbox; `autoSend` lets a draft the money guard passed go on
// its own. CARD_SENDS_ENABLED still gates every send.
//
// Gating is the daily gate (daily-gate.js): the cursor is written before the
// run, a run a deploy killed comes back once stale, the day's tries are capped.

import { store as defaultStore } from "./store.js";
import { recordEvent } from "./contact-record.js";
import { conversationConfig, startProactive, markUnsubscribed } from "./reply-agent.js";
import { getContact, smsUnsubscribed } from "./ghl.js";
import { workHour, isWorkday, normalizeOutreachAutopilot } from "./outreach-sweep.js";
import { allEventsSince } from "./contact-events.js";
import { claimDailyRun, closeDailyRun } from "./daily-gate.js";
import { annotateCurrent } from "./shared/current-offer.js";
import { effectiveStatus, OPEN_STATUSES, dealIsOver } from "./shared/offer-status.js";
import { addressKey } from "./shared/us-address.js";
import {
  normalizeAgentPulse, pickPulseAgents, blockedByTags,
  AGENT_PULSE_EVENT_TYPES, AGENT_PULSE_LEDGER_TYPES, INBOUND_EVENT_TYPES,
} from "./shared/agent-pulse.js";

export const CURSOR_NAME = "agentPulse";
export const WINDOW_HOURS = 5;
const DAY_MS = 86400000;
const EVENTS_DAYS = 130;
const LEDGER_DAYS = 400;
const iso = (ms) => new Date(ms).toISOString();
const pacificDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(ms));

const jobs = new Map();
export const getAgentPulseJob = (locationId) => jobs.get(locationId) || null;
export function _resetJobs() { jobs.clear(); }

export const agentPulseSettings = (saved = {}) => normalizeAgentPulse(saved?.outreachAutopilot?.pulse);

const byContact = (rows) => {
  const m = new Map();
  for (const r of rows || []) {
    if (!r?.contactId) continue;
    if (!m.has(r.contactId)) m.set(r.contactId, []);
    m.get(r.contactId).push(r);
  }
  return m;
};

/**
 * housesFrom(offers) → { live: Set<addressKey>, walked: Map<addressKey, at> }
 *
 * A house with any live offer or deal of ours is that offer's business, and a
 * house we walked away from isn't raised with anyone for six months.
 */
export function housesFrom(offers = []) {
  const live = new Set();
  const walked = new Map();
  for (const o of offers || []) {
    if (!o?.address) continue;
    const k = addressKey(o.address);
    if (!k) continue;
    const st = effectiveStatus(o);
    if ((o.deal && !dealIsOver(o.deal)) || (OPEN_STATUSES.has(st) && !o.deal)) live.add(k);
    if (st === "we_passed") {
      const at = o.statusAt || o.createdAt || "";
      if (!walked.has(k) || String(at) > String(walked.get(k))) walked.set(k, at);
    }
  }
  return { live, walked };
}

/**
 * planAgentPulse({ locationId, saved, store, now }) → { picks, counts, settings, claimedToday, seats }
 *
 * Pure read: who would get one today. One read per source, whatever the size
 * of the book.
 */
export async function planAgentPulse({ locationId, saved = {}, store = defaultStore, now = Date.now() }) {
  const settings = agentPulseSettings(saved);
  const config = conversationConfig(saved);
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  const [profiles, investors, offers, evRead, ledgerRead, openDrafts, recentDrafts, inbound, listings] = await Promise.all([
    store.listContactProfiles(locationId, { party: "agent", limit: 20000 }).catch(() => []),
    store.listContactProfiles(locationId, { party: "investor", limit: 20000 }).catch(() => []),
    store.listOffers(locationId, { limit: 5000, lean: true }).catch(() => []),
    allEventsSince(store, locationId, iso(now - EVENTS_DAYS * DAY_MS), { types: AGENT_PULSE_EVENT_TYPES }, { ceiling: 100000 }).catch(() => ({ events: [] })),
    allEventsSince(store, locationId, iso(now - LEDGER_DAYS * DAY_MS), { types: AGENT_PULSE_LEDGER_TYPES }, { ceiling: 100000 }).catch(() => ({ events: [] })),
    store.listReplyDrafts(locationId, { status: ["draft", "scheduled"], limit: 5000 }).catch(() => []),
    store.listReplyDrafts(locationId, { since: iso(now - 4 * DAY_MS), limit: 2000 }).catch(() => []),
    store.lastContactActivity(locationId, { types: INBOUND_EVENT_TYPES, inboundOnly: true, limit: 50000 }).catch(() => []),
    typeof store.listFreshAgentListings === "function"
      ? store.listFreshAgentListings(locationId, { since: iso(now - settings.freshDays * DAY_MS), seenSince: iso(now - settings.listingSeenDays * DAY_MS) }).catch(() => [])
      : [],
  ]);

  const annotated = annotateCurrent(offers || []).filter(Boolean);
  const houses = housesFrom(annotated);
  const offersBy = byContact(annotated);
  const eventsBy = byContact(evRead.events);
  const ledgerBy = byContact(ledgerRead.events);
  const seenDraft = new Set((openDrafts || []).map((d) => d.id));
  const draftsBy = byContact([...(openDrafts || []), ...(recentDrafts || []).filter((d) => !seenDraft.has(d.id))]);
  const inboundBy = new Map((inbound || []).map((r) => [r.contactId, r.at]));
  const listingsBy = byContact(listings);
  const profileBy = new Map((profiles || []).map((p) => [p.contactId, p]));
  // A buyer the pull happened to match (some buyers list houses too) is the
  // buyer pulse's, not this one's.
  const investorIds = new Set((investors || []).map((p) => p.contactId));
  const ids = new Set([...(profiles || []).map((p) => p.contactId), ...(listings || []).map((l) => l.contactId)]);

  const agents = [];
  for (const id of ids) {
    if (!id || investorIds.has(id)) continue;
    const p = profileBy.get(id) || {};
    const mine = offersBy.get(id) || [];
    agents.push({
      contactId: id, name: p.name || "", tags: p.tags || [], facts: p.facts || {},
      offers: mine, current: mine.filter((o) => o.isCurrent !== false),
      drafts: draftsBy.get(id) || [], events: eventsBy.get(id) || [], ledger: ledgerBy.get(id) || [],
      lastInboundAt: inboundBy.get(id) || null, listings: listingsBy.get(id) || [],
    });
  }

  // The day's cap is the DAY's: a retry, or a second press of Run now, only
  // gets the seats still empty. A voided claim gave its seat back.
  const voided = new Set((ledgerRead.events || []).filter((e) => e.type === "agent_pulse_voided").map((e) => e.data?.claimKey).filter(Boolean));
  const today = (ledgerRead.events || []).filter((e) => e.type === "agent_pulse_sent" && pacificDay(Date.parse(e.at)) === pacificDay(now));
  const claimedToday = today.filter((e) => !voided.has(e.dedupeKey)).length;
  const seats = Math.max(0, settings.dailyCap - claimedToday);
  // Tried today already — a claim that drafted nothing is voided and gives
  // its seat back, but the agent waits for tomorrow (the day's claim key is
  // theirs), so the seat goes to someone else.
  const triedToday = new Set(today.map((e) => e.contactId));
  const plan = pickPulseAgents({ agents: agents.filter((a) => !triedToday.has(a.contactId)), settings, config, houses, outreachFollowUpDays: oa.followUpDays, seats, now });
  return { ...plan, settings, claimedToday, seats, truncated: Boolean(evRead.truncated || ledgerRead.truncated) };
}

/**
 * startAgentPulse({ client, locationId, saved, store, sendsEnabled, deps, trigger, dryRun, limit, now, onDone }) → job
 *
 * A dry run picks and reports; it claims nobody and drafts nothing. `limit`
 * (a run by hand) can only lower the day's seats.
 */
export function startAgentPulse({
  client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {},
  trigger = "manual", dryRun = false, limit = null, now = Date.now(), onDone = null,
}) {
  if (jobs.get(locationId)?.status === "running") throw Object.assign(new Error("an agent check-in run is already going"), { http: 409 });
  const job = {
    id: `ap-${Date.now().toString(36)}`, locationId, trigger, dryRun: Boolean(dryRun), status: "running",
    startedAt: iso(now), finishedAt: null, picked: 0, started: 0, skipped: 0, counts: null, autoSend: false, results: [], error: null,
  };
  jobs.set(locationId, job);
  const start = typeof deps.startProactive === "function" ? deps.startProactive : startProactive;
  const read = typeof deps.getContact === "function" ? deps.getContact : (id) => getContact(client, id);
  const finish = (patch) => { Object.assign(job, patch, { finishedAt: new Date().toISOString() }); try { onDone?.(job); } catch { /* the caller's */ } };

  (async () => {
    const plan = await planAgentPulse({ locationId, saved, store, now });
    const picks = limit != null ? plan.picks.slice(0, Math.max(0, Math.round(Number(limit)) || 0)) : plan.picks;
    job.counts = plan.counts;
    job.picked = picks.length;
    const config = conversationConfig(saved);
    job.autoSend = Boolean(plan.settings.autoSend && sendsEnabled && config.enabled);
    const botOff = config.routing?.botOffTags || [];
    // A different way in for each text, continuing across the day's runs.
    let n = Number(plan.claimedToday) || 0;
    for (const p of picks) {
      const row = { contactId: p.contactId, segment: p.segment, pulse: p.reason, address: p.subject?.address || "" };
      job.results.push(row);
      const skip = (why) => { row.status = "skipped"; row.detail = why; job.skipped++; };
      if (dryRun) { row.status = "would draft"; continue; }

      // Their GHL record first: unsubscribed, tagged off, or no phone is never claimed.
      let contact = null;
      try { contact = await read(p.contactId); } catch (e) { skip(`couldn't read the contact (${String(e?.message || e).slice(0, 80)})`); continue; }
      if (smsUnsubscribed(contact)) {
        await markUnsubscribed({ client, store, locationId, contactId: p.contactId, party: "agent", now }).catch(() => {});
        skip("they unsubscribed");
        continue;
      }
      const tag = blockedByTags(contact?.tags || [], botOff);
      if (tag) { skip(`tagged "${tag}"`); continue; }
      if (!String(contact?.phone || "").trim()) { skip("no phone"); continue; }

      // Claim first. The unique key is the whole concurrency story.
      const claimKey = `agent_pulse_sent:${p.contactId}:${pacificDay(now)}`;
      const claim = await recordEvent({
        store, locationId, contactId: p.contactId, party: "agent", type: "agent_pulse_sent", at: iso(now), source: "sweep",
        address: p.subject?.address || "", dedupeKey: claimKey, data: { segment: p.segment, reason: p.reason, listingKey: p.listingKey || null, trigger },
      });
      if (!claim.inserted) { skip("already claimed today"); continue; }
      const pingKey = p.reason === "fresh_listing" && p.listingKey ? `listing_pinged:${p.contactId}:${p.listingKey}` : null;
      if (pingKey) {
        await recordEvent({
          store, locationId, contactId: p.contactId, party: "agent", type: "listing_pinged", at: iso(now), source: "sweep",
          address: p.subject?.address || "", dedupeKey: pingKey, data: { listingKey: p.listingKey },
        }).catch(() => {});
      }
      // Nothing drafted: the seat and the listing come back.
      let voidedOnce = false;
      const voidClaim = async (why) => {
        if (voidedOnce) return;
        voidedOnce = true;
        await recordEvent({
          store, locationId, contactId: p.contactId, party: "agent", type: "agent_pulse_voided", at: iso(Date.now()), source: "sweep",
          dedupeKey: `agent_pulse_voided:${claimKey}`, data: { claimKey, why: String(why || "").slice(0, 160) },
        }).catch(() => {});
        if (pingKey) {
          await recordEvent({
            store, locationId, contactId: p.contactId, party: "agent", type: "listing_ping_voided", at: iso(Date.now()), source: "sweep",
            dedupeKey: `listing_ping_voided:${pingKey}`, data: { listingKey: p.listingKey },
          }).catch(() => {});
        }
      };
      const r = await start({
        client, locationId, saved, store, contactId: p.contactId, kind: "agent_pulse", offer: null,
        subject: { ...p.subject, listingKey: p.listingKey || null, variant: n++ },
        sendsEnabled: Boolean(sendsEnabled),
        deps: {
          ...deps,
          releaseHeld: plan.settings.autoSend,
          releaseReason: "the agent check-in may send itself (Settings → Agent Outreach)",
          onSettled: (j) => { if (!j?.draftId) voidClaim(j?.heldReason || j?.error || "nothing was drafted"); },
        },
      }).catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
      if (r?.skipped) { await voidClaim(r.skipped); skip(r.skipped); }
      else { job.started++; row.status = "drafting"; row.jobId = r?.job?.id || null; }
    }
    finish({ status: "done" });
  })().catch((e) => finish({ status: "error", error: String(e?.message || e).slice(0, 300) }));
  return job;
}

/**
 * maybeRunAgentPulse({ client, locationId, saved, store, sendsEnabled, deps, now }) → boolean
 *
 * Off the 15-minute tick: in the pulse's Pacific window on a workday, once a
 * day, back the same day if a deploy killed it.
 */
export async function maybeRunAgentPulse({ client, locationId, saved = {}, store = defaultStore, sendsEnabled = false, deps = {}, now = Date.now() }) {
  const s = agentPulseSettings(saved);
  if (!s.enabled || !conversationConfig(saved).enabled) return false;
  if (s.weekdaysOnly && !isWorkday(now)) return false;
  const gate = await claimDailyRun({ store, locationId, cursorName: CURSOR_NAME, now, hourNow: workHour(now), startHour: s.hour,
    windowHours: WINDOW_HOURS, running: jobs.get(locationId)?.status === "running" });
  if (!gate.go) return false;
  startAgentPulse({
    client, locationId, saved, store, sendsEnabled, deps, trigger: "daily", now,
    onDone: (job) => closeDailyRun({ store, locationId, cursorName: CURSOR_NAME, failed: job.status === "error", error: job.error,
      last: { id: job.id, status: job.status, picked: job.picked, started: job.started, skipped: job.skipped, finishedAt: job.finishedAt,
        due: job.counts?.due || null, dueNoSeat: job.counts?.dueNoSeat ?? null } }),
  });
  return true;
}
