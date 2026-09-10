import test from "node:test";
import assert from "node:assert/strict";
import { mirrorPlan, mirrorDiff, normalizeMirror, tierFrom, agentPlan } from "./ghl-mirror.js";

const cfg = { enabled: true,
  acquisitions: { mode: "lanes", pipelineId: "pA", stages: { ready: "s-ready", floated: "s-float", sent: "s-sent", countered: "s-counter", dead: "s-dead", won: "s-won" } },
  dispositions: { pipelineId: "pD", stages: { under_contract: "d-uc", buyer_found: "d-bf", assigned: "d-as", closed: "d-closed", fell_through: "d-ft" } } };
const offer = (over = {}) => ({ id: "o1", address: "12 Elm St, Renton, WA", contactId: "c1", cashAmount: 410000, status: "new", createdAt: "2026-09-01T00:00:00Z", ...over });

test("switched off, or a hand-made draft, plans nothing", () => {
  assert.deepEqual(mirrorPlan({ offer: offer(), config: { ...cfg, enabled: false } }), {});
  assert.deepEqual(mirrorPlan({ offer: offer({ status: "draft" }), config: cfg }), {});
});

test("an open offer lands in the acquisitions lane it is in, with our cash number as the value", () => {
  assert.deepEqual(mirrorPlan({ offer: offer(), config: cfg }).acquisitions, { pipelineId: "pA", stageId: "s-ready", status: "open", name: "12 Elm St, Renton, WA", value: 410000 });
  assert.equal(mirrorPlan({ offer: offer({ status: "sent", sends: [{ ts: "2026-09-02T00:00:00Z" }] }), config: cfg }).acquisitions.stageId, "s-sent");
  assert.equal(mirrorPlan({ offer: offer({ proactive: { takeCheckAt: "2026-09-02T00:00:00Z" } }), config: cfg }).acquisitions.stageId, "s-float");
  assert.equal(mirrorPlan({ offer: offer({ status: "countered" }), config: cfg }).acquisitions.stageId, "s-counter");
});

test("a dead offer is lost; an unmapped lane leaves the stage alone", () => {
  const dead = mirrorPlan({ offer: offer({ status: "passed" }), config: cfg }).acquisitions;
  assert.equal(dead.status, "lost");
  assert.equal(dead.stageId, "s-dead");
  const partial = mirrorPlan({ offer: offer({ status: "countered" }), config: { ...cfg, acquisitions: { mode: "lanes", pipelineId: "pA", stages: { ready: "s-ready" } } } }).acquisitions;
  assert.equal(partial.stageId, null);
  assert.equal(partial.status, "open");
});

test("a deal is won on the acquisitions side and open on the dispositions side, valued at the buyer price", () => {
  const p = mirrorPlan({ offer: offer({ status: "accepted", deal: { stage: "buyer_found", contractPrice: 465000, assignmentFee: 30000, stageHistory: [] } }), config: cfg });
  assert.equal(p.acquisitions.status, "won");
  assert.equal(p.acquisitions.stageId, "s-won");
  assert.deepEqual(p.dispositions, { pipelineId: "pD", stageId: "d-bf", status: "open", name: "12 Elm St, Renton, WA", value: 495000 });
  assert.equal(mirrorPlan({ offer: offer({ deal: { stage: "closed" } }), config: cfg }).dispositions.status, "won");
  assert.equal(mirrorPlan({ offer: offer({ deal: { stage: "fell_through" } }), config: cfg }).dispositions.status, "lost");
  // no dispositions pipeline mapped: only the acquisitions side speaks
  const one = mirrorPlan({ offer: offer({ deal: { stage: "under_contract" } }), config: { ...cfg, dispositions: {} } });
  assert.equal(one.dispositions, undefined);
});

