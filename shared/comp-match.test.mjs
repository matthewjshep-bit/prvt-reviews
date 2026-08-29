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
import { compareByMatch, matchLabel, matchTone, mergeSelection, milesBetween, scoreComp } from "./comp-match.js";

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

/* ---------------- selection across a re-pull ---------------- */
//
// The bug: "Load comps" ended with setSelected(new Set(pre)), replacing the
// whole selection with the provider's fresh top six. Every Zillow capture got
// silently un-ticked, and since the server only persists comps whose id is in
// the selection, they never reached the offer or the comps PDF — while still
// sitting visibly on the board, so nothing looked wrong until you opened the
// PDF. Zillow captures are the expensive ones to lose: /comps/claim is
// read-and-delete, so a lost capture can't be re-fetched.

test("a re-pull never drops a Zillow capture or a manual comp", () => {
  const keep = ["z-101", "m-1"];                  // captured + manual on the board
  const previous = new Set(["z-101", "m-1", "p-old-1", "p-old-2"]);
  const next = mergeSelection(previous, keep, ["p-new-1", "p-new-2", "p-new-3"]);

  assert.ok(next.has("z-101"), "the Zillow capture stays ticked");
  assert.ok(next.has("m-1"), "the manual comp stays ticked");
  assert.ok(next.has("p-new-1"), "the fresh preselection is applied");
  assert.ok(!next.has("p-old-1"), "stale provider ids don't accumulate");
  assert.equal(next.size, 5);
});

test("repeated pulls don't accumulate stale provider ids", () => {
  const keep = ["z-1"];
  let sel = new Set(["z-1"]);
  sel = mergeSelection(sel, keep, ["p-a", "p-b"]);
  sel = mergeSelection(sel, keep, ["p-c"]);
  sel = mergeSelection(sel, keep, ["p-d"]);
  assert.deepEqual([...sel].sort(), ["p-d", "z-1"], "only the newest pull plus the keepers");
});

test("a pull that preselects nothing still keeps the hand-picked comps", () => {
  // bedBathRelaxed responses deliberately preselect nothing.
  const next = mergeSelection(new Set(["z-1", "p-1"]), ["z-1"], []);
  assert.deepEqual([...next], ["z-1"]);
});

test("mergeSelection takes arrays or Sets, and tolerates empties", () => {
  assert.deepEqual([...mergeSelection(new Set(["z-1"]), new Set(["z-1"]), ["p-1"])].sort(), ["p-1", "z-1"]);
  assert.deepEqual([...mergeSelection(null, null, null)], []);
  assert.deepEqual([...mergeSelection(new Set(["z-1"]), [], [])], [], "nothing to keep means nothing kept");
});

/* ---------------- condition by price proxy ---------------- */

import { markRenovatedByPrice, PRICE_PROXY_MIN_POOL } from "./comp-match.js";

// A tight comp set: same beds/baths, all within ±20% of 1,400 sqft.
const pool = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test("the top tier by $/sqft is marked renovated, the rest left unknown", () => {
  const comps = [
    { id: "a", price: 700000, sqft: 1400 },   // 500/sqft
    { id: "b", price: 672000, sqft: 1400 },   // 480
    { id: "c", price: 644000, sqft: 1400 },   // 460
    { id: "d", price: 560000, sqft: 1400 },   // 400
    { id: "e", price: 546000, sqft: 1400 },   // 390
    { id: "f", price: 532000, sqft: 1400 },   // 380
  ];
  const out = markRenovatedByPrice(comps, { take: 3 });
  assert.equal(out.applied, true);
  assert.equal(out.pool, 6);
  const byId = Object.fromEntries(out.comps.map((c) => [c.id, c]));
  assert.deepEqual(["a", "b", "c"].map((k) => byId[k].condition), ["renovated", "renovated", "renovated"]);
  // The losers are UNKNOWN, not "dated" — we have no evidence about them.
  for (const k of ["d", "e", "f"]) assert.equal(byId[k].condition, undefined);
});

