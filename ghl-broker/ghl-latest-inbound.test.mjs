// ghl-latest-inbound.test.mjs — reading back the text a skipped webhook never
// delivered, so a reply can be redrafted from what the agent actually wrote.

import test from "node:test";
import assert from "node:assert/strict";
import { getLatestInboundMessage, getUnansweredInbound } from "./ghl.js";

// A fake GHL: conversations by contact, messages by conversation, and the
// emails inside an email thread by id.
const fake = (convos, emails = {}) => ({
  async call(path) {
    const u = new URL(path, "https://x");
    const e = u.pathname.match(/^\/conversations\/messages\/email\/([^/]+)$/);
    if (e) return { emailMessage: emails[e[1]] };
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

// The 10/19 agent email (2026-10-21): GHL files the thread as ONE inbound
// message whose body is the first email in it, ours. Chris B. wrote back
// "remove" and Glen W. "927 Jersey is still available.", and the daytime pass
// answered our own email, to matt@shepflips.com, two days later.
const OURS = { id: "ours", direction: "outbound", from: "Matt Shepherd <matt@shepflips.com>", body: "<p>Hi Chris,</p><p>Matt Shepherd here. I fix up houses around Puget Sound.</p>", dateAdded: "2026-10-21T19:16:18Z" };
const threadOf = (reply) => [{ id: "t1", direction: "inbound", messageType: "TYPE_EMAIL", body: OURS.body, dateAdded: "2026-10-21T19:33:46Z", meta: { email: { messageIds: ["ours", "theirs"] } } }];
const theirs = (body) => ({ id: "theirs", direction: "inbound", from: "chris@compass.com", body, dateAdded: "2026-10-21T19:33:40Z" });

test("an email reply is read from their email in the thread, not from ours at the top of it", async () => {
  const client = fake([{ id: "em", last: 1, messages: threadOf() }],
    { ours: OURS, theirs: theirs("<div>remove</div><div>On Wed, Oct 21, 2026 at 12:16 PM Matt Shepherd &lt;matt@shepflips.com&gt; wrote:</div><blockquote>Hi Chris, Matt Shepherd here.</blockquote>") });
  const r = await getLatestInboundMessage(client, "LOC", "c1");
  assert.equal(r.body, "remove");
  assert.equal(r.type, "TYPE_EMAIL");
  const glen = fake([{ id: "em", last: 1, messages: threadOf() }],
    { ours: OURS, theirs: theirs("927 Jersey is still available.\n\nOn Wed, Oct 21, 2026 at 11:08 AM Matt Shepherd <matt@shepflips.com> wrote:\n> Hi Glen,") });
  assert.deepEqual(await getUnansweredInbound(glen, "LOC", "c1"), ["927 Jersey is still available."]);
});

test("an email thread with only our own email in it is not a message from them", async () => {
  const client = fake([{ id: "em", last: 1, messages: [{ ...threadOf()[0], meta: { email: { messageIds: ["ours"] } } }] }], { ours: OURS });
  assert.equal(await getLatestInboundMessage(client, "LOC", "c1"), null);
  assert.deepEqual(await getUnansweredInbound(client, "LOC", "c1"), []);
});

// 2026-11-09 audit: our answer to someone asking who we were was blocked by the
// carrier. A send GHL marked failed or undelivered never reached them, so the
// texts under it are still theirs to answer (the audit's redraft reads these;
// shared/conversation-audit.test.mjs has the audit's side).
test("the question under a blocked answer is still read as unanswered", async () => {
  const client = fake([{ id: "sms", last: 1, messages: [
    { id: "o1", direction: "outbound", body: "Matt here, I fix up houses locally.", status: "undelivered", messageType: "TYPE_SMS", dateAdded: "2026-11-09T21:55:00Z" },
    { id: "i2", direction: "inbound", body: "Sorry, do I know you?", messageType: "TYPE_SMS", dateAdded: "2026-11-09T21:52:00Z" },
    { id: "o0", direction: "outbound", body: "Is your place on Birch Rd a bit of a project?", status: "delivered", messageType: "TYPE_SMS", dateAdded: "2026-11-09T18:00:00Z" },
  ] }]);
  assert.deepEqual(await getUnansweredInbound(client, "LOC", "c1"), ["Sorry, do I know you?"]);
  // One that arrived is an answer, as before.
  const answered = fake([{ id: "sms", last: 1, messages: [
    { id: "o1", direction: "outbound", body: "Matt here, I fix up houses locally.", status: "delivered", messageType: "TYPE_SMS", dateAdded: "2026-11-09T21:55:00Z" },
    { id: "i2", direction: "inbound", body: "Sorry, do I know you?", messageType: "TYPE_SMS", dateAdded: "2026-11-09T21:52:00Z" },
  ] }]);
  assert.deepEqual(await getUnansweredInbound(answered, "LOC", "c1"), []);
});

// The delivery check's one read per send (delivery-watch.js).
test("a message's delivery is read back with its carrier code, whatever shape GHL answers in", async () => {
  const { getMessage } = await import("./ghl.js");
  const seen = [];
  const client = { call: async (p, opts) => { seen.push([p, opts?.version]); return { message: { id: "m9", status: "undelivered", error: "Error 30007", body: "x" } }; } };
  assert.deepEqual(await getMessage(client, "m9"), { id: "m9", status: "undelivered", code: "30007", type: "" });
  assert.deepEqual(seen, [["/conversations/messages/m9", "2021-04-15"]]);
  const flat = { call: async () => ({ id: "m8", status: "delivered", messageType: "TYPE_SMS" }) };
  assert.deepEqual(await getMessage(flat, "m8"), { id: "m8", status: "delivered", code: null, type: "TYPE_SMS" });
});
