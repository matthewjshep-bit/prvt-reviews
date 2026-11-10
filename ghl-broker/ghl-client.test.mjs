// ghl-client.test.mjs — one retry and one rate limit for every GHL call.
//
// 2026-11-09: client.call threw on any non-2xx, five copies of withRetry
// retried only 429, and reply assembly didn't retry at all, so one 502 from
// GHL became "AI reply could not be drafted, answer by hand". A send must
// never go twice, and an error must never carry what a lookup searched for.
//
//   node --test ghl-client.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { makeClient, callKind, ghlError, retryAfterMs, takeTurn, _resetBuckets, findDuplicateContact, GHL_MAX_TRIES } from "./ghl.js";
import { buildTranscript } from "./enrich.js";

const realFetch = globalThis.fetch;
const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
// Each test gets its own token (its own bucket) and a sleep that only records.
let n = 0;
function client({ rate = 1000 } = {}) {
  const waits = [];
  const c = makeClient(`tok-${++n}`, { rate, sleep: async (ms) => { waits.push(ms); }, retryBaseMs: 5 });
  return { c, waits };
}
test.afterEach(() => { globalThis.fetch = realFetch; });

test("a GHL read that gets one 502 still drafts the reply", async () => {
  // Reply assembly reads the thread through buildTranscript (enrich.js).
  const seen = [];
  let failed = false;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    seen.push(u.pathname);
    if (u.pathname === "/conversations/search") {
      if (!failed) { failed = true; return reply(502, "<html>Bad Gateway</html>"); }
      return reply(200, { conversations: [{ id: "cv1" }], total: 1 });
    }
    if (u.pathname === "/conversations/cv1/messages") {
      return reply(200, { messages: { messages: [{ id: "m1", messageType: "TYPE_SMS", direction: "inbound", body: "is the yellow house still on your list", dateAdded: new Date().toISOString() }] } });
    }
    return reply(404, {});
  };
  const { c, waits } = client();
  const t = await buildTranscript(c, "loc-1", "contact-1", { maxConversations: 1, maxPagesPerConvo: 1, maxCallTranscripts: 0 });
  assert.match(t.text, /yellow house/);
  assert.equal(seen.filter((p) => p === "/conversations/search").length, 2, "the 502 was tried once more");
  assert.equal(waits.length, 1, "with one backoff between");
});

