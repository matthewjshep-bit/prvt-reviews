// ghl-latest-inbound.test.mjs — reading back the text a skipped webhook never
// delivered, so a reply can be redrafted from what the agent actually wrote.

import test from "node:test";
import assert from "node:assert/strict";
import { getLatestInboundMessage } from "./ghl.js";

// A fake GHL: conversations by contact, messages by conversation.
const fake = (convos) => ({
  async call(path) {
    const u = new URL(path, "https://x");
    if (u.pathname === "/conversations/search") {
      return { conversations: convos.map((c) => ({ id: c.id, lastMessageDate: c.last })) };
    }
    const m = u.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
    if (m) return { messages: { messages: convos.find((c) => c.id === m[1])?.messages || [], nextPage: false } };
    throw new Error(`unexpected ${path}`);
  },
});

test("the newest inbound text wins, across conversations", async () => {
  const client = fake([
    { id: "sms", last: 2, messages: [
      { id: "m1", direction: "inbound", body: "Just needs minor repairs", dateAdded: "2026-09-14T18:45:00Z", messageType: "TYPE_SMS" },
      { id: "m2", direction: "outbound", body: "Around 477k", dateAdded: "2026-09-14T18:56:00Z" },
      { id: "m3", direction: "inbound", body: "No even close. Even at 60 in repairs we're well over your price.", dateAdded: "2026-09-14T19:00:00Z", messageType: "TYPE_SMS" },
    ] },
    { id: "email", last: 1, messages: [
      { id: "e1", direction: "inbound", body: "older email", dateAdded: "2026-09-13T10:00:00Z", messageType: "TYPE_EMAIL" },
    ] },
  ]);
  const r = await getLatestInboundMessage(client, "LOC", "c1");
  assert.equal(r.id, "m3");
  assert.match(r.body, /Even at 60 in repairs/);
  assert.equal(r.at, "2026-09-14T19:00:00.000Z");
  assert.equal(r.type, "TYPE_SMS");
});

test("our own messages and blank ones are never taken as theirs", async () => {
  const client = fake([{ id: "sms", last: 1, messages: [
    { id: "o1", direction: "outbound", body: "Our offer", dateAdded: "2026-09-14T19:30:00Z" },
    { id: "b1", direction: "inbound", body: "   ", dateAdded: "2026-09-14T19:20:00Z" },
    { id: "i1", direction: "inbound", body: "Closed.", dateAdded: "2026-09-14T19:03:00Z" },
  ] }]);
  assert.equal((await getLatestInboundMessage(client, "LOC", "c1")).body, "Closed.");
});

test("a contact who never wrote to us has nothing to redraft", async () => {
  const client = fake([{ id: "sms", last: 1, messages: [{ id: "o1", direction: "outbound", body: "Hi", dateAdded: "2026-09-14T19:30:00Z" }] }]);
  assert.equal(await getLatestInboundMessage(client, "LOC", "c1"), null);
  assert.equal(await getLatestInboundMessage(fake([]), "LOC", "c1"), null);
});
