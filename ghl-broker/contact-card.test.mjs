import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { sendReplyDraft, saveConversationConfig } from "./reply-agent.js";
import { createContactCardPublicRouter } from "./contact-card.js";

const VCARD = "BEGIN:VCARD\nVERSION:3.0\nFN:Pat Example\nTEL:+15550000000\nEND:VCARD";
const TOKEN = "0123456789abcdef0123456789abcdef";
const BASE = "https://offers.example.test";
const ON = { conversationAi: { contactCard: { enabled: true, vcard: VCARD, token: TOKEN, fileName: "Pat Example" } } };

function fakeStore({ drafts = [], saved = ON } = {}) {
  const rows = new Map(drafts.map((d) => [d.id, d]));
  const events = [];
  let settings = saved;
  return {
    events,
    get settings() { return settings; },
    getOfferSettings: async () => settings,
    saveOfferSettings: async (_loc, s) => { settings = s; },
    getReplyDraft: async (id) => rows.get(id) || null,
    updateReplyDraft: async (id, doc) => { rows.set(id, doc); return true; },
    listReplyDrafts: async () => [],
    getContactProfile: async () => null,
    upsertContactProfile: async (_l, _c, p) => p,
    appendContactEvents: async (_l, contactId, evs) => {
      let inserted = 0;
      for (const e of evs) { if (events.some((x) => x.dedupeKey === e.dedupeKey)) continue; events.push({ ...e, contactId }); inserted++; }
      return { inserted };
    },
    listContactEvents: async (_l, contactId, { types = null } = {}) => events.filter((e) => e.contactId === contactId && (!types || types.includes(e.type))),
  };
}

const draft = (over = {}) => ({
  id: "d1", locationId: "LOC", contactId: "c1", status: "draft", channel: "sms", party: "agent",
  intent: "question", inbound: "", reply: "Understood, thanks for running it by the seller.", createdAt: new Date().toISOString(), ...over,
});

const smsCalls = (calls) => calls.filter(([p, o]) => p === "/conversations/messages" && o.body.type === "SMS");

test("an agent who passes on our number gets Matt's contact card in its own text, and only the first time", async () => {
  const store = fakeStore({ drafts: [draft({ intent: "rejection", inbound: "Seller won't go that low" }), draft({ id: "d2", intent: "rejection" })] });
  const calls = [];
  const client = { call: async (path, opts) => { calls.push([path, opts]); return { messageId: `m${calls.length}` }; } };

  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, cardBaseUrl: BASE });
  const sms = smsCalls(calls);
  assert.equal(sms.length, 2, "the reply, then the card");
  assert.equal(sms[0][1].body.message, "Understood, thanks for running it by the seller.");
  assert.equal(sms[0][1].body.attachments, undefined, "the reply itself carries nothing");
  assert.match(sms[1][1].body.message, /Save it and I'll be in touch/);
  assert.deepEqual(sms[1][1].body.attachments, [`${BASE}/card/${TOKEN}`]);
  assert.equal(r.contactCard, "they passed");
  assert.equal(store.events.filter((e) => e.type === "contact_card_sent").length, 1);
  assert.equal(store.events[0].data.why, "they passed");

  calls.length = 0;
  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d2", live: true, cardBaseUrl: BASE });
  assert.equal(smsCalls(calls).length, 1, "the second pass gets the reply and no second card");
});

test("someone who asks who we are gets the card after the answer", async () => {
  const store = fakeStore({ drafts: [draft({ party: "investor", inbound: "who is this?", reply: "Matt with Shep Flips." })] });
  const calls = [];
  const client = { call: async (path, opts) => { calls.push([path, opts]); return {}; } };
  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, cardBaseUrl: BASE });
  const sms = smsCalls(calls);
  assert.equal(sms.length, 2);
  assert.equal(sms[1][1].body.message, "Here's my contact card so you have it.");
});

test("with the card switched off, a no gets the reply and nothing else", async () => {
  const off = { conversationAi: { contactCard: { ...ON.conversationAi.contactCard, enabled: false } } };
  const store = fakeStore({ drafts: [draft({ intent: "rejection" })], saved: off });
  const calls = [];
  const client = { call: async (path, opts) => { calls.push([path, opts]); return {}; } };
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, cardBaseUrl: BASE });
  assert.equal(smsCalls(calls).length, 1);
  assert.equal(r.contactCard, undefined);
  assert.equal(store.events.filter((e) => e.type === "contact_card_sent").length, 0);
});

test("a card that fails to send doesn't fail the reply that already went", async () => {
  const store = fakeStore({ drafts: [draft({ intent: "rejection" })] });
  let n = 0;
  const client = { call: async (path, opts) => {
    if (path === "/conversations/messages" && opts.body.attachments) throw new Error("media rejected");
    n++; return {};
  } };
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, cardBaseUrl: BASE });
  assert.equal(r.ok, true);
  assert.equal((await store.getReplyDraft("d1")).status, "sent");
  assert.ok(n >= 1);
  assert.equal(store.events.filter((e) => e.type === "contact_card_sent").length, 0, "no record of a card that didn't go");
});

test("saving a card mints its link once, keeps it, and a page that doesn't know about the card doesn't wipe it", async () => {
  const store = fakeStore({ saved: {} });
  const first = await saveConversationConfig(store, "LOC", { contactCard: { vcard: VCARD } });
  assert.match(first.contactCard.token, /^[a-f0-9]{32}$/);
  assert.equal(first.contactCard.enabled, false, "saving a card doesn't switch it on");
  const again = await saveConversationConfig(store, "LOC", { contactCard: { vcard: VCARD, enabled: true } });
  assert.equal(again.contactCard.token, first.contactCard.token);
  const older = await saveConversationConfig(store, "LOC", { dailyCap: 10 });
  assert.equal(older.contactCard.vcard, VCARD);
  assert.equal(older.contactCard.token, first.contactCard.token);
  assert.equal(older.contactCard.enabled, true);
});

test("the card's link serves a vCard the phone can save, under its own name, and nothing for a wrong token", async () => {
  const store = fakeStore();
  const app = express();
  app.use("/card", createContactCardPublicRouter({ store, locations: () => ["LOC"] }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/card/${TOKEN}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /^text\/vcard/);
    assert.equal(r.headers.get("content-disposition"), 'attachment; filename="Pat Example.vcf"');
    const body = await r.text();
    assert.ok(body.startsWith("BEGIN:VCARD\r\n") && body.endsWith("END:VCARD\r\n"), "CRLF line endings, as the spec wants");
    assert.equal((await fetch(`${base}/card/${TOKEN}.vcf`)).status, 200);
    assert.equal((await fetch(`${base}/card/${"f".repeat(32)}`)).status, 404);
    assert.equal((await fetch(`${base}/card/nope`)).status, 404);
  } finally { server.close(); }
});
