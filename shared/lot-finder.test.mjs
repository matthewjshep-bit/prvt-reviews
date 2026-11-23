// lot-finder.test.mjs — the teardown lane's front end, the pure parts. Names
// and addresses are made up.

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLotFinder, pocketReady, propertySearchBody, ownerFromProperty, pickToTrace, traceLookupBody,
  phonesFromTrace, reachable, lotOwnerText, nextOwnerStep, lotOwnerTags, suggestPocket, OPEN_TEXTS, FOLLOW_TEXTS,
} from "./lot-finder.js";

const pocket = { id: "clyde-hill", name: "Clyde Hill", lat: 47.63, lng: -122.21, radiusMiles: 1, lotSqftMin: 30000, yearBuiltMax: 1980, yearsOwnedMin: 5, bandLo: 1900000, bandHi: 2300000 };

test("the finder ships off, dry, with texts waiting for Matt, and the settings come back the same twice", () => {
  const d = normalizeLotFinder(undefined);
  assert.equal(d.enabled, false);
  assert.equal(d.dryRun, true);
  assert.equal(d.autoSend, false);
  assert.deepEqual(d.pockets, []);
  const once = normalizeLotFinder({ enabled: true, dryRun: false, pockets: [{ name: "Clyde Hill", address: "1 Main St, Clyde Hill, WA", lat: "47.63", lng: "-122.21", lotSqftMin: "30000", bandLo: "1.9e6", bandHi: 2300000 }, { name: "Clyde Hill" }] });
  assert.equal(once.pockets.length, 1, "two pockets with the same name are one");
  assert.equal(once.pockets[0].id, "clyde-hill");
  assert.equal(once.pockets[0].bandLo, 1900000);
  assert.deepEqual(normalizeLotFinder(once), once);
});

test("a pocket is ready only with a center and a price band to say", () => {
  assert.equal(pocketReady(pocket), true);
  assert.equal(pocketReady({ ...pocket, bandLo: 0 }), false);
  assert.equal(pocketReady({ ...pocket, lat: 0 }), false);
  assert.equal(pocketReady({ ...pocket, enabled: false }), false);
});

test("the parcel search asks for old single-family houses on big lots, owned a while, inside the circle", () => {
  const b = propertySearchBody(pocket, { size: 100, resultIndex: 200 });
  assert.equal(b.property_type, "SFR");
  assert.equal(b.year_built_max, 1980);
  assert.equal(b.lot_size_min, 30000);
  assert.equal(b.years_owned_min, 5);
  assert.equal(b.radius, 1);
  assert.equal(b.size, 100);
  assert.equal(b.resultIndex, 200);
});

const record = { id: 123456, address: { street: "9 Lakeview Ln", city: "Clyde Hill", state: "WA", zip: "98004" }, mailAddress: { street: "PO Box 9", city: "Bellevue", state: "WA", zip: "98009" },
  owner1FirstName: "Pat", owner1LastName: "Example", yearBuilt: 1962, lotSquareFeet: 34000, squareFeet: 2300, lastSaleDate: "2009-05-01", lastSaleAmount: "900000", estimatedValue: 1800000, ownerOccupied: true, latitude: 47.63, longitude: -122.21 };

test("an owner row keeps the house, the owner of record and the teardown facts, and knows whether there's a person to look up", () => {
  const o = ownerFromProperty(record, pocket);
  assert.equal(o.ownerKey, "rapi:123456");
  assert.equal(o.pocketId, "clyde-hill");
  assert.equal(o.doc.house.street, "9 Lakeview Ln");
  assert.equal(o.doc.mail.city, "Bellevue");
  assert.equal(o.doc.person, true);
  assert.equal(o.doc.lotSqft, 34000);
  assert.equal(o.doc.lastSaleAmount, 900000);
  const llc = ownerFromProperty({ ...record, owner1FirstName: "", owner1LastName: "", companyName: "Lakeview Holdings LLC" }, pocket);
  assert.equal(llc.doc.person, false);
  assert.equal(ownerFromProperty({ address: {} }, pocket), null);
});

