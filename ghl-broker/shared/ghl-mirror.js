// AUTO-GENERATED COPY of /shared — do NOT edit here.
// Edit /shared/<file> then run: node scripts/sync-shared.mjs

// ghl-mirror.js — the app's pipeline, projected onto GHL's Opportunities.
//
// The board in shared/pipeline.js is the truth; nothing in GHL moves a card.
// But a blank Opportunities board in GHL means anyone looking there — a
// partner, a VA, Matt on his phone — sees nothing. This is the digest: one
// opportunity per property per side, in whichever GHL pipeline and stage
// the operator mapped each lane to. One way, best effort, like the custom
// fields.
//
// Pure: given an offer and the mapping, say where it belongs. The broker
// does the reading and the writing.

import { laneFor } from "./pipeline.js";

export const ACQ_LANES = ["ready", "floated", "sent", "countered", "needs_review"];
export const DISPO_STAGES = ["under_contract", "buyer_found", "assigned", "closed", "fell_through"];
// Where a dead acquisition goes: an optional stage, else the opportunity is
// simply marked lost in whatever stage it last sat.
export const ACQ_TERMINAL = ["dead", "won"];

// The agent's tier, as the Acquisitions pipeline in GHL actually reads:
// Tier 1 (has a deal / new property), Tier 2 (open to investors), Tier 3
// (passed / no fit). A property of the AGENT, kept as tags the Conversation
// AI's rules write. In "tiers" mode the acquisitions side is one
// opportunity per agent in the stage their tier maps to.
export const TIER_TAGS = ["tier-1", "tier-2", "tier-3"];
export const TIER_KEYS = [...TIER_TAGS, "none"];
export const ACQ_MODES = ["tiers", "lanes"];

export const MIRROR_DEFAULTS = Object.freeze({
  enabled: false,
  // mode "tiers": one opportunity per AGENT, stage = their tier (stages keyed
  // tier-1 / tier-2 / tier-3 / none). mode "lanes": one per PROPERTY, stage =
  // the board's lane (stages keyed ready / floated / …).
  acquisitions: { mode: "tiers", pipelineId: "", pipelineName: "", stages: {} },
  dispositions: { pipelineId: "", pipelineName: "", stages: {} },   // stage → stageId
  valueField: "cash",   // what monetaryValue carries on the agent side: our cash offer
});

const str = (v, max = 80) => String(v == null ? "" : v).trim().slice(0, max);

export function normalizeMirror(v = {}) {
  const o = v && typeof v === "object" ? v : {};
  const side = (s, keys) => {
    const x = s && typeof s === "object" ? s : {};
    const stages = {};
    for (const k of keys) if (x.stages?.[k]) stages[k] = str(x.stages[k]);
    return { pipelineId: str(x.pipelineId), pipelineName: str(x.pipelineName, 120), stages };
  };
  const acqMode = ACQ_MODES.includes(o.acquisitions?.mode) ? o.acquisitions.mode : "tiers";
  return {
    enabled: o.enabled === true,
    acquisitions: { mode: acqMode, ...side(o.acquisitions, acqMode === "tiers" ? TIER_KEYS : [...ACQ_LANES, ...ACQ_TERMINAL]) },
    dispositions: side(o.dispositions, DISPO_STAGES),
    valueField: o.valueField === "none" ? "none" : "cash",
  };
}

/**
 * mirrorPlan({ offer, config }) → { acquisitions?: target, dispositions?: target }
 *
 *   target = { pipelineId, stageId, status: open|won|lost, name, value }
 *
 * A side is present only when its pipeline is mapped and the offer has
 * something to say there. A deal keeps its acquisitions opportunity (won)
 * and gains a dispositions one.
 */
