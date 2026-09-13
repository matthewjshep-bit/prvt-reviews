// dispo-regions.test.mjs — market and strategy tags off a borrower list.

import test from "node:test";
import assert from "node:assert/strict";
import { regionFor, strategyFor, tagsForPurchases, marketsFromTags, citySlug, cityLabel } from "./dispo-regions.js";

test("cities land in their region; unknown WA is other-wa; out of state is null", () => {
  assert.equal(regionFor("KIRKLAND"), "eastside");
  assert.equal(regionFor("Lake Forest Park"), "north-king");
  assert.equal(regionFor("SEATAC"), "south-king");
  assert.equal(regionFor("UNIVERSITY PLACE"), "pierce");
  assert.equal(regionFor("YAKIMA"), "other-wa");
  assert.equal(regionFor("MURPHY", "TX"), null);
  assert.equal(citySlug("SEA TAC"), "seatac");
});

test("a 30-year maturity is a rental, a construction lender is a build, the rest are flips", () => {
  assert.equal(strategyFor({ lender: "Kiavi", amount: 400000, maturity: "2056-07-01", recordedAt: "2026-06-16" }), "rental");
  assert.equal(strategyFor({ lender: "Blueprint Capital", amount: 900000, recordedAt: "2026-06-16" }), "new-construction");
  assert.equal(strategyFor({ lender: "Rain City", amount: 3000000, maturity: "2027-01-01", recordedAt: "2026-06-16" }), "new-construction");
  assert.equal(strategyFor({ lender: "Kiavi", amount: 450000, maturity: "2027-01-01", recordedAt: "2026-06-16" }), "flip");
  assert.equal(strategyFor({ lender: "Eastside Funding LLC", amount: 300000 }), "flip");
});

test("every city an investor bought in is tagged, with its region, and out-of-state gets a state tag", () => {
  const r = tagsForPurchases([
    { city: "KIRKLAND", state: "WA", lender: "Kiavi", amount: 800000 },
    { city: "TACOMA", state: "WA", lender: "Rain City", amount: 300000 },
    { city: "BELLEVUE", state: "WA", lender: "Blueprint Capital", amount: 2000000 },
    { city: "EUGENE", state: "OR", lender: "Blackhawk", amount: 300000 },
  ]);
  assert.deepEqual(r.cities.sort(), ["bellevue", "kirkland", "tacoma"]);
  assert.deepEqual(r.regions.sort(), ["eastside", "pierce"]);
  assert.ok(r.tags.includes("dispo-city-kirkland"));
  assert.ok(r.tags.includes("dispo-region-eastside"));
  assert.ok(r.tags.includes("dispo-oos-or"));
  assert.ok(r.tags.includes("dispo-type-flip") && r.tags.includes("dispo-type-new-construction"));
  // Never a bare dispo-<city>: the feedback package would read it as a blast tag.
  assert.ok(!r.tags.includes("dispo-kirkland"));
});

test("a row with no address or city gets no tags", () => {
  assert.deepEqual(tagsForPurchases([{ city: "", state: "", lender: "Vontive", amount: 350000 }]).tags, []);
});

test("markets read back off synced tags, ignoring unrelated dispo tags", () => {
  const m = marketsFromTags(["investor", "dispo-seatac", "dispo-blast", "dispo-city-lake-forest-park", "dispo-region-north-king", "dispo-type-rental", "dispo-oos-tx", "dispo-region-bogus"]);
  assert.deepEqual(m, { cities: ["lake-forest-park"], regions: ["north-king"], types: ["rental"], states: ["TX"] });
  assert.equal(cityLabel("lake-forest-park"), "Lake Forest Park");
});
