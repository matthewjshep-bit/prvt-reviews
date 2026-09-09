import test from "node:test";
import assert from "node:assert/strict";
import { mirrorPlan, mirrorDiff, normalizeMirror } from "./ghl-mirror.js";

const cfg = { enabled: true,
  acquisitions: { pipelineId: "pA", stages: { ready: "s-ready", floated: "s-float", sent: "s-sent", countered: "s-counter", dead: "s-dead", won: "s-won" } },
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
  const partial = mirrorPlan({ offer: offer({ status: "countered" }), config: { ...cfg, acquisitions: { pipelineId: "pA", stages: { ready: "s-ready" } } } }).acquisitions;
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
  const n = normalizeMirror({ enabled: "true", acquisitions: { pipelineId: " pA ", stages: { ready: "s1", bogus: "x" } } });
  assert.equal(n.enabled, false);
  assert.deepEqual(n.acquisitions.stages, { ready: "s1" });
  assert.equal(n.valueField, "cash");
});
