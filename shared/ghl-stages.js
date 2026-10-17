// ghl-stages.js — GHL's Acquisitions card follows the agent's offers.
//
// Matt, 2026-10-13 (a diagram): GHL is the source of truth for where an agent
// is, in four stages, and the offer's stage (shared/offer-stage.js) drives it:
//
//   Tier 2     agent nurture: has replied, nothing live     every offer passed, or none
//   Tier 1     a property identified                        a draft: priced or being priced
//   Offer Out  our number is out                            Sent, Countered or Hot
//   Contract   under contract                               Accepted (a closed deal: the card is won)
//
// The highest stage across the agent's current offers wins. A person still
// moves cards in GHL: the plan only moves a card when the agent's newest
// offer event is later than the card's last move ("newest wins"). A card
// dragged after that is reported as "you moved it" and left alone.
//
// Never: a contact with two open cards (a person's call), a won card, a move
// into Tier 2 while a published "Tier 2+3 nurture" workflow would text them on
// it (unless `allowNurtureTrigger`), or a card in a stage that's going away —
// the one-time migration (ghl-broker/acq-migrate.js) moves those. A card is
// created for an agent with something live and no card, and — with
// `tier2Repliers` — in Tier 2 for an agent we've talked with and have
// nothing live for (Matt, 2026-10-16: "should have an opp in tier 2 so we
// know to follow up with her").
//
// Ships OFF (`ghlStages.mode`); the plan is kept every morning as a report.
// Pure. The runners (ghl-broker/tier-check.js) read GHL and the book.

import { annotateCurrent } from "./current-offer.js";
import { offerStage, offerStageAt } from "./offer-stage.js";
import { LIVE_DEAL_STAGES } from "./offer-status.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = typeof v === "number" ? v : Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

export const GHL_STAGES_DEFAULTS = Object.freeze({ mode: "off", staleTier1Days: 10, allowNurtureTrigger: false, maxMovesPerRun: 100, tier2Repliers: false });

/** normalizeGhlStages(v) → { mode: "off"|"on", staleTier1Days, allowNurtureTrigger, maxMovesPerRun, tier2Repliers } */
export function normalizeGhlStages(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const n = (x, d, lo, hi) => { const k = Math.round(Number(x)); return x == null || x === "" || !Number.isFinite(k) ? d : Math.min(hi, Math.max(lo, k)); };
  return {
    mode: o.mode === "on" ? "on" : "off",
    staleTier1Days: n(o.staleTier1Days, GHL_STAGES_DEFAULTS.staleTier1Days, 3, 90),
    allowNurtureTrigger: o.allowNurtureTrigger === true,
    maxMovesPerRun: n(o.maxMovesPerRun, GHL_STAGES_DEFAULTS.maxMovesPerRun, 1, 300),
    tier2Repliers: o.tier2Repliers === true,
  };
}

// Stage names as GHL has them ("Tier 1 - Hot/Actionable, Active Deal"). The
// old ones stay readable so the migration can find the cards still in them.
const STAGE_RX = {
  newLead: /^new lead\b/i,
  contacted: /^contacted\b/i,
  tier1: /^tier\s*1\b/i,
  tier2: /^tier\s*2\b/i,
  tier3: /^tier\s*3\b/i,
  offerOut: /^offer out\b/i,
  negotiations: /^negotiations?\b/i,
  passed: /^passed on offer\b/i,
  notGood: /^not a good deal\b/i,
  contractSigned: /^contract signed\b/i,
  contractSent: /^contract sent\b/i,
  lost: /^lost\b/i,
};

/** The four stages the pipeline keeps, lowest first. */
export const CARD_STAGES = Object.freeze(["tier2", "tier1", "offerOut", "contract"]);
export const CARD_STAGE_LABEL = Object.freeze({ tier2: "Tier 2", tier1: "Tier 1", offerOut: "Offer Out", contract: "Contract" });
/** Stages that go away (Matt deletes them in GHL once they're empty). */
export const OLD_STAGES = Object.freeze(["newLead", "contacted", "tier3", "negotiations", "passed", "notGood", "contractSent", "lost"]);

