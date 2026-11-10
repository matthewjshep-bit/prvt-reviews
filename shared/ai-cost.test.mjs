import test from "node:test";
import assert from "node:assert/strict";
import { usageOf, costOf } from "./ai-cost.js";

test("a draft's cost reads off its own usage block, cache and batch included", () => {
  // 5,400 system tokens read from cache, 4,000 of thread, 1,000 out, on Opus 5.
  const r = usageOf({ model: "claude-opus-5", usage: { input_tokens: 4000, cache_read_input_tokens: 5400, cache_creation_input_tokens: 0, output_tokens: 1000 } });
  assert.equal(r.costUsd, 0.0477);   // 4000*5e-6 + 5400*0.5e-6 + 1000*25e-6
  const w = usageOf({ model: "claude-sonnet-5", usage: { input_tokens: 4000, cache_creation_input_tokens: 5400, cache_creation: { ephemeral_1h_input_tokens: 5400, ephemeral_5m_input_tokens: 0 }, output_tokens: 1000 } });
  assert.equal(w.cacheWrite1h, 5400);
  assert.equal(w.costUsd, 0.0396);   // 4000*2e-6 + 5400*4e-6 + 1000*10e-6
  assert.equal(usageOf({ model: "claude-sonnet-5", usage: { input_tokens: 4000, output_tokens: 1000 } }, { batched: true }).costUsd, 0.009);
  assert.equal(costOf({ model: "some-other-model", input: 10 }), null, "unpriced is null, not wrong");
});

// 2026-11-09 audit: Opus 5.5 billed as Opus 5 (its id starts "claude-opus-5-"),
// and Haiku 5.5 had no row at all, so its calls read as free.
test("an answer from Opus 5.5 is priced, not counted as free", () => {
  // 10,000 in, 2,000 read from cache, 1,000 out, at $4 / $20 with cache reads at $0.20.
  const o = usageOf({ model: "claude-opus-5-5", usage: { input_tokens: 10000, cache_read_input_tokens: 2000, output_tokens: 1000 } });
  assert.equal(o.costUsd, 0.0604);   // 10000*4e-6 + 2000*0.2e-6 + 1000*20e-6
  // Sonnet 5.5 at $2 / $10.
  assert.equal(costOf({ model: "claude-sonnet-5-5", input: 10000, output: 1000 }), 0.03);
  // Haiku 5.5 at $0.10 / $0.50 up to 100K tokens of prompt, $0.50 / $2.50 past it.
  assert.equal(costOf({ model: "claude-haiku-5-5", input: 50000, output: 2000 }), 0.006);
  assert.equal(costOf({ model: "claude-haiku-5-5", input: 120000, output: 2000 }), 0.065);
  // A dated id still bills as its own model, and Opus 5 keeps its own price.
  assert.equal(costOf({ model: "claude-opus-5-5-20261101", input: 1000000 }), 4);
  assert.equal(costOf({ model: "claude-opus-5", input: 1000000 }), 5);
  assert.equal(costOf({ model: "claude-haiku-5-5", input: 1 }) != null, true, "never null for a listed model");
});
