// key-health.test.mjs — the paid keys, read once a day (key-health.js,
// 2026-11-23 audit AH-1). The Apify token was rejected 11-11 to 11-18 and
// nobody knew for a week. The store is the JSON-file backend in a temp
// folder; Apify is a stub on globalThis.fetch, Anthropic a stub in deps.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "key-health-test-"));
process.env.DATA_DIR = DIR;
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { maybeRunKeyHealth, probeApify, probeAnthropic, _resetKeyHealth, CURSOR_NAME } = await import("./key-health.js");
const { listingCheckDown } = await import("./outreach-sweep.js");
const { default: createOutreachRouter } = await import("./routes/outreach.js");
const { keyTroubles, machineTrouble, keyHealthDue } = await import("./shared/machine-health.js");
await store.init();
const realFetch = globalThis.fetch;
test.after(async () => { globalThis.fetch = realFetch; await new Promise((r) => setTimeout(r, 120)); fs.rmSync(DIR, { recursive: true, force: true }); });

// Tuesday 2026-11-17, Pacific.
const TUE = (hh, mm = 0) => Date.parse(`2026-11-17T${String(hh + 8).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
const ON = { keyHealth: { enabled: true }, apifyToken: "apify_api_TESTTOKEN123", aiApiKey: "sk-ant-test-key" };
const goodModels = async () => ({ data: [{ id: "claude-test" }] });

// Apify's API: `me` answers with `status`; `limits` with the month's usage.
function apify({ status = 200, usd = 10, limit = 50 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.authorization || "" });
    if (String(url).endsWith("/users/me/limits")) return Response.json({ data: { current: { monthlyUsageUsd: usd }, limits: { maxMonthlyUsageUsd: limit } } });
    if (String(url).endsWith("/users/me")) return status === 200 ? Response.json({ data: { id: "u1" } }) : new Response("{}", { status });
    throw new Error(`unexpected fetch ${url}`);
  };
  return calls;
}

test("a rejected Apify key is kept as rejected from the day it started, and read again within the hour", async () => {
  const LOC = "loc-apify-401";
  _resetKeyHealth();
  const calls = apify({ status: 401 });
  const r = await maybeRunKeyHealth({ locationId: LOC, saved: ON, store, deps: { listModels: goodModels }, now: TUE(7, 5) });
  assert.equal(r.keys.apify.ok, false);
  assert.equal(r.keys.apify.status, 401);
  assert.equal(r.keys.anthropic.ok, true);
  assert.ok(calls.every((c) => !c.url.includes("TESTTOKEN")), "the token never rides in a URL");
  assert.equal(calls[0].auth, "Bearer apify_api_TESTTOKEN123");
  const since = r.keys.apify.failingSince;
  assert.equal(await maybeRunKeyHealth({ locationId: LOC, saved: ON, store, deps: { listModels: goodModels }, now: TUE(7, 40) }), null, "not before the hour");
  const again = await maybeRunKeyHealth({ locationId: LOC, saved: ON, store, deps: { listModels: goodModels }, now: TUE(8, 10) });
  assert.equal(again.keys.apify.failingSince, since, "still the same spell");
  const cur = await store.getJobCursor(LOC, CURSOR_NAME);
  const t = keyTroubles(cur.doc, { now: TUE(8, 10) });
  assert.equal(t.length, 1);
  assert.match(t[0].text, /Zillow comps key \(Apify\) rejected since today \(HTTP 401\): auto-underwrite, the outreach listing check, price watch and the lot finder's builder scan are stopped\./);
  // Fixed: the next hourly read clears it, and nothing more is read today.
  apify({ status: 200 });
  const fixed = await maybeRunKeyHealth({ locationId: LOC, saved: ON, store, deps: { listModels: goodModels }, now: TUE(9, 15) });
  assert.equal(fixed.keys.apify.ok, true);
  assert.equal(fixed.keys.apify.failingSince, null);
  assert.equal(await maybeRunKeyHealth({ locationId: LOC, saved: ON, store, deps: { listModels: goodModels }, now: TUE(10, 30) }), null);
});

test("Apify's month past 80% of its limit is a line of its own", async () => {
  const LOC = "loc-apify-usage";
  _resetKeyHealth();
  apify({ usd: 42.1, limit: 50 });
  const r = await maybeRunKeyHealth({ locationId: LOC, saved: ON, store, deps: { listModels: goodModels }, now: TUE(7, 5) });
  assert.deepEqual(r.keys.apify.usage, { usd: 42.1, limitUsd: 50, pct: 84 });
  const t = keyTroubles((await store.getJobCursor(LOC, CURSOR_NAME)).doc, { now: TUE(7, 10) });
  assert.equal(t.length, 1);
  assert.match(t[0].text, /Apify usage is at 84% of its \$50 monthly limit \(\$42\.1\)/);
});

test("a key check that's switched off reads nothing", async () => {
  _resetKeyHealth();
  const calls = apify();
  assert.equal(await maybeRunKeyHealth({ locationId: "loc-off", saved: { ...ON, keyHealth: {} }, store, deps: { listModels: goodModels }, now: TUE(7, 5) }), null);
  assert.equal(calls.length, 0);
});

test("a provider that doesn't answer isn't called a rejected key", async () => {
  globalThis.fetch = async () => { throw new Error("fetch failed"); };
  const r = await probeApify("apify_api_TESTTOKEN123");
  assert.equal(r.ok, null);
  assert.doesNotMatch(r.error, /TESTTOKEN/);
  const bad = await probeAnthropic("sk-ant-test-key", { listModels: async () => { throw Object.assign(new Error("401 authentication_error: invalid x-api-key"), { status: 401 }); } });
  assert.equal(bad.ok, false);
  const slow = await probeAnthropic("sk-ant-test-key", { listModels: async () => { throw Object.assign(new Error("Overloaded"), { status: 529 }); } });
  assert.equal(slow.ok, null);
});

test("the strip on Offers and Deals shows the key lines and fresh stoppers only", () => {
  const now = TUE(12);
  const keyHealth = { doc: { keys: { apify: { ok: false, status: 403, failingSince: new Date(TUE(7) - 86400000).toISOString(), checkedAt: new Date(TUE(11)).toISOString() } } } };
  const fresh = { doc: { at: new Date(now - 10 * 60000).toISOString(), stoppers: [{ id: "job:outreach", text: "Outreach autopilot (county pull) hasn't run in 30h." }] } };
  const lines = machineTrouble({ keyHealth, stoppers: fresh, now });
  assert.equal(lines.length, 2);
  assert.match(lines[0].text, /rejected since Mon \(HTTP 403\)/);
  const stale = { doc: { ...fresh.doc, at: new Date(now - 3 * 3600000).toISOString() } };
  assert.equal(machineTrouble({ keyHealth: null, stoppers: stale, now }).length, 0, "a stopper list nobody refreshed in hours is not shown");
});

// Review, 2026-11-23: a key rejected and then the check switched off (or
// stopped running) kept the strip red, and #machine @Matt, every day for good.
test("a key line goes once the key check is switched off or its last read is over a day old", () => {
  const now = TUE(12);
  const read = (at) => ({ doc: { keys: { apify: { ok: false, status: 401, failingSince: new Date(at).toISOString(), checkedAt: new Date(at).toISOString() } } } });
  assert.equal(machineTrouble({ keyHealth: read(TUE(11)), now }).length, 1);
  assert.equal(machineTrouble({ keyHealth: read(TUE(11)), keyCheckOn: false, now }).length, 0, "switched off: what it last read is not known any more");
  assert.equal(machineTrouble({ keyHealth: read(now - 27 * 3600000), now }).length, 0, "a read the check never followed up");
});

test("the key check's gate retries a run that died, and stops at its daily cap", () => {
  const day = "2026-11-17";
  assert.equal(keyHealthDue({}, { now: TUE(6, 30), hourNow: 6 }).go, false, "not before 7am");
  assert.equal(keyHealthDue({ day, tries: 1, lastRun: new Date(TUE(7)).toISOString(), run: { startedAt: new Date(TUE(7)).toISOString() } }, { now: TUE(7, 5), hourNow: 7 }).go, false, "a run is going");
  assert.equal(keyHealthDue({ day, tries: 1, lastRun: new Date(TUE(7)).toISOString(), run: { startedAt: new Date(TUE(7)).toISOString() } }, { now: TUE(7, 30), hourNow: 7 }).go, true, "it died: again");
  assert.equal(keyHealthDue({ day, tries: 16, lastRun: new Date(TUE(7)).toISOString(), keys: { apify: { ok: false } } }, { now: TUE(12), hourNow: 12 }).go, false, "capped");
});

// AH-1: the listing check's pre-flight only asked whether a token was saved,
// so a rejected one spent the day's RentCast requests before failing.
test("a rejected Apify token stops the outreach day before a RentCast request is spent", async () => {
  const LOC = "loc-listing-check";
  await store.saveOfferSettings(LOC, { apifyToken: "apify_api_TESTTOKEN123" });
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: LOC, client: null }) });
  const calls = apify({ status: 401 });
  const down = await listingCheckDown(router.sweepDeps, LOC);
  assert.match(down, /Apify rejected the token \(HTTP 401\)/);
  assert.ok(calls.every((c) => c.url.startsWith("https://api.apify.com/v2/users/me")), "only the free read");
  apify({ status: 200 });
  assert.equal(await listingCheckDown(router.sweepDeps, LOC), "", "a good token passes");
});
