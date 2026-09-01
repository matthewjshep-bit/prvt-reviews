import test from "node:test";
import assert from "node:assert/strict";
import { geocodeAddress, censusLabel, atLeast, _resetGeocodeCache } from "./geocode.js";

/* ---------- a stub for both providers ---------- */

// Each case is { census: { "<query>": [matchedAddress, lat, lng] }, photon: [features] }.
// Anything not named answers empty, which is exactly how the live services
// behave for an address they don't hold.
function stubProviders({ census = {}, photon = {} } = {}) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const q = u.searchParams.get("address") || u.searchParams.get("q") || "";
    const which = u.hostname.includes("census") ? "census" : "photon";
    calls.push({ which, q });
    if (which === "census") {
      const hits = census[q] ? [census[q]] : [];
      return json({
        result: {
          addressMatches: hits.map(([matchedAddress, y, x]) => ({
            matchedAddress, coordinates: { x, y },
          })),
        },
      });
    }
    return json({ features: photon[q] || [] });
  };
  _resetGeocodeCache();
  return { calls, restore: () => { globalThis.fetch = real; _resetGeocodeCache(); } };
}

const json = (body) => ({ ok: true, json: async () => body });

const feature = (lat, lng, props) => ({
  geometry: { coordinates: [lng, lat] },
  properties: { countrycode: "US", ...props },
});

const LARCH = "14808 Larch Way, Lynnwood, WA 98087";

/* ---------- the bug this module was written for ---------- */

test("an address OSM has never heard of still resolves, via Census", async () => {
  // Photon returns literally nothing for this house. It is a real, listed
  // property, and the auto-underwrite used to die on it.
  const s = stubProviders({
    census: { [LARCH]: ["14808 LARCH WAY, LYNNWOOD, WA, 98087", 47.8636, -122.2401] },
  });
  try {
    const geo = await geocodeAddress(LARCH);
    assert.equal(geo.source, "census");
    assert.equal(geo.precision, "address");
    assert.equal(geo.matched, "14808 Larch Way, Lynnwood, WA 98087");
    assert.ok(Math.abs(geo.lat - 47.8636) < 1e-6 && Math.abs(geo.lng + 122.2401) < 1e-6);
  } finally { s.restore(); }
});

test("Photon still answers for what TIGER hasn't got", async () => {
  const s = stubProviders({
    photon: {
      [LARCH]: [feature(47.8636, -122.2401, {
        housenumber: "14808", street: "Larch Way", city: "Lynnwood", state: "Washington", postcode: "98087",
      })],
    },
  });
  try {
    const geo = await geocodeAddress(LARCH);
    assert.equal(geo.source, "photon");
    assert.equal(geo.precision, "address");
  } finally { s.restore(); }
});

/* ---------- refusing a confident wrong answer ---------- */

test("Census reaching for a different street is refused", async () => {
  // Live behaviour: "1234 NE 8th Street, Renton, WA" comes back as
  // "1234 N 8TH ST, RENTON, WA 98057" — same number, different street.
  const q = "1234 NE 8th St, Renton, WA 98056";
  const s = stubProviders({
    census: { [q]: ["1234 N 8TH ST, RENTON, WA, 98057", 47.49, -122.2] },
  });
  try {
    assert.equal(await geocodeAddress(q), null);
  } finally { s.restore(); }
});

test("a Photon hit in another country is not an answer", async () => {
  // "14808 Larch Way, Lynnwood, WA" has really returned a Brazilian highway.
  const s = stubProviders({
    photon: { [LARCH]: [feature(-21.87, -48.1, { countrycode: "BR", street: "Rodovia Washington Luís", postcode: "14808-000" })] },
  });
  try {
    assert.equal(await geocodeAddress(LARCH), null);
  } finally { s.restore(); }
});

test("a Photon hit in a state the address didn't name is not an answer", async () => {
  const s = stubProviders({
    photon: { [LARCH]: [feature(41.2, -96.0, { housenumber: "14808", street: "Larch Way", state: "Nebraska" })] },
  });
  try {
    assert.equal(await geocodeAddress(LARCH), null);
  } finally { s.restore(); }
});

test("the right house number on the wrong street is not an answer", async () => {
  const q = "1234 NE 8th St, Renton, WA";
  const s = stubProviders({
    photon: { [q]: [feature(47.79, -122.37, { housenumber: "1234", street: "8th Avenue South", city: "Edmonds", state: "Washington" })] },
  });
  try {
    assert.equal(await geocodeAddress(q), null);
  } finally { s.restore(); }
});

/* ---------- the ladder ---------- */

test("a unit number is dropped and the address tried again", async () => {
  const s = stubProviders({
    census: { [LARCH]: ["14808 LARCH WAY, LYNNWOOD, WA, 98087", 47.8636, -122.2401] },
  });
  try {
    const geo = await geocodeAddress("14808 Larch Way #B, Lynnwood, WA 98087");
    assert.equal(geo.precision, "address");
    assert.ok(s.calls.some((c) => c.q === LARCH), "retried without the unit");
  } finally { s.restore(); }
});

