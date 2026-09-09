// deal-feedback.test.mjs — the buyer-feedback package. Fixtures are in the
// exact format enrich.js writes a thread in, because parsing that format is
// most of what can go wrong here.

import test from "node:test";
import assert from "node:assert/strict";
import * as pkg_mod from "./deal-feedback.js";
import { buildFeedbackPackage, parseThread, excerptTranscript, renderFeedbackHtml } from "./deal-feedback.js";

const OFFER = {
  id: "o1", address: "22018 76th Avenue West, Edmonds, Washington 98026", contactName: "Catrina Shaw", contactId: "ag1",
  cashAmount: 485721, arv: 700000, repairs: 30000, statusAt: "2026-09-04T15:59:00.000Z",
  deal: { stage: "under_contract", createdAt: "2026-09-04T15:59:00.000Z", contractPrice: 480000, assignmentFee: 9000, investors: [] },
};
const PITCH = "[2026-09-07 20:44] US sms: Hi Rick, have a property under contract in Edmonds.\n\n22018 76th Avenue W, Edmonds, WA\n$489,000 Purchase Price.\n$30K Rehab\nComps support ~$700K ARV.";
const buyer = (over = {}) => ({ contactId: "b1", name: "Richard Romatowski", status: "passed", addedAt: "2026-09-08T00:00:00Z", thread: PITCH, ...over });

test("a thread parses into dated lines with call transcripts attached to their call", () => {
  const t = parseThread("[2026-09-08 20:55] THEM call TRANSCRIPT:\nSpeaker 1: Hey Matt.\nSpeaker 2: Hey Derek.\n[2026-09-08 21:00] US sms: nice chatting");
  assert.equal(t.length, 2);
  assert.equal(t[0].channel, "call");
  assert.deepEqual(t[0].transcript.map((l) => l.speaker), ["1", "2"]);
  assert.equal(t[1].body, "nice chatting");
});

test("a buyer's pass in their own words is quoted under the reason they gave", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [buyer({
    thread: PITCH + "\n[2026-09-09 00:41] THEM sms: You're being aggressive on the resale price of this one, so I'll pass.",
    reason: { code: "price", note: "aggressive ARV" },
  })] });
  assert.equal(pkg.funnel.replied, 1);
  assert.equal(pkg.funnel.passed, 1);
  assert.equal(pkg.objections[0].code, "price");
  assert.match(pkg.objections[0].buyers[0].quote, /aggressive on the resale price/);
  assert.equal(pkg.aboutTheNumbers.length, 1, "price is an objection about the house");
});

test("timing and area passes are kept apart from passes about the numbers", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [
    buyer({ contactId: "a", thread: PITCH + "\n[2026-09-08 03:57] THEM sms: Thanks not ready yet for another one.", reason: { code: "timing", note: "" } }),
    buyer({ contactId: "b", thread: PITCH + "\n[2026-09-09 00:08] THEM sms: 30k rehab 🤣", reason: { code: "rehab_scope", note: "" } }),
  ] });
  assert.deepEqual(pkg.aboutTheNumbers.map((o) => o.code), ["rehab_scope"]);
  assert.deepEqual(pkg.aboutTheBuyer.map((o) => o.code), ["timing"]);
});

test("a number a buyer said they would do is picked out", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [buyer({
    thread: PITCH + "\n[2026-09-08 17:22] THEM sms: If there's any way you can get me closer to $470k-$475k I think I'd feel a lot better.",
    reason: { code: "price", note: "asked for 470k-475k" },
  })] });
  assert.equal(pkg.askedFor[0].amount, 470000);
});

test("a message reaction is not a reply", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [buyer({ status: "evaluating", thread: PITCH + "\n[2026-09-07 20:50] THEM sms: Loved “Hi Rick, have a property”" })] });
  assert.equal(pkg.funnel.replied, 0);
});

test("only the part of a call that touches the property is excerpted, and a voicemail greeting is nothing", () => {
  const lines = [
    { speaker: "1", text: "Your call has been forwarded to voicemail. At the tone, please record your message." },
  ];
  assert.deepEqual(excerptTranscript(lines, ["edmonds"]), []);
  const call = [
    { speaker: "1", text: "How are you doing today?" },
    { speaker: "2", text: "Good. What's going on?" },
    { speaker: "1", text: "The Edmonds project we're gonna have to pass on because it's a little too far from my guys." },
    { speaker: "2", text: "No worries." },
    { speaker: "1", text: "Anyway how about the Seahawks." },
  ];
  const ex = excerptTranscript(call, ["edmonds", "too far"]);
  assert.deepEqual(ex.map((l) => l.text.slice(0, 12)), ["Good. What's", "The Edmonds ", "No worries."]);
});

test("a call about the property lands on the buyer's row", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [buyer({
    thread: PITCH + "\n[2026-09-08 20:55] THEM call TRANSCRIPT:\nSpeaker 1: The Edmonds project I think we're gonna have to pass on, too far from my guys.\nSpeaker 2: No worries.\n[2026-09-08 21:00] THEM sms: thanks",
  })] });
  assert.equal(pkg.buyers[0].calls.length, 1);
  assert.match(pkg.buyers[0].calls[0].lines[0].text, /too far/);
});

test("what buyers were told comes from the pitch, not from our contract", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [], options: { pitch: { price: 489000, rehab: 30000, arv: 700000 } } });
  assert.equal(pkg.pitch.price, 489000);
  // and without a pitch, the buyer-facing number is what a buyer would pay
  const p2 = buildFeedbackPackage({ offer: OFFER, buyers: [] });
  assert.equal(p2.pitch.price, 489000);
});

