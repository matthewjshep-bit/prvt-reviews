// call-list.test.mjs — who to call today, and why.
//
// The shapes are 2026-10-02's book (names changed): seven hot offers and
// eleven counters, none of them on Today, while Matt walked GHL's Tier 1
// stage to decide who to call.

import test from "node:test";
import assert from "node:assert/strict";
import { callList, briefFor, normalizeDesk, kText, DESK_DEFAULTS, CALL_KINDS } from "./call-list.js";
import { foldDesk, KIND_STRENGTH } from "./desk.js";

const NOW = Date.parse("2026-10-02T20:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const card = (over = {}) => ({ id: `card:${over.offerId || "o1"}`, side: "agent", lane: "hot", contactId: "c1", contactName: "Maryanne A", offerId: "o1",
  address: "9311 12th Pl SE, Lake Stevens, WA 98258", cashAmount: 197500, status: "sent", ...over });
const offer = (over = {}) => ({ id: "o1", contactId: "c1", contactName: "Maryanne A", address: "9311 12th Pl SE, Lake Stevens, WA 98258", cashAmount: 197500, status: "sent",
  createdAt: ago(20), sends: [{ ts: ago(10) }], ...over });

test("a hot offer is a call today, not after two pushes", () => {
  const offers = [offer({ realm: { answer: "yes", ts: ago(1) } })];
  const rows = callList({ offers, cards: [card()], now: NOW });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.kind, "call_hot");
  assert.equal(r.section, "call");
  assert.match(r.call.goal, /NWMLS/);
  assert.match(r.call.goal, /197\.5K/);
  assert.match(r.call.opener, /^Hi Maryanne, it's Matt/);
  assert.deepEqual(r.call.houses.map((h) => h.offerId), ["o1"]);
});

test("a counter row shows ours, theirs, the gap and the ceiling from the band draft", () => {
  const offers = [offer({ id: "o2", contactId: "c2", contactName: "Kel B", address: "23908 SE 168th St, Issaquah, WA 98027", cashAmount: 690000, status: "countered", counter: { amount: 715000, at: ago(1) } })];
  const drafts = [{ id: "k1", contactId: "c2", status: "draft", intent: "counter", offerId: "o2", inbound: "Seller would do 715", createdAt: ago(1),
    exception: { passed: false, theirAmount: 715000, ceiling: 700000, basis: "70% ARV − rehab at a $10k assignment" } }];
  const rows = callList({ offers, drafts, cards: [card({ lane: "countered", contactId: "c2", contactName: "Kel B", offerId: "o2", address: offers[0].address, cashAmount: 690000, status: "countered" })], now: NOW });
  const r = rows.find((x) => x.kind === "call_counter");
  assert.ok(r);
  assert.deepEqual({ ours: r.counter.ours, theirs: r.counter.theirs, gap: r.counter.gap, ceiling: r.counter.ceiling, over: r.counter.overCeiling }, { ours: 690000, theirs: 715000, gap: 25000, ceiling: 700000, over: 15000 });
  assert.equal(r.draftId, "k1", "the composer is the counter's own draft");
  assert.match(r.call.goal, /Never above what we sent/);
  // A counter at or under our number is nothing to call about.
  const under = callList({ offers: [{ ...offers[0], counter: { amount: 650000 } }], cards: [card({ lane: "countered", contactId: "c2", offerId: "o2", cashAmount: 690000 })], now: NOW });
  assert.equal(under.length, 0);
});

test("a connected call since the reason clears the row; one before it doesn't", () => {
  const offers = [offer({ realm: { answer: "yes", ts: ago(1) } })];
  const talked = { type: "call_summary", contactId: "c1", at: ago(0.5), data: { transcribed: true, durationSec: 200 } };
  assert.equal(callList({ offers, cards: [card()], events: [talked], now: NOW }).length, 0);
  const before = { ...talked, at: ago(3) };
  assert.equal(callList({ offers, cards: [card()], events: [before], now: NOW }).length, 1);
});

test("two no-answers hand the person back to the machine", () => {
  const offers = [offer({ realm: { answer: "yes", ts: ago(1) } })];
  const miss = (d) => ({ type: "call_attempt", contactId: "c1", at: ago(d), data: { outcome: "no_answer", direction: "outbound" } });
  const once = callList({ offers, cards: [card()], events: [miss(0.2)], now: NOW })[0];
  assert.equal(once.section, "call");
  assert.equal(once.call.tries, 1);
  assert.ok(once.score < 100, "lower for the day");
  const twice = callList({ offers, cards: [card()], events: [miss(0.3), miss(0.1)], now: NOW })[0];
  assert.equal(twice.section, "machine");
  assert.match(twice.next.what, /back to texting/);
  // …and the Desk doesn't put them back under Call through another reason.
  const stalled = { id: "hot_stalled:o1", kind: "hot_stalled", severity: "now", group: "stuck", contactId: "c1", offerId: "o1", ops: [] };
  const { rows } = foldDesk([twice, stalled]);
  assert.equal(rows[0].section, "decide");
});

test("a call back date hides the row until then", () => {
  const offers = [offer({ realm: { answer: "yes", ts: ago(1) } })];
  const later = { type: "call_attempt", contactId: "c1", at: ago(0.1), data: { outcome: "call_back", callBackAt: new Date(NOW + 2 * 86400000).toISOString() } };
  assert.equal(callList({ offers, cards: [card()], events: [later], now: NOW }).length, 0);
  assert.equal(callList({ offers, cards: [card()], events: [later], now: NOW + 3 * 86400000 }).length, 1, "the day comes, it's back");
});

