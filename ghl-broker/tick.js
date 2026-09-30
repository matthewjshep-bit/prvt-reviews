// tick.js — the 15-minute tick, one job at a time, each on its own.
//
// Until 2026-09-29 every job for a location ran inside ONE try/catch
// (broker.js): a throw in an early job skipped every job after it — the
// promises, the audit, the price watch, the waves, the pulse, the calls —
// that tick and every tick until it stopped throwing. Now each job fails
// alone, and its failure is recorded under its own area (`tick:<area>`).

/**
 * runLocationTick(ctx, jobs, { store, recordError, log }) → { ran, failed }
 *
 * `jobs` is [{ area, run(ctx) }] in the order they should go. A job's run is
 * awaited, so one that returns a promise can't reject past the tick.
 */
export async function runLocationTick(ctx, jobs = [], { store = null, recordError = null, log = console.error } = {}) {
  const out = { ran: 0, failed: [] };
  for (const job of jobs) {
    try {
      await job.run(ctx);
      out.ran++;
    } catch (e) {
      out.failed.push(job.area);
      log(`tick:${job.area} failed for ${ctx?.locationId}: ${String(e?.message || e).slice(0, 200)}`);
      if (typeof recordError === "function") {
        await Promise.resolve(recordError(store, { locationId: ctx?.locationId, area: `tick:${job.area}`, err: e })).catch(() => {});
      }
    }
  }
  return out;
}
