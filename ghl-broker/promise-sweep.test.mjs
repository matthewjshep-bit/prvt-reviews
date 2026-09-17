// promise-sweep.test.mjs — the promises the bot makes, kept or said so.

import test from "node:test";
import assert from "node:assert/strict";
import { runPromiseSweep, maybeRunPromiseSweep, settlePromise, localHour } from "./promise-sweep.js";
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

/* ---------- check-ins they asked for ---------- */

import { checkInRequested, offersToSendDeals } from "./shared/follow-up.js";
import { runCheckInSweep } from "./promise-sweep.js";

test("a check-in with a day named reads as a request, due the morning after", () => {
  const monday = Date.parse("2026-09-14T21:18:00Z");   // a Monday afternoon
  const tyler = checkInRequested("Hey Matt, Nothing interesting but i just got back into town. I'll check back in when I get into the office this Wednesday 👍", monday);
  assert.ok(tyler);
  assert.equal(tyler.dueAt, "2026-09-17T17:00:00.000Z", "Thursday morning, after their Wednesday");
  assert.match(tyler.phrase, /wednesday/i);
  assert.ok(checkInRequested("Not yet, I'll let you know in a few weeks", monday));
  assert.equal(checkInRequested("It will be closing on the 17th", monday), null, "no check-in cue");
  assert.equal(checkInRequested("I'll let you know", monday), null, "no day named");
  assert.equal(checkInRequested("closed last month, no longer available", monday), null, "'month' is not Monday");
});

test("an agent offering to send us deals reads as a source", () => {
  assert.equal(offersToSendDeals("Of course. You got an email I can send properties to? We also have a new \"first look\" feature on the mls"), true);
  assert.equal(offersToSendDeals("That house is actually better than brand new! I'll keep you in mind for any fixers"), true);
  assert.equal(offersToSendDeals("Copy that I'll keep an eye on some more properties"), true);
  assert.equal(offersToSendDeals("Sold and gone."), false);
});

const request = (hoursAgo, data) => ({ contactId: "c9", type: "checkin_requested", at: at(hoursAgo), address: "", dedupeKey: `req:${hoursAgo}`, data });

test("a due check-in they didn't beat us to goes once; a source's next week is written", async () => {
  const store = fakeStore({ events: [request(48, { kind: "source", phrase: "", dueAt: at(1), left: 5 })] });
  const s = starter();
  const r = await runCheckInSweep({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: s });
  assert.equal(r.sent, 1);
  assert.equal(s.calls[0].kind, "checkin_due");
  assert.equal(s.calls[0].subject.sourceKind, "source");
  const next = store.events.filter((e) => e.type === "checkin_requested").at(-1);
  assert.equal(next.data.left, 4);
  assert.ok(Date.parse(next.data.dueAt) > NOW);
  const again = await runCheckInSweep({ locationId: "LOC", saved: SAVED, store, now: NOW + HOUR, deps: s });
  assert.equal(again.sent, 0, "the next week isn't due yet, and this one was claimed");
});

test("a check-in they got to first — they texted since asking — sends nothing", async () => {
  const store = fakeStore({ events: [
    request(72, { kind: "date", phrase: "this Wednesday", dueAt: at(2) }),
    { contactId: "c9", type: "text_summary", at: at(10), data: {} },
  ] });
  const s = starter();
  const r = await runCheckInSweep({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: s });
  assert.equal(r.answered, 1);
  assert.equal(s.calls.length, 0);
});

/* ---------- the address they haven't sent yet ---------- */

import { runAddressChase, ADDRESS_CHASE_DAYS } from "./promise-sweep.js";
import { addressPending } from "./shared/follow-up.js";

const DAY = 24 * HOUR;
const pending = (hoursAgo, data = {}) => ({ contactId: "ag", type: "address_pending", at: at(hoursAgo), address: "", dedupeKey: `pend:${hoursAgo}`,
  data: { hint: "I will likely have one in Spanaway soon, it's been a rental for years", firstDueAt: null, phrase: "", ...data } });

test("a property coming with no address reads as pending; one with an address, or another intent, doesn't", () => {
  const p = addressPending({ intent: "new_property", propertyAddress: "", message: "I will likely have one in Spanaway soon, it's been a rental for years", now: NOW });
  assert.match(p.hint, /Spanaway/);
  assert.equal(p.firstDueAt, null);
  assert.equal(addressPending({ intent: "new_property", propertyAddress: "1 Main St, Spanaway, WA 98387", message: "got one", now: NOW }), null);
  assert.equal(addressPending({ intent: "question", propertyAddress: "", message: "what do you buy?", now: NOW }), null);
  assert.ok(addressPending({ intent: "deal_available", propertyAddress: "", message: "should have it listed in a few weeks", now: NOW }).firstDueAt);
});

