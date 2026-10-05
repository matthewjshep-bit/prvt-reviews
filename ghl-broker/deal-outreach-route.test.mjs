// deal-outreach-route.test.mjs — Stop outreach on a deal from the deal pane,
// and start it again (Matt, 2026-10-01, 5232 S Yakima: "stop outreach on
// this one completely").
//
//   node --test deal-outreach-route.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deal-outreach-route-test-"));
delete process.env.DATABASE_URL;
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { default: createDispoRouter } = await import("./routes/dispo.js");
const { dealOutreachPaused } = await import("./shared/offer-status.js");

const LOC = "loc-deal-outreach-route";
const resolveLocation = () => ({ locationId: LOC, client: { call: async () => ({}) } });
const app = express();
app.use(express.json());
const offersRouter = createOffersRouter({ resolveLocation, uploadDir: process.env.DATA_DIR });
const dispoRouter = createDispoRouter({ resolveLocation });
app.use("/api/offers", offersRouter);
app.use("/api/dispo", dispoRouter);
// Wired as broker.js wires them.
offersRouter.setDispoDeps({ matchForDeal: dispoRouter.matchForDeal, blastFromApp: dispoRouter.blastFromApp, rankBuyerForDeal: dispoRouter.rankBuyerForDeal, resumeWave: dispoRouter.resumeWave });
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();
test.after(() => server.close());

const setStopped = (id, body) => fetch(`${B}/api/offers/${id}/deal/outreach`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));

const ADDRESS = "5232 South Yakima Avenue, Tacoma, WA 98408";
const draft = (over) => store.createReplyDraft({ locationId: LOC, channel: "sms", party: "investor", reply: "…", inbound: "", flags: [], ...over });

test("stopping outreach on a deal pulls back what was queued about it, leaves everything else, and resuming clears it", async () => {
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent1", address: ADDRESS, cashAmount: 231250, status: "accepted", statusHistory: [],
    deal: { stage: "under_contract", investors: [], stageHistory: [], blasts: [{ at: new Date().toISOString(), via: "app", wave: 1, count: 2 }] } });
  const other = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent2", address: "7034 South K Street, Tacoma, WA 98408", cashAmount: 318000, status: "accepted", statusHistory: [],
    deal: { stage: "under_contract", investors: [], stageHistory: [] } });
  const sendAt = new Date(Date.now() + 5 * 60000).toISOString();

  const blast = await draft({ contactId: "b1", status: "scheduled", sendAt, intent: "blast_open", outbound: { kind: "blast_open", offerId: o.id, address: ADDRESS } });
  const nudge = await draft({ contactId: "b2", status: "draft", intent: "blast_nudge", outbound: { kind: "blast_nudge", offerId: o.id, address: ADDRESS } });
  const reply = await draft({ contactId: "b3", status: "scheduled", sendAt, intent: "question", inbound: "What's the number on Yakima?", propertyAddress: "5232 South Yakima Avenue, Tacoma" });
  const waiting = await draft({ contactId: "b4", status: "draft", intent: "wants_walkthrough", inbound: "Can I see it Saturday?", propertyAddress: "5232 South Yakima Avenue" });
  const elsewhere = await draft({ contactId: "b5", status: "scheduled", sendAt, intent: "blast_open", outbound: { kind: "blast_open", offerId: other.id, address: other.address } });
  const agent = await draft({ contactId: "agent1", party: "agent", status: "scheduled", sendAt, intent: "question", inbound: "When's inspection?", propertyAddress: ADDRESS });

  const r = await setStopped(o.id, { stopped: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.offer.deal.outreachStopped?.at, "the deal carries the stop");
  assert.equal(dealOutreachPaused(r.offer.deal).status, "stopped");
  assert.deepEqual(r.pulled, { dismissed: 2, held: 1 });

  const after = async (d) => (await store.getReplyDraft(d.id)).status;
  assert.equal(await after(blast), "dismissed", "the queued blast text never goes");
  assert.equal(await after(nudge), "dismissed", "nor the nudge waiting in the outbox");
  assert.equal(await after(reply), "draft", "the bot's reply to a buyer comes back to you");
  assert.equal((await store.getReplyDraft(reply.id)).sendAt, null);
  assert.match((await store.getReplyDraft(reply.id)).autoSend?.reason || "", /^needs a person: you stopped outreach/, "the nightly audit won't release it");
  assert.equal(await after(waiting), "draft", "a reply already waiting for you is left as it is");
  assert.equal(await after(elsewhere), "scheduled", "another deal's blast is untouched");
  assert.equal(await after(agent), "scheduled", "the listing agent's thread is not buyer outreach");

  // Pressing it twice keeps the first time.
  const again = await setStopped(o.id, { stopped: true });
  assert.equal(again.offer.deal.outreachStopped.at, r.offer.deal.outreachStopped.at);

  const resumed = await setStopped(o.id, { stopped: false });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.offer.deal.outreachStopped, undefined);
  assert.equal(dealOutreachPaused((await store.getOffer(o.id)).deal), null, "live again");
  assert.equal(await after(nudge), "dismissed", "a nudge isn't put back; the nudge sweep drafts it again once the deal text has gone");
  assert.equal(await after(reply), "draft", "a reply the stop handed back stays with you");
  assert.equal(resumed.resumed.dropped, 1, "b1 isn't in the buyer book, so the wave rules don't pick them");
});

