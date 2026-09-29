// deal-closing.test.mjs — the deal's parties and its closing checklist.
//
// Same harness as deal-documents.test.mjs: JSON file backend in a temp
// directory, GHL stubbed to a no-op client. What matters: a party edit only
// touches the role it names, a checklist edit is one item and survives the
// next read, the signed paper ticks its own line when it's uploaded, and a
// new deal starts with the standard checklist written down.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deal-closing-test-"));
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { CHECKLIST_TEMPLATE } = await import("./shared/deal-checklist.js");

const LOC = "loc-deal-closing-test";
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/offers", createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }),
  uploadDir: process.env.DATA_DIR,
}));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();

const req = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const mkOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent-1", contactName: "Mick Walls",
  address: "3511 Northeast 153rd Street, Lake Forest Park, WA 98155", cashAmount: 400000, status: "sent",
  statusHistory: [{ ts: new Date().toISOString(), status: "sent" }], ...over,
});
const mkDeal = () => mkOffer({ status: "accepted", deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date().toISOString() } });

test("a new deal starts with the standard closing checklist written down", async () => {
  const o = await mkOffer();
  const r = await req("POST", `/api/offers/${o.id}/deal`, { contractPrice: 400000, assignmentFee: 21000 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const deal = (await store.getOffer(o.id)).deal;
  assert.equal(deal.checklist.items.length, CHECKLIST_TEMPLATE.length);
  assert.equal(deal.checklist.items[0].id, "psa_signed");
});

test("a party edit touches only the role it names, and null brings the default back", async () => {
  const o = await mkDeal();
  let r = await req("PATCH", `/api/offers/${o.id}/deal`, { parties: { title: { company: "Ticor Title", name: "Jane Doe", phone: "206-555-0100" }, buyerAgent: { name: "  " } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await req("PATCH", `/api/offers/${o.id}/deal`, { parties: { lender: { name: "Hard Money Co" } } });
  let parties = (await store.getOffer(o.id)).deal.parties;
  assert.deepEqual(Object.keys(parties).sort(), ["lender", "title"]);
  assert.equal(parties.title.company, "Ticor Title");
  await req("PATCH", `/api/offers/${o.id}/deal`, { parties: { title: null } });
  parties = (await store.getOffer(o.id)).deal.parties;
  assert.deepEqual(Object.keys(parties), ["lender"]);
});

test("checklist items tick, re-date, add and remove one at a time", async () => {
  const o = await mkDeal();
  let r = await req("POST", `/api/offers/${o.id}/deal/checklist`, { id: "earnest_money", done: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await req("POST", `/api/offers/${o.id}/deal/checklist`, { id: "prelim_title", due: "2026-10-09", owner: "title" });
  r = await req("POST", `/api/offers/${o.id}/deal/checklist`, { add: { gate: "under_contract", label: "HOA docs from seller", owner: "sellerAgent" } });
  r = await req("POST", `/api/offers/${o.id}/deal/checklist`, { id: "lender_clear", remove: true });
  const items = (await store.getOffer(o.id)).deal.checklist.items;
  assert.equal(items.find((i) => i.id === "earnest_money").done, true);
  assert.equal(items.find((i) => i.id === "prelim_title").due, "2026-10-09");
  assert.equal(items.some((i) => i.label === "HOA docs from seller" && i.custom), true);
  assert.equal(items.some((i) => i.id === "lender_clear"), false);
  assert.equal((await req("POST", `/api/offers/${o.id}/deal/checklist`, { id: "nope", done: true })).status, 404);
  assert.equal((await req("POST", `/api/offers/${o.id}/deal/checklist`, { add: { gate: "closed", label: "x" } })).status, 400);
});

test("uploading the signed assignment ticks its line on the checklist", async () => {
  const o = await mkDeal();
  const data = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\nassignment\n%%EOF").toString("base64")}`;
  const up = await req("POST", `/api/offers/${o.id}/deal/documents`, { name: "Assignment signed.pdf", kind: "Assignment", data });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const items = (await store.getOffer(o.id)).deal.checklist.items;
  assert.equal(items.find((i) => i.id === "assignment_signed").done, true);
  assert.equal(items.find((i) => i.id === "psa_signed").done, false);
});

test.after(() => server.close());