test("the agent-facing page shortens buyer names and never prints our fee", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [buyer({ thread: PITCH + "\n[2026-09-09 00:41] THEM sms: I'll pass.", reason: { code: "price" } })] });
  const html = renderFeedbackHtml(pkg, { from: "Matt" });
  assert.match(html, /Richard R\./);
  assert.doesNotMatch(html, /Romatowski/);
  assert.doesNotMatch(html, /\$9,000\b/);
  assert.doesNotMatch(html, /480,000/, "the contract price is the agent's to know, not this page's to print");
  assert.doesNotMatch(html, /489,000/, "the buyer-facing price is our fee by subtraction");
  assert.match(html, /<title>22018 76th Avenue West — What buyers said<\/title>/);
});

test("full names and the wrapped document are opt-in", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [buyer()] });
  assert.match(renderFeedbackHtml(pkg, { fullNames: true }), /Romatowski/);
  assert.match(renderFeedbackHtml(pkg, { wrap: true }), /^<!doctype html>/);
  assert.doesNotMatch(renderFeedbackHtml(pkg), /<!doctype/);
});

test("package opens are drawn to their own scale", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [], room: { shareViews: 311, uniqueVisitors: 77, downloads: 3, viewsByDay: [{ date: "2026-09-07", count: 4 }, { date: "2026-09-08", count: 79 }], lastViewedAt: "2026-09-09T15:38:00Z" } });
  const html = renderFeedbackHtml(pkg);
  assert.match(html, /311 opens/);
  assert.match(html, /height:100%/);
  assert.match(html, /height:5%/);
});

test("a pass with no coded reason is read off the buyer's words", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [
    buyer({ contactId: "m", thread: PITCH + "\n[2026-09-08 17:22] THEM sms: I like the Edmonds one, I'm just trying to stay disciplined. At $485k it's a little tighter than I'd like. If there's any way you can get me closer to $470k-$475k I'd feel better." }),
    buyer({ contactId: "d", thread: PITCH + "\n[2026-09-08 20:55] THEM call TRANSCRIPT:\nSpeaker 1: The Edmonds project we're gonna have to pass on, a little too far from my guys." }),
    buyer({ contactId: "v", thread: PITCH + "\n[2026-09-08 04:11] THEM sms: Not interested" }),
  ] });
  const code = (id) => pkg.buyers.find((b) => b.contactId === id).reason.code;
  assert.equal(code("m"), "price");
  assert.equal(code("d"), "area");
  assert.equal(code("v"), "other", "a bare no stays uncoded rather than guessed");
  assert.deepEqual(pkg.askedFor.map((a) => a.amount), [470000]);
});

test("a line that ends in a carriage return still parses", () => {
  const t = parseThread("[2026-09-07 20:44] US sms: Hi Erik, have a property in Edmonds.\r\n$489,000\r\n[2026-09-07 21:05] THEM sms: Yes\r\n");
  assert.equal(t.length, 2);
  assert.equal(t[1].body, "Yes");
  assert.match(t[0].body, /489,000/);
});

test("a buyer who passed for distance and then talked about another house's rehab passed for distance", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [buyer({ contactId: "d", thread: PITCH +
    "\n[2026-09-08 20:55] THEM call TRANSCRIPT:\nSpeaker 1: The Edmonds project we're gonna have to pass on because it's a little too far from my guys.\nSpeaker 2: No worries. I have one in Issaquah.\nSpeaker 1: Oh the rehab portion of it is not a big deal." })] });
  const d = pkg.buyers[0];
  assert.equal(d.reason.code, "area");
  const g = pkg.objections.find((o) => o.code === "area");
  assert.match(g.buyers[0].quote, /too far from my guys/);
  assert.equal(g.buyers[0].fromCall, true);
});

test("a quote is trimmed to the sentences about this house", () => {
  const { trimToDeal } = pkg_mod;
  const t = trimToDeal("Thanks Matt, I'll take a look at this one. I think this may work for a partner, I'm not getting into that market. I'm also going to pass on Edmonds. I saw it on the market and it needs way over $30k.", ["edmonds"]);
  assert.equal(t, "I'm also going to pass on Edmonds. I saw it on the market and it needs way over $30k.");
  assert.equal(trimToDeal("Yes", ["edmonds"]), "Yes");
});

test("a buyer repeating our price back is redacted, but the number they would do is kept", () => {
  const pkg = buildFeedbackPackage({ offer: OFFER, buyers: [buyer({
    thread: PITCH + "\n[2026-09-08 17:22] THEM sms: I like the Edmonds one. At $485k it's tighter than I'd like, closer to $470k would work."
      + "\n[2026-09-08 20:17] THEM call TRANSCRIPT:\nSpeaker 1: It was the 489,000 purchase price in Edmonds, right?",
    reason: { code: "price" },
  })], options: { pitch: { price: 489000 } } });
  const html = renderFeedbackHtml(pkg);
  assert.doesNotMatch(html, /485k/);
  assert.doesNotMatch(html, /489,000/);
  assert.match(html, /\[our price\]/);
  assert.match(html, /\$470,000/);
  assert.match(html, /470k would work/);
  const open = renderFeedbackHtml(pkg, { showPrice: true });
  assert.match(open, /489,000/);
});
