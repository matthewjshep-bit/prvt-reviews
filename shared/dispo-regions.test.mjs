// dispo-regions.test.mjs — market and strategy tags off a borrower list.

import test from "node:test";
import assert from "node:assert/strict";
import { regionFor, strategyFor, tagsForPurchases, marketsFromTags, citySlug, cityLabel, areaMatches, areaVerdict, readArea } from "./dispo-regions.js";

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

test("a mobile home buyer shows as mobile / manufactured, not dropped as an unknown type", () => {
  const m = marketsFromTags(["investor", "dispo-type-mobile-home", "dispo-source-fb-warei"]);
  assert.deepEqual(m.types, ["mobile-home"]);
});

test("a builder found off permits reads as new construction", () => {
  assert.deepEqual(marketsFromTags(["builder", "dispo-source-permits", "dispo-city-seattle"]).types, ["new-construction"]);
  assert.deepEqual(marketsFromTags(["dispo-type-new-construction", "builder"]).types, ["new-construction"]);
});

/* ---------- where a buyer said they buy, in their words (2026-11-09) ---------- */

// What went wrong: a buy box said "North Seattle", "Seattle area" or
// "Shoreline/North Seattle" and none of them matched a Seattle 98133 deal,
// because the match compared the whole phrase to a city name. And a box
// saying "West Seattle" matched nothing narrower than all of Seattle.

const place = (city, zip = "", state = "WA") => ({ city: citySlug(city), zip, region: regionFor(city, state), state });
const greenLake = place("Seattle", "98103");
const bitterLake = place("Seattle", "98133");
const bellevue = place("Bellevue", "98004");
const kent = place("Kent", "98031");

test("a buyer who said North Seattle gets a 98133 deal", () => {
  for (const said of ["North Seattle", "N Seattle", "north seattle only", "Shoreline/North Seattle", "Seattle 98133", "Seattle area", "Greater Seattle", "98133"]) {
    assert.equal(areaMatches(said, bitterLake), true, said);
  }
  assert.equal(areaMatches("West Seattle", bitterLake), false, "West Seattle is not 98133");
});

test("a neighbourhood is the city plus its ZIPs, and a region resolves before a city", () => {
  assert.equal(areaMatches("West Seattle", greenLake), false);
  assert.equal(areaMatches("Ballard", place("Seattle", "98107")), true);
  assert.equal(areaMatches("Ballard", kent), false);
  assert.equal(areaMatches("Snohomish County", place("Everett", "98201")), true, "the county, not the town of Snohomish");
  assert.equal(areaMatches("King County", bellevue), true);
  assert.equal(areaMatches("Eastside & South King", kent), true);
  assert.equal(areaMatches("Tacoma and Puyallup", kent), false);
  assert.equal(areaMatches("North Tacoma", place("Tacoma", "98403")), true);
  assert.equal(areaMatches("North Tacoma", bellevue), false);
  assert.equal(readArea("Shoreline/North Seattle").places.length, 2);
});

test("not, anything but and avoid rule a place out; a phrase that doesn't resolve abstains", () => {
  assert.equal(areaMatches("not Seattle", greenLake), false);
  assert.equal(areaMatches("Not a Seattle fan", greenLake), false);
  assert.equal(areaMatches("anything but Seattle/Tacoma", place("Tacoma", "98404")), false);
  assert.equal(areaMatches("avoid Kent", kent), false);
  assert.equal(areaMatches("not Seattle", kent), null, "saying no to Seattle says nothing about Kent");
  assert.equal(areaMatches("fixers with good bones", kent), null);
  assert.equal(areaMatches("anywhere", kent), null);
  assert.equal(areaMatches("Tacoma area", kent), null, "an area around a city never rules a deal out");
  assert.equal(areaMatches("Tacoma area", place("Tacoma", "98404")), true);
});

test("a town the map doesn't keep still matches a deal there, and says nothing about anywhere else", () => {
  const harborview = place("Quillcrest", "98999");
  assert.equal(areaMatches("Quillcrest", harborview), true);
  assert.equal(areaMatches("Quillcrest", kent), null);
  assert.equal(areaVerdict(["Quillcrest"], kent).elsewhere, false);
  assert.equal(areaMatches("Western WA", kent), null);
});

test("a place out of state never fits a Washington deal, and a city with its state is a place", () => {
  assert.equal(areaMatches("Oregon", kent), false);
  const v = areaVerdict(["Bend", "OR"], kent);
  assert.equal(v.elsewhere, true, JSON.stringify(v));
  assert.equal(areaVerdict(["Bend", "OR"], place("Bend", "97701", "OR")).fit?.kind, "city");
});

test("the verdict over every area: a fit, a refusal, everything elsewhere, or not sure", () => {
  assert.equal(areaVerdict(["West Seattle"], greenLake).elsewhere, true);
  assert.equal(areaVerdict(["West Seattle", "Ballard"], place("Seattle", "98107")).fit.kind, "neighborhood");
  assert.equal(areaVerdict(["West Seattle", "lots with alley access"], greenLake).elsewhere, false, "one phrase it can't read keeps it unsure");
  assert.equal(areaVerdict(["Seattle", "not Queen Anne"], place("Seattle", "98119")).refused, "not Queen Anne");
  assert.equal(areaVerdict("Seattle but not West Seattle", place("Seattle", "98116")).refused, "not West Seattle");
  assert.deepEqual(areaVerdict([], greenLake), { fit: null, refused: null, elsewhere: false, stated: 0, elsewhereLabels: [] });
  assert.equal(areaVerdict(["Kent"], { city: "", zip: "", region: null }).elsewhere, false, "a deal with no city can't be elsewhere");
});


// What went wrong (review, 2026-11-09): the region map lists a county's
// cities, not every town in it. A buyer who said "Pierce County" read as
// "elsewhere" for a Parkland deal, because Parkland isn't on the list, and
// that took a buyer who had bought in Parkland off the deal. A town the map
// doesn't place could be in any region, so a region says nothing about it.
test("a buyer who said Pierce County isn't ruled out of a town the region map doesn't list", () => {
  const parkland = place("Parkland", "98444");
  assert.equal(parkland.region, "other-wa");
  assert.equal(areaMatches("Pierce County", parkland), null);
  assert.equal(areaMatches("King County", parkland), null);
  assert.equal(areaMatches("South King", parkland), null);
  assert.equal(areaVerdict(["Pierce County"], parkland).elsewhere, false);
  assert.equal(areaVerdict(["Tacoma", "Pierce County"], parkland).elsewhere, false);
  // A town it does list still reads as the region it's in.
  assert.equal(areaMatches("Pierce County", kent), false);
  assert.equal(areaVerdict(["Pierce County"], kent).elsewhere, true);
  // A city by name still misses a town that isn't it.
  assert.equal(areaVerdict(["Tacoma"], parkland).elsewhere, true);
});

test("a buyer who said SW Seattle doesn't get a Green Lake deal", () => {
  for (const said of ["SW Seattle", "Southwest Seattle"]) {
    assert.equal(areaMatches(said, greenLake), false, said);
    assert.equal(areaMatches(said, place("Seattle", "98116")), true, said);
  }
});
