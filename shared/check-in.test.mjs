// check-in.test.mjs — when a check-in waits, and which fixed text it says
// (shared/check-in.js, 2026-11-09).
//
// The 11-09 audit: word-for-word repeats, check-ins right after a no or a
// "check back after the holidays", texts into auto-responders and to
// homeowners, and check-ins after we'd said we'd back off. Every name,
// street and word below is invented.

import test from "node:test";
import assert from "node:assert/strict";
import { checkInPack, routeCheckIn, pickVariant, checkInWait, goesBySaid, goesByOf, onlyAsksIfBot, asksIfBot, botAskFlags,
  isCriticalCheckIn, normalizeCheckInRoute, CHECK_IN_ROUTE_DEFAULTS } from "./check-in.js";
import { repeatsUs } from "./voice.js";
import { standardText, CHECKIN_TEXTS } from "./standard-texts.js";
import { evaluateAgent, normalizeAgentPulse } from "./agent-pulse.js";
import { normalizeConversationAi } from "./conversation-ai.js";
import { openerVariant } from "./outreach-opener.js";

const DAY = 86400000;
const NOW = Date.parse("2026-11-10T19:00:00Z");   // a Tuesday, 11am Pacific
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const stamp = (d) => ago(d).slice(0, 16).replace("T", " ");
const thread = (lines) => lines.map(([d, who, text, ch = "sms"]) => `[${stamp(d)}] ${who} ${ch}${text == null ? "" : `: ${text}`}`).join("\n");
const route = (lines, kind = "agent_pulse", opts = {}) => {
  const pack = checkInPack(thread(lines), {}, opts.context || {}, NOW);
  return { pack, r: routeCheckIn(pack, kind, opts.settings || {}, { party: opts.party || "agent", sourceKind: opts.sourceKind || "", now: NOW }) };
};
const pulse = (over = {}) => ({ contactId: "a1", name: "Dana", tags: ["agent"], offers: [], current: [], drafts: [], events: [], ledger: [], listings: [], facts: {}, lastInboundAt: null, ...over });
const CONFIG = normalizeConversationAi({ enabled: true });
const ctx = (now = NOW) => ({ settings: normalizeAgentPulse({ enabled: true }), config: CONFIG, houses: { live: new Set(), walked: new Map() }, now });
// What runProactive writes when a check-in waits.
const skipped = (r, at = NOW) => ({ type: "checkin_skipped", at: new Date(at).toISOString(), data: { kind: "agent_pulse", why: r.why, until: r.until, route: r.route, ...(r.permanent ? { permanent: true } : {}) } });

/* ---------- the settings ---------- */

test("the check-in's wait settings ship on, and only hold texts back", () => {
  const c = normalizeConversationAi({}).checkIns;
  assert.deepEqual({ noRepeat: c.noRepeat, repeatTouches: c.repeatTouches, respectLastWord: c.respectLastWord, afterNoDays: c.afterNoDays, aiComplaintDays: c.aiComplaintDays },
    { ...CHECK_IN_ROUTE_DEFAULTS });
  const typed = normalizeConversationAi({ checkIns: { noRepeat: false, repeatTouches: 40, respectLastWord: "false", afterNoDays: 2, aiComplaintDays: 999 } }).checkIns;
  assert.deepEqual([typed.noRepeat, typed.repeatTouches, typed.respectLastWord, typed.afterNoDays, typed.aiComplaintDays], [false, 12, false, 7, 120]);
  assert.equal(typed.lint, true, "the voice check's own keys are kept");
  assert.deepEqual(normalizeCheckInRoute({}), { ...CHECK_IN_ROUTE_DEFAULTS });
});

/* ---------- never the same text twice ---------- */

test("an agent never gets the same check-in text twice in a row", () => {
  for (let i = 0; i < 25; i++) {
    const contactId = `agent-${i}`;
    const prior = [];
    for (let touch = 0; touch < 8; touch++) {
      const s = standardText({ kind: "agent_pulse", outbound: { mode: "template", reason: "general", segment: "engaged", touch }, name: "Dana Quill", contactId, prior });
      assert.ok(s, `${contactId} touch ${touch}`);
      if (prior[0]) {
        assert.notEqual(s.text, prior[0].text, `${contactId}: check-in ${touch} said the last one again`);
        assert.equal(repeatsUs(s.text, prior.slice(0, 2)), "", `${contactId}: check-in ${touch} repeats us: ${s.text}`);
      }
      prior.unshift({ text: s.text, at: ago((8 - touch) * 21) });
    }
  }
});

