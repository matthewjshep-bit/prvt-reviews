import test from "node:test";
import assert from "node:assert/strict";
import { porchcardStage, splitDealAddress, sameListing, porchcardListing, porchcardStep, PORCHCARD_MAX_PHOTOS } from "./porchcard-listing.js";

const ALL_PUBLIC = { summary: true, property: true, equity: true, photos: true };

const room = (over = {}) => ({
  id: "room-1",
  address: "1200 Example Avenue North, Tacoma, Washington 98406",
  snapshot: {
    property: { address: "1200 Example Avenue North, Tacoma, Washington 98406", beds: 3, baths: 2, sqft: 1500, yearBuilt: 1962, kind: "" },
    numbers: { investorPrice: 410000, arv: 620000, repairs: 70000 },
    notes: "A tidy rambler that needs a kitchen and a roof.",
    ...over,
  },
});
const deal = (stage, more = {}) => ({ id: "offer-1", address: "1200 Example Ave N, Tacoma, WA 98406", deal: { stage, contractPrice: 390000, ...more } });

test("a deal under contract or with a buyer is live, an assigned or closed one is done, a dead one is gone", () => {
  assert.equal(porchcardStage({ stage: "under_contract" }), "active");
  assert.equal(porchcardStage({ stage: "buyer_found" }), "active");
  assert.equal(porchcardStage({ stage: "assigned" }), "closed");
  assert.equal(porchcardStage({ stage: "closed" }), "closed");
  assert.equal(porchcardStage({ stage: "fell_through" }), "gone");
  assert.equal(porchcardStage(null), null);
});

test("a spelled-out deal address splits into the street, city, two-letter state and ZIP Porchcard asks for", () => {
  assert.deepEqual(splitDealAddress("1200 Example Avenue North, Tacoma, Washington 98406"),
    { address: "1200 Example Avenue North", city: "Tacoma", state: "WA", zip: "98406" });
  assert.deepEqual(splitDealAddress("88 Sample Pl SE, Bellevue, WA 98006"),
    { address: "88 Sample Pl SE", city: "Bellevue", state: "WA", zip: "98006" });
});

test("a listing put up by hand with the short spelling is the same house as the deal's long spelling", () => {
  assert.equal(sameListing({ address: "1200 Example Ave N", zip: "98406" }, "1200 Example Avenue North, Tacoma, Washington 98406"), true);
  assert.equal(sameListing({ address: "1200 Example Ave N", zip: "98103" }, "1200 Example Avenue North, Tacoma, Washington 98406"), false);
  assert.equal(sameListing({ address: "1202 Example Ave N", zip: "98406" }, "1200 Example Avenue North, Tacoma, Washington 98406"), false);
});

test("a live deal goes up at the buyer price with ARV, rehab and the room's description", () => {
  const r = porchcardListing({ offer: deal("buyer_found"), room: room(), sections: ALL_PUBLIC });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields, {
    address: "1200 Example Avenue North", city: "Tacoma", state: "WA", zip: "98406",
    beds: 3, baths: 2, sqft: 1500, year_built: 1962, status: "active",
    price: 410000, arv: 620000, rehab: 70000, description: "A tidy rambler that needs a kitchen and a roof.",
  });
});

test("a room that hides its numbers or its summary doesn't publish them on Porchcard either", () => {
  const r = porchcardListing({ offer: deal("under_contract"), room: room(), sections: { photos: true, property: true } });
  assert.equal(r.ok, true);
  assert.equal(r.fields.arv, undefined);
  assert.equal(r.fields.rehab, undefined);
  assert.equal(r.fields.description, undefined);
  assert.equal(r.fields.price, 410000);
});

