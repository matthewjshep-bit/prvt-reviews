// partner-terms.test.mjs — an agent offering to work together on terms is
// Matt's to answer, never the bot's "keep me in mind".

import test from "node:test";
import assert from "node:assert/strict";
import { partnerTerms, partnerTermsLine, answersItself, PARTNER_TERMS_KINDS, PARTNER_TERMS_LABEL } from "./partner-terms.js";

const kindOf = (text) => partnerTerms(text)?.kind || null;

test("an agent asking if we do list-backs is a list-back offer", () => {
  for (const said of [
    "Do you do list backs? I'm an agent, let's chat more tomorrow",
    "Do you honor list backs when the project is completed?",
    "Just need to know if you honor list-backs so we don't waste each other's time",
    "When I find a great one I send it to a short list of clients that always list back with me.",
    "Seller owes about 230 and wants 265. I'd help you with a DADU and list it after you're done",
    "Are you fine with 2.5% on the relist?",
    "fyi when I find stuff for flippers I expect to relist the property once flipped",
    "You'll need to sign a NCND including relist agreement",
    "If you have any wholesale deals you're taking to market, I'd love to help you list it!",
    "Also confirm it's OK that I list it for you guys when you're done fixing it",
    "Are you using one agent or several for resale?",
  ]) assert.equal(kindOf(said), "list_back", said);
});

test("an agent offering to be our buyer's agent is a buyer-agent offer", () => {
  for (const said of [
    "I can represent you as your buyer's agent",
    "I'll act as your buyer's agent and keep an eye out",
    "Let me know if you wanna write an offer. I could definitely represent you.",
    "For me to represent you I would need a buyer agency agreement signed and a consultation first",
    "I'll need to send you a buyer brokerage agreement, I usually make those property specific",
    "I have a fixer but can't give the address until a buyer broker form for this home is signed",
    "Are you wanting our team to represent you with this offer?",
    "So if it's not my listing, would I be considered your buyers agent?",
    "I'd suggest writing it up on NWMLS forms with me representing you.",
    "I will be representing you?",
  ]) assert.equal(kindOf(said), "buyer_agent", said);
});

test("an agent asking about a referral, finder's or buyer broker fee is a fee question", () => {
  for (const said of [
    "How do you handle referrals? Do you pay a finder's fee?",
    "If it's not this property, what are your referral fees like?",
    "So I know for future reference, would a buyer broker fee be requested?",
    "Would you guys be waiving buyer broker commission?",
    "Is there a buyers agent commission or are you working without a realtor?",
    "If you bump your price to pay a 1.5% finders fee that should do it",
    "I have contractors that want these deals. I'm looking for referrals as well.",
    "They are offering 2%. Are you willing to do 3% commission on your end for me also?",
    "Would my client need to provide a commission for your agent?",
    "Did u hear back about my commission?",
  ]) assert.equal(kindOf(said), "referral_fee", said);
});

test("a wholesaler or a deal list offering to work deals together is co-wholesale", () => {
  for (const said of [
    "This is a wholesale deal, so daisy chaining won't work. That said, I'm happy to work together on a different deal!",
    "If you could ping Tyler, my dispo partner, he can get you the details",
    "One of my wholesale partners that shares commissions with me is also looking for you.",
    "I run a deal community out here, let's grab a beer",
    "I'm a wholesaler myself so I understand.",
    "Open to a JV on the next one?",
  ]) assert.equal(kindOf(said), "co_wholesale", said);
});

test("someone who says they buy or pays assignment fees is an investor buyer", () => {
  for (const said of [
    "Do you have anything you got offered that didn't work for you? I can pay a 10k assignment if the deal pencils out",
    "We buy 2 to 10 per month, usually 60 on the dollar",
    "Would they be open to a partnership? I've been wanting to take on a flip. Got a couple hard money lenders",
    "I also flip houses, send me anything that doesn't fit you",
  ]) assert.equal(kindOf(said), "investor_buyer", said);
});

test("a plain 'I'll keep you in mind' raises nothing", () => {
  for (const said of [
    "I'll keep you in mind!", "Thanks, will keep you on the list", "Not at this time, but I'll reach out if something comes up",
    "Let's try to work together in the future.", "Maybe we can jump on a call and see",
    // Not an offer of terms: what they won't do, or what the seller won't.
    "We can't represent you unfortunately. I assume you have an agent",
    "I can write up the offer, but I don't want to represent you.",
    "I represent the sellers and need to be sure they aren't taken advantage of.",
    "This is not a wholesale deal. Bring me a serious offer.",
    "He does not want to get into contract with a wholesaler again",
    "I have enough wholesalers in my database",
    "Are you a cash buyer or a wholesaler?",
    // The paperwork question every listing agent asks is the bot's to answer.
    "Are you being represented by an agent?", "Who are you represented with as a buyers agent?",
    // A commission as a fact of the deal, not a question to us.
    "The seller is ready to move forward at 410k with no buyer agent commission.",
    "I'd say remove the buyers agent compensation and add it to the price",
    "I will write up the MLS forms, but not be representing you on the sale.",
    "An agent representing you as a buyer should give you unbiased information",
    "Have you or anyone representing you toured all three units?",
    // Relisting a house is not a list-back.
    "Relisting today at 568k", "I think the seller is going to relist with someone else soon",
    "the estate attorney gave me the green light to relist it this week",
    // An auto-reply menu and a polite closing are not a referral question.
    "Thank you for contacting the Care Desk. Press 2 for Commercial or Referral",
    "I'm winding down and only working with past clients and referrals.",
    "My partner is touring on Sunday", "the zillow link utm_medium=referral&utm_source=txtshare",
    "", null,
  ]) assert.equal(partnerTerms(said), null, String(said));
});

