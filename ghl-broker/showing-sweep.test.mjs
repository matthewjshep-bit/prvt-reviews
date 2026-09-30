// showing-sweep.test.mjs — the walkthrough texts, on the JSON store.
//
//   node --test showing-sweep.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "showing-sweep-test-"));
delete process.env.DATABASE_URL;

const { store } = await import("./store.js");
const { runShowingSweep, maybeRunShowingSweep } = await import("./showing-sweep.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
await store.init();

// Sat Oct 3 2026, 10am–12pm Pacific; the sweep runs Fri Oct 2 at 4pm Pacific.
const SAT = { start: "2026-10-03T17:00:00.000Z", end: "2026-10-03T19:00:00.000Z" };
const FRI_4PM = Date.parse("2026-10-02T23:00:00Z");
const saved = (showings = { remindDayBefore: true, followUpAfter: true }) => ({
  aiApiKey: "k", conversationAi: normalizeConversationAi({ enabled: true }), dispoAutopilot: { showings },
});
const reachable = async (id) => ({ id, phone: "+12065550100", tags: [] });
const mkDeal = (loc, rsvps) => store.createOffer({
  id: crypto.randomUUID(), locationId: loc, contactId: "agent-1", address: "3511 NE 153rd St, Lake Forest Park, WA 98155",
  cashAmount: 400000, status: "accepted", statusHistory: [],
  deal: { stage: "under_contract", investors: [], stageHistory: [], createdAt: new Date(FRI_4PM - 5 * 86400000).toISOString(),
    showing: { windows: [SAT], rsvps } },
});

test("off by default: nothing is read and nothing runs", async () => {
  assert.equal(await maybeRunShowingSweep({ client: {}, locationId: "loc-sh-off", saved: saved({}), store, now: FRI_4PM }), null);
});

test("the afternoon before, a buyer coming gets one reminder; the next tick finds nothing new", async () => {
  const loc = "loc-sh-remind";
  const deal = await mkDeal(loc, [{ contactId: "b1", name: "Rick", status: "coming", windowStart: SAT.start }, { contactId: "b2", status: "interested" }]);
  const calls = [];
  const deps = { getContact: reachable, startProactive: async (args) => { calls.push(args); return { job: { id: `j${calls.length}` } }; } };
  const r = await runShowingSweep({ client: {}, locationId: loc, saved: saved(), store, now: FRI_4PM, deps });
  assert.equal(r.started, 1, JSON.stringify(r.results));
  assert.equal(calls[0].kind, "showing_reminder");
  assert.equal(calls[0].contactId, "b1");
  assert.equal(calls[0].offer.id, deal.id);
  assert.equal(calls[0].subject.windowLabel, "Sat Oct 3, 10am-12pm");
  assert.equal(calls[0].deps.releaseHeld, false, "drafts for you until the walkthrough switch says send");
  const again = await runShowingSweep({ client: {}, locationId: loc, saved: saved(), store, now: FRI_4PM + 15 * 60000, deps });
  assert.equal(again.started, 0);
  assert.equal(calls.length, 1, "once per buyer per window");
});

test("a buyer whose own text is waiting on you is skipped without a claim, and drafted once it's answered", async () => {
  const loc = "loc-sh-waiting";
  await mkDeal(loc, [{ contactId: "b3", status: "coming", windowStart: SAT.start }]);
  const reply = await store.createReplyDraft({ locationId: loc, contactId: "b3", status: "draft", party: "investor", inbound: "what time again?", outbound: null, reply: "", createdAt: new Date().toISOString() });
  const calls = [];
  const deps = { getContact: reachable, startProactive: async (args) => { calls.push(args); return { job: { id: "j" } }; } };
  const r = await runShowingSweep({ client: {}, locationId: loc, saved: saved(), store, now: FRI_4PM, deps });
  assert.equal(r.started, 0);
  assert.equal(r.results[0].reason, "their text is waiting on you");
  assert.equal((await store.listContactEvents(loc, "b3", { limit: 20 })).some((e) => e.type === "showing_reminder_sent"), false, "not claimed");
  await store.updateReplyDraft(reply.id, { ...reply, status: "sent" });
  const later = await runShowingSweep({ client: {}, locationId: loc, saved: saved(), store, now: FRI_4PM + 15 * 60000, deps });
  assert.equal(later.started, 1, JSON.stringify(later.results));
});

test("an unsubscribed buyer is marked and skipped; a dry run claims nobody", async () => {
  const loc = "loc-sh-dnd";
  await mkDeal(loc, [{ contactId: "b4", status: "coming", windowStart: SAT.start }]);
  const dry = await runShowingSweep({ client: {}, locationId: loc, saved: saved(), store, now: FRI_4PM, dryRun: true,
    deps: { getContact: async () => { throw new Error("a dry run reads nothing from GHL"); } } });
  assert.deepEqual(dry.results.map((x) => [x.kind, x.contactId, x.status]), [["showing_reminder", "b4", "would draft"]]);
  const r = await runShowingSweep({ client: {}, locationId: loc, saved: saved(), store, now: FRI_4PM,
    deps: { getContact: async (id) => ({ id, phone: "+12065550101", dndSettings: { SMS: { status: "permanent" } } }), startProactive: async () => { throw new Error("must not start"); } } });
  assert.equal(r.results[0].reason, "they unsubscribed");
  const events = await store.listContactEvents(loc, "b4", { limit: 20 });
  assert.ok(events.some((e) => e.type === "unsubscribed"));
  assert.equal(events.some((e) => e.type === "showing_reminder_sent"), false);
});
