// tier-check.js — once a day, an agent's tier tag and their Acquisitions card agree.
//
// The bot keeps them together when it tags someone (routes/offers.js
// onTagsChanged). This catches everything else: a card dragged by hand in GHL,
// a tag edited by hand, a GHL workflow that moved a card, a hook that failed.
// On 2026-09-15, 32 agents were out of line.
//
// Which side wins:
//   - A card in Tier 1/2/3 is the truth. The tags become that one tier, unless the
//     bot tagged a different tier after the card last moved; then the card follows
//     that tag, because the hook missed it.
//   - A card at Offer Out or later is a deal in flight, so the tag is tier-1 alone.
//   - Anything else is left as it is: New Lead, Contacted, Passed on Offer, Lost,
//     a closed card, a contact who isn't an agent, or a contact whose cards disagree.
// Bounded per run; every tag change is on the contact's record.
//
// With `ghlStages.mode` "on" (Matt's four-stage board, 2026-10-13) the card
// follows the offers instead (shared/ghl-stages.js), and the tags follow the
// card: Tier 1, Offer Out and Contract are tier-1, Tier 2 is tier-2, and a tag
// the bot added never moves a card.

import { store as defaultStore } from "./store.js";
import { listPipelines, addContactTags, removeContactTags, updateOpportunity, createOpportunity, searchOpportunities, listWorkflows, getContact, getOpportunity, searchConversations, listConversationMessages } from "./ghl.js";
import { acquisitionsPipeline, pipelinesFor } from "./ghl-mirror.js";
import { recordEvent } from "./contact-record.js";
import { localHour } from "./promise-sweep.js";
import { claimDailyRun, closeDailyRun } from "./daily-gate.js";
import { planStageMoves, planCard, planHandMove, normalizeGhlStages, stageKeys, CARD_STAGE_LABEL, raisedHouses, HOUSE_EVENT_TYPES, theirWordInGhl } from "./shared/ghl-stages.js";
import { offerStageAt } from "./shared/offer-stage.js";
import { openPromises } from "./shared/promise-resolver.js";
import { INBOUND_EVENT_TYPES } from "./shared/last-activity.js";
import { runTierOneScreen } from "./tier-one.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { resolveParty } from "./conversation-party.js";
import { allEventsSince } from "./contact-events.js";

export const CURSOR_NAME = "tierCheck";
export const CHECK_HOUR = 7;             // PT
// The operator chose the whole backlog in one run (2026-09-15: 174 agents);
// this is a ceiling against a bad read, not a pace.
export const MAX_CHANGES = 300;
const MIN_GAP_MS = 20 * 3600 * 1000;
const EVENT_LOOKBACK_MS = 3 * 86400000;
const TIERS = ["tier-1", "tier-2", "tier-3"];
const PAST_TIERS_RX = /^(offer out|negotiations?|contract sent|contract signed)\b/i;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * planTierFixes({ pipelines, opportunities, tagEvents, followsOffers }) → [{ contactId, name, opportunityId, add, remove, moveTo, from, why }]
 *
 * Pure. `opportunities` are GHL search rows (with `contact.tags`); `tagEvents`
 * are the app's recent tag_added events ({ contactId, at, data: { tag } }).
 * `followsOffers`: the card follows the offers, so the tags only follow the
 * card — never the other way round.
 */
export function planTierFixes({ pipelines = [], opportunities = [], tagEvents = [], followsOffers = false } = {}) {
  const acq = acquisitionsPipeline(pipelines);
  if (!acq) return [];
  const stageName = new Map((acq.stages || []).map((s) => [s.id, String(s.name || "").trim()]));
  const tierOfStage = new Map(Object.entries(acq.tierStages).map(([tier, id]) => [id, tier]));

  const byContact = new Map();
  for (const o of opportunities || []) {
    if (o.pipelineId !== acq.id || !o.contactId) continue;
    if (!byContact.has(o.contactId)) byContact.set(o.contactId, []);
    byContact.get(o.contactId).push(o);
  }
  const lastBotTier = new Map();
  for (const e of tagEvents || []) {
    const tag = String(e?.data?.tag || "").toLowerCase();
    if (!TIERS.includes(tag) || !e.contactId) continue;
    const prev = lastBotTier.get(e.contactId);
    if (!prev || String(e.at) > prev.at) lastBotTier.set(e.contactId, { tag, at: String(e.at) });
  }

  const fixes = [];
  for (const [contactId, opps] of byContact) {
    const open = opps.filter((o) => (o.status || "open") === "open");
    if (!open.length) continue;
    // Where each open card says the agent is: a tier, "past" the tiers, or nowhere we manage.
    const reads = open.map((o) => {
      const tier = tierOfStage.get(o.pipelineStageId);
      if (tier) return { o, want: tier, past: false };
      if (PAST_TIERS_RX.test(stageName.get(o.pipelineStageId) || "")) return { o, want: "tier-1", past: true };
      return { o, want: null };
    }).filter((r) => r.want);
    if (!reads.length) continue;
    if (new Set(reads.map((r) => r.want)).size > 1) continue;
    const { o, want, past } = reads.find((r) => r.past) || reads[0];

    const tags = (o.contact?.tags || []).map((t) => String(t).toLowerCase());
    const isAgent = tags.includes("agent") || tags.some((t) => TIERS.includes(t));
    if (!isAgent) continue;
    const name = o.contact?.name || o.name || "";
    const have = TIERS.filter((t) => tags.includes(t));

    // The bot moved them after the card last moved: the card follows the tag.
    const bot = lastBotTier.get(contactId);
    const stageAt = String(o.lastStageChangeAt || o.updatedAt || "");
    if (!followsOffers && !past && bot && bot.tag !== want && have.includes(bot.tag) && bot.at > stageAt) {
      const remove = have.filter((t) => t !== bot.tag);
      fixes.push({ contactId, name, opportunityId: o.id, add: [], remove, moveTo: acq.tierStages[bot.tag], from: stageName.get(o.pipelineStageId) || "",
        why: `the bot tagged ${bot.tag} after the card last moved` });
      continue;
    }

    const add = have.includes(want) ? [] : [want];
    const remove = have.filter((t) => t !== want);
    if (!add.length && !remove.length) continue;
    fixes.push({ contactId, name, opportunityId: o.id, add, remove, moveTo: null, from: stageName.get(o.pipelineStageId) || "",
      why: past ? `card at ${stageName.get(o.pipelineStageId)}: tier-1 only` : `card in ${stageName.get(o.pipelineStageId)}` });
  }
  return fixes;
}

