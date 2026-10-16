// call-list.test.mjs — who to call today, and why.
//
// The shapes are 2026-10-02's book (names changed): seven hot offers and
// eleven counters, none of them on Today, while Matt walked GHL's Tier 1
// stage to decide who to call.

import test from "node:test";
import assert from "node:assert/strict";
import { callList, briefFor, normalizeDesk, kText, DESK_DEFAULTS, CALL_KINDS } from "./call-list.js";
import { foldDesk, KIND_STRENGTH, urgentReasons } from "./desk.js";

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
  const fresh = callList({ offers, cards: [card()], now: NOW })[0];
  const once = callList({ offers, cards: [card()], events: [miss(0.2)], now: NOW })[0];
  assert.equal(once.section, "call");
  assert.equal(once.call.tries, 1);
  assert.ok(once.score < fresh.score, "lower for the day");
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
  // A hot offer nobody has agreed yet: no boosts, so the ring back leads.
  const rows = callList({ offers: [offer({ hot: { at: ago(1), by: "operator" } })], cards: [card()], events: [missed], drafts: [{ id: "d", contactId: "c9", contactName: "Rob G", inbound: "hi", createdAt: ago(5) }], now: NOW });
  assert.equal(rows[0].kind, "call_missed");
  assert.match(rows[0].call.opener, /sorry I missed your call/);
});

test("a new agent's first reply about a house is a relationship call; a reply after months of talk isn't", () => {
  // Our first text was about another house: 4th Ave is one they brought us.
  const events = [{ type: "outreach_sent", contactId: "n1", at: ago(3), address: "88 Elm St, Kent, WA" }];
  const drafts = [{ id: "f", contactId: "n1", contactName: "Nadia P", party: "agent", intent: "deal_available", inbound: "I have one on 4th Ave", propertyAddress: "210 4th Ave, Kent, WA", createdAt: ago(0.5) }];
  const r = callList({ events, drafts, now: NOW });
  assert.equal(r[0]?.kind, "call_first_reply");
  assert.match(r[0].call.why, /210 4th Ave/);
  const older = [...events, { type: "text_summary", contactId: "n1", at: ago(40), data: { inbound: "hey" } }];
  assert.equal(callList({ events: older, drafts, now: NOW }).length, 0);
});

// Matt, 2026-10-08: ~78 of 86 Call rows were first replies, most of them
// "it's turnkey" about the house our first text named. A first reply is a
// call only when it's a lead.
const iceEvents = [{ type: "outreach_sent", contactId: "n1", at: ago(3), address: "210 4th Ave, Kent, WA 98032" }];
const firstReply = (over = {}) => ({ id: "f", contactId: "n1", contactName: "Nadia P", party: "agent", intent: "deal_available", propertyAddress: "210 4th Ave, Kent, WA", createdAt: ago(0.5), ...over });

test("an agent who says the house is turnkey isn't a first-reply lead", () => {
  for (const inbound of ["It's turnkey, not a fix", "Move-in ready! New roof and updated kitchen", "Not a fixer, it's in great shape"]) {
    const r = callList({ events: iceEvents, drafts: [firstReply({ inbound })], now: NOW });
    assert.equal(r.filter((x) => x.kind === "call_first_reply").length, 0, inbound);
  }
});

// 2026-10-15: the agents behind deals with committed buyers said "it's
// turnkey" first and brought their next house once we talked. A small call
// for a week: what else are they working on?
test("a turnkey first reply is a small call for a week: what else are they working on", () => {
  const r = callList({ events: iceEvents, drafts: [firstReply({ inbound: "It's turnkey, not a fix" })], now: NOW });
  assert.equal(r[0]?.kind, "call_turnkey_week");
  assert.equal(r[0].section, "call");
  assert.match(r[0].call.opener, /What else are you working on\?/);
  assert.ok(r[0].score < 70, "below a lead's first reply");
  // Six days on it's still there; past the week it's gone.
  assert.equal(callList({ events: iceEvents, drafts: [firstReply({ inbound: "It's turnkey, not a fix", createdAt: ago(6) })], now: NOW })[0]?.kind, "call_turnkey_week");
  assert.equal(callList({ events: iceEvents, drafts: [firstReply({ inbound: "It's turnkey, not a fix", createdAt: ago(8) })], now: NOW }).length, 0);
  // A lead's first reply still only lasts firstReplyDays.
  assert.equal(callList({ events: iceEvents, drafts: [firstReply({ inbound: "Yes it's a project, foundation issues", createdAt: ago(5) })], now: NOW }).length, 0);
});

