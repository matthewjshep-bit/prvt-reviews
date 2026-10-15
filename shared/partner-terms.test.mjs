// partner-terms.test.mjs — an agent offering to work together on terms is
// Matt's to answer, never the bot's "keep me in mind".

import test from "node:test";
import assert from "node:assert/strict";
import { partnerTerms, partnerTermsLine, PARTNER_TERMS_KINDS, PARTNER_TERMS_LABEL } from "./partner-terms.js";

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
    assert.match(partnerTermsLine({ kind: k, phrase: "x" }), /keep me in mind/i, "the rule names the brush-off it replaces");
  }
  assert.equal(partnerTermsLine(null), "");
});
