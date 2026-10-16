// carrier-filtered.test.mjs — texts the phone carriers blocked (2026-10-02).
//
// Matt's screenshot: "Jeff, noticed your listing at 1515 Lombard Ave has been
// sitting a while. I'm a local investor buying houses as-is, no repairs
// needed. Would the seller consider a cash offer?" — Error 30007, blocked by
// carrier policy. Fourteen days of our own texts: the check-ins and openers
// that pitched "as-is cash offer / I buy houses" were blocked 53% of the time
// cold, deal texts with a link 32% cold, and everything else 0.6%. The
// workflow's own opener, a plain question about the listing, 0.1%.

import test from "node:test";
import assert from "node:assert/strict";
import { outboundOpening } from "./conversation-prompt.js";
import { evaluateReplyGates, CARRIER_CHECKED_KINDS, writeAgainWithoutCarrierWords } from "./reply-agent.js";
import { blastMessage } from "./shared/blast-text.js";

const PITCH = /cash offer|as-is cash|buy(s|ing)? houses|no repairs|quick close|local investor|wholesal/i;

test("the listing check-in no longer asks for an as-is cash offer — Jeff's 1515 Lombard Ave text was blocked by the carrier", () => {
  const cold = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "cold", listing: { street: "1515 Lombard Ave", city: "Everett", dom: 80 } });
  assert.match(cold, /1515 Lombard Ave in Everett/);
  assert.doesNotMatch(cold.replace(/never write[^.]*\./i, ""), PITCH, "no pitch in what the bot is asked to say");
  assert.match(cold, /phone carriers block/i);
  const known = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "engaged", listing: { street: "1515 Lombard Ave" } });
  assert.doesNotMatch(known.replace(/never write[^.]*\./i, ""), PITCH);
});

test("the first text and its nudge to a new agent don't pitch cash either", () => {
  for (const kind of ["outreach_open", "outreach_nudge"]) {
    const t = outboundOpening({ kind, address: "12 Elm St, Tacoma, WA", hookDom: 60 });
    assert.doesNotMatch(t.replace(/never write[^.]*\./i, ""), PITCH, kind);
    assert.match(t, /phone carriers block/i, kind);
  }
});

test("the buyer check-in says who we are without 'investor' or 'wholesale'", () => {
  const t = outboundOpening({ kind: "buyer_pulse", conversed: false, dealsSent: 2, variant: 0 });
  assert.doesNotMatch(t.replace(/never write[^.]*\./i, ""), /wholesal|investor who/i);
  assert.match(t, /phone carriers block/i);
});

test("a check-in that still pitches is held by the gate", () => {
  const draft = { intent: "agent_pulse", confidence: "high", needsHuman: false,
    reply: "Jeff, noticed 1515 Lombard Ave has been sitting a while. I'm a local investor buying houses as-is. Would the seller consider a cash offer?" };
  const g = evaluateReplyGates({ draft, party: "agent", carrierCheck: true });
  assert.equal(g.ok, false);
  assert.ok(g.flags.some((f) => /carriers block/.test(f)), g.flags.join(" · "));
  assert.equal(evaluateReplyGates({ draft, party: "agent" }).flags.some((f) => /carriers block/.test(f)), false, "only where asked: a float to an agent we're talking to is fine");
  assert.deepEqual([...CARRIER_CHECKED_KINDS].sort(), ["agent_pulse", "blast_nudge", "buyer_pulse", "dataroom_nudge", "deal_followup", "outreach_nudge", "outreach_open", "second_look", "showing_followup", "showing_reminder"]);
});

test("a machine text with blocked words is written again without them, once", async () => {
  const asks = [];
  const first = { reply: "Jeff, would the seller at 1515 Lombard Ave consider an as-is cash offer?", summary: "s" };
  const clean = { reply: "Jeff, saw 1515 Lombard Ave is still on the market. Is it a bit of a project?", summary: "s2" };
  const r = await writeAgainWithoutCarrierWords({ draft: first, kind: "agent_pulse", redraft: async (avoid) => { asks.push(avoid); return clean; } });
  assert.deepEqual(asks, [["cash", "as-is"]]);
  assert.equal(r.reply, clean.reply);
  // A rewrite that's no better keeps the first; the gate then holds it.
  const same = await writeAgainWithoutCarrierWords({ draft: first, kind: "agent_pulse", redraft: async () => first });
  assert.equal(same.reply, first.reply);
  // Other kinds, or a clean first draft, never pay for a second call.
  let called = 0;
  await writeAgainWithoutCarrierWords({ draft: first, kind: "realm_check", redraft: async () => { called++; return clean; } });
  await writeAgainWithoutCarrierWords({ draft: clean, kind: "agent_pulse", redraft: async () => { called++; return clean; } });
  assert.equal(called, 0);
});

