// promise-sweep.test.mjs — the promises the bot makes, kept or said so.

import test from "node:test";
import assert from "node:assert/strict";
import { runPromiseSweep, maybeRunPromiseSweep, localHour } from "./promise-sweep.js";
import { detectPromise, PROMISE_DUE_HOURS } from "./shared/follow-up.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { buildPipeline } from "./shared/pipeline.js";

const HOUR = 3600000;
// 2026-09-14 20:00 UTC = 1pm Pacific.
const NOW = Date.parse("2026-09-14T20:00:00Z");
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
const SAVED = { aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true } } } }) };

const fakeStore = ({ events = [], drafts = [], offers = [] } = {}) => {
  const rows = [...events];
  return {
    events: rows,
    async listContactEventsSince(_loc, since, { types = null } = {}) {
      return rows.filter((e) => e.at >= since && (!types || types.includes(e.type)));
    },
    async appendContactEvents(_loc, contactId, add) {
      let inserted = 0;
      for (const r of add) {
        if (r.dedupeKey && rows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue;
        rows.push({ ...r, contactId });
        inserted++;
      }
      return { inserted, skipped: add.length - inserted };
    },
    async getContactProfile() { return null; },
    async upsertContactProfile() { return {}; },
    async listReplyDrafts(_loc, { contactId, status } = {}) {
      return drafts.filter((d) => (!contactId || d.contactId === contactId) && (!status || d.status === status));
    },
    async listOffers(_loc, { contactId } = {}) { return offers.filter((o) => !contactId || o.contactId === contactId); },
  };
};

const promise = (hoursAgo, over = {}) => ({
  id: `p${hoursAgo}`, contactId: "c1", type: "promise_made", at: at(hoursAgo), address: "83 Olympic Dr NW, Shoreline, WA 98177",
  ref: "d1", dedupeKey: `promise_made:d${hoursAgo}`,
  data: { what: "number", draftId: `d${hoursAgo}`, dueAt: new Date(Date.parse(at(hoursAgo)) + PROMISE_DUE_HOURS * HOUR).toISOString(),
    text: "Good to know the bones are solid. I'll run it past my underwriting team today and get back to you." },
  ...over,
});

const starter = () => {
  const calls = [];
  return { calls, startProactive: async (args) => { calls.push(args); return { job: { id: `j${calls.length}` } }; } };
};

/* ---------- detecting a promise ---------- */

test("today's promises read as promises, and today's plain replies don't", () => {
  assert.equal(detectPromise("Let me run this by my underwriting team today and get back to you with a number."), "number");
  assert.equal(detectPromise("Should have a number back to you today."), "number");
  assert.equal(detectPromise("Still on my radar. Let me get the numbers rerun today and I'll come back with a firm figure rather than guess at it."), "number");
  assert.equal(detectPromise("Good to know the bones are solid. I'll run it past my underwriting team today and get back to you."), "number");
  assert.equal(detectPromise("Fair point on the ADU. Let me run it by my partner and get back to you this afternoon."), "answer");
  assert.equal(detectPromise("Good question on the due diligence piece. Let me run it by my partner and come back to you today with exactly how we'd structure it."), "answer");
  assert.equal(detectPromise("Sounds good, catch you Wednesday. Anything that needs real work, send it my way."), null);
  assert.equal(detectPromise("Ran the Bateman numbers. As-is with a quick close we could likely do around 600k."), null);
});

/* ---------- the sweep ---------- */

test("a due promise with nothing sent is owed: recorded, and a promise_due text that carries what we said", async () => {
  const store = fakeStore({ events: [promise(5)] });
  const s = starter();
  const r = await runPromiseSweep({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: { ...s, listUnderwriteJobs: () => [] } });
  assert.equal(r.owed, 1);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].kind, "promise_due");
  assert.equal(s.calls[0].subject.what, "number");
  assert.match(s.calls[0].subject.promisedText, /underwriting team/);
  assert.ok(store.events.some((e) => e.type === "promise_owed"));
});