test("the diff says when GHL needs a write, and nothing else", () => {
  const t = { pipelineId: "pA", stageId: "s-sent", status: "open", value: 410000 };
  assert.equal(mirrorDiff(null, t), true);
  assert.equal(mirrorDiff({ id: "op1", pipelineId: "pA", stageId: "s-sent", status: "open", value: 410000 }, t), false);
  assert.equal(mirrorDiff({ id: "op1", pipelineId: "pA", stageId: "s-ready", status: "open", value: 410000 }, t), true);
  assert.equal(mirrorDiff({ id: "op1", pipelineId: "pA", stageId: "s-ready", status: "open", value: 410000 }, { ...t, stageId: null }), false, "an unmapped stage never forces a write");
  assert.equal(mirrorDiff({ id: "op1", pipelineId: "pA", stageId: "s-sent", status: "open", value: 400000 }, t), true);
});

test("settings coerce and unknown stage keys are dropped", () => {
  const n = normalizeMirror({ enabled: "true", acquisitions: { mode: "lanes", pipelineId: " pA ", stages: { ready: "s1", bogus: "x" } } });
  assert.equal(n.enabled, false);
  assert.deepEqual(n.acquisitions.stages, { ready: "s1" });
  assert.equal(n.valueField, "cash");
});

/* ---------- tiers ---------- */

test("the tier is the GHL snapshot with the app's later tag moves replayed, highest wins, a live deal is tier 1", () => {
  assert.equal(tierFrom({ tags: ["agent", "tier-3"] }), "tier-3");
  assert.equal(tierFrom({ tags: ["Tier-2", "tier-3"] }), "tier-2", "case-insensitive, highest wins");
  assert.equal(tierFrom({ tags: [] }), "none");
  const seen = "2026-09-10T00:00:00Z";
  const ev = [
    { type: "tag_added", at: "2026-09-09T00:00:00Z", data: { tag: "tier-1" } },   // before the snapshot: already reflected (or not) in tags — ignored
    { type: "tag_added", at: "2026-09-11T00:00:00Z", data: { tag: "tier-1" } },
    { type: "tag_removed", at: "2026-09-11T00:00:01Z", data: { tag: "tier-3" } },
  ];
  assert.equal(tierFrom({ tags: ["tier-3"], events: ev, ghlSeenAt: seen }), "tier-1");
  assert.equal(tierFrom({ tags: ["tier-3"], events: [{ type: "tag_removed", at: "2026-09-12T00:00:00Z", data: { tag: "tier-3" } }], ghlSeenAt: seen }), "none");
  assert.equal(tierFrom({ tags: ["tier-3"], hasLiveDeal: true }), "tier-1");
  // no snapshot date: every event replays
  assert.equal(tierFrom({ tags: [], events: [{ type: "tag_added", at: "2026-01-01T00:00:00Z", data: { tag: "tier-2" } }] }), "tier-2");
});

test("in tiers mode the acquisitions side is one opportunity per agent in the tier's stage, and the property plan has no acquisitions side", () => {
  const tiers = { enabled: true, acquisitions: { mode: "tiers", pipelineId: "pA", stages: { "tier-1": "s1", "tier-2": "s2", "tier-3": "s3" } }, dispositions: { pipelineId: "pD", stages: { under_contract: "d-uc" } } };
  const p = agentPlan({ contactId: "c1", name: "Dana Reyes", tier: "tier-2", openOffers: [{ cashAmount: 300000, createdAt: "2026-09-01" }, { cashAmount: 410000, createdAt: "2026-09-05" }], config: tiers });
  assert.deepEqual(p, { pipelineId: "pA", stageId: "s2", status: "open", name: "Dana Reyes", value: 410000, tier: "tier-2" });
  assert.equal(agentPlan({ contactId: "c1", tier: "none", config: tiers }), null, "an unmapped tier plans nothing");
  assert.equal(agentPlan({ contactId: "c1", tier: "tier-1", config: { ...tiers, acquisitions: { ...tiers.acquisitions, mode: "lanes" } } }), null);
  const prop = mirrorPlan({ offer: offer(), config: tiers });
  assert.equal(prop.acquisitions, undefined, "properties don't go on the tier pipeline");
  const deal = mirrorPlan({ offer: offer({ deal: { stage: "under_contract", contractPrice: 400000, assignmentFee: 20000 } }), config: tiers });
  assert.equal(deal.dispositions.stageId, "d-uc", "the deal side still works per property");
  assert.equal(normalizeMirror({ acquisitions: { mode: "bogus" } }).acquisitions.mode, "tiers", "tiers is the default");
});
