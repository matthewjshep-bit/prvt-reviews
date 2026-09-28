import test from "node:test";
import assert from "node:assert/strict";
import { addDismissal, removeDismissal, applyDismissals, isDismissed, rowSignature, TODAY_DISMISS_KEEP_DAYS } from "./today-dismiss.js";

const NOW = Date.parse("2026-09-28T20:00:00Z");
const closing = (d, extra = {}) => ({
  id: "closing_soon:offer-1415", kind: "closing_soon", severity: "soon",
  title: `1415 2nd St, Snohomish, WA 98290 closes in ${d}d`, detail: "buyer found", ...extra,
});

// 1415 2nd St, 2026-09-28: the closing row had no way off Today.
test("a closing row you dismissed stays off Today while only its countdown ticks", () => {
  const doc = addDismissal(null, closing(2), NOW);
  assert.equal(isDismissed(closing(2), doc, NOW), true);
  assert.equal(isDismissed(closing(1), doc, NOW + 86400000), true, "closes in 1d is the same row");
  const { actions, hidden } = applyDismissals([closing(1), { id: "gone_quiet:o2", kind: "gone_quiet", severity: "fyi", title: "x", detail: "" }], doc, NOW);
  assert.deepEqual(actions.map((a) => a.id), ["gone_quiet:o2"]);
  assert.equal(hidden.length, 1);
});

test("a dismissed row comes back when it says something new", () => {
  const doc = addDismissal(null, closing(2), NOW);
  assert.equal(isDismissed(closing(0, { severity: "now", title: "1415 2nd St was due to close 1d ago" }), doc, NOW), false, "overdue is news");
  assert.equal(isDismissed(closing(2, { detail: "under contract" }), doc, NOW), false, "a new stage is news");
});

test("Undo brings it back, and old dismissals are forgotten after a month", () => {
  const doc = addDismissal(null, closing(2), NOW);
  assert.equal(isDismissed(closing(2), removeDismissal(doc, closing(2).id), NOW), false);
  const later = NOW + (TODAY_DISMISS_KEEP_DAYS + 1) * 86400000;
  assert.equal(isDismissed(closing(2), doc, later), false);
  assert.deepEqual(addDismissal(doc, { id: "other", kind: "k" }, later).rows[closing(2).id], undefined, "pruned on the next write");
});

test("the doc keeps a fingerprint, never the row's words", () => {
  const doc = addDismissal(null, closing(2), NOW);
  assert.doesNotMatch(JSON.stringify(doc), /2nd St|buyer found/);
  assert.equal(rowSignature(closing(2)), doc.rows[closing(2).id].sig);
});
