import test from "node:test";
import assert from "node:assert/strict";
import { buildFlow, FLOW_STAGES, machineDid } from "./flow.js";

const NOW = Date.parse("2026-09-10T20:00:00Z");
const D = 86400000;
const at = (h) => new Date(NOW - h * 3600000).toISOString();
const win = { windowStartMs: NOW - 7 * D, windowEndMs: NOW + 1, now: NOW };

test("every stage is present in river order, two rows", () => {
  const r = buildFlow({ ...win });
  assert.equal(r.stages.length, 12);
  assert.deepEqual(r.stages.map((s) => s.key), FLOW_STAGES.map((s) => s.key));
  assert.ok(r.stages.every((s) => s.count === 0));
});

test("the machine's share reads off the event's source and flags", () => {
  assert.equal(machineDid({ type: "outreach_sent", source: "conversation", data: { auto: true } }), true);
  assert.equal(machineDid({ type: "outreach_sent", source: "conversation", data: { auto: false } }), false);
  assert.equal(machineDid({ type: "offer_sent", source: "conversation", data: { by: "underwrite" } }), true);
  assert.equal(machineDid({ type: "offer_sent", source: "offer", data: {} }), false);
  assert.equal(machineDid({ type: "follow_up_sent", source: "conversation", data: {} }), true);
  assert.equal(machineDid({ type: "deal_promoted", source: "deal", data: {} }), false);
});

