// investor-thread.test.mjs — an investor's whole thread, read out of GHL.
//
// What went wrong (2026-10-29): a scan of every investor's texts and calls ran
// 4-way with no retry; 1,524 of 2,058 threads threw 429 and the scan still
// looked finished. And the prompt-sized transcript (enrich.js) stops at five
// conversations and cuts a call at 4,000 characters, so a quote can't be
// checked against it. This read takes every page, every call transcript,
// retries what GHL throttles, and says when a thread came back short.
//
//   node --test investor-thread.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readInvestorThread, withRetry, transcriptTurns, channelOf } from "./investor-thread.js";

const noWait = { retry: { baseMs: 0, wait: async () => {} } };

function fakeGhl({ pages, transcripts = {}, throttleFirst = 0 }) {
  let throttled = 0;
  const calls = { list: 0 };
  return {
    calls,
    deps: {
      ...noWait,
      searchConversations: async () => ({ conversations: Object.keys(pages).map((id) => ({ id })) }),
      listConversationMessages: async (_c, convoId, { lastMessageId }) => {
        calls.list++;
        if (throttled < throttleFirst) { throttled++; throw Object.assign(new Error("GHL 429"), { status: 429 }); }
        const list = pages[convoId];
        const i = lastMessageId ? list.findIndex((p) => p.after === lastMessageId) : 0;
        const page = list[i];
        return { messages: page.messages, nextPage: i < list.length - 1, lastMessageId: page.messages[page.messages.length - 1]?.id };
      },
      getMessageTranscription: async (_c, _l, id) => {
        const t = transcripts[id];
        if (t instanceof Error) throw t;
        if (!t) throw Object.assign(new Error("404"), { status: 404 });
        return t;
      },
      messageWords: async (_c, m) => `their reply to ${m.id}`,
    },
  };
}

const msg = (id, at, direction, messageType, body = "", extra = {}) => ({ id, dateAdded: at, direction, messageType, body, ...extra });

test("every page of every conversation is read, oldest first, and system rows are left out", async () => {
  const g = fakeGhl({ pages: {
    c1: [
      { messages: [msg("m3", "2026-08-03T00:00:00Z", "inbound", "TYPE_SMS", "Tacoma only"), msg("m2", "2026-08-02T00:00:00Z", "outbound", "TYPE_ACTIVITY_OPPORTUNITY", "Opportunity created")] },
      { after: "m2", messages: [msg("m1", "2026-08-01T00:00:00Z", "outbound", "TYPE_SMS", "What do you buy?")] },
    ],
    c2: [{ messages: [msg("m9", "2026-09-01T00:00:00Z", "inbound", "TYPE_SMS", "Still buying")] }],
  } });
  const t = await readInvestorThread(null, "LOC", "inv1", { deps: g.deps });
  assert.deepEqual(t.messages.map((m) => m.id), ["m1", "m3", "m9"]);
  assert.deepEqual(t.messages.map((m) => m.dir), ["us", "them", "them"]);
  assert.equal(t.stats.conversations, 2);
  assert.equal(t.stats.failures, 0);
});

test("a throttled page is retried, not skipped", async () => {
  const g = fakeGhl({ throttleFirst: 3, pages: { c1: [{ messages: [msg("m1", "2026-08-01T00:00:00Z", "inbound", "TYPE_SMS", "Cash buyer")] }] } });
  const t = await readInvestorThread(null, "LOC", "inv1", { deps: g.deps });
  assert.equal(t.messages.length, 1);
  assert.equal(g.calls.list, 4);
  assert.equal(t.stats.failures, 0);
});

test("a page that never comes back is counted as a failure, not read as an empty thread", async () => {
  const g = fakeGhl({ throttleFirst: 99, pages: { c1: [{ messages: [] }] } });
  const t = await readInvestorThread(null, "LOC", "inv1", { deps: g.deps });
  assert.equal(t.stats.failures, 1);
  assert.equal(t.stats.failedWith["page:429"], 1);
});

test("a call carries its transcript; a call GHL can't transcribe is still a call, not a failure", async () => {
  const g = fakeGhl({
    pages: { c1: [{ messages: [
      msg("k1", "2026-08-01T00:00:00Z", "outbound", "TYPE_CALL", "", { meta: { call: { duration: 300, status: "completed" } } }),
      msg("k2", "2026-08-02T00:00:00Z", "outbound", "TYPE_CALL", "", { meta: { call: { duration: 5 } } }),
    ] }] },
    transcripts: {
      k1: [{ sentenceIndex: 1, mediaChannel: 2, transcript: "Mostly flips." }, { sentenceIndex: 0, mediaChannel: 1, transcript: "What do you buy?" }, { sentenceIndex: 2, mediaChannel: 2, transcript: "Up to 500." }],
      k2: Object.assign(new Error("GHL 400"), { status: 400 }),
    },
  });
  const t = await readInvestorThread(null, "LOC", "inv1", { deps: g.deps });
  assert.deepEqual(t.messages[0].turns, [{ speaker: "1", text: "What do you buy?" }, { speaker: "2", text: "Mostly flips. Up to 500." }]);
  assert.equal(t.messages[0].secs, 300);
  assert.equal(t.messages[1].turns, undefined);
  assert.equal(t.stats.callsTranscribed, 1);
  assert.equal(t.stats.failures, 0);
});

test("their email is their own words out of the thread; ours is cut to a paragraph", async () => {
  const g = fakeGhl({ pages: { c1: [{ messages: [
    msg("e1", "2026-08-01T00:00:00Z", "outbound", "TYPE_EMAIL", `<p>${"Our long pitch. ".repeat(200)}</p>`),
    msg("e2", "2026-08-02T00:00:00Z", "inbound", "TYPE_EMAIL", "<p>Our long pitch quoted back</p>"),
  ] }] } });
  const t = await readInvestorThread(null, "LOC", "inv1", { deps: g.deps });
  assert.ok(t.messages[0].body.length <= 1200);
  assert.equal(t.messages[1].body, "their reply to e2");
  assert.equal(t.stats.theirs, 1);
});

test("retry gives up at once on a request GHL refuses for good", async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw Object.assign(new Error("bad"), { status: 400 }); }, { baseMs: 0, wait: async () => {} }));
  assert.equal(n, 1);
});

test("speaker turns merge consecutive sentences and keep the order GHL numbered them", () => {
  assert.deepEqual(transcriptTurns([{ sentenceIndex: 2, mediaChannel: 1, transcript: "c" }, { sentenceIndex: 0, mediaChannel: 1, transcript: "a" }, { sentenceIndex: 1, mediaChannel: 1, transcript: "b" }]), [{ speaker: "1", text: "a b c" }]);
  assert.equal(channelOf({ messageType: "TYPE_VOICEMAIL" }), "voicemail");
  assert.equal(channelOf({ messageType: "TYPE_ACTIVITY_CONTACT" }), null);
});
