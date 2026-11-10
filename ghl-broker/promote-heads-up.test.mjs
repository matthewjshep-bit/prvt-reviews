// promote-heads-up.test.mjs — what a promote is about to send, said before
// it goes, and a change of kind in the first minutes re-picks who gets it
// (2026-11-09).
//
// Matt stopped four of four promote blasts by hand, two of them on wrong
// data: nothing told him how many texts were queued, when the first went or
// at what price, and a deal set to land after promote still went to the
// flippers the house was first picked for.
//
// Sends are on in this file only so the queue schedules the way it does in
// production; every GHL call and Slack post is a stub.
//
//   node --test promote-heads-up.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "promote-heads-up-test-"));
delete process.env.DATABASE_URL;
process.env.CARD_SENDS_ENABLED = "true";
process.env.DISPO_BLASTS_ENABLED = "true";

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { default: createDispoRouter } = await import("./routes/dispo.js");
const { promoteHeadsUp } = await import("./slack-notify.js");

const LOC = "loc-promote-heads-up";
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

// Slack is a stub: every post is kept, nothing leaves the machine.
const slackPosts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith("https://slack.com/api/")) {
    slackPosts.push({ method: String(url).split("/").pop(), body: JSON.parse(opts.body || "{}") });
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ ok: true, ts: `${Date.now()}.0001` }) };
  }
  return realFetch(url, opts);
};
test.after(() => { globalThis.fetch = realFetch; server.close(); });

await store.saveOfferSettings(LOC, {
  wholesaleFee: 30000,
  conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["blast_open"] } } } },
  dispoAutopilot: { autoBlastOnPromote: true, spreadSec: 60 },
  slack: { enabled: true, streams: { dispositions: true }, channels: { dispositions: "C0DISPO01" } },
  slackBotToken: "xoxb-test-token",
});

const flipper = (contactId) => ({ contactId, name: `Flipper ${contactId}`,
  doc: { name: `Flipper ${contactId}`, phone: "+12065550142", tags: ["investor"], custom: { buybox_areas: "Kent" }, lastRepliedAt: "2026-10-01T18:00:00.000Z" }, buyboxText: "" });
const builder = (contactId) => ({ contactId, name: `Builder ${contactId}`,
  doc: { name: `Builder ${contactId}`, phone: "+12065550143", tags: ["investor", "builder"], lastRepliedAt: "2026-10-01T18:00:00.000Z" }, buyboxText: "" });
await store.upsertInvestors(LOC, [flipper("f1"), flipper("f2"), builder("b1")]);

