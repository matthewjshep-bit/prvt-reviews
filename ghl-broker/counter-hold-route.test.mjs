// counter-hold-route.test.mjs — GET /api/offers/:id/hold, the Desk's "Hold
// our number" on a counter: the words, at the lowest number we've put to
// them on the house, read from the thread. Never sends.
//
//   node --test counter-hold-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "counter-hold-route-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-counter-hold";
// The thread: we texted 65k by hand after the 71,075 offer went out.
const client = { call: async (p) => {
  if (String(p).startsWith("/conversations/search")) return { conversations: [{ id: "cv1", contactId: "kim" }] };
  if (String(p).includes("/conversations/cv1/messages")) return { messages: { messages: [
    { id: "m1", direction: "outbound", messageType: "TYPE_SMS", body: "Can we do $65k actually on 1510 Maple Lane", dateAdded: "2026-09-13T18:00:00Z" },
  ], nextPage: false } };
  return {};
} };
const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

test("Hold names the lowest number we've put to them, and sends nothing", async () => {
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "kim", contactName: "Kim P", address: "1510 Maple Lane, Kent, WA 98030",
    status: "countered", cashAmount: 71075, statusHistory: [], createdAt: "2026-09-10T00:00:00Z", sends: [{ ts: "2026-09-10T01:00:00Z" }], counter: { amount: 76000, at: "2026-09-14T00:00:00Z" } });
  const r = await (await fetch(`${B}/api/offers/${o.id}/hold`)).json();
  assert.equal(r.ok, true, r.error);
  assert.ok(r.amount <= 71075, `never above the book (${r.amount})`);
  assert.match(r.text, /hold at \$/);
  const after = await store.getOffer(o.id);
  assert.equal(after.cashAmount, 71075, "nothing about the offer changed");
  assert.deepEqual(after.sends, o.sends, "nothing went out");
});

test("a deal has no number to hold — its contract price is the number", async () => {
  const d = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "x", address: "1 Deal St", status: "accepted", cashAmount: 100000, statusHistory: [],
    deal: { stage: "under_contract", investors: [], contractPrice: 100000 } });
  assert.equal((await fetch(`${B}/api/offers/${d.id}/hold`)).status, 409);
});
