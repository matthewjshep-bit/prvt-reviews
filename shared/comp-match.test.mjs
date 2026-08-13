// comp-match.test.mjs — the comp scorecard.
//
// The case that motivated most of this: a comp captured off Zillow while
// looking at a DIFFERENT deal used to score a perfect green chip, because the
// distance criterion abstained ("not knowable") and dropped out of the
// denominator — even though we had coordinates for both ends the whole time.
//
//   node --test comp-match.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { compareByMatch, matchLabel, matchTone, milesBetween, scoreComp } from "./comp-match.js";

const KENT = { lat: 47.3809, lng: -122.2348 };
const SPOKANE = { lat: 47.6588, lng: -117.426 };

const subject = { beds: 3, baths: 2, sqft: 1600, yearBuilt: 1990, ...KENT };
const recent = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

/* ---------------- distance ---------------- */

test("milesBetween: a known separation, and nulls when either end is missing", () => {
  const miles = milesBetween(KENT, SPOKANE);
  assert.ok(miles > 220 && miles < 240, `expected ~230 miles, got ${miles}`);
  assert.equal(milesBetween(KENT, KENT), 0);
  assert.equal(milesBetween(KENT, { lat: null, lng: null }), null);
  assert.equal(milesBetween(null, KENT), null);
});

test("the wrong-city comp no longer scores perfect", () => {
  const wrongCity = { beds: 3, baths: 2, sqft: 1650, yearBuilt: 1992, saleDate: recent, ...SPOKANE };

  // Without a distance the criterion abstains — this is the old behaviour, and
  // it is exactly why the bug was invisible.
  const blind = scoreComp(subject, wrongCity);
  assert.equal(blind.checks.find((c) => c.key === "distance").ok, null);
  assert.equal(matchLabel(blind), "5/5");
  assert.equal(matchTone(blind), "strong");

  // With the distance filled in, it fails loudly.
  const seeing = scoreComp(subject, { ...wrongCity, distance: Math.round(milesBetween(subject, wrongCity)) });
  assert.equal(seeing.checks.find((c) => c.key === "distance").ok, false);
  assert.equal(matchLabel(seeing), "5/6");
  assert.notEqual(matchTone(seeing), "strong");
});

test("a genuinely close comp still scores clean", () => {
  const nextStreet = {
    beds: 3, baths: 2, sqft: 1580, yearBuilt: 1991, saleDate: recent,
    lat: 47.3835, lng: -122.2361,
  };
  const miles = milesBetween(subject, nextStreet);
  assert.ok(miles < 1, `expected under a mile, got ${miles}`);
  const r = scoreComp(subject, { ...nextStreet, distance: miles });
  assert.equal(matchLabel(r), "6/6");
  assert.equal(matchTone(r), "strong");
});

/* ---------------- knowable-only denominator ---------------- */

test("missing data abstains rather than counting as a miss", () => {
  // A Zillow capture with no sold date — real: the Phinney Ave listing had none.
  const noDate = { beds: 3, baths: 2, sqft: 1600, yearBuilt: 1990, distance: 0.3 };
  const r = scoreComp(subject, noDate);
  assert.equal(r.checks.find((c) => c.key === "sold").ok, null);
  assert.equal(r.max, 5, "the unscoreable sold-date check must leave the denominator");
  assert.equal(r.score, 5);
});

test("a comp the provider knows nothing about scores '—' rather than zero", () => {
  const r = scoreComp(subject, { price: 400000 });
  assert.equal(r.max, 0);
  assert.equal(matchLabel(r), "—");
  assert.equal(matchTone(r), "unknown");
});

/* ---------------- individual criteria ---------------- */

test("baths tolerate a quarter-bath difference, beds do not", () => {
  assert.equal(scoreComp(subject, { baths: 2.5 }).checks.find((c) => c.key === "baths").ok, true);
  assert.equal(scoreComp(subject, { baths: 3 }).checks.find((c) => c.key === "baths").ok, false);
  assert.equal(scoreComp(subject, { beds: 4 }).checks.find((c) => c.key === "beds").ok, false);
});

test("era is +/-10 years", () => {
  assert.equal(scoreComp(subject, { yearBuilt: 2000 }).checks.find((c) => c.key === "year").ok, true);
  assert.equal(scoreComp(subject, { yearBuilt: 2001 }).checks.find((c) => c.key === "year").ok, false);
});

test("size is +/-20%", () => {
  assert.equal(scoreComp(subject, { sqft: 1920 }).checks.find((c) => c.key === "sqft").ok, true);
  assert.equal(scoreComp(subject, { sqft: 1921 }).checks.find((c) => c.key === "sqft").ok, false);
});

test("subdivision comparison survives provider spelling", () => {
  const s = { subdivision: "Maple Ridge Div 2" };
  assert.equal(scoreComp(s, { subdivision: "MAPLE RIDGE DIVISION 2" }).checks.find((c) => c.key === "subdivision").ok, true);
  assert.equal(scoreComp(s, { subdivision: "Cedar Park" }).checks.find((c) => c.key === "subdivision").ok, false);
});

/* ---------------- ordering ---------------- */

test("best match first, then closest", () => {
  const mk = (o) => ({ ...o, match: scoreComp(subject, o) });
  const far = mk({ beds: 3, baths: 2, sqft: 1600, yearBuilt: 1990, distance: 40, saleDate: recent });
  const near = mk({ beds: 3, baths: 2, sqft: 1600, yearBuilt: 1990, distance: 0.2, saleDate: recent });
  const weak = mk({ beds: 5, baths: 4, sqft: 3000, yearBuilt: 1960, distance: 0.1, saleDate: recent });
  const sorted = [far, weak, near].sort(compareByMatch);
  assert.equal(sorted[0], near, "the best match leads");
  assert.equal(sorted[2], weak, "a close but dissimilar comp ranks last");
});
