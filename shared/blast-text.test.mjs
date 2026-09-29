import test from "node:test";
import assert from "node:assert/strict";
import { blastMessage, blastNote, dealFacts } from "./blast-text.js";

test("a blast text names the street, the work, the buyer price in k, and no dollar sign or link", () => {
  const t = blastMessage({ firstName: "Ravi Patel", address: "22018 76th Ave W, Edmonds, WA 98026", city: "Edmonds", price: 495000, beds: 3, baths: 2, sqft: 1480, rehab: "moderate", variant: 0 });
  assert.equal(t, "Hey Ravi, got 22018 76th Ave W in Edmonds under contract — 3bd 2ba 1,480 sqft, moderate rehab. Buyer price 495k. Want the details?");
  assert.doesNotMatch(t, /\$|https?:/);
  for (const v of [1, 2, 3]) {
    const s = blastMessage({ address: "9 Elm St", price: 1250000, variant: v });
    assert.match(s, /9 Elm St/);
    assert.match(s, /1\.25M/);
  }
  assert.equal(blastMessage({ address: "9 Elm St", variant: 1 }), "Hey, new one: 9 Elm St, needs work. Interested?");
});

test("deal facts come off the offer, with the rehab level read from repairs against ARV", () => {
  const f = dealFacts({ address: "22018 76th Ave W, Edmonds, WA 98026", arv: 640000, repairs: 60000, subject: { beds: 3, baths: 2, sqft: 1480 } }, { price: 495000 });
  assert.equal(f.city, "Edmonds");
  assert.equal(f.rehab, "moderate");
  assert.equal(f.beds, 3);
  assert.equal(dealFacts({ address: "1 A St, Kent, WA", arv: 500000, repairs: 150000 }).rehab, "full_gut");
  assert.equal(dealFacts({ address: "1 A St" }).rehab, "");
});

// Dmitriy Kozlov, 2026-09-16: "got 23706 138th Dr SE in Snohomish under
// contract, moderate rehab. Buyer price 532k." Everything else about the
// house was on file and none of it was in the text.
const UNDERWRITTEN = {
  address: "23706 138th Dr SE, Snohomish, WA 98296",
  calc: { inputs: { arv: 735000, repairs: 85000 } },
  snapshot: { subjectInfo: { beds: 3, baths: 2.5, sqft: 1890, yearBuilt: 1978 } },
  deal: { contractPrice: 452000, assignmentFee: 80000 },
};

test("the property facts come from where the underwrite actually writes them", () => {
  const f = dealFacts(UNDERWRITTEN, { price: 532000 });
  assert.equal(f.beds, 3);
  assert.equal(f.baths, 2.5);
  assert.equal(f.sqft, 1890);
  assert.equal(f.yearBuilt, 1978);
  assert.equal(f.arv, 735000);
  assert.equal(f.repairs, 85000);
  assert.equal(f.rehab, "moderate");

  // The comps pane's own copy is read first, the same one the dataroom uses.
  const viaComps = dealFacts({ ...UNDERWRITTEN, snapshot: { comps: { result: { info: { beds: 4, sqft: 2400 } } }, subjectInfo: { beds: 3 } } }, { price: 1 });
  assert.equal(viaComps.beds, 4);

  // A rehab figure the offer never named adds up from the scope, so the text
  // and the dataroom quote one number.
  const scoped = dealFacts({ address: "1 A St, Kent, WA", calc: { inputs: { arv: 400000 } }, scope: [{ cost: 20000 }, { cost: 15000 }] }, { price: 1 });
  assert.equal(scoped.repairs, 35000);
});

test("the blast carries the house, the numbers a buyer may see, and never ours", () => {
  const f = dealFacts(UNDERWRITTEN, { price: 532000 });
  const t = blastMessage({ ...f, firstName: "Dmitriy Kozlov", variant: 0 });
  assert.equal(t, "Hey Dmitriy, got 23706 138th Dr SE in Snohomish under contract — 3bd 2.5ba 1,890 sqft, built 1978, " +
    "moderate rehab. Buyer price 532k, ARV around 735k, rehab about 85k. Want the details?");
  assert.doesNotMatch(t, /\$|https?:/, "carrier rules: no dollar signs, no links");
  // The two figures that would tell a buyer what we make.
  assert.doesNotMatch(t, /452|80k/, "the contract price and the fee are never in a blast");

  // Every fact is optional — an empty deal still sends what it used to.
  assert.equal(blastMessage({ address: "9 Elm St", price: 495000, variant: 0 }),
    "Hey, got 9 Elm St under contract, needs work. Buyer price 495k. Want the details?");
});

test("the operator's dataroom headline rides along, scrubbed", () => {
  const f = dealFacts(UNDERWRITTEN, { price: 532000, note: "Corner lot, tenant is out — see $ at http://x.co/a" });
  const t = blastMessage({ ...f, firstName: "Dmitriy", variant: 1 });
  assert.match(t, /Corner lot, tenant is out/);
  assert.doesNotMatch(t, /\$|http/);
  // Too long to be a line in a text: left out rather than truncated mid-word.
  assert.equal(blastNote("x".repeat(120)), "");
  assert.equal(blastNote(""), "");
});

test("with the buyer's own package link, the blast ends on the link instead of offering to send details", () => {
  const link = "https://deals.shepflips.com/d/tok123";
  const texts = [0, 1, 2].map((variant) => blastMessage({ firstName: "Alex", address: "7034 South K Street, Tacoma, WA", city: "Tacoma", price: 329000, arv: 499000, repairs: 45000, rehab: "moderate", variant, link }));
  for (const t of texts) {
    assert.match(t, /Buyer price 329k/);
    assert.ok(t.endsWith(link), t);
    assert.doesNotMatch(t, /Want the details\?|Say the word|\$/);
  }
  assert.equal(new Set(texts).size, 3, "the three phrasings still differ");
  // No link, no change: the text still asks.
  assert.match(blastMessage({ address: "9 Elm St", price: 495000, variant: 0 }), /Want the details\?$/);
});

// Matt, 2026-09-29: the point of a buyer text is getting them out to the
// house. With a walkthrough question the text ends on it, the link after.
test("a blast with a walkthrough question ends on it, then the package link", () => {
  const f = { firstName: "Rick R", address: "3511 NE 153rd St, Lake Forest Park, WA", city: "Lake Forest Park", price: 421000, arv: 849000, repairs: 200000, rehab: "heavy" };
  const t = blastMessage({ ...f, variant: 1, link: "https://deals.example/d/abc", ask: "Walkthrough is Sat Oct 3, 10am-12pm. Can you make it?" });
  assert.equal(t, "Hey Rick, new one in Lake Forest Park: 3511 NE 153rd St, heavy rehab. Buyer price 421k, ARV around 849k, rehab about 200k. Walkthrough is Sat Oct 3, 10am-12pm. Can you make it? Full package: https://deals.example/d/abc");
  for (const v of [0, 1, 2]) {
    const s = blastMessage({ ...f, variant: v, ask: "When could you get out to walk it?" });
    assert.match(s, /When could you get out to walk it\?$/);
    assert.doesNotMatch(s, /Want the details|Interested\?|send the package/);
  }
});
