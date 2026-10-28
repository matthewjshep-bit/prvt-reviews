// investor-ratio.test.mjs — what investors actually pay, read from recorded sales.

import test from "node:test";
import assert from "node:assert/strict";
import { nameKey, isEntityName, singleParcelSales, flipPairs, dropRebuilds, ratioTable, investorPrice, openInvestorBuys } from "./investor-ratio.js";

const day = (s) => Date.parse(`${s}T00:00:00Z`);
const sale = (parcel, date, price, buyer, seller, excise = null) => ({ parcel, at: day(date), price, buyer, seller, excise });

test("the same company spelled three ways on three deeds is one buyer", () => {
  assert.equal(nameKey("ACME HOMES LLC"), nameKey("Acme Homes, L.L.C."));
  assert.equal(nameKey("ACME HOMES L L C"), "ACME HOMES");
  assert.notEqual(nameKey("ACME HOMES LLC"), nameKey("ACME HOLDINGS LLC"));
});

test("a company is an investor buyer and a family trust is not", () => {
  assert.ok(isEntityName("RAINIER REDEVELOPMENT LLC"));
  assert.ok(isEntityName("NW HOME INVESTMENTS INC"));
  assert.ok(!isEntityName("SMITH JOHN+JANE"));
  assert.ok(!isEntityName("SMITH FAMILY TRUST"));
});

test("a house bought and resold by the same company for more is a flip, at what they paid over what it sold for", () => {
  const pairs = flipPairs([
    sale("A", "2025-01-10", 400000, "ACME HOMES LLC", "ESTATE OF DOE"),
    sale("A", "2025-08-01", 650000, "BUYER PAT", "Acme Homes, LLC"),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].bought, 400000);
  assert.equal(pairs[0].sold, 650000);
  assert.equal(Math.round(pairs[0].ratio * 1000), 615);
});

test("a resale by someone else, a small gain, or a long hold isn't a flip", () => {
  const pairs = flipPairs([
    // someone else sold it on
    sale("B", "2025-01-10", 400000, "ACME HOMES LLC", "X"),
    sale("B", "2025-06-01", 600000, "Y", "OTHER PARTY"),
    // 5% gain
    sale("C", "2025-01-10", 400000, "ACME HOMES LLC", "X"),
    sale("C", "2025-06-01", 420000, "Y", "ACME HOMES LLC"),
    // two years on
    sale("D", "2023-01-10", 400000, "ACME HOMES LLC", "X"),
    sale("D", "2025-02-01", 650000, "Y", "ACME HOMES LLC"),
  ]);
  assert.deepEqual(pairs, []);
});

test("a deed covering several parcels for one price is left out of every parcel", () => {
  const rows = singleParcelSales([
    sale("A", "2025-01-10", 900000, "ACME", "X", "E1"),
    sale("B", "2025-01-10", 900000, "ACME", "X", "E1"),
    sale("C", "2025-01-10", 450000, "ACME", "X", "E2"),
  ]);
  assert.deepEqual(rows.map((r) => r.parcel), ["C"]);
});

test("a flip where the house went up after the buy is new construction, not a rehab", () => {
  const pairs = [
    { parcel: "A", boughtAt: day("2024-03-01"), soldAt: day("2025-02-01"), bought: 500000, sold: 1400000, ratio: 0.36 },
    { parcel: "B", boughtAt: day("2024-03-01"), soldAt: day("2024-11-01"), bought: 400000, sold: 620000, ratio: 0.65 },
    { parcel: "C", boughtAt: day("2024-03-01"), soldAt: day("2024-11-01"), bought: 300000, sold: 500000, ratio: 0.6 },
  ];
  const { kept, dropped } = dropRebuilds(pairs, new Map([["A", { yearBuilt: 2024, units: 1 }], ["B", { yearBuilt: 1962, units: 1 }]]));
  assert.deepEqual(kept.map((p) => p.parcel), ["B"]);
  assert.deepEqual(dropped.map((p) => [p.parcel, p.reason]), [["A", "built after the buy"], ["C", "no house on record"]]);
});

const flip = (parcel, soldOn, ratio) => ({ parcel, boughtAt: day(soldOn) - 1, soldAt: day(soldOn), bought: ratio * 1000, sold: 1000, ratio });

test("the investor price uses the ZIP's own ratio once it has five flips", () => {
  const zipOf = (p) => (p.startsWith("s") ? "98118" : "98052");
  const pairs = [
    ...[0.55, 0.56, 0.58, 0.6, 0.62].map((r, i) => flip(`s${i}`, "2026-05-01", r)),
    ...[0.7, 0.72].map((r, i) => flip(`r${i}`, "2026-05-01", r)),
  ];
  const table = ratioTable(pairs, { asOf: day("2026-10-01"), zipOf });
  assert.deepEqual(investorPrice({ arv: 600000, zip: "98118", table }), { price: 348000, ratio: 0.58, n: 5, basis: "zip" });
  // Two flips in 98052 isn't enough: the county ratio stands in.
  const thin = investorPrice({ arv: 600000, zip: "98052", table });
  assert.equal(thin.basis, "county");
  assert.equal(thin.n, 7);
});

test("flips resold after the as-of date or before the window don't count", () => {
  const pairs = [flip("a", "2026-05-01", 0.6), flip("b", "2026-11-01", 0.9), flip("c", "2023-01-01", 0.3)];
  const t = ratioTable(pairs, { asOf: day("2026-10-01") });
  assert.equal(t.county.n, 1);
  assert.equal(t.county.median, 0.6);
});

test("with no ARV or no flips there is no investor price", () => {
  const t = ratioTable([], { asOf: day("2026-10-01") });
  assert.equal(investorPrice({ arv: 600000, table: t }), null);
  assert.equal(investorPrice({ arv: 0, table: ratioTable([flip("a", "2026-05-01", 0.6)], { asOf: day("2026-10-01") }) }), null);
});

test("the answer key is a company's buy two to six months back that nobody has bought since", () => {
  const open = openInvestorBuys([
    sale("A", "2026-06-01", 410000, "ACME HOMES LLC", "DOE"),             // yes
    sale("B", "2026-09-20", 410000, "ACME HOMES LLC", "DOE"),             // too fresh
    sale("C", "2026-06-01", 410000, "SMITH PAT", "DOE"),                  // a person
    sale("D", "2026-03-01", 300000, "ACME HOMES LLC", "DOE"),
    sale("D", "2026-08-01", 520000, "SMITH PAT", "ACME HOMES LLC"),       // already resold
  ], { asOf: day("2026-10-01") });
  assert.deepEqual(open.map((o) => [o.parcel, o.bought]), [["A", 410000]]);
});

test("a company that has never flipped a house is left out of the answer key, since it may be a builder after the lot", () => {
  const sales = [
    sale("F", "2025-01-10", 400000, "ACME HOMES LLC", "DOE"),
    sale("F", "2025-08-01", 650000, "SMITH PAT", "ACME HOMES LLC"),
    sale("A", "2026-06-01", 410000, "Acme Homes, LLC", "DOE"),
    sale("B", "2026-06-01", 900000, "TALL TOWNHOMES LLC", "DOE"),
  ];
  const flippers = new Set(flipPairs(sales).map((p) => p.flipper));
  const open = openInvestorBuys(sales, { asOf: day("2026-10-01"), flippers });
  assert.deepEqual(open.map((o) => o.parcel), ["A"]);
});