test("a fixed check-in walks past a text that repeats ours or spends a phrase our last three used", () => {
  const fill = (t) => t.replace(/\{first\}/g, "Dana");
  const first = pickVariant(CHECKIN_TEXTS, [], "agent-7", 0, { fill, now: NOW });
  const again = pickVariant(CHECKIN_TEXTS, [{ text: first.text, at: ago(21) }], "agent-7", 0, { fill, now: NOW });
  assert.notEqual(again.text, first.text);
  // Its turn falls on the "estates or tired rentals" text, and our last text
  // said "rentals": the next one along goes instead.
  const n = CHECKIN_TEXTS.length;
  const touch = (CHECKIN_TEXTS.findIndex((t) => /rentals/.test(t)) - openerVariant("agent-7", n) + n) % n;
  assert.match(pickVariant(CHECKIN_TEXTS, [], "agent-7", touch, { fill }).text, /rentals/);
  const spent = pickVariant(CHECKIN_TEXTS, [{ text: "Any rentals coming up near Kentwood, Dana?", at: ago(14) }], "agent-7", touch, { fill, now: NOW });
  assert.doesNotMatch(spent.text, /rentals?|estates?/i, spent.text);
  // With noRepeat off it starts where it starts.
  assert.equal(pickVariant(CHECKIN_TEXTS, [{ text: first.text, at: ago(21) }], "agent-7", 0, { fill, noRepeat: false }).text, first.text);
  // Every one repeats: the first that fills, for the voice gate to hold.
  const all = CHECKIN_TEXTS.map((t) => ({ text: fill(t), at: ago(5) }));
  assert.ok(pickVariant(CHECKIN_TEXTS, all, "agent-7", 0, { fill, now: NOW }).text);
});

/* ---------- after a no, a "later", an auto-reply ---------- */

test("an agent who said a plain no twelve days ago hears nothing until day 30", () => {
  const { pack, r } = route([[40, "US", "Hey Dana, anything new on your end that needs real work?"], [12, "THEM", "No thanks"]]);
  assert.equal(pack.theirLast.read, "no");
  assert.equal(r.route, "skip");
  assert.equal(r.until, new Date(Date.parse(ago(12)) + 30 * DAY).toISOString());
  // The agent check-in waits on it past its own three weeks, and goes again
  // once day 30 is past.
  const agent = pulse({ lastInboundAt: ago(12), ledger: [skipped(r)] });
  const day22 = evaluateAgent(agent, ctx(NOW + 10 * DAY));
  assert.equal(day22.status, "not_due");
  assert.match(day22.reason, /the check-in waits: they said no on/);
  assert.equal(day22.dueAt, r.until);
  assert.equal(evaluateAgent(agent, ctx(NOW + 19 * DAY)).status, "due", "day 31");
  // A no thirty days back is old news: the check-in goes.
  assert.equal(route([[60, "US", "Hey Dana, anything new?"], [31, "THEM", "Nope"]]).r.route, "send");
  // "No, but I have one in Kentwood" is a lead, not a no.
  assert.notEqual(route([[40, "US", "Hey Dana, anything new?"], [12, "THEM", "No, but I have one in Kentwood coming"]]).pack.theirLast.read, "no");
});

test("an agent who said check back after the holidays hears nothing before then", () => {
  const { pack, r } = route([[40, "US", "Hey Dana, anything new that needs work?"], [10, "THEM", "Slow right now. Check back after the holidays"]]);
  assert.equal(pack.theirLast.read, "later");
  assert.equal(r.route, "skip");
  assert.match(r.until, /^2027-01-0\d/);
  assert.match(r.why, /they said to check back \(after the holidays\)/);
  // A dated check-in they asked for is theirs: it still goes on its day.
  assert.equal(routeCheckIn(pack, "checkin_due", {}, { sourceKind: "date", now: NOW }).route, "send");
  // "every couple of months": their own cadence, from when they said it.
  assert.equal(route([[40, "US", "Anything new?"], [20, "THEM", "Please only text me every couple of months"]]).r.route, "skip");
});

test("a number only an auto-reply has answered in 90 days is parked, not texted", () => {
  const { pack, r } = route([[30, "US", "Hi Dana, it's Matt. Anything around Kentwood that needs real work?"],
    [30, "THEM", "Thank you for your message, we will get back to you shortly."]], "outreach_nudge");
  assert.equal(pack.autoOnly, true);
  assert.equal(pack.theirLast.read, "auto");
  assert.equal(r.route, "skip");
  assert.equal(r.until, new Date(NOW + 90 * DAY).toISOString());
  assert.equal(route([[30, "US", "Anything new?"], [30, "THEM", "Thank you for your message, we will get back to you shortly."]], "offer_nudge").r.route, "skip", "every kind");
  // A person answered once in the window: not parked.
  assert.equal(route([[30, "US", "Anything new?"], [29, "THEM", "Thank you for your message, we will get back to you shortly."], [28, "THEM", "Hey sorry, nothing yet, will keep you posted"]]).pack.autoOnly, false);
  // Nobody ever answered: a cold agent, not an auto-reply.
  assert.equal(route([[30, "US", "Anything new?"]]).pack.autoOnly, false);
});

