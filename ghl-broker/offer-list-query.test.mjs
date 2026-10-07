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
import { offerListQuery, lastActivityQuery } from "./store.js";
import { OFFER_LIST_FIELDS, LEAN_CALC_SETTINGS, LEAN_CASH_FIELDS, leanOfferDoc, toListOffer } from "./shared/offer-status.js";
import { calculateOffers } from "./shared/offer-calc.js";

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

test("the last-activity read binds its types and its limit, and has no window", () => {
  for (const opts of [
    { locationId: "loc" },
    { locationId: "loc", types: ["text_summary", "call_summary"] },
    { locationId: "loc", types: ["text_summary"], limit: 100 },
  ]) {
    const { text, params } = lastActivityQuery(opts);
    const seen = placeholders(text);
    assert.deepEqual([...new Set(seen)].sort((a, b) => a - b), params.map((_, i) => i + 1));
    assert.doesNotMatch(text, /any\(\d/, "the type list is bound, not inlined");
    assert.doesNotMatch(text, /limit \d/, "the limit is bound, not inlined");
  }
  const q = lastActivityQuery({ locationId: "loc", types: ["text_summary"] });
  // One row per contact, newest first — the whole point of `distinct on`.
  assert.match(q.text, /distinct on \(contact_id\)/);
  assert.match(q.text, /order by contact_id, at desc/);
  // Unbounded on purpose: a window would make "never" and "not lately" the
  // same blank, which is exactly what the column has to tell apart.
  assert.doesNotMatch(q.text, /at >=/);
});

test("the contact filter is optional and always newest-first", () => {
  const all = offerListQuery({ locationId: "loc" });
  assert.doesNotMatch(all.text, /contact_id/);

  const one = offerListQuery({ locationId: "loc", contactId: "c1" });
  assert.match(one.text, /and contact_id = \$2/);
  assert.deepEqual(one.params, ["loc", "c1", 50]);

  for (const q of [all, one]) assert.match(q.text, /order by created_at desc/);
});

test("the file store trims a lean read the way Postgres does", () => {
  const doc = {
    id: "o1", locationId: "loc", cashAmount: 295000, status: "sent",
    calc: { inputs: { arv: 500000 }, settings: { aiApiKey: "sk-secret" } },
    snapshot: { subjectInfo: { homeType: "SINGLE_FAMILY" }, comps: { result: { big: true } } },
    scope: [{ id: "paint" }],
  };
  const row = leanOfferDoc(doc);
  // Only the list fields, plus the one derived key the SQL builds.
  for (const k of Object.keys(row)) assert.ok(OFFER_LIST_FIELDS.includes(k) || k === "subjectHomeType" || k === "calc" || k === "draftInputs", k);
  assert.equal(row.subjectHomeType, "SINGLE_FAMILY");
  assert.equal(row.snapshot, undefined);
  assert.equal(row.scope, undefined);
  assert.doesNotMatch(JSON.stringify(row), /sk-secret/);
});

// Every offer's ARV, repairs and list price live inside `calc`, which the lean
// trim drops. On the JSON store the full doc reached toListOffer and the bot
// saw them; on Postgres it never did, so since 2026-09-17 "show our work"
// could only ever describe the method (conversation-context.js).
test("an offer read off Postgres still knows its ARV, repairs, asking price and terms", () => {
  const calc = calculateOffers(
    { address: "12 Elm St", arv: 500000, repairs: 50000, askingPrice: 525000 },
    { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000, aiApiKey: "sk-secret" },
  );
  const full = { id: "o1", locationId: "loc", address: "12 Elm St", cashAmount: calc.offers.cash.amount, status: "sent", createdAt: "2026-10-01T00:00:00Z", calc };
  const row = toListOffer(leanOfferDoc(full));
  assert.equal(row.cashAmount, 295000);
  assert.equal(row.arv, 500000);
  assert.equal(row.repairs, 50000);
  assert.equal(row.askingPrice, 525000);
  assert.equal(row.terms?.earnestMoney, 2500);
  // A row stays a row: the calc it was read from doesn't ride along, and
  // nothing secret in the frozen settings ever leaves the database.
  assert.equal(row.calc, undefined);
  assert.doesNotMatch(JSON.stringify(row), /sk-secret|wholesaleFee|conversationAi/);

  // A held draft keeps its figures on the draft, not in a calc.
  const held = { id: "o2", locationId: "loc", address: "9 Oak St", status: "draft", cashAmount: null, createdAt: "2026-10-01T00:00:00Z",
    draft: { inputs: { address: "9 Oak St", arv: 640000, repairs: 80000, askingPrice: 599000 }, scope: [{ id: "paint" }] } };
  const hrow = toListOffer(leanOfferDoc(held));
  assert.equal(hrow.arv, 640000);
  assert.equal(hrow.repairs, 80000);
  assert.equal(hrow.askingPrice, 599000);
  assert.equal(hrow.draft, undefined);
});

test("the slice of calc a lean read keeps is an allowlist with nothing secret on it", () => {
  const lean = offerListQuery({ locationId: "loc", lean: true });
  assert.ok(lean.params.some((p) => p === LEAN_CALC_SETTINGS), "the settings keep-list is bound");
  assert.ok(lean.params.some((p) => p === LEAN_CASH_FIELDS), "the cash keep-list is bound");
  for (const k of ["wholesaleFee", "aiApiKey", "apifyToken", "compsApiKey", "conversationAi", "company", "breakdown", "components"]) {
    assert.ok(!LEAN_CALC_SETTINGS.includes(k) && !LEAN_CASH_FIELDS.includes(k), k);
  }
});
