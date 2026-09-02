import test from "node:test";
import assert from "node:assert/strict";
import { fetchZillowPhotos } from "./rehab-scan.js";

// The detail actor was rebuilt on 2026-09-02 with the same rename as the search
// one: the carousel became `listingPhotos`, the status `listingStatus`, the
// price a money object. Reading only the old names is why every run reported
// "0 listing photos to scan" for houses that plainly had them — and then said
// the scope of work couldn't be scanned, as if the house were at fault.

function stubApify(items) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => items });
  return () => { globalThis.fetch = real; };
}

const NEW_SHAPE = {
  zpid: "2064142765",
  listingStatus: "sold",
  listingPrice: { amount: 995000, currency: "USD", formatted: "$995,000" },
  listingPhotos: [
    { url: "https://photos.zillowstatic.com/fp/a-p_e.jpg", caption: null },
    { url: "https://photos.zillowstatic.com/fp/b-p_e.jpg", caption: null },
  ],
  photoCount: 2,
  description: "Charming fixer on a quiet street.",
  bedrooms: 3, bathrooms: 1, livingArea: 1187, yearBuilt: 1900,
  homeType: "SINGLE_FAMILY",
};

const OLD_SHAPE = {
  zpid: 2064142765,
  homeStatus: "RECENTLY_SOLD",
  price: 995000,
  photos: [
    { mixedSources: { jpeg: [{ url: "https://photos.zillowstatic.com/fp/a-p_e.jpg", width: 1024 }] } },
    { url: "https://photos.zillowstatic.com/fp/b-p_e.jpg" },
  ],
  description: "Charming fixer on a quiet street.",
  bedrooms: 3, bathrooms: 1, livingArea: 1187, yearBuilt: 1900,
  homeType: "SINGLE_FAMILY",
};

test("the curated shape yields photos — the ones the runs were missing", async () => {
  const restore = stubApify([NEW_SHAPE]);
  try {
    const r = await fetchZillowPhotos("2614 S 54th St, Tacoma, WA 98409", "token");
    assert.equal(r.photos.length, 2);
    assert.equal(r.photosCount, 2);
    assert.match(r.photos[0], /^https:\/\/photos\.zillowstatic\.com/);
    assert.equal(r.listing.status, "sold");
    assert.equal(r.listing.listPrice, 995000);
    assert.deepEqual(r.facts, {
      beds: 3, baths: 1, sqft: 1187, yearBuilt: 1900, homeType: "SINGLE_FAMILY",
    });
  } finally { restore(); }
});

test("the old shape still yields the same photos", async () => {
  const restore = stubApify([OLD_SHAPE]);
  try {
    const r = await fetchZillowPhotos("2614 S 54th St, Tacoma, WA 98409", "token");
    assert.equal(r.photos.length, 2);
    assert.equal(r.listing.listPrice, 995000);
    assert.equal(r.facts.sqft, 1187);
  } finally { restore(); }
});

test("a listing that genuinely has no pictures is not an error", async () => {
  // The distinction the gate depends on: a house with no photos still hands
  // back its facts, so the comp search can still be shaped by them.
  const { listingPhotos, ...noPhotos } = NEW_SHAPE;
  const restore = stubApify([noPhotos]);
  try {
    const r = await fetchZillowPhotos("2614 S 54th St, Tacoma, WA 98409", "token");
    assert.deepEqual(r.photos, []);
    assert.equal(r.facts.beds, 3);
  } finally { restore(); }
});

test("the actor's miss sentinel is still an error, not an empty house", async () => {
  // { isValid: false } is a truthy item with every field undefined. Waved
  // through, it reads as "this listing has no pictures" forever.
  const restore = stubApify([{ addressOrUrlFromInput: "nowhere", isValid: false, invalidReason: "Address not found" }]);
  try {
    await assert.rejects(
      () => fetchZillowPhotos("nowhere", "token"),
      /Address not found/
    );
  } finally { restore(); }
});