test("an agent whose phone auto-replies but who answers by email is not parked", () => {
  const lines = [[30, "US", "Anything new?"], [30, "THEM", "Thank you for your message, we will get back to you shortly."],
    [27, "THEM", "Saw your text, nothing on my end this month but I'll keep you in mind", "email"]];
  const { pack, r } = route(lines);
  assert.equal(pack.autoOnly, false);
  assert.equal(r.route, "send");
});

test("a homeowner never gets the agent check-in", () => {
  const { pack, r } = route([[200, "US", "Hi Pim, do you still own the house on Birch Ln? Would you consider selling?"], [199, "THEM", "Not right now"]]);
  assert.equal(pack.homeowner, true);
  assert.deepEqual([r.route, r.permanent], ["skip", true]);
  assert.equal(evaluateAgent(pulse({ lastInboundAt: ago(199), ledger: [skipped(r)] }), ctx()).status, "stopped");
  // An agent tag, or a first text about a listing, is an agent.
  assert.equal(route([[200, "US", "Hi Pim, do you still own the house on Birch Ln?"]], "agent_pulse", { context: { agentTagged: true } }).pack.homeowner, false);
  assert.equal(route([[200, "US", "Hi Pim, saw your listing on Birch Ln. Would the seller consider selling as is?"]]).pack.homeowner, false);
  // A buyer is never read as one.
  assert.equal(route([[200, "US", "Hi Pim, do you still own the house on Birch Ln?"]], "buyer_pulse", { party: "investor" }).r.route, "send");
});

/* ---------- are you a bot? ---------- */

test("an agent who asked whether this is AI gets no machine text for 30 days and the thread waits for Matt", () => {
  const { pack, r } = route([[20, "US", "Hey Dana, anything new on your end?"], [5, "THEM", "lol are you a bot?"]]);
  assert.equal(pack.theirLast.read, "ai_complaint");
  assert.equal(r.route, "matt");
  assert.equal(r.until, new Date(Date.parse(ago(5)) + 30 * DAY).toISOString());
  assert.match(r.key, /^ai:/);
  // Even a live number's nudge waits for Matt.
  assert.equal(routeCheckIn(pack, "offer_nudge", {}, { now: NOW }).route, "matt");
  // An auto-responder's "this is an automated message" is not them asking.
  assert.equal(route([[20, "US", "Anything new?"], [19, "THEM", "Hey, nothing yet"], [5, "THEM", "This is an automated message. I am out of the office until Monday."]]).pack.aiComplaint, null);
  // Past the 30 days, it's over.
  assert.equal(route([[60, "US", "Anything new?"], [35, "THEM", "is this AI"]]).r.route, "send");
  // The agent check-in waits on it.
  const w = checkInWait([skipped(r)], { lastInboundAt: ago(5), now: NOW });
  assert.equal(w.until, r.until);
});

test("a reply that only asks are you a bot is a question for Matt, never an opt-out", () => {
  for (const t of ["Are you a bot?", "is this AI lol", "Are u a real person"]) {
    assert.equal(asksIfBot(t), true, t);
    assert.equal(onlyAsksIfBot(t), true, t);
  }
  assert.equal(onlyAsksIfBot("Is this a bot? Stop texting me"), false);
  assert.equal(onlyAsksIfBot("are you a bot, take me off your list"), false);
  // Anything past the bare question leaves the model's opt-out read standing.
  for (const t of ["is this a bot? not interested", "Are you a bot? f off", "is this automated? go away", "is this AI? leave us alone", "are you a robot, this is spam"]) {
    assert.equal(onlyAsksIfBot(t), false, t);
  }
  assert.equal(asksIfBot("Thanks, A.I. Nolan here"), false, "initials are not a complaint");
  assert.deepEqual(botAskFlags({ asked: true }).length, 1);
  assert.deepEqual(botAskFlags({}), []);
});

/* ---------- our own word ---------- */

