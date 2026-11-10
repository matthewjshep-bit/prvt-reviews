// price-golden.test.mjs — the offer engine against the golden set (audit 2026-11-09).
//
// The fixture (fixtures/price-golden.json) is 17 deals, 38 houses Matt priced by hand beside the
// machine's read, and 3 engine numbers that reached agents, from prod on 2026-11-09: ZIP, size,
// age and numbers only. Every "said" and "killerWords" line is invented words of the same meaning.
//
// Part 1 pins every formula as it works. Part 2 replays the deals and pairs. Part 3 is the fixes:
// the ones this branch built pass; the rest are `todo`, each naming the fix that will make it pass.
//
//   cd ghl-broker && node --test ../shared/price-golden.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { priceHouse, triageOf } from "./price-engine.js";
import { rehabFloor, MIN_REHAB, eraFor } from "./rehab-floor.js";
import { calculateOffers } from "./offer-calc.js";
import { measure } from "./price-scorecard.js";
import { calibrate } from "./calibration.js";
import { readsFrom } from "../ghl-broker/price-v2.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "price-golden.json"), "utf8"));
const SURE = (arv) => ({ arv, arvConfidence: 0.9, comps: [{ renovated: true }, { renovated: true }, { renovated: true }] });
const live = (id) => G.live.find((d) => d.id === id);
const readsOf = (d, { arv = d.matt.arv, rehab = 0, words = "" } = {}) => ({ sqft: d.sqft || 0, yearBuilt: d.yearBuilt || 0, zip: d.zip, homeType: d.homeType || "", bricked: SURE(arv), theirRepairs: rehab, said: words });

/* ---------------- Part 1: the formulas as they are ---------------- */

describe("every formula pin in the golden set passes", () => {
  // Matt, 2026-11-10 (decision 11): his medians x 1.3. Against what buyers paid our rehab ran 34% low.
  test("rehab floor: $91 a foot before 1950, $72 from 1950 to 1999, $46 from 2000, never under $60k", () => {
    assert.equal(eraFor(1949).psf, 91);
    assert.equal(eraFor(1950).psf, 72);
    assert.equal(eraFor(1999).psf, 72);
    assert.equal(eraFor(2000).psf, 46);
    assert.equal(rehabFloor({ sqft: 2000, yearBuilt: 1924 }).floor, 182000);
    assert.equal(rehabFloor({ sqft: 2000, yearBuilt: 1972 }).floor, 144000);
    assert.equal(rehabFloor({ sqft: 2000, yearBuilt: 2005 }).floor, 92000);
    assert.equal(rehabFloor({ sqft: 900, yearBuilt: 2005 }).floor, MIN_REHAB, "41.4k at $46 a foot is under the ballpark");
  });

  test("rehab floor: no year built is $72 a foot, no size is the $60k ballpark", () => {
    assert.equal(rehabFloor({ sqft: 2000 }).floor, 144000);
    const none = rehabFloor({ yearBuilt: 1924 });
    assert.equal(none.floor, 60000);
    assert.match(none.why, /no size on record/);
  });

  test("rehab floor: heavy words or a poor grade are $100 a foot, a gut $150, and a negation is not heavy", () => {
    assert.equal(rehabFloor({ sqft: 1500, yearBuilt: 1990, said: "had a fire last year" }).floor, 150000);
    assert.equal(rehabFloor({ sqft: 1500, yearBuilt: 1990, countyCondition: 2 }).tier, "heavy");
    assert.equal(rehabFloor({ sqft: 1500, yearBuilt: 1990, condition: 5 }).tier, "heavy");
    assert.equal(rehabFloor({ sqft: 1500, yearBuilt: 1990, said: "no water damage at all" }).tier, "age");
    assert.equal(rehabFloor({ sqft: 1500, yearBuilt: 1990, said: "it's a tear down" }).floor, 225000);
  });

  test("engine: investor price is 70% of ARV less rehab; walk-away less $15k and open less $30k, to $250", () => {
    const r = priceHouse({ sqft: 1500, yearBuilt: 1961, bricked: SURE(640000), scope: { total: 121234, photos: 20 } });
    assert.equal(r.rehab, 121000, "the scope beat the 108k floor, rounded to $500");
    assert.equal(r.investorPrice, 0.7 * 640000 - 121000);
    assert.equal(r.walkAway, 312000);
    assert.equal(r.open, 297000);
  });

  test("engine: the walk-away never tops 90% of list", () => {
    const r = priceHouse({ list: 300000, sqft: 1500, yearBuilt: 1961, bricked: SURE(640000) });
    assert.equal(r.walkAway, 270000);
  });

  test("engine: triage bands are 95 / 85 / 70 percent of their number, else the list", () => {
    assert.equal(triageOf({ walkAway: 95, sellerNumber: 100 }).triage, "hot");
    assert.equal(triageOf({ walkAway: 85, sellerNumber: 100 }).triage, "workable");
    assert.equal(triageOf({ walkAway: 70, sellerNumber: 100 }).triage, "long_shot");
    assert.equal(triageOf({ walkAway: 69, sellerNumber: 100 }).triage, "no_fit");
  });

  test("old path: the mao offer is pct of ARV less repairs less the fee", () => {
    const c = calculateOffers({ arv: 500000, repairs: 60000 }, { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000 }).offers.cash;
    assert.equal(c.amount, 285000);
  });

  test("scorecard: Matt's inputs are measured at the engine's own formula, 70% less rehab less $15k", () => {
    const m = measure({ v2: { walkAway: 300000, arv: 500000, rehab: 50000 }, outcome: { mattArv: 500000, mattRehab: 50000 } });
    assert.equal(m.walkVsMatt, 300000 / (0.7 * 500000 - 50000 - 15000));
  });

  test("calibration never lowers a rehab and never cuts ARV past 15%", () => {
    const c = calibrate({ calibration: { rehabFloorPsf: [{ beforeYear: 1950, psf: 80 }], arvHaircutPct: 40 }, arv: 500000, repairs: 200000, sqft: 1000, yearBuilt: 1920 });
    assert.equal(c.repairsAdd, 0);
    assert.equal(c.arvCutPct, 15);
  });
});