// A card move within this long of a move the app recorded (ghl_stage_moved:
// this planner, the migration, the Tier 1 list) is the app's own, not a
// person's. A GHL workflow the bot enrolled them in is not counted: TIER 2 on
// a no ("she's listing next week") was the conversation's own read, and the
// planner must not drag that card back up on an unsent number.
export const APP_MOVE_SLACK_MS = 10 * 60000;

// A held underwrite counts as a house in hand this long (shared/tiers.js
// HELD_DAYS) — the outer bound. Inside it, the card follows the thread: see
// targetStage's `staleDays`.
export const HELD_DAYS = 21;

/** stageKeys(acq) → { key: stageId } for the stages this knows, by name. `contract` is Contract Signed, else Contract Sent. */
export function stageKeys(acq) {
  const out = {};
  for (const s of acq?.stages || []) {
    const name = String(s?.name || "").trim();
    for (const [k, rx] of Object.entries(STAGE_RX)) if (!out[k] && rx.test(name)) out[k] = s.id;
  }
  // With both, Contract Signed is the one kept and Contract Sent goes away.
  const contract = out.contractSigned || out.contractSent;
  if (contract) out.contract = contract;
  return out;
}

/** stageKeyOf(keys, stageId) → "tier1" | "tier2" | "offerOut" | "contract" | an old key | null */
export function stageKeyOf(keys, stageId) {
  if (!stageId) return null;
  for (const k of CARD_STAGES) if (keys[k] === stageId) return k;
  for (const k of OLD_STAGES) if (keys[k] === stageId) return k;
  return null;
}

// Rank: what wins when an agent has more than one house. A closed deal sits
// below anything live, so a new house reopens the relationship.
const RANK = { contract: 5, offerOut: 4, tier1: 3, won: 2, tier2: 1 };

/**
 * targetStage({ offers, now, lastIn, staleDays }) → { to: "contract"|"offerOut"|"tier1"|"tier2"|null, won, why, at, offerId }
 *
 * `offers` are the agent's rows (lean is fine), drafts included. Superseded
 * rows don't count. `at` is the newest offer event across their current rows
 * (offerStageAt). `to` is null when the agent has no offers at all.
 *
 * A house we priced and never sent (a held draft, or a `new` row) is Tier 1
 * only while it's live: something happened on the offer in the last
 * `staleDays` (ghlStages.staleTier1Days, 10). After that it's Tier 2 —
 * Matt, 2026-10-14: Eric B. sat in Tier 1 for 55 days on an August row that
 * never went out, and Cheryl P. on a duplicate of a house we'd passed on.
 * Their texts about something else don't keep a number alive: a re-run, a
 * float or a send is what does. `lastIn` is accepted and unused here.
 */
