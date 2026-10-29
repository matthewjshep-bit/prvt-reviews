// bricked-form-route.test.mjs — the offer form's "Price with Bricked.ai"
// button: one lookup on the typed address, its ARV and repairs back to the
// form, and nothing made, noted or sent.
//
// Matt, 2026-10-29: two options on auto underwrite — ours or Bricked.ai.
//
//   node --test bricked-form-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bricked-form-route-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-bricked-form";
const ghlCalls = [];
const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client: { call: async (...a) => { ghlCalls.push(a); return {}; } } }),
  uploadDir: process.env.DATA_DIR,
}));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const ADDRESS = "15415 64th Ave NE, Kenmore, WA 98028";
const READ = {
  id: "b1", arv: 975000, arvConfidence: 0.84, cmv: 700000, cmvConfidence: 0.7, totalRepairCost: 70000,
  repairs: [{ repair: "Kitchen", cost: 45000 }, { repair: "Paint", cost: 25000 }],
  property: { address: { fullAddress: ADDRESS }, details: { bedrooms: 3, bathrooms: 2, squareFeet: 1800 } },
  comps: [{ compType: "arv", selected: true, is_renovated: true, address: { fullAddress: "15500 64th Ave NE" }, details: { squareFeet: 1750, lastSaleAmount: 990000 } }],
  shareLink: "https://bricked.ai/share/b1",
};

function stub(answer = { status: 200, body: READ }) {
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(B)) return original(url, opts);
    asked.push({ url: u, key: opts.headers?.["x-api-key"] });
    return { ok: answer.status < 300, status: answer.status, statusText: "", json: async () => answer.body };
  };
  return { asked, restore: () => { globalThis.fetch = original; } };
}

const press = (body) => fetch(`${B}/api/offers/bricked`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("the button fills the form with Bricked's ARV and repairs and makes no offer", async () => {
  await store.saveOfferSettings(LOC, { brickedApiKey: "bk-1" });
  const offersBefore = (await store.listOffers?.(LOC))?.length ?? 0;
  const { asked, restore } = stub();
  try {
    const r = await press({ address: ADDRESS, work: "dated kitchen, needs paint" });
    assert.equal(r.status, 200);
    assert.equal(r.body.arv, 975000);
    assert.equal(r.body.repairs, 70000);
    assert.equal(r.body.sqft, 1800);
    assert.equal(r.body.bricked.link, "https://bricked.ai/share/b1");
    assert.equal(r.body.bricked.comps.length, 1);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].key, "bk-1");
    assert.equal(new URL(asked[0].url).searchParams.get("repairs"), "dated kitchen, needs paint");
  } finally { restore(); }
  assert.equal((await store.listOffers?.(LOC))?.length ?? 0, offersBefore);
  assert.equal(ghlCalls.length, 0, "nothing is noted or tagged in GHL");
});

test("it works without 'Price drafts with Bricked.ai' switched on — pressing it is the ask", async () => {
  await store.saveOfferSettings(LOC, { brickedApiKey: "bk-1", brickedOnDrafts: false });
  const { restore } = stub();
  try { assert.equal((await press({ address: ADDRESS })).status, 200); } finally { restore(); }
});

test("no description of the work leaves repairs empty rather than zero", async () => {
  await store.saveOfferSettings(LOC, { brickedApiKey: "bk-1" });
  const { asked, restore } = stub({ status: 200, body: { ...READ, totalRepairCost: null, repairs: [] } });
  try {
    const r = await press({ address: ADDRESS });
    assert.equal(r.body.repairs, null);
    assert.equal(new URL(asked[0].url).searchParams.has("repairs"), false);
  } finally { restore(); }
});

test("a street with no house number is never sent to Bricked", async () => {
  await store.saveOfferSettings(LOC, { brickedApiKey: "bk-1" });
  const { asked, restore } = stub();
  try {
    const r = await press({ address: "64th Ave NE, Kenmore, WA 98028" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /house number/);
    assert.equal(asked.length, 0);
  } finally { restore(); }
});

test("with no key saved it says where to put one and calls nothing", async () => {
  await store.saveOfferSettings(LOC, { brickedApiKey: "" });
  const { asked, restore } = stub();
  try {
    const r = await press({ address: ADDRESS });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Bricked API key/);
    assert.equal(asked.length, 0);
  } finally { restore(); }
});

test("Bricked's own refusal comes back as the message", async () => {
  await store.saveOfferSettings(LOC, { brickedApiKey: "bk-1" });
  const { restore } = stub({ status: 402, body: { error: "subscription inactive" } });
  try {
    const r = await press({ address: ADDRESS });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /402: subscription inactive/);
  } finally { restore(); }
});
