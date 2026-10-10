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
import { conversationConfig, startProactive, previewProactive, markUnsubscribed } from "./reply-agent.js";
import { getContact, smsUnsubscribed, removeContactFromWorkflow, searchAllContactsByTags, listWorkflows, listPipelines } from "./ghl.js";
import { acquisitionsPipeline } from "./ghl-mirror.js";
import { listAcquisitionOpportunities } from "./tier-check.js";
import { workHour, isWorkday, normalizeOutreachAutopilot } from "./outreach-sweep.js";
import { allEventsSince } from "./contact-events.js";
import { botEventsByContact } from "./bot-hold.js";
import { mergeEvents } from "./shared/bot-hold.js";
import { claimDailyRun, closeDailyRun } from "./daily-gate.js";
import { annotateCurrent } from "./shared/current-offer.js";
import { agentTier } from "./shared/tiers.js";
import { effectiveStatus, OPEN_STATUSES, dealIsOver } from "./shared/offer-status.js";
import { addressKey } from "./shared/us-address.js";
import {
  normalizeAgentPulse, pickPulseAgents, blockedByTags, tierDrips, evaluateAgent,
  AGENT_PULSE_EVENT_TYPES, AGENT_PULSE_LEDGER_TYPES, INBOUND_EVENT_TYPES,
} from "./shared/agent-pulse.js";
import { leadSourcesFor } from "./shared/lead-source.js";

export const CURSOR_NAME = "agentPulse";
export const WINDOW_HOURS = 5;
const DAY_MS = 86400000;
const EVENTS_DAYS = 130;
const LEDGER_DAYS = 400;
const iso = (ms) => new Date(ms).toISOString();
const pacificDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(ms));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The tags the tier nurture goes with; who the one-time clean-up reads.
export const TIER_DRIP_TAGS = ["tier-2", "tier-3"];

// GHL's workflow list, for finding the nurture drip by name. Ten minutes is
// plenty: workflows are renamed by hand, rarely. A read that fails gives null,
// and then only drips picked by hand are replaced.
const WORKFLOWS_TTL_MS = 10 * 60 * 1000;
const workflowCache = new Map();
export async function pulseWorkflows(client, locationId, deps = {}) {
  if (typeof deps.listWorkflows === "function") return deps.listWorkflows().catch(() => null);
  const hit = workflowCache.get(locationId);
  if (hit && Date.now() - hit.at < WORKFLOWS_TTL_MS) return hit.list;
  if (!client) return null;
  try {
    const list = await listWorkflows(client, locationId);
    workflowCache.set(locationId, { at: Date.now(), list });
    return list;
  } catch { return null; }
}

// GHL's Tier 2 / Tier 3 cards (Matt, 2026-10-09: the nurture drip is off and
// the app does all of it): contactId → { tier, movedAt }, the day the card
// moved there. Ten minutes' cache, like the workflow list. A read that fails
// gives null and the check-in plans without the cards.
const TIER_CARDS_TTL_MS = 10 * 60 * 1000;
const tierCardCache = new Map();
export function tierCardsFrom({ acq = null, opportunities = [] } = {}) {
  const out = new Map();
  if (!acq?.tierStages) return out;
  const tierOf = new Map([[acq.tierStages["tier-2"], "t2"], [acq.tierStages["tier-3"], "t3"]]);
  for (const o of opportunities || []) {
    const tier = tierOf.get(o?.pipelineStageId);
    const contactId = o?.contactId || o?.contact?.id;
    if (!tier || !contactId || (o.status && o.status !== "open")) continue;
    // The stage move, never updatedAt: any edit to the card moves that.
    const movedAt = o.lastStageChangeAt || o.createdAt || null;
    const had = out.get(contactId);
    if (!had || String(movedAt || "") > String(had.movedAt || "")) out.set(contactId, { tier, movedAt });
  }
  return out;
}
export async function pulseTierCards(client, locationId, deps = {}) {
  if (typeof deps.tierCards === "function") return deps.tierCards().catch(() => null);
  const hit = tierCardCache.get(locationId);
  if (hit && Date.now() - hit.at < TIER_CARDS_TTL_MS) return hit.cards;
  if (!client) return null;
  try {
    const acq = acquisitionsPipeline(await listPipelines(client, locationId));
    if (!acq) return null;
    const cards = tierCardsFrom({ acq, opportunities: await listAcquisitionOpportunities(client, locationId, acq.id) });
    tierCardCache.set(locationId, { at: Date.now(), cards });
    return cards;
  } catch { return null; }
}

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
 * housesFrom(offers, events) → { live: Set<addressKey>, walked: Map<addressKey, at> }
 *
 * A house with any live offer or deal of ours is that offer's business, and a
 * house we walked away from isn't raised with anyone for six months — passed
 * on its offer, or passed / kicked off the Tier 1 list with no offer at all.
 */