test("the trace picks new rows, people first, up to the day's cap, and looks a person up by name", () => {
  const rows = [
    { ownerKey: "a", status: "new", firstSeen: "2026-11-20", doc: { person: false, house: { street: "1 A St", city: "X", state: "WA" } } },
    { ownerKey: "b", status: "new", firstSeen: "2026-11-21", doc: { person: true, first: "Pat", last: "Example", house: { street: "2 B St", city: "X", state: "WA", zip: "98004" } } },
    { ownerKey: "c", status: "traced", firstSeen: "2026-11-19", doc: { person: true, house: { street: "3 C St" } } },
    { ownerKey: "d", status: "new", firstSeen: "2026-11-22", doc: { person: true, first: "Sam", last: "Sample", house: { street: "4 D St", city: "X", state: "WA" } } },
  ];
  const picked = pickToTrace(rows, { cap: 2 });
  assert.deepEqual(picked.map((r) => r.ownerKey), ["b", "d"]);
  assert.deepEqual(traceLookupBody(rows[1]), { address: "2 B St", city: "X", state: "WA", zip: "98004", find_owner: false, first_name: "Pat", last_name: "Example" });
  assert.deepEqual(traceLookupBody(rows[0]), { address: "1 A St", city: "X", state: "WA", find_owner: true });
});

test("only a cell that isn't on a do-not-call list, from someone who isn't a litigator, is reachable", () => {
  const result = { hit: true, persons: [
    { first_name: "Pat", litigator: false, phones: [{ number: "(206) 555-0142", type: "Mobile", dnc: false, rank: 2 }, { number: "2065550100", type: "Landline", dnc: false, rank: 1 }, { number: "2065550199", type: "Mobile", dnc: true, rank: 3 }] },
    { first_name: "Lee", litigator: true, phones: [{ number: "4255550101", type: "Mobile", dnc: false, rank: 1 }] },
    { first_name: "Gone", deceased: true, phones: [{ number: "4255550102", type: "Mobile", dnc: false, rank: 1 }] },
  ] };
  const phones = phonesFromTrace(result);
  assert.equal(phones.length, 4);
  assert.equal(phones[0].number, "+12065550142", "cells first, by rank");
  assert.deepEqual(reachable(phones).map((p) => p.number), ["+12065550142"]);
  assert.deepEqual(phonesFromTrace({ hit: false }), []);
});

test("every first text names the street and the price band, with no blank left over, and drops the greeting when there's no first name", () => {
  for (let i = 0; i < OPEN_TEXTS.length; i++) {
    const t = lotOwnerText({ step: "open", variant: i, first: "Pat", street: "9 Lakeview Ln, Clyde Hill, WA 98004", bandLo: 1900000, bandHi: 2300000 });
    assert.ok(t.includes("9 Lakeview Ln"), t);
    assert.ok(t.includes("1.9M") && t.includes("2.3M"), t);
    assert.doesNotMatch(t, /\$/, "no dollar signs in a text");
    assert.ok(t.includes("Pat"), t);
    assert.doesNotMatch(t, /[{}]/);
    assert.ok(t.length <= 300, `${t.length} chars`);
  }
  const noName = lotOwnerText({ step: "open", variant: 1, first: "", street: "9 Lakeview Ln", bandLo: 950000, bandHi: 1200000 });
  assert.doesNotMatch(noName, /[{}]/);
  assert.match(noName, /^This is Matt/);
  assert.ok(noName.includes("950k") && noName.includes("1.2M"));
  assert.equal(lotOwnerText({ step: "open", first: "Pat", street: "9 Lakeview Ln", bandLo: 0, bandHi: 0 }), "", "no band, no text");
  for (let i = 0; i < FOLLOW_TEXTS.length; i++) {
    const f = lotOwnerText({ step: "follow", variant: i, first: "Pat", street: "9 Lakeview Ln" });
    assert.doesNotMatch(f, /[{}]/);
    assert.ok(f.includes("9 Lakeview Ln"));
  }
});

