// deal-commit-paperwork.test.mjs — committing a buyer from the Deals modal
// drafts the assignment, the same as a commit that came in by text.
//
// What went wrong (found 2026-10-02): "Draft the assignment when a buyer
// commits" (dispoAutopilot.paperworkOnCommit, on at Normal) only ran when
// the conversation marked the buyer committed. Marking them committed by hand
// in the Deals modal moved the deal to buyer found and drafted nothing.
//
//   node --test deal-commit-paperwork.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deal-commit-paperwork-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-deal-commit-paperwork";
const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }), uploadDir: process.env.DATA_DIR }));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const deal = (over = {}) => store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent", address: "1415 2nd St, Snohomish, WA 98290",
  status: "accepted", cashAmount: 420000, statusHistory: [],
  deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 15000, stageHistory: [{ stage: "under_contract", ts: "2026-09-20T00:00:00Z" }],
    investors: [{ contactId: "buyer", name: "Pat Buyer", status: "evaluating" }] }, ...over });
const commit = (id) => fetch(`${B}/api/offers/${id}/deal/investors/buyer`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "committed" }) }).then((r) => r.json());

test("committing a buyer from the Deals modal drafts the assignment when the switch is on", async () => {
  await store.saveOfferSettings(LOC, { company: { name: "Demo Co", signer: "Sam Signer" }, dispoAutopilot: { paperworkOnCommit: true } });
  const o = await deal();
  const r = await commit(o.id);
  assert.equal(r.ok, true, r.error);
  const after = await store.getOffer(o.id);
  assert.equal(after.deal.stage, "buyer_found");
  assert.ok(after.deal.paperwork?.assignmentDraftedAt, "the assignment was drafted");
  assert.equal(after.deal.paperwork.for, "buyer");
  assert.ok(after.assignmentPdfUrl, "and it's on the deal");
});

test("with the switch off, the commit drafts nothing", async () => {
  await store.saveOfferSettings(LOC, { company: { name: "Demo Co" }, dispoAutopilot: { paperworkOnCommit: false } });
  const o = await deal();
  await commit(o.id);
  const after = await store.getOffer(o.id);
  assert.equal(after.deal.stage, "buyer_found");
  assert.equal(after.deal.paperwork, undefined);
});

test("an assignment made by hand is kept when the buyer commits", async () => {
  await store.saveOfferSettings(LOC, { company: { name: "Demo Co" }, dispoAutopilot: { paperworkOnCommit: true } });
  const o = await deal({ assignment: { fields: {}, generatedAt: "2026-09-30T00:00:00Z" }, assignmentPdfUrl: "https://example.test/hand-made.pdf" });
  await commit(o.id);
  const after = await store.getOffer(o.id);
  assert.equal(after.assignmentPdfUrl, "https://example.test/hand-made.pdf");
  assert.equal(after.deal.paperwork, undefined);
});