const call = (method, p, body) => realFetch(`${B}/api/offers${p}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 25)); }
};
const dealTexts = async (offerId, status = ["draft", "scheduled"]) => (await store.listReplyDrafts(LOC, { status, limit: 200 }))
  .filter((d) => d.outbound?.kind === "blast_open" && d.outbound.offerId === offerId);
const sentOffer = (address) => store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-p", contactName: "Pat Agent", address,
  cashAmount: 410000, status: "sent", statusHistory: [], sends: [{ ts: new Date().toISOString() }] });

test("promoting a deal posts how many texts go, when and at what price", async () => {
  const o = await sentOffer("1450 Saltgrass Ave, Kent, WA 98031");
  const r = await call("POST", `/${o.id}/deal`, { contractPrice: "412,345.67" });
  assert.equal(r.status, 200, r.error);
  const queued = await until(async () => (await dealTexts(o.id)).length === 2);
  assert.ok(queued, "the promote queued the two Kent flippers");
  const line = await until(() => slackPosts.find((p) => p.method === "chat.postMessage" && /Saltgrass/.test(p.body.text)));
  assert.ok(line, "one line to #dispositions");
  assert.equal(line.body.channel, "C0DISPO01");
  const text = line.body.blocks?.[0]?.text?.text || line.body.text;
  assert.match(text, /\b2 texts start at (?:\w{3} )?\d{1,2}:\d{2}[ap]m\b/, text);
  assert.match(text, /buyers who buy in Kent/);
  assert.match(text, /at \$442,346\b/, "the buyer price the texts will say");
  assert.match(text, /contract \$412,345\.67 \+ default \$30,000 fee/, "the fee came from Settings");
  assert.match(text, /the contract price has cents/);
  assert.match(text, /kind of house not set/);
  assert.match(text, /Stop on the deal to hold them/);
  assert.doesNotMatch(text, /[–—]/, "no dashes");
  // Once per promote.
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(slackPosts.filter((p) => /Saltgrass/.test(p.body.text || "")).length, 1);
});

test("setting a deal to land in its first ten minutes takes the flippers off its queued texts", async () => {
  const o = await sentOffer("88 Brambling Way, Kent, WA 98031");
  assert.equal((await call("POST", `/${o.id}/deal`, {})).status, 200);
  const before = await until(async () => { const d = await dealTexts(o.id); return d.length === 2 ? d : null; });
  assert.ok(before, "the flippers were queued at promote");
  assert.deepEqual(before.map((d) => d.contactId).sort(), ["f1", "f2"]);
  assert.ok(before.every((d) => d.status === "scheduled"));
  const firstAt = Math.min(...before.map((d) => Date.parse(d.sendAt)));

  const r = await call("PATCH", `/${o.id}/asset`, { type: "land" });
  assert.equal(r.status, 200, r.error);
  assert.deepEqual(r.repick, { dismissed: 2, queued: 1, drafted: 0 });
  for (const d of before) {
    const now = await store.getReplyDraft(d.id);
    assert.equal(now.status, "dismissed", d.contactId);
    assert.ok(now.flags.some((f) => /kind of house changed to land/i.test(f)), now.flags.join(" | "));
  }
  const after = await dealTexts(o.id);
  assert.deepEqual(after.map((d) => d.contactId), ["b1"], "the builder takes their place");
  assert.equal(after[0].status, "scheduled");
  assert.ok(Date.parse(after[0].sendAt) >= firstAt - 1000, "on the schedule the promote set, not sooner");
  assert.equal(after[0].outbound.assetType, "land");

  // The same kind again re-picks nothing.
  const again = await call("PATCH", `/${o.id}/asset`, { type: "land" });
  assert.deepEqual(again.repick, { dismissed: 0, queued: 0, drafted: 0 });
});

test("a deal text whose kind of house changed after it was queued waits for Matt at send", async () => {
  const { sendReplyDraft } = await import("./reply-agent.js");
  const o = await store.createOffer({ id: crypto.randomUUID(), locationId: LOC, contactId: "agent-p", address: "5 Godwit Ct, Kent, WA 98031", cashAmount: 300000, status: "accepted",
    statusHistory: [], asset: { type: "land", by: "you" },
    deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date().toISOString(), contractPrice: 300000, assignmentFee: 20000 } });
  // Queued while it read as a house; the re-pick never got to it.
  const d = await store.createReplyDraft({ locationId: LOC, contactId: "f1", contactName: "Flipper f1", channel: "sms", party: "investor", status: "scheduled",
    sendAt: new Date().toISOString(), intent: "blast_open", reply: "…", inbound: "", flags: [],
    outbound: { kind: "blast_open", offerId: o.id, address: o.address, assetType: "sfr" } });
  const sent = [];
  const client = { call: async (p, opts) => { sent.push(p); return { messageId: "m1" }; } };
  const r = await sendReplyDraft({ client, store, locationId: LOC, draftId: d.id, live: true, auto: true, readThread: async () => "" });
  assert.match(String(r.skipped), /kind of house changed/);
  assert.equal(sent.filter((p) => p === "/conversations/messages").length, 0, "nothing went");
  const held = await store.getReplyDraft(d.id);
  assert.equal(held.status, "draft", "it waits for you");
});

test("the heads-up says what it can't schedule and what waits for Matt", () => {
  const text = promoteHeadsUp({
    address: "12 Plover St, Kent, WA 98031", where: "who build",
    rows: [{ channel: "sms", status: "draft", draftId: "a" }, { channel: "sms", status: "draft", draftId: "b" }, { channel: "email", status: "draft", draftId: "c" }],
    scheduled: false, reason: "sends are off on the broker (CARD_SENDS_ENABLED)",
    price: 512000, contractPrice: 490000, assignmentFee: 22000, feeSource: "you", kindSet: true,
  });
  assert.match(text, /2 texts and 1 email wait in the outbox as drafts/);
  assert.match(text, /sends are off on the broker/);
  assert.match(text, /contract \$490,000 \+ \$22,000 fee/);
  assert.doesNotMatch(text, /default|cents|kind of house/);
  assert.doesNotMatch(text, /[–—]/);
});
