// deal-hand-sent.test.mjs — a deal Matt texts to a buyer by hand counts as
// sent (2026-11-09).
//
// After 10/21 about 1,140 buyers got deals through scripts on the hand-text
// route, which recorded only that a person texted them. The app's newest
// "sent" was 10/20, so the morning catch-up, or a Resume on a stopped deal,
// would have texted the same buyers the same deal again.
//
//   node --test deal-hand-sent.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deal-hand-sent-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { default: createDispoRouter } = await import("./routes/dispo.js");
const { sendHandReply } = await import("./hand-reply.js");
const { DEAL_SENT_TYPES } = await import("./shared/buyer-score.js");

const LOC = "loc-deal-hand-sent";
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

const buyer = (contactId) => ({
  contactId, name: `Buyer ${contactId}`,
  doc: { name: `Buyer ${contactId}`, phone: "+12065550199", tags: ["investor"], custom: { buybox_areas: "Kent" } },
  buyboxText: "",
});
const handText = (contactId, offerId) => sendHandReply({ store, locationId: LOC, contactId, offerId, text: "Hey, I've got a house on Birch St in Kent. Any interest?", live: true,
  deps: { sendSms: async () => ({ messageId: `m-${contactId}` }), removeContactTags: async () => {} } });
const setStopped = (id, stopped) => fetch(`${B}/api/offers/${id}/deal/outreach`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stopped }) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));

test("a buyer Matt texted the deal by hand isn't picked again by the morning catch-up or Resume", async () => {
  await store.saveOfferSettings(LOC, { dispoAutopilot: { autoBlastOnPromote: true } });
  await store.upsertInvestors(LOC, ["h1", "h2", "h3"].map(buyer));
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-h", address: "88 Birch St, Kent, WA 98031", cashAmount: 300000, status: "accepted", statusHistory: [],
    deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date(Date.now() - 3600000).toISOString(), blastTags: ["dispo-88-birch-st"],
      blasts: [{ at: new Date(Date.now() - 3000000).toISOString(), via: "app", wave: 1, count: 2, tag: "dispo-88-birch-st", contactIds: ["h1", "h2"] }] } });
  // The promote blast queued h1 and h2; Matt pressed Stop on it.
  for (const cid of ["h1", "h2"]) {
    await store.createReplyDraft({ locationId: LOC, contactId: cid, contactName: `Buyer ${cid}`, channel: "sms", party: "investor", status: "scheduled", sendAt: new Date(Date.now() + 600000).toISOString(),
      intent: "blast_open", reply: "…", inbound: "", flags: [], outbound: { kind: "blast_open", offerId: o.id, address: o.address, label: "dispo-88-birch-st" } });
  }
  assert.equal((await setStopped(o.id, true)).pulled.dismissed, 2);

  // Then texted h1 and h3 the deal himself, and the listing agent about it.
  await handText("h1", o.id);
  await handText("h3", o.id);
  await handText("agent-h", o.id);
  const ledger = await store.listContactEventsSince(LOC, "1970-01-01T00:00:00.000Z", { types: DEAL_SENT_TYPES, limit: 100 });
  assert.deepEqual(ledger.filter((e) => e.type === "deal_hand_sent").map((e) => e.contactId).sort(), ["h1", "h3"], "the listing agent isn't a buyer");
  assert.ok(ledger.every((e) => e.offerId === o.id && e.data?.messageId), "it says which deal and which message");
  // A second hand text of the same deal is the same one sent.
  await handText("h1", o.id);
  assert.equal((await store.listContactEventsSince(LOC, "1970-01-01T00:00:00.000Z", { types: ["deal_hand_sent"], limit: 100 })).filter((e) => e.contactId === "h1").length, 1);

  // Nobody he texted is new to the deal.
  const preview = await (await fetch(`${B}/api/dispo/waves/preview?offerId=${o.id}`)).json();
  assert.deepEqual(preview.wouldGet.map((w) => w.contactId), [], "h1 and h3 had it by hand; h2 is still on the stopped send");

  // Resume puts back the stopped send, but only to the buyer who never got it.
  const r = await setStopped(o.id, false);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.resumed.dropped, 1, JSON.stringify(r.resumed));
  const open = (await store.listReplyDrafts(LOC, { status: ["draft", "scheduled"], limit: 100 }))
    .filter((d) => d.outbound?.kind === "blast_open" && d.outbound.offerId === o.id);
  assert.deepEqual(open.map((d) => d.contactId), ["h2"]);
});

test("a hand text with no deal behind it, or to someone outside the buyer book, isn't a deal sent", async () => {
  await store.upsertInvestors(LOC, [buyer("h9")]);
  const offer = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-z", address: "9 Cedar Ct, Kent, WA 98031", cashAmount: 250000, status: "sent", statusHistory: [] });
  await handText("h9", offer.id);
  await handText("someone-else", offer.id);
  const rows = await store.listContactEventsSince(LOC, "1970-01-01T00:00:00.000Z", { types: ["deal_hand_sent"], limit: 100 });
  assert.equal(rows.filter((e) => e.offerId === offer.id).length, 0);
});

test("the ledger backfill runs dry unless told otherwise, on a deal only, and answers with counts", async () => {
  const post = (body) => fetch(`${B}/api/dispo/ledger/backfill`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const notDeal = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-q", address: "5 Quail Ln, Kent, WA 98031", cashAmount: 200000, status: "sent", statusHistory: [] });
  assert.equal((await post({ offerId: notDeal.id })).status, 404);
  const deal = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-q", address: "6 Quail Ln, Kent, WA 98031", cashAmount: 200000, status: "accepted", statusHistory: [],
    deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date().toISOString() } });
  const r = await post({ offerId: deal.id });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.job.dryRun, true);
  assert.deepEqual(Object.keys(r.job.skipped).sort(), ["already", "dealParties", "failedSend", "listingAgent", "notInBook"]);
  await new Promise((done) => setTimeout(done, 50));
  const back = await (await fetch(`${B}/api/dispo/ledger/backfill?offerId=${deal.id}`)).json();
  assert.equal(back.job.status, "done", back.job.error);
});
