// ghl-calls.test.mjs — Today's calls in GHL's Manual Actions: the setting.

import test from "node:test";
import assert from "node:assert/strict";
import { workflowIdFrom, normalizeGhlCalls, ghlCallsOn, ghlCallWindow, GHL_CALLS_DEFAULTS } from "./ghl-calls.js";

test("a workflow id is read from the id or the builder link", () => {
  assert.equal(workflowIdFrom("7f1c2a9e-0b3d-4e5f-8a6b-1c2d3e4f5a6b"), "7f1c2a9e-0b3d-4e5f-8a6b-1c2d3e4f5a6b");
  assert.equal(workflowIdFrom(" https://app.gohighlevel.com/location/loc123/workflow/7f1c2a9e-0b3d-4e5f-8a6b-1c2d3e4f5a6b?tab=builder "), "7f1c2a9e-0b3d-4e5f-8a6b-1c2d3e4f5a6b");
  assert.equal(workflowIdFrom("https://example.com/nope"), "");
  assert.equal(workflowIdFrom(""), "");
  assert.equal(workflowIdFrom(null), "");
});

test("calls go to GHL only switched on and with a workflow", () => {
  assert.equal(ghlCallsOn(normalizeGhlCalls({})), false);
  assert.equal(ghlCallsOn(normalizeGhlCalls({ enabled: true })), false, "no workflow, nothing to put them in");
  assert.equal(ghlCallsOn(normalizeGhlCalls({ workflowId: "wf-abc123" })), false, "a workflow but switched off");
  assert.equal(ghlCallsOn(normalizeGhlCalls({ enabled: true, workflowId: "wf-abc123" })), true);
  assert.equal(GHL_CALLS_DEFAULTS.enabled, false);
});

test("the window runs from 8:30 to 5pm by default, and a backwards one still leaves the morning", () => {
  assert.deepEqual(ghlCallWindow({}), { start: 8.5, end: 17 });
  assert.deepEqual(ghlCallWindow({ hour: 9, minute: 0, until: "12:30" }), { start: 9, end: 12.5 });
  assert.deepEqual(ghlCallWindow({ hour: 18, minute: 0, until: "17:00" }), { start: 18, end: 21 });
});
