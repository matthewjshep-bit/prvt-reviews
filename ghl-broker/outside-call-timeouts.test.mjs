// outside-call-timeouts.test.mjs — the calls outside GHL that had no timeout.
//
// 2026-11-09: the Slack post, the Gmail token refresh and cardgen's /render
// were plain fetches with no signal, so one that hung held its caller (the
// tick's Slack job, a draft's email read, offer creation) for as long as it
// hung.
//
//   node --test outside-call-timeouts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { slackApi, SLACK_TIMEOUT_MS } from "./slack-notify.js";
import { accessToken, _resetToken, GMAIL_TOKEN_TIMEOUT_MS } from "./gmail-api.js";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

// A server that never answers: the fetch only ends when its signal fires.
const hangs = (seen) => (url, opts = {}) => {
  seen.push(opts.signal);
  return new Promise((_, reject) => {
    if (!opts.signal) return; // no signal: it would hang for good
    opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
  });
};

test("a Slack post gives up after 15 seconds", async () => {
  assert.equal(SLACK_TIMEOUT_MS, 15000);
  const seen = [];
  globalThis.fetch = hangs(seen);
  const t0 = Date.now();
  await assert.rejects(slackApi("xoxb-invented", "chat.postMessage", { channel: "C1", text: "hi" }, { timeoutMs: 30 }),
    (e) => e.name === "TimeoutError");
  assert.ok(Date.now() - t0 < 2000, "it gave up instead of hanging");
  assert.ok(seen[0] instanceof AbortSignal);
});

test("the Gmail token refresh gives up instead of holding a draft", async () => {
  assert.equal(GMAIL_TOKEN_TIMEOUT_MS, 15000);
  _resetToken();
  const seen = [];
  globalThis.fetch = hangs(seen);
  await assert.rejects(accessToken({ clientId: "id", clientSecret: "s", refreshToken: "r-invented-token" }, { timeoutMs: 30 }),
    (e) => e.name === "TimeoutError");
  assert.ok(seen[0] instanceof AbortSignal);
});
