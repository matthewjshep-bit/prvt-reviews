import test from "node:test";
import assert from "node:assert/strict";
import { fetchZillowPhotos, fetchZillowFacts, fetchZillowUnits, lotSqftFromDetail, lighterZillowRendition, loadImageBlocks, _resetFactsCache } from "./rehab-scan.js";

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
      beds: 3, baths: 1, sqft: 1187, yearBuilt: 1900, lotSqft: null, homeType: "SINGLE_FAMILY",
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


/* ---------- the facts a search row doesn't carry (2026-09-16) ---------- */

// The comps' year built never reached the match: Zillow search rows don't
// carry it. The detail actor does — the same call the multifamily path was
// already making for unit counts and keeping only the units from.
function stubApifyCounting(items) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body).addresses); return { ok: true, json: async () => items }; };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const DETAIL_ROW = (street, over = {}) => ({
  address: { streetAddress: street, city: "Kent", state: "WA", zipcode: "98031" },
  bedrooms: 3, bathrooms: 2, livingArea: 1650, yearBuilt: 1971, homeType: "SINGLE_FAMILY",
  lotAreaValue: 0.18, lotAreaUnits: "acres", dateSold: "2026-05-02T00:00:00Z", lastSoldPrice: 610000,
  ...over,
});

test("a facts lookup reads year built, lot and unit count off one detail row", async () => {
  _resetFactsCache();
  const { restore } = stubApifyCounting([
    DETAIL_ROW("10412 SE 219th St"),
    DETAIL_ROW("10420 SE 219th St", { homeType: "MULTI_FAMILY", description: "Solid triplex, three units all rented" }),
  ]);
  try {
    const m = await fetchZillowFacts(["10412 SE 219th St, Kent, WA 98031", "10420 SE 219th St, Kent, WA 98031"], "t");
    const a = m.get("10412 se 219th st");
    assert.equal(a.yearBuilt, 1971);
    assert.equal(a.lotSqft, 7841, "0.18 acres, in square feet");
    assert.equal(a.sqft, 1650);
    assert.equal(a.lastSoldPrice, 610000);
    assert.equal(a.lastSoldDate, "2026-05-02");
    assert.equal(a.units, null, "a house has no unit count");
    assert.equal(m.get("10420 se 219th st").units, 3);
  } finally { restore(); }
});

test("a lot in acres is stored in square feet, whichever field carries it", () => {
  assert.equal(lotSqftFromDetail({ lotAreaValue: 0.25, lotAreaUnits: "acres" }), 10890);
  assert.equal(lotSqftFromDetail({ lotAreaValue: 6000, lotAreaUnits: "sqft" }), 6000);
  assert.equal(lotSqftFromDetail({ lotSize: 7200 }), 7200);
  assert.equal(lotSqftFromDetail({ resoFacts: { lotSize: "0.17 Acres" } }), 7405);
  assert.equal(lotSqftFromDetail({ resoFacts: { lotSize: "5,227 sqft" } }), 5227);
  assert.equal(lotSqftFromDetail({}), null);
});

test("the second ask for the same street is free, and a miss is remembered too", async () => {
  _resetFactsCache();
  const { calls, restore } = stubApifyCounting([DETAIL_ROW("1 Main St")]);
  try {
    await fetchZillowFacts(["1 Main St, Kent, WA", "2 Main St, Kent, WA"], "t");
    assert.equal(calls.length, 1);
    const again = await fetchZillowFacts(["1 Main St, Kent, WA", "2 Main St, Kent, WA"], "t");
    assert.equal(calls.length, 1, "nothing new to buy");
    assert.equal(again.get("1 main st").yearBuilt, 1971);
    assert.equal(again.get("2 main st"), null, "Zillow couldn't read it; that's remembered, not re-bought");
    await fetchZillowFacts(["3 Main St, Kent, WA"], "t");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], ["3 Main St, Kent, WA"], "only the new address goes out");
  } finally { restore(); }
});

test("fetchZillowUnits still answers with units only", async () => {
  _resetFactsCache();
  const { restore } = stubApifyCounting([
    DETAIL_ROW("5 Elm St", { homeType: "MULTI_FAMILY", description: "duplex with two units" }),
    DETAIL_ROW("6 Elm St"),
  ]);
  try {
    const m = await fetchZillowUnits(["5 Elm St, Kent, WA", "6 Elm St, Kent, WA"], "t");
    assert.deepEqual([...m], [["5 elm st", 2]]);
  } finally { restore(); }
});
