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

export const MIRROR_DEFAULTS = Object.freeze({
  enabled: false,
  acquisitions: { pipelineId: "", pipelineName: "", stages: {} },   // lane → stageId
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
  return {
    enabled: o.enabled === true,
    acquisitions: side(o.acquisitions, [...ACQ_LANES, ...ACQ_TERMINAL]),
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
  if (acq.pipelineId) {
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
