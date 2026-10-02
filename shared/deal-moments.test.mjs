// deal-moments.test.mjs — the work pane's timeline strip: one house, one
// person, a few words each, never the words anybody wrote.

import test from "node:test";
import assert from "node:assert/strict";
import { dealMoments, shortMoney } from "./deal-moments.js";

const DAY = 86400000;
const T0 = Date.parse("2026-09-01T17:00:00.000Z");
const d = (n) => new Date(T0 + n * DAY).toISOString();
const NOW = T0 + 20 * DAY;

const offer = (over = {}) => ({
  id: "o1", contactId: "c1", address: "12 Elm St, Renton, WA 98055", cashAmount: 385000, createdAt: d(0),
  autoUnderwrite: { jobId: "j1" },
  sends: [{ ts: d(0.2), channels: ["sms"], results: { sms: { ok: true } } }],
  statusHistory: [{ status: "sent", ts: d(0.2) }, { status: "countered", ts: d(5), amount: 425000 }],
  ...over,
});
const theirText = (n, over = {}) => ({ id: `in${n}`, contactId: "c1", status: "sent", inbound: "any update on 12 Elm? call me at 206-555-0101", reply: "Still working on it.", propertyAddress: "12 Elm St", createdAt: d(n), sentAt: d(n + 0.01), ...over });
const nudge = (n, kind = "offer_nudge", over = {}) => ({ id: `n${n}`, contactId: "c1", status: "sent", inbound: "", reply: "Any word from the seller?", outbound: { kind, offerId: "o1", address: "12 Elm St, Renton, WA 98055" }, autoSent: true, createdAt: d(n), sentAt: d(n), ...over });
const kinds = (r) => r.moments.map((m) => m.kind);

test("an offer's life reads in order: priced, sent, countered, agreed, hot", () => {
  const r = dealMoments({ contactId: "c1", offer: offer({ agreed: { amount: 400000, at: d(8) }, hot: { at: d(9), by: "operator" } }), events: [], drafts: [], now: NOW });
  assert.deepEqual(kinds(r), ["priced", "sent", "countered", "agreed", "hot"]);
  const [priced, sent, countered, agreed, hot] = r.moments;
  assert.equal(priced.label, "priced 385K");
  assert.equal(priced.who, "machine", "an auto-underwrite priced it");
  assert.equal(sent.label, "offer sent");
  assert.equal(countered.label, "countered 425K");
  assert.equal(countered.who, "them");
  assert.equal(agreed.label, "agreed 400K");
  assert.equal(hot.who, "us", "you flagged it");
  assert.ok(r.moments.every((m, i) => i === 0 || m.at >= r.moments[i - 1].at), "oldest first");
});

test("a nudge that never went is not a moment; one that went is the machine's", () => {
  const unsent = nudge(3, "offer_nudge", { status: "dismissed", sentAt: null });
  const r = dealMoments({ contactId: "c1", offer: offer(), drafts: [unsent, nudge(4)], events: [{ type: "follow_up_sent", contactId: "c1", at: d(3), offerId: "o1" }], now: NOW });
  const nudges = r.moments.filter((m) => m.kind === "nudge");
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].at, d(4));
  assert.equal(nudges[0].who, "machine");
});

test("a back-and-forth reads as one moment a side: they wrote ×3, we replied ×3", () => {
  const r = dealMoments({ contactId: "c1", offer: offer({ statusHistory: [] }), drafts: [theirText(2), theirText(2.3), theirText(2.6)], events: [], now: NOW });
  const wrote = r.moments.filter((m) => m.kind === "they_wrote");
  assert.equal(wrote.length, 1);
  assert.equal(wrote[0].count, 3);
  assert.equal(wrote[0].label, "they wrote ×3");
  assert.equal(wrote[0].at, d(2.6), "the run reads at its last");
  const replied = r.moments.filter((m) => m.kind === "we_replied");
  assert.equal(replied.length, 1);
  assert.equal(replied[0].label, "we replied ×3");
  // A week apart is two moments, not one.
  const apart = dealMoments({ contactId: "c1", offer: offer({ statusHistory: [] }), drafts: [theirText(2), theirText(9)], events: [], now: NOW });
  assert.equal(apart.moments.filter((m) => m.kind === "they_wrote").length, 2);
});

