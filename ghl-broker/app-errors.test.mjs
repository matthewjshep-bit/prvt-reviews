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
