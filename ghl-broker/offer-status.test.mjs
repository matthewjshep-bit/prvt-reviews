// offer-status.test.mjs — end-to-end checks for the offer lifecycle routes.
// Run with:  npm run test:status
//
// shared/offer-status.test.mjs already covers the rules (what a status means,
// when something is expired). These cover the things only a live router can
// show: that the routes answer at the paths the app actually calls, that a
// status survives the round-trip through the store, and — the two that would
// quietly corrupt data — that "accepted" goes through the same promote path as
// the Deal button, and that a bulk mark can never overwrite an active deal.
//
// Runs against the JSON file backend in a throwaway temp directory, with GHL
// stubbed to a no-op client (every CRM write here is best-effort by design).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offer-status-test-"));
process.env.CARD_SENDS_ENABLED = "false";

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-status-test";
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/offers", createOffersRouter({
  // A client whose every call resolves to nothing: the GHL side effects are
  // exercised but can't reach the network.
  resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:4998",
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

const mkOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(),
  locationId: LOC,
  contactId: "contact-1",
  contactName: "Test Agent",
  address: "1 Main St, Seattle, WA 98101",
  cashAmount: 100000,
  calc: { settings: {}, inputs: {}, offers: {} },
  createdAt: new Date().toISOString(),
  status: "new",
  statusHistory: [],
  ...over,
});

test("an outcome is recorded, noted, and persisted", async () => {
  const o = await mkOffer();
  const r = await req("PATCH", `/api/offers/${o.id}/status`, { status: "passed", note: "listing went pending" });
  assert.equal(r.status, 200);
  assert.equal(r.json.offer.status, "passed");
  assert.equal(r.json.offer.statusNote, "listing went pending");
  assert.equal(r.json.offer.statusHistory.at(-1).status, "passed");
  // Read it back from the store, not the response — the round-trip is the point.
  assert.equal((await store.getOffer(o.id)).status, "passed");
});

test("an unknown status is refused", async () => {
  const o = await mkOffer();
  const r = await req("PATCH", `/api/offers/${o.id}/status`, { status: "vibes" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /status must be one of/);
});

test("a draft has no outcome to record", async () => {
  const o = await mkOffer({ status: "draft" });
  const r = await req("PATCH", `/api/offers/${o.id}/status`, { status: "passed" });
  assert.equal(r.status, 400);
  assert.equal((await store.getOffer(o.id)).status, "draft");
});

test("an offer from another location is invisible", async () => {
  const o = await mkOffer({ locationId: "someone-else" });
  const r = await req("PATCH", `/api/offers/${o.id}/status`, { status: "passed" });
  assert.equal(r.status, 404);
});

test("accepted promotes through the same path as the Deal button", async () => {
  const o = await mkOffer();
  const r = await req("PATCH", `/api/offers/${o.id}/status`, { status: "accepted" });
  assert.equal(r.status, 200);
  assert.equal(r.json.promoted, true);
  assert.equal(r.json.offer.deal.stage, "under_contract");
  assert.equal(r.json.offer.status, "accepted");
  assert.equal(r.json.offer.deal.contractPrice, 100000, "price defaults from the cash offer");

  // Setting it again is a no-op rather than a second deal.
  const again = await req("PATCH", `/api/offers/${o.id}/status`, { status: "accepted" });
  assert.equal(again.status, 200);
  assert.ok(!again.json.promoted);
});

test("un-promoting falls back to the pre-acceptance truth", async () => {
  const never = await mkOffer();
  await req("PATCH", `/api/offers/${never.id}/status`, { status: "accepted" });
  await req("DELETE", `/api/offers/${never.id}/deal`);
  assert.equal((await store.getOffer(never.id)).status, "new", "never sent → back to not sent");

  const wasSent = await mkOffer({ sends: [{ ts: new Date().toISOString(), channels: ["sms"], results: { sms: { ok: true } } }] });
  await req("PATCH", `/api/offers/${wasSent.id}/status`, { status: "accepted" });
  await req("DELETE", `/api/offers/${wasSent.id}/deal`);
  assert.equal((await store.getOffer(wasSent.id)).status, "sent", "docs went out → back to sent");
});

test("bulk marks many, and can never overwrite an active deal", async () => {
  const a = await mkOffer();
  const b = await mkOffer();
  const dealt = await mkOffer();
  await req("PATCH", `/api/offers/${dealt.id}/status`, { status: "accepted" });

  const r = await req("PATCH", "/api/offers/status", {
    ids: [a.id, b.id, dealt.id, "not-a-real-id"],
    status: "no_response",
  });
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
  assert.equal(byId[a.id].ok, true);
  assert.equal(byId[b.id].ok, true);
  assert.equal(byId[dealt.id].ok, false, "an active deal is not bulk-editable");
  assert.equal(byId["not-a-real-id"].ok, false, "one bad id must not sink the batch");

  assert.equal((await store.getOffer(a.id)).status, "no_response");
  assert.equal((await store.getOffer(b.id)).status, "no_response");
  assert.equal((await store.getOffer(dealt.id)).status, "accepted", "the deal is untouched");
});

test("bulk refuses accepted — mass-promoting is never what you meant", async () => {
  const a = await mkOffer();
  const r = await req("PATCH", "/api/offers/status", { ids: [a.id], status: "accepted" });
  assert.equal(r.status, 400);
  assert.equal((await store.getOffer(a.id)).status, "new");
});

test("bulk needs a selection", async () => {
  const r = await req("PATCH", "/api/offers/status", { ids: [], status: "passed" });
  assert.equal(r.status, 400);
});

test.after(() => server.close());
