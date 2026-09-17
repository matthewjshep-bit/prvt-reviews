import test from "node:test";
import assert from "node:assert/strict";
import { buildUserContext, buildSystemPrompt, outboundOpening } from "./conversation-prompt.js";

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
  assert.match(sys, /at least 7 to 10 days/);
  assert.match(sys, /14 is what we normally write/);
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
