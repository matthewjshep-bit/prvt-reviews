// second-look.test.mjs — a strong past offer, asked about once more.
//
// The 2026-10-16 audit found 36 offers that died close to the seller's number
// with nothing planned. These pin which of them earn a second look, and the
// many that never do.

import test from "node:test";
import assert from "node:assert/strict";
import {
  secondLookDue, theirNumberOn, numberPresented, numbersPass, secondLookNumber, offMarketOn,
  normalizeSecondLook, SECOND_LOOK_DEFAULTS, SECOND_LOOK_SENT,
} from "./second-look.js";
import { normalizeConversationAi } from "./conversation-ai.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-16T17:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const ON = { enabled: true };

// A listing agent's house: our 380K went out on paper, they passed 30 days
// ago, and the seller's counter was 410K (7.9% over ours).
const offer = (over = {}) => ({
  id: "o1", contactId: "c1", address: "1418 Alder Ln, Kent, WA 98031", cashAmount: 380000,
  status: "passed", statusAt: ago(30), createdAt: ago(45),
  sends: [{ ts: ago(44), channels: ["sms"], results: { sms: { ok: true } } }],
  counter: { amount: 410000, at: ago(35) },
  ...over,
});
// Two real texts from them, five weeks back.
const talked = [
  { id: "d1", contactId: "c1", status: "handled", inbound: "Seller is hoping for closer to 410", intent: "counter", propertyAddress: "1418 Alder Ln", createdAt: ago(35) },
  { id: "d2", contactId: "c1", status: "handled", inbound: "They're going to pass for now, thanks for the offer", intent: "rejection", propertyAddress: "1418 Alder Ln", createdAt: ago(30) },
];
const due = (over = {}) => secondLookDue({ offer: offer(), offers: [offer()], events: [], drafts: talked, cfg: ON, now: NOW, ...over });

test("the settings: off by default, and every key survives a save", () => {
  assert.equal(SECOND_LOOK_DEFAULTS.enabled, false);
  const cfg = normalizeConversationAi({ parties: { agent: { followUp: { secondLook: { enabled: true, withinPct: 12 } } } } });
  assert.deepEqual(cfg.parties.agent.followUp.secondLook, { enabled: true, withinPct: 12, afterDays: 21, everyDays: 45, maxPerHouse: 2, minTheirTexts: 2 });
  assert.equal(normalizeConversationAi({}).parties.agent.followUp.secondLook.enabled, false, "off unless switched on");
  assert.equal(cfg.parties.investor.followUp.secondLook, undefined, "agent only");
  const again = normalizeConversationAi(cfg);
  assert.deepEqual(again.parties.agent.followUp.secondLook, cfg.parties.agent.followUp.secondLook, "idempotent");
  assert.equal(normalizeSecondLook({ withinPct: 500 }).withinPct, 50, "clamped");
});

test("a passed offer whose seller came within 15% of ours, from an agent who talked to us, gets a second look", () => {
  const v = due();
  assert.equal(v.due, true, v.why);
  assert.equal(v.theirs, 410000);
  assert.equal(v.source, "counter");
  assert.equal(v.ours, 380000);
  assert.equal(v.gapPct, 7.9);
  assert.equal(v.step, 1);
  assert.match(v.why, /their counter 410K is 7\.9% over our 380K/);
});

test("a seller far over our number gets no second look", () => {
  const v = due({ offer: offer({ counter: { amount: 460000, at: ago(35) } }) });
  assert.equal(v.due, false);
  assert.match(v.why, /21\.1% over our 380K/);
});

test("the lowest number the seller has shown counts: a price watch list price under their old counter", () => {
  const o = offer({ counter: { amount: 460000, at: ago(35) }, priceWatch: { listPrice: 425000, status: "FOR_SALE", checkedAt: ago(2) } });
  assert.deepEqual(theirNumberOn({ offer: o, events: [] }), { amount: 425000, source: "list", at: ago(2) });
  const v = due({ offer: o, offers: [o] });
  assert.equal(v.due, true, v.why);
  assert.equal(v.source, "list");
  // What the agent told us the seller needs, on this house only.
  const said = [{ type: "property_details", address: "1418 Alder Ln, Kent, WA", at: ago(36), data: { sellerAsk: 400000 } },
    { type: "property_details", address: "9 Other St, Kent, WA", at: ago(36), data: { sellerAsk: 100000 } }];
  assert.deepEqual(theirNumberOn({ offer: o, events: said }), { amount: 400000, source: "seller", at: ago(36) });
});