export function targetStage({ offers = [], now = Date.now(), lastIn = null, staleDays = GHL_STAGES_DEFAULTS.staleTier1Days } = {}) {
  const rows = annotateCurrent((offers || []).filter(Boolean)).filter((o) => !o.supersededBy);
  let best = null;
  let at = null;
  const consider = (key, o, why) => {
    if (!best || RANK[key] > RANK[best.key]) best = { key, offerId: o.id || null, why };
  };
  const live = (t) => t != null && now - t <= staleDays * DAY_MS;
  for (const o of rows) {
    const t = offerStageAt(o);
    if (o.status === "draft") {
      const age = now - (ms(o.createdAt) ?? now);
      if (!o.contactId || age > HELD_DAYS * DAY_MS) continue;
      if (t != null) at = Math.max(at ?? t, t);
      if (live(t)) consider("tier1", o, "a house being priced");
      else consider("tier2", o, `held, and nothing on it in ${staleDays}+ days`);
      continue;
    }
    if (t != null) at = Math.max(at ?? t, t);
    const s = offerStage(o);
    if (s.sub === "accepted") {
      if (o.deal && !LIVE_DEAL_STAGES.has(o.deal.stage)) consider("won", o, "the deal closed");
      else consider("contract", o, "under contract");
    } else if (s.stage === "sent" || s.sub === "countered" || s.sub === "hot") consider("offerOut", o, s.sub ? `responded: ${s.sub}` : s.why);
    else if (s.stage === "draft") {
      if (live(t)) consider("tier1", o, "priced, our number not out yet");
      else consider("tier2", o, `priced but never sent, and nothing on it in ${staleDays}+ days`);
    }
    else consider("tier2", o, `every house passed (${s.why})`);
  }
  if (!best) return { to: null, won: false, why: "no offers", at, offerId: null };
  const won = best.key === "won";
  return { to: won ? "contract" : best.key, won, why: best.why, at, offerId: best.offerId };
}

/**
 * cardHeldBy({ offers, now, staleDays }) → null | { to, label, offerId, address, text }
 *
 * After a pass: the house that keeps the card above Tier 2, in words. Null
 * when nothing does (the card goes to Tier 2). Matt, 2026-10-16 (Toril S.):
 * he passed her house and the card stayed in Tier 1. Her other house, a held
 * draft, kept it there as the rule says, but nothing told him so.
 */
export function cardHeldBy({ offers = [], now = Date.now(), staleDays = GHL_STAGES_DEFAULTS.staleTier1Days } = {}) {
  const t = targetStage({ offers, now, staleDays });
  if (!t.to || t.to === "tier2" || t.won) return null;
  const o = (offers || []).find((x) => x?.id === t.offerId) || null;
  const street = String(o?.address || "").split(",")[0].trim() || "another house";
  const label = CARD_STAGE_LABEL[t.to];
  const because = {
    tier1: o?.status === "draft" ? `${street} is still being priced. Pass that house too and it goes to Tier 2` : `${street} is priced and our number isn't out yet`,
    offerOut: `our number on ${street} is still out`,
    contract: `${street} is under contract`,
  }[t.to];
  return { to: t.to, label, offerId: t.offerId, address: o?.address || "", text: `The GHL card stays in ${label}: ${because}.` };
}

/**
 * planCard({ acq, keys, cards, offers, contactId, name, lastIn, openPromise, nurtureLive, settings, now })
 *   → { move } | { create } | { youMoved } | { skip }
 *
 * One agent. `cards` are their opportunities in the Acquisitions pipeline
 * (pipelineStageId, status, lastStageChangeAt when the read has it — the
 * per-contact search doesn't, and then the newest offer event wins).
 * `replied`: an agent's last word to us (never one who opted out) — the
 * Tier 2 card for a conversation (repliedCard). `cardMade`: the app has
 * made a card for them before.
 */
