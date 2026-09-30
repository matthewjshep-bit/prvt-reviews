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
  assert.match(t, /do NOT name any number/i, "an old price is not in the offer book, and saying it again recommits us to it");
  assert.doesNotMatch(t, /You may mention the number/);
  assert.match(t, /still available/);
});

test("a check-in on an offer that went quiet doesn't tell them they passed", () => {
  const t = outboundOpening({ kind: "passed_checkin", address: "3817 Bells Beach Rd, Langley, WA", stepIndex: 1, quiet: true });
  assert.match(t, /never heard back/);
  assert.doesNotMatch(t, /passed on our offer/);
  assert.match(t, /do NOT name any number/i);
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
  const passed = outboundOpening({ kind: "passed_checkin", address: "12 Elm St", went: "number", quiet: true });
  assert.match(passed, /floated where we'd be on 12 Elm St by text \(nothing in writing\) and never heard back/);
});

test("the listing check-in names the street, never the price", () => {
  const t = outboundOpening({ kind: "agent_pulse", reason: "fresh_listing", segment: "cold", listing: { street: "123 Main St", city: "Kent", dom: 64, cut: true } });
  assert.match(t, /123 Main St in Kent/);
  assert.match(t, /as-is cash offer/);
  assert.match(t, /never its price or any number/);
  assert.match(t, /One clause on who you are/, "a cold agent gets a one-clause intro");
  const known = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", dealsWithUs: 1 });
  assert.match(known, /anything coming up that needs work/);
  assert.match(known, /this is a friend/);
  assert.match(known, /do NOT reintroduce yourself/);
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
