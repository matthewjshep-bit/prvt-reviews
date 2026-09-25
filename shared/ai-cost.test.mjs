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
