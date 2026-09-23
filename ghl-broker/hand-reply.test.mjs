// hand-reply.test.mjs — a text typed on Today's work pane, with no bot draft.
// Run: node --test hand-reply.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hand-reply-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { sendHandReply } = await import("./hand-reply.js");
const { threadHealth } = await import("./shared/thread-health.js");
await store.init();
const LOC = "loc-hand-reply";
const NOW = Date.parse("2026-09-23T18:00:00Z");

function fakeGhl() {
  const sent = [];
  const untagged = [];
  return {
    sent, untagged,
    deps: {
      sendSms: async (_client, { contactId, message }) => { sent.push({ contactId, message }); return { messageId: "m-1" }; },
      removeContactTags: async (_client, contactId, tags) => { untagged.push({ contactId, tags }); },
    },
  };
}

test("a typed reply is a dry run while sends are off", async () => {
  const g = fakeGhl();
  const r = await sendHandReply({ store, locationId: LOC, contactId: "c1", text: "  Can you do 410?  ", live: false, deps: g.deps, now: NOW });
  assert.equal(r.dryRun, true);
  assert.equal(r.preview.message, "Can you do 410?");
  assert.equal(g.sent.length, 0, "nothing leaves while sends are off");
  assert.equal((await store.listContactEvents(LOC, "c1", { types: ["hand_reply"] })).length, 0, "a dry run is not a person having the thread");
});

test("a typed reply goes out and the machine stays off the thread", async () => {
  const g = fakeGhl();
  const r = await sendHandReply({ store, locationId: LOC, contactId: "c2", text: "Seller's firm at 425?", offerId: "o2", live: true, deps: g.deps, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, false);
  assert.deepEqual(g.sent, [{ contactId: "c2", message: "Seller's firm at 425?" }]);
  const events = await store.listContactEvents(LOC, "c2", { types: ["hand_reply"] });
  assert.equal(events.length, 1);
  assert.equal(events[0].offerId, "o2");
  const drafts = await store.listReplyDrafts(LOC, { contactId: "c2" });
  assert.equal(threadHealth({ drafts, events, now: NOW + 3600000 }).reason, "person_has_it");
});

test("a typed reply stands the bot's open draft aside", async () => {
  const g = fakeGhl();
  const open = await store.createReplyDraft({ locationId: LOC, contactId: "c3", contactName: "Pat Q", party: "agent", intent: "price_pushback",
    status: "draft", inbound: "Can you come up?", reply: "Let me check with my partner." });
  const other = await store.createReplyDraft({ locationId: LOC, contactId: "c3", party: "agent", intent: "other", status: "sent", inbound: "hi", reply: "hi" });
  await sendHandReply({ store, locationId: LOC, contactId: "c3", text: "Best we can do is 400.", live: true, deps: g.deps, now: NOW });
  const after = await store.getReplyDraft(open.id);
  assert.equal(after.status, "dismissed");
  assert.equal(after.answeredBy, "you");
  assert.ok(after.flags.some((f) => /answered it yourself/.test(f)));
  assert.equal((await store.getReplyDraft(other.id)).status, "sent", "a sent draft is history, left alone");
  assert.deepEqual(g.untagged, [{ contactId: "c3", tags: ["reply-draft"] }]);
});

test("no message text reaches the event or a log", async () => {
  const g = fakeGhl();
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(" "));
  try {
    await sendHandReply({ store, locationId: LOC, contactId: "c4", text: "Call me at 206-555-0100 about Elm", live: true, deps: g.deps, now: NOW });
    await assert.rejects(() => sendHandReply({ store, locationId: LOC, contactId: "c4", text: "Call me at 206-555-0100", live: true,
      deps: { ...g.deps, sendSms: async () => { throw new Error("GHL said no"); } }, now: NOW }));
  } finally { Object.assign(console, orig); }
  const events = await store.listContactEvents(LOC, "c4", { types: ["hand_reply"] });
  assert.equal(events.length, 1, "a failed send writes no event");
  assert.doesNotMatch(JSON.stringify(events), /555|Elm|Call me/);
  assert.doesNotMatch(lines.join("\n"), /555|Elm|Call me/);
});

test("an empty or overlong text, or no contact, is a 400", async () => {
  const g = fakeGhl();
  await assert.rejects(() => sendHandReply({ store, locationId: LOC, contactId: "c5", text: "   ", live: true, deps: g.deps }), (e) => e.http === 400);
  await assert.rejects(() => sendHandReply({ store, locationId: LOC, contactId: "c5", text: "x".repeat(1601), live: true, deps: g.deps }), (e) => e.http === 400);
  await assert.rejects(() => sendHandReply({ store, locationId: LOC, contactId: "", text: "hi", live: true, deps: g.deps }), (e) => e.http === 400);
  assert.equal(g.sent.length, 0);
});
