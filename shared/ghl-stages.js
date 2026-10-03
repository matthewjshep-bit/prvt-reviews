// ghl-stages.js — GHL's Acquisitions cards follow the app, so nobody drags them.
//
// Matt, 2026-10-02: part of his daily walk through GHL's Tier 1 stage was
// moving cards and tags by hand. On that day 9 of the 28 Tier 1 agents had
// nothing live in the app, and offers that had gone out still sat in Tier
// 1/2/3. The app knows where each agent stands; this plans the card moves
// that say so:
//
//   Tier 1/2/3, New Lead, Contacted → Offer Out    our number or our paper went out
//   anything before Negotiations    → Negotiations they countered, or it's hot
//   Offer Out / Negotiations        → Passed on Offer   every house they had passed / went quiet
//                                   → Not a Good Deal   we passed on every house
//   Tier 1 (≥ staleTier1Days there) → Tier 2       nothing open, no deal, no promise, nothing
//                                                  from them in that long
//
// Never: a contract stage, a closed or lost card, an agent with two open
// cards, a live deal's card, or any move into Tier 2/3 while a published
// "Tier 2+3 nurture" workflow would text them on the stage change (unless
// `allowNurtureTrigger`). The whole thing ships OFF (`ghlStages.mode`), and
// every night's plan is kept on the tier check's cursor as a report.
//
// Pure. The runner (ghl-broker/tier-check.js) reads GHL and the book.

import { annotateCurrent } from "./current-offer.js";
import { effectiveStatus, isHot, OPEN_STATUSES, LIVE_DEAL_STAGES } from "./offer-status.js";

const DAY_MS = 86400000;
const ms = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

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

// Stage names as GHL has them ("Tier 1 - Hot/Actionable, Active Deal").
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
  contract: /^contract (?:sent|signed)\b/i,
  lost: /^lost\b/i,
};
const BEFORE_OFFER = new Set(["newLead", "contacted", "tier1", "tier2", "tier3"]);
const IN_FLIGHT = new Set(["offerOut", "negotiations"]);
const NURTURE_STAGES = new Set(["tier2", "tier3"]);

/** stageKeys(acq) → { key: stageId } for the stages this knows, by name. */
export function stageKeys(acq) {
  const out = {};
  for (const s of acq?.stages || []) {
    const name = String(s?.name || "").trim();
    for (const [k, rx] of Object.entries(STAGE_RX)) if (!out[k] && rx.test(name)) out[k] = s.id;
  }
  return out;
}

/**
 * planStageMoves({ acq, opportunities, offers, lastIn, openPromiseContacts, nurtureLive, settings, now })
 *   → { moves: [{ contactId, opportunityId, from, to, toStageId, why, blocked? }], counts }
 *
 *   acq                  the Acquisitions pipeline ({ id, stages: [{ id, name }] })
 *   opportunities        GHL search rows in it ({ id, contactId, pipelineId, pipelineStageId, status, lastStageChangeAt })
 *   offers               the book's lean rows
 *   lastIn               Map contactId → ISO of their last word
 *   openPromiseContacts  Set of contactIds we owe a number or an answer
 *   nurtureLive          [{ id, name }] published nurture workflows a Tier 2/3 move would start
 */
export function planStageMoves({ acq = null, opportunities = [], offers = [], lastIn = new Map(), openPromiseContacts = new Set(), nurtureLive = [], settings = {}, now = Date.now() } = {}) {
  const cfg = normalizeGhlStages(settings);
  const keys = stageKeys(acq);
  const keyOf = new Map(Object.entries(keys).map(([k, id]) => [id, k]));
  const nameOf = new Map((acq?.stages || []).map((s) => [s.id, String(s.name || "").trim()]));
  const counts = { considered: 0, planned: 0, blocked: 0, byMove: {} };
  if (!acq?.id) return { moves: [], counts };

  const current = annotateCurrent((offers || []).filter(Boolean)).filter((o) => !o.supersededBy && o.status !== "draft");
  const offersBy = new Map();
  for (const o of current) { if (!o.contactId) continue; if (!offersBy.has(o.contactId)) offersBy.set(o.contactId, []); offersBy.get(o.contactId).push(o); }
  const heldBy = new Set((offers || []).filter((o) => o?.status === "draft" && o.contactId).map((o) => o.contactId));

  const cardsBy = new Map();
  for (const o of opportunities || []) {
    if (o?.pipelineId !== acq.id || !o.contactId || String(o.status || "open") !== "open") continue;
    if (!cardsBy.has(o.contactId)) cardsBy.set(o.contactId, []);
    cardsBy.get(o.contactId).push(o);
  }

  const moves = [];
  for (const [contactId, cards] of cardsBy) {
    counts.considered++;
    if (cards.length !== 1) continue;              // two open cards: whose truth? a person's
    const card = cards[0];
    const at = keyOf.get(card.pipelineStageId);
    if (!at || at === "contract" || at === "lost") continue;
    const mine = offersBy.get(contactId) || [];
    if (mine.some((o) => o.deal && LIVE_DEAL_STAGES.has(o.deal.stage))) continue;
    const st = mine.map((o) => ({ o, s: effectiveStatus(o) }));
    const hotOrCountered = st.some(({ o, s }) => s === "countered" || (OPEN_STATUSES.has(s) && isHot(o)));
    const out = st.some(({ o, s }) => s === "sent" || (s === "new" && Boolean(o.proactive?.takeCheckAt || o.proactive?.realmCheckAt)) || ((o.sends || []).length > 0 && OPEN_STATUSES.has(s)));
    const open = st.some(({ s }) => OPEN_STATUSES.has(s));
    const allDead = st.length > 0 && !open;
    const weAllPassed = allDead && st.every(({ s }) => s === "we_passed");

    let to = null, why = "";
    if (hotOrCountered && at !== "negotiations" && (BEFORE_OFFER.has(at) || at === "offerOut")) { to = "negotiations"; why = "they countered, or it's hot"; }
    else if (out && !hotOrCountered && BEFORE_OFFER.has(at)) { to = "offerOut"; why = "our number went out"; }
    else if (allDead && IN_FLIGHT.has(at)) { to = weAllPassed ? "notGood" : "passed"; why = weAllPassed ? "we passed on every house" : "every house they had is passed or quiet"; }
    else if (at === "tier1" && !open && !heldBy.has(contactId) && !openPromiseContacts.has(contactId)) {
      const inTier = ms(card.lastStageChangeAt || card.updatedAt || card.dateAdded);
      const spoke = ms(lastIn.get?.(contactId));
      const staleMs = cfg.staleTier1Days * DAY_MS;
      if (inTier != null && now - inTier >= staleMs && (spoke == null || now - spoke >= staleMs)) { to = "tier2"; why = `nothing open and nothing from them in ${cfg.staleTier1Days}+ days`; }
    }
    if (!to || !keys[to]) continue;
    const move = { contactId, opportunityId: card.id, from: nameOf.get(card.pipelineStageId) || at, to: nameOf.get(keys[to]) || to, toStageId: keys[to], why };
    if (NURTURE_STAGES.has(to) && nurtureLive.length && !cfg.allowNurtureTrigger) {
      move.blocked = `${nurtureLive.map((w) => w.name).join(", ")} is published and would text them on this move`;
      counts.blocked++;
    } else counts.planned++;
    counts.byMove[`${at}→${to}`] = (counts.byMove[`${at}→${to}`] || 0) + 1;
    moves.push(move);
  }
  return { moves, counts };
}