test("the USPS and spelled-out forms are both offered", async () => {
  const s = stubProviders({
    census: { "7525 166th Ave NE, Redmond, WA 98052": ["7525 166TH AVE NE, REDMOND, WA, 98052", 47.67, -122.11] },
  });
  try {
    const geo = await geocodeAddress("7525 166th Avenue Northeast, Redmond, Washington 98052");
    assert.equal(geo.precision, "address");
  } finally { s.restore(); }
});

test("\"Sixth Street South\" is offered to the address files as \"6th St S\"", async () => {
  const s = stubProviders({
    census: { "820 6th St S, Kirkland, WA 98033": ["820 6TH ST S, KIRKLAND, WA, 98033", 47.67, -122.19] },
  });
  try {
    const geo = await geocodeAddress("820 Sixth Street South, Kirkland, Washington 98033");
    assert.equal(geo.precision, "address");
    assert.equal(geo.matched, "820 6th St S, Kirkland, WA 98033");
  } finally { s.restore(); }
});

/* ---------- the comma nobody typed ---------- */

// The live failure this rung was written for: the auto-underwrite held on
// "17118 Riverview Way E Enumclaw, WA 98022" with "could only be placed at the
// centre of its ZIP code" and pulled zero comps, because the ZIP centroid is
// downtown Enumclaw and the house is twenty miles up the river.
const RIVERVIEW = "17118 Riverview Way E Enumclaw, WA 98022";
const RIVERVIEW_TIGER = ["17118 RIVERVIEW WAY E, ENUMCLAW, WA, 98022", 47.101105, -121.600087];

test("a city glued to the street still resolves to the house", async () => {
  // Census answers the run-on query correctly; it's our own street check that
  // used to reject the answer. Only the re-split query is stubbed, so this
  // fails if the rung stops being offered.
  const s = stubProviders({
    census: { "17118 Riverview Way E, Enumclaw, WA 98022": RIVERVIEW_TIGER },
  });
  try {
    const geo = await geocodeAddress(RIVERVIEW);
    assert.equal(geo.precision, "address");
    assert.equal(geo.matched, "17118 Riverview Way E, Enumclaw, WA 98022");
    assert.ok(Math.abs(geo.lat - 47.101105) < 1e-6);
  } finally { s.restore(); }
});

test("an address with no commas at all is re-split too", async () => {
  const s = stubProviders({
    census: { "17118 Riverview Way E, Enumclaw WA 98022": RIVERVIEW_TIGER },
  });
  try {
    const geo = await geocodeAddress("17118 Riverview Way E Enumclaw WA 98022");
    assert.equal(geo.precision, "address");
  } finally { s.restore(); }
});

test("a well-formed address is never re-split", async () => {
  // Nothing follows the directional, so there is no city to cut off. The
  // rung has to stay quiet here or every correct address grows a round trip.
  const s = stubProviders({});
  try {
    await geocodeAddress("1234 Park Avenue South, Seattle, WA 98144");
    const asked = s.calls.filter((c) => c.which === "census").map((c) => c.q);
    // A cut in the wrong place — after "Avenue", treating "South" as the city —
    // would show up as a fourth comma segment.
    assert.ok(
      asked.every((q) => q.split(",").length <= 3),
      `re-split an address that didn't need it: ${asked.join(" | ")}`
    );
    // The only extra rungs a well-formed address earns are its own three
    // spellings offered again without the ZIP.
    assert.equal(
      new Set(asked.map((q) => q.replace(/\s+\d{5}$/, ""))).size, 3,
      `an unexpected rewrite was tried: ${asked.join(" | ")}`
    );
  } finally { s.restore(); }
});

/* ---------- the street type nobody typed ---------- */

// The live failure this rung was written for: "2614 S 54th, Tacoma, WA 98409"
// held with zero comps and "could only be placed at the centre of its ZIP
// code". TIGER matches more strictly once a ZIP is present, so the street
// missing its "St" was refused with the ZIP and answered without it.
const S54 = "2614 S 54th, Tacoma, WA 98409";
const S54_TIGER = ["2614 S 54TH ST, TACOMA, WA, 98409", 47.207683, -122.471244];

test("a street typed without its type still resolves to the house", async () => {
  // Only the ZIP-less query is stubbed — exactly how Census behaves here — so
  // this fails if that rung stops being offered.
  const s = stubProviders({ census: { "2614 S 54th, Tacoma, WA": S54_TIGER } });
  try {
    const geo = await geocodeAddress(S54);
    assert.equal(geo.precision, "address");
    assert.equal(geo.matched, "2614 S 54th St, Tacoma, WA 98409");
    assert.ok(Math.abs(geo.lat - 47.207683) < 1e-6);
  } finally { s.restore(); }
});