test("partner check-ins never crowd out a hot call", () => {
  const partner = (i) => offer({ id: `p${i}`, contactId: `p${i}`, contactName: `Partner ${i}`, address: `${i} Old Deal Rd`, status: "accepted", deal: { stage: "closed" }, createdAt: ago(200) });
  const offers = [offer({ realm: { answer: "yes", ts: ago(1) } }), ...[1, 2, 3, 4].map(partner)];
  const rows = callList({ offers, cards: [card()], settings: { relationshipPerDay: 2 }, now: NOW });
  assert.equal(rows[0].kind, "call_hot");
  assert.equal(rows.filter((r) => r.kind === "call_partner").length, 2, "at most relationshipPerDay");
  const { rows: desk } = foldDesk(rows, { callCap: 2 });
  assert.equal(desk[0].kind, "call_hot");
  assert.equal(desk.filter((r) => r.later).length, 1, "past the cap, behind 'N more to call'");
  // A partner you spoke to last week isn't due.
  const recent = callList({ offers: offers.slice(1, 2), lastAny: new Map([["p1", ago(5)]]), now: NOW });
  assert.equal(recent.length, 0);
});

test("an agent who said 'stop calling' is never on the list", () => {
  const offers = [offer({ realm: { answer: "yes", ts: ago(1) } })];
  const drafts = [{ id: "x", contactId: "c1", status: "sent", inbound: "Please stop calling me about this", intent: "other", createdAt: ago(0.5) }];
  assert.equal(callList({ offers, drafts, cards: [card()], now: NOW }).length, 0);
});

test("they called and nobody picked up: call them back first", () => {
  const missed = { type: "call_attempt", contactId: "c9", at: ago(0.1), data: { outcome: "no_answer", direction: "inbound" } };
  const rows = callList({ offers: [offer({ realm: { answer: "yes", ts: ago(1) } })], cards: [card()], events: [missed], drafts: [{ id: "d", contactId: "c9", contactName: "Rob G", inbound: "hi", createdAt: ago(5) }], now: NOW });
  assert.equal(rows[0].kind, "call_missed");
  assert.match(rows[0].call.opener, /sorry I missed your call/);
});

test("a new agent's first reply about a house is a relationship call; a reply after months of talk isn't", () => {
  const events = [{ type: "outreach_sent", contactId: "n1", at: ago(3) }];
  const drafts = [{ id: "f", contactId: "n1", contactName: "Nadia P", party: "agent", intent: "deal_available", inbound: "I have one on 4th Ave", propertyAddress: "210 4th Ave, Kent, WA", createdAt: ago(0.5) }];
  const r = callList({ events, drafts, now: NOW });
  assert.equal(r[0]?.kind, "call_first_reply");
  assert.match(r[0].call.why, /210 4th Ave/);
  const older = [...events, { type: "text_summary", contactId: "n1", at: ago(40), data: { inbound: "hey" } }];
  assert.equal(callList({ events: older, drafts, now: NOW }).length, 0);
});

test("an engaged agent who went quiet on our offer is a call; a cold one is left to the texts", () => {
  const quiet = { id: "ladder_exhausted:o3", kind: "ladder_exhausted", severity: "soon", group: "stuck", contactId: "c3", contactName: "Alycia B", offerId: "o3", address: "5305 Waldrick Rd SE, Olympia, WA", ops: [] };
  const offers = [offer({ id: "o3", contactId: "c3", contactName: "Alycia B" })];
  const engaged = callList({ offers, actions: [quiet], lastIn: new Map([["c3", ago(20)]]), now: NOW });
  assert.equal(engaged[0]?.kind, "call_quiet");
  assert.equal(callList({ offers, actions: [quiet], now: NOW }).length, 0, "never replied: cold");
});

test("someone who turned texts off, with a house still open, is a phone call", () => {
  const rows = callList({ offers: [offer({ contactId: "u1" })], cards: [card({ contactId: "u1", lane: "countered", contactName: "Bern S" })], unsubscribed: new Set(["u1"]), now: NOW });
  assert.deepEqual(rows.map((r) => r.kind), ["call_phone_only"]);
});

test("a Call row the list didn't build still gets a brief", () => {
  const row = { id: "draft_waiting:w", kind: "draft_waiting", title: "Morgan I: wants walkthrough", contactId: "m", contactName: "Morgan I", address: "1 Elm St, Kent", section: "call" };
  const b = briefFor(row, { cards: [card({ contactId: "m", offerId: "o5" })], offers: [] });
  assert.match(b.goal, /set a time/);
  assert.match(b.opener, /^Hi Morgan, it's Matt — calling about 1 Elm St/);
  assert.equal(b.houses.length, 1);
});

test("settings are whole numbers in range, with defaults", () => {
  assert.deepEqual(normalizeDesk({}), { ...DESK_DEFAULTS });
  assert.equal(normalizeDesk({ callCap: 500 }).callCap, 50);
  assert.equal(normalizeDesk({ relationshipPerDay: "3" }).relationshipPerDay, 3);
  assert.equal(kText(386000), "386K");
  assert.equal(kText(197500), "197.5K", "never rounded up past what we sent");
  assert.equal(kText(567990), "567.9K");
  assert.equal(kText(1082500), "1.08M");
  for (const k of CALL_KINDS) assert.ok(KIND_STRENGTH.includes(k.key), `${k.key} ranks on the Desk`);
});