test("the first text once imported, one follow-up a day after it went, then nothing; any answer stops it", () => {
  const T0 = Date.parse("2026-11-24T18:00:00Z");
  const imported = { type: "import", at: new Date(T0).toISOString() };
  assert.equal(nextOwnerStep({ events: [], now: T0 }).step, null);
  assert.equal(nextOwnerStep({ events: [imported], now: T0 }).step, "open");
  const queued = { type: "lot_owner_queued", at: new Date(T0 + 1000).toISOString(), data: { step: "open" } };
  assert.equal(nextOwnerStep({ events: [imported, queued], now: T0 + 3600000 }).step, null, "the draft hasn't gone yet");
  const sent = { type: "lot_owner_sent", at: new Date(T0 + 7200000).toISOString(), data: { step: "open" } };
  assert.equal(nextOwnerStep({ events: [imported, queued, sent], now: T0 + 7200000 + 3600000 }).step, null, "too soon for the follow-up");
  assert.equal(nextOwnerStep({ events: [imported, queued, sent], now: T0 + 7200000 + 90000000 }).step, "follow");
  const fq = { type: "lot_owner_queued", at: new Date(T0 + 90000000).toISOString(), data: { step: "follow" } };
  assert.match(nextOwnerStep({ events: [imported, queued, sent, fq], now: T0 + 200000000 }).why, /done/);
  const replied = { type: "lot_owner_replied", at: new Date(T0 + 8000000).toISOString() };
  assert.match(nextOwnerStep({ events: [imported, queued, sent, replied], now: T0 + 90000000 }).stop, /yours to call/);
  const opted = { type: "unsubscribed", at: new Date(T0 + 8000000).toISOString() };
  assert.match(nextOwnerStep({ events: [imported, queued, sent, opted], now: T0 + 90000000 }).stop, /opted out/);
});

test("an owner contact is tagged apart from agents and buyers, by pocket", () => {
  assert.deepEqual(lotOwnerTags(pocket), ["lot-owner", "lot-pocket-clyde-hill"]);
});

test("the pocket's numbers come off the new builds' lots and the teardowns that sold inside that band", () => {
  const s = suggestPocket({
    newBuilds: [{ price: 4100000, lotSqft: 43560, sqft: 6000 }, { price: 5250000, lotSqft: 32670, sqft: 7200 }, { price: 4600000, lotSqft: 32670, sqft: 6500 }],
    teardowns: [
      { price: 1050000, lotSqft: 34848, yearBuilt: 1971 }, { price: 1300000, lotSqft: 32670, yearBuilt: 1968 }, { price: 1300000, lotSqft: 42000, yearBuilt: 1963 },
      { price: 1350000, lotSqft: 34848, yearBuilt: 1974 }, { price: 1560000, lotSqft: 43560, yearBuilt: 1966 },
      { price: 700000, lotSqft: 9000, yearBuilt: 1990 },   // a small lot: out of the band
    ],
  });
  assert.equal(s.lotSqftMin, 29403);
  assert.equal(s.lotSqftMax, 47916);
  assert.equal(s.teardowns, 5);
  assert.equal(s.yearBuiltMax, 1980, "the newest teardown, 1974, rounded up to the decade");
  assert.equal(s.lotValue, 1300000);
  assert.equal(s.bandLo, 1300000);
  assert.equal(s.bandHi, 1350000);
  assert.equal(s.exitLo, 4100000);
  assert.equal(s.exitHi, 5250000);
});