export function housesFrom(offers = [], events = []) {
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
  for (const e of events || []) {
    if (!e?.address || (e.type !== "tier1_passed" && e.type !== "tier1_kicked")) continue;
    const k = addressKey(e.address);
    if (k && (!walked.has(k) || String(e.at || "") > String(walked.get(k)))) walked.set(k, e.at || "");
  }
  return { live, walked };
}

/**
 * planAgentPulse({ locationId, saved, store, now }) → { picks, counts, settings, claimedToday, seats }
 *
 * Pure read: who would get one today. One read per source, whatever the size
 * of the book.
 */
/**
 * loadPulseAgents({ locationId, saved, store, now }) → { agents, settings, config, oa, houses, ledgerRead, evRead }
 *
 * Every agent the app knows (contact profiles, listing agents, and anyone we
 * made an offer to), each with their offers, drafts, timeline, check-in
 * ledger, last word and fresh listings. The check-in plans from it; the
 * tiers (agentRoster) read it too.
 */
export async function loadPulseAgents({ locationId, saved = {}, store = defaultStore, now = Date.now(), tierCards = null }) {
  const settings = agentPulseSettings(saved);
  const config = conversationConfig(saved);
  const oa = normalizeOutreachAutopilot(saved.outreachAutopilot);
  // The stop events come with no time window (ghl-broker/bot-hold.js): the
  // pulse's own read keeps 130 days, and a stop pressed in May still holds.
  // Not caught — a plan that can't tell who is stopped texts no one.
  const [profiles, investors, offers, evRead, ledgerRead, openDrafts, recentDrafts, inbound, listings, stops] = await Promise.all([
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
    botEventsByContact({ store, locationId }),
  ]);
  // Every agent's opening listing, to tell the houses they brought us from
  // the ones we texted them about (shared/lead-source.js).
  const hooks = typeof store.listOutreachHooks === "function" ? await store.listOutreachHooks(locationId).catch(() => []) : [];
  const leads = leadSourcesFor({ offers: offers || [], hooks, events: [...(evRead.events || []), ...(ledgerRead.events || [])] });

  const annotated = annotateCurrent((offers || []).map((o) => (o && leads.has(o.id) ? { ...o, leadSource: leads.get(o.id) } : o))).filter(Boolean);
  const houses = housesFrom(annotated, evRead.events);
  const offersBy = byContact(annotated);
  const eventsBy = byContact(evRead.events);
  for (const [id, list] of stops) eventsBy.set(id, mergeEvents(eventsBy.get(id) || [], list));
  const ledgerBy = byContact(ledgerRead.events);
  const seenDraft = new Set((openDrafts || []).map((d) => d.id));
  const draftsBy = byContact([...(openDrafts || []), ...(recentDrafts || []).filter((d) => !seenDraft.has(d.id))]);
  const inboundBy = new Map((inbound || []).map((r) => [r.contactId, r.at]));
  const listingsBy = byContact(listings);
  const profileBy = new Map((profiles || []).map((p) => [p.contactId, p]));
  // A buyer the pull happened to match (some buyers list houses too) is the
  // buyer pulse's, not this one's.
  const investorIds = new Set((investors || []).map((p) => p.contactId));
  // Contact profiles, listing agents, and anyone we made an offer to, sent
  // or drafted (Matt, 2026-10-09: every agent with an offer is followed up).
  // An offer contact with no profile has no tags here; the runner checks
  // each one in GHL before it claims them.
  // And everyone on a Tier 2 or Tier 3 card in GHL (pulseTierCards).
  const cards = tierCards instanceof Map ? tierCards : new Map();
  const ids = new Set([...(profiles || []).map((p) => p.contactId), ...(listings || []).map((l) => l.contactId), ...offersBy.keys(), ...cards.keys()]);

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
      ghlTier: cards.get(id) || null,
    });
  }
  return { agents, settings, config, oa, houses, ledgerRead, evRead };
}

