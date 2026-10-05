import test from "node:test";
import assert from "node:assert/strict";
import { maybeSweepHandReplies, isPersonText, findHandTexts, HAND_REPLY_CURSOR } from "./hand-reply-sweep.js";

const NOW = Date.parse("2026-10-04T21:00:00Z");
const ago = (h) => new Date(NOW - h * 3600000).toISOString();

const fakeStore = ({ drafts = [] } = {}) => {
  const events = []; const cursors = new Map();
  return {
    events, drafts, cursors,
    async listReplyDrafts(_l, { contactId = null, status = null } = {}) {
      return drafts.filter((d) => (!contactId || d.contactId === contactId) && (!status || (Array.isArray(status) ? status.includes(d.status) : d.status === status)));
    },
    async updateReplyDraft(id, doc) { const i = drafts.findIndex((d) => d.id === id); drafts[i] = doc; return doc; },
    async appendContactEvents(_l, contactId, add) {
      let inserted = 0;
      for (const r of add) { if (r.dedupeKey && events.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue; events.push({ ...r, contactId }); inserted++; }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
    async getJobCursor(l, k) { return cursors.get(`${l}|${k}`) || null; },
    async setJobCursor(l, k, v) { cursors.set(`${l}|${k}`, v); return v; },
  };
};

// One conversation: they asked, the bot drafted (held), Matt typed his own
// answer in GHL. Also the bot's own send and a workflow's, neither a person.
const client = (messages) => ({ call: async (path) => {
  if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1", contactId: "c1", lastMessageDate: Date.parse(ago(0.5)) }] };
  return { messages };
} });
const thread = [
  { id: "m4", direction: "outbound", messageType: "TYPE_SMS", source: "app", userId: "u1", dateAdded: ago(1), body: "Tomorrow afternoon work for you?" },
  { id: "m3", direction: "outbound", messageType: "TYPE_SMS", source: "app", dateAdded: ago(1.5), body: "Good deal, I'll line up a time." },
  { id: "m2", direction: "outbound", messageType: "TYPE_SMS", source: "workflow", dateAdded: ago(1.6), body: "Hi, circling back" },
  { id: "m1", direction: "inbound", messageType: "TYPE_SMS", dateAdded: ago(2), body: "Sometime this week? I'm flexible" },
];

test("a text you typed in GHL closes the draft it answered", async () => {
  const store = fakeStore({ drafts: [
    { id: "d1", contactId: "c1", status: "draft", intent: "wants_walkthrough", createdAt: ago(1.9), flags: [] },
    { id: "d2", contactId: "c1", status: "draft", intent: "question", createdAt: ago(0.2), flags: [] },
  ] });
  const seen = [];
  const r = await maybeSweepHandReplies({ client: client(thread), locationId: "L", store, now: NOW, deps: { removeContactTags: async () => {}, onHandText: async (t) => seen.push(t.id) } });
  assert.deepEqual(r, { found: 1, recorded: 1, stoodAside: 1 });
  const ev = store.events.filter((e) => e.type === "hand_reply");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.via, "ghl");
  assert.equal(ev[0].data.text, undefined, "the words stay in GHL");
  assert.equal(store.drafts.find((d) => d.id === "d1").status, "dismissed");
  assert.match(store.drafts.find((d) => d.id === "d1").flags.at(-1), /answered it in GHL/);
  assert.equal(store.drafts.find((d) => d.id === "d2").status, "draft", "a draft written after your text answers something newer");
  assert.deepEqual(seen, ["m4"]);
  assert.ok(store.cursors.get(`L|${HAND_REPLY_CURSOR}`)?.at);
  // The next tick sees the same message and writes nothing twice.
  const again = await maybeSweepHandReplies({ client: client(thread), locationId: "L", store, now: NOW + 15 * 60000, deps: { removeContactTags: async () => {} } });
  assert.equal(again.recorded, 0);
  assert.equal(store.events.filter((e) => e.type === "hand_reply").length, 1);
});

test("only a person's text counts: the bot's own sends, workflows, calls and reactions don't", () => {
  assert.equal(isPersonText({ direction: "outbound", messageType: "TYPE_SMS", source: "app", userId: "u1" }), true);
  assert.equal(isPersonText({ direction: "outbound", messageType: "TYPE_EMAIL", userId: "u1" }), true);
  assert.equal(isPersonText({ direction: "outbound", messageType: "TYPE_SMS", source: "app" }), false, "the bot");
  assert.equal(isPersonText({ direction: "outbound", messageType: "TYPE_SMS", source: "workflow" }), false);
  assert.equal(isPersonText({ direction: "outbound", messageType: "TYPE_CALL", userId: "u1" }), false);
  assert.equal(isPersonText({ direction: "outbound", messageType: "TYPE_ACTIVITY_OPPORTUNITY", userId: "u1" }), false);
  assert.equal(isPersonText({ direction: "inbound", messageType: "TYPE_SMS", userId: "u1" }), false);
});

test("a dry run says what it would set aside and writes nothing", async () => {
  const store = fakeStore({ drafts: [{ id: "d1", contactId: "c1", status: "draft", createdAt: ago(1.9), flags: [] }] });
  const r = await maybeSweepHandReplies({ client: client(thread), locationId: "L", store, now: NOW, dryRun: true, sinceMs: NOW - 14 * 86400000 });
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.contacts.map((c) => [c.contactId, c.wouldStandAside]), [["c1", ["d1"]]]);
  assert.equal(store.events.length, 0);
  assert.equal(store.drafts[0].status, "draft");
  assert.equal(store.cursors.size, 0);
});

test("conversations that didn't move since the last look aren't read", async () => {
  let reads = 0;
  const c = { call: async (path) => {
    if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1", contactId: "c1", lastMessageDate: Date.parse(ago(5)) }] };
    reads++; return { messages: thread };
  } };
  assert.deepEqual(await findHandTexts({ client: c, locationId: "L", sinceMs: NOW - 3600000, now: NOW }), []);
  assert.equal(reads, 0);
});
