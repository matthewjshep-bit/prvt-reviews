// ghl-calls.test.mjs — Today's calls in GHL's Manual Actions: the setting.

import test from "node:test";
import assert from "node:assert/strict";
import { workflowIdFrom, normalizeGhlCalls, ghlCallsOn, ghlCallWindow, GHL_CALLS_DEFAULTS, callFields, liveGhlQueues, ghlCallClaimKey, CALL_FIELD_MAX } from "./ghl-calls.js";

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

test("the two fields say what the call is for and how to open it, each within 300 characters", () => {
  const row = { kind: "call_counter", contactName: "Pat Agent", address: "12 Elm St, Kent, WA 98030",
    call: { why: "countered 315K on 12 Elm St against our 300K — 5% apart, a call lands it", goal: "Land a number. Never above what we sent without deciding it yourself.", opener: "Hi Pat, it's Matt — got your 315K on 12 Elm St." } };
  const f = callFields(row);
  assert.equal(f.why, "Countered 315K on 12 Elm St against our 300K — 5% apart, a call lands it. Land a number. Never above what we sent without deciding it yourself.");
  assert.equal(f.say, "Hi Pat, it's Matt — got your 315K on 12 Elm St.");
  const long = callFields({ ...row, call: { ...row.call, goal: "x ".repeat(400) } });
  assert.ok(long.why.length <= CALL_FIELD_MAX && long.why.endsWith("…"));
  // A held reply asking to talk has no brief.
  const asked = callFields({ kind: "draft_waiting", contactName: "Pat Agent", title: "Pat Agent: wants walkthrough" },
    { draft: { intent: "wants_walkthrough", propertyAddress: "12 Elm St, Kent, WA 98030" } });
  assert.match(asked.why, /^They want to walk 12 Elm St\. Their text is waiting/);
  assert.equal(asked.say, "Hi Pat, it's Matt — you wanted to talk about 12 Elm St. Is now a good time?");
  // A row with no brief at all: its title.
  assert.equal(callFields({ kind: "call_owed", title: "Owed: a call to Pat on 12 Elm St" }).why, "Owed: a call to Pat on 12 Elm St.");
});

test("who is in GHL's queue: each person's newest claim, unless it failed or was taken back", () => {
  const q = (c, day, at) => ({ type: "ghl_call_queued", contactId: c, at, dedupeKey: ghlCallClaimKey(c, day), data: { kind: "call_hot", workflowId: "wf-abc123" } });
  const events = [
    q("a", "2026-10-14", "2026-10-14T15:30:00Z"), q("a", "2026-10-15", "2026-10-15T15:30:00Z"),
    q("b", "2026-10-15", "2026-10-15T15:30:00Z"), { type: "ghl_call_failed", contactId: "b", at: "2026-10-15T15:31:00Z", data: { claimKey: ghlCallClaimKey("b", "2026-10-15") } },
    q("c", "2026-10-15", "2026-10-15T15:30:00Z"), { type: "ghl_call_withdrawn", contactId: "c", at: "2026-10-15T18:00:00Z", data: { claimKey: ghlCallClaimKey("c", "2026-10-15") } },
  ];
  const live = liveGhlQueues(events);
  assert.deepEqual([...live.keys()], ["a"]);
  assert.deepEqual(live.get("a"), { at: "2026-10-15T15:30:00Z", claimKey: "ghl_call:a:2026-10-15", kind: "call_hot", workflowId: "wf-abc123" });
});