export async function planAgentPulse({ locationId, saved = {}, store = defaultStore, now = Date.now(), workflows = null, tierCards = null }) {
  const { agents, settings, config, oa, houses, ledgerRead, evRead } = await loadPulseAgents({ locationId, saved, store, now, tierCards });

  // The day's cap is the DAY's: a retry, or a second press of Run now, only
  // gets the seats still empty. A voided claim gave its seat back.
  const voided = new Set((ledgerRead.events || []).filter((e) => e.type === "agent_pulse_voided").map((e) => e.data?.claimKey).filter(Boolean));
  const today = (ledgerRead.events || []).filter((e) => e.type === "agent_pulse_sent" && pacificDay(Date.parse(e.at)) === pacificDay(now));
  const claimedToday = today.filter((e) => !voided.has(e.dedupeKey)).length;
  const seats = settings.dailyCap > 0 ? Math.max(0, settings.dailyCap - claimedToday) : Infinity;   // 0 = no cap
  // Tried today already — a claim that drafted nothing is voided and gives
  // its seat back, but the agent waits for tomorrow (the day's claim key is
  // theirs), so the seat goes to someone else.
  const triedToday = new Set(today.map((e) => e.contactId));
  // The drips this check-in replaces (the tier nurture) never hold an agent
  // back from it: the check-in is the one clock.
  const drips = tierDrips({ pulse: settings, conversationAi: saved.conversationAi, workflows });
  const planSettings = { ...settings, replacesWorkflowIds: drips.map((d) => d.id) };
  const plan = pickPulseAgents({ agents: agents.filter((a) => !triedToday.has(a.contactId)), settings: planSettings, config, houses, outreachFollowUpDays: oa.followUpDays, seats, now });
  return { ...plan, settings, drips, claimedToday, seats, tierCardsRead: tierCards instanceof Map, truncated: Boolean(evRead.truncated || ledgerRead.truncated) };
}

// What keeps a Tier 2 agent warm, in a few words (shared/agent-pulse.js
// evaluateAgent's verdict).
function careLine(v, pulseOn) {
  if (v.status === "owned") return { kind: "clock", text: v.reason };
  if (v.status === "stopped") return { kind: "stopped", text: v.reason };
  if (v.status === "cold_dropped") return { kind: "dropped", text: v.reason };
  if (!pulseOn) return { kind: "off", text: "the agent check-in is off — nothing keeps them warm" };
  if (v.status === "due") return { kind: "due", text: v.pulseReason === "fresh_listing" ? "check-in due: they have a fresh listing" : "check-in due on the next run" };
  return { kind: "waiting", text: v.reason ? `check-in later — ${v.reason}` : "check-in later" };
}

/**
 * agentRoster({ locationId, saved, store, now }) → { counts, rows, pulseOn }
 *
 * Every agent's tier (shared/tiers.js agentTier), derived each time from the
 * app's record, and for Tier 2 what is keeping them warm. Rows are Tier 1 and
 * Tier 2 (cold and opted-out agents are counted only). Names come from the
 * contact record; nothing here is logged.
 */
export async function agentRoster({ locationId, saved = {}, store = defaultStore, now = Date.now() }) {
  const { agents, settings, config, oa, houses } = await loadPulseAgents({ locationId, saved, store, now });
  const counts = { t1: 0, t2: 0, cold: 0, opted_out: 0 };
  const rows = [];
  for (const a of agents) {
    const t = agentTier({ offers: a.offers, events: a.events, lastInboundAt: a.lastInboundAt, now });
    counts[t.tier] = (counts[t.tier] || 0) + 1;
    if (t.tier !== "t1" && t.tier !== "t2") continue;
    const name = a.name || a.offers.find((o) => o?.contactName)?.contactName || a.drafts.find((d) => d?.contactName)?.contactName || "";
    const row = { contactId: a.contactId, name, tier: t.tier, why: t.why, address: t.address || "", lastInboundAt: a.lastInboundAt };
    if (t.tier === "t2") {
      const v = evaluateAgent(a, { settings, config, houses, outreachFollowUpDays: oa.followUpDays, now });
      row.segment = v.segment || null;
      row.care = careLine(v, settings.enabled);
    }
    rows.push(row);
  }
  rows.sort((x, y) => (x.tier === y.tier ? String(y.lastInboundAt || "").localeCompare(String(x.lastInboundAt || "")) : x.tier === "t1" ? -1 : 1));
  return { counts, rows, pulseOn: Boolean(settings.enabled) };
}

