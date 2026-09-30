// ai-spend.test.mjs — every Claude call counted, not just the reply drafts.
// On 2026-09-30 the drafts report said ~$8/day while the bill said more: the
// photo scans, comp grading, enrichment and dispo calls were never metered.

import test from "node:test";
import assert from "node:assert/strict";
import { addSpend, spendReport, meterAi, startAiSpendMeter, _stopAiSpendMeter } from "./ai-spend.js";

const usage = (model, input, output) => ({ model, usage: { input_tokens: input, output_tokens: output } });

test("each call lands on its day and feature, with tokens and dollars", () => {
  let doc = {};
  doc = addSpend(doc, { feature: "photo_scan", usage: { model: "claude-sonnet-5", input: 60000, output: 20000, costUsd: 0.32 }, day: "2026-09-30" });
  doc = addSpend(doc, { feature: "photo_scan", usage: { model: "claude-sonnet-5", input: 40000, output: 10000, costUsd: 0.18 }, day: "2026-09-30" });
  doc = addSpend(doc, { feature: "draft", usage: { model: "claude-sonnet-5", input: 5000, output: 800, costUsd: 0.018 }, day: "2026-09-30" });
  const d = doc.days["2026-09-30"];
  assert.deepEqual(d.photo_scan, { calls: 2, input: 100000, output: 30000, usd: 0.5 });
  assert.equal(d.draft.calls, 1);
});

test("old days roll off so the row stays small", () => {
  let doc = {};
  for (let i = 1; i <= 70; i++) doc = addSpend(doc, { feature: "x", usage: { costUsd: 1, input: 1, output: 1 }, day: `2026-07-${String(i).padStart(2, "0")}` });
  assert.ok(Object.keys(doc.days).length <= 60);
});

test("the report adds the days up, biggest feature first", () => {
  const doc = { days: {
    "2026-09-29": { photo_scan: { calls: 25, input: 1, output: 1, usd: 9 }, draft: { calls: 200, input: 1, output: 1, usd: 8 } },
    "2026-09-30": { draft: { calls: 10, input: 1, output: 1, usd: 0.3 } },
  } };
  const r = spendReport(doc, { days: 7, now: Date.parse("2026-09-30T20:00:00Z") });
  assert.equal(r.totalUsd, 17.3);
  assert.deepEqual(r.byFeature.map((f) => f.feature), ["photo_scan", "draft"]);
  assert.equal(r.byDay.find((d) => d.day === "2026-09-29").usd, 17);
});

test("metering writes through the store once started, and never throws", async () => {
  const saved = new Map();
  const store = {
    async getJobCursor(loc, name) { return saved.get(`${loc}|${name}`) || null; },
    async setJobCursor(loc, name, v) { saved.set(`${loc}|${name}`, v); return v; },
  };
  assert.doesNotThrow(() => meterAi("enrich", usage("claude-sonnet-5", 1000, 100)), "not started: just a log line");
  startAiSpendMeter({ store });
  meterAi("enrich", usage("claude-sonnet-5", 1000, 100));
  meterAi("enrich", usage("claude-sonnet-5", 1000, 100));
  await _stopAiSpendMeter();
  const doc = [...saved.values()][0].doc;
  const day = Object.values(doc.days)[0];
  assert.equal(day.enrich.calls, 2, "queued, so two calls in one tick both count");
  assert.doesNotThrow(() => meterAi("enrich", null));
});
