// row-feedback.test.mjs — "what should the bot have done?" on a Today row, recorded.
// Run: node --test row-feedback.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "row-feedback-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { recordRowFeedback } = await import("./row-feedback.js");
const { ROW_FEEDBACK_SENTINEL_CONTACT } = await import("./shared/row-feedback.js");
await store.init();
const LOC = "loc-row-feedback";

test("feedback on a draft row carries what they said and what the bot wrote, read from the draft not the client", async () => {
  const d = await store.createReplyDraft({ locationId: LOC, contactId: "c1", contactName: "Haleh C", party: "agent", intent: "scheduling", status: "handled",
    inbound: "Can you do Tuesday at 2?", reply: "", propertyAddress: "450 Overlake Dr E, Medina, WA 98039" });
  const r = await recordRowFeedback({ store, locationId: LOC, now: Date.parse("2026-09-22T18:00:00Z"), body: {
    rowId: "audit:unanswered_inbound:c1:2026-09-21T19:09:53", rowKind: "audit_owed", auditKind: "unanswered_inbound", draftId: d.id,
    category: "should_have_replied", note: "just offer two times", title: "Haleh C · 450 Overlake Dr E", detail: "scheduling — yours to answer",
    // the client's idea of the thread is ignored
    theySaid: "forged", botWrote: "forged", contactId: "c1",
  } });
  assert.equal(r.ok, true);
  assert.equal(r.recorded, true);
  assert.equal(r.feedback.label, "Should have replied itself");
  const rows = await store.listContactEvents(LOC, "c1", { types: ["row_feedback"] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.theySaid, "Can you do Tuesday at 2?");
  assert.equal(rows[0].data.intent, "scheduling");
  assert.equal(rows[0].data.party, "agent");
  assert.equal(rows[0].data.note, "just offer two times");
  assert.equal(rows[0].id, r.feedback.eventId, "the event id is what a lesson cites");
});

test("feedback on a row with no contact is kept under the Today sentinel and makes no contact profile", async () => {
  const r = await recordRowFeedback({ store, locationId: LOC, body: { rowId: "blast_no_opens:o9", rowKind: "blast_no_opens", category: "wrong_read", note: "" } });
  assert.equal(r.recorded, true);
  const rows = await store.listContactEvents(LOC, ROW_FEEDBACK_SENTINEL_CONTACT, { types: ["row_feedback"] });
  assert.equal(rows.length, 1);
  assert.equal(await store.getContactProfile(LOC, ROW_FEEDBACK_SENTINEL_CONTACT), null);
});

test("saving twice on one row keeps both and the newer wins", async () => {
  const body = { rowId: "promise_owed:o1", rowKind: "promise_owed", contactId: "c2", category: "should_have_acted", note: "send the number" };
  await recordRowFeedback({ store, locationId: LOC, body, now: Date.parse("2026-09-22T10:00:00Z") });
  await recordRowFeedback({ store, locationId: LOC, body: { ...body, category: "right_to_hand_over", note: "" }, now: Date.parse("2026-09-22T11:00:00Z") });
  const rows = await store.listContactEvents(LOC, "c2", { types: ["row_feedback"] });
  assert.equal(rows.length, 2);
  const { latestRowFeedback } = await import("./shared/row-feedback.js");
  assert.equal(latestRowFeedback(rows, { now: Date.parse("2026-09-22T12:00:00Z") }).get("promise_owed:o1").data.category, "right_to_hand_over");
});

test("a bad category, or no row, is a 400", async () => {
  await assert.rejects(() => recordRowFeedback({ store, locationId: LOC, body: { rowId: "x", category: "vibes" } }), (e) => e.http === 400);
  await assert.rejects(() => recordRowFeedback({ store, locationId: LOC, body: { category: "wrong_read" } }), (e) => e.http === 400);
});
