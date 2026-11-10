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
  // The fixed texts use it.
  const s = standardText({ kind: "agent_pulse", outbound: { mode: "template", reason: "general", segment: "engaged", touch: 0 }, name: "Katherine Vale", contactId: "a9", goesBy: "Kate" });
  assert.match(s.text, /\bKate\b/);
  assert.doesNotMatch(s.text, /Katherine/);
});