test("our own words quoted in a reaction are not theirs", () => {
  assert.equal(partnerTerms("Liked “Yes, you get the list back if you bring the deal. Always want agents to get paid.”"), null);
  assert.equal(partnerTerms("​👍​ to “ Good question. Let me check with my partner on how we handle referrals ”"), null);
  assert.equal(partnerTerms("Reacted 💪🏽 to “keep those referrals coming”"), null);
  assert.equal(kindOf("Liked “sounds good” — also, do you do list backs?"), "list_back", "their own words beside the reaction still count");
});

test("the phrase is theirs, short, with no phone or email in it", () => {
  const r = partnerTerms("Hi Matt. Do you do list backs? Call me at (206) 555-0100 or pat@example.com, I have a few coming up in Kent this month and more after that for sure");
  assert.equal(r.kind, "list_back");
  assert.ok(r.phrase.length <= 120, r.phrase);
  assert.match(r.phrase, /list backs/i);
  assert.doesNotMatch(r.phrase, /555|@|example/);
  // Every kind it heard, the strongest first; "they buy" rides along.
  const both = partnerTerms("We buy 2 to 10 a month. Do you have an agent listing back with you?");
  assert.equal(both.kind, "list_back");
  assert.deepEqual(both.kinds, ["list_back", "investor_buyer"]);
  assert.equal(both.addToBuyers, true);
});

test("every kind has a label and a line for the draft", () => {
  for (const k of PARTNER_TERMS_KINDS) {
    assert.ok(PARTNER_TERMS_LABEL[k], k);
    // An offer to represent us is a yes the bot gives (2026-11-04); the rest name the brush-off they replace.
    if (k === "buyer_agent") assert.match(partnerTermsLine({ kind: k, phrase: "x" }), /Say yes/);
    else assert.match(partnerTermsLine({ kind: k, phrase: "x" }), /keep me in mind/i, "the rule names the brush-off it replaces");
  }
  assert.equal(partnerTermsLine(null), "");
});

// 2026-10-15 (agents work for us): an agent who'd be our agent on the buy is
// a buyer-agent offer, however it's put — since 2026-11-04 the bot says yes to it.
test("an agent offering to be our agent, or needing a buyer agreement, is a buyer-agent offer", () => {
  for (const said of [
    "I'd want to represent you on this one",
    "I would love to be your agent on this one",
    "Happy to be your agent if you want to write it",
    "You'd have to sign a buyer's agreement with me first",
    "We need a buyer rep agreement before I send the address",
    "I can work as your buyers agent",
    "Can I be your agent?",
    "Let me be your agent on the buy",
  ]) assert.equal(kindOf(said), "buyer_agent", said);
  for (const said of ["I can't be your agent on my own listing", "Who is your agent?", "Do you have an agent?", "Your agent should send it over", "The buyer agreed to the price",
    "Who will be your agent on this?", "Is anyone going to be your agent?"]) {
    assert.notEqual(kindOf(said), "buyer_agent", said);
  }
});

