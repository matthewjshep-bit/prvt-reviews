// underwrite-retry.test.mjs — which stopped-early drafts wait on a retry,
// and which can be retried now (2026-11-23 audit, AH-2).
import test from "node:test";
import assert from "node:assert/strict";
import { stoppedEarlyOn, waitsOnRetry, underwriteFailure, retryableNow } from "./underwrite-retry.js";

const draft = (held, over = {}) => ({ id: "d1", status: "draft", address: "5 Fern Ct, Auburn, WA", autoUnderwrite: { held: [held] }, ...over });

test("a draft that stopped early on a rejected key waits on its retry; one that stopped on the house doesn't", () => {
  assert.equal(waitsOnRetry(draft("stopped early — Zillow comps lookup failed (Apify 401)")), true);
  assert.equal(waitsOnRetry(draft("stopped early — Zillow comps lookup failed (Apify 401)", { autoUnderwrite: { held: ["stopped early — Zillow comps lookup failed (Apify 401)"], retriedAt: "2026-11-19T18:00:00Z" } })), false, "retried once already");
  assert.equal(waitsOnRetry(draft("stopped early — no property address in the thread")), false, "not a provider's failure");
  assert.equal(waitsOnRetry(draft("fewer than 8 photos")), false, "a hold, not a failure");
  assert.equal(waitsOnRetry(draft("stopped early — comps: fetch failed", { status: "we_passed" })), false, "no longer a draft");
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
