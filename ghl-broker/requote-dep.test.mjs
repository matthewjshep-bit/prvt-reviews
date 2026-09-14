// requote-dep.test.mjs — the broker's re-quote actually reads the agent's take.
//
// Until 2026-09-14 routes/offers.js called propertyDossier without importing
// it. The ReferenceError was swallowed by the try around the event read, the
// take came back empty, and every re-quote in production answered "nothing new
// from them to re-quote on" — Thomas Rinow's "Even at 60 in repairs" included.
// Driven through the real router against the JSON store, so a missing import
// fails here instead of silently in production.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "requote-dep-test-"));
process.env.CARD_SENDS_ENABLED = "false";

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");

const LOC = "loc-requote-dep";
const client = { call: async () => ({}) };
const router = createOffersRouter({ resolveLocation: () => ({ locationId: LOC, client }), uploadDir: process.env.DATA_DIR, publicBaseUrl: "http://127.0.0.1:4995" });
await store.init();
await store.saveOfferSettings(LOC, { conversationAi: { enabled: true, parties: { agent: { requote: { enabled: true, maxPerOffer: 1, maxArvLiftPct: 10, maxRepairCutPct: 25 } } } } });

const ADDRESS = "10412 Se 219th St, Kent, WA 98031";

test("the re-quote reads the agent's saved take — it never answers 'nothing new' when a take exists", async () => {
  const contactId = "agent-thomas";
  const offer = await store.createOffer({
    id: crypto.randomUUID(), locationId: LOC, contactId, contactName: "Thomas", address: ADDRESS,
    arv: 785000, repairs: 81500, cashAmount: 477250, status: "new", statusHistory: [],
    calc: { settings: { underwriteMode: "mao", maoPctOfArv: 75, wholesaleFee: 30000 }, inputs: { arv: 785000, repairs: 81500 } },
  });
  // The store stamps createdAt itself, so the timeline is built from what it
  // saved: their take a minute after we priced, then a status change after that.
  const created = await store.getOffer(offer.id);
  const pricedMs = Date.parse(created.createdAt);
  const takeAt = new Date(pricedMs + 60_000).toISOString();
  await store.updateOffer(offer.id, { ...created, status: "new", statusAt: new Date(pricedMs + 5 * 60_000).toISOString() });
  await store.appendContactEvents(LOC, contactId, [{
    party: "agent", type: "agent_estimate", at: takeAt, address: ADDRESS,
    source: "conversation", ref: "d1", dedupeKey: `agent_estimate:${ADDRESS}:2026-09-14`,
    data: { arv: 0, rehab: 60000, note: "Even at 60 in repairs" },
  }]);

  const deps = router.conversationDepsFor({ locationId: LOC, client, saved: await store.getOfferSettings(LOC) });
  const r = await deps.requoteFromAgentNumbers({ contactId, addressHint: ADDRESS }).catch((e) => ({ ok: false, reason: `threw: ${e.message}` }));
  assert.doesNotMatch(String(r.reason || ""), /nothing new from them/, `the take was not read: ${r.reason}`);
  assert.doesNotMatch(String(r.reason || ""), /predates our underwrite/, `a later status change made the take look stale: ${r.reason}`);
  // Reaching the re-issue is the proof the take was read and the plan passed
  // (capped at the ceiling here). The test broker has no card service, so the
  // re-issue itself stops at the document render — that's past what's tested.
  assert.ok(r.ok || /above what we'd pay|CARD_SERVICE_URL|card service/.test(String(r.reason)), `unexpected: ${JSON.stringify(r)}`);
  if (r.ok) assert.equal(offer.id && typeof r.to, "number");
});