test("a new build that sold reads as a builder lead: the exit, the lot buy before it, the builder the listing names or its agent", async () => {
  const { builderFromNewBuild, builderName, builderTags, builderOpener } = await import("./lot-finder.js");
  assert.equal(builderName("Another stunning home built by Mystery Homes LLC on a private acre"), "Mystery Homes LLC");
  assert.equal(builderName("Welcome to this Pacific Crest Homes masterpiece"), "Pacific Crest Homes");
  assert.equal(builderName("Beautiful remodel with a view"), "");
  const row = { address: "12 Summit Dr, Clyde Hill, WA 98004", price: 4600000, saleDate: "2026-06-10", lotSqft: 32670, sqft: 6500, yearBuilt: 2026 };
  const facts = { description: "Built by Mystery Homes, this 6,500 sqft estate…", sales: [{ date: "2026-06-10", price: 4600000 }, { date: "2023-09-01", price: 1100000 }, { date: "2001-03-01", price: 400000 }],
    agent: { name: "Ann Agent", phone: "(425) 555-0177", email: "" }, brokerage: "Example Realty" };
  const b = builderFromNewBuild({ row, facts, pocket: { id: "clyde-hill" }, now: Date.parse("2026-11-24T18:00:00Z") });
  assert.equal(b.builderKey, "nb:12-summit-dr-clyde-hill-wa-98004");
  assert.equal(b.doc.exitPrice, 4600000);
  assert.equal(b.doc.priorLotPrice, 1100000, "the sale before the exit, a year or more earlier and well under it");
  assert.equal(b.doc.priorLotDate, "2023-09-01");
  assert.equal(b.doc.builder, "Mystery Homes");
  assert.equal(b.doc.agent.phone, "+14255550177");
  assert.equal(b.doc.reach, "agent");
  const noBuilder = builderFromNewBuild({ row, facts: { ...facts, description: "Stunning new estate" }, pocket: { id: "x" } });
  assert.equal(noBuilder.doc.name, "Ann Agent (listing agent)");
  assert.equal(builderFromNewBuild({ row: { address: "", price: 0 } }), null);
  assert.deepEqual(builderTags({ id: "clyde-hill" }), ["investor", "builder", "dispo-type-new-construction", "dispo-source-builder-exits", "lot-pocket-clyde-hill"]);
  const t = builderOpener({ first: "Ann", exit: b.doc, lotStreet: "9 Lakeview Ln, Clyde Hill", assignAt: 1300000 });
  assert.equal(t, "Ann, Matt Shepherd here. Saw you sold 12 Summit Dr for 4.6M, looks like the lot ran 1.1M, congrats. I've got an off-market lot of similar size a few blocks away at 9 Lakeview Ln at 1.3M, fits the building envelope of the one you just did. Any interest?");
  assert.doesNotMatch(t, /\$/);
});

test("a house inside an enabled pocket, big and old enough, belongs to the lane; one outside, too small, too new or unknown doesn't", async () => {
  const { pocketFor, lotHold, milesApart, LOT_HOLD } = await import("./lot-finder.js");
  const p = { ...pocket, enabled: true };
  assert.ok(Math.abs(milesApart({ lat: 47.63, lng: -122.21 }, { lat: 47.63, lng: -122.19 }) - 0.93) < 0.05);
  assert.equal(pocketFor({ lat: 47.635, lng: -122.212, lotSqft: 34000, yearBuilt: 1962 }, [p])?.id, "clyde-hill");
  assert.equal(pocketFor({ lat: 47.70, lng: -122.21, lotSqft: 34000, yearBuilt: 1962 }, [p]), null, "outside the circle");
  assert.equal(pocketFor({ lat: 47.635, lng: -122.212, lotSqft: 9000, yearBuilt: 1962 }, [p]), null, "too small");
  assert.equal(pocketFor({ lat: 47.635, lng: -122.212, lotSqft: 34000, yearBuilt: 1995 }, [p]), null, "too new");
  assert.equal(pocketFor({ lat: 47.635, lng: -122.212, lotSqft: 0, yearBuilt: 1962 }, [p]), null, "no lot on record");
  assert.equal(pocketFor({ lat: 47.635, lng: -122.212, lotSqft: 34000, yearBuilt: 1962 }, [{ ...p, enabled: false }]), null, "pocket off");
  const h = lotHold(p, { lotSqft: 34000, yearBuilt: 1962 });
  assert.ok(LOT_HOLD.test(h));
  assert.match(h, /inside the Clyde Hill pocket \(34,000 sqft lot, built 1962\)/);
  assert.match(lotHold(null), /a homeowner the lot finder texted/);
});