/* ---------------- Part 2: the golden deals and pairs ---------------- */

test("a deal that died on price or rehab prices at least 10% under its contract on the buyers' numbers", () => {
  for (const d of G.deals.filter((x) => x.outcome === "dead" && x.buyers?.arv && x.buyers?.rehab)) {
    const r = priceHouse(readsOf(d, { arv: d.buyers.arv, rehab: d.buyers.rehab }));
    assert.ok(r.walkAway <= d.contract * 0.9, `${d.id}: walk-away ${r.walkAway} vs contract ${d.contract}`);
  }
});

test("a manufactured home, a park home or a teardown is never grade A", () => {
  for (const d of G.deals.filter((x) => x.killerWords)) {
    const r = priceHouse(readsOf(d, { words: d.killerWords }));
    assert.equal(r.grade, "C", `${d.id}: ${r.reasons.join(" | ")}`);
  }
});

// 2026-11-09: 15 of 24 within 10%, 5 more than 10% over Matt. The 2026-11-10 floor (x1.3; Matt's own
// rehab ran low against what buyers paid too) moves the engine under him: 12 within, 3 over, 9 under.
// Over is the costly side, so that is the bar that must not slip back.
test("pairs: on the machine's own ARV, today's engine lands within 10% of Matt's inputs on half the houses and rarely 10% over", () => {
  const xs = G.pairs.filter((p) => p.sqft > 0 && p.machine.arv > 0 && p.matt.arv > 0).map((p) => {
    const e = priceHouse({ sqft: p.sqft, yearBuilt: p.yearBuilt || 0, comps: { arv: p.machine.arv, n: 4 }, ...(p.machine.rehab ? { scope: { total: p.machine.rehab, photos: 20 } } : {}) });
    return e.walkAway / (0.7 * p.matt.arv - p.matt.rehab - 15000) - 1;
  });
  const within = xs.filter((x) => Math.abs(x) <= 0.1).length;
  const over = xs.filter((x) => x > 0.1).length;
  assert.ok(within / xs.length >= 0.5, `${within} of ${xs.length} within 10%`);
  assert.ok(over <= 3, `${over} of ${xs.length} more than 10% over Matt's`);
});