export function mirrorPlan({ offer, config } = {}) {
  const c = normalizeMirror(config);
  if (!c.enabled || !offer?.id) return {};
  const placed = laneFor(offer);
  if (!placed) return {};
  const out = {};
  const name = String(offer.address || offer.contactName || offer.id).slice(0, 150);
  const value = c.valueField === "none" ? 0 : Math.round(Number(offer.cashAmount) || 0);

  const acq = c.acquisitions;
  // In tiers mode the acquisitions side belongs to the agent (agentPlan),
  // not the property.
  if (acq.pipelineId && acq.mode !== "tiers") {
    if (placed.side === "agent") {
      const dead = placed.lane === "dead";
      const stageId = dead ? (acq.stages.dead || null) : (acq.stages[placed.lane] || null);
      // An unmapped live lane means "leave the stage alone" — only the
      // status is written when a stage can't be named.
      out.acquisitions = { pipelineId: acq.pipelineId, stageId, status: dead ? "lost" : "open", name, value };
    } else {
      out.acquisitions = { pipelineId: acq.pipelineId, stageId: acq.stages.won || null, status: "won", name, value };
    }
  }
  const dis = c.dispositions;
  if (dis.pipelineId && placed.side === "dispo") {
    const stage = placed.lane === "dead" ? "fell_through" : placed.lane;
    const status = stage === "closed" ? "won" : stage === "fell_through" ? "lost" : "open";
    const d = offer.deal || {};
    const dealValue = Math.round((Number(d.contractPrice) || 0) + (Number(d.assignmentFee) || 0)) || value;
    out.dispositions = { pipelineId: dis.pipelineId, stageId: dis.stages[stage] || null, status, name, value: dealValue };
  }
  return out;
}

/**
 * mirrorDiff(current, target) → true when GHL needs a write.
 * `current` is what the offer remembers writing last time.
 */
export function mirrorDiff(current, target) {
  if (!target) return false;
  if (!current?.id) return true;
  return current.pipelineId !== target.pipelineId
    || (target.stageId && current.stageId !== target.stageId)
    || current.status !== target.status
    || Math.round(Number(current.value) || 0) !== Math.round(Number(target.value) || 0);
}

/* ---------- the agent's tier ---------- */

const TIER_RANK = { "tier-1": 3, "tier-2": 2, "tier-3": 1 };
const tagKey = (t) => String(t || "").trim().toLowerCase();

/**
 * tierFrom({ tags, events, ghlSeenAt, hasLiveDeal }) → "tier-1" | "tier-2" | "tier-3" | "none"
 *
 * The truth for an agent's tier, assembled the way the record is: the tags
 * GHL showed us last (the snapshot on the profile), with every tag the app
 * added or removed SINCE that snapshot replayed on top — the app writes
 * tier tags through its actions and records each as an event, so a tier
 * moved a minute ago is right even before GHL is read again. When more
 * than one tier tag is present, the highest wins. A live deal on any of
 * their properties is Tier 1 whatever the tags say.
 */
export function tierFrom({ tags = [], events = [], ghlSeenAt = null, hasLiveDeal = false } = {}) {
  if (hasLiveDeal) return "tier-1";
  const set = new Set((tags || []).map(tagKey).filter((t) => TIER_RANK[t]));
  const since = ghlSeenAt ? Date.parse(ghlSeenAt) : 0;
  const replay = (events || [])
    .filter((e) => (e.type === "tag_added" || e.type === "tag_removed") && TIER_RANK[tagKey(e.data?.tag)])
    .filter((e) => !since || Date.parse(e.at) > since)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const e of replay) {
    const t = tagKey(e.data.tag);
    if (e.type === "tag_added") set.add(t); else set.delete(t);
  }
  let best = "none";
  for (const t of set) if (best === "none" || TIER_RANK[t] > TIER_RANK[best]) best = t;
  return best;
}

/**
 * agentPlan({ contactId, name, tier, openOffers, config }) → target | null
 *
 * The agent-level acquisitions opportunity in tiers mode. Stage = the tier's
 * mapped stage ("none" may map too, for agents we're working with no tier
 * yet); an unmapped tier plans nothing. Status is open — won and lost live
 * on the deal side. Value: the newest open offer's cash number, so the
 * board's dollar column means something.
 */
export function agentPlan({ contactId, name = "", tier = "none", openOffers = [], config } = {}) {
  const c = normalizeMirror(config);
  const acq = c.acquisitions;
  if (!c.enabled || acq.mode !== "tiers" || !acq.pipelineId || !contactId) return null;
  const stageId = acq.stages[tier] || null;
  if (!stageId) return null;
  const newest = [...openOffers].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
  const value = c.valueField === "none" ? 0 : Math.round(Number(newest?.cashAmount) || 0);
  const label = String(name || contactId).slice(0, 120);
  return { pipelineId: acq.pipelineId, stageId, status: "open", name: label, value, tier };
}
