// promote-price.test.mjs — a deal made from Today's Promote is priced off the
// paper or the book, never an "agreed" on record above them.
//
// Review, 2026-10-02: live data had a realm "yes" at 289,750 on an offer since
// re-priced to 226,000. Promote would have made the deal at 289,750, and the
// buyer blasts would have priced off it.
//
//   node --test promote-price.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "promote-price-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-promote-price";
const client = { call: async () => ({}) };
const router = createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR });
await store.init();

test("Promote makes the deal at the offer's number and the closing date they named, not a stale agreement above it", async () => {
  await store.saveOfferSettings(LOC, { wholesaleFee: 15000 });
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent1", contactName: "Anne T", address: "3418 Wetmore Ave, Everett, WA 98201",
    status: "sent", cashAmount: 226000, statusHistory: [], createdAt: "2026-09-20T00:00:00Z", sends: [{ ts: "2026-09-21T00:00:00Z" }],
    agreed: { amount: 289750, at: "2026-10-02T01:52:28Z", via: "realm_yes" }, realm: { answer: "yes", ts: "2026-10-02T01:52:28Z" } });
  const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });
  const r = await deps.promoteToDeal({ contactId: "agent1", addressHint: "3418 Wetmore Ave", closingDate: "2026-10-24" });
  assert.equal(r.ok, true, r.reason);
  const after = await store.getOffer(o.id);
  assert.equal(after.deal.contractPrice, 226000, "the book's number");
  assert.equal(after.deal.closingDate, "2026-10-24");
});

/* ---------- before we sign (shared/pre-contract.js, 2026-10-15) ---------- */

test("a promote with things nobody checked says so and keeps them on the deal — it never blocks", async () => {
  await store.saveOfferSettings(LOC, { wholesaleFee: 15000 });
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent2", contactName: "Dana Agent", address: "41 Alder Way, Kent, WA 98030",
    status: "sent", cashAmount: 300000, statusHistory: [], createdAt: "2026-10-01T00:00:00Z", sends: [{ ts: "2026-10-02T00:00:00Z" }],
    realm: { answer: "yes", ts: "2026-10-10T00:00:00Z" }, calc: { inputs: { arv: 500000, repairs: 20000 } }, snapshot: { subjectSqft: 1300 },
    preContract: { ticks: { extension: { at: "2026-10-11T00:00:00Z" } } } });
  const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });
  const r = await deps.promoteToDeal({ contactId: "agent2", addressHint: "41 Alder Way" });
  assert.equal(r.ok, true, r.reason);
  const after = await store.getOffer(o.id);
  assert.equal(after.deal.stage, "under_contract", "promoted anyway");
  const rec = after.deal.preContractAtPromote;
  assert.ok(rec?.at);
  assert.ok(rec.open.includes("rehab_floor"), "20k of rehab on 1,300 sqft is under the light floor");
  assert.ok(rec.open.includes("presell"));
  assert.ok(!rec.open.includes("extension"), "your tick stands");
  assert.ok((after.warnings || []).some((w) => /^before signing, not checked: .*rehab at or above the light floor/.test(w)), (after.warnings || []).join(" | "));
});

test("the buyers a house was pre-sold to join the deal; a pre-sell text nobody sent stands down for the first wave", async () => {
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent3", contactName: "Pat Agent", address: "9 Birch St, Kent, WA 98030",
    status: "sent", cashAmount: 250000, statusHistory: [], createdAt: "2026-10-01T00:00:00Z", sends: [{ ts: "2026-10-02T00:00:00Z" }],
    realm: { answer: "yes", ts: "2026-10-10T00:00:00Z" }, presell: { at: "2026-10-11T00:00:00Z", contactIds: ["buyer-sent", "buyer-waiting"] } });
  const sent = await store.createReplyDraft({ locationId: LOC, contactId: "buyer-sent", contactName: "Sam Buyer", status: "sent", party: "investor", intent: "blast_open",
    outbound: { kind: "blast_open", offerId: o.id, address: o.address, presell: true }, reply: "Hey Sam, lining one up in Kent…" });
  const waiting = await store.createReplyDraft({ locationId: LOC, contactId: "buyer-waiting", contactName: "Lee Buyer", status: "draft", party: "investor", intent: "blast_open",
    outbound: { kind: "blast_open", offerId: o.id, address: o.address, presell: true }, reply: "Hey Lee, lining one up in Kent…" });
  const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });
  const r = await deps.promoteToDeal({ contactId: "agent3", addressHint: "9 Birch St" });
  assert.equal(r.ok, true, r.reason);
  const after = await store.getOffer(o.id);
  assert.deepEqual(after.deal.investors.map((i) => [i.contactId, i.status, i.source]), [["buyer-sent", "evaluating", "presell"]]);
  assert.equal((await store.getReplyDraft(waiting.id)).status, "superseded");
  assert.equal((await store.getReplyDraft(sent.id)).status, "sent");
});

test("a pre-contract item is ticked by hand and read back with the rest", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/offers", router);
  const srv = app.listen(0);
  const url = (id) => `http://127.0.0.1:${srv.address().port}/api/offers/${id}/precontract`;
  try {
    const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent4", address: "77 Cedar Ct, Kent, WA 98030",
      status: "sent", cashAmount: 280000, statusHistory: [], realm: { answer: "yes", ts: "2026-10-10T00:00:00Z" } });
    const before = await (await fetch(url(o.id))).json();
    assert.equal(before.checks.find((c) => c.key === "eyes").state, "unknown");
    const post = (body) => fetch(url(o.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = await (await post({ key: "eyes", note: "walked it Tuesday" })).json();
    assert.equal(r.checks.find((c) => c.key === "eyes").state, "ok");
    assert.match(r.checks.find((c) => c.key === "eyes").detail, /walked it Tuesday/);
    assert.ok((await store.getOffer(o.id)).preContract.ticks.eyes.at);
    assert.equal((await post({ key: "nonsense" })).status, 400);
  } finally { srv.close(); }
});