export function planCard({ acq = null, keys = null, cards = [], offers = [], contactId = "", name = "", lastIn = null, openPromise = false, nurtureLive = [], appMoves = [], replied = null, cardMade = false, settings = {}, now = Date.now() } = {}) {
  const cfg = normalizeGhlStages(settings);
  const k = keys || stageKeys(acq);
  const label = (key) => CARD_STAGE_LABEL[key] || key;
  const nameOf = new Map((acq?.stages || []).map((s) => [s.id, String(s.name || "").trim()]));
  if (!acq?.id) return { skip: "no Acquisitions pipeline" };
  const mine = (cards || []).filter((c) => c && (!c.pipelineId || c.pipelineId === acq.id));
  const open = mine.filter((c) => String(c.status || "open") === "open");
  if (open.length > 1) return { skip: "two open cards — a person's call" };
  const t = targetStage({ offers, now, lastIn, staleDays: cfg.staleTier1Days });
  const base = { contactId, why: t.why };

  // No open card: create one for something live; a lost or abandoned card is reopened instead.
  if (!open.length) {
    if (!t.to || t.to === "tier2" || t.won) {
      const r = cfg.tier2Repliers && replied ? repliedCard({ k, mine, nameOf, contactId, name, replied, cardMade, nurtureLive, cfg }) : null;
      return r || { skip: t.to ? "nothing live and no open card" : "no offers and no open card" };
    }
    if (!k[t.to]) return { skip: `no ${label(t.to)} stage in the Acquisitions pipeline` };
    const closed = mine.filter((c) => !/^won$/i.test(String(c.status || ""))).sort((a, b) => String(b.lastStageChangeAt || b.updatedAt || "").localeCompare(String(a.lastStageChangeAt || a.updatedAt || "")))[0];
    if (closed) return { move: { ...base, opportunityId: closed.id, from: `${nameOf.get(closed.pipelineStageId) || "?"} (${closed.status})`, to: label(t.to), toKey: t.to, toStageId: k[t.to], status: "open" } };
    return { create: { ...base, name: name || "Agent", to: label(t.to), toKey: t.to, toStageId: k[t.to] } };
  }

  const card = open[0];
  const at = stageKeyOf(k, card.pipelineStageId);
  const from = nameOf.get(card.pipelineStageId) || at || card.pipelineStageId;
  // Tier 3 is folded into Tier 2 (Matt, 2026-10-13): a card that still lands
  // there — a GHL workflow, a drag — is moved on, whoever put it there.
  const folded = at === "tier3";
  if (!CARD_STAGES.includes(at) && !folded) return { skip: `in ${from} — the migration moves it`, old: true };

  let to = t.to;
  let why = t.why;
  if (!to && folded) { to = "tier2"; why = "Tier 3 joins Tier 2"; }
  if (!to) {
    // No offers: a Tier 1 card nothing came of goes back to nurture after a while.
    if (at !== "tier1" || openPromise) return { skip: "no offers" };
    const inTier = ms(card.lastStageChangeAt || card.updatedAt || card.dateAdded);
    const spoke = ms(lastIn);
    const staleMs = cfg.staleTier1Days * DAY_MS;
    if (inTier == null || now - inTier < staleMs || (spoke != null && now - spoke < staleMs)) return { skip: "a new Tier 1 card, nothing priced yet" };
    to = "tier2";
    why = `nothing priced and nothing from them in ${cfg.staleTier1Days}+ days`;
  }
  if (!k[to]) return { skip: `no ${label(to)} stage in the Acquisitions pipeline` };

  // Newest wins: a person moved the card after the last thing the offers did.
  // A move the app made — this planner, the one-time migration, the Tier 1
  // list, or a GHL workflow the bot enrolled them in — is not a person's: on
  // 2026-10-14 Eric B. and Korey P. read "you moved it" off the
  // migration's own move into Tier 1, so nothing could ever take them out.
  const cardAt = ms(card.lastStageChangeAt);
  const appMade = cardAt != null && (appMoves || []).some((x) => { const m = ms(x); return m != null && Math.abs(m - cardAt) <= APP_MOVE_SLACK_MS; });
  if (!folded && !appMade && t.to && cardAt != null && t.at != null && cardAt > t.at && (to !== at || t.won)) {
    return { youMoved: { ...base, opportunityId: card.id, from, wanted: label(to) } };
  }
  if (to === at) {
    if (t.won) return { move: { ...base, opportunityId: card.id, from, to: label(to), toKey: to, toStageId: k[to], status: "won", why: "the deal closed" } };
    return { skip: `already in ${from}` };
  }
  const move = { ...base, why, opportunityId: card.id, from, to: label(to), toKey: to, toStageId: k[to], ...(t.won ? { status: "won" } : {}) };
  if (to === "tier2" && (nurtureLive || []).length && !cfg.allowNurtureTrigger) {
    move.blocked = `${nurtureLive.map((w) => w.name).join(", ")} is published and would text them on this move`;
  }
  return { move };
}