test("an agent who says it's a project is", () => {
  const r = callList({ events: iceEvents, drafts: [firstReply({ inbound: "Yes it's a project, foundation issues and the roof leaks" })], now: NOW });
  assert.equal(r[0]?.kind, "call_first_reply");
  // The qualify step already found it a flip: a lead whatever the words.
  const q = callList({ events: iceEvents, drafts: [firstReply({ inbound: "see my last", qualify: { stage: "qualified", address: "210 4th Ave, Kent, WA" } })], now: NOW });
  assert.equal(q[0]?.kind, "call_first_reply");
  // Off-market, or a number on it, is a lead too.
  assert.equal(callList({ events: iceEvents, drafts: [firstReply({ inbound: "I have a pocket listing nearby" })], now: NOW })[0]?.kind, "call_first_reply");
  assert.equal(callList({ events: iceEvents, drafts: [firstReply({ inbound: "Seller would take 425k" })], now: NOW })[0]?.kind, "call_first_reply");
  // Our question went and the answer was vague: no call.
  assert.equal(callList({ events: iceEvents, drafts: [firstReply({ inbound: "could use some love", qualify: { stage: "ask", address: "210 4th Ave, Kent, WA" } })], now: NOW }).length, 0);
});

test("an agent who asks for a call is", () => {
  const r = callList({ events: iceEvents, drafts: [firstReply({ intent: "wants_call", propertyAddress: "", inbound: "Give me a call when you can" })], now: NOW });
  assert.equal(r[0]?.kind, "call_first_reply");
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
  const MACHINE = { hotPush: true, offerNudge: true, counterHold: { enabled: true, checkIns: 2, gapHours: 72 }, nudges: true };
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
  // An agreed price says what the machine is doing: pushing it to paper.
  const agreed = callList({ offers: [hot("7", "agreed", { agreed: { at: ago(1), via: "acceptance", amount: 197500 } })], cards: [hotCard("7", "agreed")], now: NOW, machine: MACHINE });
  assert.match(agreed[0].title, /pushing it to paper/);
  assert.equal(agreed[0].next.what, "the next push to paper");
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
  assert.match(by.deciding.title, /keeps asking where the seller is/, "warm, nothing agreed: the nudge has it, not a push to paper");
  const desk = foldDesk(rows, {});
  assert.deepEqual(desk.rows.filter((r) => r.section === "call").map((r) => r.contactId), ["handed"]);
  // Nothing drives a warm offer when the offer ladder is off: it stays a call.
  const noNudge = callList({ offers, cards, drafts, actions: quiet, now: NOW, machine: { ...MACHINE, offerNudge: false } });
  assert.equal(noNudge.find((r) => r.contactId === "deciding").section, "call");
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

// 3418 Wetmore: a yes at 289,750, then 226,000 by hand. Not a number to
// "settle" on the Desk — but no paper at 226k either (pushesToPaper false).
test("a yes you re-priced below yourself isn't a 'settle the number' call", () => {
  const MACHINE = { hotPush: true, offerNudge: true, counterHold: null, nudges: true };
  const wet = offer({ cashAmount: 226000, hot: { at: ago(3), by: "conversation", signal: "writing_up" }, realm: { answer: "yes", ts: ago(3) },
    agreed: { at: ago(3), via: "realm_yes", amount: 289750 }, revisions: [{ ts: ago(2.5), from: 289750, to: 226000 }] });
  const rows = callList({ offers: [wet], cards: [card({ cashAmount: 226000 })], now: NOW, machine: MACHINE });
  assert.equal(rows[0].section, "machine");
  assert.doesNotMatch(rows[0].title, /settle/);
  assert.match(rows[0].next.what, /write-up|nudge/);
  // With no re-price of yours, an agreement above the book is still yours to settle.
  const stale = offer({ cashAmount: 226000, hot: { at: ago(3), by: "conversation", signal: "warm" }, agreed: { at: ago(3), via: "realm_yes", amount: 289750 } });
  assert.match(callList({ offers: [stale], cards: [card({ cashAmount: 226000 })], now: NOW, machine: MACHINE })[0].title, /settle the number/);
});

test("an agent who brings us a house gets a call within the hour, not a text thread — every off-market deal with a buyer had one", () => {
  const brought = offer({ id: "b1", contactId: "c9", contactName: "Dana R", address: "23706 138th Dr SE, Snohomish, WA 98296", status: "new", createdAt: ago(0.05), sends: [],
    autoUnderwrite: { leadSource: "agent_brought", theirNumber: { seller: 250000, ceiling: 329250, room: 79250, fits: true } } });
  const drafts = [{ id: "d1", contactId: "c9", inbound: "A friend of mine owns a place on a double lot. The brother is POA, she's going into assisted living", createdAt: ago(0.06) }];
  const rows = callList({ offers: [brought], drafts, now: NOW });
  const r = rows.find((x) => x.kind === "call_brought");
  assert.ok(r, "a call row");
  assert.equal(r.section, "call");
  assert.match(r.title, /brought us 23706 138th Dr SE — a seller going through a life event — their 250K works/);
  assert.match(r.call.goal, /won't approach or bother the seller/);
  assert.match(r.call.goal, /Never above our number/);
  assert.match(r.call.opener, /^Hi Dana, it's Matt/);
  assert.ok(KIND_STRENGTH.indexOf("call_brought") < KIND_STRENGTH.indexOf("call_counter"));
  assert.ok(CALL_KINDS.some((k) => k.key === "call_brought"));

  const ours = { ...brought, autoUnderwrite: { leadSource: "hook" } };
  assert.equal(callList({ offers: [ours], now: NOW }).filter((x) => x.kind === "call_brought").length, 0, "the listing we texted about is not one they brought");
  const stale = { ...brought, createdAt: ago(3) };
  assert.equal(callList({ offers: [stale], now: NOW }).filter((x) => x.kind === "call_brought").length, 0, "after two days it's the machine's thread");
  const passedOn = { ...brought, status: "we_passed" };
  assert.equal(callList({ offers: [passedOn], now: NOW }).filter((x) => x.kind === "call_brought").length, 0);
});

test("a house the agent brought that our underwrite held is still a call — what the hold is missing is what you ask for", () => {
  const held = offer({ id: "h9", contactId: "c8", contactName: "Lee K", address: "6814 49th Ave E, Tacoma, WA", status: "draft", cashAmount: null, createdAt: ago(0.1), sends: [],
    autoUnderwrite: { leadSource: "agent_brought", held: ["only 1 priced comps — the price proxy needs 6 to have a top tier"] } });
  const r = callList({ offers: [held], now: NOW }).find((x) => x.kind === "call_brought");
  assert.ok(r);
  assert.match(r.title, /no number yet \(only 1 priced comps\)/);
  assert.match(r.call.goal, /what our underwrite is missing/);
});

test("a seller 7% under our number is a call, not a dead thread — live or lost in the last two months", () => {
  const ask = (address, sellerAsk, d = 2, contactId = "c5") => ({ type: "property_details", contactId, address, at: ago(d), data: { sellerAsk } });
  const live = offer({ id: "g1", contactId: "c5", contactName: "Dana R", address: "10511 Moller Dr NW, Gig Harbor, WA", cashAmount: 607500, status: "sent", arv: 900000, repairs: 60000 });
  const rows = callList({ offers: [live], cards: [card({ lane: "sent", contactId: "c5", contactName: "Dana R", offerId: "g1", address: live.address, cashAmount: 607500 })], asks: [ask(live.address, 650000)], now: NOW });
  const r = rows.find((x) => x.kind === "call_gap");
  assert.ok(r, "a call row");
  assert.match(r.title, /their 650K vs our 607.5K on 10511 Moller Dr NW — 7% apart/);
  assert.equal(r.gap.middle, 629000);
  assert.match(r.call.goal, /Never above our number/);

  const far = callList({ offers: [live], cards: [card({ lane: "sent", contactId: "c5", offerId: "g1", address: live.address, cashAmount: 607500 })], asks: [ask(live.address, 800000)], now: NOW });
  assert.equal(far.filter((x) => x.kind === "call_gap").length, 0, "24% apart is not a call");

  const lost = { ...live, id: "g2", status: "passed", statusAt: ago(10) };
  assert.match(callList({ offers: [lost], asks: [ask(live.address, 650000)], now: NOW }).find((x) => x.kind === "call_gap").title, /and we let it go/);
  assert.equal(callList({ offers: [{ ...lost, statusAt: ago(90) }], asks: [ask(live.address, 650000)], now: NOW }).filter((x) => x.kind === "call_gap").length, 0, "lost months ago");
  assert.equal(callList({ offers: [{ ...lost, statusNote: "outside the area we buy in" }], asks: [ask(live.address, 650000)], now: NOW }).filter((x) => x.kind === "call_gap").length, 0, "lost for what it is");
  assert.equal(normalizeDesk({}).gapPct, 15);
});

// 2026-10-14: list-backs, buyer's-agent offers, referral fees and deal lists
// were answered "keep me in mind". The terms are Matt's.
test("an agent who offered partner terms gets a partner row carrying what they offered", () => {
  const ev = (over = {}) => ({ type: "partner_terms", contactId: "c8", at: ago(0.2), data: { kind: "list_back", phrase: "Do you do list backs?", kinds: ["list_back"], addToBuyers: false }, ...over });
  const drafts = [{ id: "d8", contactId: "c8", contactName: "Pat Agent", status: "draft", inbound: "Do you do list backs?", partnerTerms: { kind: "list_back" }, createdAt: ago(0.2) }];
  const rows = callList({ events: [ev()], drafts, now: NOW });
  const r = rows.find((x) => x.kind === "call_partner_terms");
  assert.ok(r, "a partner row");
  assert.equal(r.contactName, "Pat Agent");
  assert.equal(r.draftId, "d8", "the held reply rides on the row");
  assert.match(r.title, /^Pat Agent: asked about a list-back — "Do you do list backs\?"/);
  assert.deepEqual(r.partner, { kind: "list_back", phrase: "Do you do list backs?", kinds: ["list_back"], addToBuyers: false });
  assert.match(r.call.goal, /terms are yours/);
  assert.doesNotMatch(r.call.goal, /buyer list/);
  assert.ok(CALL_KINDS.some((k) => k.key === "call_partner_terms" && /Partner terms/.test(k.label)));
  // Ahead of the investor-minded call for the same person.
  const minded = { type: "investor_minded", contactId: "c8", at: ago(0.2), data: { cue: "i can pay a 10k assignment" } };
  const buyer = ev({ data: { kind: "investor_buyer", phrase: "I can pay a 10k assignment if it pencils", kinds: ["investor_buyer"], addToBuyers: true } });
  const both = callList({ events: [minded, buyer], drafts, now: NOW });
  assert.deepEqual(both.filter((x) => x.contactId === "c8").map((x) => x.kind), ["call_partner_terms"]);
  assert.match(both[0].call.goal, /add them to the buyer list/i);
  assert.equal(both[0].partner.addToBuyers, true);
  // Done once you've talked, or texted them yourself; gone after two weeks.
  assert.equal(callList({ events: [ev(), { type: "hand_reply", contactId: "c8", at: ago(0.1) }], drafts, now: NOW }).filter((x) => x.kind === "call_partner_terms").length, 0);
  assert.equal(callList({ events: [ev({ at: ago(15) })], drafts, now: NOW }).filter((x) => x.kind === "call_partner_terms").length, 0);
  assert.equal(callList({ events: [ev()], drafts, unsubscribed: new Set(["c8"]), now: NOW }).filter((x) => x.kind === "call_partner_terms").length, 0);
});

test("an agent who talks like an investor gets one relationship call, and a brought house that's a wholesaler's assignment says so", () => {
  const ev = { type: "investor_minded", contactId: "c7", at: ago(1), data: { cue: "finder's fee" } };
  const rows = callList({ offers: [offer({ id: "x", contactId: "c7", contactName: "Sam T", status: "passed" })], events: [ev], now: NOW });
  const r = rows.find((x) => x.kind === "call_investor");
  assert.ok(r);
  assert.match(r.title, /talks like an investor \("finder's fee"\)/);
  assert.equal(callList({ events: [ev, { type: "call_summary", contactId: "c7", at: ago(0.5), data: { connected: true, durationSec: 120 } }], now: NOW }).filter((x) => x.kind === "call_investor").length, 0, "once you've talked, it's done");

  const brought = offer({ id: "w1", contactId: "c6", contactName: "Lee K", address: "1823 Maple St, Everett, WA", status: "new", createdAt: ago(0.1), sends: [], autoUnderwrite: { leadSource: "agent_brought" } });
  const drafts = [{ id: "d", contactId: "c6", inbound: "Investor has it under contract, selling the assignment at 400", createdAt: ago(0.1) }];
  assert.match(callList({ offers: [brought], drafts, now: NOW }).find((x) => x.kind === "call_brought").title, /a wholesaler's assignment/);
});

// 2026-10-14: "Contact <a colleague> at John L Scott, she has one coming
// up" got a thank-you and nothing else. The person they named is a stranger
// to us; whether to reach out is Matt's.
test("an agent who points us to someone with a house raises a referral row on Today, and texts nobody", () => {
  const ev = { type: "referral_mentioned", contactId: "c8", at: ago(1), source: "conversation",
    data: { name: "Sara Example", brokerage: "John L Scott", relation: "", phone: "(555) 555-0100", phrase: "Contact Sara Example at John L Scott, she has one coming up" } };
  const rows = callList({ offers: [offer({ id: "y", contactId: "c8", contactName: "Pat Agent", status: "passed" })], events: [ev], now: NOW });
  const r = rows.find((x) => x.kind === "referral");
  assert.ok(r);
  assert.equal(r.section, "decide");
  assert.equal(r.title, "Referral: Sara Example (John L Scott) — Pat says they have one");
  assert.match(r.detail, /\(555\) 555-0100/);
  assert.match(r.detail, /mention Pat/);
  assert.deepEqual(r.ops, [], "no button sends anything");
  assert.ok(CALL_KINDS.some((k) => k.key === "referral"));
  assert.deepEqual(urgentReasons([r]).map((x) => x.kind), ["referral"], "it's on Today");

  const relative = { ...ev, data: { name: "", brokerage: "", relation: "husband's client", phone: "", phrase: "my husband's client wants to sell" } };
  assert.equal(callList({ events: [relative], now: NOW }).find((x) => x.kind === "referral").title, "Referral: their husband's client — the agent says they have one");
  assert.equal(callList({ events: [{ ...ev, at: ago(40) }], now: NOW }).filter((x) => x.kind === "referral").length, 0, "a month on, it's old news");
});

// 2026-10-15: an address texted to us that GHL couldn't simply take — a
// different one on file, or another contact has it — is Matt's to check.
test("an email they texted that GHL couldn't take is on Today until an email is saved for them", () => {
  const offered = { type: "email_offered", contactId: "c9", at: ago(1), source: "conversation",
    data: { email: "new@example.com", current: "old@example.com", why: "a different one is on file" } };
  const rows = callList({ offers: [offer({ id: "z", contactId: "c9", contactName: "Sam Buyer", status: "sent" })], events: [offered], now: NOW });
  const r = rows.find((x) => x.kind === "email_check");
  assert.ok(r);
  assert.equal(r.title, "Sam texted an email: new@example.com");
  assert.match(r.detail, /GHL has old@example\.com/);
  assert.equal(r.email, "new@example.com");
  assert.deepEqual(r.ops.map((o) => o.key), ["use_email", "open_contact"]);
  assert.deepEqual(urgentReasons([r]).map((x) => x.kind), ["email_check"], "it's on Today");
  assert.ok(CALL_KINDS.some((k) => k.key === "email_check"));

  const saved = { type: "email_saved", contactId: "c9", at: ago(0.5), data: { email: "new@example.com" } };
  assert.equal(callList({ events: [offered, saved], now: NOW }).find((x) => x.kind === "email_check"), undefined, "gone once an email is saved");

  const taken = { ...offered, data: { email: "dup@example.com", current: "", why: "another GHL contact has it" } };
  const t = callList({ events: [taken], now: NOW }).find((x) => x.kind === "email_check");
  assert.match(t.detail, /Another GHL contact already has that address/);
  assert.deepEqual(t.ops.map((o) => o.key), ["open_contact"], "nothing to Use when GHL would refuse it");

  assert.equal(callList({ events: [{ ...offered, at: ago(30) }], now: NOW }).find((x) => x.kind === "email_check"), undefined, "three weeks, then it's gone");
});

/* ---------- a counter close to ours is a call (2026-10-15) ---------- */

test("a counter that comes in close to our number after the hold is a call again, not the machine's", () => {
  const MACHINE = { hotPush: true, offerNudge: true, counterHold: { enabled: true, checkIns: 2, gapHours: 72, callWithinPct: 10 }, nudges: true };
  const held = (counter) => offer({ id: "5", contactId: "held", contactName: "Agent held", address: "5 Main St, Seattle, WA 98101", status: "countered", cashAmount: 300000,
    counter, counterHold: { at: ago(4), ours: 300000, theirs: 340000, nudges: [ago(1)], replies: [] } });
  const heldCard = card({ lane: "countered", offerId: "5", contactId: "held", contactName: "Agent held", address: "5 Main St, Seattle, WA 98101", cashAmount: 300000, status: "countered" });
  // Their 340K before the hold: the machine holds it.
  const before = callList({ offers: [held({ amount: 340000, at: ago(5) })], cards: [heldCard], now: NOW, machine: MACHINE });
  assert.equal(before[0].kind, "counter_held");
  // They came down to 315K since: 5% apart, a call.
  const after = callList({ offers: [held({ amount: 315000, at: ago(0.5) })], cards: [heldCard], now: NOW, machine: MACHINE });
  assert.equal(after[0].kind, "call_counter");
  assert.equal(after[0].section, "call");
  assert.equal(after[0].counter.closePct, 5);
  assert.match(after[0].title, /5% apart, a call lands it/);
});

/* ---------- what moves a call up (2026-10-15) ---------- */

test("calls are ranked by what's behind the deals: a partner or source, an investor-minded agent, a life event, a close counter", () => {
  const hotOffer = (id, c, over = {}) => offer({ id, contactId: c, contactName: `Agent ${c}`, address: `${id} Main St, Seattle, WA 98101`, hot: { at: ago(1), by: "operator" }, ...over });
  const hotCard = (id, c) => card({ offerId: id, contactId: c, contactName: `Agent ${c}`, address: `${id} Main St, Seattle, WA 98101` });
  const offers = [hotOffer("1", "plain"), hotOffer("2", "warm"), offer({ id: "3", contactId: "warm", address: "3 Oak Ave, Kent, WA", status: "passed", realm: { answer: "yes", ts: ago(40) } })];
  const events = [{ type: "investor_minded", contactId: "warm", at: ago(20), data: { cue: "I own a few rentals" } }];
  const drafts = [{ id: "w", contactId: "warm", inbound: "The owner passed away and the executor wants it gone", createdAt: ago(2) }];
  const rows = callList({ offers, cards: [hotCard("1", "plain"), hotCard("2", "warm")], events, drafts, now: NOW });
  const by = Object.fromEntries(rows.map((r) => [r.contactId, r]));
  assert.equal(by.plain.call.boosts, undefined);
  assert.deepEqual(by.warm.call.boosts.map((b) => [b.key, b.points]), [["partner", 15], ["investor_minded", 10], ["life_event", 10]]);
  assert.equal(by.warm.call.boosts.reduce((s, b) => s + b.points, 0), 35);
  assert.ok(by.warm.score > by.plain.score);
  assert.equal(rows[0].contactId, "warm");
  // A counter 5% over ours.
  const ctr = callList({ offers: [offer({ id: "o4", contactId: "c4", status: "countered", cashAmount: 300000, counter: { amount: 315000, at: ago(1) } })],
    cards: [card({ lane: "countered", contactId: "c4", offerId: "o4", cashAmount: 300000, status: "countered" })], now: NOW });
  assert.ok(ctr[0].call.boosts.some((b) => b.key === "close_counter"));
});

test("the day's number of calls is a setting, 10 by default, 0 to 30", () => {
  assert.equal(normalizeDesk({}).dailyCalls, 10);
  assert.equal(DESK_DEFAULTS.dailyCalls, 10);
  assert.equal(normalizeDesk({ dailyCalls: 0 }).dailyCalls, 0);
  assert.equal(normalizeDesk({ dailyCalls: 99 }).dailyCalls, 30);
});