test("the address chase asks on day 2, once per rung, and not before", async () => {
  const early = fakeStore({ events: [pending(24)] });
  assert.equal((await runAddressChase({ locationId: "LOC", saved: SAVED, store: early, now: NOW, deps: starter() })).sent, 0);
  const store = fakeStore({ events: [pending(50)] });
  const s = starter();
  const r = await runAddressChase({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: s });
  assert.equal(r.sent, 1);
  assert.equal(s.calls[0].kind, "address_chase");
  assert.match(s.calls[0].subject.hint, /Spanaway/);
  assert.equal(s.calls[0].subject.rung, 1);
  assert.equal((await runAddressChase({ locationId: "LOC", saved: SAVED, store, now: NOW + HOUR, deps: s })).sent, 0, "rung 1 is claimed");
  const later = await runAddressChase({ locationId: "LOC", saved: SAVED, store, now: NOW + 3 * DAY + HOUR, deps: s });
  assert.equal(later.sent, 1);
  assert.equal(s.calls[1].subject.rung, 2);
});

test("a late start sends only the latest due rung, and the ladder ends", async () => {
  const store = fakeStore({ events: [pending(10 * 24)] });
  const s = starter();
  await runAddressChase({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: s });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].subject.rung, 3, "the day-9 rung, not days 2 and 5 as well");
  const end = fakeStore({ events: [pending(40 * 24)] });
  const s2 = starter();
  await runAddressChase({ locationId: "LOC", saved: SAVED, store: end, now: NOW, deps: s2 });
  assert.equal(s2.calls[0].subject.rung, ADDRESS_CHASE_DAYS.length);
  assert.equal((await runAddressChase({ locationId: "LOC", saved: SAVED, store: end, now: NOW + 10 * DAY, deps: s2 })).sent, 0, "nothing past the last rung");
});

test("the chase stops when the address arrives or they opt out, and waits while they're talking", async () => {
  const s = starter();
  const got = fakeStore({ events: [pending(50), { contactId: "ag", type: "subject_property_set", at: at(20), address: "1 Main St, Spanaway, WA 98387", data: {} }] });
  const r = await runAddressChase({ locationId: "LOC", saved: SAVED, store: got, now: NOW, deps: s });
  assert.equal(r.found, 1);
  const out = fakeStore({ events: [pending(50), { contactId: "ag", type: "address_pending_closed", at: at(30), data: { intent: "opt_out" } }] });
  assert.equal((await runAddressChase({ locationId: "LOC", saved: SAVED, store: out, now: NOW, deps: s })).sent, 0);
  const talking = fakeStore({ events: [pending(50), { contactId: "ag", type: "text_summary", at: at(5), data: {} }] });
  const t = await runAddressChase({ locationId: "LOC", saved: SAVED, store: talking, now: NOW, deps: s });
  assert.equal(t.sent, 0);
  assert.equal(t.waiting, 1);
  assert.equal(s.calls.length, 0);
});

test("a time they named ('in a few weeks') is the first check-in", async () => {
  const store = fakeStore({ events: [pending(50, { firstDueAt: new Date(NOW + 5 * DAY).toISOString(), phrase: "a few weeks" })] });
  const s = starter();
  assert.equal((await runAddressChase({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: s })).sent, 0);
  assert.equal((await runAddressChase({ locationId: "LOC", saved: SAVED, store, now: NOW + 5 * DAY + HOUR, deps: s })).sent, 1);
  assert.equal(s.calls[0].subject.phrase, "a few weeks");
});

test("settlePromise: an outcome on that house closes what we owed; another house's promise stays open", async () => {
  const { settlePromise } = await import("./promise-sweep.js");
  const now = Date.now();
  const rows = [
    { contactId: "c1", type: "promise_made", at: new Date(now - 5 * 3600000).toISOString(), address: "13025 Ambaum Blvd SW, Burien, WA 98146" },
    { contactId: "c1", type: "promise_owed", at: new Date(now - 2 * 3600000).toISOString(), address: "13025 Ambaum Blvd SW, Burien, WA 98146" },
  ];
  const store = {
    async listContactEventsSince() { return rows; },
    async appendContactEvents(_l, contactId, add) { for (const r of add) rows.push({ ...r, contactId }); return { inserted: add.length, skipped: 0 }; },
    async getContactProfile() { return null; }, async upsertContactProfile() { return {}; },
  };
  const other = await settlePromise({ store, locationId: "L", contactId: "c1", address: "4207 S Bateman St, Seattle, WA 98118", by: "offer_we_passed", now });
  assert.equal(other.settled, false);
  const hit = await settlePromise({ store, locationId: "L", contactId: "c1", address: "13025 Ambaum Blvd SW", by: "offer_we_passed", now });
  assert.equal(hit.settled, true);
  assert.ok(rows.some((e) => e.type === "promise_kept" && e.data?.by === "offer_we_passed"));
  const again = await settlePromise({ store, locationId: "L", contactId: "c1", by: "dismissed", now: now + 1000 });
  assert.equal(again.settled, false, "nothing left open");
});

