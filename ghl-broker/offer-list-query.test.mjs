// offer-list-query.test.mjs — the SQL behind GET /api/offers.
//
// This exists because the query is assembled from strings, and the one thing
// string-assembled SQL gets wrong is the bind placeholders. A dropped "$" turns
// `any($2::text[])` into `any(2::text[])` and `limit $4` into `limit 4` — the
// first errors, the second silently returns four rows. Both would break the
// history page in a way no unit test of the projection itself would catch.
//
//   node --test offer-list-query.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { offerListQuery } from "./store.js";
import { OFFER_LIST_FIELDS } from "./shared/offer-status.js";

// Every $n in the statement, in the order it appears.
const placeholders = (text) => [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

test("every bound value gets a placeholder, and every placeholder a value", () => {
  for (const opts of [
    { locationId: "loc" },
    { locationId: "loc", lean: true },
    { locationId: "loc", contactId: "c1" },
    { locationId: "loc", contactId: "c1", lean: true, limit: 2000 },
  ]) {
    const { text, params } = offerListQuery(opts);
    const seen = placeholders(text);
    assert.ok(seen.length > 0, "the statement binds something");
    // $1 is the location, and the rest run 2..n with nothing skipped or reused.
    assert.deepEqual([...new Set(seen)].sort((a, b) => a - b),
      params.map((_, i) => i + 1), `placeholders match params for ${JSON.stringify(opts)}`);
    // A literal that lost its "$" would read as a bare number in the SQL.
    assert.doesNotMatch(text, /any\(\d/, "the key array is bound, not inlined");
    assert.doesNotMatch(text, /limit \d/, "the limit is bound, not inlined");
  }
});

test("lean asks Postgres for the trimmed doc; full asks for the whole one", () => {
  const lean = offerListQuery({ locationId: "loc", limit: 2000, lean: true });
  assert.match(lean.text, /jsonb_object_agg/);
  assert.deepEqual(lean.params[1], OFFER_LIST_FIELDS, "the keep-list is what gets bound");
  assert.equal(lean.params.at(-1), 2000);

  const full = offerListQuery({ locationId: "loc", limit: 50 });
  assert.doesNotMatch(full.text, /jsonb_object_agg/);
  assert.match(full.text, /select doc from offers/);
  assert.deepEqual(full.params, ["loc", 50]);
});

test("the contact filter is optional and always newest-first", () => {
  const all = offerListQuery({ locationId: "loc" });
  assert.doesNotMatch(all.text, /contact_id/);

  const one = offerListQuery({ locationId: "loc", contactId: "c1" });
  assert.match(one.text, /and contact_id = \$2/);
  assert.deepEqual(one.params, ["loc", "c1", 50]);

  for (const q of [all, one]) assert.match(q.text, /order by created_at desc/);
});
