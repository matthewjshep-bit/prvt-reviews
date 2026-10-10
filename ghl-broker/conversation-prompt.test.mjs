import test from "node:test";
import assert from "node:assert/strict";
import { buildUserContext, buildSystemPrompt, outboundOpening } from "./conversation-prompt.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";

/* ---------- our own contact details ---------- */

// An agent asked "Send me email address and I will send some walk thru pics."
// and got "Let me get you the right email to send them to and I'll text it
// over shortly" — twice in two weeks — because the address never reached the
// prompt. It is in Settings; now it is in the context too.
test("our email and phone reach the prompt, marked ask-only", () => {
  const ctx = buildUserContext({
    party: "agent", contact: { name: "Nate Wright" }, signer: "Matt",
    companyContact: { email: "matt@shepflips.com", phone: "4256202863" },
    message: "Send me your email address",
  });
  assert.match(ctx, /HOW THEY REACH YOU/);
  assert.match(ctx, /matt@shepflips\.com/);
  assert.match(ctx, /4256202863/);
  assert.match(ctx, /ONLY when asked/i);
});

test("no contact block when settings hold none", () => {
  const ctx = buildUserContext({ party: "agent", contact: { name: "Nate Wright" }, signer: "Matt", message: "hi" });
  assert.doesNotMatch(ctx, /HOW THEY REACH YOU/);
});

test("the system prompt lets us hand over our own details but nothing else invented", () => {
  const sys = buildSystemPrompt({ config: null, party: "agent", channel: "sms" });
  assert.match(sys, /HOW THEY REACH YOU/);
  assert.match(sys, /Never volunteer them unasked/);
});

/* ---------- seeing the house ---------- */

// Matt walks a property only as a last resort and the agent must never know
// it: an agent who thinks the buyer needs to stand in the house first reads
// every offer as provisional.
test("the agent prompt never offers a walkthrough, and never admits why", () => {
  const sys = buildSystemPrompt({ config: null, party: "agent", channel: "sms" });
  assert.match(sys, /SEEING THE HOUSE/);
  assert.match(sys, /Never offer to come out, walk it, swing by/);
  assert.match(sys, /most of your analysis desktop/);
  assert.match(sys, /in the realm for the seller/);
  assert.match(sys, /Never say or imply that you avoid walking houses/);
});

test("a house we passed on is closed on our side — the bot never chases it or names its number", () => {
  const sys = buildSystemPrompt({ config: null, party: "agent", channel: "sms" });
  assert.match(sys, /WE PASSED:/);
  assert.match(sys, /do not ask whether the seller has moved/);
  assert.match(sys, /set needsHuman/);
});

test("the stance is agent-only — an investor walking OUR deal is the point", () => {
  const sys = buildSystemPrompt({ config: null, party: "investor", channel: "sms" });
  assert.doesNotMatch(sys, /SEEING THE HOUSE/);
});

/* ---------- a no is not the end ---------- */

// Josh Hall, 11239 SE 324th (2026-09-10): "679 arv with 30 in rehab and you
// are offering 400k... That seems aggressive. They are not interested" — and
// the bot answered "Fair enough, won't argue it." An agent calling a number
// aggressive is an opening move, not a closed door.
test("a rejection gets one ask for a counter before it is accepted", () => {
  const sys = buildSystemPrompt({ config: null, party: "agent", channel: "sms" });
  assert.match(sys, /A NO IS NOT THE END/);
  assert.match(sys, /ask once for a counter/);
  assert.match(sys, /what the seller would\s+actually take/);
  // the instruction that produced the fold
  assert.doesNotMatch(sys, /rejection needs no counter-argument/);
});

