// app-errors.test.mjs — a failure is kept, counted, and carries nobody's details.
// Run: node --test app-errors.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "app-errors-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { recordError, scrubMessage, safeContext, fingerprintOf } = await import("./app-errors.js");

test("a phone number or an email in an error message never reaches the table", () => {
  assert.equal(scrubMessage(new Error("GHL 400: +1 (206) 555-0142 has unsubscribed")), "GHL 400: <phone> has unsubscribed");
  assert.equal(scrubMessage("no contact for dana@example.com"), "no contact for <email>");
});

test("context keeps ids and drops everything that could be somebody's words", () => {
  assert.deepEqual(
    safeContext({ contactId: "c1", jobId: "j1", message: "call me at 5", contactName: "Dana", transcript: ["x"], kind: "offer_nudge" }),
    { contactId: "c1", jobId: "j1", kind: "offer_nudge" });
});

test("the same failure on two contacts is one fingerprint; a different one is its own", () => {
  const a = fingerprintOf("reply", "no such draft 3f2b8a10-1111-2222-3333-444455556666");
  const b = fingerprintOf("reply", "no such draft 9c0d7e55-aaaa-bbbb-cccc-ddddeeeeffff");
  assert.equal(a, b);
  assert.notEqual(a, fingerprintOf("reply", "request timed out after 120000ms"));
  assert.notEqual(a, fingerprintOf("underwrite", "no such draft 1"));
});

test("a repeated failure counts up rather than piling up, and the night's errors can be read back", async () => {
  const t0 = Date.parse("2026-09-17T20:00:00Z");
  await recordError(store, { locationId: "LOC", area: "reply", err: new Error("request timed out after 120000ms"), context: { contactId: "c1" }, now: t0 });
  await recordError(store, { locationId: "LOC", area: "reply", err: new Error("request timed out after 90000ms"), context: { contactId: "c2" }, now: t0 + 60000 });
  await recordError(store, { locationId: "LOC", area: "sweep", err: "boom", now: t0 + 120000 });
  await recordError(store, { locationId: "OTHER", area: "sweep", err: "boom", now: t0 });
  const rows = await store.listAppErrorsSince("LOC", new Date(t0 - 1000).toISOString());
  assert.equal(rows.length, 2);
  const timeout = rows.find((r) => r.area === "reply");
  assert.equal(timeout.count, 2);
  assert.equal(timeout.context.contactId, "c2");
  assert.equal(timeout.firstAt, new Date(t0).toISOString());
  assert.equal((await store.listAppErrorsSince("LOC", new Date(t0 + 90000).toISOString())).length, 1);
});

// 2026-11-09 audit: GHL's own error text carries the lookup URL, so an email
// arrived as dana%40example.com and a phone as %2B1206..., which the
// scrubbers didn't read as either.
test("an error with a URL-encoded email in it is scrubbed before it's stored", async () => {
  const msg = "GHL GET /contacts/search/duplicate?locationId=L1&email=dana.fake%40example.com&number=%2B12065550142: 400 Bad Request";
  const s = scrubMessage(new Error(msg));
  assert.doesNotMatch(s, /dana|example|2065550142|%40|%2B/i, s);
  assert.match(s, /^GHL GET \/contacts\/search\/duplicate: 400 Bad Request$/);
  assert.equal(scrubMessage("no contact for dana.fake%40example.com"), "no contact for <email>");
  assert.equal(scrubMessage("who is this? call back"), "who is this? call back", "a question mark that isn't a query stays");
  const row = await recordError(store, { locationId: "LOC-SCRUB", area: "outreach", err: new Error(msg) });
  assert.doesNotMatch(JSON.stringify(row), /dana|example\.com|2065550142/);
  const [kept] = await store.listAppErrorsSince("LOC-SCRUB", "2000-01-01T00:00:00Z");
  assert.doesNotMatch(JSON.stringify(kept), /dana|example\.com|2065550142/);
});

test("an error that comes back after three quiet days is marked reopened; one that kept happening is not", async () => {
  const t0 = Date.parse("2026-10-01T20:00:00Z");
  const DAY = 86400000;
  await recordError(store, { locationId: "LOC-RE", area: "gmail", err: new Error("gmail token refresh: HTTP 401"), now: t0 });
  await recordError(store, { locationId: "LOC-RE", area: "gmail", err: new Error("gmail token refresh: HTTP 401"), now: t0 + 2 * DAY });
  let [row] = await store.listAppErrorsSince("LOC-RE", new Date(t0 - DAY).toISOString());
  assert.equal(row.reopenedAt ?? null, null, "two days apart is the same spell");
  await recordError(store, { locationId: "LOC-RE", area: "gmail", err: new Error("gmail token refresh: HTTP 401"), now: t0 + 5 * DAY + 60000 });
  [row] = await store.listAppErrorsSince("LOC-RE", new Date(t0 - DAY).toISOString());
  assert.equal(row.reopenedAt, new Date(t0 + 5 * DAY + 60000).toISOString(), "three quiet days, then back");
  assert.equal(row.firstAt, new Date(t0).toISOString());
  assert.equal(row.count, 3);
  await recordError(store, { locationId: "LOC-RE", area: "gmail", err: new Error("gmail token refresh: HTTP 401"), now: t0 + 5 * DAY + 120000 });
  [row] = await store.listAppErrorsSince("LOC-RE", new Date(t0 - DAY).toISOString());
  assert.equal(row.reopenedAt, new Date(t0 + 5 * DAY + 60000).toISOString(), "kept from when it came back");
});

test("recording an error never throws — not with a broken store, not with nothing", async () => {
  assert.equal(await recordError({ recordAppError: async () => { throw new Error("db down"); } }, { locationId: "LOC", area: "reply", err: "x" }), null);
  assert.equal(await recordError(null, {}), null);
  assert.equal(await recordError({}, { locationId: "LOC", area: "reply", err: "x" }), null);
});

test("coach proposals are kept, listed by status, and updated in place", async () => {
  const a = await store.createCoachProposal({ locationId: "LOC", kind: "example", dedupeKey: "k1", why: "you shortened it" });
  await store.createCoachProposal({ locationId: "LOC", kind: "rule", status: "rejected" });
  await store.createCoachProposal({ locationId: "OTHER", kind: "rule" });
  assert.equal(a.status, "open");
  assert.equal((await store.listCoachProposals("LOC")).length, 2);
  assert.deepEqual((await store.listCoachProposals("LOC", { status: "open" })).map((p) => p.id), [a.id]);
  const applied = await store.updateCoachProposal(a.id, { ...a, status: "applied" });
  assert.equal(applied.status, "applied");
  assert.equal((await store.getCoachProposal(a.id)).status, "applied");
  assert.equal(await store.updateCoachProposal("nope", {}), null);
});
