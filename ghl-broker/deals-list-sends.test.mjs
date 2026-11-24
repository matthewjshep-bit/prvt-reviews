// deals-list-sends.test.mjs — the Deals list says how many buyers a deal
// actually went to (2026-11-23 audit, D4), and a signed document upload hands
// back the deal so the modal's checklist is current (D11).
// Run with: node --test deals-list-sends.test.mjs
//
// JSON file backend in a temp dir, GHL stubbed, an ephemeral port. Names and
// ids are invented.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deals-list-sends-test-"));

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-deals-list-sends";
const app = express();
app.use(express.json({ limit: "30mb" }));
app.use("/api/offers", createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1",
}));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const req = async (method, p, body) => {
  const r = await fetch(B + p, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const mkDeal = (over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent-1", contactName: "Test Agent",
  address: "12 Alder Ln, Kent, WA 98030", cashAmount: 300000, status: "accepted", statusHistory: [],
  deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date().toISOString(), ...over },
});

const ev = (offerId, contactId, type, at, n = "") => store.appendContactEvents(LOC, contactId, [{
  type, at, offerId, party: "investor", source: "blast", dedupeKey: `${type}:${offerId}:${contactId}${n}`,
}]);

test("a stopped blast doesn't make the Deals list say the deal went out: sent counts buyers it actually reached", async () => {
  const stopped = await mkDeal({ blasts: [{ count: 151, at: new Date().toISOString() }] });
  const sent = await mkDeal();
  await ev(sent.id, "buyer-a", "blast_sent", "2026-11-20T18:00:00.000Z");
  await ev(sent.id, "buyer-b", "deal_hand_sent", "2026-11-21T18:00:00.000Z");
  // The same buyer twice (a hand text after an app text) is one buyer.
  await ev(sent.id, "buyer-a", "deal_hand_sent", "2026-11-22T18:00:00.000Z");
  // Another kind of event on the deal is not a send.
  await ev(sent.id, "buyer-c", "investor_evaluating", "2026-11-22T19:00:00.000Z");

  const r = await req("GET", "/api/offers/deals");
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.json.deals.map((o) => [o.id, o]));
  assert.deepEqual(byId[stopped.id].deal.sends, { sent: 0, lastAt: null });
  assert.deepEqual(byId[sent.id].deal.sends, { sent: 2, lastAt: "2026-11-22T18:00:00.000Z" });
});

test("both store backends count a deal's sends the same way", async () => {
  const o = await mkDeal();
  await ev(o.id, "buyer-x", "blast_sent", "2026-11-19T18:00:00.000Z");
  const counts = await store.dealSendCounts(LOC, [o.id, "no-such-offer"]);
  assert.deepEqual(counts[o.id], { sent: 1, lastAt: "2026-11-19T18:00:00.000Z" });
  assert.equal(counts["no-such-offer"], undefined);
  assert.deepEqual(await store.dealSendCounts(LOC, []), {});
});

test("uploading the signed assignment ticks Assignment signed on screen: the upload answers with the deal", async () => {
  const o = await mkDeal();
  const pdf = Buffer.from("%PDF-1.4\nsigned\n%%EOF");
  const up = await req("POST", `/api/offers/${o.id}/deal/documents`, {
    name: "Assignment signed.pdf", kind: "Assignment", data: `data:application/pdf;base64,${pdf.toString("base64")}`,
  });
  assert.equal(up.status, 200);
  assert.equal(up.json.documents.length, 1);
  assert.ok(up.json.offer?.deal, "the response carries the updated offer");
  const item = up.json.offer.deal.checklist.items.find((i) => i.doc === "Assignment");
  assert.ok(item, "the checklist has an item the assignment ticks");
  assert.equal(item.done, true);
});
