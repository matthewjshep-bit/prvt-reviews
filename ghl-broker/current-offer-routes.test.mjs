// current-offer-routes.test.mjs — making an offer current, and re-quoting it.
//
// 13041 SE 208th St, Kent (2026-09-25): five offer rows on one house and no
// way to say which was live, so the bot sent paper at a July number. These
// cover the two presses that fix a house by hand: "make this current" and
// "re-quote at 400K" from the held-paper banner.
//
// JSON file backend in a throwaway temp directory; cardgen and GHL stubbed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "current-offer-test-"));
process.env.CARD_SENDS_ENABLED = "false";

const { default: express } = await import("express");

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);
const cardgen = express();
cardgen.use(express.json({ limit: "30mb" }));
cardgen.post("/render", (_req, res) => { res.type("image/jpeg").send(JPEG); });
const cardServer = cardgen.listen(0);
process.env.CARD_SERVICE_URL = `http://127.0.0.1:${cardServer.address().port}`;

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { resolveHouse, paperHeldNow } = await import("./shared/current-offer.js");

const LOC = "loc-current-offer-test";
const client = {
  call: async (p, opts = {}) => {
    const method = opts.method || "GET";
    if (p.includes("/customFields") && method === "GET") return { customFields: [] };
    if (p.includes("/customFields") && method === "POST") return { customField: { id: `cf-${Math.random().toString(36).slice(2, 8)}` } };
    if (/^\/contacts\/[^/]+$/.test(p) && method === "GET") return { contact: { id: "contact-1", firstName: "Sam", lastName: "Lee", customFields: [] } };
    return {};
  },
};
const app = express();
app.use(express.json({ limit: "30mb" }));
app.use("/api/offers", createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:4993",
}));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => { server.close(); cardServer.close(); });

const req = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const ADDR = "13041 SE 208th St, Kent, WA 98031";
const INPUTS = { address: ADDR, arv: 660000, repairs: 110000, askingPrice: 450000 };
const SETTINGS = { wholesaleFee: 15000, validityDays: 7, company: { name: "Shep Flips" } };
async function seed(over = {}) {
  const r = await req("POST", "/api/offers", { contactId: "contact-1", inputs: INPUTS, settings: SETTINGS, scope: [{ label: "Roof", cost: 14500 }] });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  const offer = await store.getOffer(r.json.offer.id);
  Object.assign(offer, over);
  await store.updateOffer(offer.id, offer);
  return store.getOffer(offer.id);
}
const house = async () => resolveHouse((await store.listOffers(LOC, { contactId: "contact-1", limit: 50 })).filter((o) => o.address === ADDR));

test("the list says which row is current and what replaced the rest", async () => {
  const older = await seed({ createdAt: "2026-07-27T22:35:00Z", sends: [{ ts: "2026-07-27T22:44:00Z" }], status: "sent" });
  const newer = await seed({ createdAt: "2026-08-05T16:31:00Z", sends: [{ ts: "2026-08-05T16:31:42Z" }], status: "passed" });
  const r = await req("GET", "/api/offers?contact_id=contact-1&lean=1");
  const byId = Object.fromEntries(r.json.offers.map((o) => [o.id, o]));
  assert.equal(byId[newer.id].isCurrent, true);
  assert.equal(byId[older.id].isCurrent, false);
  assert.equal(byId[older.id].supersededBy.id, newer.id);
});

test("making an older offer current pins it, and pinning another moves the pin", async () => {
  const rows = (await store.listOffers(LOC, { contactId: "contact-1", limit: 50 })).filter((o) => o.address === ADDR);
  const older = rows.find((o) => o.createdAt.startsWith("2026-07"));
  const r = await req("PATCH", `/api/offers/${older.id}/current`, { pin: true, note: "this is the number" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.currentId, older.id);
  assert.equal((await house()).current.id, older.id);

  const newer = rows.find((o) => o.createdAt.startsWith("2026-08"));
  await req("PATCH", `/api/offers/${newer.id}/current`, { pin: true });
  assert.equal((await store.getOffer(older.id)).pin, undefined, "one pin per house");
  assert.equal((await house()).current.id, newer.id);

  await req("PATCH", `/api/offers/${newer.id}/current`, { pin: false });
  assert.equal((await store.getOffer(newer.id)).pin, undefined);
});

test("a draft can't be made current", async () => {
  const d = await seed({ status: "draft" });
  const r = await req("PATCH", `/api/offers/${d.id}/current`, { pin: true });
  assert.equal(r.status, 409);
});

test("re-quote at the thread's number revises in place, makes it current, and clears the held paper", async () => {
  const rows = (await store.listOffers(LOC, { contactId: "contact-1", limit: 50 })).filter((o) => o.address === ADDR && o.status !== "draft");
  const older = rows.find((o) => o.createdAt.startsWith("2026-07"));
  const held = await store.getOffer(older.id);
  held.paperHeld = { at: new Date(Date.now() - 1000).toISOString(), reason: "we texted 400K", amount: 400000 };
  await store.updateOffer(held.id, held);
  assert.ok(paperHeldNow(await store.getOffer(older.id)));

  const count = (await store.listOffers(LOC, { limit: 500 })).length;
  const r = await req("POST", `/api/offers/${older.id}/requote`, { amount: 400000 });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  const after = await store.getOffer(older.id);
  assert.equal(after.cashAmount, 400000);
  assert.equal(after.revisions.at(-1).to, 400000);
  assert.equal((await store.listOffers(LOC, { limit: 500 })).length, count, "no new row");
  assert.equal(paperHeldNow(after), null, "a re-price makes the hold moot");
  assert.equal((await house()).current.id, older.id, "a revision is a price move");
});

test("re-quote refuses a missing amount", async () => {
  const any = (await store.listOffers(LOC, { limit: 1 }))[0];
  assert.equal((await req("POST", `/api/offers/${any.id}/requote`, {})).status, 400);
});
