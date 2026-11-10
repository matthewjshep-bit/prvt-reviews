// boot.test.mjs — a restart or a deploy is announced and drops nothing (boot.js).
//
// The 11-09 crash was found by an audit script: a restart that wasn't a
// deploy wrote nothing and posted nothing, a failed migration was a log
// line, the 15-minute tick could run into itself, and a deploy cut off the
// text that was halfway out.
//
//   node --test boot.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "boot-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { migrate, schemaState } = await import("./db.js");
const { runSlackPings } = await import("./slack-notify.js");
const { lineJobs } = await import("./shared/line.js");
const { recordBoot, sampleMemory, reportSchema, rootHandler, rootText, guarded, makeShutdown, BOOT_CURSOR, RESTART_NOTE } = await import("./boot.js");
await store.init();
const realFetch = globalThis.fetch;
test.after(async () => { globalThis.fetch = realFetch; await new Promise((r) => setTimeout(r, 120)); fs.rmSync(DIR, { recursive: true, force: true }); });

const T0 = Date.parse("2026-11-09T20:00:00.000Z");
const HOUR = 3600000;
const CH = { acquisitions: "C0ACQ00001", underwrites: "C0UW000001", dispositions: "C0DISPO001", needsMatt: "C0NEED0001", machine: "C0MACH0001", daily: "C0DAILY001" };
const ON = {
  slackBotToken: "xoxb-test-token",
  slack: { enabled: true, channels: CH, streams: { acquisitions: true, underwrites: true, dispositions: true, needsMatt: true, machine: true, daily: true } },
};
const noDesk = { pipelineFor: async () => ({ deskAll: { rows: [] }, desk: { rows: [] }, drafts: [] }) };

function slack() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: String(url).split("/api/")[1], body });
    return Response.json({ ok: true, ts: `1700000${calls.length}.0001`, channel: body.channel });
  };
  return { machine: () => calls.filter((c) => c.body.channel === CH.machine) };
}
const said = (c) => [c.body.text, ...(c.body.blocks || []).map((b) => b.text?.text)].join("\n");

test("a restart without a new commit posts once to the machine channel", async () => {
  const LOC = "loc-restart";
  const s = slack();
  const ping = (t) => runSlackPings({ store, locationId: LOC, saved: ON, deps: noDesk, now: t });

  // The first start on record, then a deploy: nothing to say.
  assert.deepEqual(await recordBoot({ store, locationIds: [LOC], commit: "aaa1111aaa", now: T0 }), [{ locationId: LOC, restarted: false }]);
  assert.deepEqual(await recordBoot({ store, locationIds: [LOC], commit: "bbb2222bbb", now: T0 + HOUR }), [{ locationId: LOC, restarted: false }]);
  await ping(T0 + HOUR + 60000);
  assert.equal(s.machine().length, 0, "a deploy is not news");

  // The same commit starts again two hours later: a crash, or a restart by hand.
  assert.deepEqual(await recordBoot({ store, locationIds: [LOC], commit: "bbb2222bbb", now: T0 + 3 * HOUR }), [{ locationId: LOC, restarted: true }]);
  await ping(T0 + 3 * HOUR + 90000);
  assert.equal(s.machine().length, 1);
  assert.match(said(s.machine()[0]), /Broker start/);
  assert.match(said(s.machine()[0]), /restarted without a deploy \(manual or crash\)/);
  await ping(T0 + 3 * HOUR + 15 * 60000);
  assert.equal(s.machine().length, 1, "once, not every tick");

  // A crash loop inside the hour moves the count, not the channel.
  await recordBoot({ store, locationIds: [LOC], commit: "bbb2222bbb", now: T0 + 3 * HOUR + 20 * 60000 });
  await ping(T0 + 3 * HOUR + 30 * 60000);
  assert.equal(s.machine().length, 1);
  const job = lineJobs(await store.listJobCursors(LOC), { now: T0 + 3 * HOUR + 30 * 60000 }).find((j) => j.name === BOOT_CURSOR);
  assert.equal(job.failed, true);
  assert.match(job.error, /2 restarts in the last hour/);

  // The next deploy clears it, and says nothing.
  await recordBoot({ store, locationIds: [LOC], commit: "ccc3333ccc", now: T0 + 6 * HOUR });
  await ping(T0 + 6 * HOUR + 60000);
  assert.equal(s.machine().length, 1);
  assert.equal(lineJobs(await store.listJobCursors(LOC), { now: T0 + 6 * HOUR }).find((j) => j.name === BOOT_CURSOR).failed, false);
});

test("with no commit to compare (a local run) a start is never called a crash", async () => {
  const LOC = "loc-dev";
  await recordBoot({ store, locationIds: [LOC], commit: "", now: T0 });
  assert.deepEqual(await recordBoot({ store, locationIds: [LOC], commit: "", now: T0 + HOUR }), [{ locationId: LOC, restarted: false }]);
});

