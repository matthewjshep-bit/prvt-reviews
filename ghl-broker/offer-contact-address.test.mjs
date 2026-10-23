// offer-contact-address.test.mjs — a new offer from a contact opens on the
// whole address. Run with:  node --test offer-contact-address.test.mjs
//
// What went wrong (2026-10-23): "New offer" from a contact filled the address
// from the GHL "short hand property address" field — "4410 N Mullen" — and
// Matt typed the city, state and ZIP by hand on every one. The record already
// knew them: a prior offer on the street, the contact's city, the geocoder.
//
// GET /api/offers/contacts/:id now returns `address`, finished the way
// auto-underwrite finishes a shorthand line. The geocoder is stubbed through
// globalThis.fetch (local requests pass through to the test server).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offer-contact-address-test-"));

const realFetch = globalThis.fetch;
const MATCHES = {
  "4410 n mullen": "4410 N MULLEN ST, TACOMA, WA, 98407",
  "918 s ainsworth": "918 S AINSWORTH AVE, TACOMA, WA, 98405",
};
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1")) return realFetch(url, opts);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("geocoding.geo.census.gov")) {
    const q = decodeURIComponent(new URL(u).searchParams.get("address") || "").toLowerCase();
    // Only a query that names the right city resolves, as TIGER would.
    const hit = Object.entries(MATCHES).find(([street]) => q.startsWith(street) && q.includes("tacoma"));
    return json({ result: { addressMatches: hit ? [{ matchedAddress: hit[1], coordinates: { x: -122.48, y: 47.27 } }] : [] } });
  }
  if (u.includes("photon.komoot.io")) return json({ features: [] });
  return json({});
};

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-offer-contact-address-test";
const CONTACTS = {
  "c-city": { city: "Tacoma", state: "WA", short: "4410 N Mullen" },
  "c-offer": { city: "Seattle", state: "WA", short: "918 S Ainsworth" },
  "c-nothing": { city: "Puyallup", state: "WA", short: "12 Nowhere Rd" },
  "c-full": { city: "", state: "", short: "4410 N Mullen St, Tacoma, WA" },
};
const client = {
  call: async (p, opts = {}) => {
    const method = opts.method || "GET";
    if (p.includes("/customFields") && method === "GET") {
      return { customFields: [{ id: "cf-short", fieldKey: "contact.short_hand_property_address", name: "Short Hand Property Address" }] };
    }
    if (p.includes("/customFields") && method === "POST") return { customField: { id: "cf-new" } };
    const m = p.match(/^\/contacts\/([^/]+)$/);
    if (m && method === "GET") {
      const c = CONTACTS[m[1]] || {};
      return { contact: { id: m[1], firstName: "Dana", lastName: "Reyes", city: c.city, state: c.state, customFields: [{ id: "cf-short", value: c.short }] } };
    }
    if (/\/notes$/.test(p)) return { notes: [] };
    return {};
  },
};

const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:4996",
}));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();

const addressOf = async (id) => {
  const r = await realFetch(`${B}/api/offers/contacts/${id}`);
  assert.equal(r.status, 200);
  return (await r.json()).contact.address;
};

test("a new offer from a contact gets the city, state and ZIP, not just the street", async () => {
  assert.equal(await addressOf("c-city"), "4410 N Mullen St, Tacoma, WA 98407");
});

test("a full address we already hold on that street wins over the contact's own city", async () => {
  await store.createOffer({ locationId: LOC, contactId: "c-offer", status: "passed", address: "918 S Ainsworth Ave, Tacoma, WA 98405" });
  assert.equal(await addressOf("c-offer"), "918 S Ainsworth Ave, Tacoma, WA 98405");
});

test("nothing geocodes: the street with the contact's city, still better than the bare line", async () => {
  assert.equal(await addressOf("c-nothing"), "12 Nowhere Rd, Puyallup, WA");
});

test("an address that's already whole picks up its ZIP", async () => {
  assert.equal(await addressOf("c-full"), "4410 N Mullen St, Tacoma, WA 98407");
});

test.after(() => { server.close(); globalThis.fetch = realFetch; });
