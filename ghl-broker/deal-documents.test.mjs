// deal-documents.test.mjs — the deal attachment routes (signed P&S, addenda…).
// Run with:  npm run test:deal-docs
//
// Same harness as offer-status.test.mjs: JSON file backend in a throwaway temp
// directory, GHL stubbed to a no-op client. What's worth pinning down here is
// everything that guards bytes the operator will click on later: the type is
// decided by the file's magic number and not by what the client claimed, an
// attachment can only be read or deleted through the offer that owns it, and a
// deleted offer doesn't leave its files behind.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deal-docs-test-"));

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-deal-docs-test";
const app = express();
app.use(express.json({ limit: "30mb" }));
app.use("/api/offers", createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:4997",
}));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();

const req = async (method, p, body) => {
  const r = await fetch(B + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const mkDeal = (over = {}) => store.createOffer({
  id: crypto.randomUUID(),
  locationId: LOC,
  contactId: "contact-1",
  contactName: "Test Agent",
  address: "1 Main St, Seattle, WA 98101",
  cashAmount: 100000,
  status: "accepted",
  statusHistory: [],
  deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date().toISOString() },
  ...over,
});

// A byte-valid minimum of each type the upload path accepts.
const pdf = (body = "hello") => Buffer.from(`%PDF-1.4\n${body}\n%%EOF`);
const png = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("IHDR-ish padding"),
]);
const dataUri = (buf, type = "application/pdf") => `data:${type};base64,${buf.toString("base64")}`;

test("a file attaches, lists, and downloads with its own name", async () => {
  const o = await mkDeal();
  const up = await req("POST", `/api/offers/${o.id}/deal/documents`, {
    name: "Signed PSA.pdf", kind: "Purchase & sale", data: dataUri(pdf("psa")),
  });
  assert.equal(up.status, 200);
  assert.equal(up.json.document.name, "Signed PSA.pdf");
  assert.equal(up.json.document.kind, "Purchase & sale");
  assert.equal(up.json.document.contentType, "application/pdf");
  assert.equal(up.json.documents.length, 1);

  const list = await req("GET", `/api/offers/${o.id}/deal/documents`);
  assert.equal(list.json.documents.length, 1);
  assert.equal(list.json.documents[0].size, pdf("psa").length);

  const r = await fetch(`${B}/api/offers/${o.id}/deal/documents/${up.json.document.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition"), /inline; filename="Signed PSA.pdf"/);
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), pdf("psa").toString());
});

test("the bytes decide the type, not the client", async () => {
  const o = await mkDeal();
  // Claims to be a PDF; is a PNG. Stored as what it actually is.
  const up = await req("POST", `/api/offers/${o.id}/deal/documents`, {
    name: "not-really.pdf", data: dataUri(png(), "application/pdf"),
  });
  assert.equal(up.json.document.contentType, "image/png");

  const bad = await req("POST", `/api/offers/${o.id}/deal/documents`, {
    name: "payload.pdf", data: dataUri(Buffer.from("<script>alert(1)</script>"), "application/pdf"),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /unsupported file type/);
});

test("a name can't escape into the header, and an unknown kind falls back", async () => {
  const o = await mkDeal();
  const up = await req("POST", `/api/offers/${o.id}/deal/documents`, {
    name: 'evil"\r\nX-Injected: 1/../../etc/passwd',
    kind: "Nonsense",
    data: dataUri(pdf()),
  });
  assert.equal(up.json.document.kind, "Other");
  assert.doesNotMatch(up.json.document.name, /["\r\n\\/]/);

  const r = await fetch(`${B}/api/offers/${o.id}/deal/documents/${up.json.document.id}`);
  assert.equal(r.headers.get("x-injected"), null);
});

test("an attachment is only reachable through the offer that owns it", async () => {
  const mine = await mkDeal();
  const theirs = await mkDeal();
  const up = await req("POST", `/api/offers/${mine.id}/deal/documents`, {
    name: "title.pdf", kind: "Title", data: dataUri(pdf("title")),
  });
  const docId = up.json.document.id;

  const crossRead = await fetch(`${B}/api/offers/${theirs.id}/deal/documents/${docId}`);
  assert.equal(crossRead.status, 404);

  const crossDelete = await req("DELETE", `/api/offers/${theirs.id}/deal/documents/${docId}`);
  assert.equal(crossDelete.status, 404);

  // …and the real owner still has it.
  const list = await req("GET", `/api/offers/${mine.id}/deal/documents`);
  assert.equal(list.json.documents.length, 1);
});

test("deleting removes the row and the bytes", async () => {
  const o = await mkDeal();
  const up = await req("POST", `/api/offers/${o.id}/deal/documents`, {
    name: "addendum.pdf", kind: "Addendum", data: dataUri(pdf("addendum")),
  });
  const del = await req("DELETE", `/api/offers/${o.id}/deal/documents/${up.json.document.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.documents.length, 0);
  assert.equal(await store.readDealDocBytes(up.json.document.id), null);
  assert.equal((await req("DELETE", `/api/offers/${o.id}/deal/documents/${up.json.document.id}`)).status, 404);
});

test("an offer that isn't a deal has no attachment list", async () => {
  const plain = await store.createOffer({
    id: crypto.randomUUID(), locationId: LOC, address: "2 Main St", status: "new", statusHistory: [],
  });
  assert.equal((await req("GET", `/api/offers/${plain.id}/deal/documents`)).status, 404);
});

test("deleting the offer takes its attachments with it", async () => {
  const o = await mkDeal();
  const up = await req("POST", `/api/offers/${o.id}/deal/documents`, {
    name: "inspection.pdf", kind: "Inspection", data: dataUri(pdf("inspection")),
  });
  await req("DELETE", `/api/offers/${o.id}`);
  assert.equal((await store.listDealDocs(o.id)).length, 0);
  assert.equal(await store.readDealDocBytes(up.json.document.id), null);
});

// The temp dir is left for the OS to reap: the store's persist() is debounced,
// so deleting it here just races a pending write and logs a scary line.
test.after(() => server.close());