test("every won deal's contract is within reach of the walk-away on Matt's own inputs",
  { todo: "needs Matt (BT-05): maoPct 70 and minFee 15k walk away 2-14% under all 5 winners; a verified-evidence maoPct would reach them" }, () => {
    for (const d of G.deals.filter((x) => x.outcome === "won")) {
      const r = priceHouse(readsOf(d, { rehab: d.matt.rehab }));
      assert.ok(r.walkAway >= d.contract, `${d.id}: walk-away ${r.walkAway} vs contract ${d.contract}`);
    }
  });

/* ---------------- Part 3: the fixes ---------------- */

test("the engine never opens above the seller's own number", () => {
  const c = live("cap-bound-unfinished-new-build");
  const r = priceHouse({ ...c.reads, sellerNumber: c.later.sellerNumber });
  assert.ok(r.open <= c.later.sellerNumber, `open ${r.open} vs the seller's ${c.later.sellerNumber}`);
  assert.ok(r.walkAway <= c.later.sellerNumber, `walk-away ${r.walkAway} vs the seller's ${c.later.sellerNumber}`);
  assert.equal(r.triage, "over_theirs", "a walk-away 1.4x their number is a wrong ARV, not a hot house");
});

test("a walk-away more than 10% over the seller's number means the ARV is wrong, not a hot house", () => {
  const c = live("off-market-inflated-comps");
  const r = priceHouse({ ...c.reads, homeType: "SINGLE_FAMILY" });
  assert.equal(r.triage, "over_theirs", `walk-away ${r.walkAway} against their ${c.reads.sellerNumber}`);
  assert.ok(r.misses.includes("arv"));
  assert.notEqual(r.grade, "A");
  assert.ok(r.walkAway <= c.reads.sellerNumber);
});

test("a walk-away held down by the list cap is not grade A", () => {
  const r = priceHouse(live("cap-bound-unfinished-new-build").reads);
  assert.equal(r.overList, true, "an uncapped walk-away over the list is a read to check");
  assert.notEqual(r.grade, "A", r.reasons.join(" | "));
});

test("a walk-away held down by the list cap still opens under it",
  { todo: "needs Matt (question 8, BT-02/UWP-22): open at the walk-away less the fee room when a cap binds" }, () => {
    const r = priceHouse(live("cap-bound-unfinished-new-build").reads);
    assert.ok(r.open < r.walkAway, `open ${r.open} = walk-away ${r.walkAway}: no room to move`);
  });

test("an unfinished new build is not a flip", () => {
  const c = live("cap-bound-unfinished-new-build");
  const r = priceHouse({ ...c.reads, said: c.later.said });
  assert.equal(r.grade, "C", r.reasons.join(" | "));
  assert.ok(r.killers.includes("new_build"));
  assert.ok(priceHouse({ ...c.reads, currentYear: 2026 }).killers.includes("new_build"), "built 2024: the year alone says so");
});

test("an agent's repair figure at or under the floor is not rehab evidence", () => {
  const c = live("thin-photos-agent-figure");
  const r = priceHouse({ ...c.reads, scope: null });
  assert.notEqual(r.grade, "A", r.reasons.join(" | "));
  assert.ok(r.misses.includes("rehab"));
});

test("a scope from under 8 photos that reads above the floor holds the grade instead of being dropped", () => {
  const c = live("thin-photos-agent-figure");
  const r = priceHouse(c.reads); // as it ran live: 1 photo scanned at 84k, the agent's own 60k
  assert.ok(r.rehab >= c.reads.scope.total, `rehab ${r.rehab}: the 84k scan was dropped`);
  assert.notEqual(r.grade, "A");
  // The same house's other runs read heavier; the heaviest of the last two weeks is kept.
  const kept = priceHouse({ ...c.reads, priorRehab: Math.max(...c.otherRunsRehab) });
  assert.equal(kept.rehab, Math.max(...c.otherRunsRehab));
});

