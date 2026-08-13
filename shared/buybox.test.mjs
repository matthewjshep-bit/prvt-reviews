// buybox.test.mjs — investor buy-box matching.
//
// The failure this guards against: a dispositions search that returns three
// buyers when you have forty, because thirty-seven of them have a half-filled
// buy box and every empty field read as a rejection. Missing data has to
// abstain, and bands have to overlap rather than contain — otherwise the
// module quietly hides your best cash buyer the first time someone forgets to
// ask him what zip codes he works.
//
//   node --test buybox.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBuyboxFilters,
  buildBuyboxProfile,
  buyboxIsEmpty,
  matchBuybox,
  normalizeBuybox,
  normalizeQuery,
  num,
  queryChips,
  rehabRank,
  removeChip,
} from "./buybox.js";

const box = (over = {}) => ({
  areas: [], areasRaw: "", priceMin: null, priceMax: null,
  propertyTypes: [], lotMin: null, rehabAppetite: null, exclusions: "", ...over,
});

/* ---------------- parsing out of GHL ---------------- */

test("num: reads whatever a human or the model typed into a NUMERICAL field", () => {
  assert.equal(num(400000), 400000);
  assert.equal(num("400000"), 400000);
  assert.equal(num("$400,000"), 400000);
  assert.equal(num("400k"), 400000);
  assert.equal(num("1.2M"), 1200000);
  assert.equal(num(""), null);
  assert.equal(num(null), null);
  assert.equal(num("n/a"), null);
});

test("normalizeBuybox: flattened GHL fields in, typed buy box out", () => {
  const b = normalizeBuybox({
    buybox_areas: "Tacoma, Spanaway, 98444",
    buybox_price_min: "200000",
    buybox_price_max: "$400,000",
    buybox_property_types: "sfr, multi family",
    buybox_lot_min: "5000",
    rehab_appetite: "Heavy",
    buybox_exclusions: "no flood zones",
  });
  assert.deepEqual(b.areas, ["Tacoma", "Spanaway", "98444"]);
  assert.equal(b.priceMin, 200000);
  assert.equal(b.priceMax, 400000);
  assert.deepEqual(b.propertyTypes, ["sfr", "multi_family"]);
  assert.equal(b.lotMin, 5000);
  assert.equal(b.rehabAppetite, "heavy");
  assert.equal(b.exclusions, "no flood zones");
});

test("normalizeBuybox: values outside the closed vocabulary are dropped, not trusted", () => {
  const b = normalizeBuybox({ buybox_property_types: "sfr, duplex, warehouse", rehab_appetite: "whatever" });
  assert.deepEqual(b.propertyTypes, ["sfr"]);
  assert.equal(b.rehabAppetite, null);
});

test("buyboxIsEmpty: an untouched contact is flagged rather than matching everything", () => {
  assert.equal(buyboxIsEmpty(normalizeBuybox({})), true);
  assert.equal(buyboxIsEmpty(normalizeBuybox({ buybox_price_max: "400000" })), false);
});

/* ---------------- the abstention rule ---------------- */

test("an empty buy-box field never excludes the investor", () => {
  const m = matchBuybox(box(), { areas: ["Tacoma"], priceMax: 400000, propertyTypes: ["sfr"] });
  assert.equal(m.pass, true);
  assert.deepEqual(m.missed, []);
  assert.deepEqual(m.matched, []);
  assert.equal(m.score, 0, "nothing knowable means nothing earned — pass, but rank last");
});

test("a criterion the query never asked about is not scored either way", () => {
  const m = matchBuybox(box({ areas: ["Kent"], priceMin: 100000, priceMax: 200000 }), { areas: ["Kent"] });
  assert.deepEqual(m.matched, ["areas"]);
  assert.ok(m.abstained.includes("price"), "the query said nothing about price");
  assert.equal(m.score, 100);
});

test("strict mode turns an undocumented buy box into a non-fit", () => {
  const q = { areas: ["Tacoma"] };
  assert.equal(matchBuybox(box(), q).pass, true);
  assert.equal(matchBuybox(box(), q, { strict: true }).pass, false);
});

/* ---------------- areas ---------------- */