test("a week of the machine at work counts each stage once and splits machine from person", () => {
  const events = [
    { id: "e1", contactId: "a1", type: "import", at: at(100), source: "import", data: { trigger: "daily" } },
    { id: "e2", contactId: "a2", type: "import", at: at(99), source: "import", data: {} },
    { id: "e3", contactId: "a1", type: "outreach_sent", at: at(90), source: "conversation", data: { auto: true, contactName: "Priya" }, address: "1 Fixer Ave" },
    { id: "e4", contactId: "a2", type: "outreach_sent", at: at(89), source: "conversation", data: { auto: false } },
    { id: "e5", contactId: "a1", type: "text_summary", at: at(80), source: "conversation", data: { summary: "has a fixer on Holly" } },
    { id: "e6", contactId: "a1", type: "call_summary", at: at(70), source: "call", data: { summary: "seller would take 425" } },   // same contact: still one reply
    { id: "e7", contactId: "a1", type: "offer_sent", at: at(60), source: "conversation", data: { by: "underwrite", channels: ["sms"] }, offerId: "o1", address: "4410 S Holly St" },
    { id: "e8", contactId: "a1", type: "offer_countered", at: at(50), source: "conversation", data: { amount: 425000 }, offerId: "o1" },
    { id: "e9", contactId: "a1", type: "deal_promoted", at: at(40), source: "deal", offerId: "o1", address: "4410 S Holly St" },
    { id: "e10", contactId: "i1", type: "blast_sent", at: at(30), source: "blast", offerId: "o1", data: { auto: true, label: "dispo-holly" } },
    { id: "e11", contactId: "i2", type: "blast_sent", at: at(30), source: "blast", offerId: "o1", data: { auto: true, label: "dispo-holly" } },
    { id: "e12", contactId: "i1", type: "dataroom_viewed", at: at(20), source: "dataroom", offerId: "o1", data: { viewCount: 1 } },
    { id: "e13", contactId: "i1", type: "dataroom_viewed", at: at(19), source: "dataroom", offerId: "o1", data: { viewCount: 2 } },
    { id: "e14", contactId: "i1", type: "investor_committed", at: at(10), source: "deal", offerId: "o1" },
    { id: "e15", contactId: "a1", type: "deal_stage", at: at(5), source: "deal", offerId: "o1", data: { stage: "assigned" } },
    { id: "e16", contactId: "a1", type: "tag_added", at: at(5), source: "conversation", data: { tag: "tier-1" } },   // not in the feed
    { id: "old", contactId: "a9", type: "outreach_sent", at: new Date(NOW - 20 * D).toISOString(), source: "conversation", data: { auto: true } },
  ];
  const offers = [
    { id: "o1", contactId: "a1", contactName: "Priya", address: "4410 S Holly St", status: "accepted", createdAt: at(65), autoUnderwrite: { finishedAt: at(64), dryRun: false }, cashAmount: 412000,
      proactive: { takeCheckAt: at(63) }, realm: { answer: "yes", at: at(55) }, statusHistory: [{ status: "sent", ts: at(60) }, { status: "countered", ts: at(50) }], counter: { amount: 425000, at: at(50) }, deal: { stage: "assigned" } },
    { id: "o2", contactId: "a3", address: "9 Held St", status: "draft", createdAt: at(30), autoUnderwrite: { finishedAt: at(30), held: true, holdReasons: ["comps"] } },
  ];
  const drafts = [
    { id: "d1", contactId: "a1", contactName: "Priya", status: "sent", autoSent: true, sentAt: at(79) },
    { id: "d2", contactId: "a2", status: "sent", autoSent: false, sentAt: at(78) },
    { id: "d3", contactId: "a2", status: "draft" },
  ];
  const r = buildFlow({ ...win, offers, events, drafts, jobs: [{ status: "running" }] });
  const s = Object.fromEntries(r.stages.map((x) => [x.key, x]));
  assert.deepEqual([s.found.count, s.found.machine, s.found.person], [2, 1, 1]);
  assert.deepEqual([s.first_text.count, s.first_text.machine, s.first_text.person], [2, 1, 1], "the 20-day-old one is outside the window");
  assert.equal(s.replied.count, 1, "one contact replied twice, counted once");
  assert.equal(s.replied.person, 1);
  assert.equal(s.underwritten.count, 2);
  assert.equal(s.underwritten.machine, 2);
  assert.match(s.underwritten.sub, /1 clear · 1 held · 1 running now/);
  assert.deepEqual([s.offered.count, s.offered.machine], [1, 1]);
  assert.equal(s.floated.count, 1);
  assert.equal(s.floated.sub, "1 said the number works");
  assert.equal(s.countered.count, 1);
  assert.equal(s.contract.count, 1);
  assert.equal(s.blasted.count, 1, "one deal blasted");
  assert.equal(s.blasted.sub, "2 buyers");
  assert.equal(s.opened.count, 1, "one buyer opened, twice");
  assert.equal(s.buyer.count, 1);
  assert.equal(s.closed.count, 1);
  // conversion is within a row: replied of first_text, blasted has none (row start)
  assert.equal(s.replied.conversion, 50);
  assert.equal(s.blasted.conversion, null);
  assert.equal(s.found.conversion, null);
  // the feed: newest first, no tag noise, names and details attached
  assert.equal(r.feed[0].type, "deal_stage");
  assert.equal(r.feed[0].detail, "assigned");
  assert.ok(!r.feed.some((f) => f.type === "tag_added"));
  const call = r.feed.find((f) => f.type === "call_summary");
  assert.equal(call.detail, "seller would take 425");
  assert.equal(call.contactName, "Priya");
  assert.equal(r.feed.find((f) => f.type === "offer_sent").machine, true);
  assert.equal(r.feed.find((f) => f.type === "offer_sent").detail, "sms · after a clean underwrite");
  assert.equal(r.feed.find((f) => f.type === "blast_sent").side, "dispo");
  assert.ok(!r.feed.some((f) => f.id === "old"));
  // totals carry the drafts' machine share
  assert.deepEqual(r.totals.messages, { autoSent: 1, personSent: 1 });
});

test("with no offer_sent events the send ledger on the offer counts as a person's send", () => {
  const offers = [{ id: "o1", contactId: "a1", address: "1 A St", status: "sent", createdAt: at(30), sends: [{ ts: at(20), channels: ["sms"] }] }];
  const s = Object.fromEntries(buildFlow({ ...win, offers }).stages.map((x) => [x.key, x]));
  assert.deepEqual([s.offered.count, s.offered.person], [1, 1]);
});
