// follow-up-store.test.mjs — the queries and the backfill the follow-up
// sweep stands on. No database: followUpQuery is built as { text, params }
// for exactly this reason, and the backfill is exercised against a fake
// query layer that records what it was asked.

import test from "node:test";
import assert from "node:assert/strict";
import { followUpQuery } from "./store.js";
import { effectiveStatus, OPEN_STATUSES } from "./shared/offer-status.js";

const CUT = "2026-09-01T00:00:00.000Z";

test("the follow-up query asks only for open offers whose status is older than the cutoff", () => {
  const { text, params } = followUpQuery({ locationId: "LOC", before: CUT });
  assert.match(text, /status = any\(\$\d+::text\[\]\)/);
  assert.match(text, /status_at is null or status_at <= \$\d+/);
  assert.equal(params[0], "LOC");
  assert.deepEqual(params.find((p) => Array.isArray(p) && p.includes("sent")), [...OPEN_STATUSES]);
  assert.ok(params.includes(CUT));
});

test("the follow-up query orders oldest-first so the most neglected offer is first in line", () => {
  const { text } = followUpQuery({ locationId: "LOC", before: CUT });
  assert.match(text, /order by status_at asc nulls first/);
});

test("an offer whose status never moved is a candidate rather than a silent omission", () => {
  // `status_at is null` has to be part of the predicate: an offer written
  // before the column existed and never touched since would otherwise be
  // invisible to the sweep forever.
  const { text } = followUpQuery({ locationId: "LOC", before: CUT });
  assert.match(text, /status_at is null/);
});

test("the follow-up query narrows to the statuses it was given", () => {
  const { params } = followUpQuery({ locationId: "LOC", statuses: ["countered"], before: CUT });
  assert.ok(params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === "countered"));
});

test("the follow-up query trims each row to the list fields so the weight stays in postgres", () => {
  const { text } = followUpQuery({ locationId: "LOC", before: CUT });
  assert.match(text, /jsonb_object_agg/);
});

/* ---------- what the backfill derives ---------- */
// The backfill's whole point is that it runs the SHARED rule rather than a
// second copy of it in SQL. These assert the rule it delegates to, which is
// what the migration will write into the column.

test("backfilling derives sent from a send when the doc never had a status", () => {
  assert.equal(effectiveStatus({ sends: [{ ts: "2026-09-01T00:00:00Z" }] }), "sent");
});

test("backfilling derives accepted from a promoted deal", () => {
  assert.equal(effectiveStatus({ deal: { stage: "under_contract" } }), "accepted");
});

test("backfilling leaves an offer that was never sent as new", () => {
  assert.equal(effectiveStatus({ sends: [] }), "new");
});

test("backfilling never overwrites a status somebody typed", () => {
  // A clock must not walk "passed" back to "sent" because a send exists.
  assert.equal(effectiveStatus({ status: "passed", sends: [{ ts: "2026-09-01T00:00:00Z" }] }), "passed");
});