test("it ranks by $/sqft, so the biggest house doesn't win on size alone", () => {
  // The 1,680 sqft comp has the highest PRICE but the lowest $/sqft. Ranking
  // on price would pick it; ranking on $/sqft must not.
  const comps = [
    { id: "big", price: 672000, sqft: 1680 },   // 400/sqft — top price
    { id: "nice", price: 630000, sqft: 1200 },  // 525/sqft — top $/sqft
    { id: "c", price: 560000, sqft: 1400 },     // 400
    { id: "d", price: 546000, sqft: 1400 },     // 390
    { id: "e", price: 532000, sqft: 1400 },     // 380
    { id: "f", price: 518000, sqft: 1400 },     // 370
  ];
  const out = markRenovatedByPrice(comps, { take: 1 });
  const won = out.comps.filter((c) => c.condition === "renovated").map((c) => c.id);
  assert.deepEqual(won, ["nice"]);
});

test("a pool too small to have a top tier refuses rather than pretending", () => {
  // Marking the best 3 of 4 comps "renovated" is circular — it just restates
  // which comps you have.
  const comps = pool(4, (i) => ({ id: String(i), price: 600000 + i * 1000, sqft: 1400 }));
  const out = markRenovatedByPrice(comps);
  assert.equal(out.applied, false);
  assert.equal(out.pool, 4);
  assert.match(out.reason, /needs 6 to have a top tier/);
  assert.deepEqual(out.comps, comps);                 // untouched
  assert.ok(out.comps.every((c) => c.condition === undefined));
});

test("exactly the minimum pool is enough", () => {
  const comps = pool(PRICE_PROXY_MIN_POOL, (i) => ({ id: String(i), price: 600000 + i * 10000, sqft: 1400 }));
  assert.equal(markRenovatedByPrice(comps).applied, true);
});

test("unpriced comps don't count toward the pool", () => {
  const comps = [
    ...pool(5, (i) => ({ id: String(i), price: 600000 + i * 10000, sqft: 1400 })),
    { id: "nop", price: 0, sqft: 1400 },
  ];
  const out = markRenovatedByPrice(comps);
  assert.equal(out.applied, false);
  assert.equal(out.pool, 5);
});

test("a comp with no sqft is ranked against the pool's typical size, not dropped", () => {
  const comps = [
    ...pool(5, (i) => ({ id: String(i), price: 500000, sqft: 1400 })),   // 357/sqft
    { id: "nosqft", price: 900000, sqft: 0 },                            // ranks at 900k/1400
  ];
  const out = markRenovatedByPrice(comps, { take: 1 });
  assert.equal(out.applied, true);
  assert.equal(out.comps.find((c) => c.id === "nosqft").condition, "renovated");
});

test("the mark says where it came from, so nothing mistakes it for a photo grade", () => {
  const comps = pool(6, (i) => ({ id: String(i), price: 600000 + i * 10000, sqft: 1400 }));
  const won = markRenovatedByPrice(comps, { take: 2 }).comps.filter((c) => c.condition);
  assert.equal(won.length, 2);
  for (const c of won) {
    assert.equal(c.conditionSource, "price");
    assert.equal(typeof c.ppsf, "number");
  }
});

test("take never exceeds the pool", () => {
  const comps = pool(6, (i) => ({ id: String(i), price: 600000 + i * 10000, sqft: 1400 }));
  const out = markRenovatedByPrice(comps, { take: 99 });
  assert.equal(out.comps.filter((c) => c.condition === "renovated").length, 6);
});

test("marking does not mutate the comps it was handed", () => {
  const comps = pool(6, (i) => ({ id: String(i), price: 600000 + i * 10000, sqft: 1400 }));
  const snapshot = JSON.parse(JSON.stringify(comps));
  markRenovatedByPrice(comps);
  assert.deepEqual(comps, snapshot);
});

test("the marked set feeds deriveArv's graded pool", async () => {
  // The contract that matters: deriveArv only switches to its graded pool when
  // it finds >= 2 renovated/updated comps. The proxy has to satisfy that.
  const { deriveArv } = await import("./arv.js");
  const comps = pool(6, (i) => ({ id: String(i), price: 500000 + i * 40000, sqft: 1400 }));
  const marked = markRenovatedByPrice(comps, { take: 4 }).comps;
  const arv = deriveArv({ comps: marked, subjectSqft: 1400 });
  assert.equal(arv.graded, true);
  assert.match(arv.basis, /renovated\/updated/);
  // The pool is 500k…700k in 40k steps; the top four are 580/620/660/700k.
  // deriveArv takes their MEDIAN — 640k — not the max. That is the whole
  // reason the proxy marks a tier rather than picking the single highest sale:
  // one optimistic comp can't set the ARV on its own.
  assert.equal(arv.arv, 640000);
});