// 9311 12th Pl SE, 2026-10-04: Matt stopped outreach right after the deal was
// made and pressed Resume; the wave's 25 texts stayed pulled back and the
// next wave counted those buyers as sent, so none of them ever heard of it.
const buyer = (contactId) => ({
  contactId, name: `Buyer ${contactId}`,
  doc: { name: `Buyer ${contactId}`, phone: "+12065550199", tags: ["investor"], custom: { buybox_areas: "Kent" } },
  buyboxText: "",
});
const KENT = (n) => `${n} Main St, Kent, WA 98031`;

test("resuming a deal you stopped sends the deal texts Stop pulled back, and the next wave counts from the resume", async () => {
  await store.saveOfferSettings(LOC, { dispoAutopilot: { autoBlastOnPromote: true, minMatchScore: 0, secondWaveMinScore: 0 } });
  await store.upsertInvestors(LOC, ["k1", "k2", "k-passed"].map(buyer));
  const firstAt = new Date(Date.now() - 60000).toISOString();
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-k", address: KENT(123), cashAmount: 300000, status: "accepted", statusHistory: [],
    deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date(Date.now() - 120000).toISOString(), blastTags: ["dispo-123-main-st"],
      blasts: [{ at: firstAt, via: "app", wave: 1, count: 3, tag: "dispo-123-main-st", contactIds: ["k1", "k2", "k-passed"] }] } });
  const sendAt = new Date(Date.now() + 9 * 60000).toISOString();
  for (const cid of ["k1", "k2", "k-passed"]) {
    await draft({ contactId: cid, contactName: `Buyer ${cid}`, status: "scheduled", sendAt, intent: "blast_open",
      outbound: { kind: "blast_open", offerId: o.id, address: o.address, label: "dispo-123-main-st" } });
  }

  const stopped = await setStopped(o.id, { stopped: true });
  assert.equal(stopped.pulled.dismissed, 3, "the stop pulls the whole wave back");

  // One of them passes on it while it's stopped.
  const mid = await store.getOffer(o.id);
  mid.deal.investors = [{ contactId: "k-passed", name: "Buyer k-passed", status: "passed" }];
  await store.updateOffer(o.id, mid);

  const r = await setStopped(o.id, { stopped: false });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual({ ...r.resumed, reason: undefined }, { firstWave: false, queued: 0, drafted: 2, dropped: 1, reason: undefined }, JSON.stringify(r.resumed));
  assert.match(r.resumed.reason, /CARD_SENDS_ENABLED/, "sends are off in tests, so they come back as drafts and say why");
  const open = await store.listReplyDrafts(LOC, { status: ["draft", "scheduled"], limit: 100 });
  const back = open.filter((d) => d.outbound?.kind === "blast_open" && d.outbound.offerId === o.id);
  assert.deepEqual(back.map((d) => d.contactId).sort(), ["k1", "k2"], "the buyer who passed meanwhile isn't sent it");
  assert.ok(back.every((d) => d.outbound.label === "dispo-123-main-st"));

  const wave = r.offer.deal.blasts.at(-1);
  assert.equal(r.offer.deal.blasts.length, 1, "it's still the first wave, not a new one");
  assert.ok(Date.parse(wave.resumedAt) > Date.parse(firstAt));
  const preview = await (await fetch(`${B}/api/dispo/waves/preview?offerId=${o.id}`)).json();
  assert.equal(preview.next.dueAt, new Date(Date.parse(wave.resumedAt) + 48 * 3600000).toISOString(), "wave 2 is two days after the resume");

  // Pressing Resume on a deal that isn't stopped does nothing.
  const twice = await setStopped(o.id, { stopped: false });
  assert.equal(twice.resumed, undefined);
});

test("a deal stopped before its first wave was picked gets that wave when you resume", async () => {
  // A mobile home, like 9311: its wave goes to the buyers who buy them, whatever their tier.
  const mh = buyer("k3");
  await store.upsertInvestors(LOC, [{ ...mh, doc: { ...mh.doc, tags: ["investor", "dispo-type-mobile-home"] } }]);
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-k2", address: KENT(456), cashAmount: 300000, status: "accepted", statusHistory: [],
    asset: { type: "manufactured", land: "own_lot", by: "you" },
    deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date().toISOString(), outreachStopped: { at: new Date().toISOString(), by: "you" } } });
  const r = await setStopped(o.id, { stopped: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.resumed.firstWave, true);
  assert.equal(r.resumed.drafted, 1, JSON.stringify(r.resumed));
  assert.equal(r.offer.deal.blasts.length, 1);
  assert.deepEqual(r.offer.deal.blasts[0].contactIds, ["k3"]);
  assert.equal(r.offer.deal.blasts[0].wave, 1);
});

test("the switch takes only true or false, and only on a deal", async () => {
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent3", address: "1 Main St, Tacoma, WA", cashAmount: 100000, status: "sent", statusHistory: [] });
  assert.equal((await setStopped(o.id, { stopped: true })).status, 404, "an offer that isn't a deal has nothing to stop");
  await store.updateOffer(o.id, { ...o, deal: { stage: "under_contract", investors: [], stageHistory: [] } });
  assert.equal((await setStopped(o.id, { stopped: "yes" })).status, 400);
});
