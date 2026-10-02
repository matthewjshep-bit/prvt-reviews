// paper-after-float.test.mjs — the written offer follows a float nobody
// answered (2026-10-02). Driven through the real router's runner against the
// JSON store, with a fake GHL that records what would have gone out.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paper-after-float-test-"));
process.env.CARD_SENDS_ENABLED = "true";

const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { recordEvent } = await import("./contact-record.js");
const { machineDid } = await import("./shared/flow.js");

const LOC = "loc-paper-float";
const sent = [];
const client = {
  call: async (p, o = {}) => {
    const method = o.method || "GET";
    if (method === "GET" && /^\/contacts\/[^/?]+$/.test(p)) return { contact: { id: p.split("/").pop(), firstName: "Dana", phone: "+12065550100", email: "dana@example.com" } };
    if (method === "POST" && p.startsWith("/conversations/messages")) {
      sent.push(typeof o.body === "string" ? JSON.parse(o.body || "{}") : o.body || {});
      return { messageId: `m${sent.length}` };
    }
    return {};
  },
};
const router = createOffersRouter({
  resolveLocation: () => ({ locationId: LOC, client }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:4996",
});
await store.init();
await store.saveOfferSettings(LOC, {
  conversationAi: { enabled: true, parties: { agent: { sendOffer: { afterFloat: { enabled: true } } } } },
});

// Friday 2026-10-02 2pm Pacific the number went out; Tuesday 11am it's quiet.
const FLOAT_AT = "2026-10-02T21:00:00.000Z";
const TUESDAY = Date.parse("2026-10-06T18:00:00Z");
async function floated(contactId, extra = {}) {
  const offer = await store.createOffer({
    id: crypto.randomUUID(), locationId: LOC, contactId, contactName: "Dana Agent",
    address: `${Math.floor(Math.random() * 9000) + 1000} Main St, Tacoma, WA 98402`, cashAmount: 300000,
    imageUrl: "https://example.com/offer.png", pdfUrl: "https://example.com/offer.pdf",
    calc: { settings: {}, inputs: {}, offers: {} }, createdAt: "2026-10-02T20:00:00.000Z", status: "new", statusHistory: [],
    autoUnderwrite: { passed: true }, proactive: { realmCheckAt: "2026-10-02T20:59:00.000Z" }, ...extra,
  });
  await store.createReplyDraft({
    locationId: LOC, contactId, status: "sent", sentAt: FLOAT_AT, channel: "sms", inbound: "",
    outbound: { kind: "realm_check", offerId: offer.id, address: offer.address, amount: offer.cashAmount }, reply: "Based on our analysis we can likely do around 300ish", createdAt: "2026-10-02T20:59:00.000Z",
  });
  return offer;
}

test("a floated number nobody answered gets the written offer, for their records", async () => {
  const offer = await floated("agent-quiet");
  const r = await router.sendPaperAfterSilence({ client, locationId: LOC, now: TUESDAY });
  assert.equal(r.sent, 1);
  const sms = sent.find((m) => m.contactId === "agent-quiet" && m.type === "SMS");
  assert.ok(sms, "a text went");
  assert.match(sms.message, /sending our written offer on .* over so you have it on file/);
  // What the carriers block stays out of the text (2026-10-02): no "cash", no
  // "as-is", and the page link rides in the email that's going too.
  assert.doesNotMatch(sms.message, /\bcash\b|as-is|https?:/i, sms.message);
  assert.match(sms.message, /comps and numbers are in your email/);
  const mail = sent.find((m) => m.contactId === "agent-quiet" && m.type === "Email");
  assert.match(String(mail?.html || ""), /\/o\//, "the page link is in the email");
  const after = await store.getOffer(offer.id);
  assert.equal(after.paperAfterFloat.status, "sent");
  assert.ok((after.sends || []).length, "the ledger has the send");
});

test("the silence send counts as the machine's on Flow", async () => {
  const events = await store.listContactEvents(LOC, "agent-quiet", { limit: 50 });
  const ev = events.find((e) => e.type === "offer_sent");
  assert.equal(ev.data.by, "after_float");
  assert.equal(ev.data.forRecord, true);
  assert.equal(machineDid(ev), true);
});

test("it goes once", async () => {
  const before = sent.length;
  const r = await router.sendPaperAfterSilence({ client, locationId: LOC, now: TUESDAY + 3600000 });
  assert.equal(r.sent, 0);
  assert.equal(sent.length, before);
});

test("an agent who answered after the float is left to the reply path", async () => {
  const offer = await floated("agent-answered");
  await recordEvent({ store, locationId: LOC, contactId: "agent-answered", type: "text_summary", at: "2026-10-05T17:00:00.000Z", source: "ghl", data: { inbound: "seller wants list" } });
  const r = await router.sendPaperAfterSilence({ client, locationId: LOC, now: TUESDAY });
  assert.equal(r.sent, 0);
  assert.equal((await store.getOffer(offer.id)).paperAfterFloat, undefined, "nothing claimed");
});

test("a stopped or unsubscribed agent gets no paper", async () => {
  const stopped = await floated("agent-stopped");
  await recordEvent({ store, locationId: LOC, contactId: "agent-stopped", type: "drive_stopped", at: "2026-10-03T17:00:00.000Z", source: "operator", data: { reason: "" } });
  const unsub = await floated("agent-unsub");
  await recordEvent({ store, locationId: LOC, contactId: "agent-unsub", type: "unsubscribed", at: "2026-10-03T17:00:00.000Z", source: "ghl", data: {} });
  const before = sent.length;
  await router.sendPaperAfterSilence({ client, locationId: LOC, now: TUESDAY });
  assert.equal(sent.filter((m) => ["agent-stopped", "agent-unsub"].includes(m.contactId)).length, 0);
  assert.equal((await store.getOffer(stopped.id)).paperAfterFloat, undefined);
  assert.equal((await store.getOffer(unsub.id)).paperAfterFloat, undefined);
  assert.ok(sent.length >= before);
});

test("nothing goes at night, or with the switch off", async () => {
  await floated("agent-night");
  const night = Date.parse("2026-10-07T06:00:00Z");   // 11pm Pacific
  assert.equal((await router.sendPaperAfterSilence({ client, locationId: LOC, now: night })).sent, 0);
  const saved = await store.getOfferSettings(LOC);
  await store.saveOfferSettings(LOC, { ...saved, conversationAi: { enabled: true, parties: { agent: { sendOffer: { afterFloat: { enabled: false } } } } } });
  assert.equal((await router.sendPaperAfterSilence({ client, locationId: LOC, now: TUESDAY })).sent, 0);
  await store.saveOfferSettings(LOC, saved);
});

test("the day's number caps it", async () => {
  const saved = await store.getOfferSettings(LOC);
  await store.saveOfferSettings(LOC, { ...saved, conversationAi: { enabled: true, parties: { agent: { sendOffer: { afterFloat: { enabled: true, dailyCap: 1 } } } } } });
  await floated("agent-cap-1");
  await floated("agent-cap-2");
  const wed = Date.parse("2026-10-07T18:00:00Z");
  const r = await router.sendPaperAfterSilence({ client, locationId: LOC, now: wed });
  assert.equal(r.sent, 1);
  const r2 = await router.sendPaperAfterSilence({ client, locationId: LOC, now: wed + 60000 });
  assert.equal(r2.sent, 0, "one a day");
  await store.saveOfferSettings(LOC, saved);
});
