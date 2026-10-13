// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

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
// created for an agent with something live and no card; never just to put
// someone in Tier 2.
//
// Ships OFF (`ghlStages.mode`); the plan is kept every morning as a report.
// Pure. The runners (ghl-broker/tier-check.js) read GHL and the book.

import { annotateCurrent } from "./current-offer.js";
import { offerStage, offerStageAt } from "./offer-stage.js";
import { LIVE_DEAL_STAGES } from "./offer-status.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = typeof v === "number" ? v : Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

export const GHL_STAGES_DEFAULTS = Object.freeze({ mode: "off", staleTier1Days: 10, allowNurtureTrigger: false, maxMovesPerRun: 100 });

/** normalizeGhlStages(v) → { mode: "off"|"on", staleTier1Days, allowNurtureTrigger, maxMovesPerRun } */
export function normalizeGhlStages(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const n = (x, d, lo, hi) => { const k = Math.round(Number(x)); return x == null || x === "" || !Number.isFinite(k) ? d : Math.min(hi, Math.max(lo, k)); };
  return {
    mode: o.mode === "on" ? "on" : "off",
    staleTier1Days: n(o.staleTier1Days, GHL_STAGES_DEFAULTS.staleTier1Days, 3, 90),
    allowNurtureTrigger: o.allowNurtureTrigger === true,
    maxMovesPerRun: n(o.maxMovesPerRun, GHL_STAGES_DEFAULTS.maxMovesPerRun, 1, 300),
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

// A held underwrite counts as a house in hand this long (shared/tiers.js HELD_DAYS).
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
 * targetStage({ offers, now }) → { to: "contract"|"offerOut"|"tier1"|"tier2"|null, won, why, at, offerId }
 *
 * `offers` are the agent's rows (lean is fine), drafts included. Superseded
 * rows don't count. `at` is the newest offer event across their current rows
 * (offerStageAt). `to` is null when the agent has no offers at all.
 */
export function targetStage({ offers = [], now = Date.now() } = {}) {
  const rows = annotateCurrent((offers || []).filter(Boolean)).filter((o) => !o.supersededBy);
  let best = null;
  let at = null;
  const consider = (key, o, why) => {
    if (!best || RANK[key] > RANK[best.key]) best = { key, offerId: o.id || null, why };
  };
  for (const o of rows) {
    const t = offerStageAt(o);
    if (o.status === "draft") {
      const age = now - (ms(o.createdAt) ?? now);
      if (!o.contactId || age > HELD_DAYS * DAY_MS) continue;
      if (t != null) at = Math.max(at ?? t, t);
      consider("tier1", o, "a house being priced");
      continue;
    }
    if (t != null) at = Math.max(at ?? t, t);
    const s = offerStage(o);
    if (s.sub === "accepted") {
      if (o.deal && !LIVE_DEAL_STAGES.has(o.deal.stage)) consider("won", o, "the deal closed");
      else consider("contract", o, "under contract");
    } else if (s.stage === "sent" || s.sub === "countered" || s.sub === "hot") consider("offerOut", o, s.sub ? `responded: ${s.sub}` : s.why);
    else if (s.stage === "draft") consider("tier1", o, "priced, our number not out yet");
    else consider("tier2", o, `every house passed (${s.why})`);
  }
  if (!best) return { to: null, won: false, why: "no offers", at, offerId: null };
  const won = best.key === "won";
  return { to: won ? "contract" : best.key, won, why: best.why, at, offerId: best.offerId };
}

/**
 * planCard({ acq, keys, cards, offers, contactId, name, lastIn, openPromise, nurtureLive, settings, now })
 *   → { move } | { create } | { youMoved } | { skip }
 *
 * One agent. `cards` are their opportunities in the Acquisitions pipeline
 * (pipelineStageId, status, lastStageChangeAt when the read has it — the
 * per-contact search doesn't, and then the newest offer event wins).
 */
export function planCard({ acq = null, keys = null, cards = [], offers = [], contactId = "", name = "", lastIn = null, openPromise = false, nurtureLive = [], settings = {}, now = Date.now() } = {}) {
  const cfg = normalizeGhlStages(settings);
  const k = keys || stageKeys(acq);
  const label = (key) => CARD_STAGE_LABEL[key] || key;
  const nameOf = new Map((acq?.stages || []).map((s) => [s.id, String(s.name || "").trim()]));
  if (!acq?.id) return { skip: "no Acquisitions pipeline" };
  const mine = (cards || []).filter((c) => c && (!c.pipelineId || c.pipelineId === acq.id));
  const open = mine.filter((c) => String(c.status || "open") === "open");
  if (open.length > 1) return { skip: "two open cards — a person's call" };
  const t = targetStage({ offers, now });
  const base = { contactId, why: t.why };

  // No open card: create one for something live; a lost or abandoned card is reopened instead.
  if (!open.length) {
    if (!t.to || t.to === "tier2" || t.won) return { skip: t.to ? "nothing live and no open card" : "no offers and no open card" };
    if (!k[t.to]) return { skip: `no ${label(t.to)} stage in the Acquisitions pipeline` };
    const closed = mine.filter((c) => !/^won$/i.test(String(c.status || ""))).sort((a, b) => String(b.lastStageChangeAt || b.updatedAt || "").localeCompare(String(a.lastStageChangeAt || a.updatedAt || "")))[0];
    if (closed) return { move: { ...base, opportunityId: closed.id, from: `${nameOf.get(closed.pipelineStageId) || "?"} (${closed.status})`, to: label(t.to), toKey: t.to, toStageId: k[t.to], status: "open" } };
    return { create: { ...base, name: name || "Agent", to: label(t.to), toKey: t.to, toStageId: k[t.to] } };
  }

  const card = open[0];
  const at = stageKeyOf(k, card.pipelineStageId);
  const from = nameOf.get(card.pipelineStageId) || at || card.pipelineStageId;
  if (!CARD_STAGES.includes(at)) return { skip: `in ${from} — the migration moves it`, old: true };

  let to = t.to;
  let why = t.why;
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
  const cardAt = ms(card.lastStageChangeAt);
  if (t.to && cardAt != null && t.at != null && cardAt > t.at && (to !== at || t.won)) {
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
 * planStageMoves({ acq, opportunities, offers, lastIn, openPromiseContacts, nurtureLive, settings, now })
 *   → { moves, creates, youMoved, counts }
 *
 *   opportunities        GHL search rows in the pipeline ({ id, contactId, pipelineStageId, status, lastStageChangeAt, contact })
 *   offers               the book's lean rows, drafts included
 *   lastIn               Map contactId → ISO of their last word
 *   openPromiseContacts  Set of contactIds we owe a number or an answer
 *   nurtureLive          [{ id, name }] published nurture workflows a Tier 2 move would start
 */
export function planStageMoves({ acq = null, opportunities = [], offers = [], lastIn = new Map(), openPromiseContacts = new Set(), nurtureLive = [], settings = {}, now = Date.now() } = {}) {
  const counts = { considered: 0, planned: 0, blocked: 0, created: 0, youMoved: 0, old: 0, byMove: {} };
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
  const contacts = new Set([...cardsBy.keys(), ...offersBy.keys()]);
  for (const contactId of contacts) {
    counts.considered++;
    const mineOffers = offersBy.get(contactId) || [];
    const name = mineOffers.find((o) => o.contactName)?.contactName || "";
    const r = planCard({ acq, keys, cards: cardsBy.get(contactId) || [], offers: mineOffers, contactId, name,
      lastIn: lastIn?.get?.(contactId) || null, openPromise: openPromiseContacts?.has?.(contactId) || false, nurtureLive, settings, now });
    if (r.old) counts.old++;
    if (r.youMoved) { counts.youMoved++; out.youMoved.push(r.youMoved); continue; }
    if (r.create) { counts.created++; out.creates.push(r.create); continue; }
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
 *   - no offers, never replied → Tier 2 with the card closed as abandoned;
 *     they stay in outreach
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
      else { to = "tier2"; newStatus = "abandoned"; why = "never replied: card closed, they stay in outreach"; }
      if (!keys[to]) continue;
      const move = { contactId, opportunityId: c.id, from, to: CARD_STAGE_LABEL[to], toStageId: keys[to], why, ...(newStatus ? { status: newStatus } : {}) };
      // Only an open card landing in Tier 2 can start GHL's nurture.
      if (to === "tier2" && status === "open" && newStatus !== "abandoned" && (nurtureLive || []).length && !cfg.allowNurtureTrigger) {
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
