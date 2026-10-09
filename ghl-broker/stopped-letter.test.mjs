// stopped-letter.test.mjs — an offer letter never sends itself to someone
// you stopped the bot on (shared/bot-hold.js). Driven through the real
// router's conversation deps against the JSON store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stopped-letter-test-"));
process.env.CARD_SENDS_ENABLED = "false";

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { recordEvent } = await import("./contact-record.js");

const LOC = "loc-stopped-letter";
const ghl = [];
const client = { call: async (p, o = {}) => { ghl.push([o.method || "GET", p]); return {}; } };
const router = createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:4996",
});
await store.init();
const deps = router.conversationDepsFor({ locationId: LOC, client, saved: {} });

test("a clean underwrite for someone you stopped doesn't send the letter by itself", async () => {
  await store.createOffer({
    id: crypto.randomUUID(), locationId: LOC, contactId: "agent-s", contactName: "Agent",
    address: "1 Main St, Seattle, WA 98101", cashAmount: 300000, calc: { settings: {}, inputs: {}, offers: {} },
    createdAt: new Date().toISOString(), status: "new", statusHistory: [],
  });
  await recordEvent({ store, locationId: LOC, contactId: "agent-s", type: "drive_stopped", at: new Date(Date.now() - 60000).toISOString(), source: "operator", data: { reason: "" } });
  const r = await deps.sendOfferDocs({ contactId: "agent-s", addressHint: "1 Main St", transcript: "", unattended: true });
  assert.equal(r.ok, false);
  assert.equal(r.held, true);
  assert.equal(r.reason, "you stopped the bot on them");
  assert.equal(ghl.some(([, p]) => p.startsWith("/conversations/messages")), false, "nothing went to GHL");
});

test("a person pressing the letter on the draft is deciding — the stop doesn't refuse it", async () => {
  const r = await deps.sendOfferDocs({ contactId: "agent-s", addressHint: "1 Main St", transcript: "" });
  assert.notEqual(r.reason, "you stopped the bot on them");
});

test("no letter goes by itself on a house the agent said is not a project", async () => {
  await store.createOffer({
    id: crypto.randomUUID(), locationId: LOC, contactId: "agent-t", contactName: "Agent",
    address: "2027 SE Walker Park Rd, Shelton, WA 98584", cashAmount: 810000, calc: { settings: {}, inputs: {}, offers: {} },
    createdAt: new Date().toISOString(), status: "new", statusHistory: [],
  });
  await recordEvent({ store, locationId: LOC, contactId: "agent-t", type: "property_details", address: "2027 SE Walker Park Rd, Shelton, WA 98584",
    at: new Date(Date.now() - 3600000).toISOString(), source: "conversation", data: { condition: "great home, waterfront with a dock", workNeeded: "none, not a project" } });
  const r = await deps.sendOfferDocs({ contactId: "agent-t", addressHint: "2027 SE Walker Park", transcript: "", unattended: true });
  assert.equal(r.ok, false);
  assert.equal(r.held, true);
  assert.match(r.reason, /isn't a project/);
});