test("the ZIP-bearing form is always asked first", async () => {
  const s = stubProviders({ census: { [S54]: S54_TIGER, "2614 S 54th, Tacoma, WA": S54_TIGER } });
  try {
    await geocodeAddress(S54);
    assert.equal(s.calls[0].q, S54, "dropping the ZIP is a fallback, not the first move");
  } finally { s.restore(); }
});

test("a street that DID name its type is still held to it", async () => {
  // The tolerance only runs one way. "NE 8th St" asked for a type, so an
  // answer on "N 8th St" is a different street and stays refused.
  const s = stubProviders({
    census: { "1234 NE 8th St, Renton, WA": ["1234 N 8TH ST, RENTON, WA, 98057", 47.49, -122.2] },
  });
  try {
    assert.equal(await geocodeAddress("1234 NE 8th St, Renton, WA 98056"), null);
  } finally { s.restore(); }
});

test("dropping the ZIP doesn't let the answer wander to another street", async () => {
  const s = stubProviders({
    census: { "2614 S 54th, Tacoma, WA": ["2614 S PROSPECT ST, TACOMA, WA, 98409", 47.24, -122.46] },
  });
  try {
    assert.equal(await geocodeAddress(S54), null);
  } finally { s.restore(); }
});

test("the re-split doesn't let TIGER answer with a different street", async () => {
  // The rung is an extra query, not a loosening of the check: the answer it
  // gets is still validated against the street that was asked for.
  const q = "1234 NE 8th St Renton, WA 98056";
  const s = stubProviders({
    census: { "1234 NE 8th St, Renton, WA 98056": ["1234 N 8TH ST, RENTON, WA, 98057", 47.49, -122.2] },
  });
  try {
    assert.equal(await geocodeAddress(q), null);
  } finally { s.restore(); }
});

/* ---------- honest downgrades ---------- */

test("an address nobody can pin falls back to its ZIP, and says so", async () => {
  const q = "99999 Nowhere Rd, Lynnwood, WA 98087";
  const s = stubProviders({
    photon: { "98087, WA": [feature(47.857, -122.264, { name: "98087", state: "Washington" })] },
  });
  try {
    const geo = await geocodeAddress(q);
    assert.equal(geo.precision, "zip");
    assert.equal(geo.matched, "98087");
  } finally { s.restore(); }
});

test("a caller that can't defend a centroid gets null instead of one", async () => {
  const q = "99999 Nowhere Rd, Lynnwood, WA 98087";
  const s = stubProviders({
    photon: { "98087, WA": [feature(47.857, -122.264, { name: "98087", state: "Washington" })] },
  });
  try {
    assert.equal(await geocodeAddress(q, { minPrecision: "street" }), null);
    assert.ok(await geocodeAddress(q, { minPrecision: "city" }));
  } finally { s.restore(); }
});

test("atLeast ranks the four grades of answer", () => {
  assert.equal(atLeast({ precision: "address" }, "street"), true);
  assert.equal(atLeast({ precision: "street" }, "street"), true);
  assert.equal(atLeast({ precision: "zip" }, "street"), false);
  assert.equal(atLeast({ precision: "city" }, "zip"), false);
  assert.equal(atLeast(null, "city"), false);
});

/* ---------- housekeeping ---------- */

test("a resolved address is looked up once, not once per caller", async () => {
  const s = stubProviders({
    census: { [LARCH]: ["14808 LARCH WAY, LYNNWOOD, WA, 98087", 47.8636, -122.2401] },
  });
  try {
    await geocodeAddress(LARCH);
    const before = s.calls.length;
    await geocodeAddress(LARCH.toUpperCase());  // same address, shouted
    assert.equal(s.calls.length, before, "second lookup hit the cache");
  } finally { s.restore(); }
});

test("a failed lookup is NOT cached — the network has bad minutes", async () => {
  const s = stubProviders({});
  try {
    assert.equal(await geocodeAddress(LARCH), null);
    const before = s.calls.length;
    assert.equal(await geocodeAddress(LARCH), null);
    assert.ok(s.calls.length > before, "tried again");
  } finally { s.restore(); }
});

test("a provider outage is a null, not a throw", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNRESET"); };
  _resetGeocodeCache();
  try {
    assert.equal(await geocodeAddress(LARCH), null);
  } finally { globalThis.fetch = real; _resetGeocodeCache(); }
});

test("TIGER's shouting is written back the way an address is written", () => {
  assert.equal(censusLabel("741 N 128TH ST, SEATTLE, WA, 98133"), "741 N 128th St, Seattle, WA 98133");
  assert.equal(censusLabel("1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500"), "1600 Pennsylvania Ave NW, Washington, DC 20500");
  assert.equal(censusLabel(""), null);
});
