import test from "node:test";
import assert from "node:assert/strict";
import {
  streetKey, hasHouseNumber, normalizeMentionedHouses, streetMentions, housesInText,
  addressAsk, asksForAddress, addressHint, housesAwaitingAddress, areaMentions, referralMention, referralKey, callWords, townIn, saidIn,
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

/* ---------- houses named with no street (2026-10-14) ---------- */

// Real threads: "I got one in Medina. I got 2 in Stanwood.", "a Federal Way
// duplex coming up", "two more parcels next to" a listing, "he wants to sell
// his flips". No street to put a number on; each is a lead all the same.

test("'some Stanwood houses' gets asked about by town", () => {
  const got = areaMentions("I've got some Stanwood houses that need a lot of work");
  assert.deepEqual(got.map((h) => [h.address, h.area, h.label, h.plural]), [["", "Stanwood", "the Stanwood houses", true]]);
  assert.equal(addressAsk(got), "What are the exact addresses on the Stanwood houses? I'll take a look at each.");
});

test("houses named only by town are each kept, one and several alike", () => {
  assert.deepEqual(areaMentions("Yeah, I got a lot. I got one in Medina. I got 2 in Stanwood.").map((h) => h.label),
    ["the Medina one", "the Stanwood ones"]);
  assert.deepEqual(areaMentions("I do have a Federal Way Duplex coming up that will need a ton of work").map((h) => h.label),
    ["the Federal Way duplex"]);
  assert.deepEqual(areaMentions("That's another one in maple valley that's pretty rough").map((h) => h.label), ["the Maple Valley one"]);
  assert.deepEqual(areaMentions("I have a new fixer going on in poulsbo, can send info later").map((h) => h.label), ["the Poulsbo fixer"]);
});

test("parcels next to a listing and an owner's flips are leads with no town", () => {
  assert.deepEqual(areaMentions("Two more parcels next to 5206 W Werner Rd are unlisted, same owner").map((h) => [h.area, h.label]),
    [["next to 5206 W Werner Rd", "the parcels next to 5206 W Werner Rd"]]);
  assert.deepEqual(areaMentions("He got a job out of state so he wants to sell his nearly finished flips asap").map((h) => h.label),
    ["the nearly finished flips"]);
});

test("a town in passing is not a house", () => {
  for (const t of [
    "I have a showing in Tacoma at 3",
    "It's a Lacey rambler with good bones",
    "I see another one in Renton on the MLS",
    "There are 70 active listings in the Sultan school district.",
    "We have 2 to 3 flips every week",
    "Do you buy in Everett?",
    "Liked “I have one in Duvall too”",
  ]) assert.deepEqual(areaMentions(t), [], t);
});

test("a 'Federal Way' with no number is the town, not a street to ask about", () => {
  assert.deepEqual(streetMentions("I do have a Federal Way Duplex coming up"), []);
  assert.deepEqual(housesInText({ message: "I do have a Federal Way Duplex coming up" }).map((h) => h.label), ["the Federal Way duplex"]);
});

test("the first-text house's town only counts when they say it's another one", () => {
  const ice = ["48 Cedar Hollow Rd, Shelton, WA 98584"];
  assert.deepEqual(housesInText({ message: "I have a Shelton property that needs work", except: ice }), []);
  assert.deepEqual(housesInText({ message: "I have another one in Shelton that needs work", except: ice }).map((h) => [h.address, h.label, h.needsAddress]),
    [["", "the Shelton one", true]]);
  assert.equal(townIn(ice[0]), "shelton");
});

test("a town the model lists with no street is a house to ask about too", () => {
  const got = housesInText({ houses: [{ address: "Mount Vernon", sellerAsk: 0, note: "flip, a few weeks out" }], message: "" });
  assert.deepEqual(got.map((h) => [h.label, h.note]), [["the Mount Vernon house", "flip, a few weeks out"]]);
});

test("a house named by town stays open until a numbered house in that town comes in after it", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");
  const named = { type: "house_mentioned", at: "2026-10-13T19:30:00Z", address: "", data: { area: "Stanwood", town: "Stanwood", label: "the Stanwood houses" } };
  assert.deepEqual(housesAwaitingAddress({ events: [named], now }).map((h) => h.label), ["the Stanwood houses"]);
  const elsewhere = { type: "house_mentioned", at: "2026-10-13T20:00:00Z", address: "12 Oak St, Everett", data: {} };
  assert.equal(housesAwaitingAddress({ events: [named, elsewhere], now }).length, 1);
  const there = { type: "house_mentioned", at: "2026-10-13T20:00:00Z", address: "12 Oak St, Stanwood", data: {} };
  assert.deepEqual(housesAwaitingAddress({ events: [named, there], now }), []);
  assert.equal(addressHint([{ address: "", label: "the Stanwood houses", sellerAsk: 0, note: "" }]), "the Stanwood houses");
});