test("the restart line says how much memory the broker had before it went down", async () => {
  const LOC = "loc-memory";
  await recordBoot({ store, locationIds: [LOC], commit: "ddd4444ddd", now: T0 });
  await sampleMemory({ store, locationIds: [LOC], bootAt: T0, now: T0 + 10 * 60000, rss: 300 * 1024 * 1024 });
  await sampleMemory({ store, locationIds: [LOC], bootAt: T0, now: T0 + 15 * 60000, rss: 512 * 1024 * 1024 });
  await sampleMemory({ store, locationIds: [LOC], bootAt: T0, now: T0 + 20 * 60000, rss: 480 * 1024 * 1024 });
  // A deploy's old broker, still sampling after the new one started, writes nothing.
  await recordBoot({ store, locationIds: ["loc-other"], commit: "x", now: T0 });
  await recordBoot({ store, locationIds: [LOC], commit: "ddd4444ddd", now: T0 + 23 * 60000 });
  const doc = (await store.getJobCursor(LOC, BOOT_CURSOR)).doc;
  assert.equal(doc.last.status, "error");
  assert.equal(doc.last.error, `${RESTART_NOTE}; memory was 480 MB 3 min before (peak 512 MB)`);
  await sampleMemory({ store, locationIds: [LOC], bootAt: T0, now: T0 + 25 * 60000, rss: 999 * 1024 * 1024 });
  assert.equal((await store.getJobCursor(LOC, BOOT_CURSOR)).doc.rss, null, "the old broker's sample didn't land on the new start");
});

test("a failed schema migration shows on the broker's root page", async () => {
  const LOC = "loc-schema";
  globalThis.fetch = realFetch;
  const app = express();
  app.get("/", rootHandler({ commit: "eee5555eeefff", backend: "pg", schema: schemaState }));
  const server = app.listen(0);
  const B = `http://127.0.0.1:${server.address().port}`;
  try {
    const broken = { query: async () => { throw new Error('column "made_up" of relation "offers" already exists'); } };
    const r = await migrate({ pool: broken, readSchema: async () => "alter table offers add column made_up text;" });
    assert.deepEqual(r, { ok: false, error: 'column "made_up" of relation "offers" already exists' });
    assert.equal(await (await fetch(`${B}/`)).text(), "offer broker ok @ eee5555 db=pg schema=failed");
    // Recorded where #machine hears it.
    assert.equal(await reportSchema({ store, locationIds: [LOC], result: r }), 1);
    const [row] = await store.listAppErrorsSince(LOC, new Date(Date.now() - HOUR).toISOString(), { limit: 10 });
    assert.equal(row.area, "db:migrate");
    assert.match(row.message, /schema migration failed: column/);

    const fixed = await migrate({ pool: { query: async () => ({ rows: [] }) }, readSchema: async () => "select 1;" });
    assert.deepEqual(fixed, { ok: true, error: null });
    assert.equal(await (await fetch(`${B}/`)).text(), "offer broker ok @ eee5555 db=pg schema=ok");
    assert.equal(await reportSchema({ store, locationIds: [LOC], result: fixed }), 0);
  } finally { server.close(); }
  assert.equal(rootText({}), "offer broker ok @ dev db=file schema=none");
});

test("the 15-minute tick doesn't start a second run while one is going", async () => {
  let release;
  let runs = 0;
  const said = [];
  const tick = guarded(async () => { runs++; await new Promise((r) => { release = r; }); return { ran: true }; }, { name: "tick", log: (m) => said.push(m) });
  const first = tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(tick.running(), true);
  assert.deepEqual(await tick(), { skipped: "running" });
  assert.equal(runs, 1, "the second tick started nothing");
  assert.match(said[0], /still going/);
  release();
  assert.deepEqual(await first, { ran: true });
  assert.equal(tick.running(), false);
  const again = tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2, "once it's done, the next tick runs");
  release();
  await again;
  // A run that throws frees the loop too.
  const boom = guarded(async () => { throw new Error("GHL 502"); });
  await assert.rejects(boom(), /GHL 502/);
  assert.equal(boom.running(), false);
});

test("a tick stuck on a call that never answers doesn't stop the ticks after it", async () => {
  let clock = T0;
  let runs = 0;
  const said = [];
  const tick = guarded(async () => { runs++; if (runs === 1) await new Promise(() => {}); return { ran: runs }; },
    { name: "tick", log: (m) => said.push(m), staleMs: 45 * 60000, now: () => clock });
  tick();
  await new Promise((r) => setImmediate(r));
  clock += 15 * 60000;
  assert.deepEqual(await tick(), { skipped: "running" }, "a slow tick is waited on");
  clock += 31 * 60000;
  assert.deepEqual(await tick(), { ran: 2 }, "46 minutes in, it's taken for stuck");
  assert.match(said.at(-1), /going 46 min; starting a new one beside it/);
});

test("a deploy stops the timers, waits for the text going out, then exits", async () => {
  let release;
  const sending = new Promise((r) => { release = r; });
  const exits = [];
  const fired = [];
  const timer = setInterval(() => fired.push(1), 5);
  const shutdown = makeShutdown({ timers: () => [timer], idle: [() => sending], timeoutMs: 5000, log: () => {}, exit: (c) => exits.push(c) });
  assert.equal(shutdown.stopping(), false);
  const done = shutdown("SIGTERM");
  assert.equal(shutdown.stopping(), true, "the send loop claims nothing new from here");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(exits, [], "still waiting on the send");
  assert.equal(fired.length, 0, "the interval was stopped");
  release();
  await done;
  assert.deepEqual(exits, [0]);
  assert.equal(shutdown("SIGTERM"), done, "a second signal is the same shutdown");

  // A send that never finishes doesn't hold the process past the cap.
  const stuck = [];
  await makeShutdown({ idle: [() => new Promise(() => {})], timeoutMs: 20, log: () => {}, exit: (c) => stuck.push(c) })("SIGTERM");
  assert.deepEqual(stuck, [0]);
});
