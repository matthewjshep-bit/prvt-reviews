// underwrite-retry.test.mjs — a house whose underwrite died on a provider's
// error is underwritten again, once, not passed (2026-11-23 audit, AH-2).
//
// 11-11 to 11-18 the Apify key was rejected and every auto-underwrite
// stopped early. The Today timer's retry worked from in-memory runs (gone
// after a deploy) and never retried a rejected key, so after the key was
// fixed most of those houses were never run again, and the Needs Matt clock
// passed some we had never priced.

import test from "node:test";
import assert from "node:assert/strict";
import { runTodayTimers } from "./today-timers.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { needsMattPassDue } from "./shared/needs-matt.js";

const NOW = Date.parse("2026-11-19T18:05:00Z");   // Thursday 10:05am Pacific
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const saved = { aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true, driver: { timers: { enabled: true } } }) };
const APIFY_401 = "stopped early — Zillow comps lookup failed (Apify 401)";
const stopped = (over = {}) => ({ id: "d1", locationId: "LOC", contactId: "c1", address: "18 Larch Ln, Kent, WA 98031", status: "draft", cashAmount: null, sends: [],
  createdAt: ago(5 * 24), autoUnderwrite: { jobId: "j-old", held: [APIFY_401], finishedAt: ago(5 * 24) }, ...over });
const keysGood = { keys: { apify: { ok: true, checkedAt: ago(1) } } };
const keysDead = { keys: { apify: { ok: false, status: 401, failingSince: ago(8 * 24) } } };

function fakeStore({ offers = [], keyHealth = keysGood } = {}) {
  const rows = [];
  const book = new Map(offers.map((o) => [o.id, structuredClone(o)]));
  return {
    book, events: rows,
    async listOffers() { return [...book.values()]; },
    async getOffer(id) { return book.has(id) ? structuredClone(book.get(id)) : null; },
    async updateOffer(id, doc) { book.set(id, structuredClone(doc)); return doc; },
    async getJobCursor(_l, name) { return name === "keyHealth" ? { doc: keyHealth } : null; },
    async listReplyDrafts() { return []; },
    async listContactEventsSince() { return []; },
    async listContactEvents(_l, contactId) { return rows.filter((e) => e.contactId === contactId); },
    async appendContactEvents(_l, contactId, add) {
      let inserted = 0;
      for (const r of add) { if (r.dedupeKey && rows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue; rows.push({ ...r, contactId }); inserted++; }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
  };
}
const spy = () => {
  const calls = [];
  return { calls, deps: { startUnderwrite: async (a) => { calls.push(a); return { job: { id: "j-new" } }; }, listUnderwriteJobs: () => [] } };
};
const run = (store, deps, now = NOW) => runTodayTimers({ locationId: "LOC", saved, store, deps, now });

test("a house whose underwrite died on a rejected key is underwritten again, not passed", async () => {
  const store = fakeStore({ offers: [stopped()] });
  const s = spy();
  // While the draft waits for its retry, the Needs Matt clock never passes it,
  // however long it has sat there.
  const need = { kind: "price", offerId: "d1", landedAt: ago(6 * 24), waitsRetry: true };
  assert.equal(needsMattPassDue(need, NOW), false);
  assert.equal(needsMattPassDue({ ...need, waitsRetry: false }, NOW), true, "without the hold it would have gone");

  const r = await run(store, s.deps);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0], { contactId: "c1", message: "", address: "18 Larch Ln, Kent, WA 98031", askingPrice: 0, replaceOfferId: "d1" });
  assert.equal(r.results.find((x) => x.offerId === "d1").status, "started");
  assert.ok(store.book.get("d1").autoUnderwrite.retriedAt, "stamped before it ran");
  // Once per row: the next pass leaves it, and the clock counts from the retry.
  await run(store, s.deps, NOW + 3 * 3600000);
  assert.equal(s.calls.length, 1);
  assert.equal(needsMattPassDue({ kind: "price", offerId: "d1", landedAt: ago(6 * 24), retriedAt: new Date(NOW).toISOString() }, NOW + 3 * 3600000), false);
});

