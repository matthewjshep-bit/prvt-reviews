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
  fundingSaid,
  paysLine,
  buyerMoneyLine,
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

test("manufactured survives the buy box, however they wrote it", () => {
  // 2026-10-01: the vocabulary had no word for a mobile home, so a buyer who
  // said "I buy mobile homes" was filed as nothing at all.
  assert.deepEqual(normalizeBuybox({ buybox_property_types: "manufactured, sfr" }).propertyTypes.sort(), ["manufactured", "sfr"]);
  assert.deepEqual(normalizeBuybox({ buybox_property_types: "Mobile Home" }).propertyTypes, ["manufactured"]);
  const m = matchBuybox(normalizeBuybox({ buybox_property_types: "manufactured" }), { propertyTypes: ["manufactured"] });
  assert.deepEqual(m.matched, ["propertyTypes"]);
});

/* ---------------- how a buyer pays (2026-11-09) ---------------- */

// What went wrong: how a buyer pays was unknown in 283 of 307 buyer threads,
// though many had said it. A buyer took a contract and was still lining up
// money three days later. What they say is filed and shown on the deal.
test("how a buyer pays is read off their own words", () => {
  assert.equal(fundingSaid("We use hard money on these, close in 3 weeks"), "hard_money");
  assert.equal(fundingSaid("All cash, can close in 10 days"), "cash");
  assert.equal(fundingSaid("I'm a cash buyer"), "cash");
  assert.equal(fundingSaid("pulling it from my HELOC"), "heloc");
  assert.equal(fundingSaid("a private lender funds it"), "private_money");
  assert.equal(fundingSaid("my partners fund the deals"), "partners");
  assert.equal(fundingSaid("conventional loan, 20 down"), "conventional");
  assert.equal(fundingSaid("DSCR on the rentals"), "dscr");
  assert.equal(fundingSaid("cash or hard money depending"), "cash", "the first they named");
  assert.equal(fundingSaid("not a cash buyer, we use hard money"), "hard_money");
  assert.equal(fundingSaid("does it cash flow?"), null);
  assert.equal(fundingSaid("no hard money on this one"), null);
  assert.equal(fundingSaid(""), null);
});

// A question is theirs to ask, not how they pay: "do you take hard money?"
test("a buyer asking about money isn't filed as how they pay", () => {
  assert.equal(fundingSaid("Would the seller take hard money? Need to know before I look"), null);
  assert.equal(fundingSaid("Are you only working with cash buyers?"), null);
  assert.equal(fundingSaid("Is a HELOC ok? We close with hard money either way."), "hard_money");
});

// The book's row carries it, so Add to buy box never files a read's "how
// they pay" over one a person already set (shared/investor-read.js readFacts).
test("a buyer's row in the book knows how they pay", () => {
  assert.equal(normalizeBuybox({ buyer_funding: "hard_money" }).funding, "hard_money");
  assert.equal(normalizeBuybox({ buyer_funding: "seashells" }).funding, null);
  assert.equal(buyboxIsEmpty(normalizeBuybox({ buyer_funding: "cash" })), true, "how they pay isn't a buy box");
});

test("the deal row says how a buyer pays, or that we don't know", () => {
  assert.equal(paysLine({ value: "hard_money", at: "2026-10-30T19:00:00Z" }), "pays: hard money (said 10/30)");
  // The day is Pacific, wherever the page or the broker runs.
  assert.equal(paysLine({ value: "cash", at: "2026-10-31T03:00:00Z" }), "pays: cash (said 10/30)");
  assert.equal(paysLine({ value: "cash" }), "pays: cash");
  assert.equal(paysLine(null), "pays: unknown");
  assert.equal(paysLine({ value: "bitcoin" }), "pays: unknown");
});

// What went wrong: a buyer took a contract and was still lining up money
// three days later, and nothing on the deal said so.
test("a committed buyer with no proof of funds on the checklist says so on the deal row", () => {
  assert.equal(buyerMoneyLine({ value: "hard_money", at: "2026-10-30T19:00:00Z" }), "pays: hard money (said 10/30)");
  assert.equal(buyerMoneyLine(null, { committed: true }), "pays: unknown · no proof of funds on file");
  assert.equal(buyerMoneyLine({ value: "cash" }, { committed: true, proofOnFile: true }), "pays: cash");
  assert.equal(buyerMoneyLine({ value: "cash" }, { committed: false, proofOnFile: false }), "pays: cash", "only a commit asks for proof");
});

/* ---------------- Find buyers reads areas the way the deal sends do (2026-11-09) ---------------- */

// What went wrong: Find buyers on a deal compared the buy box's areas to the
// deal's city and ZIP as text, so a buyer who said "Eastside", "King County"
// or "East King" was dropped from a Bellevue deal, and one who said "West
// Seattle" was kept on a Green Lake deal because "seattle" is in the phrase.
const bellevueDeal = { city: "bellevue", zip: "98004", region: "eastside", state: "WA", rehabDeal: true };
const bellevueQuery = { areas: ["Bellevue", "98004"], priceMin: 850000, priceMax: 1150000 };

test("Find buyers keeps an Eastside buyer on a Bellevue deal", () => {
  const investors = [
    { name: "Eastside", buybox: box({ areas: ["Eastside"], areasRaw: "Eastside" }) },
    { name: "King County", buybox: box({ areas: ["King County"], areasRaw: "King County" }) },
    { name: "East King", buybox: box({ areas: ["East King"], areasRaw: "East King" }) },
    { name: "Tacoma", buybox: box({ areas: ["Tacoma"], areasRaw: "Tacoma" }) },
    { name: "Not Bellevue", buybox: box({ areas: ["Eastside", "not Bellevue"], areasRaw: "Eastside, not Bellevue" }) },
  ];
  const out = applyBuyboxFilters(investors, bellevueQuery, { deal: bellevueDeal });
  assert.deepEqual(out.map((i) => i.name).sort(), ["East King", "Eastside", "King County"]);
  // Without the deal (a typed search), areas still match as text, as before.
  assert.deepEqual(applyBuyboxFilters(investors, bellevueQuery).map((i) => i.name), ["Not Bellevue"]);
});

test("Find buyers leaves off a West Seattle buyer on a Green Lake deal, and one who isn't buying", () => {
  const greenLake = { city: "seattle", zip: "98103", region: "seattle", state: "WA", rehabDeal: true };
  const q = { areas: ["Seattle", "98103"] };
  const investors = [
    { name: "West Seattle", buybox: box({ areas: ["West Seattle"], areasRaw: "West Seattle" }) },
    { name: "Seattle", buybox: box({ areas: ["Seattle"], areasRaw: "Seattle" }) },
    { name: "Seattle, paused", buybox: box({ areas: ["Seattle"], areasRaw: "Seattle", exclusions: "not buying right now" }) },
    { name: "Seattle builder", buybox: box({ areas: ["Seattle"], areasRaw: "Seattle", exclusions: "no rehabs" }) },
  ];
  assert.deepEqual(applyBuyboxFilters(investors, q, { deal: greenLake }).map((i) => i.name), ["Seattle"]);
  const lot = { ...greenLake, rehabDeal: false };
  assert.deepEqual(applyBuyboxFilters(investors, q, { deal: lot }).map((i) => i.name).sort(), ["Seattle", "Seattle builder"]);
});
