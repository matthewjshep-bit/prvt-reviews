// offer-send-page.test.mjs — the agent page rides along with the offer.
// Run with:  npm run test:send-page
//
// An offer that sends itself has no operator to tick "include the link", and a
// text carrying only a number is the one an agent bins. So the send builds the
// agent page if it isn't there and puts its link in both channels — while
// leaving an operator's own message exactly as they wrote it, because
// unticking that box is a decision the server must not undo.
//
// Runs against the JSON file backend in a throwaway temp directory, with GHL
// stubbed to a no-op client.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offer-send-page-test-"));
process.env.DATAROOM_SECRET = "test-secret-send";
process.env.CARD_SENDS_ENABLED = "false";

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { ensureOfferPage } = await import("./offer-page.js");

const LOC = "loc-send-page-test";
const BASE = "http://127.0.0.1:4996";
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/offers", createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: BASE,
}));
const server = app.listen(4996);
await store.init();

const req = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const mkOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(),
  locationId: LOC,
  contactId: "contact-1",
  contactName: "Dana Reeves",
  address: "14 Cedar Ave, Renton, WA 98055",
  cashAmount: 412000,
  imageUrl: `${BASE}/uploads/offer.jpg`,
  calc: { settings: {}, inputs: {}, offers: {} },
  createdAt: new Date().toISOString(),
  status: "new",
  statusHistory: [],
  ...over,
});

const pageFor = (offerId) =>
  store.listDatarooms(LOC, { offerId }).then((rooms) => rooms.find((r) => r.kind === "offer") || null);

test("a page is built for an offer that has none, with one share link", async () => {
  const o = await mkOffer();
  const room = await ensureOfferPage({ store, locationId: LOC, offer: o });
  assert.ok(room?.shareToken, "the page comes with the link that makes it forwardable");
  assert.equal(room.kind, "offer");
  assert.match(room.snapshot.note, /^Dana,/, "prefilled the way the modal would have");

  // Idempotent: a second send must reuse the link the agent already has.
  const again = await ensureOfferPage({ store, locationId: LOC, offer: o });
  assert.equal(again.shareToken, room.shareToken);
  assert.equal((await store.listDatarooms(LOC, { offerId: o.id })).length, 1);
});

test("a revoked page is left switched off, and a draft offer has nothing to publish", async () => {
  const o = await mkOffer();
  const room = await ensureOfferPage({ store, locationId: LOC, offer: o });
  room.status = "revoked";
  await store.updateDataroom(room.id, room);
  assert.equal(await ensureOfferPage({ store, locationId: LOC, offer: o }), null,
    "the operator switched that link off — a send must not rebuild around them");

  const draft = await mkOffer({ status: "draft" });
  assert.equal(await ensureOfferPage({ store, locationId: LOC, offer: draft }), null);
  assert.equal(await pageFor(draft.id), null, "and nothing was written");
});

test("a lookup never writes: create:false finds no page and builds none", async () => {
  const o = await mkOffer();
  assert.equal(await ensureOfferPage({ store, locationId: LOC, offer: o, create: false }), null);
  assert.equal(await pageFor(o.id), null);
});

test("an unattended send carries the page link on both channels", async () => {
  const o = await mkOffer();
  const room = await ensureOfferPage({ store, locationId: LOC, offer: o });
  const link = `${BASE}/o/${room.shareToken}`;

  const r = await req("POST", `/api/offers/${o.id}/send`, { channels: ["sms", "email"], docs: ["image"] });
  assert.equal(r.status, 200);
  assert.ok(r.json.previews.sms.message.endsWith(link), r.json.previews.sms.message);
  assert.match(r.json.previews.sms.message, /letter of intent on 14 Cedar Ave/);
  assert.ok(r.json.previews.email.html.includes(`<a href="${link}">`), r.json.previews.email.html);
});

test("an operator's own message goes out as written — the link is theirs to leave out", async () => {
  const o = await mkOffer();
  const room = await ensureOfferPage({ store, locationId: LOC, offer: o });
  const link = `${BASE}/o/${room.shareToken}`;

  const r = await req("POST", `/api/offers/${o.id}/send`, {
    channels: ["sms", "email"], docs: ["image"], message: "Dana — offer attached, call me.",
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.previews.sms.message, "Dana — offer attached, call me.");
  assert.ok(!r.json.previews.email.html.includes(link), "no link the operator didn't put there");
});

test("no page, no link — the send still goes", async () => {
  const o = await mkOffer();
  const r = await req("POST", `/api/offers/${o.id}/send`, { channels: ["sms"], docs: ["image"] });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.json.previews.sms.message, /\/o\//);
  assert.equal(await pageFor(o.id), null, "a preview writes nothing");
});

test.after(() => server.close());
