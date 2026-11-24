// What went wrong (the 2026-11-23 buyer audit): buyers were lost on the
// bot's promises and wrong answers. Fixtures are invented.
import test from "node:test";
import assert from "node:assert/strict";
import {
  offersPackage, undeliverablePromise, statusLine, repeatsStatus, saysTextOnly, factsAsked, factOnFile, walkAsk,
  buyerReplyFlags, dealRowFor, SITUATION_FLAG_RX,
} from "./buyer-reply.js";
import * as BR from "./buyer-reply.js";

const NOW = Date.parse("2026-11-20T18:00:00Z");
const DEAL = {
  address: "1234 Example Ave N, Seattle, WA 98103", stage: "under_contract", packageReady: true, walkOnFile: false,
  size: { beds: 3, baths: 2, sqft: 1440, year: 1952, lotSqft: 5000, zoning: "" }, facts: ["public sewer", "no garage"], occupancy: "",
};

test("a reply that says it's pulling the package together is read as offering the package", () => {
  for (const r of ["Pulling the package together now, give me a few.", "Here are the photos:", "Want the package on it?",
    "I'll send over the comps.", "Photos coming your way shortly.", "Can text you the scope of work."]) {
    assert.ok(offersPackage(r), r);
  }
  for (const r of ["The comps support about 650.", "Thanks, glad the photos helped.", "It's a 3 bed on a 5,000 sqft lot."]) {
    assert.equal(offersPackage(r), null, r);
  }
});

test("a promise of a comp breakdown, a bid or an answer from the park is one the app can't keep", () => {
  for (const r of ["I'll put together a breakdown of the comps for you.", "Let me check with the park and get back to you.",
    "I'll confirm with the listing agent on the alley.", "Still waiting to hear back from the seller on that.",
    "Let me find out and circle back.", "I'll email you the line-item bid tonight.", "Happy to text them directly, what's their number?"]) {
    assert.ok(undeliverablePromise(r), r);
  }
  for (const r of ["Here's the package, the scope is in there.", "It's on public sewer.", "Price is 410k, ARV around 600k.",
    "Your partner is welcome to take a look too."]) {
    assert.equal(undeliverablePromise(r), null, r);
  }
});

test("the same still-waiting line said twice in two weeks is caught, once is not", () => {
  assert.equal(statusLine("Still waiting on the park, will let you know."), true);
  assert.equal(statusLine("It's a 3 bed."), false);
  const prior = [{ text: "Still waiting on the park on that one.", at: "2026-11-19T17:00:00Z" }];
  assert.ok(repeatsStatus("Still waiting on the park, sorry.", prior, { now: NOW }));
  assert.equal(repeatsStatus("Still waiting on the park, sorry.", [], { now: NOW }), null);
  assert.equal(repeatsStatus("Still waiting on the park.", [{ text: "Still waiting on the park.", at: "2026-10-01T00:00:00Z" }], { now: NOW }), null, "a month ago is a new wait");
});

test("a reply that tells a buyer deals only go out by text is caught", () => {
  for (const r of ["Got the email, but these go out by text.", "We only send deals by text.", "Deals go out via text only."]) {
    assert.equal(saysTextOnly(r), true, r);
  }
  for (const r of ["I'll text you the next one.", "Texting is easiest for me, email works too."]) assert.equal(saysTextOnly(r), false, r);
});

test("their literal question is read, and only answered when the deal record has it", () => {
  assert.deepEqual(factsAsked("What's the address? And how big is the lot?").map((f) => f.key), ["address", "lot"]);
  assert.deepEqual(factsAsked("Is there alley access?").map((f) => f.key), ["alley"]);
  assert.deepEqual(factsAsked("Love the area. Send it over.").map((f) => f.key), [], "not a question");
  assert.equal(factOnFile("address", DEAL), true);
  assert.equal(factOnFile("beds", DEAL), true);
  assert.equal(factOnFile("alley", DEAL), false);
  assert.equal(factOnFile("basement", DEAL), false);
  assert.equal(factOnFile("garage", DEAL), true, "no garage is an answer");
  assert.equal(factOnFile("available", DEAL), true);
});

test("when can I see it is read as a walk ask", () => {
  for (const r of ["When can I see it?", "Can we get inside this week?", "How do we get in?", "Could walk it Saturday", "Any showings?"]) {
    assert.equal(walkAsk(r), true, r);
  }
  for (const r of ["Saw it on the map, nice street.", "What's the ARV?"]) assert.equal(walkAsk(r), false, r);
});

test("a buyer who asked about the alley gets a held reply when the deal never said, not a package link", () => {
  const flags = buyerReplyFlags({ reply: "Here's the package, everything's in there.", inbound: "Is there alley access?", deal: DEAL, now: NOW });
  assert.equal(flags.length, 1, flags.join(" | "));
  assert.match(flags[0], /alley access on 1234 Example Ave N and the deal record doesn't have it/);
  assert.match(flags[0], SITUATION_FLAG_RX);
  // The record has the beds: the answer goes.
  assert.deepEqual(buyerReplyFlags({ reply: "3 bed 2 bath, 1,440 sqft.", inbound: "How many beds?", deal: DEAL, now: NOW }), []);
});

test("a promise of photos on a deal with no package built is held, and one with a package is not", () => {
  const none = buyerReplyFlags({ reply: "I'll send photos over shortly.", inbound: "photos?", deal: { ...DEAL, packageReady: false }, now: NOW });
  assert.match(none.join(" | "), /no package built/);
  assert.deepEqual(buyerReplyFlags({ reply: "Here are the photos.", inbound: "photos?", deal: DEAL, now: NOW }), []);
});

test("photos Matt sent by hand an hour ago are not sent again by the bot", () => {
  const flags = buyerReplyFlags({ reply: "Pulling those photos together now.", inbound: "thanks, what's the ARV?", deal: DEAL, mattSent: { minutesAgo: 55 }, now: NOW });
  assert.match(flags.join(" | "), /you sent them photos or a link 55 minutes ago/);
});

test("when can I see it with no window or access on the deal waits for Matt, and with one it doesn't", () => {
  const flags = buyerReplyFlags({ reply: "I'll line it up with the agent.", inbound: "When can I see it?", deal: DEAL, now: NOW });
  assert.match(flags.join(" | "), /no walkthrough window or access is on the deal/);
  assert.deepEqual(buyerReplyFlags({ reply: "Walkthrough is Sat 10-12, can you make it?", inbound: "When can I see it?", deal: { ...DEAL, walkOnFile: true }, now: NOW }), []);
});

test("the deal a reply is about is the house it names, else the only one they're on", () => {
  const other = { ...DEAL, address: "88 Sample St, Tacoma, WA 98405" };
  assert.equal(dealRowFor({ linked: [DEAL, other] }, "88 Sample St").address, other.address);
  assert.equal(dealRowFor({ linked: [DEAL, other] }, ""), null);
  assert.equal(dealRowFor({ linked: [DEAL] }, "").address, DEAL.address);
});

test("a buyer who names a partner or their acquisitions person to get deals is read, with their email", () => {
  const { buyerReferral } = BR;
  assert.deepEqual(buyerReferral("Send it to my partner Jo too, jo@example.com"), { name: "Jo", relation: "partner", email: "jo@example.com", phone: "" });
  assert.equal(buyerReferral("Can you add my acquisitions manager to the list? 555-555-0101").relation, "acquisitions manager");
  assert.equal(buyerReferral("My wife and I are looking at it this weekend"), null, "no ask to send them anything");
  assert.equal(buyerReferral("I'll run it by my partner"), null, "checking with a partner is not adding one");
});
