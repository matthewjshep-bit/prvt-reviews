// row-feedback.test.mjs — the vocabulary for "what should the bot have done?"
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRowFeedback, latestRowFeedback, feedbackEvidenceId, publicRowFeedback, ROW_FEEDBACK, LEARNABLE_FEEDBACK } from "./row-feedback.js";

test("a category the app doesn't know is not feedback; a note is kept to 300 characters", () => {
  assert.equal(normalizeRowFeedback({ category: "vibes", note: "x" }), null);
  assert.equal(normalizeRowFeedback({ note: "a note with no category" }), null);
  assert.deepEqual(normalizeRowFeedback({ category: "Should Have Replied", note: "  it   knew the answer  " }), { category: "should_have_replied", note: "it knew the answer" });
  assert.equal(normalizeRowFeedback({ category: "wrong_read", note: "x".repeat(400) }).note.length, 300);
  assert.equal(ROW_FEEDBACK.length, 4);
  assert.equal(LEARNABLE_FEEDBACK.has("right_to_hand_over"), false, "handing it over is not a lesson");
});

test("two saves on one row: the newer one is what's read", () => {
  const ev = (id, at, category) => ({ id, type: "row_feedback", at, data: { rowId: "audit:unanswered_inbound:c1:2026-09-21T19:09", category, note: "" } });
  const m = latestRowFeedback([
    ev("e1", "2026-09-22T10:00:00Z", "wrong_read"),
    ev("e2", "2026-09-22T11:00:00Z", "should_have_replied"),
    { id: "e3", type: "text_summary", at: "2026-09-22T12:00:00Z", data: { rowId: "x" } },
    ev("old", "2026-09-01T11:00:00Z", "should_have_acted"),
  ], { since: "2026-09-08T00:00:00Z", now: Date.parse("2026-09-22T20:00:00Z") });
  assert.equal(m.size, 1);
  assert.equal(m.get("audit:unanswered_inbound:c1:2026-09-21T19:09").id, "e2");
  assert.deepEqual(publicRowFeedback(m.get("audit:unanswered_inbound:c1:2026-09-21T19:09")),
    { rowId: "audit:unanswered_inbound:c1:2026-09-21T19:09", category: "should_have_replied", label: "Should have replied itself", note: "", at: "2026-09-22T11:00:00Z", eventId: "e2" });
});

test("the evidence id names the event, not the row", () => {
  assert.equal(feedbackEvidenceId({ id: "e9", data: { rowId: "r1" } }), "fb:e9");
});
