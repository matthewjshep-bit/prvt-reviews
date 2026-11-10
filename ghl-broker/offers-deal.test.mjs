// offers-deal.test.mjs — the deal's own terms and its texts (2026-11-09).
//
// What went wrong on the deals after 10/21: a fee typed as "15k" saved as
// nothing and a price could be typed as "450"; taking a deal back left its
// texts queued; a promote queued texts nobody was told about; and a kind of
// house set in the first minutes never changed who got it.
//
//   node --test offers-deal.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offers-deal-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { default: createDispoRouter } = await import("./routes/dispo.js");

const LOC = "loc-offers-deal";
const resolveLocation = () => ({ locationId: LOC, client: { call: async () => ({}) } });
const app = express();
app.use(express.json());
const offersRouter = createOffersRouter({ resolveLocation, uploadDir: process.env.DATA_DIR });
const dispoRouter = createDispoRouter({ resolveLocation });
app.use("/api/offers", offersRouter);
app.use("/api/dispo", dispoRouter);
offersRouter.setDispoDeps({ matchForDeal: dispoRouter.matchForDeal, blastFromApp: dispoRouter.blastFromApp, rankBuyerForDeal: dispoRouter.rankBuyerForDeal, resumeWave: dispoRouter.resumeWave });
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const call = (method, p, body) => fetch(`${B}/api/offers${p}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));
const dealOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent1", contactName: "Avery Agent", address: "310 Juniper Ave, Kent, WA 98031",
  cashAmount: 700000, status: "accepted", statusHistory: [], ...over,
  deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date().toISOString(), contractPrice: 700000, assignmentFee: 30000, assignmentFeeSource: "setting", ...(over.deal || {}) },
});

/* ---------- money fields ---------- */

test("a fee typed as 15k is 15,000 and a contract price of 450 is refused", async () => {
  const o = await dealOffer();
  const fee = await call("PATCH", `/${o.id}/deal`, { assignmentFee: "15k" });
  assert.equal(fee.status, 200, fee.error);
  assert.equal(fee.offer.deal.assignmentFee, 15000);
  assert.equal(fee.offer.deal.assignmentFeeSource, "you", "a fee a person typed");

  const typo = await call("PATCH", `/${o.id}/deal`, { contractPrice: "450" });
  assert.equal(typo.status, 409, "a price that far from our number asks first");
  assert.match(typo.error, /\$450/);
  assert.equal((await store.getOffer(o.id)).deal.contractPrice, 700000, "nothing changed");
  const meant = await call("PATCH", `/${o.id}/deal`, { contractPrice: "450", confirm: true });
  assert.equal(meant.status, 200, "you said you meant it");
  assert.equal(meant.offer.deal.contractPrice, 450);

  assert.equal((await call("PATCH", `/${o.id}/deal`, { contractPrice: "740k" })).offer.deal.contractPrice, 740000);
  const far = await call("PATCH", `/${o.id}/deal`, { contractPrice: "1.2m" });
  assert.equal(far.status, 409, "more than 30% off our number asks first");

  const junk = await call("PATCH", `/${o.id}/deal`, { assignmentFee: "fifteen", notes: "should not land" });
  assert.equal(junk.status, 400);
  assert.match(junk.error, /fifteen/);
  assert.notEqual((await store.getOffer(o.id)).deal.notes, "should not land", "a refused body changes nothing");

  const blank = await call("PATCH", `/${o.id}/deal`, { assignmentFee: "" });
  assert.equal(blank.status, 400, "an emptied box doesn't wipe a fee buyers are priced on");
  assert.equal((await store.getOffer(o.id)).deal.assignmentFee, 15000);
  const cleared = await call("PATCH", `/${o.id}/deal`, { assignmentFee: "", clear: true });
  assert.equal(cleared.offer.deal.assignmentFee, null);

  // The same number sent back (a save of the notes) asks nothing.
  const far2 = await dealOffer({ deal: { contractPrice: 4000000 } });
  const notes = await call("PATCH", `/${far2.id}/deal`, { contractPrice: "4000000", notes: "LOIs by Friday" });
  assert.equal(notes.status, 200, notes.error);
});

test("promote says whether the fee was yours or the default", async () => {
  await store.saveOfferSettings(LOC, { wholesaleFee: 30000 });
  const mk = () => store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent2", address: `${Math.floor(Math.random() * 900) + 100} Spruce St, Kent, WA 98031`,
    cashAmount: 300000, status: "sent", statusHistory: [], sends: [{ ts: new Date().toISOString() }] });
  const a = await call("POST", `/${(await mk()).id}/deal`, {});
  assert.equal(a.offer.deal.assignmentFee, 30000);
  assert.equal(a.offer.deal.assignmentFeeSource, "setting");
  const b = await call("POST", `/${(await mk()).id}/deal`, { assignmentFee: "12.5k" });
  assert.equal(b.offer.deal.assignmentFee, 12500);
  assert.equal(b.offer.deal.assignmentFeeSource, "you");
});