test("a house that went pending or sold never gets a second look, and nobody asks whether it sold", () => {
  const gone = offer({ priceWatch: { listPrice: 399000, status: "PENDING", offMarketAt: ago(10) } });
  assert.ok(offMarketOn({ offer: gone }));
  assert.match(due({ offer: gone, offers: [gone] }).why, /off the market/);
  const back = offer({ priceWatch: { listPrice: 399000, status: "FOR_SALE", offMarketAt: ago(20), backOnMarketAt: ago(5) } });
  assert.equal(due({ offer: back, offers: [back] }).due, true, "back on the market is fair game");
  const told = [...talked, { id: "d3", contactId: "c1", status: "handled", inbound: "It's pending now", propertyAddress: "1418 Alder Ln", createdAt: ago(25) }];
  assert.match(due({ drafts: told }).why, /said it's gone/);
});

test("an agent who wrote us once and never got on a call gets no second look; a real call counts", () => {
  const once = [talked[1]];
  assert.match(due({ drafts: once }).why, /wrote us 1 time and never on a real call/);
  const call = { type: "call_summary", at: ago(33), data: { durationSec: 240, transcribed: true, summary: "talked through the counter" } };
  assert.equal(due({ drafts: once, events: [call] }).due, true);
  // Auto-replies aren't them talking.
  const auto = [...once, { id: "d9", contactId: "c1", status: "handled", inbound: "Thank you for your message, we will get back to you shortly", createdAt: ago(31) }];
  assert.equal(due({ drafts: auto }).due, false);
});

test("a conversation that isn't quiet yet waits: their text this week, or our nudge on the house", () => {
  const recent = [...talked, { id: "d4", contactId: "c1", status: "handled", inbound: "any other fixers you're looking at?", createdAt: ago(5) }];
  assert.match(due({ drafts: recent }).why, /they wrote 5 days ago/);
  const nudged = [...talked, { id: "n1", contactId: "c1", status: "sent", inbound: "", outbound: { kind: "offer_nudge", offerId: "o1" }, sentAt: ago(6), createdAt: ago(6) }];
  assert.match(due({ drafts: nudged }).why, /we texted them about it 6 days ago/);
  const fresh = offer({ statusAt: ago(10) });
  assert.match(due({ offer: fresh, offers: [fresh] }).why, /not 21 yet/);
});

test("our number has to have been in front of them: paper, a number texted in a reply, or a realm check", () => {
  const unsent = offer({ sends: [] });
  assert.equal(numberPresented(unsent), null);
  assert.match(due({ offer: unsent, offers: [unsent] }).why, /never went out/);
  const texted = offer({ sends: [], floatSentAt: ago(40) });
  assert.equal(numberPresented(texted), ago(40));
  assert.equal(due({ offer: texted, offers: [texted] }).due, true);
  const failed = offer({ sends: [{ ts: ago(44), results: { sms: { ok: false } } }] });
  assert.equal(numberPresented(failed), null, "a send that failed everywhere isn't paper");
});

test("our own pass for what the house is never comes back; our pass over their counter does", () => {
  const rural = offer({ status: "we_passed", statusNote: "rural — 5 acres", counter: { amount: 400000, at: ago(35) } });
  assert.equal(numbersPass(rural), false);
  assert.match(due({ offer: rural, offers: [rural] }).why, /what it is/);
  const swept = offer({ status: "we_passed", retired: { by: "held-sweep", at: ago(30) } });
  assert.equal(numbersPass(swept), false);
  const held = offer({ status: "we_passed", statusNote: "held at 380K; 2 check-ins and they didn't move", counterHold: { at: ago(40), ours: 380000 } });
  assert.equal(numbersPass(held), true);
  assert.equal(due({ offer: held, offers: [held] }).due, true);
  const mobile = offer({ asset: { type: "manufactured" } });
  assert.match(due({ offer: mobile, offers: [mobile] }).why, /not a house we buy/);
});

test("lost more than 120 days ago, a deal, or an open offer still unsent: no second look", () => {
  assert.match(due({ offer: offer({ statusAt: ago(130) }) }).why, /more than 120 days/);
  assert.match(due({ offer: offer({ deal: { stage: "closed" } }) }).why, /became a deal/);
  assert.match(due({ offer: offer({ status: "unavailable" }) }).why, /unavailable/);
});

test("twice per house at most, 45 days apart, and one house per agent at a time", () => {
  const sent = (d, offerId = "o1", address = "1418 Alder Ln, Kent, WA") => ({ type: SECOND_LOOK_SENT, at: ago(d), offerId, address, data: {} });
  assert.match(due({ events: [sent(100), sent(50)] }).why, /asked 2 times already/);
  assert.match(due({ events: [sent(30)] }).why, /last second look was 30 days ago/);
  // Passed in early July, asked once in late August, nothing back: the second one.
  const july = offer({ statusAt: ago(100) });
  const earlier = talked.map((d, i) => ({ ...d, createdAt: ago(105 - i * 5) }));
  const second = due({ offer: july, offers: [july], drafts: earlier, events: [sent(50)] });
  assert.equal(second.due, true, second.why);
  assert.equal(second.step, 2);
  // A look that drafted nothing (the claim) still spaces the next try.
  assert.match(due({ events: [{ type: "follow_up_sent", at: ago(3), offerId: "o1", address: "1418 Alder Ln", data: { kind: "second_look" } }] }).why, /3 days ago/);
  // Another house of theirs asked about last month: one at a time.
  assert.match(due({ events: [sent(20, "o7", "77 Birch Way, Auburn, WA")] }).why, /one house at a time — we asked about 77 Birch Way/);
  // They said no to the last one.
  const no = [...talked, { id: "d5", contactId: "c1", status: "handled", inbound: "No thanks, seller's firm", intent: "rejection", propertyAddress: "1418 Alder Ln", createdAt: ago(40) }];
  assert.match(due({ events: [sent(60)], drafts: no }).why, /said no to the last second look/);
});

test("another live offer with them, an opted-out or annoyed agent, or a call queued today: not today", () => {
  const live = { id: "o2", contactId: "c1", address: "55 Cedar Ct, Renton, WA", cashAmount: 300000, status: "sent", statusAt: ago(3), createdAt: ago(4), sends: [{ ts: ago(3) }] };
  assert.match(due({ offers: [offer(), live] }).why, /live offer on 55 Cedar Ct/);
  assert.match(due({ events: [{ type: "unsubscribed", at: ago(50) }] }).why, /opted out/);
  const cross = [...talked, { id: "d6", contactId: "c1", status: "handled", inbound: "how many times do I have to say it", createdAt: ago(29) }];
  assert.match(due({ drafts: cross }).why, /annoyed/);
  assert.match(due({ events: [{ type: "ghl_call_queued", at: new Date(NOW - 3600000).toISOString() }] }).why, /queued in GHL today/);
  assert.equal(due({ events: [{ type: "ghl_call_queued", at: ago(2) }] }).due, true, "a call two days ago isn't today");
  assert.match(due({ tags: ["dnc"] }).why, /tagged/);
});

test("the number it may say is never above what we sent: a lower number we texted since wins", () => {
  const o = offer();
  assert.equal(secondLookNumber({ offer: o, transcript: "" }), 380000);
  const thread = "[2026-09-20 18:00] US Matt: On 1418 Alder we could come down to 372k if that helps\n";
  assert.equal(secondLookNumber({ offer: o, transcript: thread }), 372000);
  // A re-underwrite after the send moved the book up: what they saw stands.
  const raised = offer({ cashAmount: 395000, revisions: [{ ts: ago(20), from: 380000, to: 395000 }] });
  assert.equal(secondLookNumber({ offer: raised, transcript: "" }), 380000);
});