test("a rejected key's house waits while the key is still dead", async () => {
  const s = spy();
  await run(fakeStore({ offers: [stopped()], keyHealth: keysDead }), s.deps);
  await run(fakeStore({ offers: [stopped()], keyHealth: {} }), s.deps);
  assert.equal(s.calls.length, 0, "no key check yet, or the key still rejected: not run");
});

test("a network failure on a stopped-early draft is retried without waiting on the key check", async () => {
  const s = spy();
  await run(fakeStore({ offers: [stopped({ autoUnderwrite: { held: ["stopped early — comps: fetch failed"] } })], keyHealth: {} }), s.deps);
  assert.equal(s.calls.length, 1);
});

test("a house that already has Matt's number, a later row, or a sent one is never underwritten again", async () => {
  const sameHouseOtherSpelling = "18 Larch Lane, Kent, WA";
  const cases = {
    "priced by hand": { id: "h1", contactId: "c1", address: sameHouseOtherSpelling, status: "draft", cashAmount: 410000, createdAt: ago(2 * 24) },
    "a later machine row": { id: "h2", contactId: "c9", address: sameHouseOtherSpelling, status: "draft", createdAt: ago(1 * 24), autoUnderwrite: { held: [] } },
    "a sent number": { id: "h3", contactId: "c9", address: sameHouseOtherSpelling, status: "sent", cashAmount: 380000, createdAt: ago(9 * 24), sends: [{ ts: ago(8 * 24) }], autoUnderwrite: { held: [] } },
    "a pass": { id: "h4", contactId: "c1", address: sameHouseOtherSpelling, status: "we_passed", createdAt: ago(9 * 24), autoUnderwrite: { held: [] } },
  };
  for (const [why, other] of Object.entries(cases)) {
    const s = spy();
    await run(fakeStore({ offers: [stopped(), { locationId: "LOC", sends: [], ...other }] }), s.deps);
    assert.equal(s.calls.length, 0, why);
  }
  // A different house on the same street is not the same house.
  const s = spy();
  await run(fakeStore({ offers: [stopped(), { id: "x1", locationId: "LOC", contactId: "c9", address: "20 Larch Ln, Kent, WA", status: "sent", cashAmount: 300000, sends: [{ ts: ago(2) }], createdAt: ago(3) }] }), s.deps);
  assert.equal(s.calls.length, 1);
});

test("an old stopped-early draft and one already retried are left to Matt", async () => {
  const s = spy();
  await run(fakeStore({ offers: [stopped({ createdAt: ago(30 * 24) })] }), s.deps);
  await run(fakeStore({ offers: [stopped({ autoUnderwrite: { held: [APIFY_401], retriedAt: ago(48) } })] }), s.deps);
  assert.equal(s.calls.length, 0);
});

test("an in-memory run that died on a rejected key is retried once the key is good, and stamps its row", async () => {
  const store = fakeStore({ offers: [stopped()] });
  const s = spy();
  const job = { id: "j-old", status: "error", error: "Zillow comps lookup failed (Apify 401)", finishedAt: ago(0.2), contactId: "c1", address: "18 Larch Ln, Kent, WA 98031", offerId: "d1" };
  await run(store, { ...s.deps, listUnderwriteJobs: () => [job] });
  assert.equal(s.calls.length, 1, "one run, not one for the job and one for its row");
  assert.ok(store.book.get("d1").autoUnderwrite.retriedAt);
  const dead = spy();
  await run(fakeStore({ offers: [], keyHealth: keysDead }), { ...dead.deps, listUnderwriteJobs: () => [job] });
  assert.equal(dead.calls.length, 0, "the key still rejected: not yet");
});
