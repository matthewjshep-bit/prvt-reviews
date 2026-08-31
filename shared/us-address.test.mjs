import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUsAddress, addressKey, addressQueryVariants, zillowUrl,
  parseUsAddress, splitUnit, stateAbbr,
} from "./us-address.js";

/* ---------- normalization ---------- */

test("the street segment is abbreviated, the city is left alone", () => {
  assert.equal(
    normalizeUsAddress("7525 166th Avenue Northeast, North Bend, Washington 98045"),
    "7525 166th Ave NE, North Bend, WA 98045"
  );
});

test("two spellings of the same house share a key", () => {
  assert.equal(
    addressKey("741 N 128th St, Seattle, WA 98133"),
    addressKey("741 North 128th Street, Seattle, Washington 98133")
  );
});

test("the variant ladder offers abbreviated, spelled-out and as-typed", () => {
  const v = addressQueryVariants("7525 166th Avenue NE, Redmond, Washington 98052");
  assert.equal(v[0], "7525 166th Ave NE, Redmond, WA 98052");
  assert.ok(v.includes("7525 166th Avenue NE, Redmond, WA 98052"));
  assert.equal(new Set(v).size, v.length, "no duplicates");
});

test("the Zillow slug uses USPS abbreviations", () => {
  assert.match(zillowUrl("741 North 128th Street, Seattle, WA 98133"), /741-N-128th-St-Seattle-WA-98133_rb/);
});

/* ---------- states ---------- */

test("a state is recognized by name or abbreviation, and nothing else is", () => {
  assert.equal(stateAbbr("Washington"), "WA");
  assert.equal(stateAbbr("wa"), "WA");
  assert.equal(stateAbbr("WA."), "WA");
  assert.equal(stateAbbr("District of Columbia"), "DC");
  assert.equal(stateAbbr("Wash"), "");
  assert.equal(stateAbbr(""), "");
});

/* ---------- pulling an address apart ---------- */

test("the ordinary form comes apart cleanly", () => {
  assert.deepEqual(parseUsAddress("14808 Larch Way, Lynnwood, WA 98087"), {
    houseNo: "14808", street: "Larch Way", unit: "", city: "Lynnwood", state: "WA", zip: "98087",
  });
});

test("a five-digit house number is not mistaken for a ZIP", () => {
  const p = parseUsAddress("14808 Larch Way");
  assert.equal(p.houseNo, "14808");
  assert.equal(p.zip, "");
});

test('"NE" on the street line is a direction, never Nebraska', () => {
  // The trap this parser exists to avoid: reading a state off the street
  // segment sends the geocode 1,500 miles east.
  const p = parseUsAddress("7525 166th Ave NE");
  assert.equal(p.state, "");
  assert.equal(p.street, "166th Ave NE");
});

test("a state glued to the city is still a state", () => {
  const p = parseUsAddress("14808 Larch Way, Lynnwood WA 98087");
  assert.equal(p.state, "WA");
  assert.equal(p.city, "Lynnwood");
});

test("a two-word state survives", () => {
  assert.equal(parseUsAddress("123 Main St, Albany, New York 12207").state, "NY");
});

test("a trailing country is dropped", () => {
  assert.equal(parseUsAddress("14808 Larch Way, Lynnwood, WA 98087, USA").zip, "98087");
});

test("the unit comes off the street line", () => {
  for (const [line, unit] of [
    ["14808 Larch Way #B", "#B"],
    ["14808 Larch Way Apt 3", "Apt 3"],
    ["14808 Larch Way, Unit 12", "Unit 12"],
    ["14808 Larch Way Suite 200", "Suite 200"],
    ["14808 Larch Way", ""],
  ]) {
    const p = splitUnit(line);
    assert.equal(p.unit, unit, line);
    assert.equal(p.street, "14808 Larch Way", line);
  }
});

test("a street with no house number keeps its whole name", () => {
  const p = parseUsAddress("Larch Way, Lynnwood, WA 98087");
  assert.equal(p.houseNo, "");
  assert.equal(p.street, "Larch Way");
});