test("a room that keeps its photos private isn't put on Porchcard, since a listing with no photo never shows", () => {
  const r = porchcardListing({ offer: deal("buyer_found"), room: room(), sections: { ...ALL_PUBLIC, photos: false } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /photos private/);
});

test("a closed deal shows the contract price and plain facts, never the ARV, rehab or the pitch", () => {
  const r = porchcardListing({ offer: deal("closed"), room: room(), sections: ALL_PUBLIC });
  assert.equal(r.ok, true);
  assert.equal(r.fields.status, "closed");
  assert.equal(r.fields.price, 390000);
  assert.equal(r.fields.arv, undefined);
  assert.equal(r.fields.rehab, undefined);
  assert.equal(r.fields.description, "Closed. A 1962 3 bed / 2 bath, 1,500 sq ft home in Tacoma. Found off-market and assigned to an investor buyer.");
});

test("land goes up with no beds or baths and no price per square foot", () => {
  const land = room({ property: { address: "88 Sample Pl SE, Bellevue, WA 98006", kind: "Land", sqft: 64000 } });
  const r = porchcardListing({ offer: deal("under_contract"), room: land, sections: ALL_PUBLIC });
  assert.equal(r.ok, true);
  assert.equal(r.fields.beds, 0);
  assert.equal(r.fields.baths, 0);
  assert.equal(r.fields.show_price_per_sqft, false);
});

test("a deal missing what Porchcard requires says what's missing instead of sending a half listing", () => {
  const bare = room({ property: { address: "1200 Example Avenue North, Tacoma, Washington 98406" } });
  assert.match(porchcardListing({ offer: deal("buyer_found"), room: bare, sections: ALL_PUBLIC }).reason, /beds, baths/);
  assert.match(porchcardListing({ offer: deal("buyer_found"), room: null, sections: ALL_PUBLIC }).reason, /no deal room/);
  assert.match(porchcardListing({ offer: deal("closed", { contractPrice: 0 }), room: room(), sections: ALL_PUBLIC }).reason, /contract price/);
});

test("a house already on Porchcard is adopted, not listed twice, and keeps the photos it was put up with", () => {
  const want = porchcardListing({ offer: deal("buyer_found"), room: room(), sections: ALL_PUBLIC });
  const listing = { key: "OWN-1", status: "active", shown: true, photos: ["a", "b"] };
  assert.deepEqual(porchcardStep({ want, link: null, listing, roomPhotoIds: ["p1"] }), { do: "adopt", key: "OWN-1", photosDone: true });
  const bare = { ...listing, photos: [] };
  assert.deepEqual(porchcardStep({ want, link: null, listing: bare }), { do: "adopt", key: "OWN-1", photosDone: false });
});

test("a new deal is created, then gets the room's photos up to Porchcard's fifteen, then nothing", () => {
  const want = porchcardListing({ offer: deal("buyer_found"), room: room(), sections: ALL_PUBLIC });
  assert.equal(porchcardStep({ want, link: null, listing: null }).do, "create");
  const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const listing = { key: "OWN-1", status: "active", shown: true, photos: [] };
  const step = porchcardStep({ want, link: { key: "OWN-1" }, listing, roomPhotoIds: ids });
  assert.equal(step.do, "photos");
  assert.equal(step.photoIds.length, PORCHCARD_MAX_PHOTOS);
  // Halfway through, it picks up where it stopped.
  const half = porchcardStep({ want, link: { key: "OWN-1", photoIds: ids.slice(0, 5) }, listing: { ...listing, photos: ids.slice(0, 5) }, roomPhotoIds: ids });
  assert.deepEqual(half.photoIds, ids.slice(5, 15));
  assert.equal(porchcardStep({ want, link: { key: "OWN-1", photosDone: true }, listing, roomPhotoIds: ids }).do, "none");
});

test("a deal that closes after going up is switched to closed, and its ARV and rehab are cleared", () => {
  const want = porchcardListing({ offer: deal("closed"), room: room(), sections: ALL_PUBLIC });
  const step = porchcardStep({ want, link: { key: "OWN-1", photosDone: true }, listing: { key: "OWN-1", status: "active", shown: true, photos: ["a"] } });
  assert.equal(step.do, "close");
  assert.deepEqual(step.patch, { status: "closed", price: 390000, description: want.fields.description, arv: null, rehab: null });
});

test("a deal that falls through comes off the profile once, and a listing Matt hid stays hidden", () => {
  const want = porchcardListing({ offer: deal("fell_through"), room: room(), sections: ALL_PUBLIC });
  const link = { key: "OWN-1", photosDone: true };
  assert.deepEqual(porchcardStep({ want, link, listing: { key: "OWN-1", status: "active", shown: true } }), { do: "hide", key: "OWN-1" });
  assert.equal(porchcardStep({ want, link, listing: { key: "OWN-1", status: "active", shown: false } }).do, "none");
  // A live deal whose listing was hidden by hand isn't put back.
  const live = porchcardListing({ offer: deal("buyer_found"), room: room(), sections: ALL_PUBLIC });
  assert.equal(porchcardStep({ want: live, link, listing: { key: "OWN-1", status: "active", shown: false, photos: ["a"] } }).do, "none");
});

test("a listing Matt deleted on Porchcard isn't put back up", () => {
  const want = porchcardListing({ offer: deal("buyer_found"), room: room(), sections: ALL_PUBLIC });
  assert.deepEqual(porchcardStep({ want, link: { key: "OWN-1", photosDone: true }, listing: null }), { do: "none", reason: "deleted on Porchcard" });
});