test("a deal text without its link asks if they want it", () => {
  const facts = { street: "5232 S Yakima Ave", city: "Tacoma", price: 235000, arv: 415000, repairs: 50000, rehab: "heavy", firstName: "Sam" };
  for (const variant of [0, 1, 2]) {
    const t = blastMessage({ ...facts, variant, link: "" });
    assert.doesNotMatch(t, /https?:/);
    assert.match(t, /details\?|Interested\?|package\./);
  }
});

/* ---------- 2026-10-15: deal texts to buyers ---------- */

// October's buyer texts: 74 of 678 blocked (10.9%). The cold deal texts were
// a third of them ("…it's Matt, a local investor… got one under contract…"),
// and the walkthrough invites carrying a price another third; the buyer
// check-ins, which already carried the carrier rule, went through.
test("a deal text to a buyer who never replied carries no word carriers block", async () => {
  const { blastIntro } = await import("./dispo-autopilot.js");
  const { carrierFlags } = await import("./shared/carrier-words.js");
  const facts = { address: "41 Alder Way, Kent, WA 98030", city: "Kent", price: 383000, arv: 520000, repairs: 60000, beds: 3, baths: 2 };
  const strangers = [
    { tags: ["investor", "dispo-source-county", "dispo-city-kent"] },
    { tags: ["investor", "dispo-source-county", "dispo-type-mobile-home", "dispo-city-auburn"] },
    { tags: ["investor", "dispo-source-fb-warei"] },
  ];
  for (const inv of strangers) {
    const intro = blastIntro(inv);
    assert.ok(intro, "a stranger is told how we found them");
    for (const variant of [0, 1, 2]) {
      for (const ask of ["", "Walkthrough is Thu 4–5pm. Can you make it?"]) {
        // The operator's line off the package headline can say it too.
        const t = blastMessage({ ...facts, firstName: "Sam Buyer", variant, intro, ask, linkOnReply: true, note: "Cash only, sold as-is" });
        assert.deepEqual(carrierFlags(t), [], t);
      }
    }
  }
});

test("the deal follow-ups and walkthrough texts to buyers carry the carrier rule and are held if they slip", () => {
  const kinds = ["blast_nudge", "dataroom_nudge", "deal_followup", "showing_reminder", "showing_followup"];
  for (const kind of kinds) {
    assert.ok(CARRIER_CHECKED_KINDS.has(kind), kind);
    const t = outboundOpening({ kind, address: "41 Alder Way, Kent, WA 98030", street: "41 Alder Way", windowLabel: "Thu 4–5pm" });
    assert.match(t, /phone carriers block/i, kind);
  }
  const draft = { intent: "blast_nudge", confidence: "high", needsHuman: false, reply: "Hey Sam, still have 41 Alder Way if you want it. Cash buyers close fast on this one." };
  const g = evaluateReplyGates({ draft, party: "investor", carrierCheck: CARRIER_CHECKED_KINDS.has("blast_nudge") });
  assert.equal(g.ok, false);
  assert.ok(g.flags.some((f) => /carriers block/.test(f)), g.flags.join(" · "));
});

// The "for your records" letter that went live today opened differently from
// the old one, so the thread reader took it for a person answering and the
// bot would stand aside for half an hour.
test("the for-the-record letter reads as the app's own text, not a person answering", async () => {
  const { OUR_OFFER_TEXT_RX } = await import("./reply-agent.js");
  assert.match("Hi Dana, sending our written offer on 9520 187th Street Ct E over so you have it on file — $300,000, close on your timeline (letter attached).", OUR_OFFER_TEXT_RX);
  assert.match("Hi Dana, here's our letter of intent on 12 Elm St — $300,000, close on your timeline (letter attached).", OUR_OFFER_TEXT_RX);
  assert.doesNotMatch("sounds good, I'll send it over", OUR_OFFER_TEXT_RX);
});