test("asking for their number never becomes an offer of ours", () => {
  const sys = buildSystemPrompt({ config: null, party: "agent", channel: "sms" });
  assert.match(sys, /do NOT name a new \s*number of ours/);
  assert.match(sys, /do NOT hint that we could go higher/);
  assert.match(sys, /any movement \s*on ours is a person's call/);
  // and the ask is one ask — not a haggle
  assert.match(sys, /Only when they have already turned down that ask/);
});

test("the counter push is agent-side; an investor pushing on price is its own playbook", () => {
  const sys = buildSystemPrompt({ config: null, party: "investor", channel: "sms" });
  assert.doesNotMatch(sys, /A NO IS NOT THE END/);
});

/* ---------- whose name is whose ---------- */

test("the prompt says which name is ours and which is theirs", () => {
  const ctx = buildUserContext({ party: "agent", contact: { name: "Nate Wright" }, signer: "Matt", message: "Hi Matt" });
  assert.match(ctx, /NAMES: "Matt" is YOUR name/);
  assert.match(ctx, /never call them Matt/);
  assert.match(ctx, /Their name is Nate Wright/);
});

test("an agent who really is called Matt gets no confusing note", () => {
  const ctx = buildUserContext({ party: "agent", contact: { name: "Matt Jones" }, signer: "Matt", message: "hi" });
  assert.doesNotMatch(ctx, /NAMES:/);
});

/* ---------- the inspection period, and a thread we never answered ---------- */

// Saundra Mock, 13041 (2026-09-16): "your 12 day inspection contingency is a
// killer... She wants you to preinspect, so obviously the fewer days the
// better." The bot had no policy for either half, so it promised twice to run
// it by a partner and the thread sat two days.
test("the inspection period and the no-pre-inspection rule reach the agent prompt", () => {
  const sys = buildSystemPrompt({ config: null, party: "agent", channel: "sms" });
  assert.match(sys, /THE INSPECTION PERIOD/);
  assert.match(sys, /We write 10 to 14 days and never under 10/);
  assert.match(sys, /never agree to a specific window/);
  assert.match(sys, /PRE-INSPECTION: we do NOT pre-inspect/);
  assert.match(sys, /once we are under contract/);
});

test("an investor is never told any of it — it is an agent's negotiation", () => {
  const sys = buildSystemPrompt({ config: null, party: "investor", channel: "sms" });
  assert.doesNotMatch(sys, /PRE-INSPECTION/);
});

test("the check-in on a thread we never answered apologises for nothing", () => {
  const ours = outboundOpening({ kind: "checkin_due", address: "10412 SE 219th St", sourceKind: "unanswered", phrase: "" });
  assert.match(ours, /never got a reply from us/);
  assert.match(ours, /Do NOT apologise/);
  assert.match(ours, /Set intent to checkin_due/);

  // The two it must not be confused with.
  const asked = outboundOpening({ kind: "checkin_due", address: "10412 SE 219th St", sourceKind: "date", phrase: "next week" });
  assert.match(asked, /told us to check back/);
  const weekly = outboundOpening({ kind: "checkin_due", address: "", sourceKind: "source", phrase: "" });
  assert.match(weekly, /weekly check-in/i);
});

test("a counter nudge asks for room and names no number", () => {
  const t = outboundOpening({ kind: "counter_nudge", address: "3831 Bagley Ave N, Seattle, WA", days: 6, theirsK: "850k" });
  assert.match(t, /countered on 3831 Bagley Ave N.*6 days ago/);
  assert.match(t, /Do NOT name a new number of ours/);
  assert.match(t, /Set intent to counter_nudge/);
});

test("a question Matt already answered is in the prompt, for the right party only", async () => {
  const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
  const config = normalizeConversationAi({ answers: [
    { party: "agent", question: "What's your inspection window?", answer: "Ten days." },
    { party: "investor", question: "Is the fee negotiable?", answer: "Not on this one." },
    { party: "any", question: "Are you local?", answer: "Yes, we're in Seattle." },
  ] });
  const agent = buildSystemPrompt({ config, party: "agent", channel: "sms" });
  assert.match(agent, /ANSWERS THE OWNER HAS ALREADY GIVEN/);
  assert.match(agent, /inspection window\?\s*\n?\s*A: Ten days\./);
  assert.match(agent, /Are you local/);
  assert.doesNotMatch(agent, /fee negotiable/);
  assert.match(agent, /do not say you'll check with a partner/i);
  const none = buildSystemPrompt({ config: normalizeConversationAi({}), party: "agent", channel: "sms" });
  assert.doesNotMatch(none, /ANSWERS THE OWNER/);
});

/* ---------- the terms we always write (Kimberly Pettie, 1510 Maple Lane, 2026-09-18) ---------- */

// "Earnest? Inspection?" got "let me confirm with my partner". The answer is
// the same every time: 1k earnest after inspection, 14 days, Matthew
// Shepherd and/or assigns.
test("the agent prompt carries the write-up terms and says to give them in the same message", () => {
  const sys = buildSystemPrompt({ config: normalizeConversationAi(null), party: "agent", channel: "sms" });
  assert.match(sys, /WRITE-UP TERMS/);
  assert.match(sys, /\$1,000 earnest money/);
  assert.match(sys, /after the inspection period/);
  assert.match(sys, /10 to 14 day inspection/);
  assert.match(sys, /Matthew Shepherd and\/or assigns/);
  assert.match(sys, /in the same message/);
  assert.match(sys, /Commission[^.]*not yours to settle/i);
});

// 10917 48th St E, 2026-09-27: the prompt itself said "close fast, cash,
// with no lender" and "a 10 to 14 day target close", and the bot said both.
test("the agent prompt says we buy with a hard money loan, a 10 to 14 day inspection and roughly 10 to 21 days to close, never cash with no lender", () => {
  const sys = buildSystemPrompt({ config: normalizeConversationAi(null), party: "agent", channel: "sms" });
  assert.match(sys, /hard money loan/);
  assert.match(sys, /10 to 14 day inspection/);
  assert.match(sys, /close in roughly 10 to 21 days from mutual acceptance, inspection included, depending on the lender/);
  assert.doesNotMatch(sys, /cash, with no lender/);
  assert.doesNotMatch(sys, /10 to 14 day target close/);
  assert.doesNotMatch(sys, /14 is what we normally write/);
});

test("a check-in on an offer they passed on re-quoted our old price, and every one was held for a person", () => {
  const t = outboundOpening({ kind: "passed_checkin", address: "3817 Bells Beach Rd, Langley, WA", stepIndex: 2 });
  assert.match(t, /Do NOT name that house, its street or any number/, "an old price is not in the offer book, and saying it again recommits us to it");
  assert.doesNotMatch(t, /You may mention the number/);
});

// Matt, 2026-10-08: seven texts in a month asking an agent whether 163rd
// closed, when the seller had taken another offer in August. "We don't know
// what happened to specific properties and often they get sold. When we check
// in we need to just ask about any other distressed properties, off market or
// not — personable, professional, even slightly funny."
test("a check-in after a passed house asks about other houses that need work, never whether that one sold", () => {
  const t = outboundOpening({ kind: "passed_checkin", address: "11435 163rd Avenue Southeast, Renton, WA 98059", stepIndex: 3 });
  assert.match(t, /it is NOT about 11435 163rd Avenue Southeast/);
  assert.match(t, /Do NOT ask about it: not whether it sold, closed or is still available, not what the seller did, not whether they'd revisit our number/);
  assert.match(t, /ask whether any other distressed properties — houses that need work — have come across their desk, on the market or off/);
  assert.match(t, /a little funny/);
  assert.match(t, /don't repeat the wording or the joke of the last one/);
  assert.match(t, /"last nudge"/, "no last-chance language");
  assert.doesNotMatch(t, /would they come closer to where we were/);
});

test("a check-in on an offer that went quiet doesn't tell them they passed", () => {
  const t = outboundOpening({ kind: "passed_checkin", address: "3817 Bells Beach Rd, Langley, WA", stepIndex: 1, quiet: true });
  assert.match(t, /never heard back/);
  assert.doesNotMatch(t, /passed on our offer/);
  assert.match(t, /Do NOT name that house, its street or any number/);
});

test("a passed house back on the market is still the news, by name", () => {
  const t = outboundOpening({ kind: "passed_checkin", address: "3817 Bells Beach Rd, Langley, WA", relisted: true });
  assert.match(t, /it's back on the market now/);
  assert.match(t, /3817 Bells Beach Rd/);
});

test("the agent check-in sounds personable, professional and a little funny", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "nothing", segment: "engaged" });
  assert.match(t, /PERSONALITY: personable and professional, and a little funny/);
  assert.match(t, /never sarcasm, never at the agent's, a seller's or a house's expense/);
});

test("the model is told today's date, so the 18th is never 'past month end'", () => {
  const ctx = buildUserContext({ party: "agent", contact: { name: "Nate Wright" }, signer: "Matt", message: "hi", now: Date.parse("2026-09-18T17:16:00Z") });
  assert.match(ctx, /TODAY: Friday, September 18, 2026/);
  // Pacific, not UTC: 2am UTC on the 19th is still the 18th here.
  const late = buildUserContext({ party: "agent", contact: { name: "Nate Wright" }, signer: "Matt", message: "hi", now: Date.parse("2026-09-19T02:00:00Z") });
  assert.match(late, /TODAY: Friday, September 18, 2026/);
});

// 8811 NE 15th Pl, Clyde Hill (2026-09-25): the underwrite held on
// "square footage unknown" and "0 listing photos" with four comps at match 98,
// and the text said "Comps on Clyde Hill came back thinner than I'd like".
// The reason given is the one that held it.
test("an underwrite held on something other than comps doesn't tell the agent the comps are thin", () => {
  const sqft = "the subject's square footage is unknown";
  for (const kind of ["take_ask", "promise_due"]) {
    const o = { kind, address: "8811 NE 15th Pl", heldReason: sqft, needs: ["value", "work"], needValue: true, needWork: true, what: "number" };
    const p = outboundOpening(o);
    assert.doesNotMatch(p, /comps/i, kind);
    assert.match(p, /square footage/, kind);
  }
  const photos = outboundOpening({ kind: "take_ask", address: "x", heldReason: "only 0 listing photos to scan", needWork: true });
  assert.doesNotMatch(photos, /comps/i);
  assert.match(photos, /photos/);
  // Real thin comps still say so.
  const thin = outboundOpening({ kind: "take_ask", address: "x", heldReason: "only 1 priced comps", needValue: true });
  assert.match(thin, /comps came back thin/);
});

// The thread is read keeping its newest 16K characters, and the prompt then
// kept its FIRST 14K — so on a long thread the newest messages, the ones the
// reply is about, were the part cut (found 2026-09-25).
test("on a long thread the newest messages reach the drafter, not the oldest", () => {
  const old = Array.from({ length: 300 }, (_, i) => `[2026-08-01 10:00] THEM sms: old line ${i} ${"x".repeat(40)}`).join("\n");
  const transcript = `${old}\n[2026-09-25 02:06] THEM sms: We should draw it up; she might sign it.`;
  const ctx = buildUserContext({ party: "agent", transcript, message: "We should draw it up", context: { text: "" } });
  assert.match(ctx, /We should draw it up; she might sign it\./);
  assert.doesNotMatch(ctx, /old line 0 /, "the oldest lines are the ones dropped");
});

/* ---------- say only what's true about the offer (2026-09-29) ---------- */

test("a nudge on a number we only floated never says we sent an offer", () => {
  const floated = outboundOpening({ kind: "offer_nudge", address: "12 Elm St", went: "number", step: 3, stepIndex: 1, stepCount: 3 });
  assert.doesNotMatch(floated, /We sent this agent an offer/);
  assert.match(floated, /floated a rough number on 12 Elm St by text \(nothing in writing yet\)/);
  assert.match(floated, /Do NOT say we sent an offer/);
  const read = outboundOpening({ kind: "offer_nudge", address: "12 Elm St", went: "read" });
  assert.match(read, /shared our read on 12 Elm St/);
  // The letter went: the words are exactly what they were.
  const paper = outboundOpening({ kind: "offer_nudge", address: "12 Elm St", went: "paper" });
  assert.match(paper, /We sent this agent an offer on 12 Elm St and they haven't answered/);
  // A passed-offer check-in no longer says what went out: it isn't about that house.
  const passed = outboundOpening({ kind: "passed_checkin", address: "12 Elm St", went: "number", quiet: true });
  assert.doesNotMatch(passed, /We sent this agent an offer/);
});

test("the listing check-in names the street, never the price", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "cold", listing: { street: "123 Main St", city: "Kent", dom: 64, cut: true } });
  assert.match(t, /123 Main St in Kent/);
  assert.match(t, /whether it's a bit of a project/, "asks about the house, not for an as-is cash offer the carriers block");
  assert.match(t, /Phone carriers block texts/);
  assert.match(t, /never its price or any number/);
  assert.match(t, /One clause on who you are/, "a cold agent gets a one-clause intro");
  const known = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", dealsWithUs: 1 });
  assert.match(known, /anything distressed/);
  assert.match(known, /text to a friend/);
  assert.match(known, /do NOT reintroduce yourself/i);
});

test("the walkthrough reminder names the street and window, says only what the access lines say, and names no price", () => {
  const t = outboundOpening({ kind: "showing_reminder", street: "3511 NE 153rd St", windowLabel: "Sat Oct 3, 10am-12pm" });
  assert.match(t, /walkthrough at 3511 NE 153rd St tomorrow, Sat Oct 3, 10am-12pm/);
  assert.match(t, /ONLY what the deal's access lines above say/);
  assert.match(t, /never that it's open/);
  assert.match(t, /Do NOT name a price/);
  assert.match(t, /intent to showing_reminder/);
  const f = outboundOpening({ kind: "showing_followup", street: "3511 NE 153rd St", windowLabel: "Sat Oct 3, 10am-12pm" });
  assert.match(f, /ask how it looked/);
  assert.match(f, /didn't make it/);
  assert.match(f, /intent to showing_followup/);
});

// Matt, 2026-09-30: "make it reference pieces of the conversation we've had if
// any, make it personalized, concise, friendly, professional, like we're
// building a relationship".
test("the check-in is generic: no house from before, personable from the tone and their area, and it asks about distressed or off-market houses", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged",
    lastHouse: { street: "9 Oak St", how: "passed", daysAgo: 35 },
    aboutThem: [{ what: "daughter just started at UW", daysAgo: 40 }],
    areas: ["South King"], lastSummary: "said a Burien fixer might list after the holidays",
    voice: "Keep it short. Sign off -Matt." });
  assert.match(t, /KEEP IT GENERIC: never mention, name or hint at any house, listing, offer or deal from before/);
  assert.doesNotMatch(t, /9 Oak St/, "the last house is never handed to the drafter");
  assert.doesNotMatch(t, /daughter/, "no personal detail");
  assert.doesNotMatch(t, /Burien fixer/, "no thread recital");
  assert.match(t, /South King/, "the area they work, in a few words");
  assert.match(t, /anything distressed — a house that needs work, listed or not — or anything off-market/);
  assert.match(t, /friendly and professional/i);
  assert.match(t, /HOW MATT WANTS THESE TO SOUND[^]*Keep it short\. Sign off -Matt\./);
  assert.match(t, /Do NOT name a price/);
  assert.doesNotMatch(t, /Reference the thread/);
  const house = outboundOpening({ kind: "agent_pulse", reason: "our_house", segment: "engaged", house: { street: "123 Main St", how: "passed" } });
  assert.doesNotMatch(house, /123 Main St/, "a house whose clocks ended is never brought up");
  const thanks = outboundOpening({ kind: "agent_pulse", reason: "deal_thanks", segment: "partner", house: { street: "4747 46th Ave S", how: "closed" } });
  assert.doesNotMatch(thanks, /4747/);
  assert.match(thanks, /never name the house or its street/);
});

// The first samples: "…had a price cut and is still sitting, aside from the
// landscaping story you shared." A reference that doesn't fit in one natural
// clause reads like a form letter; the listing is already the point.
test("a check-in about a fresh listing names only that listing, never a house from before", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "engaged",
    listing: { street: "4706 64th St E", city: "Tacoma", dom: 70, cut: true }, lastHouse: { street: "9 Oak St", how: "passed" }, aboutThem: [{ what: "redoing their backyard", daysAgo: 12 }] });
  assert.match(t, /4706 64th St E in Tacoma/);
  assert.match(t, /the listing above is the only house in this text/);
  assert.doesNotMatch(t, /9 Oak St|backyard/);
});