test("areas match on containment in either direction", () => {
  const b = box({ areas: ["Tacoma", "Spanaway", "98444"] });
  assert.equal(matchBuybox(b, { areas: ["98444"] }).pass, true, "zip stated in the buy box");
  assert.equal(matchBuybox(b, { areas: ["tacoma"] }).pass, true, "case-insensitive");
  assert.equal(matchBuybox(b, { areas: ["South Tacoma"] }).pass, true, "query is a superstring");
  assert.equal(matchBuybox(b, { areas: ["Everett"] }).pass, false, "a genuine contradiction does exclude");
});

test("punctuation and spacing in place names do not break the match", () => {
  const b = normalizeBuybox({ buybox_areas: "Federal Way; Auburn" });
  assert.equal(matchBuybox(b, { areas: ["federal  way"] }).pass, true);
});

/* ---------------- price ---------------- */

test("price bands overlap rather than contain", () => {
  const b = box({ priceMin: 200000, priceMax: 400000 });
  assert.equal(matchBuybox(b, { priceMin: 380000, priceMax: 450000 }).pass, true, "partial overlap is a fit");
  assert.equal(matchBuybox(b, { priceMin: 250000, priceMax: 300000 }).pass, true, "query inside the box");
  assert.equal(matchBuybox(b, { priceMin: 150000, priceMax: 600000 }).pass, true, "box inside the query");
  assert.equal(matchBuybox(b, { priceMax: 400000 }).pass, true, "open-ended low side");
  assert.equal(matchBuybox(b, { priceMin: 900000 }).pass, false, "no overlap at all");
  assert.equal(matchBuybox(b, { priceMax: 90000 }).pass, false);
});

test("a one-sided buy box is unbounded on the side it did not state", () => {
  assert.equal(matchBuybox(box({ priceMax: 400000 }), { priceMin: 50000, priceMax: 80000 }).pass, true);
  assert.equal(matchBuybox(box({ priceMin: 500000 }), { priceMax: 300000 }).pass, false);
});

test("normalizeQuery: a backwards price range is swapped, not discarded", () => {
  const q = normalizeQuery({ priceMin: 300000, priceMax: 200000 });
  assert.equal(q.priceMin, 200000);
  assert.equal(q.priceMax, 300000);
});

/* ---------------- rehab appetite ---------------- */

test("rehab appetite is a ceiling: a full-gut buyer takes a moderate deal, not vice versa", () => {
  assert.ok(rehabRank("full_gut") > rehabRank("moderate"));
  assert.equal(matchBuybox(box({ rehabAppetite: "full_gut" }), { rehabAppetite: "moderate" }).pass, true);
  assert.equal(matchBuybox(box({ rehabAppetite: "moderate" }), { rehabAppetite: "full_gut" }).pass, false);
  assert.equal(matchBuybox(box({ rehabAppetite: "cosmetic_only" }), { rehabAppetite: "cosmetic_only" }).pass, true);
});

/* ---------------- types + lot ---------------- */

test("property types match on any overlap", () => {
  const b = box({ propertyTypes: ["sfr", "multi_family"] });
  assert.equal(matchBuybox(b, { propertyTypes: ["multi_family"] }).pass, true);
  assert.equal(matchBuybox(b, { propertyTypes: ["condo", "sfr"] }).pass, true);
  assert.equal(matchBuybox(b, { propertyTypes: ["land"] }).pass, false);
});

test("the deal's lot must clear the investor's stated minimum", () => {
  const b = box({ lotMin: 5000 });
  assert.equal(matchBuybox(b, { lotMin: 7200 }).pass, true);
  assert.equal(matchBuybox(b, { lotMin: 5000 }).pass, true, "exactly at the minimum still qualifies");
  assert.equal(matchBuybox(b, { lotMin: 3000 }).pass, false);
});

/* ---------------- scoring + ordering ---------------- */

test("score counts knowable criteria only, so a sparse buy box is not punished", () => {
  const thorough = box({ areas: ["Tacoma"], priceMin: 200000, priceMax: 400000, propertyTypes: ["sfr"] });
  const sparse = box({ areas: ["Tacoma"] });
  const q = { areas: ["Tacoma"], priceMax: 350000, propertyTypes: ["sfr"] };
  assert.equal(matchBuybox(thorough, q).score, 100);
  assert.equal(matchBuybox(sparse, q).score, 100, "1/1 knowable, not 1/3");
});

