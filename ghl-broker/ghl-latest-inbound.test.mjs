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
