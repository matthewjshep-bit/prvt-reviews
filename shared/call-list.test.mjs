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

// Live data, 2026-10-02: 3418 Wetmore had a realm "yes" recorded at 289,750,
// then was re-priced to 226,000; Woodcrest's band "agreed" 402,500 over the
// 390,000 we'd signed. The call card said "289.7K is agreed — get it on paper"
// — a number above what the book says we're at. It never names more.
test("a call never says an agreed number above our current offer — it asks you to settle the number first", () => {
  const offers = [offer({ cashAmount: 226000, agreed: { amount: 289750, at: ago(1), via: "realm_yes" }, realm: { answer: "yes", ts: ago(1) } })];
  const r = callList({ offers, cards: [card({ cashAmount: 226000 })], now: NOW })[0];
  assert.equal(r.kind, "call_hot");
  assert.doesNotMatch(`${r.call.goal} ${r.call.opener}`, /289/, "the stale agreement's number is never what we say or aim at");
  assert.match(r.call.why, /289\.7K on record is above our 226K/, "it tells you why the number is in doubt");
  assert.match(r.call.goal, /226K/);
  assert.match(r.call.why, /settle the number/);
  assert.doesNotMatch(r.call.opener, /works/, "no 'sounds like it works' on a number in doubt");
});

test("an agreement even a few hundred over the book is in doubt — never said as agreed", () => {
  const offers = [offer({ cashAmount: 226000, agreed: { amount: 226300, at: ago(1), via: "realm_yes" } })];
  const r = callList({ offers, cards: [card({ cashAmount: 226000 })], now: NOW })[0];
  assert.match(r.call.why, /settle the number/);
});

test("flagged hot with nothing agreed says hot, not agreed", () => {
  const offers = [offer({ status: "countered", hot: { at: ago(1), by: "operator" } })];
  const r = callList({ offers, cards: [card({ cashAmount: 197500 })], now: NOW })[0];
  assert.equal(r.kind, "call_hot");
  assert.doesNotMatch(r.call.why, /agreed/);
});

// 2026-10-04: rows stayed on the Desk after Matt had answered by text in GHL.
test("they called and you texted them back yourself: off the list", () => {
  const missed = { type: "call_attempt", contactId: "c1", at: ago(0.3), data: { outcome: "no_answer", direction: "inbound" } };
  assert.equal(callList({ offers: [], cards: [card({ lane: "sent" })], events: [missed], now: NOW })[0]?.kind, "call_missed");
  const typed = { type: "hand_reply", contactId: "c1", at: ago(0.2), data: { via: "ghl" } };
  assert.equal(callList({ offers: [], cards: [card({ lane: "sent" })], events: [missed, typed], now: NOW }).length, 0);
});

// The Desk on 2026-10-04 (names changed): 15 Call rows, and Matt — "today
// should only be for urgent things only a human should do". With the push
// to paper, the hold and the offer ladder on, the machine has the hot
// offers, the held counters and the quiet threads; a write-up handed to
// someone else is the one call left.
test("the Desk keeps only what needs you: hot, held and quiet are the machine's", () => {
  const MACHINE = { hotPush: true, counterHold: { enabled: true, checkIns: 2, gapHours: 72 }, nudges: true };
  const hot = (id, c, over = {}) => offer({ id, contactId: c, contactName: `Agent ${c}`, address: `${id} Main St, Seattle, WA 98101`, hot: { at: ago(3), by: "conversation", signal: "presenting" }, ...over });
  const hotCard = (id, c) => card({ offerId: id, contactId: c, contactName: `Agent ${c}`, address: `${id} Main St, Seattle, WA 98101` });
  const offers = [
    hot("1", "writing", { hot: { at: ago(1), by: "conversation", signal: "writing_up" } }),
    hot("2", "deciding"),
    hot("3", "handed"),
    hot("4", "signing"),
    offer({ id: "5", contactId: "held", contactName: "Agent held", address: "5 Main St, Seattle, WA 98101", status: "countered", cashAmount: 259600, counter: { amount: 270000, at: ago(5) },
      counterHold: { at: ago(2), ours: 259600, theirs: 270000, nudges: [], replies: [] } }),
  ];
  const cards = [hotCard("1", "writing"), hotCard("2", "deciding"), hotCard("3", "handed"), hotCard("4", "signing"),
    card({ lane: "countered", offerId: "5", contactId: "held", contactName: "Agent held", address: "5 Main St, Seattle, WA 98101", cashAmount: 259600, status: "countered" })];
  const said = (c, text, d) => ({ id: `${c}-${d}`, contactId: c, inbound: text, createdAt: ago(d) });
  const drafts = [
    said("deciding", "Great. Have a good weekend.", 0.5),
    said("handed", "Write up whatever you like! You can call the listing broker for better insight", 1),
    said("handed", "(360) 555-0161 here!", 0.5),
    said("signing", "Sent it over for your signature through Authentisign", 0.2),
  ];
  const quiet = [{ kind: "gone_quiet", contactId: "q1", contactName: "Agent q1", offerId: "9", address: "9 Main St" }];
  const rows = callList({ offers, cards, drafts, actions: quiet, now: NOW, machine: MACHINE });
  const by = Object.fromEntries(rows.map((r) => [r.contactId, r]));
  assert.equal(by.writing.section, "machine");
  assert.equal(by.writing.next.what, "waiting on their write-up");
  assert.equal(by.deciding.section, "machine", "their goodbye doesn't make a hot offer a call");
  assert.equal(by.handed.section, "call");
  assert.match(by.handed.call.goal, /\(360\) 555-0161/);
  assert.equal(by.signing.kind, "paper_to_sign");
  assert.equal(by.signing.section, "decide");
  assert.equal(by.held.kind, "counter_held");
  assert.equal(by.held.section, "machine");
  assert.match(by.held.title, /held at 259\.6K/);
  assert.equal(by.q1, undefined, "the offer ladder keeps asking: no 'gone quiet' call");
  const desk = foldDesk(rows, {});
  assert.deepEqual(desk.rows.filter((r) => r.section === "call").map((r) => r.contactId), ["handed"]);
  // Switched off, they read as before: calls.
  const off = callList({ offers, cards, drafts, actions: quiet, now: NOW });
  assert.equal(off.find((r) => r.contactId === "writing").section, "call");
});

test("a text after the call doesn't put a hot offer back on the call list", () => {
  const offers = [offer({ hot: { at: ago(3), by: "conversation", signal: "presenting" } })];
  const talked = { type: "call_summary", contactId: "c1", at: ago(1), data: { transcribed: true, durationSec: 224 } };
  const after = [{ id: "bye", contactId: "c1", inbound: "Great. Have a good weekend.", createdAt: ago(0.9) }];
  assert.equal(callList({ offers, cards: [card()], events: [talked], drafts: after, now: NOW }).length, 0);
});