test("a send that times out is not sent again", async () => {
  let posts = 0;
  globalThis.fetch = async (url, opts) => {
    if (opts.method === "POST") posts++;
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  const { c } = client();
  await assert.rejects(
    c.call("/conversations/messages", { method: "POST", body: { type: "SMS", contactId: "c1", message: "hello there" } }),
    (e) => e.name === "TimeoutError");
  assert.equal(posts, 1, "one try, never a second");
});

test("a send GHL refuses with a 429 or a 503 goes back to the scheduler, not round again here", async () => {
  for (const status of [429, 503]) {
    let posts = 0;
    globalThis.fetch = async () => { posts++; return reply(status, { message: "Too Many Requests" }); };
    const { c } = client();
    await assert.rejects(c.call("/conversations/messages", { method: "POST", body: {} }), (e) => e.status === status);
    assert.equal(posts, 1);
  }
});

test("a GHL duplicate-lookup error never carries the email it looked up", async () => {
  // The body echoes what it was asked; the path carried it in the query.
  globalThis.fetch = async () => reply(500, { statusCode: 500, message: "lookup failed for pat.example@example.com or +12065550142" });
  const { c } = client();
  let err = null;
  try { await findDuplicateContact(c, "loc-1", { email: "pat.example@example.com" }); } catch (e) { err = e; }
  assert.ok(err, "a 500 still throws so the caller can back off");
  assert.equal(err.status, 500);
  assert.doesNotMatch(err.message, /pat\.example|example\.com|%40|2065550142|\?/);
  assert.match(err.message, /^GHL GET \/contacts\/search\/duplicate -> 500 lookup failed for <email> or <phone>$/);
  assert.equal(err.data.statusCode, 500, "the whole body stays on err.data");
});

test("a GHL error is the path without its query plus the body's message, and nothing else", () => {
  const e = ghlError({ method: "GET", path: "/contacts/search/duplicate?locationId=L&number=%2B12065550199", status: 422, data: { message: ["number is invalid", "try again"], extra: "+12065550199" } });
  assert.equal(e.message, "GHL GET /contacts/search/duplicate -> 422 number is invalid; try again");
  assert.equal(ghlError({ method: "PUT", path: "/contacts/c1", status: 502, data: { raw: "<html>gateway</html>" } }).message, "GHL PUT /contacts/c1 -> 502");
  // The scheduler still reads these two (conversation-scheduler.js).
  const unsub = ghlError({ method: "POST", path: "/conversations/messages", status: 400, data: { message: "Cannot send message as +14255550100 has unsubscribed" } });
  assert.match(unsub.message, /unsubscribed/);
  assert.doesNotMatch(unsub.message, /4255550100/);
  assert.match(ghlError({ method: "POST", path: "/conversations/messages", status: 429, data: {} }).message, /-> 429\b/);
});

test("a read that keeps failing stops after three tries, waiting what GHL asks", async () => {
  let tries = 0;
  globalThis.fetch = async () => { tries++; return reply(429, { message: "slow down" }, { "retry-after": "2" }); };
  const { c, waits } = client();
  await assert.rejects(c.call("/contacts/c1"), (e) => e.status === 429);
  assert.equal(tries, GHL_MAX_TRIES);
  assert.deepEqual(waits, [2000, 2000], "Retry-After, in seconds");
  assert.equal(retryAfterMs("120"), 120000);
  assert.equal(retryAfterMs(new Date(Date.now() + 3000).toUTCString(), Date.now()) > 1000, true);
  assert.equal(retryAfterMs(""), null);
});

test("a write is retried on a 429 only, and a 404 or a 400 is never retried", async () => {
  let tries = 0;
  globalThis.fetch = async () => { tries++; return tries === 1 ? reply(429, {}) : reply(200, { tags: ["x"] }); };
  const { c } = client();
  assert.deepEqual(await c.call("/contacts/c1/tags", { method: "POST", body: { tags: ["x"] } }), { tags: ["x"] });
  assert.equal(tries, 2);

  tries = 0;
  globalThis.fetch = async () => { tries++; return reply(502, {}); };
  await assert.rejects(c.call("/contacts/c1", { method: "PUT", body: {} }), (e) => e.status === 502);
  assert.equal(tries, 1, "a write that may have landed is not sent twice");

  tries = 0;
  globalThis.fetch = async () => { tries++; return reply(404, { message: "no such contact" }); };
  await assert.rejects(c.call("/contacts/gone"), (e) => e.status === 404);
  assert.equal(tries, 1);
});

test("the contact search is a read; the message send and every other post are not", () => {
  assert.equal(callKind("GET", "/contacts/x?y=1"), "read");
  assert.equal(callKind("POST", "/contacts/search"), "read");
  assert.equal(callKind("POST", "/conversations/messages"), "send");
  assert.equal(callKind("POST", "/conversations/messages/outbound"), "send");
  assert.equal(callKind("POST", "/contacts/"), "write");
  assert.equal(callKind("DELETE", "/contacts/c1/tags"), "write");
});

test("calls for one location take turns at about eight a second, and another location isn't held up", () => {
  _resetBuckets();
  const t0 = 1_000_000;
  const waits = Array.from({ length: 10 }, () => takeTurn("loc-a", { rate: 8, now: t0 }));
  assert.deepEqual(waits.slice(0, 8), [0, 0, 0, 0, 0, 0, 0, 0], "a burst of eight goes at once");
  assert.equal(waits[8], 125);
  assert.equal(waits[9], 250, "the next ones queue behind each other");
  assert.equal(takeTurn("loc-b", { rate: 8, now: t0 }), 0);
  assert.equal(takeTurn("loc-a", { rate: 8, now: t0 + 2000 }), 0, "two seconds later the bucket has refilled");
});
