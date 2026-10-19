// pass-note.test.mjs — Matt marks a house an agent sent "We passed: <reason>"
// and the bot tells them, unless he texts them first (2026-10-19). End to
// end: the note is drafted for every marked house, waits out his ten
// minutes, goes, and leaves the houses marked; a house he priced since stops
// it; a text of his own makes it his. Offline: the model, GHL and the store
// are all stubbed.

import test from "node:test";
import assert from "node:assert/strict";
import { startProactive, sendReplyDraft, decideAutoSend, _resetJobs as resetReplies } from "./reply-agent.js";
import { startPassNote, sweepPassNotes } from "./pass-note.js";
import { outboundOpening } from "./conversation-prompt.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";

const NOW = Date.parse("2026-10-19T17:00:00Z");   // 10am Pacific
const min = (m) => new Date(NOW - m * 60000).toISOString();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const configWith = (passNote = { enabled: true }) => normalizeConversationAi({
  enabled: true,
  autoSend: { channels: ["sms"], minConfidence: "medium", holdOnNeedsHuman: false, debounceSec: 0, weekends: "all" },
  parties: { agent: { autoSend: { enabled: true, intents: ["question"] }, followUp: { enabled: true }, passNote } },
});
const SAVED = { aiApiKey: "k", company: { signer: "Matt Shepherd" }, conversationAi: configWith() };
const OFF = { ...SAVED, conversationAi: configWith({ enabled: false }) };

// Invented agent and houses: two drafts he marked a few minutes apart.
const marked = (id, address, code, minutesAgo, over = {}) => ({
  id, locationId: "LOC", contactId: "c1", contactName: "Dana Agent", address, cashAmount: null, createdAt: min(120),
  status: "we_passed", statusAt: min(minutesAgo), passReason: { code, at: min(minutesAgo), by: "operator" },
  passNote: { status: "due", markedAt: min(minutesAgo) }, ...over,
});
const PINE = (over = {}) => marked("o1", "1412 Pine St, Kent, WA 98031", "turnkey", 4, over);
const ALDER = (over = {}) => marked("o2", "88 Alder St, Kent, WA 98031", "rural", 1, over);

const fakeStore = ({ offers = [], drafts = [] } = {}) => {
  const rows = new Map(drafts.map((d) => [d.id, d]));
  const events = [];
  const store = {
    offers: new Map(offers.map((o) => [o.id, o])), rows, events,
    async listOffers(_loc, { contactId = null } = {}) { return [...store.offers.values()].filter((o) => !contactId || o.contactId === contactId); },
    async getOffer(id) { return store.offers.get(id) || null; },
    async updateOffer(id, doc) { store.offers.set(id, doc); return true; },
    async listContactEvents(_loc, contactId) { return events.filter((e) => e.contactId === contactId); },
    async listContactEventsSince() { return []; },
    async appendContactEvents(_loc, contactId, list) { events.push(...list.map((r) => ({ ...r, contactId }))); return { inserted: list.length }; },
    async getContactProfile() { return null; },
    async upsertContactProfile() { return {}; },
    async getJobCursor() { return null; },
    async setJobCursor() { return null; },
    async listReplyDrafts(_loc, { status = null, contactId = null } = {}) {
      const want = Array.isArray(status) ? new Set(status) : status ? new Set([status]) : null;
      return [...rows.values()].filter((d) => (!want || want.has(d.status)) && (!contactId || d.contactId === contactId));
    },
    async getReplyDraft(id) { return rows.get(id) || null; },
    async updateReplyDraft(id, doc) { if (!rows.has(id)) return false; rows.set(id, doc); return true; },
    async createReplyDraft(doc) { const full = { ...doc, id: `d${rows.size + 1}`, createdAt: new Date(NOW).toISOString() }; rows.set(full.id, full); return full; },
  };
  return store;
};

function ghlStub() {
  const sent = [];
  const client = {
    call: async (path, opts = {}) => {
      if (/^\/contacts\/c1$/.test(path) && !opts.method) return { contact: { id: "c1", firstName: "Dana", lastName: "Agent", phone: "+12065550100", tags: ["agent"] } };
      if (path.endsWith("/notes") || path.endsWith("/tags")) return {};
      if (path.startsWith("/conversations/search")) return { conversations: [] };
      if (path === "/conversations/messages") { sent.push(opts.body); return { messageId: "m1" }; }
      if (path.endsWith("/customFields")) return { customFields: [] };
      if (/^\/contacts\/c1$/.test(path)) return { contact: {} };
      throw new Error(`unexpected ${path}`);
    },
  };
  return { client, sent };
}
const NOTE = "Thanks for sending these Dana. Going to pass on 1412 Pine, it's in too good a shape for us, and 88 Alder is too rural for our buyers. Keep the rough ones coming, on or off market.";
const draftSaying = (reply) => async () => ({ intent: "pass_note", confidence: "high", needsHuman: false, humanReason: "", reply,
  summary: "Passing on two houses.", propertyAddress: "", counterAmount: 0 });

