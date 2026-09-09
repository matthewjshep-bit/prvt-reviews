import test from "node:test";
import assert from "node:assert/strict";
import { blastMessage, dealFacts } from "./blast-text.js";

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