/**
 * repliedCard(…) → { create } | { move } | { skip } | null
 *
 * An agent we've talked with and have nothing live for, with no open card,
 * goes in Tier 2: that's where Matt looks for who to follow up with (Matt,
 * 2026-10-16, Deanna W.: "no fixers right now, I'll call when I have one" —
 * no offer, so no card, and nothing in GHL said to check in). The create and
 * the reopen carry `replier: true` so a runner can put them behind the
 * offers' own moves.
 *   - their newest card is closed: reopened in Tier 2 only when they wrote
 *     after it was closed (whoever closed it had seen the conversation);
 *     lost is a person's call and stays lost; won stays won and a word since
 *     makes a new card;
 *   - no card at all, but the app made one before: someone deleted it, and it
 *     stays deleted (Tyler E., 2026-10-15). It also keeps a card GHL's search
 *     hasn't caught up with yet from being made twice.
 */
function repliedCard({ k, mine, nameOf, contactId, name, replied, cardMade, nurtureLive, cfg }) {
  if (!k.tier2) return null;
  const why = "they wrote back, nothing live";
  const blocked = (nurtureLive || []).length && !cfg.allowNurtureTrigger
    ? { blocked: `${nurtureLive.map((w) => w.name).join(", ")} is published and would text them on this move` } : {};
  const closedAt = (c) => ms(c.lastStatusChangeAt || c.updatedAt || c.lastStageChangeAt);
  const last = [...mine].sort((a, b) => (closedAt(b) ?? 0) - (closedAt(a) ?? 0))[0];
  if (last) {
    const status = String(last.status || "");
    if (/^lost$/i.test(status)) return { skip: "their card is marked lost — a person's call" };
    const at = closedAt(last);
    if (at != null && !((ms(replied) ?? 0) > at)) return { skip: `their card was closed (${status}) after their last word` };
    if (!/^won$/i.test(status)) {
      return { move: { contactId, why, opportunityId: last.id, from: `${nameOf.get(last.pipelineStageId) || "?"} (${status})`, to: CARD_STAGE_LABEL.tier2, toKey: "tier2", toStageId: k.tier2, status: "open", replier: true, ...blocked } };
    }
  } else if (cardMade) return { skip: "the card the app made for them is gone; a deleted card stays deleted" };
  return { create: { contactId, why, name: name || "", to: CARD_STAGE_LABEL.tier2, toKey: "tier2", toStageId: k.tier2, replier: true, ...blocked } };
}

/**
 * planStageMoves({ acq, opportunities, offers, lastIn, openPromiseContacts, nurtureLive, settings, now })
 *   → { moves, creates, youMoved, counts }
 *
 *   opportunities        GHL search rows in the pipeline ({ id, contactId, pipelineStageId, status, lastStageChangeAt, contact })
 *   offers               the book's lean rows, drafts included
 *   lastIn               Map contactId → ISO of their last word
 *   openPromiseContacts  Set of contactIds we owe a number or an answer
 *   nurtureLive          [{ id, name }] published nurture workflows a Tier 2 move would start
 *   appMoves             Map contactId → [ISO] of card moves the app made (ghl_stage_moved; APP_MOVE_SLACK_MS)
 *   repliers             Map contactId → ISO of an agent's last word (opt-outs left out): Tier 2 cards, with tier2Repliers
 *   cardsMade            Set of contactIds the app has made a card for
 */