// The first live batch, 2026-09-30: "…been sitting a bit, 84 days now",
// "never did connect after that 4pm", and one that opened "Would your seller…"
// with no name. Days on market is handed over as "a while", never a count.
test("a check-in never gets the days-on-market count, never names a time or date, and opens with their first name", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "engaged", listing: { street: "19712 207th Street Ct E", city: "Bonney Lake", dom: 84, cut: false } });
  assert.match(t, /listing at 19712 207th Street Ct E in Bonney Lake, on the market a while\./);
  assert.doesNotMatch(t, /about 84 days/, "no count to repeat");
  assert.match(t, /Open with their first name/);
  assert.match(t, /never a count of days, a time of day or a date/i);
});

// Matt, 2026-09-30: "our biggest success has been in agent-sourced off market
// properties… ask agents if they get off market properties please send our
// way, when we can ask them but not in an aggressive way".
test("an agent's reply may ask for off-market houses at a natural close, lightly, when the context allows; a buyer's never", () => {
  const sys = buildSystemPrompt({ config: null, party: "agent", channel: "sms" });
  assert.match(sys, /OFF-MARKET: our best deals are off-market houses agents bring us/);
  assert.match(sys, /only when the context's OFF-MARKET ASK line says you may/i);
  assert.match(sys, /never claim we have off-market deals/i);
  assert.doesNotMatch(buildSystemPrompt({ config: null, party: "investor", channel: "sms" }), /OFF-MARKET: our best deals/);
});

test("every general check-in asks about distressed or off-market houses, whether or not we asked this month", () => {
  for (const offMarketAskDue of [true, false]) {
    const t = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", offMarketAskDue });
    assert.match(t, /anything distressed/);
    assert.match(t, /anything off-market has come across their desk/);
    assert.match(t, /first look/);
  }
});

// Matt, 2026-10-06: the asks went out as "anything before it hits the MLS".
// "It is okay to say 'off-market' and check in if they have any off-market
// opportunities that came across the desk."
test("an agent is asked about off-market opportunities in that word, not 'before it hits the MLS'", () => {
  const ask = /whether any off-market opportunities have come across their desk/;
  const plain = /Say "off-market" itself, never "before it hits the MLS"/;
  const sys = buildSystemPrompt({ config: normalizeConversationAi({}), party: "agent", channel: "sms" });
  assert.match(sys, ask);
  assert.match(sys, plain);
  assert.doesNotMatch(sys, /never pitch "off-market deals"/, "the starter rule no longer warns the word off");
  const due = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", offMarketAskDue: true });
  assert.match(due, /anything off-market has come across their desk/);
  assert.match(due, plain);
});

/* ---------- one house at a time (2026-10-02) ---------- */

// The Auburn listing agent, 9/30: "Last check on 10625 SE 304th Way… just say so and
// I'll leave it alone", with the next nudge already set for the week after.
test("a nudge on a ladder that keeps asking never says it's the last check", () => {
  const day14 = outboundOpening({ kind: "offer_nudge", address: "10625 SE 304th Way", went: "number", step: 14, stepIndex: 3, stepCount: 3, repeats: true });
  assert.doesNotMatch(day14, /This is the LAST follow-up/);
  assert.match(day14, /Do NOT call it a last check or say you'll leave it alone — we will ask again/);
  const day21 = outboundOpening({ kind: "offer_nudge", address: "10625 SE 304th Way", went: "number", step: 21, stepIndex: 0, stepCount: 3, repeats: true });
  assert.match(day21, /This is a repeat follow-up/, "a repeat rung isn't the first follow-up all over again");
  const ends = outboundOpening({ kind: "offer_nudge", address: "12 Elm St", went: "paper", step: 14, stepIndex: 3, stepCount: 3 });
  assert.match(ends, /This is the LAST follow-up/, "a ladder that really ends still says so");
});

test("a house they passed on rides on the live offer's nudge as one line, never a number or a second question", () => {
  const t = outboundOpening({ kind: "offer_nudge", address: "10625 SE 304th Way", went: "number", step: 7, stepIndex: 2, stepCount: 3,
    aside: { street: "28422 Military Road South", quiet: false } });
  // Matt, 2026-10-08: the line is about the next house, never the passed one
  // (we don't know what happened to it, and it has usually sold).
  assert.match(t, /Then ONE short closing line: if anything else that needs work comes across their desk, on the market or off, we'd love a look/);
  assert.match(t, /A statement, not a question\. Do NOT name 28422 Military Road South or any other house, and no number\. 10625 SE 304th Way stays the subject/);
  assert.doesNotMatch(t, /shakes loose/);
  assert.match(t, /Set intent to offer_nudge\.$/);
  assert.doesNotMatch(outboundOpening({ kind: "offer_nudge", address: "12 Elm St", went: "paper" }), /closing line/);
});

/* ---------- a buyer who spoke up (2026-10-05) ---------- */

// Buck, 3511 NE 153rd St: "Last check on this one… If it's not one for you
// just say so and I'll leave it" — to a buyer who never said a word about it.
// The only deal follow-up a buyer gets now is to one who spoke up, once, and
// it picks up where they left off.
test("a follow-up to a buyer never says last check", () => {
  const t = outboundOpening({ kind: "deal_followup", address: "3511 NE 153rd St", step: 3, stepIndex: 1, stepCount: 1, spokeAt: "2026-10-01T18:00:00Z" });
  assert.doesNotMatch(t, /This is the LAST follow-up|I'll leave it\)/);
  assert.match(t, /do NOT call it a last check, do NOT say you'll leave it alone/);
  assert.match(t, /pick up exactly where they left off/);
  assert.match(t, /Do NOT name a price or any number/);
  assert.match(t, /Set intent to deal_followup\.$/);
});

test("the bot is told to describe a house only in the deal's words", () => {
  const sys = buildSystemPrompt({ config: normalizeConversationAi({ enabled: true }), party: "investor" });
  assert.match(sys, /DESCRIBING A HOUSE: use only the words the context gives it/);
  assert.match(sys, /the condition as the deal describes it/);
  // An agent is asked whether a listing needs work; the rule is the buyer's.
  assert.doesNotMatch(buildSystemPrompt({ config: normalizeConversationAi({ enabled: true }), party: "agent" }), /DESCRIBING A HOUSE/);
});

/* ---------- the pulse, personal (2026-10-05) ---------- */

// Buck, 2026-09-24: "I'm a Seattle investor…" → "who is this?". The answer
// opened "Matt, Seattle investor…" and the name gate held it for four days.
test("a pulse to someone new says it's Matt", () => {
  const t = outboundOpening({ kind: "buyer_pulse", dealsSent: 3, conversed: false, variant: 0 });
  assert.match(t, /who you are by first name \("It's Matt" \/ "This is Matt"/);
  assert.match(t, /never open with your bare name and a comma/);
  const fb = outboundOpening({ kind: "buyer_pulse", dealsSent: 0, conversed: false, source: "found you through the WA real estate Facebook group" });
  assert.match(fb, /how we found them \(found you through the WA real estate Facebook group\)/);
});

test("asked who this is, the answer starts with Matt", () => {
  const sys = buildSystemPrompt({ config: normalizeConversationAi({ enabled: true }), party: "investor" });
  assert.match(sys, /WHO THIS IS: when they ask who this is/);
  assert.match(sys, /never your bare name followed by a comma/);
});

test("a buyer who never answered a deal is asked what fits, with that house as the way in", () => {
  const t = outboundOpening({ kind: "buyer_pulse", dealsSent: 1, conversed: false, lastHouse: { street: "3511 NE 153rd St", city: "Lake Forest Park", how: "no answer" }, missing: ["price range"] });
  assert.match(t, /THE LAST HOUSE WE SENT THEM: 3511 NE 153rd St in Lake Forest Park, and they never answered/);
  assert.match(t, /Never ask whether they want it/);
  assert.match(t, /SHAPE FOR THIS ONE: open with the house you sent/);
  assert.match(t, /the piece of their buy box we don't have — price range/);
  assert.match(t, /THE ONE REFERENCE/);
  assert.match(t, /no street address except the house we sent them/);
});

test("the pulse carries Matt's voice and the notes that make it personal", () => {
  const t = outboundOpening({ kind: "buyer_pulse", dealsSent: 4, conversed: true, voice: "short, like a friend, no pitch",
    passReasons: ["7034 South K Street: too far south"], lastSummary: "Wants north King only", aboutThem: "Building spec homes in Shoreline" });
  assert.match(t, /HOW MATT WANTS THESE TO SOUND .*short, like a friend, no pitch/);
  assert.match(t, /Why they passed before, as recorded: 7034 South K Street: too far south/);
  assert.match(t, /Our last conversation: Wants north King only/);
  assert.match(t, /About them, from our notes: Building spec homes in Shoreline/);
});


// Matt, 2026-10-08: a rural house (two acres or more) is passed, and the
// agent hears that's why.
test("the pass on a rural house says we can't do rural and names the acreage", () => {
  const t = outboundOpening({ kind: "kind_pass", address: "21800 Farm Rd SE, Maple Valley, WA 98038", why: "rural",
    heldReason: "rural — it sits on 5.2 acres (we buy houses on under 2 acres)" });
  assert.match(t, /it's a rural property — it sits on 5\.2 acres, and we can't do rural/);
  assert.match(t, /fixers in town on a normal-size lot/);
  assert.doesNotMatch(t, /single-family/);
});

test("when an agent brings us a house, the bot gets the address with a promise not to bother the seller, and their read on value and work", () => {
  const sys = buildSystemPrompt({ config: null, party: "agent", channel: "sms" });
  assert.match(sys, /A HOUSE THEY BRING US[^]*won't approach, drive by or bother the seller/);
  assert.match(sys, /worth fixed up and what it needs, and the seller's situation and timing/);
  assert.doesNotMatch(buildSystemPrompt({ config: null, party: "investor", channel: "sms" }), /A HOUSE THEY BRING US/);
});

test("a check-in names one kind of seller that becomes a deal, and tells a new agent what we buy — once", () => {
  const fresh = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", variant: 0, offersWithUs: 0, dealsWithUs: 0 });
  assert.match(fresh, /name one kind of seller we're good for, in a few words: an estate that hasn't been listed\. One, never a list\./);
  assert.match(fresh, /what we buy: single-family houses that need work, under about a million/);
  const known = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", variant: 1, offersWithUs: 3, dealsWithUs: 0 });
  assert.match(known, /a parent moving into care/);
  assert.doesNotMatch(known, /what we buy:/, "an agent we've worked houses with already knows");
});
