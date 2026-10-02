// contact-timeline.test.mjs — the work pane's header, read for one person.

import test from "node:test";
import assert from "node:assert/strict";
import { contactTimeline } from "./contact-timeline.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-01T18:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const ahead = (d) => new Date(NOW + d * DAY).toISOString();

const OFFER = {
  id: "o1", locationId: "LOC", contactId: "c1", contactName: "Dana", address: "12 Elm St, Renton, WA 98055", cashAmount: 385000,
  status: "sent", statusAt: ago(9), createdAt: ago(10), sends: [{ ts: ago(9), channels: ["sms"], results: { sms: { ok: true } } }],
  statusHistory: [{ status: "sent", ts: ago(9) }],
};

// One person's reads. The location-wide reads throw: the pane must never
// make them (the Offers table does, once, for everyone).
function fakeStore({ events = [], drafts = [], profile = null, offers = [OFFER], saved = {} } = {}) {
  const reads = [];
  return {
    reads,
    async getContactProfile(_l, id) { reads.push(["profile", id]); return profile; },
    async listOffers(_l, { contactId } = {}) { reads.push(["offers", contactId]); if (!contactId) throw new Error("location-wide offers read"); return offers.filter((o) => o.contactId === contactId); },
    async getOffer(id) { return offers.find((o) => o.id === id) || null; },
    async listContactEvents(_l, contactId, { types = null } = {}) { reads.push(["events", contactId]); return events.filter((e) => e.contactId === contactId && (!types || types.includes(e.type))); },
    async listContactEventsSince() { throw new Error("location-wide events read"); },
    async listReplyDrafts(_l, { contactId } = {}) { if (!contactId) throw new Error("location-wide drafts read"); return drafts.filter((d) => d.contactId === contactId); },
    async getOfferSettings() { return saved; },
  };
}

test("the pane's timeline reads one person, not the whole location", async () => {
  const store = fakeStore();
  const t = await contactTimeline({ store, locationId: "LOC", contactId: "c1", offerId: "o1", now: NOW });
  assert.equal(t.offerId, "o1");
  assert.deepEqual(t.moments.map((m) => m.kind), ["priced", "sent"]);
  assert.ok(store.reads.every(([, id]) => id === "c1"), JSON.stringify(store.reads));
  assert.equal(t.bot.held, false);
  assert.equal(t.bot.pace, "normal");
});

test("it says paused until the date you picked, and the pace", async () => {
  const events = [
    { type: "drive_stopped", contactId: "c1", at: ago(1), data: { until: ahead(6), reason: "on vacation" } },
    { type: "cadence_set", contactId: "c1", at: ago(2), data: { pace: "less" } },
  ];
  const t = await contactTimeline({ store: fakeStore({ events }), locationId: "LOC", contactId: "c1", offerId: "o1", now: NOW });
  assert.equal(t.bot.held, true);
  assert.equal(t.bot.kind, "paused");
  assert.equal(t.bot.until, ahead(6));
  assert.equal(t.bot.pace, "less");
  assert.equal(t.next.kind, "stopped");
  assert.match(t.next.label, /^Paused until/);
});

test("a bot-off tag and an unsubscribe show, read-only", async () => {
  const profile = { party: "agent", tags: ["agent", "stop bot"] };
  const events = [{ type: "unsubscribed", contactId: "c1", at: ago(3), data: {} }];
  const t = await contactTimeline({ store: fakeStore({ profile, events }), locationId: "LOC", contactId: "c1", offerId: "o1", now: NOW });
  assert.equal(t.bot.botOffTag, "stop bot");
  assert.equal(t.bot.unsubscribed, true);
});

test("a stop older than their newest 300 events still shows as stopped", async () => {
  const busy = Array.from({ length: 400 }, (_, i) => ({ type: "text_summary", contactId: "c1", at: ago(1 + i / 1000), data: {} }));
  const store = fakeStore({ events: [{ type: "drive_stopped", contactId: "c1", at: ago(140), data: {} }, ...busy] });
  // The windowed read keeps only the newest 300, as the store does.
  const raw = store.listContactEvents;
  store.listContactEvents = async (l, id, opts = {}) => {
    const rows = await raw.call(store, l, id, opts);
    return opts.types ? rows : rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 300);
  };
  const t = await contactTimeline({ store, locationId: "LOC", contactId: "c1", offerId: "o1", now: NOW });
  assert.equal(t.bot.held, true);
  assert.equal(t.bot.kind, "stopped");
});

test("a buyer's timeline has no agent follow-up, and no offer of theirs to price", async () => {
  const drafts = [{ id: "b1", contactId: "i9", status: "sent", inbound: "send me the package", reply: "Here you go.", propertyAddress: "12 Elm St", createdAt: ago(2), sentAt: ago(2) }];
  const t = await contactTimeline({ store: fakeStore({ drafts }), locationId: "LOC", contactId: "i9", offerId: "o1", party: "investor", now: NOW });
  assert.equal(t.next, null);
  assert.deepEqual(t.moments.map((m) => m.kind), ["they_wrote", "we_replied"]);
});

test("an offer from another location is not read", async () => {
  const store = fakeStore({ offers: [{ ...OFFER, locationId: "ELSEWHERE" }] });
  const t = await contactTimeline({ store, locationId: "LOC", contactId: "c1", offerId: "o1", now: NOW });
  assert.equal(t.offerId, null);
  assert.equal(t.next, null);
});
