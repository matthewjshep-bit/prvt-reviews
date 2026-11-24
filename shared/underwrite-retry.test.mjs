// underwrite-retry.test.mjs — which stopped-early drafts wait on a retry,
// and which can be retried now (2026-11-23 audit, AH-2).
import test from "node:test";
import assert from "node:assert/strict";
import { stoppedEarlyOn, waitsOnRetry, underwriteFailure, retryableNow, retryHoldFrom, houseSettled } from "./underwrite-retry.js";

const NOW = Date.parse("2026-11-19T18:05:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const draft = (held, over = {}) => ({ id: "d1", status: "draft", address: "5 Fern Ct, Auburn, WA", createdAt: daysAgo(3), autoUnderwrite: { held: [held] }, ...over });
const ON = { now: NOW, timersOn: true, keyCheckOn: true };
const APIFY = "stopped early — Zillow comps lookup failed (Apify 401)";

test("a draft that stopped early on a rejected key waits on its retry; one that stopped on the house doesn't", () => {
  assert.equal(waitsOnRetry(draft(APIFY), ON), true);
  assert.equal(waitsOnRetry(draft(APIFY, { autoUnderwrite: { held: [APIFY], retriedAt: "2026-11-19T18:00:00Z" } }), ON), false, "retried once already");
  assert.equal(waitsOnRetry(draft("stopped early — no property address in the thread"), ON), false, "not a provider's failure");
  assert.equal(waitsOnRetry(draft("fewer than 8 photos"), ON), false, "a hold, not a failure");
  assert.equal(waitsOnRetry(draft("stopped early — comps: fetch failed", { status: "we_passed" }), ON), false, "no longer a draft");
});

test("a stopped-early draft waits only while a retry can still come", () => {
  assert.equal(waitsOnRetry(draft(APIFY, { createdAt: daysAgo(22) }), ON), false, "past the retry's 21 days");
  assert.equal(waitsOnRetry(draft(APIFY, { createdAt: undefined }), ON), false, "no age, no retry");
  assert.equal(waitsOnRetry(draft("stopped early — HTTP 401"), ON), false, "a rejected key nobody can name is never retried");
  assert.equal(waitsOnRetry(draft(APIFY), { ...ON, keyCheckOn: false }), false, "the key check off: nothing will say the key is good");
  assert.equal(waitsOnRetry(draft("stopped early — comps: fetch failed"), { ...ON, keyCheckOn: false }), true, "a network failure doesn't need the key check");
  assert.equal(waitsOnRetry(draft("stopped early — comps: fetch failed"), { ...ON, timersOn: false }), false, "the timers off: no retry at all");
  assert.equal(waitsOnRetry(draft(APIFY)), false, "nothing said switched on: no hold");
  const priced = { id: "p1", status: "draft", address: "5 Fern Court, Auburn, WA", cashAmount: 300000, createdAt: daysAgo(1) };
  assert.equal(waitsOnRetry(draft(APIFY), { ...ON, offers: [draft(APIFY), priced] }), false, "someone's number on the house: no retry will come");
  assert.deepEqual(retryHoldFrom({ conversationAi: { enabled: true, driver: { timers: { enabled: true } } }, keyHealth: { enabled: true } }), { timersOn: true, keyCheckOn: true });
  assert.deepEqual(retryHoldFrom({}), { timersOn: false, keyCheckOn: false });
});

test("a street number in the words is never read as a provider's status code", () => {
  assert.equal(stoppedEarlyOn(draft("stopped early — 403 Fern Ct not found on Zillow")), null);
  assert.equal(stoppedEarlyOn(draft("stopped early — no comps near 502 Elm St")), null);
  assert.equal(underwriteFailure("GHL PUT -> 429").transient, true);
  assert.equal(underwriteFailure("Bricked 402: out of money").auth, true);
  assert.equal(underwriteFailure("401 {\"type\":\"error\"}").auth, true);
});

test("a house gone from the market settles it like a pass", () => {
  const gone = { id: "g1", status: "unavailable", address: "5 Fern Ct, Auburn, WA", createdAt: daysAgo(9), autoUnderwrite: { held: [] } };
  assert.equal(houseSettled(draft(APIFY), [gone]), "the house was passed");
});

test("a rejected key is retried only once its own provider's key reads good", () => {
  const apify = underwriteFailure("Zillow comps lookup failed (Apify 403)");
  assert.deepEqual(apify, { auth: true, transient: false, provider: "apify" });
  assert.equal(retryableNow(apify, { keys: { apify: { ok: true } } }), true);
  assert.equal(retryableNow(apify, { keys: { apify: { ok: false } } }), false);
  assert.equal(retryableNow(apify, { keys: { anthropic: { ok: true } } }), false, "another provider's good key says nothing");
  assert.equal(retryableNow(underwriteFailure("401 authentication_error"), { keys: { anthropic: { ok: true } } }), true);
  assert.equal(retryableNow(underwriteFailure("request timed out"), {}), true, "the network's failure, any time");
  assert.equal(retryableNow(underwriteFailure("HTTP 401"), { keys: { apify: { ok: true } } }), false, "a rejected key nobody can name waits for Matt");
  assert.equal(stoppedEarlyOn(draft("stopped early — Zillow comps lookup failed (Apify 401)")).provider, "apify");
});