test("numbers that went out after the promise keep it, and nothing is texted", async () => {
  const store = fakeStore({
    events: [promise(5)],
    drafts: [{ id: "rc1", contactId: "c1", status: "sent", intent: "realm_check", outbound: { kind: "realm_check" }, sentAt: at(2) }],
  });
  const s = starter();
  const r = await runPromiseSweep({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: { ...s, listUnderwriteJobs: () => [] } });
  assert.equal(r.kept, 1);
  assert.equal(s.calls.length, 0);
  assert.ok(store.events.some((e) => e.type === "promise_kept"));
});

test("a promise not yet due waits", async () => {
  const store = fakeStore({ events: [promise(1)] });
  const s = starter();
  const r = await runPromiseSweep({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: { ...s, listUnderwriteJobs: () => [] } });
  assert.equal(r.waiting, 1);
  assert.equal(s.calls.length, 0);
});

test("an underwrite still running past the due time gets its grace before we say anything", async () => {
  const store = fakeStore({ events: [promise(5)] });
  const s = starter();
  const r = await runPromiseSweep({ locationId: "LOC", saved: SAVED, store, now: NOW,
    deps: { ...s, listUnderwriteJobs: () => [{ id: "uw1", status: "running", contactId: "c1" }] } });
  assert.equal(r.waiting, 1);
  assert.equal(s.calls.length, 0);
});

test("the owed text goes once — a second sweep leaves it to Today", async () => {
  const store = fakeStore({ events: [promise(5)] });
  const s = starter();
  const deps = { ...s, listUnderwriteJobs: () => [] };
  await runPromiseSweep({ locationId: "LOC", saved: SAVED, store, now: NOW, deps });
  await runPromiseSweep({ locationId: "LOC", saved: SAVED, store, now: NOW + HOUR, deps });
  assert.equal(s.calls.length, 1);
});

test("a held underwrite on that house rides into the text, so it asks for their numbers", async () => {
  const store = fakeStore({
    events: [promise(5)],
    offers: [{ id: "o1", contactId: "c1", address: "83 Olympic Dr NW, Shoreline, WA 98177", status: "draft",
      autoUnderwrite: { passed: false, held: ["only 0 priced comps — the price proxy needs 6 to have a top tier"] } }],
  });
  const s = starter();
  await runPromiseSweep({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: { ...s, listUnderwriteJobs: () => [] } });
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].subject.heldReason, /only 0 priced comps/);
});

test("the sweep doesn't text at night", async () => {
  const night = Date.parse("2026-09-15T10:00:00Z");   // 3am Pacific
  assert.equal(localHour(night), 3);
  const s = starter();
  const r = await maybeRunPromiseSweep({ locationId: "LOC", saved: SAVED, store: fakeStore({ events: [promise(5)] }), now: night, deps: s });
  assert.equal(r, null);
  assert.equal(s.calls.length, 0);
});

test("an owed promise is a 'now' row on Today until it's kept", () => {
  const owed = { contactId: "c1", type: "promise_owed", at: at(1), address: "83 Olympic Dr NW, Shoreline, WA 98177", data: { what: "number", heldReason: "only 0 priced comps" } };
  const p1 = buildPipeline({ events: [owed], contactNames: { c1: "Shawn Filer" }, now: NOW });
  const row = p1.actions.find((a) => a.kind === "promise_owed");
  assert.ok(row, "owed row present");
  assert.equal(row.severity, "now");
  assert.match(row.title, /Shawn Filer: we owe them a number on 83 Olympic Dr NW/);
  const p2 = buildPipeline({ events: [owed, { contactId: "c1", type: "promise_kept", at: at(0) }], now: NOW });
  assert.ok(!p2.actions.some((a) => a.kind === "promise_owed"), "cleared once kept");
});