// Matt, 2026-11-04: an offer to represent us is answered yes by the bot; a
// fee, a commission, a list-back or a deal list beside it is still his.
test("an offer to represent us answers itself; one with money or other terms beside it doesn't", () => {
  assert.equal(answersItself(partnerTerms("I can represent you as your buyer's agent")), true);
  assert.equal(answersItself(partnerTerms("As a co-signer, I represent you")), true);
  assert.equal(answersItself(partnerTerms("Happy to be your buyer's agent. Would you be paying my buyer agent commission?")), false);
  assert.equal(answersItself(partnerTerms("I'll represent you, and do you do list backs?")), false);
  assert.equal(answersItself(partnerTerms("Do you do list backs?")), false);
  assert.equal(answersItself(null), false);
  const line = partnerTermsLine(partnerTerms("I can be your buyer's agent on this one"));
  assert.match(line, /^BUYER'S AGENT: they offered to represent us/);
  assert.match(line, /say yes/i);
  assert.doesNotMatch(line, /A person reads this one before it goes/);
});

/* ---------- the forms an Oregon house is written on ---------- */

// The Bend market (2026-10-21): an Oregon house is written up on OREF forms.
// The 2026-11-09 audit: an agent in Bend who offered to represent us was told
// NWMLS, and the rule promised the compensation answer "today".
test("a Bend agent who offers to represent us hears OREF forms", async () => {
  const { BUYER_AGENT_RULE, formsFlags, formsStateOf } = await import("./partner-terms.js");
  assert.match(BUYER_AGENT_RULE, /NWMLS forms \(OREF forms for an Oregon house\)/);
  assert.doesNotMatch(BUYER_AGENT_RULE, /\btoday\b/, "no time promised on the compensation");
  assert.match(partnerTermsLine(partnerTerms("I can be your buyer's agent on this one")), /NWMLS forms \(OREF forms for an Oregon house\)/);
  // A reply about an Oregon house that says NWMLS holds; OREF, or a Washington house, doesn't.
  const nwmls = "Yes, please represent us. Write it up on NWMLS forms for our signature.";
  assert.equal(formsFlags(nwmls, { state: "OR" }).length, 1);
  assert.match(formsFlags(nwmls, { state: "OR" })[0], /OREF/);
  assert.deepEqual(formsFlags(nwmls.replace("NWMLS", "OREF"), { state: "OR" }), []);
  assert.deepEqual(formsFlags(nwmls, { state: "WA" }), []);
  assert.deepEqual(formsFlags(nwmls, { state: "" }), []);
  // Where the house is: the address's state, else a Bend-area town, else the next address.
  assert.equal(formsStateOf("61 NW Juniper Ln, Bend, OR 97703"), "OR");
  assert.equal(formsStateOf("61 NW Juniper Ln, Bend"), "OR");
  assert.equal(formsStateOf("61 NW Juniper Ln", "61 NW Juniper Ln, Bend, OR 97703"), "OR");
  assert.equal(formsStateOf("12 Elm St, Redmond, WA 98052"), "WA");
  assert.equal(formsStateOf("12 Elm St, Redmond"), "", "Redmond is a Washington town too");
  assert.equal(formsStateOf(""), "");
});

/* ---------- are you a wholesaler? ---------- */

// The 2026-11-09 audit: three agents who asked whether we wholesale or
// assign were told "we close ourselves, no assignments" or "we do the flips
// ourselves". How we buy is Matt's to answer.
test("an agent asking if we wholesale or assign is heard, and plain talk about the house isn't", async () => {
  const { asksIfWholesaler } = await import("./partner-terms.js");
  for (const said of [
    "So are you guys wholesalers?",
    "Just so you know, my seller won't work with wholesalers.",
    "Do you assign your contracts?",
    "Is this going to be an assignment?",
    "Do you close yourselves or flip the contract?",
    "Are you the end buyer?",
    "We don't work with wholesalers, sorry",
    "Is the contract assignable?",
  ]) assert.ok(asksIfWholesaler(said), said);
  for (const said of [
    "Seller needs 450 on it",
    "Buyer is Matthew Shepherd and/or assigns, right?",
    "I was assigned this listing last week",
    "It needs a roof and the kitchen is original",
    "",
  ]) assert.equal(asksIfWholesaler(said), null, said);
});

test("a reply that denies we wholesale or assign is caught", async () => {
  const { deniesWholesaling, wholesaleFlags } = await import("./partner-terms.js");
  for (const said of [
    "We close ourselves, no assignments.",
    "We're not wholesalers, we do the flips ourselves.",
    "No assignment, we buy direct with our own cash.",
    "We don't assign contracts.",
    "I'm the end buyer on this one.",
  ]) assert.ok(deniesWholesaling(said), said);
  for (const said of ["Happy to go over how we'd buy it on a quick call.", "Buyer is Matthew Shepherd and/or assigns.", "We close in about three weeks."]) {
    assert.equal(deniesWholesaling(said), "", said);
  }
  assert.deepEqual(wholesaleFlags({ reply: "Sounds good.", party: "agent" }), []);
  assert.match(wholesaleFlags({ reply: "Sounds good.", party: "agent", asked: { phrase: "are you a wholesaler?" } }).join(" "), /they asked if we wholesale: your answer/);
  assert.match(wholesaleFlags({ reply: "We close ourselves, no assignments.", party: "agent" }).join(" "), /we close ourselves/i);
  assert.deepEqual(wholesaleFlags({ reply: "We close ourselves, no assignments.", party: "investor" }), [], "only an agent's reply");
});

test("the wholesale question leaves Matt's answer to him and promises no call for him", async () => {
  const { wholesaleAskLine } = await import("./partner-terms.js");
  const line = wholesaleAskLine({ phrase: "are you guys wholesalers?" });
  assert.match(line, /^WHOLESALE QUESTION:/);
  assert.match(line, /never say we close ourselves/);
  assert.match(line, /don't promise a call/);
  assert.doesNotMatch(line, /say you'll[^.]*call/i);
  assert.equal(wholesaleAskLine(null), "");
});