test("another house's moments stay off this house's strip; the person's own stay on", () => {
  const otherHouse = theirText(3, { propertyAddress: "99 Oak Ave, Kent, WA" });
  const noHouse = theirText(4, { propertyAddress: "" });
  const otherNudge = nudge(5, "offer_nudge", { outbound: { kind: "offer_nudge", offerId: "o2", address: "99 Oak Ave, Kent, WA" } });
  const call = { type: "call_summary", contactId: "c1", at: d(6), address: "", data: { summary: "talked about the roof" } };
  const otherOff = { type: "listing_off_market", contactId: "c1", at: d(7), address: "99 Oak Ave, Kent, WA", offerId: "o2", data: {} };
  const r = dealMoments({ contactId: "c1", offer: offer({ statusHistory: [] }), drafts: [otherHouse, noHouse, otherNudge], events: [call, otherOff], now: NOW });
  assert.deepEqual(kinds(r).filter((k) => !["priced", "sent"].includes(k)), ["they_wrote", "we_replied", "call"]);
});

test("a send on the offer and as an event is one moment, and a machine send says so", () => {
  const ev = { type: "offer_sent", contactId: "c1", at: d(0.2), offerId: "o1", data: { channels: ["sms"], by: "underwrite" } };
  const r = dealMoments({ contactId: "c1", offer: offer({ statusHistory: [] }), events: [ev], drafts: [], now: NOW });
  const sends = r.moments.filter((m) => m.kind === "sent");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].who, "machine");
});

test("stop, pause, resume and pace are on the strip — without the reason you typed", () => {
  const events = [
    { type: "drive_stopped", contactId: "c1", at: d(10), data: { reason: "Dana is calling the seller" } },
    { type: "drive_resumed", contactId: "c1", at: d(12), data: {} },
    { type: "drive_stopped", contactId: "c1", at: d(13), data: { until: d(17) } },
    { type: "cadence_set", contactId: "c1", at: d(18), data: { pace: "less" } },
  ];
  const r = dealMoments({ contactId: "c1", offer: offer({ statusHistory: [] }), events, drafts: [], now: NOW });
  const labels = r.moments.map((m) => m.label);
  assert.ok(labels.includes("you stopped the bot"));
  assert.ok(labels.includes("bot back on"));
  assert.ok(labels.includes("paused until Sep 18"));
  assert.ok(labels.includes("pause ended"), "a pause ends with no event of its own");
  assert.ok(labels.includes("checking in less"));
  assert.doesNotMatch(JSON.stringify(r), /Dana is calling/);
});

test("no message words, phone or email ever appear", () => {
  const r = dealMoments({
    contactId: "c1", offer: offer(),
    drafts: [theirText(2), nudge(3), { id: "r1", contactId: "c1", status: "sent", inbound: "email me at dana@example.com", reply: "Sent to dana@example.com", createdAt: d(4), sentAt: d(4), autoSent: false, propertyAddress: "12 Elm St" }],
    events: [{ type: "hand_reply", contactId: "c1", at: d(5), data: { chars: 40 } }, { type: "email_received", contactId: "c1", at: d(6), data: { subject: "re: 12 Elm, from dana@example.com" } }],
    now: NOW,
  });
  const s = JSON.stringify(r);
  assert.doesNotMatch(s, /206-555-0101|dana@example\.com|any update|Still working|Sent to|re: 12 Elm/);
  assert.ok(r.moments.some((m) => m.kind === "we_replied" && m.who === "us"));
  assert.ok(r.moments.some((m) => m.kind === "you_texted"));
});

test("the strip keeps the newest when there are many, and says how many there were", () => {
  const many = Array.from({ length: 30 }, (_, i) => nudge(1 + i * 2, "offer_nudge"));
  const r = dealMoments({ contactId: "c1", offer: offer({ statusHistory: [] }), drafts: many, events: [], now: T0 + 100 * DAY, limit: 5 });
  assert.equal(r.moments.length, 5);
  assert.ok(r.total > 5);
  assert.equal(r.moments.at(-1).at, d(59));
});

test("money reads short", () => {
  assert.equal(shortMoney(385000), "385K");
  assert.equal(shortMoney(416500), "416.5K");
  assert.equal(shortMoney(1250000), "1.25M");
  assert.equal(shortMoney(0), "");
});
