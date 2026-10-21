// hand-off.test.mjs — everything that used to wait on Today has an owner.

import test from "node:test";
import assert from "node:assert/strict";
import { ownerOf, handOffs, OWNERS, OWNER_OF_KIND } from "./hand-off.js";
import { ACTION_KINDS } from "./pipeline.js";
import { CALL_KINDS } from "./call-list.js";

// Matt, 2026-10-20: no Today. A kind added later with no owner here would
// need a person and have nowhere to show it.
test("every kind the pipeline, the call list or the audit can make has an owner", () => {
  const kinds = [...ACTION_KINDS.map((k) => k.key), ...CALL_KINDS.map((k) => k.key), "audit_owed"];
  const missing = kinds.filter((k) => !OWNERS.includes(ownerOf({ kind: k })));
  assert.deepEqual(missing, []);
  assert.ok(Object.values(OWNER_OF_KIND).every((o) => OWNERS.includes(o)));
});

test("a held reply is a call when they asked to talk, closed when there's nothing to say, else the machine's", () => {
  const draftsById = new Map([
    ["call", { id: "call", intent: "wants_call" }],
    ["sched", { id: "sched", intent: "scheduling" }],
    ["thanks", { id: "thanks", intent: "small_talk" }],
    ["stranger", { id: "stranger", intent: "other", autoSend: { reason: "an unknown contact never auto-sends" } }],
    ["counter", { id: "counter", intent: "counter" }],
    ["mine", { id: "mine", intent: "agent_pulse", outbound: { kind: "agent_pulse", forMatt: true } }],
  ]);
  const of = (draftId) => ownerOf({ kind: "draft_waiting", draftId }, { draftsById });
  assert.deepEqual(["call", "sched", "thanks", "stranger", "counter", "mine"].map(of), ["call", "call", "drop", "drop", "machine", "machine"]);
});

test("a number we owe is Matt's to price; the written offer is the machine's; an answer only he has pings him", () => {
  assert.equal(ownerOf({ kind: "promise_owed", what: "number" }), "price");
  assert.equal(ownerOf({ kind: "promise_owed", what: "paper" }), "machine");
  assert.equal(ownerOf({ kind: "promise_owed", what: "answer" }), "ping");
  assert.equal(ownerOf({ kind: "price_it" }), "price");
});

test("last night's 'they want a call' is a call, and an overdue number is his to price", () => {
  assert.equal(ownerOf({ kind: "audit_owed", findingKind: "unanswered_inbound", intent: "wants_call" }), "call");
  assert.equal(ownerOf({ kind: "audit_owed", findingKind: "promise_open_overdue" }), "price");
  assert.equal(ownerOf({ kind: "audit_owed", findingKind: "unanswered_inbound" }), "machine");
});

test("paper to sign, an agreed number and closing tasks ping him", () => {
  for (const kind of ["paper_to_sign", "approve_number", "investor_price_agreed", "closing_task_due", "pre_contract"]) assert.equal(ownerOf({ kind }), "ping", kind);
});

test("the counts say who has what, and nothing is unowned", () => {
  const r = handOffs([{ kind: "price_it" }, { kind: "price_it" }, { kind: "call_brought" }, { kind: "texts_elsewhere" }, { kind: "made_up" }]);
  assert.deepEqual(r.counts, { machine: 0, price: 2, call: 1, ping: 0, drop: 1, unowned: 1 });
  assert.deepEqual(r.byKind[0], { kind: "price_it", owner: "price", n: 2 });
});