export function planStageMoves({ acq = null, opportunities = [], offers = [], lastIn = new Map(), openPromiseContacts = new Set(), nurtureLive = [], appMoves = new Map(), repliers = new Map(), cardsMade = new Set(), settings = {}, now = Date.now() } = {}) {
  const counts = { considered: 0, planned: 0, blocked: 0, created: 0, youMoved: 0, old: 0, tier2Repliers: 0, byMove: {} };
  const out = { moves: [], creates: [], youMoved: [], counts };
  if (!acq?.id) return out;
  const keys = stageKeys(acq);
  const offersBy = new Map();
  for (const o of offers || []) { if (!o?.contactId) continue; if (!offersBy.has(o.contactId)) offersBy.set(o.contactId, []); offersBy.get(o.contactId).push(o); }
  const cardsBy = new Map();
  for (const o of opportunities || []) {
    if (o?.pipelineId && o.pipelineId !== acq.id) continue;
    if (!o?.contactId) continue;
    if (!cardsBy.has(o.contactId)) cardsBy.set(o.contactId, []);
    cardsBy.get(o.contactId).push(o);
  }
  const withRepliers = normalizeGhlStages(settings).tier2Repliers;
  const contacts = new Set([...cardsBy.keys(), ...offersBy.keys(), ...(withRepliers ? repliers?.keys?.() || [] : [])]);
  for (const contactId of contacts) {
    counts.considered++;
    const mineOffers = offersBy.get(contactId) || [];
    const name = mineOffers.find((o) => o.contactName)?.contactName || "";
    const r = planCard({ acq, keys, cards: cardsBy.get(contactId) || [], offers: mineOffers, contactId, name,
      lastIn: lastIn?.get?.(contactId) || null, openPromise: openPromiseContacts?.has?.(contactId) || false, nurtureLive,
      appMoves: appMoves?.get?.(contactId) || [], replied: repliers?.get?.(contactId) || null, cardMade: cardsMade?.has?.(contactId) || false, settings, now });
    if (r.old) counts.old++;
    if (r.youMoved) { counts.youMoved++; out.youMoved.push(r.youMoved); continue; }
    if (r.create?.replier || r.move?.replier) counts.tier2Repliers++;
    if (r.create) { if (r.create.blocked) counts.blocked++; else counts.created++; out.creates.push(r.create); continue; }
    if (!r.move) continue;
    if (r.move.blocked) counts.blocked++; else counts.planned++;
    const key = `${r.move.from}→${r.move.to}${r.move.status === "won" ? " (won)" : ""}`;
    counts.byMove[key] = (counts.byMove[key] || 0) + 1;
    out.moves.push(r.move);
  }
  return out;
}

/**
 * boardCounts({ acq, opportunities }) → { tier2, tier1, offerOut, contract, old, closed }
 *
 * Open cards per kept stage; `old` is every open card still in a stage that's going away.
 */
export function boardCounts({ acq = null, opportunities = [] } = {}) {
  const out = { tier2: 0, tier1: 0, offerOut: 0, contract: 0, old: 0, closed: 0 };
  if (!acq?.id) return out;
  const keys = stageKeys(acq);
  for (const o of opportunities || []) {
    if (o?.pipelineId && o.pipelineId !== acq.id) continue;
    if (String(o.status || "open") !== "open") { out.closed++; continue; }
    const k = stageKeyOf(keys, o.pipelineStageId);
    if (CARD_STAGES.includes(k)) out[k]++;
    else out.old++;
  }
  return out;
}

/* ---------- the one-time move off the old stages ---------- */

/**
 * planMigration({ acq, opportunities, offers, replied, nurtureLive, settings, now })
 *   → { moves: [{ contactId, opportunityId, from, to, toStageId, status?, why, blocked? }], manual: [{ contactId, why }], counts }
 *
 * Every card still in a stage that goes away (New Lead, Contacted, Tier 3,
 * Negotiations, Passed on Offer, Not a Good Deal, Contract Sent when Contract
 * Signed is kept, Lost) lands in one of the four, by the facts (Matt,
 * 2026-10-13: "map by facts"):
 *   - with offers: where targetStage puts them (a closed deal → Contract, won)
 *   - no offers, they've written to us (`replied` has them) → Tier 2
 *   - Tier 3 with nothing live → Tier 2, open, replied or not (Matt,
 *     2026-10-13: "Tier 2 should combine all the previous tier 3's")
 *   - any other old stage, no offers, never replied → Tier 2 with the card
 *     closed as abandoned; they stay in outreach
 * A closed card keeps its status and goes to Tier 2, so the old stage empties.
 * Two open cards on a contact are listed for a person, not moved.
 */
