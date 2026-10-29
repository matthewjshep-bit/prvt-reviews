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
  assert.match(sys, /WHY WE PASSED on that house and they ask why/, "the bot may give Matt's reason");
  assert.match(sys, /never a reason the book doesn't give/);
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

test("the check-in on a lead they gave us a date for names the lead, not the generic 'anything distressed?'", () => {
  const t = outboundOpening({ kind: "checkin_due", address: "", sourceKind: "lead", phrase: "end of this month",
    lead: { what: "the probate", said: "The probate is with the court, should know by end of this month.", toldAt: "2026-10-14T20:00:00.000Z", via: "text" } });
  assert.match(t, /a lead \(the probate\)/);
  assert.match(t, /with the court/);
  assert.match(t, /Did the family decide on the probate house\?/);
  assert.match(t, /Do NOT ask the generic/);
  assert.match(t, /Set intent to checkin_due/);
  // Only "check back in a couple months": the light ask, on the day they named.
  const back = outboundOpening({ kind: "checkin_due", address: "", sourceKind: "lead", phrase: "in a couple months", lead: { what: "", said: "Check back in a couple months" } });
  assert.match(back, /you'd mentioned in a couple months/);
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

// 2026-10-20: a house waiting on Matt's own number. The ask isn't "our
// numbers are stuck": Matt is pricing it himself and wants their read,
// including what the seller would take.
test("the ask on a house Matt is pricing himself says so, and asks what the seller would take", () => {
  const p = outboundOpening({ kind: "take_ask", address: "8811 NE 15th Pl", heldReason: "ready for your comps", needValue: true, needWork: true, needTake: true });
  assert.match(p, /you're running the numbers yourself/i);
  assert.match(p, /what the seller would take/);
  assert.doesNotMatch(p, /stuck|ready for your comps/);
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
  assert.match(t, /listing on Main St in Kent/);
  assert.doesNotMatch(t, /123 Main/, "the street name, never the house number");
  // 2026-10-21, Matt: a check-in that names the listing in passing, not a question about it.
  assert.match(t, /Mention it in passing, in a clause: it doesn't look like a fixer for us\. Don't ask about that house/);
  assert.match(t, /any other distressed properties on their plate/);
  assert.match(t, /Phone carriers block texts/);
  assert.match(t, /never its price or any number/);
  const known = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", dealsWithUs: 1 });
  assert.match(known, /anything distressed/);
  assert.match(known, /text to a friend/);
  assert.match(known, /do NOT reintroduce yourself/i);
});

// 2026-10-19: "Hey, saw the listing on 126th come off the market. Still hoping
// to sell? I'm local and always looking for the next project house." Matt: the
// last line is filler, take it out of every check-in.
test("a check-in never tacks on 'I'm local and always looking for the next project house'", () => {
  for (const o of [
    { reason: "off_market_listing", segment: "cold", listing: { street: "126th Ave SE", city: "Kent" } },
    { reason: "fresh_listing", segment: "cold", listing: { street: "123 Main St", city: "Kent" } },
    { reason: "general", segment: "cold", offersWithUs: 2 },
    { reason: "general", segment: "cold" },
    { reason: "general", segment: "engaged" },
  ]) {
    const t = outboundOpening({ kind: "agent_pulse", ...o });
    assert.doesNotMatch(t, /One clause on who you are/, o.reason);
    assert.doesNotMatch(t, /(someone local who's|buyer who .*) always (looking for|after) the next project house/, o.reason);
    assert.match(t, /never "I'm local", never that we're always looking for the next project house/, o.reason);
  }
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
test("the check-in names one thing and no house from before, personable from the tone and their area, and it asks about distressed or off-market houses", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged",
    lastHouse: { street: "9 Oak St", how: "passed", daysAgo: 35 },
    aboutThem: [{ what: "daughter just started at UW", daysAgo: 40 }],
    areas: ["South King"], lastSummary: "said a Burien fixer might list after the holidays",
    voice: "Keep it short. Sign off -Matt." });
  assert.match(t, /ONE THING ONLY \(no house at all\): never mention, name or hint at any other house, listing, offer or deal from before/);
  assert.match(t, /never a house we priced or passed on, and never ask whether a house sold/);
  assert.match(t, /THE ONE THING it names: name one kind of seller we're good for/);
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

// 2026-10-15, the funnel review: Matt's own specific texts got 70% replies,
// the bot's generic check-ins 35%. So a check-in names one real thing.
test("a check-in names a house they mentioned that we never priced, as the one thing, and no other", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", variant: 0,
    hook: { kind: "mentioned", street: "Pine St", town: "Shelton", daysAgo: 20 }, lastHouse: { street: "9 Oak St", how: "passed" } });
  assert.match(t, /They mentioned a house on Pine St in Shelton a few weeks back/);
  assert.match(t, /how it's coming along, or whether the seller is still thinking about selling/);
  assert.match(t, /the house they mentioned above is the only house in this text/);
  assert.doesNotMatch(t, /9 Oak St/);
  assert.doesNotMatch(t, /an estate that hasn't been listed/, "one thing: no seller situation on top");
  assert.doesNotMatch(t, /\b20 days\b/, "no count of days");
  const recent = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", hook: { kind: "mentioned", label: "some Stanwood houses", daysAgo: 3 } });
  assert.match(recent, /They mentioned a house \(some Stanwood houses\) recently/);
});

test("a check-in may say we just closed one in their town, by the town only, never the house", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", hook: { kind: "closed_nearby", town: "Kent" } });
  assert.match(t, /We just closed on a house in Kent, a town they work\. Say so in a clause, by the town only — never a street or which house/);
  assert.match(t, /Kent is the only place named, and no house at all/);
  assert.match(t, /anything off-market has come across their desk/);
});

test("a check-in offers a quick call if that's easier, with no day or time — no calendar is connected", () => {
  for (const o of [{ reason: "general" }, { reason: "fresh_listing", listing: { street: "1 A St", city: "Kent", dom: 10 } }]) {
    const t = outboundOpening({ kind: "agent_pulse", segment: "engaged", ...o });
    assert.match(t, /offer a quick call in a few words/);
    assert.match(t, /never a day or a time, and still only one question/);
  }
});

// 2026-10-15: short first texts got answered (54% under ~230 characters). A
// cold agent's fresh listing is in effect a second first text.
test("a cold agent's fresh listing gets the plain first-text voice: their name, the street, one question, under 160 characters, no remark or joke", () => {
  const listing = { street: "123 Main St", city: "Kent", dom: 64, cut: true };
  const t = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "cold", listing });
  assert.match(t, /the short first-text voice — two short sentences, under 160 characters, plain/);
  assert.match(t, /the PERSONALITY line above doesn't apply to this one/);
  assert.match(t, /never the house number/);
  assert.match(t, /as one that doesn't look like a fixer for us; ONE question, whether they have any other distressed properties on their plate\. Say nothing else about the house/);
  assert.match(t, /Nothing else: no other ask, no call offer/);
  assert.doesNotMatch(t, /offer a quick call in a few words/);
  assert.match(t, /the listing above is the only house in this text/, "no past house");
  assert.match(outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "cold", listing, tooLong: 260 }), /YOUR LAST DRAFT WAS 260 CHARACTERS: write it again under 160/);
  const warm = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "engaged", listing });
  assert.doesNotMatch(warm, /short first-text voice/, "an agent we know gets the usual check-in");
});

test("the listing check-in and the thank-you keep their own one thing, whatever the hook says", () => {
  const l = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "engaged", listing: { street: "77 Heron Way", city: "Tacoma", dom: 70 },
    hook: { kind: "mentioned", street: "Pine St", daysAgo: 3 } });
  assert.doesNotMatch(l, /Pine St/);
  const thanks = outboundOpening({ kind: "agent_pulse", reason: "deal_thanks", segment: "partner", hook: { kind: "closed_nearby", town: "Kent" } });
  assert.doesNotMatch(thanks, /Kent/);
});

// The first samples: "…had a price cut and is still sitting, aside from the
// landscaping story you shared." A reference that doesn't fit in one natural
// clause reads like a form letter; the listing is already the point.
test("a check-in about a fresh listing names only that listing, never a house from before", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "engaged",
    listing: { street: "4706 64th St E", city: "Tacoma", dom: 70, cut: true }, lastHouse: { street: "9 Oak St", how: "passed" }, aboutThem: [{ what: "redoing their backyard", daysAgo: 12 }] });
  assert.match(t, /64th St E in Tacoma/);
  assert.match(t, /the listing above is the only house in this text/);
  assert.doesNotMatch(t, /9 Oak St|backyard/);
});