/* ---------- a call's words ---------- */

test("on a call with speaker labels only their side is read", () => {
  assert.deepEqual(callWords("US: what about the one on Maple St?\nTHEM: I've got one in Duvall"), { words: "I've got one in Duvall", labelled: true });
  assert.deepEqual(callWords("Speaker 1: I've got one in Duvall"), { words: "Speaker 1: I've got one in Duvall", labelled: false });
});

test("a house the model lists from a call counts only when they said it", () => {
  const theirs = "I've got one in Duvall, and the other is 1412 Pine St";
  assert.equal(saidIn(theirs, "1412 Pine St, Shelton, WA"), true);
  assert.equal(saidIn(theirs, "Maple St"), false);
  assert.equal(saidIn(theirs, "Duvall"), true);
  assert.equal(saidIn("the 155th one needs a roof", "30651 155th Pl SE, Kent"), true);
});

/* ---------- a referral to someone else (2026-10-14) ---------- */

test("an agent who says 'contact Dana at Acme Realty, she has one' names a referral", () => {
  const r = referralMention("Contact Sara Example at John L Scott, she has one coming up: (555) 555-0100");
  assert.deepEqual({ ...r, phrase: undefined }, { name: "Sara Example", brokerage: "John L Scott", relation: "", phone: "(555) 555-0100", phrase: undefined });
  assert.equal(referralKey(r), "sara example");
});

test("a colleague holding the address, a partner who has the details, and a relative's client are referrals", () => {
  assert.equal(referralMention("All my buyers need to go through Evan Partnerly my business partner").name, "Evan Partnerly");
  assert.deepEqual(referralMention("If you could ping Tyler my dispo partner he can get you the details for maple"), {
    name: "Tyler", brokerage: "", relation: "", phone: "", phrase: "If you could ping Tyler my dispo partner he can get you the details for maple" });
  assert.equal(referralMention("If you can reach out to my partner Tyler at (555) 555-0101 he can assist.").relation, "partner");
  assert.equal(referralMention("Just told my husband about you and one of his clients has a place in Everett and she wants to sell.").relation, "husband's client");
  assert.equal(referralMention("One of my wholesale partners that shares commissions with me is also looking for you.").relation, "wholesale partner");
  assert.equal(referralMention("Dana Sample at Windermere has a fixer she's about to list").brokerage, "Windermere");
});

test("a name in passing is not a referral", () => {
  for (const t of [
    "Call me if you want to know more!",
    "I'm out of town, you can call my colleague Deidre with questions",
    "Liked “My partner Paul will be going out, thanks.”",
    "Chasing my partner down for the closing date and address",
    "Contact Information: Name: matt",
    "If you want to talk with Matt about it, sure",
    "The person that we contact there is Katie at escrow",
    "Talk to you tomorrow",
  ]) assert.equal(referralMention(t), null, t);
  assert.equal(referralMention("Call Pat Agent at Windermere if you need anything, she has one", { self: "Pat Agent" }), null, "their own signature");
});

// 2026-10-16: two runs priced the house the thread had been on while the
// agent's text was about a house on SE 188th St in Renton.
test("the street their text is about, when it isn't the house we were about to price", async () => {
  const { otherStreetIn } = await import("./mentioned-houses.js");
  assert.equal(otherStreetIn("Address - 129 39 SE 188th ST Renton - He is asking 650k", "311 R St NE, Auburn, WA 98002"), "SE 188th ST");
  assert.equal(otherStreetIn("talking to my friend about 12939 SE. - 188th St., Renton WA 98058", "715 141st St S, Tacoma, WA 98444"), "188th St, Renton");
  assert.equal(otherStreetIn("The one on Pine St in Shelton", "88 Alder St, Shelton, WA"), "Pine St, Shelton");
  // The same street, a cross street beside it, or no street at all: nothing.
  assert.equal(otherStreetIn("It needs a roof, the one at 715 141st St S", "715 141st St S, Tacoma, WA 98444"), "");
  assert.equal(otherStreetIn("4417 Somerset Ln, just off 41st St", "4417 Somerset Ln, Everett, WA 98203"), "");
  assert.equal(otherStreetIn("311 R St NE needs paint", "311 R St NE, Auburn, WA 98002"), "");
  assert.equal(otherStreetIn("Needs a new roof and the kitchen is gutted", "4417 Somerset Ln, Everett, WA 98203"), "");
});