/* ---------- promises that were never owed ---------- */

test("we asked them a question, so no 'we owe you' text goes out", async () => {
  const asked = promise(5, { data: { what: "answer", draftId: "d5", dueAt: at(1), text: "Fair enough, I'll get back to you. Is the seller showing any flexibility on price at this point?" } });
  const store = fakeStore({ events: [asked] });
  const s = starter();
  const r = await runPromiseSweep({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: { ...s, listUnderwriteJobs: () => [] } });
  assert.equal(s.calls.length, 0, "nothing texted");
  assert.equal(r.owed, 0);
  assert.equal(store.events.some((e) => e.type === "promise_owed"), false, "and nothing lands on Today");
  const kept = store.events.find((e) => e.type === "promise_kept");
  assert.equal(kept?.data?.by, "not_owed");
});

test("a row already on Today for a promise that was never owed clears by itself", async () => {
  const asked = promise(9, { data: { what: "answer", draftId: "d9", dueAt: at(5), text: "Got it. What did the seller say about the roof?" } });
  const owed = { id: "w1", contactId: "c1", type: "promise_owed", at: at(4), address: asked.address, dedupeKey: "promise_owed:c1:x", data: { what: "answer", text: asked.data.text } };
  const store = fakeStore({ events: [asked, owed] });
  const s = starter();
  await runPromiseSweep({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: { ...s, listUnderwriteJobs: () => [] } });
  assert.equal(s.calls.length, 0);
  assert.equal(store.events.find((e) => e.type === "promise_kept")?.data?.by, "not_owed");
});

test("a dismissal keeps its reason", async () => {
  const store = fakeStore({ events: [promise(9), { id: "w1", contactId: "c1", type: "promise_owed", at: at(4), address: promise(9).address, dedupeKey: "promise_owed:c1:y", data: { what: "number" } }] });
  const r = await settlePromise({ store, locationId: "LOC", contactId: "c1", by: "dismissed", reason: { code: "handled_by_call", note: "talked Tuesday" }, now: NOW });
  assert.equal(r.settled, true);
  const kept = store.events.find((e) => e.type === "promise_kept");
  assert.deepEqual(kept.data.reason, { code: "handled_by_call", note: "talked Tuesday" });
  assert.match(kept.data.ourText, /underwriting team/, "with what we said, so the coach can see what was misread");
});

/* ---------- the driver goes first ---------- */

test("the driver already moved on a promise, so no 'still working on it' text goes out, but Today still knows", async () => {
  const p = promise(5);
  const claim = { id: "a1", contactId: "c1", type: "audit_action", at: at(0.2), address: p.address, dedupeKey: `audit:promise_send_number:c1:${p.at}`, data: { kind: "promise_send_number" } };
  const store = fakeStore({ events: [p, claim] });
  const s = starter();
  const r = await runPromiseSweep({ locationId: "LOC", saved: SAVED, store, now: NOW, deps: { ...s, listUnderwriteJobs: () => [] } });
  assert.equal(s.calls.length, 0, "one voice at a time");
  assert.equal(r.owed, 1);
  assert.ok(store.events.some((e) => e.type === "promise_owed"), "the row still reaches Today, where it reads as waiting");
});

test("with the driver switched on, the tick drives before it sweeps", async () => {
  const on = { ...SAVED, conversationAi: normalizeConversationAi({ ...SAVED.conversationAi, driver: { promises: { enabled: true } } }) };
  const offers = [{ id: "o1", locationId: "LOC", contactId: "c1", address: promise(5).address, status: "new", cashAmount: 400000, sends: [], createdAt: at(1) }];
  const store = fakeStore({ events: [promise(5)], offers });
  store.listContactEvents = async (_l, contactId) => store.events.filter((e) => e.contactId === contactId);
  const s = starter();
  const floats = [];
  const r = await maybeRunPromiseSweep({ locationId: "LOC", saved: on, store, now: NOW, sendsEnabled: true,
    deps: { ...s, listUnderwriteJobs: () => [], floatOffer: async (a) => { floats.push(a); return { skipped: null, job: { id: "jf" } }; } } });
  assert.deepEqual(floats, [{ offerId: "o1" }]);
  assert.equal(s.calls.length, 0, "the number went; 'still working on it' did not");
  assert.equal(r.driven, 1);
});
