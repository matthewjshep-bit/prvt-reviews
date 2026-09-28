// hot-house.test.mjs — what a conversation says about one house lands on that
// house, or nowhere.
//
// 34418 54th Ave S and 28605 51st Pl S, Auburn (2026-09-23). The agent had
// both. The seller on 54th countered 530K; the bot marked 54th passed. Two
// minutes later "I'll inform them that your price is firm…" — about 54th —
// read as warm, and with 54th closed the heat went to the agent's only OPEN
// offer: 51st Pl, a house the seller had turned down a week before. The hot
// push then asked him to draft "51st Pl … at the 400k" (54th's number).
// Driven through the real router's conversation deps against the JSON store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hot-house-test-"));
process.env.CARD_SENDS_ENABLED = "false";

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-hot-house";
const client = { call: async () => ({}) };
const router = createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR, publicBaseUrl: "http://127.0.0.1:1" });
await store.init();
const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const mkOffer = (over = {}) => store.createOffer({
  id: crypto.randomUUID(), locationId: LOC, contactName: "Agent",
  calc: { settings: {}, inputs: {}, offers: {} }, statusHistory: [], ...over,
});
const twoHouses = async (contactId) => {
  const fiftyFourth = await mkOffer({
    contactId, address: "34418 54th Ave S", cashAmount: 400000, createdAt: ago(7),
    status: "passed", statusHistory: [{ status: "sent", ts: ago(7) }, { status: "passed", ts: ago(0.01) }],
    sends: [{ ts: ago(7), channels: ["sms"] }],
  });
  const fiftyFirst = await mkOffer({
    contactId, address: "28605 51st Pl S, Auburn, WA 98001", cashAmount: 501750, createdAt: ago(8),
    status: "new", proactive: { realmCheckAt: ago(8) },
  });
  return { fiftyFourth, fiftyFirst };
};

test("a warm word about a house we've closed never makes the agent's other house hot", async () => {
  const { fiftyFourth, fiftyFirst } = await twoHouses("agent-heat");
  const r = await deps.raiseOfferHeat({ contactId: "agent-heat", addressHint: "34418 54th Ave S", signal: "warm", note: "agent says the number might work" });
  assert.notEqual(r.raised, true, "nothing is raised");
  assert.equal((await store.getOffer(fiftyFirst.id)).hot, undefined, "51st Pl is untouched");
  assert.equal((await store.getOffer(fiftyFourth.id)).hot, undefined);
});

test("a status about a house we've closed never lands on the agent's other house", async () => {
  const { fiftyFirst } = await twoHouses("agent-status");
  const r = await deps.setOfferStatus({ contactId: "agent-status", addressHint: "34418 54th Ave S", status: "no_response" });
  assert.equal(r.ok, false);
  assert.equal((await store.getOffer(fiftyFirst.id)).status, "new");
});

test("with no house named, the agent's only open offer is still the one", async () => {
  const { fiftyFirst } = await twoHouses("agent-unnamed");
  const r = await deps.setOfferStatus({ contactId: "agent-unnamed", addressHint: "", status: "passed", note: "seller won't" });
  assert.equal(r.ok, true);
  assert.equal((await store.getOffer(fiftyFirst.id)).status, "passed");
});

test("the seller countering or passing cools the heat the conversation raised — a hot flag you set stays", async () => {
  const auto = await mkOffer({
    contactId: "agent-cool", address: "1 Oak St, Kent, WA", cashAmount: 400000, createdAt: ago(3), status: "sent",
    sends: [{ ts: ago(3), channels: ["sms"] }], hot: { at: ago(1), by: "conversation", signal: "writing_up", note: "agent is writing it up" },
  });
  const r = await deps.setOfferStatus({ contactId: "agent-cool", addressHint: "1 Oak St", status: "countered", amount: 530000, note: "seller proposal 530k" });
  assert.equal(r.ok, true);
  const after = await store.getOffer(auto.id);
  assert.equal(after.status, "countered");
  assert.equal(after.hot, undefined, "a counter means the price isn't settled");

  const mine = await mkOffer({
    contactId: "agent-mine", address: "2 Elm St, Kent, WA", cashAmount: 300000, createdAt: ago(3), status: "sent",
    sends: [{ ts: ago(3), channels: ["sms"] }], hot: { at: ago(1), by: "operator", note: "Matt's call" },
  });
  await deps.setOfferStatus({ contactId: "agent-mine", addressHint: "2 Elm St", status: "countered", amount: 320000 });
  assert.equal((await store.getOffer(mine.id)).hot?.by, "operator");
});
