import test from "node:test";
import assert from "node:assert/strict";
import {
  streetKey, hasHouseNumber, normalizeMentionedHouses, streetMentions, housesInText,
  addressAsk, asksForAddress, addressHint, housesAwaitingAddress,
} from "./mentioned-houses.js";

const TWO_MORE = "Got one on Pine St in Shelton too, a 1920s rambler, they want about 410K. " +
  "Also a house split into a triplex in Alder Street, around 720K";

test("a street with no number is still a street; prose is not", () => {
  assert.equal(streetKey("Pine St, Shelton"), "pine st");
  assert.equal(streetKey("Alder Street"), "alder st");
  assert.equal(streetKey("1412 Pine Street, Shelton, WA"), "pine st");
  assert.equal(streetKey("the Tacoma one"), "");
  assert.equal(hasHouseNumber("Pine St, Shelton"), false);
  assert.equal(hasHouseNumber("1412 Pine St"), true);
});

test("both streets an agent names in one text are found, with the town when they gave it", () => {
  assert.deepEqual(streetMentions(TWO_MORE).map((h) => h.address), ["Pine St, Shelton", "Alder Street"]);
});

test("ordinary words around 'way' and 'road' are not read as streets", () => {
  assert.deepEqual(streetMentions("I'm on my way, it's down the road on a quiet street"), []);
});

test("numbered addresses keep their numbers", () => {
  assert.deepEqual(streetMentions("Pine is 1412 Pine St Shelton and the triplex is 88 Alder St Shelton").map((h) => h.address),
    ["1412 Pine St, Shelton", "88 Alder St, Shelton"]);
});

test("the first-text house is left out, and a numbered spelling beats the bare street", () => {
  const got = housesInText({
    houses: [{ address: "Pine St, Shelton", sellerAsk: 410000, note: "rambler" }],
    message: "Still have 48 Cedar Hollow Rd too. Pine is 1412 Pine St by the way",
    except: ["48 Cedar Hollow Rd, Shelton, WA 98584"],
  });
  assert.deepEqual(got, [{ address: "1412 Pine St", sellerAsk: 410000, note: "rambler", from: "model", needsAddress: false }]);
});

test("the model's list is cleaned: no street, no entry", () => {
  assert.deepEqual(normalizeMentionedHouses([{ address: "her listing" }, { address: "  Pine  St ", sellerAsk: "410000.4" }, null]),
    [{ address: "Pine St", sellerAsk: 410000, note: "", from: "model" }]);
  assert.deepEqual(normalizeMentionedHouses("nope"), []);
});

test("the ask names each house the way a text would", () => {
  assert.equal(addressAsk([{ address: "Pine St, Shelton" }]), "What's the exact address on the Pine St one? I'll take a look.");
  assert.equal(addressAsk([{ address: "Pine St, Shelton" }, { address: "Alder Street" }]),
    "What are the exact addresses on the Pine St one and the Alder St one? I'll take a look at each.");
  assert.equal(asksForAddress("What's the address on that one?"), true);
  assert.equal(asksForAddress("Appreciate you thinking of me."), false);
});

test("the chase hint carries each house's ask and note", () => {
  assert.equal(addressHint([{ address: "Pine St, Shelton", sellerAsk: 410000, note: "rambler" }, { address: "Alder Street", sellerAsk: 0, note: "" }]),
    "Pine St, Shelton (asking 410K, rambler); Alder Street");
});

test("a house stops waiting once its number or an offer on it shows up", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");
  const at = "2026-10-13T19:30:00Z";
  const events = [
    { type: "house_mentioned", at, address: "Pine St, Shelton", data: { sellerAsk: 410000, note: "rambler" } },
    { type: "house_mentioned", at, address: "Alder Street", data: { sellerAsk: 720000, note: "triplex" } },
    { type: "house_mentioned", at: "2026-07-01T00:00:00Z", address: "Birch Ln", data: {} },
  ];
  assert.deepEqual(housesAwaitingAddress({ events, offers: [], now }).map((h) => h.address), ["Pine St, Shelton", "Alder Street"]);
  assert.deepEqual(housesAwaitingAddress({ events, offers: [{ address: "88 Alder St, Shelton, WA" }], now }).map((h) => h.address), ["Pine St, Shelton"]);
  const later = [...events, { type: "house_mentioned", at: "2026-10-13T20:00:00Z", address: "1412 Pine St, Shelton", data: {} }];
  assert.deepEqual(housesAwaitingAddress({ events: later, offers: [{ address: "88 Alder St" }], now }), []);
});

test("an office address in a signature is not a house", () => {
  assert.deepEqual(streetMentions("Thanks! Sam, Windermere, 1200 Main St, Suite 300, Shelton"), []);
  assert.deepEqual(streetMentions("Office: 55 Front St Ste 2"), []);
});