test("an agent we told we'd check back in a couple months hears nothing for 60 days", () => {
  const { pack, r } = route([[45, "THEM", "Nothing on my end right now"], [10, "US", "No problem, I'll check back in a couple months."]]);
  assert.equal(pack.laterUntil.by, "us");
  assert.equal(r.route, "skip");
  assert.match(r.why, /we said we'd check back/);
  assert.ok(Date.parse(r.until) >= NOW + 49 * DAY && Date.parse(r.until) <= NOW + 51 * DAY, r.until);
});

test("a live offer's nudge still goes after we said we'd back off", () => {
  const lines = [[45, "THEM", "Seller is thinking it over"], [3, "US", "All good, I'll check back in a couple months."]];
  assert.equal(route(lines, "agent_pulse").r.route, "skip");
  for (const kind of ["offer_nudge", "hot_push", "counter_nudge", "second_look", "promise_due", "price_drop", "address_chase"]) {
    assert.equal(route(lines, kind).r.route, "send", kind);
    assert.equal(isCriticalCheckIn(kind), true, kind);
  }
  // After a plain no too.
  assert.equal(route([[20, "US", "Our number stands"], [5, "THEM", "No thanks"]], "offer_nudge").r.route, "send");
  assert.equal(isCriticalCheckIn("checkin_due", "source"), false, "the weekly deal-source check-in is routine");
});

/* ---------- our number, taken back ---------- */

test("a check-in after we took our number back waits for Matt", () => {
  const offers = [{ id: "o1", address: "12 Fennel Ct, Kentwood, WA", status: "we_passed", statusAt: ago(9.5), sends: [{ ts: ago(10) }] }];
  const { pack, r } = route([[11, "THEM", "Send me your best number"], [10, "US", "We'd be at 300 on Fennel"], [9.5, "US", "Sorry, we have to pull that one back"]], "agent_pulse", { context: { offers } });
  assert.equal(pack.retracted.offerId, "o1");
  assert.equal(r.route, "matt");
  assert.match(r.why, /took our number back on 12 Fennel Ct/);
  // A pass a week after the number is just a pass.
  const later = [{ ...offers[0], statusAt: ago(3) }];
  assert.equal(route([[11, "THEM", "Send me your best"], [10, "US", "We'd be at 300"]], "agent_pulse", { context: { offers: later } }).pack.retracted, null);
});

/* ---------- the wait itself ---------- */

test("a skip is lifted by a word from them, and a past date is no wait", () => {
  const r = { route: "skip", why: "they said no on 2026-10-29", until: new Date(NOW + 18 * DAY).toISOString() };
  assert.ok(checkInWait([skipped(r, NOW - DAY)], { lastInboundAt: ago(12), now: NOW }));
  assert.equal(checkInWait([skipped(r, NOW - DAY)], { lastInboundAt: ago(0.5), now: NOW }), null, "they wrote since");
  assert.equal(checkInWait([skipped(r, NOW - DAY)], { now: NOW + 19 * DAY }), null, "its day came");
  assert.equal(checkInWait([], { now: NOW }), null);
});

/* ---------- the name they go by ---------- */

test("an agent who signs her texts with a short form of her name goes by it", () => {
  assert.equal(goesBySaid("Nothing yet, will keep an eye out\nKate", { first: "Katherine", ours: "Matt" }), "Kate");
  assert.equal(goesBySaid("Sounds good - Kat", { first: "Katherine" }), "Kat");
  assert.equal(goesBySaid("Please call me Bex, everyone does", { first: "Rebecca" }), "Bex");
  assert.equal(goesBySaid("I go by Rob", { first: "Robert" }), "Rob");
  // Not her name: our own, a different letter, a word, her own first name.
  assert.equal(goesBySaid("Thanks, Matt", { first: "Mara", ours: "Matt" }), "");
  assert.equal(goesBySaid("Talk soon\nMatt", { first: "Mara", ours: "Matt" }), "");
  assert.equal(goesBySaid("See you\nBen", { first: "Katherine" }), "");
  assert.equal(goesBySaid("call me tomorrow", { first: "Tom" }), "");
  assert.equal(goesBySaid("Nothing new\nThanks", { first: "Theo" }), "");
  assert.equal(goesBySaid("Nothing new\nKatherine", { first: "Katherine" }), "");
  assert.equal(goesByOf({ goes_by: [{ value: "Kat", at: ago(30) }, { value: "Kate", at: ago(2) }] }), "Kate");
  // "Call me Kate" opens the text as often as not.
  assert.equal(goesBySaid("Call me Kate, everyone does", { first: "Katherine" }), "Kate");
  assert.equal(goesBySaid("Call me\nIf anything comes up", { first: "Ian" }), "");
  // The fixed texts use it.
  const s = standardText({ kind: "agent_pulse", outbound: { mode: "template", reason: "general", segment: "engaged", touch: 0 }, name: "Katherine Vale", contactId: "a9", goesBy: "Kate" });
  assert.match(s.text, /\bKate\b/);
  assert.doesNotMatch(s.text, /Katherine/);
});

test("a town after a dash or a teammate signing her phone is never the name she goes by", () => {
  // Every fixed text would open on it ("Kirkland, any fixers…").
  assert.equal(goesBySaid("Showing went fine - Kirkland.", { first: "Katherine" }), "");
  assert.equal(goesBySaid("Busy week up here - Tacoma.", { first: "Tim" }), "");
  assert.equal(goesBySaid("Nothing new yet\nKevin", { first: "Kristin" }), "");
  // A short form still is.
  assert.equal(goesBySaid("Thx\nSteve", { first: "Steven" }), "Steve");
  assert.equal(goesBySaid("Sounds good\nJen", { first: "Jennifer" }), "Jen");
});

/* ---------- the one real thing (the composer, 2026-11-09) ---------- */
//
// Matt, 2026-11-09: check-ins personable and not AI, one real thing each; and
// at ~22:05, never a past property. Every word, town and street here is
// invented.

const { namesAHouse, namesBookHouse, checkInFlags, composeRoute, composerArm, normalizeCheckInComposer, CHECK_IN_COMPOSER_DEFAULTS,
  openingIndex, nothingToSay, checkInReport, LEAD_HOOK_DAYS } = await import("./check-in.js");
const fact = (value, d) => ({ value, at: ago(d) });
const packOf = (lines, context = {}, subject = {}) => checkInPack(thread(lines), subject, { party: "agent", ...context }, NOW);

test("the composer ships off, and its settings survive a save", () => {
  const c = normalizeConversationAi({}).checkIns;
  assert.deepEqual({ composer: c.composer, composerShare: c.composerShare, skipEmpty: c.skipEmpty, skipDays: c.skipDays, personal: c.personal },
    { ...CHECK_IN_COMPOSER_DEFAULTS });
  assert.equal(c.composer, "off");
  const typed = normalizeConversationAi({ checkIns: { composer: "loud", composerShare: 250, skipDays: 1, personal: "false" } }).checkIns;
  assert.deepEqual({ composer: typed.composer, composerShare: typed.composerShare, skipDays: typed.skipDays, personal: typed.personal },
    { composer: "off", composerShare: 100, skipDays: 7, personal: false });
  const on = normalizeConversationAi(normalizeConversationAi({ checkIns: { composer: "shadow", composerShare: 50 } })).checkIns;
  assert.equal(on.composer, "shadow");
  assert.equal(on.composerShare, 50);
  assert.equal(composeRoute({ pack: {}, kind: "agent_pulse", settings: c, contactId: "a1" }).mode, "off", "off: nothing changes");
});

test("an agent's trip is the check-in's one thing when it's under 60 days old", () => {
  const facts = { personal_details: [fact("heading to Maui with the kids next month", 20)] };
  const pack = packOf([[30, "US", "Hey Wren, anything new on your end that needs real work?"], [29, "THEM", "ok thanks"]], { facts });
  assert.equal(pack.hooks[0].kind, "personal");
  assert.match(pack.hooks[0].line, /Maui/);
  assert.equal(pack.hooks[0].anchor, "Maui");
  // Older than 60 days: not the one thing.
  const old = packOf([[30, "US", "Hey Wren, anything new?"]], { facts: { personal_details: [fact("heading to Maui with the kids", 75)] } });
  assert.equal(old.hooks.length, 0);
  // Switched off: never.
  assert.equal(packOf([], { facts, composer: { personal: false } }).hooks.length, 0);
});

test("a seller's surgery is never a check-in's personal touch", () => {
  for (const what of ["her seller is having surgery next month", "client going through a divorce, house may sell", "out for a week after knee surgery"]) {
    const pack = packOf([[30, "US", "Hey Wren, anything new?"]], { facts: { personal_details: [fact(what, 10)] } });
    assert.equal(pack.personal, null, what);
    assert.equal(pack.hooks.length, 0, what);
  }
});

test("a June summary is never the one thing in November", () => {
  const june = (d) => ({ type: "call_summary", at: ago(d), data: { summary: "Talked about how slow the Halden market has been this year.", transcribed: true } });
  const pack = packOf([[150, "THEM", "Market in Halden is slow, sellers are holding"], [140, "US", "Got it, thanks Wren."]],
    { calls: [june(150)], facts: { last_convo_summary: [fact("talked about the slow Halden market", 150)], personal_details: [fact("just back from Lisbon", 150)] } });
  assert.deepEqual(pack.hooks, [], "every one of them is months old");
  assert.equal(pack.lastSummary, null, "not even as background");
  // The same call last week is.
  const fresh = packOf([], { calls: [june(6)] });
  assert.equal(fresh.hooks[0].kind, "call");
});

test("an agent who called about her market is asked about that, and the check-in names no house", () => {
  const call = { type: "call_summary", at: ago(9), data: { transcribed: true,
    summary: "She said the Halden market is slow and her sellers are holding out for spring. She also brought up 1412 Pine St, which is listed." } };
  const pack = packOf([[20, "US", "Hey Wren, anything new on your end?"]], { calls: [call] });
  assert.equal(pack.hooks[0].kind, "call");
  assert.match(pack.hooks[0].line, /Halden market is slow/);
  assert.doesNotMatch(pack.hooks[0].line, /Pine|1412|listed/, "the call's topic, never its house");
  // A call that was only about a house is no one thing at all.
  const onlyHouse = packOf([], { calls: [{ type: "call_summary", at: ago(9), data: { transcribed: true, summary: "Went over 1412 Pine St and the seller's timeline." } }] });
  assert.equal(onlyHouse.call, null);
});

test("a check-in that names any past house or street is held, even a deal we closed together", () => {
  const flags = (t) => checkInFlags({ text: t });
  assert.match(flags("Still thinking about the Corvid Ln deal we did together. Got another?")[0], /^named a house \(Corvid Ln/);
  assert.match(flags("Hey Wren, the deal we did together was a good one. Got another like it?")[0], /^named a house \(the deal we did/);
  assert.match(flags("any word on 1412 Pine?")[0], /^named a house \(1412 Pine/);
  assert.match(flags("how's the house on Oak coming along?")[0], /^named a house/);
  assert.deepEqual(flags("Hey Wren, how's Halden treating you this fall? Anything rough sitting?"), [], "their town is their area, not a house");
  assert.equal(namesBookHouse("know 163rd didn't work out", ["11435 163rd Avenue Southeast, Halden, WA"]), "163rd");
  assert.equal(namesBookHouse("still buying around Auburn?", ["88 Auburn Way S, Auburn, WA"]), "", "a street word that's a town is the town");
  assert.equal(namesBookHouse("the main thing is timing", ["12 Main St, Halden, WA"]), "");
});

test("a check-in never says the place you called about", () => {
  for (const t of ["How did the place you called about turn out?", "Did that last one ever sell?", "Any news on the one we sent you?", "Whatever happened with the house you mentioned?"]) {
    assert.ok(namesAHouse(t), t);
  }
  // The lead line is how a lead is asked about, and names nothing.
  assert.equal(namesAHouse("any word on the one you said was coming up?"), "");
  assert.equal(namesAHouse("Anything on the market or off that needs real work?"), "");
  assert.equal(namesAHouse("Free for a quick one on Monday?"), "", "a day is not a street");
});

test("a model check-in written around their trip has to say it", () => {
  const hook = { kind: "personal", anchor: "Maui", line: "heading to Maui" };
  assert.deepEqual(checkInFlags({ text: "Hope Maui treated you well. Did any sellers call while you were gone?", hook }), []);
  assert.match(checkInFlags({ text: "Did any sellers call while you were gone?", hook })[0], /doesn't say the one thing \(Maui\)/);
  assert.match(checkInFlags({ text: "hope the trip was a good one. anything new come up while you were out?", hook: { kind: "personal" } })[0], /copied a voice example/);
});

test("composer on at share 50 splits agents by contact id", () => {
  const ids = Array.from({ length: 400 }, (_, i) => `c-${i}`);
  const model = ids.filter((id) => composerArm(id, 50) === "model");
  assert.ok(model.length > 150 && model.length < 250, `${model.length} of 400`);
  assert.equal(composerArm("c-7", 50), composerArm("c-7", 50), "an agent stays in one arm");
  assert.ok(ids.every((id) => composerArm(id, 100) === "model"));
  assert.ok(ids.every((id) => composerArm(id, 0) === "control"));
  const hook = { kind: "personal", key: "personal:x", from: "our notes" };
  const r = composeRoute({ pack: { hooks: [hook] }, kind: "agent_pulse", reason: "general", settings: { composer: "on", composerShare: 50 }, contactId: model[0] });
  assert.equal(r.mode, "model");
  const c = composeRoute({ pack: { hooks: [hook] }, kind: "agent_pulse", reason: "general", settings: { composer: "on", composerShare: 50 }, contactId: ids.find((id) => !model.includes(id)) });
  assert.equal(c.mode, "control");
  // Never a listing ping, the thank-you, Matt's 15 or the net under their text.
  for (const [kind, o] of [["agent_pulse", { reason: "fresh_listing" }], ["agent_pulse", { reason: "deal_thanks" }], ["agent_pulse", { forMatt: true }], ["checkin_due", { sourceKind: "unanswered" }], ["offer_nudge", {}]]) {
    assert.equal(composeRoute({ pack: { hooks: [hook] }, kind, ...o, settings: { composer: "on" }, contactId: model[0] }).mode, "off", `${kind} ${JSON.stringify(o)}`);
  }
});

test("with the composer on and nothing real to say, a general check-in waits two weeks", () => {
  const r = composeRoute({ pack: { hooks: [] }, kind: "agent_pulse", reason: "general", settings: { composer: "on" }, contactId: "a1", now: NOW });
  assert.equal(r.mode, "skip");
  assert.equal(r.why, "nothing real to say");
  assert.equal(r.until, new Date(NOW + 14 * DAY).toISOString());
  // A dated check-in they asked for is written anyway.
  assert.equal(composeRoute({ pack: { hooks: [] }, kind: "checkin_due", sourceKind: "date", settings: { composer: "on" }, contactId: "a1", now: NOW }).mode, "model");
  // skipEmpty off: today's text.
  assert.equal(composeRoute({ pack: { hooks: [] }, kind: "agent_pulse", reason: "general", settings: { composer: "on", skipEmpty: false }, contactId: "a1" }).mode, "fallback");
  assert.ok(nothingToSay({ reply: "", needsHuman: true, humanReason: "nothing real to say" }));
  assert.ok(!nothingToSay({ reply: "Hey", humanReason: "nothing real to say" }));
});

test("the weekly deal-source check-in skips a week with nothing new", () => {
  // Their words came before our last check-in: nothing new since.
  const lines = [[16, "THEM", "Will keep you in mind, Halden has been quiet lately"], [7, "US", "Hey Wren, anything turn up this week?"]];
  const pack = packOf(lines, { newerThan: ago(7) });
  assert.deepEqual(pack.hooks, []);
  const r = composeRoute({ pack, kind: "checkin_due", sourceKind: "source", settings: { composer: "on" }, contactId: "a1", now: NOW });
  assert.equal(r.mode, "skip");
  assert.equal(r.until, new Date(NOW + 7 * DAY).toISOString(), "until next week's");
  // Something new from them since: written.
  const fresh = packOf([...lines, [2, "THEM", "Halden finally picked up, sellers are calling again"]], { newerThan: ago(7) });
  assert.equal(fresh.hooks[0].kind, "their_words");
});

test("the check-in after an undated lead asks about that lead", () => {
  const lead = { what: "the one coming up", said: "I may have one coming up", at: ago(20), undated: true };
  const pack = packOf([[30, "THEM", "I may have one coming up"], [29, "US", "Sounds good, thanks Wren."]], {}, { lead });
  assert.equal(pack.hooks[0].kind, "lead");
  assert.match(pack.hooks[0].line, /any word on the one you said was coming up/);
  // With the composer off: the fixed lead line, in either mode.
  for (const mode of ["template", "ai"]) {
    const s = standardText({ kind: "agent_pulse", outbound: { mode, reason: "general", segment: "engaged", lead, touch: 0 }, name: "Wren Halloway", contactId: "a1" });
    assert.equal(s.set, "lead", mode);
    assert.match(s.text, /the one you said was coming/);
    assert.equal(namesAHouse(s.text), "");
  }
});

test("a lead older than 60 days is dropped", () => {
  const lead = (d) => ({ what: "the one coming up", at: ago(d), undated: true });
  assert.equal(packOf([], {}, { lead: lead(LEAD_HOOK_DAYS + 2) }).lead, null);
  assert.ok(packOf([], {}, { lead: lead(30) }).lead);
});

test("a buyer's pulse quotes what they said only when it's under six months old", () => {
  const quotes = [{ text: "We only want 3 bed ramblers north of the lake", at: ago(200) }, { text: "Mostly cosmetic flips in Halden for now", at: ago(40) },
    { text: "The one on Corvid Ln was too rough", at: ago(10) }];
  const pack = checkInPack("", {}, { party: "investor", quotes }, NOW);
  assert.deepEqual(pack.quotes.map((q) => q.text), ["Mostly cosmetic flips in Halden for now"], "not the old one, not the one naming a house");
  assert.equal(pack.hooks[0].kind, "quotes");
});

test("the composer opens a different way than our last text did, by the contact's own count", () => {
  const seen = new Set([0, 1, 2, 3].map((touch) => openingIndex({ touch, contactId: "a1" })));
  assert.ok(seen.size >= 2);
  for (let t = 0; t < 6; t++) assert.notEqual(openingIndex({ touch: t, contactId: "a1", ourLast: [{ text: "Wren, anything new on your end?" }] }), 1);
});

test("the check-ins report counts each arm's texts, replies within a week and opt-outs, and never a name", () => {
  const ev = [
    { type: "agent_pulse_texted", contactId: "a", at: ago(10), data: { checkIn: { arm: "model", hook: "personal" } } },
    { type: "text_summary", contactId: "a", at: ago(9), data: { inbound: "nice, thanks" } },
    { type: "agent_pulse_texted", contactId: "b", at: ago(10), data: { checkIn: { arm: "control", hook: null } } },
    { type: "unsubscribed", contactId: "b", at: ago(9) },
    { type: "agent_pulse_texted", contactId: "c", at: ago(10), data: {} },
    { type: "checkin_skipped", contactId: "d", at: ago(5), data: { why: "nothing real to say" } },
  ];
  const r = checkInReport(ev, { days: 30, now: NOW });
  assert.deepEqual(r.arms.model, { sent: 1, replied: 1, stops: 0, replyRate: 100 });
  assert.deepEqual(r.arms.control, { sent: 1, replied: 0, stops: 1, replyRate: 0 });
  assert.equal(r.arms.none.sent, 1);
  assert.equal(r.hooks.personal.replied, 1);
  assert.equal(r.skips["nothing real to say"], 1);
  assert.doesNotMatch(JSON.stringify(r), /nice, thanks/);
});

/* ---------- review fixes (2026-11-10) ---------- */

test("the cold check-in that names a town of two words is not held for a street that shares a word with it", () => {
  // The cold ladder names the town of the listing we first texted about. A
  // listing on a "Lake ..." street made "Lake" in "Lake Stevens" read as it.
  // (Streets and numbers invented; the towns are towns.)
  const cases = [
    ["Hey Jo, anything around Lake Stevens that needs real work?", ["1820 Lake Quillback Rd, Lake Stevens, WA 98000"]],
    ["Jo, how is Maple Valley treating you?", ["2201 Maple Fernhill Ln, Maple Valley, WA 98000"]],
    ["anything around Bonney Lake sitting?", ["9004 Lake Corvid Pkwy, Bonney Lake, WA 98000"]],
    ["anything around Fernhollow Bay that needs work?", ["41 Fernhollow Bay Rd, Fernhollow Bay, WA 98000"]],
  ];
  for (const [text, book] of cases) assert.equal(namesBookHouse(text, book), "", text);
  // The street itself still holds.
  assert.equal(namesBookHouse("any word on the Maple place?", ["2201 Maple Fernhill Ln, Maple Valley, WA 98000"]), "Maple");
  assert.equal(namesBookHouse("still thinking about 1820?", ["1820 Lake Quillback Rd, Lake Stevens, WA 98000"]), "1820");
});

test("every way of sounding the composer is shown asks one question, so the voice check never holds the shape it was taught", async () => {
  const { voiceFlags, hardVoiceKeys } = await import("./voice.js");
  const { CHECK_IN_VOICE_EXAMPLES, BUYER_VOICE_EXAMPLES } = await import("./check-in.js");
  for (const x of CHECK_IN_VOICE_EXAMPLES) assert.deepEqual(hardVoiceKeys(voiceFlags({ text: x, kind: "agent_pulse", channel: "sms", prior: [] })), [], x);
  for (const x of BUYER_VOICE_EXAMPLES) assert.deepEqual(hardVoiceKeys(voiceFlags({ text: x, kind: "buyer_pulse", channel: "sms", prior: [] })), [], x);
});

test("a one thing only the shadow or the control arm saw is still there for the model", async () => {
  const { spentHookKeys } = await import("./check-in.js");
  const texted = (arm, key) => ({ type: "agent_pulse_texted", at: ago(20), data: { checkIn: { arm, hook: "personal", key } } });
  assert.deepEqual(spentHookKeys([texted("shadow", "personal:a"), texted("control", "personal:b"), texted("model", "personal:c"), { type: "pulse_texted", data: { checkIn: { arm: "model", key: "quotes:d" } } }]),
    ["personal:c", "quotes:d"]);
  // And the report counts a one thing only where the model said it.
  const r = checkInReport([texted("shadow", "personal:a"), texted("model", "personal:c")].map((e, i) => ({ ...e, contactId: `c${i}` })), { days: 30, now: NOW });
  assert.equal(r.hooks.personal.sent, 1);
  assert.equal(r.arms.shadow.sent, 1);
});