test("the houses you marked we passed get one note from the bot, naming each and why, and it waits ten minutes after your last mark", async () => {
  resetReplies();
  const { client } = ghlStub();
  const store = fakeStore({ offers: [PINE(), ALDER()] });
  const r = await startPassNote({ client, locationId: "LOC", saved: SAVED, store, contactId: "c1", sendsEnabled: true, startProactive,
    deps: { draft: draftSaying(NOTE), now: () => NOW, random: () => 0 }, now: NOW });
  assert.equal(r.started, true, r.skipped);
  assert.equal(r.houses, 2);
  await pause(60);
  const d = [...store.rows.values()][0];
  assert.ok(d, "a note was drafted");
  assert.equal(d.outbound.kind, "pass_note");
  assert.deepEqual(d.outbound.houses.map((h) => [h.address, h.code]), [["1412 Pine St, Kent, WA 98031", "turnkey"], ["88 Alder St, Kent, WA 98031", "rural"]]);
  assert.equal(d.status, "scheduled", d.autoSend?.reason);
  assert.ok(Date.parse(d.sendAt) >= Date.parse(min(1)) + 10 * 60000, `sends at ${d.sendAt}, ten minutes after the last mark`);
  // Both houses know which note carries them.
  assert.deepEqual([store.offers.get("o1").passNote.status, store.offers.get("o2").passNote.status], ["drafted", "drafted"]);
  assert.equal(store.offers.get("o1").passNote.draftId, d.id);
});

test("with the switch off, nothing is drafted and the houses stay as you marked them", async () => {
  resetReplies();
  const { client } = ghlStub();
  const store = fakeStore({ offers: [PINE()] });
  const r = await startPassNote({ client, locationId: "LOC", saved: OFF, store, contactId: "c1", sendsEnabled: true, startProactive, deps: { draft: draftSaying(NOTE) }, now: NOW });
  assert.match(r.skipped, /off/);
  assert.equal(store.rows.size, 0);
  assert.equal(decideAutoSend({ gate: { ok: true }, party: "agent", intent: "pass_note", config: normalizeConversationAi(OFF.conversationAi), sendsEnabled: true }).send, false);
  assert.equal(decideAutoSend({ gate: { ok: true }, party: "agent", intent: "pass_note", config: normalizeConversationAi(SAVED.conversationAi), sendsEnabled: true }).send, true,
    "on, it sends itself with no box on the auto-send list");
});

const noteDraft = (over = {}) => ({
  id: "n1", locationId: "LOC", contactId: "c1", status: "scheduled", channel: "sms", party: "agent", intent: "pass_note", inbound: "", reply: NOTE,
  outbound: { kind: "pass_note", offerId: "o2", address: "1412 Pine St, Kent, WA 98031; 88 Alder St, Kent, WA 98031",
    houses: [{ offerId: "o1", address: "1412 Pine St, Kent, WA 98031", code: "turnkey", statusAt: min(4) }, { offerId: "o2", address: "88 Alder St, Kent, WA 98031", code: "rural", statusAt: min(1) }] },
  createdAt: min(1), sendAt: new Date(NOW).toISOString(), flags: [], ...over,
});

test("the note goes though both houses are marked we passed, and leaves them marked sent", async () => {
  const { client, sent } = ghlStub();
  const store = fakeStore({ offers: [PINE(), ALDER()], drafts: [noteDraft()] });
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "n1", live: true, auto: true, now: NOW, readThread: async () => "" });
  assert.equal(r.skipped, undefined, r.skipped);
  assert.equal(sent.length, 1);
  assert.deepEqual([store.offers.get("o1").passNote.status, store.offers.get("o2").passNote.status], ["sent", "sent"]);
});

test("a house you priced after marking it stops the note at send", async () => {
  const { client, sent } = ghlStub();
  const store = fakeStore({ offers: [PINE(), ALDER({ status: "new", statusAt: new Date(NOW - 30000).toISOString(), cashAmount: 240000 })], drafts: [noteDraft()] });
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "n1", live: true, auto: true, now: NOW, readThread: async () => "" });
  assert.match(r.skipped, /88 Alder St.*isn't marked "we passed"/);
  assert.equal(sent.length, 0);
  assert.equal((await store.getReplyDraft("n1")).status, "dismissed");
});

test("a note your own text dismissed is yours and never sent again; one superseded is written again; one a day old is dropped", async () => {
  resetReplies();
  const { client } = ghlStub();
  const store = fakeStore({
    offers: [
      PINE({ passNote: { status: "drafted", markedAt: min(4), draftId: "yours" } }),
      marked("o3", "7 Elm St, Kent, WA 98031", "turnkey", 25 * 60, { contactId: "c3" }),
      marked("o4", "9 Fir St, Kent, WA 98031", "comps", 3, { contactId: "c4", passNote: { status: "drafted", markedAt: min(3), draftId: "gone" } }),
    ],
    drafts: [noteDraft({ id: "yours", status: "dismissed" }), noteDraft({ id: "gone", contactId: "c4", status: "superseded" })],
  });
  const started = [];
  const r = await sweepPassNotes({ client, locationId: "LOC", saved: SAVED, store, sendsEnabled: true, now: NOW,
    startProactive: async (args) => { started.push(args.contactId); return { skipped: null, job: { id: "j" } }; } });
  assert.equal(store.offers.get("o1").passNote.status, "yours");
  assert.equal(store.offers.get("o3").passNote.status, "off");
  assert.deepEqual(started, ["c4"], "only the superseded one is written again");
  assert.equal(r.started, 1);
});

test("the prompt names each house and its one reason, and asks for rougher ones with no number", () => {
  const t = outboundOpening({ kind: "pass_note", address: "x", houses: [{ address: "1412 Pine St", words: "it's in too good a shape for us" }, { address: "88 Alder St", words: "it's too rural for our buyers" }] });
  assert.match(t, /- 1412 Pine St: it's in too good a shape for us/);
  assert.match(t, /- 88 Alder St: it's too rural for our buyers/);
  assert.match(t, /thank them for sending these/);
  assert.match(t, /Do NOT name any number/);
  assert.match(t, /Set intent to pass_note/);
});
