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
const { dealOutreachPaused } = await import("./shared/offer-status.js");

const LOC = "loc-deal-outreach-route";
const app = express();
app.use(express.json());
app.use("/api/offers", createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client: { call: async () => ({}) } }), uploadDir: process.env.DATA_DIR }));
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
  assert.equal(await after(blast), "dismissed", "resuming sends nothing by itself");
});

test("the switch takes only true or false, and only on a deal", async () => {
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent3", address: "1 Main St, Tacoma, WA", cashAmount: 100000, status: "sent", statusHistory: [] });
  assert.equal((await setStopped(o.id, { stopped: true })).status, 404, "an offer that isn't a deal has nothing to stop");
  await store.updateOffer(o.id, { ...o, deal: { stage: "under_contract", investors: [], stageHistory: [] } });
  assert.equal((await setStopped(o.id, { stopped: "yes" })).status, 400);
});