const removerFor = (client, deps = {}) => (typeof deps.removeFromWorkflow === "function"
  ? deps.removeFromWorkflow : (contactId, workflowId) => removeContactFromWorkflow(client, contactId, workflowId));

/**
 * leaveDrip({ store, locationId, contactId, drip, remove, why, now }) → "removed" | "not_in" | "failed"
 *
 * Takes one person out of one GHL drip and puts it on their timeline. GHL
 * answers a 4xx for someone who wasn't in it; that's not a failure.
 */
async function leaveDrip({ store, locationId, contactId, drip, remove, why = "", now = Date.now() }) {
  try { await remove(contactId, drip.id); }
  catch (e) { return e?.status >= 400 && e?.status < 500 ? "not_in" : "failed"; }
  await recordEvent({
    store, locationId, contactId, party: "agent", type: "workflow_left", at: iso(Date.now()), source: "sweep", ref: drip.id,
    dedupeKey: `workflow_left:${contactId}:${drip.id}:${pacificDay(now)}`,
    data: { workflowId: drip.id, workflowName: drip.name || "", why },
  }).catch(() => {});
  return "removed";
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
  const remove = removerFor(client, deps);
  const finish = (patch) => { Object.assign(job, patch, { finishedAt: new Date().toISOString() }); try { onDone?.(job); } catch { /* the caller's */ } };

  (async () => {
    const plan = await planAgentPulse({ locationId, saved, store, now, workflows: await pulseWorkflows(client, locationId, deps), tierCards: await pulseTierCards(client, locationId, deps) });
    const picks = limit != null ? plan.picks.slice(0, Math.max(0, Math.round(Number(limit)) || 0)) : plan.picks;
    job.counts = plan.counts;
    job.picked = picks.length;
    const config = conversationConfig(saved);
    job.autoSend = Boolean(plan.settings.autoSend && sendsEnabled && config.enabled);
    const botOff = config.routing?.botOffTags || [];
    // A different way in for each text, continuing across the day's runs.
    let n = Number(plan.claimedToday) || 0;
    // The day's picks, then the spares: an agent skipped before being claimed
    // (unsubscribed, tagged off, no phone) hands the seat to the next in line.
    const seats = picks.length;
    let claimed = 0;
    for (const p of [...picks, ...(dryRun ? [] : plan.spares || [])]) {
      if (claimed >= seats) break;
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
      claimed++;
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
      // Out of the drips this check-in replaces first, so nobody hears from
      // both (a 4xx is "wasn't in it").
      for (const drip of plan.drips || []) {
        await leaveDrip({ store, locationId, contactId: p.contactId, drip, remove, why: "the agent check-in took over", now });
      }
      const r = await start({
        client, locationId, saved, store, contactId: p.contactId, kind: "agent_pulse", offer: null,
        subject: { ...p.subject, listingKey: p.listingKey || null, variant: n++ },
        sendsEnabled: Boolean(sendsEnabled),
        deps: {
          ...deps,
          // The thank-you after a close is yours to send unless you said otherwise.
          releaseHeld: plan.settings.autoSend && (p.reason !== "deal_thanks" || plan.settings.thanksAutoSend),
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

/**
 * previewAgentPulse({ client, locationId, saved, store, limit, deps, now }) → { previews, counts, drips }
 *
 * The next few check-ins as the drafter would write them today — their
 * thread, their record, Matt's notes on the voice — and nothing else: no
 * claim, no draft row, nothing sent (reply-agent.js previewProactive). One
 * model call each, so a handful at most.
 */
export async function previewAgentPulse({ client, locationId, saved = {}, store = defaultStore, limit = 3, reason = "", deps = {}, now = Date.now() }) {
  const plan = await planAgentPulse({ locationId, saved, store, now, workflows: await pulseWorkflows(client, locationId, deps), tierCards: await pulseTierCards(client, locationId, deps) });
  const preview = typeof deps.previewProactive === "function" ? deps.previewProactive : previewProactive;
  const n = Math.max(1, Math.min(5, Math.round(Number(limit)) || 3));
  const previews = [];
  // A pick that wouldn't be drafted (unsubscribed, a person has the thread)
  // is shown with why, and the next in line is written in its place.
  let drafted = 0;
  // `reason` ("general", "fresh_listing", …): samples of that kind only.
  const line = [...plan.picks, ...(plan.spares || [])].filter((p) => !reason || p.reason === reason).slice(0, n + 4);
  for (const [i, p] of line.entries()) {
    if (drafted >= n) break;
    const r = await preview({ client, locationId, saved, store, contactId: p.contactId, kind: "agent_pulse", offer: null, subject: { ...p.subject, variant: i } })
      .catch((e) => ({ skipped: String(e?.message || e).slice(0, 160) }));
    if (!r?.skipped) drafted++;
    previews.push({
      contactId: p.contactId, name: r?.contactName || p.name || "", segment: p.segment, reason: p.reason, street: p.subject?.address || "",
      reply: r?.reply || "", held: Boolean(r?.held), flags: r?.flags || [], skipped: r?.skipped || "",
    });
  }
  return { previews, counts: plan.counts, drips: plan.drips };
}

/* ---------- the one-time clean-up: everyone out of the tier nurture ---------- */

const leaveJobs = new Map();
export const getLeaveDripsJob = (locationId) => leaveJobs.get(locationId) || null;

/**
 * startLeaveDrips({ client, locationId, saved, store, dryRun, deps }) → job
 *
 * Everyone tagged tier-2 or tier-3 in GHL, out of the drips the check-in
 * replaces (the tier nurture) — for the ones already running when it's switched on
 * (GHL has no API that lists who's in a workflow, so the tags are the list).
 * A dry run only counts. Live, only with the check-in on, so nobody is left
 * with no check-in at all. Paced; a person who wasn't in a drip is counted,
 * not failed.
 */
export function startLeaveDrips({ client, locationId, saved = {}, store = defaultStore, dryRun = false, deps = {} }) {
  const s = agentPulseSettings(saved);
  if (!dryRun && !s.enabled) throw Object.assign(new Error("turn the agent check-in on first, so nobody is left without a check-in"), { http: 409 });
  if (leaveJobs.get(locationId)?.status === "running") throw Object.assign(new Error("already taking people out of the drips"), { http: 409 });
  const job = {
    id: `ld-${Date.now().toString(36)}`, locationId, dryRun: Boolean(dryRun), status: "running", startedAt: new Date().toISOString(), finishedAt: null,
    drips: [], tagged: 0, done: 0, removed: 0, notIn: 0, failed: 0, truncated: false, error: null,
  };
  leaveJobs.set(locationId, job);
  const remove = removerFor(client, deps);
  const pace = deps.paceMs ?? 150;
  const tagged = typeof deps.taggedContacts === "function" ? deps.taggedContacts
    : async () => { const r = await searchAllContactsByTags(client, locationId, TIER_DRIP_TAGS); job.truncated = Boolean(r?.truncated); return r?.contacts || []; };
  (async () => {
    const drips = tierDrips({ pulse: s, conversationAi: saved.conversationAi, workflows: await pulseWorkflows(client, locationId, deps) });
    if (!drips.length) throw new Error("no nurture drip found in GHL — pick the drips the check-in replaces in Settings");
    job.drips = drips;
    const contacts = ((await tagged()) || []).filter((c) => c?.id);
    job.tagged = contacts.length;
    if (!dryRun) {
      for (const c of contacts) {
        for (const drip of drips) {
          const r = await leaveDrip({ store, locationId, contactId: c.id, drip, remove, why: "the agent check-in replaced the drip" });
          if (r === "removed") job.removed++; else if (r === "not_in") job.notIn++; else job.failed++;
          if (pace) await sleep(pace);
        }
        job.done++;
      }
    }
    Object.assign(job, { status: "done", finishedAt: new Date().toISOString() });
  })().catch((e) => Object.assign(job, { status: "error", error: String(e?.message || e).slice(0, 300), finishedAt: new Date().toISOString() }));
  return job;
}