test("applyBuyboxFilters: drops contradictions and orders the survivors best-first", () => {
  const investors = [
    { name: "Blank Slate", buybox: box() },
    { name: "Wrong City", buybox: box({ areas: ["Spokane"] }) },
    { name: "Partial Fit", buybox: box({ areas: ["Tacoma"], priceMin: 900000 }) },
    { name: "Strong Fit", buybox: box({ areas: ["Tacoma"], priceMin: 200000, priceMax: 400000, propertyTypes: ["sfr"] }) },
  ];
  const q = { areas: ["Tacoma"], priceMax: 350000, propertyTypes: ["sfr"] };
  const out = applyBuyboxFilters(investors, q);
  assert.deepEqual(out.map((i) => i.name), ["Strong Fit", "Blank Slate"]);
  assert.equal(out[0].match.matched.length, 3);
  assert.equal(out[0].match.score, 100);
  assert.equal(out[1].match.score, 0, "nothing knowable ranks last but still survives");
});

test("applyBuyboxFilters: more matched criteria beats fewer at the same score", () => {
  const investors = [
    { name: "One Criterion", buybox: box({ areas: ["Kent"] }) },
    { name: "Three Criteria", buybox: box({ areas: ["Kent"], priceMax: 400000, propertyTypes: ["sfr"] }) },
  ];
  const out = applyBuyboxFilters(investors, { areas: ["Kent"], priceMax: 350000, propertyTypes: ["sfr"] });
  assert.deepEqual(out.map((i) => i.name), ["Three Criteria", "One Criterion"]);
});

/* ---------------- profile text ---------------- */

test("buildBuyboxProfile: everything the ranker may reason about, bounded", () => {
  const text = buildBuyboxProfile({
    name: "Dana Reyes",
    tags: ["investor-active"],
    buybox: box({
      areas: ["Tacoma", "98444"], priceMin: 200000, priceMax: 400000,
      propertyTypes: ["multi_family"], lotMin: 5000, rehabAppetite: "heavy",
      exclusions: "no flood zones",
    }),
    lastConvoSummary: "Wants off-market duplexes, closes cash in 10 days.",
    lastConvoDate: "2026-07-30T00:00:00.000Z",
    dealHistory: "2026-08-10 | 2010 NE 54th St | passed — foundation",
  });
  assert.match(text, /Dana Reyes \[investor-active\]/);
  assert.match(text, /\$200,000–\$400,000/);
  assert.match(text, /Multi-family/);
  assert.match(text, /Heavy/);
  assert.match(text, /no flood zones/);
  assert.match(text, /2026-07-30/);
  assert.match(text, /2010 NE 54th St/);
});

test("buildBuyboxProfile: an empty investor still produces a usable line", () => {
  assert.equal(buildBuyboxProfile({}), "Unnamed investor");
});

test("buildBuyboxProfile: long histories are truncated to the char budget", () => {
  const dealHistory = Array.from({ length: 50 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")} | ${i} Long Street Name Ave | passed — a fairly wordy reason`).join("\n");
  const text = buildBuyboxProfile({ name: "Verbose", dealHistory }, { maxChars: 300 });
  assert.ok(text.length <= 300, `expected <=300 chars, got ${text.length}`);
});

/* ---------------- chips ---------------- */

test("queryChips: one removable chip per stated criterion", () => {
  const chips = queryChips({ areas: ["Tacoma"], priceMax: 400000, propertyTypes: ["multi_family"], rehabAppetite: "heavy" });
  assert.deepEqual(chips.map((c) => c.label), ["Tacoma", "up to $400,000", "Multi-family", "Heavy rehab"]);
});

test("removeChip: dropping a chip widens the query", () => {
  const q = normalizeQuery({ areas: ["Tacoma", "Kent"], priceMax: 400000 });
  assert.deepEqual(removeChip(q, { field: "areas", value: "Tacoma" }).areas, ["Kent"]);
  assert.equal(removeChip(q, { field: "price" }).priceMax, null);
});