// The first live batch, 2026-09-30: "…been sitting a bit, 84 days now",
// "never did connect after that 4pm", and one that opened "Would your seller…"
// with no name. Days on market is handed over as "a while", never a count.
test("a check-in never gets the days-on-market count, never names a time or date, and opens with their first name", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "engaged", listing: { street: "19712 207th Street Ct E", city: "Bonney Lake", dom: 84, cut: false } });
  assert.match(t, /listing on 207th Street Ct E in Bonney Lake\./);
  assert.doesNotMatch(t, /on the market a while/, "nothing about the house: it's named in passing");
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
  assert.match(t, /Set intent to deal_followup\. Phone carriers block/, "then the carrier rule (2026-10-15)");
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

// 2026-10-14: a house we owed the agent a number on, closed out by the sweep.
test("the pass on a house we promised a number on owns that we owe them, gives the reason, and asks for the next one", async () => {
  const { outboundDescriptor } = await import("./reply-agent.js");
  const o = outboundDescriptor({ kind: "kind_pass", offer: null, saved: {}, subject: { address: "12 Elm St, Renton, WA", why: "promised", owed: "number", reason: "there weren't enough good sales nearby to price it with confidence", heldReason: "held 15 days and nothing since" } });
  assert.equal(o.why, "promised");
  const t = outboundOpening(o);
  assert.match(t, /we'd come back to them with a number on 12 Elm St/);
  assert.match(t, /We're passing on it: there weren't enough good sales nearby/);
  assert.match(t, /send the next fixer/);
  assert.match(t, /Do NOT name any number/);
  assert.doesNotMatch(t, /held 15 days/, "the sweep's own reason is ours, not theirs");
});

// Matt, 2026-10-13: no manufactured homes as a rule.
test("the pass on a mobile home says we don't buy mobile homes, not that we're single-family only right now", () => {
  const t = outboundOpening({ kind: "kind_pass", address: "1510 Maple Lane, Kent, WA 98030", why: "manufactured",
    heldReason: "not our kind of house — a mobile home (we don't buy mobile or manufactured homes)" });
  assert.match(t, /it's a mobile or manufactured home, and we don't buy those/);
  assert.match(t, /single-family fixers/);
  assert.doesNotMatch(t, /right now we only buy single-family/);
});

// Price once (2026-10-15): a listed house far under the seller's number gets
// a polite no-fit with no number, and the first text on a listed house asks
// the seller's number instead of their read.
test("the no-fit on a listed house says we're too far from the seller, names no number, and asks for other fixers on or off market", async () => {
  const { outboundDescriptor } = await import("./reply-agent.js");
  const o = outboundDescriptor({ kind: "kind_pass", offer: null, saved: {}, subject: { address: "18 Fern Way, Kent, WA 98030", why: "too_far" } });
  assert.equal(o.why, "too_far");
  const t = outboundOpening(o);
  assert.match(t, /too far under where the seller is to be worth sending a number/);
  assert.match(t, /other fixers, on or off market/);
  assert.match(t, /Do NOT name any number/);
  assert.doesNotMatch(t, /single-family/);
});

test("the first text on a listed house floats our read and asks only what the seller is hoping to get", async () => {
  const { outboundDescriptor } = await import("./reply-agent.js");
  const offer = { id: "o1", address: "18 Fern Way, Kent, WA 98030", cashAmount: 410000, arv: 620000, repairs: 90000 };
  const o = outboundDescriptor({ kind: "take_check", offer, saved: {}, subject: { address: offer.address, askSeller: true } });
  assert.equal(o.askSeller, true);
  const t = outboundOpening(o);
  assert.match(t, /"what's the seller hoping to get\?"/);
  assert.match(t, /do NOT ask what they think it's worth or what the work would run/);
  assert.match(t, /Do NOT mention an offer, a purchase price/);
  // Since 2026-10-21 every take check asks this, never "what do you think?" of our read.
  const plain = outboundOpening(outboundDescriptor({ kind: "take_check", offer, saved: {}, subject: { address: offer.address } }));
  assert.match(plain, /"what's the seller hoping to get\?"/);
  assert.doesNotMatch(plain, /What do you think\?/);
  const said = outboundDescriptor({ kind: "take_check", offer, saved: {}, subject: { address: offer.address }, dossier: { have: { sellerAsk: { value: 450000 } } } });
  assert.match(outboundOpening(said), /"what's the seller's timeline looking like\?"/, "a seller's number they gave isn't asked again");
});

test("when an agent brings us a house, the bot gets the address with a promise not to bother the seller, and asks the seller's side, never their rehab", () => {
  const sys = buildSystemPrompt({ config: null, party: "agent", channel: "sms" });
  assert.match(sys, /A HOUSE THEY BRING US[^]*won't approach, drive by or bother the seller/);
  assert.match(sys, /Say we'll run the numbers, and ask the seller's situation and timing; never what it's worth fixed up or what the work would run/);
  assert.doesNotMatch(sys, /THEIR TAKE: get the agent's OWN read/, "the default playbook doesn't ask for it either");
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

// 2026-10-21: a close ended "keep me in mind for the next one that
// needs work, and if anything changes with the seller I'm here" — a statement
// that asks nothing. Matt: always end on "have anything else that needs work
// or would be a good flip?"
test("a text that closes a house ends on asking for the next one, not keep me in mind", async () => {
  const sys = buildSystemPrompt({ config: null, party: "agent", channel: "sms" });
  assert.match(sys, /NEXT ONE: when your text closes out a house/);
  assert.match(sys, /Have anything else that needs work or would be a good flip\?/);
  assert.match(sys, /end on the NEXT ONE question, and stop/);
  assert.doesNotMatch(sys, /ask them to keep us in mind/);
  assert.doesNotMatch(buildSystemPrompt({ config: null, party: "investor", channel: "sms" }), /good flip/, "buyers don't get the agent ask");
  const { outboundDescriptor } = await import("./reply-agent.js");
  for (const subject of [{ address: "12 Elm St, Renton, WA", why: "area" }, { address: "12 Elm St, Renton, WA", why: "promised", owed: "number" }]) {
    const t = outboundOpening(outboundDescriptor({ kind: "kind_pass", offer: null, saved: {}, subject }));
    assert.match(t, /end on one question/, subject.why);
    assert.match(t, /good flip\?/, subject.why);
    assert.doesNotMatch(t, /keep us in mind/, subject.why);
  }
});

// Gig Harbor, 2026-10-21: "I'll flag it to Matt in case he's got questions"
// went to an agent who'd talked to Matt twice that day. The prompt told the
// bot "our underwritten number and Matt decide that, never you".
test("the bot is told it is Matt, and no rule talks about Matt as someone else", async () => {
  const { AGENT_GOAL_RULE, PROMISE_RULE } = await import("./shared/conversation-ai.js");
  const { accessLines } = await import("./shared/deal-access.js");
  const p = buildSystemPrompt({ config: normalizeConversationAi({ persona: { name: "Matt" } }), party: "agent" });
  assert.match(p, /YOU ARE Matt, the person they have been texting/);
  const rules = [p, AGENT_GOAL_RULE, PROMISE_RULE, ...accessLines({ method: "lockbox" }), ...accessLines({ method: "matt" }),
    outboundOpening({ kind: "pass_note", houses: [{ address: "1 Elm St" }] })].join("\n")
    .replace(/YOU ARE Matt[^\n]*?"let me call you on that"\./, "");
  assert.doesNotMatch(rules, /\bMatt (?:will|is|calls|sends|meets|looked|decide)|only Matt|and Matt\b|to Matt\b|with Matt\b/);
});

// 2026-10-22: a house we priced came off the market unsold (followUp.lostHouse).
test("the second look on a house that came off the market says so, and still never asks if it sold", () => {
  const base = { kind: "second_look", street: "12 Oak St", oursK: "410K", offerStatus: "passed", step: 1, maxChars: 240 };
  const off = outboundOpening({ ...base, offMarket: true });
  assert.match(off, /came off the market without selling/);
  assert.match(off, /Do NOT ask whether it sold/);
  assert.doesNotMatch(off, /wasn't far from ours/);
  assert.match(outboundOpening(base), /wasn't far from ours/);
});

/* ---------- personality ---------- */

// Matt, 2026-10-27: the replies read dry. Light personality is a switch, off
// until he turns it on, and never touches money or the texts we start.
test("replies stay plain until personality is turned on, and the setting survives a save", () => {
  const plain = normalizeConversationAi({});
  assert.equal(plain.persona.personality, "off");
  assert.doesNotMatch(buildSystemPrompt({ config: plain, party: "agent" }), /PERSONALITY \(when answering them/);

  const light = normalizeConversationAi({ persona: { personality: "light" } });
  assert.equal(light.persona.personality, "light");
  assert.equal(normalizeConversationAi({ persona: { personality: "zany" } }).persona.personality, "off");
  for (const party of ["agent", "investor"]) {
    const sys = buildSystemPrompt({ config: light, party });
    assert.match(sys, /PERSONALITY \(when answering them/);
    // The line never lands on money, and never on a text the machine starts.
    assert.match(sys, /None at all when the message is about a price, an offer, a counter or terms/);
    assert.match(sys, /a message you are STARTING keeps the tone its own instructions give/);
    // Concise still wins, and the no-warm-up rule still stands.
    assert.match(sys, /stays as short as the length rule says/);
    assert.match(sys, /No warm-up clause before the substance/);
  }
});