test("four price-guessed comps from a widened ring are not a sure ARV", () => {
  // UW_MAX_ARV_COMPS is 4, so n >= 4 is the normal case; how far they reached has to count.
  const r = priceHouse({ sqft: 1320, yearBuilt: 1938, list: 420000, homeType: "SINGLE_FAMILY", comps: { arv: 584000, n: 4, listing: 0, radius: 1 }, scope: { total: 31000, photos: 28 } });
  assert.ok(r.misses.includes("arv"), r.reasons.join(" | "));
});

test("the engine reads the county's condition code when the county has one",
  { todo: "rehab floor re-seed (BT-04, needs Matt): feed King County's condition code through readsFrom" }, () => {
    const reads = readsFrom({ address: "1 Main St, Vashon, WA 98070", facts: { sqft: 2190, yearBuilt: 1994, countyCondition: 1 } });
    assert.equal(reads.countyCondition, 1);
  });

test("the engine reads the agent's own ARV and drops the grade when ours is more than 10% over it",
  { todo: "second ARV (BT-07, needs Matt, question 4): theirArv in readsFrom and an arv miss in priceHouse" }, () => {
    const c = live("thin-photos-agent-figure");
    const reads = readsFrom({ address: "1 Main St, Bend, OR 97702", events: [{ type: "agent_estimate", address: "1 Main St, Bend, OR 97702", at: "2026-11-07T01:51:00Z", data: { arv: c.agentArv, rehab: 60000 } }] });
    assert.equal(reads.theirArv, c.agentArv);
    const r = priceHouse({ ...c.reads, theirArv: c.agentArv });
    assert.ok(r.misses.includes("arv"), r.reasons.join(" | "));
  });

// The 2026-11-10 floor (x1.3) brought won-05 from 33% over to 23% over (rehab 120.5k to 157.5k on a
// 1994 house of 2,190 sqft); the other three won deals with a size sit 5.5-9% under. Still a todo:
// what's left is the house's own condition, and King County's condition code is not in this change.
test("a won deal is never priced more than 10% over its contract on the inputs we had then",
  { todo: "rehab floor re-seed from what buyers paid (BT-04, needs Matt): after the 11-10 x1.3 floor the age floor still prices the Vashon deal about 23% over; the county's condition code is the rest" }, () => {
    for (const d of G.deals.filter((x) => x.outcome === "won" && x.sqft)) {
      const r = priceHouse(readsOf(d, {}));
      assert.ok(r.walkAway <= d.contract * 1.1, `${d.id}: walk-away ${r.walkAway} vs contract ${d.contract} (rehab ${r.rehab}: ${r.rehabWhy})`);
    }
  });

/* ---------------- the fixture itself ---------------- */

// Memory no-contact-words-in-fixtures: a fixture never quotes an agent. Every free-text line is
// one of these invented ones; a new line has to be invented and added here on purpose.
const INVENTED = new Set([
  "",
  "a manufactured home that has been moved before",
  "sits in a 55+ community with monthly space rent",
  "more of a tear-down than a flip",
  "the build is maybe 85% done and the rest will cost around 400k",
]);
test("the golden fixture carries no words copied from a thread", () => {
  const lines = [...G.deals.map((d) => d.killerWords ?? ""), ...G.live.map((c) => c.later?.said ?? ""), ...G.live.map((c) => c.reads?.said ?? "")];
  for (const l of lines) assert.ok(INVENTED.has(l), `not an invented line: ${l.slice(0, 40)}`);
  assert.match(G._what, /invented words/);
  // No addresses, phones, emails or names: ZIP, size, age and numbers only.
  const text = JSON.stringify(G);
  assert.doesNotMatch(text, /\b\d{2,6}\s+(?:[NSEW]{1,2}\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:St|Ave|Rd|Dr|Ln|Ct|Pl|Way|Blvd|Ter|Loop|Cir)\b/, "a street address");
  assert.doesNotMatch(text, /\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/, "a phone number");
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/, "an email");
});
