// partner-answer.test.mjs — a question the bot couldn't answer, answered once.

import test from "node:test";
import assert from "node:assert/strict";
import { answerPartnerQuestion, forgetAnswer } from "./partner-answer.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";

const NOW = Date.parse("2026-09-17T20:00:00Z");
const at = (h) => new Date(NOW - h * 3600000).toISOString();

const fakeStore = ({ settings = {}, events = [] } = {}) => {
  const s = { settings: { aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true }), company: { name: "Shep Flips" }, ...settings }, events: [...events] };
  return {
    ...s,
    get saved() { return s.settings; },
    async getOfferSettings() { return s.settings; },
    async saveOfferSettings(_loc, next) { s.settings = next; return next; },
    async listContactEventsSince(_loc, _since, { types } = {}) { return s.events.filter((e) => !types || types.includes(e.type)); },
    async appendContactEvents(_loc, contactId, add) {
      let inserted = 0;
      for (const r of add) { if (r.dedupeKey && s.events.some((e) => e.dedupeKey === r.dedupeKey)) continue; s.events.push({ ...r, contactId }); inserted++; }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; },
    async upsertContactProfile() { return {}; },
    events: s.events,
  };
};
const owed = { id: "w1", contactId: "c1", type: "promise_owed", at: at(3), address: "", dedupeKey: "promise_owed:c1:x", data: { what: "answer", text: "Let me check with my partner and get back to you.", draftId: "d0" } };
const starter = (result = null) => {
  const calls = [];
  return { calls, startProactive: async (args) => { calls.push(args); return result || { skipped: null, job: { id: "j1" } }; } };
};
const run = (store, s, over = {}) => answerPartnerQuestion({
  locationId: "LOC", store, contactId: "c1", draftId: "d0", question: "What's your inspection window?",
  answer: "Ten days, shorter for a clean house.", now: NOW, deps: s, ...over,
});

test("an answer becomes a draft in our voice and a standing answer, and the owed-an-answer row clears", async () => {
  const store = fakeStore({ events: [owed] });
  const s = starter();
  const r = await run(store, s);
  assert.equal(r.started, true);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].kind, "partner_answer");
  assert.equal(s.calls[0].contactId, "c1");
  assert.deepEqual(s.calls[0].subject, { address: "", question: "What's your inspection window?", answer: "Ten days, shorter for a clean house." });
  const saved = store.saved.conversationAi.answers;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].question, "What's your inspection window?");
  assert.equal(saved[0].answer, "Ten days, shorter for a clean house.");
  assert.equal(saved[0].party, "agent");
  assert.equal(r.savedAnswerId, saved[0].id);
  const kept = store.events.find((e) => e.type === "promise_kept");
  assert.equal(kept?.data?.by, "answered");
});

test("with 'save for next time' unticked the reply is drafted and nothing is kept", async () => {
  const store = fakeStore({ events: [owed] });
  const r = await run(store, starter(), { saveAsFact: false });
  assert.equal(r.started, true);
  assert.equal(r.savedAnswerId, null);
  assert.deepEqual(store.saved.conversationAi.answers, []);
});

test("an answer with a phone number in it goes to them but is never kept as a standing answer", async () => {
  const store = fakeStore({ events: [owed] });
  const s = starter();
  const r = await run(store, s, { answer: "Call my partner on 206-555-0142 and he'll walk you through it." });
  assert.equal(r.started, true);
  assert.equal(r.savedAnswerId, null);
  assert.match(r.notSaved, /phone number, an email or a street address/);
  assert.deepEqual(store.saved.conversationAi.answers, []);
});

test("an empty answer is refused, and so is one with nobody to send it to", async () => {
  await assert.rejects(run(fakeStore(), starter(), { answer: "   " }), /answer/i);
  await assert.rejects(run(fakeStore(), starter(), { contactId: "" }), /contactId/);
});

test("when the draft can't be started nothing is saved and the promise stays open", async () => {
  const store = fakeStore({ events: [owed] });
  const r = await run(store, starter({ skipped: "Conversation AI is switched off", job: null }));
  assert.equal(r.started, false);
  assert.match(r.skipped, /switched off/);
  assert.deepEqual(store.saved.conversationAi.answers, []);
  assert.equal(store.events.some((e) => e.type === "promise_kept"), false);
});

test("the same answer given twice is kept once", async () => {
  const store = fakeStore({ events: [owed] });
  await run(store, starter());
  await run(store, starter());
  assert.equal(store.saved.conversationAi.answers.length, 1);
});

test("undo forgets exactly that answer", async () => {
  const store = fakeStore({ events: [owed], settings: { conversationAi: normalizeConversationAi({ enabled: true, answers: [{ id: "keep", question: "Local?", answer: "Yes." }] }) } });
  const r = await run(store, starter());
  const out = await forgetAnswer({ store, locationId: "LOC", id: r.savedAnswerId });
  assert.equal(out.removed, true);
  assert.deepEqual(store.saved.conversationAi.answers.map((a) => a.id), ["keep"]);
  assert.equal((await forgetAnswer({ store, locationId: "LOC", id: "nope" })).removed, false);
});
