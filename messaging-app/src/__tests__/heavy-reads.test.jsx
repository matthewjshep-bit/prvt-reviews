// heavy-reads.test.jsx — the console asks the broker for less (2026-11-09).
//
// The Autopilot tabs built all of Today (GET /pipeline) just for their switch
// pills, and Flow polled every thirty seconds even on a day that was over.
// Each of those is a heavy read on the one broker that takes GHL's webhooks.
import { test, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { flowPollMs } from "../FlowView.jsx";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

test("the Autopilot tabs load without reading the whole pipeline", async () => {
  const urls = [];
  globalThis.fetch = vi.fn(async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({ ok: true, autopilot: { switches: [] }, conversationEnabled: true }) }; });
  const { getDashboardAutopilot } = await import("../api.js");
  const r = await getDashboardAutopilot();
  expect(r.autopilot.switches).toEqual([]);
  expect(urls).toHaveLength(1);
  expect(urls[0]).toMatch(/\/api\/dashboard\/autopilot\?/);
  // And the three tabs ask for that, never for Today.
  for (const file of ["AutopilotView.jsx", "AgentsTab.jsx", "InvestorsTab.jsx"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    expect(src, file).toContain("getDashboardAutopilot()");
    expect(src, file).not.toContain("getDashboardPipeline");
  }
});

test("Flow pinned to a past day doesn't poll", () => {
  expect(flowPollMs("2026-11-01", "2026-11-09")).toBeNull();
  expect(flowPollMs("", "2026-11-09")).toBe(30000);
  expect(flowPollMs("2026-11-09", "2026-11-09")).toBe(30000);
});