export function planMigration({ acq = null, opportunities = [], offers = [], replied = new Set(), nurtureLive = [], settings = {}, now = Date.now() } = {}) {
  const cfg = normalizeGhlStages(settings);
  const counts = { old: 0, planned: 0, blocked: 0, manual: 0, closed: 0, byMove: {} };
  const out = { moves: [], manual: [], counts };
  if (!acq?.id) return out;
  const keys = stageKeys(acq);
  if (!keys.tier1 || !keys.tier2) return out;
  const nameOf = new Map((acq.stages || []).map((s) => [s.id, String(s.name || "").trim()]));
  const offersBy = new Map();
  for (const o of offers || []) { if (!o?.contactId) continue; if (!offersBy.has(o.contactId)) offersBy.set(o.contactId, []); offersBy.get(o.contactId).push(o); }
  const cardsBy = new Map();
  for (const c of opportunities || []) {
    if (!c?.contactId || (c.pipelineId && c.pipelineId !== acq.id)) continue;
    if (!cardsBy.has(c.contactId)) cardsBy.set(c.contactId, []);
    cardsBy.get(c.contactId).push(c);
  }
  const isOld = (c) => !CARD_STAGES.includes(stageKeyOf(keys, c.pipelineStageId));
  for (const [contactId, cards] of cardsBy) {
    const old = cards.filter(isOld);
    if (!old.length) continue;
    counts.old += old.length;
    const open = cards.filter((c) => String(c.status || "open") === "open");
    if (open.length > 1 && open.some(isOld)) { counts.manual++; out.manual.push({ contactId, why: "two open cards — a person's call" }); }
    const t = targetStage({ offers: offersBy.get(contactId) || [], now });
    for (const c of old) {
      const from = nameOf.get(c.pipelineStageId) || c.pipelineStageId;
      const status = String(c.status || "open");
      let to, why, newStatus = null;
      if (status !== "open") {
        counts.closed++;
        to = /^won$/i.test(status) && keys.contract ? "contract" : "tier2";
        why = `closed (${status}): out of the old stage`;
      } else if (open.length > 1) continue;
      else if (t.to) {
        to = t.to; why = t.why;
        if (t.won) newStatus = "won";
      } else if (replied.has(contactId)) { to = "tier2"; why = "replied, nothing live"; }
      else if (stageKeyOf(keys, c.pipelineStageId) === "tier3") { to = "tier2"; why = "Tier 3 joins Tier 2"; }
      else { to = "tier2"; newStatus = "abandoned"; why = "never replied: card closed, they stay in outreach"; }
      if (!keys[to]) continue;
      const move = { contactId, opportunityId: c.id, from, to: CARD_STAGE_LABEL[to], toStageId: keys[to], why, ...(newStatus ? { status: newStatus } : {}) };
      // Any card landing in Tier 2 — open or closed — could fire a stage-change
      // trigger in GHL, so none moves there while a nurture is published.
      if (to === "tier2" && (nurtureLive || []).length && !cfg.allowNurtureTrigger) {
        move.blocked = `${nurtureLive.map((w) => w.name).join(", ")} is published and would text them on this move`;
        counts.blocked++;
      } else counts.planned++;
      const k = `${from}→${move.to}${newStatus ? ` (${newStatus})` : ""}`;
      counts.byMove[k] = (counts.byMove[k] || 0) + 1;
      out.moves.push(move);
    }
  }
  return out;
}
