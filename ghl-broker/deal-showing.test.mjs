// deal-showing.test.mjs — the buyer walkthrough routes on a deal.
//
// Same harness as deal-documents.test.mjs: JSON file backend in a temp
// directory, GHL stubbed to a no-op client, CARD_SENDS_ENABLED unset so
// nothing is ever scheduled to send. What matters: the window and access are
// the operator's to set and survive a save, the ask to the listing agent is
// written to the outbox for the agent (not a buyer) and marks the deal
// asked, and a buyer's answer set by hand sticks.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deal-showing-test-"));
delete process.env.CARD_SENDS_ENABLED;

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-deal-showing-test";
const app = express();
app.use(express.json());
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
const mkDeal = () => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactId: "agent-1", contactName: "Mick Walls",
  address: "3511 Northeast 153rd Street, Lake Forest Park, WA 98155", cashAmount: 400000, status: "accepted", statusHistory: [],
  deal: { stage: "under_contract", investors: [{ contactId: "buyer-1", name: "Rick R", status: "evaluating" }], stageHistory: [], createdAt: new Date().toISOString() },
});

test("the walkthrough window and who lets buyers in are saved on the deal, and a window settles the ask", async () => {
  const o = await mkDeal();
  const r = await req("PATCH", `/api/offers/${o.id}/deal`, { showing: {
    windows: [{ start: "2026-10-03T17:00:00Z", end: "2026-10-03T19:00:00Z" }], access: { mode: "lockbox", note: "code from Mick" },
  } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = (await store.getOffer(o.id)).deal.showing;
  assert.equal(s.windows.length, 1);
  assert.equal(s.access.mode, "lockbox");
  assert.equal(s.agentAsk.status, "confirmed");
});

test("asking the listing agent for a window drafts one text to the agent and marks the deal asked", async () => {
  const o = await mkDeal();
  const preview = await req("GET", `/api/offers/${o.id}/deal/showing/ask-agent`);
  assert.match(preview.json.text, /^Hi Mick, I'd like to line up a buyer walkthrough at 3511 Northeast 153rd Street/);
  const r = await req("POST", `/api/offers/${o.id}/deal/showing/ask-agent`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, "draft", "sends are off on the broker, so it waits");
  const d = await store.getReplyDraft(r.json.draftId);
  assert.equal(d.contactId, "agent-1");
  assert.equal(d.party, "agent");
  assert.equal(d.outbound.kind, "showing_ask");
  const s = (await store.getOffer(o.id)).deal.showing;
  assert.equal(s.agentAsk.status, "asked");
  assert.equal(s.agentAsk.draftId, d.id);
  // Asking again replaces the first ask rather than queueing two.
  const again = await req("POST", `/api/offers/${o.id}/deal/showing/ask-agent`, { text: "Hi Mick, any day this week for buyers?" });
  assert.equal((await store.getReplyDraft(r.json.draftId)).status, "superseded");
  assert.equal((await store.getReplyDraft(again.json.draftId)).reply, "Hi Mick, any day this week for buyers?");
});

test("a buyer's walkthrough answer set by hand is kept, named off the deal", async () => {
  const o = await mkDeal();
  const bad = await req("POST", `/api/offers/${o.id}/deal/showing/rsvp`, { contactId: "buyer-1", status: "maybe" });
  assert.equal(bad.status, 400);
  const r = await req("POST", `/api/offers/${o.id}/deal/showing/rsvp`, { contactId: "buyer-1", status: "attended" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.showing.rsvps.map((x) => [x.name, x.status]), [["Rick R", "attended"]]);
});

test.after(() => server.close());
