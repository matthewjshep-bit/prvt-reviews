import test from "node:test";
import assert from "node:assert/strict";
import { fetchZillowPhotos, lighterZillowRendition, loadImageBlocks } from "./rehab-scan.js";

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

/* ---------- the photos go over as bytes, not links ---------- */

// Anthropic fetches a `url` image source itself and honours robots.txt when
// it does; Zillow's photo CDN disallows it. Every scan of a Zillow-sourced
// listing failed with "This URL is disallowed by the website's robots.txt
// file" — the auto-underwrite's terminal error on 2026-09-03 — and comp
// grading through the same path had been coming back "unknown" for every
// comp. The loader below downloads the pictures and inlines them.

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

// A fake CDN: `-p_f.jpg` exists for hash "aaaa" but not "bbbb", one URL is an
// HTML error page, and everything else is a small jpeg. Records what was asked.
function stubCdn({ bigBytes = 0 } = {}) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    const res = (ok, status, type, bytes) => ({
      ok, status,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? type : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    if (/bbbb-p_f\.jpg$/.test(url)) return res(false, 404, "text/html", new Uint8Array(0));
    if (/error\.html$/.test(url)) return res(true, 200, "text/html; charset=utf-8", new Uint8Array([60, 104]));
    if (/big\.jpg$/.test(url)) return res(true, 200, "image/jpeg", new Uint8Array(bigBytes));
    return res(true, 200, "image/jpeg; charset=binary", JPEG);
  };
  return { asked, restore: () => { globalThis.fetch = real; } };
}

test("a carousel URL has a lighter rendition; other URLs do not", () => {
  assert.equal(
    lighterZillowRendition("https://photos.zillowstatic.com/fp/aaaa-uncropped_scaled_within_1536_1152.jpg"),
    "https://photos.zillowstatic.com/fp/aaaa-p_f.jpg"
  );
  assert.equal(lighterZillowRendition("https://photos.zillowstatic.com/fp/aaaa-p_e.jpg"), null);
  assert.equal(lighterZillowRendition("https://cdn.example.com/mls/123.jpg"), null);
  assert.equal(lighterZillowRendition("data:image/jpeg;base64,abcd"), null);
});

test("photos come back as base64 blocks, in order, with the fetched media type", async () => {
  const { asked, restore } = stubCdn();
  try {
    const blocks = await loadImageBlocks([
      "https://photos.zillowstatic.com/fp/aaaa-uncropped_scaled_within_1536_1152.jpg",
      "https://cdn.example.com/mls/second.jpg",
    ]);
    assert.equal(blocks.length, 2);
    for (const b of blocks) {
      assert.equal(b.type, "image");
      assert.equal(b.source.type, "base64", "never a url source — that is the robots.txt path");
      assert.equal(b.source.media_type, "image/jpeg", "parameters stripped from the content-type");
      assert.equal(b.source.data, Buffer.from(JPEG).toString("base64"));
    }
    assert.deepEqual(asked, [
      "https://photos.zillowstatic.com/fp/aaaa-p_f.jpg",
      "https://cdn.example.com/mls/second.jpg",
    ], "the lighter rendition is what gets fetched for a Zillow carousel photo");
  } finally { restore(); }
});

test("a hash without the lighter rendition falls back to the original", async () => {
  const { asked, restore } = stubCdn();
  try {
    const blocks = await loadImageBlocks(["https://photos.zillowstatic.com/fp/bbbb-uncropped_scaled_within_1536_1152.jpg"]);
    assert.equal(blocks.length, 1);
    assert.deepEqual(asked, [
      "https://photos.zillowstatic.com/fp/bbbb-p_f.jpg",
      "https://photos.zillowstatic.com/fp/bbbb-uncropped_scaled_within_1536_1152.jpg",
    ]);
  } finally { restore(); }
});

test("a dead link or an error page is dropped, not sent and not fatal", async () => {
  const { restore } = stubCdn();
  try {
    const blocks = await loadImageBlocks([
      "https://cdn.example.com/error.html",
      "https://cdn.example.com/ok.jpg",
    ]);
    assert.equal(blocks.length, 1);
  } finally { restore(); }
});

test("an uploaded data: URL passes straight through as base64", async () => {
  const { asked, restore } = stubCdn();
  try {
    const blocks = await loadImageBlocks(["data:image/png;base64,iVBORw0KGgo="]);
    assert.deepEqual(blocks, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]);
    assert.deepEqual(asked, [], "nothing fetched");
  } finally { restore(); }
});

test("the request budget trims from the end, keeping the leading photos", async () => {
  const { restore } = stubCdn({ bigBytes: 3000 });
  try {
    const blocks = await loadImageBlocks(
      ["https://cdn.example.com/1-big.jpg", "https://cdn.example.com/2-big.jpg", "https://cdn.example.com/3-big.jpg"],
      { budget: 6500 }
    );
    assert.equal(blocks.length, 2, "two fit, the third would overflow");
  } finally { restore(); }
});

test("an image over the per-image cap is skipped rather than sent", async () => {
  const { restore } = stubCdn({ bigBytes: 5 * 1024 * 1024 + 1 });
  try {
    const blocks = await loadImageBlocks(["https://cdn.example.com/1-big.jpg", "https://cdn.example.com/ok.jpg"]);
    assert.equal(blocks.length, 1);
  } finally { restore(); }
});