async function listAcquisitionOpportunities(client, locationId, pipelineId, { maxPages = 30 } = {}) {
  const rows = [];
  let after = "";
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ location_id: locationId, pipeline_id: pipelineId, limit: "100" });
    if (after) { q.set("startAfter", after.startAfter); q.set("startAfterId", after.startAfterId); }
    const r = await client.call(`/opportunities/search?${q.toString()}`);
    const batch = Array.isArray(r?.opportunities) ? r.opportunities : [];
    rows.push(...batch);
    const m = r?.meta || {};
    if (!batch.length || !m.startAfterId || !m.nextPage) break;
    after = { startAfter: String(m.startAfter), startAfterId: String(m.startAfterId) };
    await sleep(150);
  }
  return rows;
}

/**
 * runTierCheck({ client, locationId, store, ghl, dryRun, limit, now }) → { considered, planned, applied, fixes, errors }
 */
export async function runTierCheck({ client, locationId, store = defaultStore, ghl = null, saved = {}, dryRun = false, limit = MAX_CHANGES, now = Date.now() }) {
  const api = ghl || { listPipelines, addContactTags, removeContactTags, updateOpportunity, listAcquisitionOpportunities };
  const out = { considered: 0, planned: 0, applied: 0, fixes: [], errors: [] };
  const pipelines = await api.listPipelines(client, locationId);
  const acq = acquisitionsPipeline(pipelines);
  if (!acq) { out.errors.push("no pipeline with Tier 1/2/3 stages"); return out; }
  const [opportunities, tagEvents] = await Promise.all([
    api.listAcquisitionOpportunities(client, locationId, acq.id),
    store.listContactEventsSince?.(locationId, iso(now - EVENT_LOOKBACK_MS), { types: ["tag_added"], limit: 5000 }).catch(() => []) || [],
  ]);
  out.considered = opportunities.length;
  // The stage plan reads the same cards (runStagePlan); not part of the summary.
  Object.defineProperty(out, "read", { value: { pipelines, opportunities }, enumerable: false });
  const followsOffers = normalizeGhlStages(saved?.ghlStages).mode === "on";
  const fixes = planTierFixes({ pipelines, opportunities, tagEvents, followsOffers });
  out.planned = fixes.length;
  for (const f of fixes.slice(0, limit)) {
    if (dryRun) { out.fixes.push({ ...f, applied: false }); continue; }
    try {
      if (f.remove.length) await api.removeContactTags(client, f.contactId, f.remove);
      if (f.add.length) await api.addContactTags(client, f.contactId, f.add);
      if (f.moveTo) await api.updateOpportunity(client, f.opportunityId, { stageId: f.moveTo });
      const events = [...f.remove.map((tag) => ["tag_removed", tag]), ...f.add.map((tag) => ["tag_added", tag])];
      await Promise.all(events.map(([type, tag]) => recordEvent({ store, locationId, contactId: f.contactId, party: "agent", type, source: "tier_check", data: { tag } })));
      out.applied++;
      out.fixes.push({ ...f, applied: true });
      await sleep(120);
    } catch (e) {
      out.errors.push(`${f.name || f.contactId}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  return out;
}

// A published "Tier 2+3 nurture" style workflow: GHL starts it by itself
// when a card lands in Tier 2/3, and it texts (shared/agent-pulse.js tierDrips).
// The agent nurture GHL starts on a Tier 2/3 stage move ("Tier 2+3 nurture").
// Not every workflow called a nurture: "Not Now Nurture" is a seller drip
// with nothing to do with the Acquisitions board (Matt, 2026-10-13).
const NURTURE_RX = /^(?=.*nurture)(?=.*tier)/i;
const nurtureWorkflows = (list) => (Array.isArray(list) ? list : [])
  .filter((w) => w?.id && NURTURE_RX.test(String(w.name || "")) && !/dispo/i.test(String(w.name || "")) && String(w.status || "").toLowerCase() !== "draft")
  .map((w) => ({ id: String(w.id), name: String(w.name || "") }));

// What the app does to a card: its own moves (this planner, the migration,
// the Tier 1 list). Not the bot's TIER workflows: those followed the
// conversation at the time, and stand as a person's move would.
export const APP_MOVE_EVENT_TYPES = ["ghl_stage_moved"];
// A stage a person set in the app (the companion window, setCardStage): a
// person's move, like a drag in GHL. Never in APP_MOVE_EVENT_TYPES, or the
// offers would read it as their own and move the card straight back.
export const HAND_MOVE_EVENT_TYPES = ["ghl_stage_set"];
const movesByContact = (types) => (events = []) => {
  const out = new Map();
  for (const e of events || []) {
    if (!e?.contactId || !e.at || !types.includes(e.type)) continue;
    if (!out.has(e.contactId)) out.set(e.contactId, []);
    out.get(e.contactId).push(e.at);
  }
  return out;
};
export const appMovesByContact = movesByContact(APP_MOVE_EVENT_TYPES);
export const handMovesByContact = movesByContact(HAND_MOVE_EVENT_TYPES);
// The contacts the app has made a card for (a deleted one stays deleted).
const cardsMadeBy = (events = []) => new Set((events || []).filter((e) => e?.contactId && APP_MOVE_EVENT_TYPES.includes(e.type) && e.data?.created).map((e) => e.contactId));

// Their word to us: a call, or a text summary of THEIR text (store.lastContactActivity inboundOnly).
const isTheirWord = (e) => INBOUND_EVENT_TYPES.includes(e?.type) && (e.type !== "text_summary" || String(e.data?.inbound || "").trim() !== "");

// An agent by their GHL tags, the way the conversation routes them (Settings →
// Conversation AI: agent, agent-*). A text filed as an agent's isn't enough:
// the preview before tier2Repliers went on (2026-10-16) planned a card for a
// homeowner from the June seller texts, whose replies were filed that way.
const routingOf = (saved) => normalizeConversationAi(saved?.conversationAi).routing || {};
const taggedAgent = (tags, routing) => resolveParty({ tags: tags || [], routing }).party === "agent";
// What says someone is an agent before GHL is asked. Most profiles carry no
// tags (Deanna W.'s was []), so their timeline counts: an agent tag the app
// added (the outreach import), or our outreach opener.
const AGENT_SIGN_TYPES = ["tag_added", "outreach_enrolled", "outreach_sent", "outreach_left"];
function knownAgents({ profiles = [], signs = [], offers = [], routing = {} } = {}) {
  const buyers = new Set((profiles || []).filter((p) => p?.party === "investor").map((p) => p.contactId));
  const out = new Set();
  for (const p of profiles || []) if (p?.contactId && taggedAgent(p.tags, routing)) out.add(p.contactId);
  for (const e of signs || []) {
    if (!e?.contactId) continue;
    if (e.type !== "tag_added" || taggedAgent([e.data?.tag], routing)) out.add(e.contactId);
  }
  // A house of theirs we priced: a listing agent.
  for (const o of offers || []) if (o?.contactId) out.add(o.contactId);
  for (const id of buyers) out.delete(id);
  return out;
}

/**
 * agentRepliers(lastRows, optOuts, isAgent) → Map contactId → ISO of their last word
 *
 * The agents we've talked with, for their Tier 2 card (shared/ghl-stages.js
 * repliedCard): `lastRows` is each contact's newest word to us. A buyer is
 * left out (their board is Dispositions), and so is an agent who opted out —
 * an unsubscribed event, or a last word that said stop. `isAgent(contactId)`,
 * when given, must say yes too (their tags).
 */
export function agentRepliers(lastRows = [], optOuts = [], isAgent = null) {
  const out = new Map();
  const stopped = new Set((optOuts || []).map((e) => e?.contactId).filter(Boolean));
  for (const r of lastRows || []) {
    if (!r?.contactId || r.party !== "agent" || stopped.has(r.contactId) || !isTheirWord(r)) continue;
    if (isAgent && !isAgent(r.contactId)) continue;
    if (r.data?.intent === "opt_out") continue;
    out.set(r.contactId, r.at);
  }
  return out;
}
const YEAR_MS = 365 * 86400000;

// GHL's own threads, for the agents the bot never summarised (Matt,
// 2026-10-19: "all agents who HAVE responded (not negatively like stop,
// etc)"). The morning sweep reads every thread that moved since its last
// read; an agent found there whose card isn't made yet (the run's cap, a
// nurture guard) is kept and tried again the next morning, for a month.
export const GHL_WORDS_CURSOR = "ghlWords";
const GHL_WORDS_MAX_READS = 1000;
const GHL_WORDS_KEEP_MS = 30 * 86400000;
const DO_NOT_CONTACT_TAGS = new Set(["dnc", "dnd", "unsubscribed", "do-not-contact"]);
const msOf = (v) => (typeof v === "number" ? v : Date.parse(v || ""));

/**
 * ghlRepliers({ client, locationId, api, since, routing, skip, maxReads }) → { repliers, read, through }
 *
 * Agents (by GHL's tags, the Conversation AI routing) whose thread moved
 * since `since` and who wrote back (shared/ghl-stages.js theirWordInGhl),
 * opt-outs left out. `skip`: contacts not to read (an open card, a word the
 * app already has). Oldest thread first, so a capped run picks up where it
 * stopped: `through` is how far it got.
 */
export async function ghlRepliers({ client, locationId, api, since = null, routing = {}, skip = new Set(), maxReads = GHL_WORDS_MAX_READS, startedAt = Date.now() }) {
  const floor = since ? msOf(since) : 0;
  const threads = new Map();
  let after;
  for (let page = 0; page < 200; page++) {
    const { conversations = [] } = await api.searchConversations(client, locationId, { limit: 100, startAfterDate: after });
    let done = !conversations.length;
    for (const c of conversations) {
      if (msOf(c.lastMessageDate) < floor) { done = true; break; }
      if (!c.contactId) continue;
      if (!threads.has(c.contactId)) threads.set(c.contactId, []);
      threads.get(c.contactId).push(c);
    }
    const last = conversations.at(-1);
    const next = last?.sort?.[0] ?? last?.lastMessageDate;
    if (done || next == null || next === after) break;
    after = next;
    await sleep(150);
  }
  const candidates = [...threads.entries()].filter(([contactId, cs]) => {
    const tags = cs[0].tags || [];
    if (skip.has(contactId) || tags.some((t) => DO_NOT_CONTACT_TAGS.has(String(t).toLowerCase()))) return false;
    // An agent by tags, and not also a buyer: their board is Dispositions.
    const { party, matched } = resolveParty({ tags, routing });
    return party === "agent" && !matched.investor.length;
  }).sort(([, a], [, b]) => msOf(a[0].lastMessageDate) - msOf(b[0].lastMessageDate));
  const repliers = new Map();
  let read = 0;
  let through = iso(startedAt);
  for (const [contactId, cs] of candidates) {
    if (read >= maxReads) { through = iso(msOf(cs[0].lastMessageDate) - 1); break; }
    read++;
    const messages = [];
    for (const c of cs.slice(0, 2)) messages.push(...((await api.listConversationMessages(client, c.id, { limit: 100 }))?.messages || []));
    const word = theirWordInGhl(messages);
    if (word?.at) repliers.set(contactId, word.at);
    await sleep(150);
  }
  return { repliers, read, through };
}

/**
 * ghlWordsFor({ … }) → Map contactId → ISO of their last word, from GHL
 *
 * The sweep's side of ghlRepliers: the agents found before and not yet
 * carded, plus (when `read`) a read since the cursor. A dry run reads
 * nothing new and moves no cursor.
 */
async function ghlWordsFor({ client, locationId, store, api, routing, skip, read, dryRun, now }) {
  const cur = await store.getJobCursor?.(locationId, GHL_WORDS_CURSOR).catch(() => null);
  const doc = cur?.doc || {};
  const found = new Map(Object.entries(doc.pending || {}).filter(([, v]) => now - (msOf(v?.foundAt) || 0) <= GHL_WORDS_KEEP_MS).map(([id, v]) => [id, v]));
  if (read && !dryRun && api.searchConversations && api.listConversationMessages) {
    // Noted before the read (as every job's cursor is), so a run a deploy
    // kills reads the same window again.
    await store.setJobCursor?.(locationId, GHL_WORDS_CURSOR, { at: iso(now), doc: { ...doc, startedAt: iso(now) } });
    const r = await ghlRepliers({ client, locationId, api, since: doc.since || null, routing, skip: new Set([...skip, ...found.keys()]), startedAt: now });
    for (const [id, at] of r.repliers) found.set(id, { at, foundAt: iso(now) });
    await store.setJobCursor?.(locationId, GHL_WORDS_CURSOR, { at: iso(now), doc: { since: r.through, read: r.read, pending: Object.fromEntries(found) } });
  }
  return new Map([...found].map(([id, v]) => [id, v.at]));
}

// After the moves: an agent found in GHL who has a card now is done.
async function settleGhlWords({ store, locationId, done }) {
  if (!done.size) return;
  const cur = await store.getJobCursor?.(locationId, GHL_WORDS_CURSOR).catch(() => null);
  const pending = { ...(cur?.doc?.pending || {}) };
  for (const id of done) delete pending[id];
  await store.setJobCursor?.(locationId, GHL_WORDS_CURSOR, { at: cur?.at || iso(Date.now()), doc: { ...(cur?.doc || {}), pending } });
}

// How far back the house events go: a raise is live for staleTier1Days, but a
// house the conversation closed stays closed under a row we priced later
// (raisedHouses; Tyler E., 2026-10-19), so the close has to be in the read.
const HOUSE_LOOKBACK_MS = 60 * 86400000;

/** raisedByContact({ events, offers, now, staleDays }) → Map contactId → raisedHouses(…) for agents' events, the non-empty ones only. */
export function raisedByContact({ events = [], offers = [], now = Date.now(), staleDays = 10 } = {}) {
  const evs = new Map();
  for (const e of events || []) {
    if (!e?.contactId || e.party !== "agent") continue;
    if (!evs.has(e.contactId)) evs.set(e.contactId, []);
    evs.get(e.contactId).push(e);
  }
  const rows = new Map();
  for (const o of offers || []) { if (!o?.contactId) continue; if (!rows.has(o.contactId)) rows.set(o.contactId, []); rows.get(o.contactId).push(o); }
  const out = new Map();
  for (const [id, list] of evs) {
    const r = raisedHouses({ events: list, offers: rows.get(id) || [], now, staleDays });
    if (r.length) out.set(id, r);
  }
  return out;
}

/**
 * runStagePlan({ client, locationId, store, saved, ghl, read, dryRun, now }) → { mode, planned, blocked, applied, moves, errors }
 *
 * Where each agent's Acquisitions card should sit by the app's record
 * (shared/ghl-stages.js), and — only with `ghlStages.mode` "on" and not a dry
 * run — the moves themselves, capped per run. The report keeps contact and
 * card ids and stage names, never a name or a message.
 */
export async function runStagePlan({ client, locationId, store = defaultStore, saved = {}, ghl = null, read = null, dryRun = true, readGhlWords = false, now = Date.now() }) {
  const api = ghl || { listPipelines, updateOpportunity, createOpportunity, listAcquisitionOpportunities, listWorkflows, getContact, searchConversations, listConversationMessages };
  const cfg = normalizeGhlStages(saved?.ghlStages);
  const out = { mode: cfg.mode, planned: 0, blocked: 0, applied: 0, moves: [], byMove: {}, errors: [] };
  const pipelines = read?.pipelines || await api.listPipelines(client, locationId);
  const acq = acquisitionsPipeline(pipelines);
  if (!acq) { out.errors.push("no pipeline with Tier 1/2/3 stages"); return out; }
  const [opportunities, offers, promiseEvents, moveEvents, lastRows, workflows, optOuts, profiles, signs] = await Promise.all([
    read?.opportunities || api.listAcquisitionOpportunities(client, locationId, acq.id),
    store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []),
    store.listContactEventsSince?.(locationId, iso(now - 7 * 86400000), { types: ["promise_made", "promise_owed", "promise_kept"], limit: 5000 }).catch(() => []) || [],
    // Card moves the app made, so "newest wins" never reads one as yours, and
    // the cards it made, so one someone deleted stays deleted.
    store.listContactEventsSince?.(locationId, iso(now - YEAR_MS), { types: [...APP_MOVE_EVENT_TYPES, ...HAND_MOVE_EVENT_TYPES], limit: 20000 }).catch(() => []) || [],
    store.lastContactActivity?.(locationId, { types: INBOUND_EVENT_TYPES, inboundOnly: true, limit: 20000 }).catch(() => []) || [],
    (api.listWorkflows ? api.listWorkflows(client, locationId) : Promise.resolve(null)).catch(() => null),
    cfg.tier2Repliers ? store.listContactEventsSince?.(locationId, iso(now - 3 * YEAR_MS), { types: ["unsubscribed"], limit: 20000 }).catch(() => []) || [] : [],
    cfg.tier2Repliers ? store.listContactProfiles?.(locationId, { limit: 20000 }).catch(() => []) || [] : [],
    cfg.tier2Repliers
      ? allEventsSince(store, locationId, iso(now - 3 * YEAR_MS), { types: AGENT_SIGN_TYPES }, { ceiling: 200000 }).then((r) => r.events).catch(() => [])
      : [],
  ]);
  const routing = routingOf(saved);
  // Houses the conversation raised (shared/ghl-stages.js raisedHouses): Tier 1
  // with no row behind them, for a contact we know is an agent.
  const houseEvents = await store.listContactEventsSince?.(locationId, iso(now - Math.max(HOUSE_LOOKBACK_MS, (cfg.staleTier1Days + 1) * 86400000)), { types: HOUSE_EVENT_TYPES, limit: 20000 }).catch(() => []) || [];
  const raisedBy = raisedByContact({ events: houseEvents, offers, now, staleDays: cfg.staleTier1Days });
  const needAgents = cfg.tier2Repliers || raisedBy.size > 0;
  const [agentProfiles, agentSigns] = cfg.tier2Repliers || !needAgents ? [profiles, signs] : await Promise.all([
    store.listContactProfiles?.(locationId, { limit: 20000 }).catch(() => []) || [],
    allEventsSince(store, locationId, iso(now - 3 * YEAR_MS), { types: AGENT_SIGN_TYPES }, { ceiling: 200000 }).then((r) => r.events).catch(() => []),
  ]);
  const agentIds = needAgents ? knownAgents({ profiles: agentProfiles, signs: agentSigns, offers, routing }) : new Set();
  for (const id of [...raisedBy.keys()]) if (!agentIds.has(id)) raisedBy.delete(id);
  const repliers = cfg.tier2Repliers ? agentRepliers(lastRows, optOuts, (id) => agentIds.has(id)) : new Map();
  // Agents whose reply only GHL's thread has (the bot never summarised it).
  // Their GHL tags say agent; the card's own check reads them again.
  let fromGhl = new Map();
  if (cfg.tier2Repliers) {
    const open = (opportunities || []).filter((o) => String(o?.status || "open") === "open").map((o) => o.contactId);
    const stopped = new Set((optOuts || []).map((e) => e?.contactId));
    const buyers = new Set((profiles || []).filter((p) => p?.party === "investor").map((p) => p.contactId));
    fromGhl = await ghlWordsFor({ client, locationId, store, api, routing, skip: new Set([...open, ...repliers.keys()]), read: readGhlWords, dryRun, now })
      .catch((e) => { out.errors.push(`GHL threads: ${String(e?.message || e).slice(0, 160)}`); return new Map(); });
    for (const [id, at] of fromGhl) if (!repliers.has(id) && !stopped.has(id) && !buyers.has(id)) repliers.set(id, at);
    out.fromGhl = fromGhl.size;
  }
  const plan = planStageMoves({
    acq, opportunities, offers, now, settings: cfg,
    lastIn: new Map((lastRows || []).map((r) => [r.contactId, r.at])),
    openPromiseContacts: new Set(openPromises(promiseEvents || [], { now }).map((p) => p.contactId)),
    appMoves: appMovesByContact(moveEvents),
    handMoves: handMovesByContact(moveEvents),
    repliers,
    cardsMade: cardsMadeBy(moveEvents),
    raised: raisedBy,
    // Can't read the workflow list: assume the nurture is live, so nothing moves into Tier 2 blind.
    nurtureLive: workflows == null ? [{ id: "?", name: "a nurture workflow (GHL's list couldn't be read)" }] : nurtureWorkflows(workflows),
  });
  out.planned = plan.counts.planned;
  out.blocked = plan.counts.blocked;
  out.created = 0;
  out.byMove = plan.counts.byMove;
  out.youMoved = plan.youMoved.slice(0, 40).map((m) => ({ contactId: m.contactId, opportunityId: m.opportunityId, from: m.from, wanted: m.wanted }));
  out.counts = plan.counts;
  const go = cfg.mode === "on" && !dryRun;
  let left = cfg.maxMovesPerRun;
  // The offers' own moves and cards first; a conversation's Tier 2 card waits behind them under the cap.
  const offersFirst = (list) => [...list.filter((x) => !x.replier), ...list.filter((x) => x.replier)];
  // A card from GHL's thread that didn't happen this run (the cap, a guard, a GHL error) is tried again tomorrow.
  const waiting = new Set();
  for (const m of offersFirst(plan.moves)) {
    const row = { contactId: m.contactId, opportunityId: m.opportunityId, from: m.from, to: m.to, why: m.why, ...(m.status ? { status: m.status } : {}), ...(m.blocked ? { blocked: m.blocked } : {}), ...(m.conversation ? { conversation: true } : {}) };
    if (go && !m.blocked && left > 0) {
      try {
        const done = await applyCardPlan({ client, locationId, store, api, acq, routing, plan: { move: m }, source: "ghl_stages" });
        if (done?.skip) row.skipped = done.skip;
        else { row.applied = true; out.applied++; left--; }
        await sleep(120);
      } catch (e) { out.errors.push(`${m.opportunityId}: ${String(e?.message || e).slice(0, 160)}`); }
    }
    if (m.replier && !row.applied && !row.skipped) waiting.add(m.contactId);
    if (out.moves.length < 80) out.moves.push(row);
  }
  out.creates = [];
  for (const c of offersFirst(plan.creates)) {
    const row = { contactId: c.contactId, to: c.to, why: c.why, ...(c.blocked ? { blocked: c.blocked } : {}), ...(c.conversation ? { conversation: true } : {}) };
    if (go && !c.blocked && left > 0) {
      try {
        const done = await applyCardPlan({ client, locationId, store, api, acq, routing, plan: { create: c }, source: "ghl_stages" });
        if (done?.skip) row.skipped = done.skip;
        else { row.applied = true; out.created++; left--; }
        await sleep(120);
      } catch (e) { out.errors.push(`create ${c.contactId}: ${String(e?.message || e).slice(0, 160)}`); }
    }
    if (c.replier && !row.applied && !row.skipped) waiting.add(c.contactId);
    if (out.creates.length < 40) out.creates.push(row);
  }
  if (go && fromGhl.size) await settleGhlWords({ store, locationId, done: new Set([...fromGhl.keys()].filter((id) => !waiting.has(id))) }).catch(() => {});
  return out;
}

/**
 * applyCardPlan({ client, locationId, store, api, acq, routing, plan, source }) → { opportunityId, from, to } | { skip } | null
 *
 * Writes one planCard result to GHL and the contact's record. Throws on a GHL
 * failure (the callers count it). Ids and stage names only. A conversation's
 * Tier 2 card (`replier`) or Tier 1 card (`conversation`, a house they
 * raised) is made, reopened or moved only for a contact GHL tags as an agent
 * right now; their name comes from the same read.
 */
async function applyCardPlan({ client, locationId, store, api, acq, routing = {}, plan, source }) {
  let who = null;
  if (plan.create?.replier || plan.move?.replier || plan.create?.conversation || plan.move?.conversation) {
    const id = (plan.create || plan.move).contactId;
    who = api.getContact ? await api.getContact(client, id).catch(() => null) : null;
    if (!who || !taggedAgent(who.tags, routing)) return { skip: "not tagged as an agent in GHL" };
  }
  if (plan.move && !plan.move.blocked) {
    const m = plan.move;
    await api.updateOpportunity(client, m.opportunityId, { stageId: m.toStageId, ...(m.status ? { status: m.status } : {}) });
    await recordEvent({ store, locationId, contactId: m.contactId, party: "agent", type: "ghl_stage_moved", source,
      data: { from: m.from, to: m.to, why: m.why, ...(m.status ? { status: m.status } : {}) } }).catch(() => {});
    return { opportunityId: m.opportunityId, from: m.from, to: m.to };
  }
  if (plan.create && !plan.create.blocked) {
    const c = plan.create;
    // A conversation's card has no offer to name it from: the contact's own name.
    const name = c.name || [who?.firstName, who?.lastName].filter(Boolean).join(" ") || String(who?.name || who?.contactName || "");
    const made = await api.createOpportunity(client, { locationId, pipelineId: acq.id, contactId: c.contactId, name: name || "Agent", stageId: c.toStageId });
    await recordEvent({ store, locationId, contactId: c.contactId, party: "agent", type: "ghl_stage_moved", source,
      data: { from: "", to: c.to, why: c.why, created: true } }).catch(() => {});
    return { opportunityId: made?.id || "", from: "", to: c.to };
  }
  return null;
}

// GHL's workflow list, once an hour per location: a Tier 2 move checks it.
const WORKFLOW_TTL_MS = 3600 * 1000;
const workflowCache = new Map();
async function liveNurture(client, locationId, api, now) {
  const hit = workflowCache.get(locationId);
  if (hit && now - hit.at < WORKFLOW_TTL_MS) return hit.live;
  const list = await (api.listWorkflows ? api.listWorkflows(client, locationId) : Promise.resolve(null)).catch(() => null);
  const live = list == null ? [{ id: "?", name: "a nurture workflow (GHL's list couldn't be read)" }] : nurtureWorkflows(list);
  workflowCache.set(locationId, { at: now, live });
  return live;
}
export function _resetWorkflowCache() { workflowCache.clear(); }

/**
 * syncAgentCard({ client, locationId, contactId, store, saved, ghl, repliersOnly, now }) → planCard's result, plus { applied } | { skip } | { error }
 *
 * One agent's card, right after their offers moved (shared/ghl-stages.js
 * planCard). Only with `ghlStages.mode` "on". Never throws. With
 * `tier2Repliers`, their record says whether we've talked (the Tier 2 card
 * for a conversation). A house they raised puts the card in Tier 1 with no
 * row (raisedHouses). `repliersOnly` applies only what the conversation
 * moves, for an agent who just wrote to us and whose offers didn't move.
 */
export async function syncAgentCard({ client, locationId, contactId, store = defaultStore, saved = null, ghl = null, repliersOnly = false, now = Date.now() }) {
  const api = ghl || { listPipelines, searchOpportunities, updateOpportunity, createOpportunity, listWorkflows, getContact };
  try {
    if (!contactId) return { skip: "no contact" };
    const settings = saved || (await store.getOfferSettings(locationId).catch(() => null)) || {};
    const cfg = normalizeGhlStages(settings.ghlStages);
    if (cfg.mode !== "on") return { skip: "GHL doesn't follow the offers (ghlStages off)" };
    const acq = acquisitionsPipeline(await pipelinesFor(client, locationId, { ghl: api, now }));
    if (!acq) return { skip: "no Acquisitions pipeline" };
    const [cards, offers, events] = await Promise.all([
      api.searchOpportunities(client, locationId, { contactId, pipelineId: acq.id }),
      store.listOffers(locationId, { contactId, limit: 100, lean: true }).catch(() => []),
      // A stage set in the companion is read every time: this search has no
      // lastStageChangeAt, so without it any offer update would undo it.
      store.listContactEvents?.(locationId, contactId, {
        types: [...new Set([...INBOUND_EVENT_TYPES, "unsubscribed", ...APP_MOVE_EVENT_TYPES, ...HAND_MOVE_EVENT_TYPES, ...HOUSE_EVENT_TYPES])], limit: 500,
      }).catch(() => []) || [],
    ]);
    const mine = (events || []).map((e) => ({ ...e, contactId }));
    const since = now - Math.max(HOUSE_LOOKBACK_MS, (cfg.staleTier1Days + 1) * 86400000);
    const raised = raisedHouses({ events: mine.filter((e) => HOUSE_EVENT_TYPES.includes(e.type) && (Date.parse(e.at || "") || 0) >= since), offers, now, staleDays: cfg.staleTier1Days });
    const lastWord = mine.filter(isTheirWord).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    const plan = planCard({
      acq, keys: stageKeys(acq), contactId, offers, settings: cfg, now,
      cards: (cards || []).map((c) => ({ ...c, pipelineStageId: c.pipelineStageId || c.stageId })),
      name: (offers || []).find((o) => o?.contactName)?.contactName || "",
      nurtureLive: await liveNurture(client, locationId, api, now),
      replied: agentRepliers(lastWord ? [lastWord] : [], mine.filter((e) => e.type === "unsubscribed")).get(contactId) || null,
      cardMade: cardsMadeBy(mine).has(contactId),
      handMoves: handMovesByContact(mine).get(contactId) || [],
      raised,
    });
    const fromConversation = (p) => Boolean(p.create?.replier || p.move?.replier || p.create?.conversation || p.move?.conversation);
    if (repliersOnly && !fromConversation(plan)) return { skip: plan.skip || "not a card the conversation moves" };
    if (plan.skip || plan.youMoved || plan.move?.blocked || plan.create?.blocked) return plan;
    const applied = await applyCardPlan({ client, locationId, store, api, acq, routing: routingOf(settings), plan, source: "offers" });
    if (applied?.skip) return { skip: applied.skip };
    console.log(`card follows offers loc=${locationId} contact=${contactId} ${applied?.from || "new"} → ${applied?.to}`);
    return { ...plan, applied };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * setCardStage({ client, locationId, contactId, to, store, ghl, now })
 *   → { ok, opportunityId, from, to, key, created? } | { refused } | { skip }
 *
 * Matt sets an agent's Acquisitions stage from the companion window (shared/
 * ghl-stages.js planHandMove). Works whether or not ghlStages is on: it's a
 * person's move, as a drag in GHL is. Recorded as `ghl_stage_set` so the
 * offers leave it until an offer event comes after it. The card is read back
 * by id (GHL's search lags). Ids and stage names only.
 */
export async function setCardStage({ client, locationId, contactId, to, store = defaultStore, ghl = null, now = Date.now() }) {
  const api = ghl || { listPipelines, searchOpportunities, updateOpportunity, createOpportunity, getOpportunity, listWorkflows, getContact };
  const acq = acquisitionsPipeline(await pipelinesFor(client, locationId, { ghl: api, now }));
  if (!acq) return { refused: "GHL has no Acquisitions pipeline with Tier 1 and Tier 2 stages." };
  const keys = stageKeys(acq);
  const cards = await api.searchOpportunities(client, locationId, { contactId, pipelineId: acq.id });
  const plan = planHandMove({
    acq, keys, contactId, to,
    cards: (cards || []).map((c) => ({ ...c, pipelineStageId: c.pipelineStageId || c.stageId })),
    nurtureLive: to === "tier2" ? await liveNurture(client, locationId, api, now) : [],
  });
  if (plan.refuse) return { refused: plan.refuse };
  if (plan.skip) return { skip: plan.skip };
  let opportunityId;
  let from = "";
  if (plan.move) {
    const m = plan.move;
    await api.updateOpportunity(client, m.opportunityId, { stageId: m.toStageId, ...(m.status ? { status: m.status } : {}) });
    const back = api.getOpportunity ? await api.getOpportunity(client, m.opportunityId).catch(() => null) : null;
    if (back && back.stageId && back.stageId !== m.toStageId) {
      const e = new Error(`GHL kept the card in ${(acq.stages || []).find((x) => x.id === back.stageId)?.name || "its stage"}`);
      e.http = 502;
      throw e;
    }
    opportunityId = m.opportunityId;
    from = m.from;
  } else {
    const c = plan.create;
    const offers = await store.listOffers(locationId, { contactId, limit: 20, lean: true }).catch(() => []);
    let name = (offers || []).find((o) => o?.contactName)?.contactName || "";
    if (!name && api.getContact) {
      const who = await api.getContact(client, contactId).catch(() => null);
      name = [who?.firstName, who?.lastName].filter(Boolean).join(" ") || String(who?.name || who?.contactName || "");
    }
    const made = await api.createOpportunity(client, { locationId, pipelineId: acq.id, contactId, name: name || c.name, stageId: c.toStageId });
    opportunityId = made?.id || "";
  }
  // Without this record the offers would read the move as nobody's and could
  // put the card back on their next change; say so rather than pass quietly.
  const recorded = await recordEvent({ store, locationId, contactId, party: "agent", type: "ghl_stage_set", source: "companion",
    data: { from, to: CARD_STAGE_LABEL[to], ...(plan.create ? { created: true } : {}) } }).then((r) => r?.inserted === true, () => false);
  return { ok: true, opportunityId, from, to: CARD_STAGE_LABEL[to], key: to, ...(plan.create ? { created: true } : {}),
    ...(recorded ? {} : { warning: "Moved in GHL, but the app couldn't note it was you. The offers may move it back on their next change." }) };
}

/**
 * syncChangedCards({ client, locationId, store, saved, ghl, now, limit }) → { since, contacts, moved, errors } | null
 *
 * The 15-minute tick: every agent whose offers moved since the last run gets
 * syncAgentCard. Status writes come from a dozen places (the conversation,
 * the sweeps, the timers, the triage); reading what changed catches them all.
 * The cursor is written before the run; a contact past `limit` waits for the
 * 7am sweep. Only with `ghlStages.mode` "on".
 */
export const CARD_SYNC_CURSOR = "cardSync";
const cardSyncRunning = new Set();
export async function syncChangedCards({ client, locationId, store = defaultStore, saved = {}, ghl = null, now = Date.now(), limit = 40 }) {
  if (normalizeGhlStages(saved?.ghlStages).mode !== "on" || cardSyncRunning.has(locationId)) return null;
  cardSyncRunning.add(locationId);
  try {
    const cur = await store.getJobCursor?.(locationId, CARD_SYNC_CURSOR).catch(() => null);
    // First run: nothing to catch up on — the morning sweep has the book.
    const since = Date.parse(cur?.doc?.since || "") || now;
    await store.setJobCursor?.(locationId, CARD_SYNC_CURSOR, { at: iso(now), doc: { since: iso(now), prev: iso(since) } });
    const offers = await store.listOffers(locationId, { limit: 2000, lean: true }).catch(() => []);
    const changed = [...new Set((offers || []).filter((o) => o?.contactId
      && Math.max(offerStageAt(o) ?? 0, Date.parse(o.updatedAt || "") || 0) > since).map((o) => o.contactId))];
    // With tier2Repliers: an agent who wrote to us since, whose offers didn't
    // move, gets their conversation's Tier 2 card now rather than at 7am.
    const words = normalizeGhlStages(saved?.ghlStages).tier2Repliers
      ? await store.listContactEventsSince?.(locationId, iso(since + 1), { types: INBOUND_EVENT_TYPES, limit: 500 }).catch(() => []) || []
      : [];
    const talked = [...new Set((words || []).filter((e) => e?.party === "agent" && isTheirWord(e) && !changed.includes(e.contactId)).map((e) => e.contactId))];
    // A house they raised (or one we closed) since: their Tier 1 card now.
    const houseWords = await store.listContactEventsSince?.(locationId, iso(since + 1), { types: HOUSE_EVENT_TYPES, limit: 500 }).catch(() => []) || [];
    for (const e of houseWords) if (e?.party === "agent" && e.contactId && !changed.includes(e.contactId) && !talked.includes(e.contactId)) talked.push(e.contactId);
    const out = { since: iso(since), contacts: changed.length, repliers: talked.length, moved: 0, errors: [] };
    const work = [...changed.map((contactId) => ({ contactId })), ...talked.map((contactId) => ({ contactId, repliersOnly: true }))];
    for (const { contactId, repliersOnly } of work.slice(0, limit)) {
      const r = await syncAgentCard({ client, locationId, contactId, store, saved, ghl, repliersOnly, now });
      if (r?.applied) out.moved++;
      if (r?.error) out.errors.push(`${contactId}: ${r.error}`);
      await sleep(100);
    }
    return out;
  } finally {
    cardSyncRunning.delete(locationId);
  }
}

/** The tick's call: once a day from 7am PT. */
const inFlight = new Set();
export async function maybeRunTierCheck({ client, locationId, store = defaultStore, ghl = null, saved = {}, operatorStatus = null, tierOneDeps = null, now = Date.now() }) {
  // Once a day; a run a deploy killed, or one that failed, comes back later
  // that day (daily-gate.js).
  const gate = await claimDailyRun({ store, locationId, cursorName: CURSOR_NAME, now, hourNow: localHour(now), startHour: CHECK_HOUR,
    windowHours: 20 - CHECK_HOUR, running: inFlight.has(locationId), minGapMs: MIN_GAP_MS });
  if (!gate.go) return null;
  inFlight.add(locationId);
  try {
    const r = await runTierCheck({ client, locationId, store, ghl, saved, now });
    // Where the cards should sit (shared/ghl-stages.js): always planned and
    // kept as a report, moved only with ghlStages.mode "on".
    const stageMoves = await runStagePlan({ client, locationId, store, saved, ghl, read: r.read, dryRun: false, readGhlWords: true, now })
      .catch((e) => ({ errors: [String(e?.message || e).slice(0, 160)] }));
    // GHL's Tier 1 stage screened (ghl-broker/tier-one.js): sure misses are
    // planned every morning and taken off only with tierOne.autoKick on.
    const tierOne = await runTierOneScreen({ client, locationId, saved, store, read: r.read, now,
      deps: { ...(tierOneDeps || {}), ...(operatorStatus ? { operatorStatus } : {}) } })
      .catch((e) => ({ errors: [String(e?.message || e).slice(0, 160)] }));
    const summary = { considered: r.considered, planned: r.planned, applied: r.applied, errors: r.errors.slice(0, 5),
      fixes: r.fixes.slice(0, 40).map((f) => ({ name: f.name, add: f.add, remove: f.remove, moved: !!f.moveTo, why: f.why })),
      stageMoves: { ...stageMoves, at: iso(now) }, tierOne: { ...tierOne, at: iso(now) } };
    await closeDailyRun({ store, locationId, cursorName: CURSOR_NAME, last: summary });
    return r;
  } catch (e) {
    const error = String(e?.message || e).slice(0, 160);
    await closeDailyRun({ store, locationId, cursorName: CURSOR_NAME, failed: true, error });
    return { considered: 0, planned: 0, applied: 0, fixes: [], errors: [error] };
  } finally {
    inFlight.delete(locationId);
  }
}

export { listAcquisitionOpportunities };
