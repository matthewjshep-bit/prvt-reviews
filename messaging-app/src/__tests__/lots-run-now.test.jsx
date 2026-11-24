// lots-run-now.test.jsx — the Lots tab's Run now (2026-11-24 audit). It waited
// on the whole run (parcels, traces, imports: minutes), Render's proxy cut the
// request off, and Matt saw "The run failed." while the run went on. Now it
// starts the run, polls the light GET /api/lot-finder/job, and reads the
// result off `last`.
import { test, expect, vi, afterEach } from "vitest";
import { waitForLotRun, lotRunMessage } from "../LotsTab.jsx";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

test("Run now doesn't wait on the whole run", async () => {
  const bodies = [];
  globalThis.fetch = vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true, job: { id: "lot-1", status: "running" } }) }; });
  const { runLotFinder } = await import("../api.js");
  await runLotFinder({ dryRun: false });
  expect(bodies[0].wait).toBe(false);
  expect(bodies[0].dryRun).toBe(false);
});

test("the poll is the light read, not the one that lists every owner", async () => {
  const urls = [];
  globalThis.fetch = vi.fn(async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({ job: null, last: null }) }; });
  await waitForLotRun("lot-1", { sleep: async () => {} });
  expect(urls).toHaveLength(1);
  expect(urls[0]).toMatch(/\/api\/lot-finder\/job\?/);
});

test("the tab polls until this run is done and its result is saved", async () => {
  const seen = [
    { job: { id: "lot-1", status: "running" }, last: { id: "lot-0" } },
    { job: { id: "lot-1", status: "done" }, last: { id: "lot-0" } },   // done, result not stamped yet
    { job: { id: "lot-1", status: "done" }, last: { id: "lot-1", dryRun: false, traced: { looked: 4, reachable: 3 }, imported: { created: 2 }, texts: { scheduled: 0, drafted: 2 }, pockets: [{ id: "hillcrest", parcels: 40 }] } },
  ];
  let i = 0;
  const sleeps = [];
  const info = await waitForLotRun("lot-1", { get: async () => seen[Math.min(i++, seen.length - 1)], sleep: async (ms) => { sleeps.push(ms); } });
  expect(i).toBe(3);
  expect(sleeps.length).toBe(2);
  expect(info.last.id).toBe("lot-1");
  expect(lotRunMessage(info.last)).toMatch(/^Ran — hillcrest: 40 parcels\. Traced 4 \(3 with a cell\); owners imported 2; builders imported 0; texts 0 scheduled, 2 waiting for you\.$/);
});

test("a broker that dropped the run, or a dropped poll, doesn't hang the tab", async () => {
  // The broker restarted mid-run: no job in memory, so stop and show what's there.
  const gone = await waitForLotRun("lot-1", { get: async () => ({ job: null, last: { id: "lot-0" } }), sleep: async () => {} });
  expect(gone.job).toBe(null);
  // A poll that fails is tried again.
  let n = 0;
  const back = await waitForLotRun("lot-2", { get: async () => { if (n++ === 0) throw new Error("502"); return { job: { id: "lot-2", status: "error" }, last: { id: "lot-2", error: "no key" } }; }, sleep: async () => {} });
  expect(back.last.error).toBe("no key");
  // A run that goes on past the limit returns with it still running.
  let t = 0;
  const long = await waitForLotRun("lot-3", { get: async () => ({ job: { id: "lot-3", status: "running" } }), sleep: async (ms) => { t += ms; }, now: () => t, maxMs: 20000, everyMs: 5000 });
  expect(long.job.status).toBe("running");
});

test("a dry run's message says what it would do", () => {
  expect(lotRunMessage({ dryRun: true, pockets: [{ id: "hillcrest", parcels: 40 }], traced: { would: 10 }, imported: { would: 8 }, texts: { would: 8 } }))
    .toBe("Dry run — hillcrest: 40 parcels. Would trace 10, would import 8, would text 8.");
});
