// draft-cost.test.mjs — what the reply drafts cost, and what keeps a cheaper
// path from ever costing a draft (2026-09-25).
import test from "node:test";
import assert from "node:assert/strict";
import { draftParams, draftEffort, callDraftModel, shadowRow, BATCHABLE_KINDS, LOW_EFFORT_KINDS, REPLY_MODEL } from "./reply-agent.js";

const params = () => draftParams({ model: REPLY_MODEL, system: "sys", user: "u", schema: { type: "object" }, effort: "medium" });
const fakeClient = (calls) => ({
  beta: { messages: { create: async (p) => { calls.push(["beta", p.model, Boolean(p.fallbacks)]); return { stop_reason: "end_turn", model: p.model, content: [], usage: {} }; } } },
  messages: { create: async (p) => { calls.push(["plain", p.model]); return { stop_reason: "end_turn", model: p.model, content: [], usage: {} }; } },
});

test("the system prompt caches for an hour, not five minutes", () => {
  assert.deepEqual(params().system[0].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("plain check-ins draft at low effort; replies, numbers and negotiation stay at medium", () => {
  assert.equal(draftEffort({ kind: "offer_nudge" }), "low");
  assert.equal(draftEffort({ kind: "checkin_due" }), "low");
  for (const kind of ["counter_nudge", "hot_push", "realm_check", "take_check", "promise_due", "price_drop"]) assert.equal(draftEffort({ kind }), "medium", kind);
  assert.equal(draftEffort(null), "medium", "a reply to a person");
});

test("nothing a person is waiting on may wait on a batch", () => {
  for (const kind of ["realm_check", "take_check", "partner_answer", "address_chase"]) assert.equal(BATCHABLE_KINDS.has(kind), false, kind);
  for (const kind of LOW_EFFORT_KINDS) assert.ok(BATCHABLE_KINDS.has(kind), `${kind} is a sweep's text`);
});

test("a batched draft comes back marked batched; a failed or refused batch drafts directly instead", async () => {
  const calls = [];
  const ok = await callDraftModel(fakeClient(calls), params(), { batch: { enqueue: async () => ({ stop_reason: "end_turn", usage: {} }) } });
  assert.equal(ok.batched, true);
  assert.equal(calls.length, 0);

  const failed = await callDraftModel(fakeClient(calls), params(), { batch: { enqueue: async () => { throw new Error("batch not done in 15 min"); } } });
  assert.equal(failed.batched, false);
  assert.deepEqual(calls.at(-1), ["beta", "claude-opus-5", true], "the direct call keeps the refusal fallback");

  const refused = await callDraftModel(fakeClient(calls), params(), { batch: { enqueue: async () => ({ stop_reason: "refusal" }) } });
  assert.equal(refused.batched, false);
});

test("the shadow model is called plainly, and its draft is judged by the real gates", async () => {
  const calls = [];
  await callDraftModel(fakeClient(calls), { ...params(), model: "claude-sonnet-5" });
  assert.deepEqual(calls.at(-1), ["plain", "claude-sonnet-5"]);
  const row = shadowRow({ model: "claude-sonnet-5", intent: "question", confidence: "high", needsHuman: false, reply: "Still available?", usage: { costUsd: 0.02 } },
    (d) => ({ ok: d.reply.length < 10, flags: ["too long"] }));
  assert.equal(row.gateOk, false);
  assert.deepEqual(row.flags, ["too long"]);
  assert.deepEqual(shadowRow({ model: "claude-sonnet-5", error: "429" }, () => ({})), { model: "claude-sonnet-5", error: "429" });
  assert.equal(shadowRow(null, () => ({})), null);
});
