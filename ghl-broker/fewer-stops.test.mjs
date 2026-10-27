// fewer-stops.test.mjs — the texts that made listing agents text STOP
// (2026-10-26).
//
// Matt: "we've gotten quite a few STOP messages recently … my feeling is we
// are hitting them too hard too frequently or not specific enough messaging,
// it sounds like a bot." The opt-out rate doubled the week of 10/19 (1.1% →
// 2.4% of agents texted). It wasn't how often: 54 of 74 had one text from us
// that week. It was what the text showed we hadn't looked at:
//   - agents asked in August about a house were asked about the same house
//     again on 10/19 ("is it a bit of a project?"), some after we'd told them
//     it was too turnkey for us;
//   - the "day-2" follow-up said "Not sure if that listing needs work",
//     and drew a STOP for every 4 replies, where the one that names the
//     house drew 34% replies and none;
//   - 99 follow-up texts went within 12 hours of an email ("Got your
//     messages. Please take me off your list").
// And the plain first texts (1.6% STOPs) can be saved as Matt's choice.
//
// Real file store, fake GHL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fewer-stops-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { listingAlreadyRaised } = await import("./shared/agent-pulse.js");
const { listingCheckInFor, outboundDescriptor, previewProactive } = await import("./reply-agent.js");
const { standardText, fillTemplate, CHECKIN_TEXTS } = await import("./shared/standard-texts.js");
const { normalizeOpener, DEFAULT_FOLLOW_UP_TEXTS, DAY_TWO_DEFAULT_FOLLOW_UP_TEXTS, PLAIN_DEFAULT_OPENER_EXAMPLES } = await import("./shared/outreach-opener.js");
const { introEmailDue, checkInEmailDue } = await import("./shared/outreach-email.js");
const { carrierFlags } = await import("./shared/carrier-words.js");

const DAY = 86400000;
const NOW = Date.parse("2026-10-19T19:00:00Z");
const iso = (t) => new Date(t).toISOString();

// The 10/19 thread, as the transcript reads it.
const AUGUST = [
  "[2026-08-25 13:25] US sms: Hi Kevin, came across your listing for 15421 12th Ave W. I'm local here in Seattle and buy places to fix up King and Pierce counties mostly. Is this one a bit of a project, or pretty turnkey?",
].join("\n");

/* ---------- the same house twice ---------- */

test("an agent asked about a house in August isn't asked about the same house again — they texted STOP", () => {
  assert.deepEqual(listingAlreadyRaised(AUGUST, "15421 12th Ave W, Lynnwood, WA 98087"), { at: "2026-08-25" });
  // GHL's old pass text glued the number to the word before it.
  const glued = "[2026-08-19 11:49] US sms: Hi Jodi reached out a couple weeks back about one of your listings3812 Sw Morgan St... after taking another look that ones probably too turnkey for us honestly.";
  assert.ok(listingAlreadyRaised(glued, "3812 SW Morgan St, Seattle, WA 98126"), "too turnkey for us, then 'is it a bit of a project?'");
  // Their own word about it counts too.
  assert.ok(listingAlreadyRaised("[2026-09-01 10:00] THEM sms: 20104 165th St E is pending already", "20104 165th St E, Bonney Lake, WA"));
});

test("a different house of theirs, or another number on the same street, is still news", () => {
  assert.equal(listingAlreadyRaised(AUGUST, "5317 E L St, Tacoma, WA"), null);
  assert.equal(listingAlreadyRaised(AUGUST, "15423 12th Ave W, Lynnwood, WA"), null);
  assert.equal(listingAlreadyRaised("[2026-08-25 13:25] US sms: offer of 15421 on 12th? no", ""), null, "no address, nothing to match");
});

const pulse = (segment) => outboundDescriptor({ kind: "agent_pulse", offer: null, saved: {},
  subject: { reason: "fresh_listing", segment, address: "15421 12th Ave W, Lynnwood, WA 98087", listing: { street: "15421 12th Ave W", city: "Lynnwood" }, hook: { kind: "listing" }, variant: 0 } });

test("a cold agent we already asked about that listing gets nothing — a new listing was the only reason to text them", () => {
  const r = listingCheckInFor({ kind: "agent_pulse", outbound: pulse("cold"), transcript: AUGUST });
  assert.match(r.skip, /15421 12th Ave W came up with them on 2026-08-25/);
  assert.equal(r.outbound, undefined);
});

test("an engaged agent gets the plain check-in instead of the listing one, naming no house", () => {
  const r = listingCheckInFor({ kind: "agent_pulse", outbound: pulse("engaged"), transcript: AUGUST });
  assert.equal(r.skip, undefined);
  assert.equal(r.outbound.reason, "general");
  assert.equal(r.outbound.listing, null);
  const t = standardText({ kind: "agent_pulse", outbound: r.outbound, name: "Kevin" }).text;
  assert.ok(CHECKIN_TEXTS.map((x) => fillTemplate(x, { first: "Kevin" })).includes(t), t);
  assert.doesNotMatch(t, /12th/);
});

test("a listing nobody has mentioned still gets its listing check-in", () => {
  const out = pulse("cold");
  assert.equal(listingCheckInFor({ kind: "agent_pulse", outbound: out, transcript: "" }).outbound, out);
  assert.equal(listingCheckInFor({ kind: "outreach_nudge", outbound: { reason: "fresh_listing" }, transcript: AUGUST }).skip, undefined, "other kinds aren't touched");
});

test("the preview of that check-in drafts nothing and says why", async () => {
  const client = { call: async (p) => {
    if (/^\/contacts\/c-kevin$/.test(p)) return { contact: { id: "c-kevin", firstName: "Kevin", tags: ["agent"] } };
    if (p.startsWith("/conversations/search")) return { conversations: [{ id: "conv-k", contactId: "c-kevin", lastMessageDate: Date.parse("2026-08-25T20:25:00Z") }] };
    if (p.startsWith("/conversations/conv-k/messages")) return { messages: { messages: [
      { id: "m1", direction: "outbound", messageType: "TYPE_SMS", dateAdded: "2026-08-25T20:25:00Z", body: "Hi Kevin, came across your listing for 15421 12th Ave W. Is this one a bit of a project, or pretty turnkey?" },
    ] } };
    return {};
  } };
  let modelCalls = 0;
  const r = await previewProactive({ client, locationId: "loc-stops", store, contactId: "c-kevin", kind: "agent_pulse", name: "Kevin",
    saved: { aiApiKey: "test-key", conversationAi: { enabled: true, persona: { name: "Matt" } } },
    subject: { reason: "fresh_listing", segment: "cold", address: "15421 12th Ave W, Lynnwood, WA 98087", listing: { street: "15421 12th Ave W", city: "Lynnwood" }, hook: { kind: "listing" } },
    deps: { draft: async () => { modelCalls++; return { reply: "x", summary: "s", confidence: "high" }; } } });
  assert.match(r.skipped || "", /came up with them on 2026-08-25/, JSON.stringify(r));
  assert.equal(modelCalls, 0);
});

/* ---------- the follow-up names the house ---------- */

test("the day-2 follow-up names their house instead of 'not sure if that listing needs work'", () => {
  const o = normalizeOpener({});
  assert.match(o.followUps[0], /\{address\}/);
  assert.doesNotMatch(o.followUps.join(" "), /not sure if that listing/i);
  for (const t of DEFAULT_FOLLOW_UP_TEXTS) assert.deepEqual(carrierFlags(fillTemplate(t, { first: "Randi", address: "2714 84th Dr NE" })), []);
  const nudge = outboundDescriptor({ kind: "outreach_nudge", offer: null, saved: {}, subject: { address: "2714 84th Dr NE, Marysville, WA", step: 2, steps: [2] } });
  assert.equal(standardText({ kind: "outreach_nudge", outbound: nudge, name: "Randi", contactId: "c-r" }).text,
    "Hey Randi, circling back on 2714 84th Dr NE. If it's not a fit, no worries. Any fixers or houses that need some TLC on your radar, on or off market?");
});

test("with no address the follow-up still goes, naming no house", () => {
  const nudge = outboundDescriptor({ kind: "outreach_nudge", offer: null, saved: {}, subject: { step: 2, steps: [2] } });
  assert.equal(standardText({ kind: "outreach_nudge", outbound: nudge, name: "Randi", contactId: "c-r" }).text, fillTemplate(DEFAULT_FOLLOW_UP_TEXTS[1], { first: "Randi" }));
});

test("a saved copy of the 10/20 follow-ups is read as never changed and gets today's", () => {
  assert.deepEqual(normalizeOpener({ followUps: DAY_TWO_DEFAULT_FOLLOW_UP_TEXTS }).followUps, DEFAULT_FOLLOW_UP_TEXTS);
  const mine = ["Hey {first}, my own follow-up?"];
  assert.deepEqual(normalizeOpener({ followUps: mine }).followUps, mine);
});

/* ---------- an email never the same day as a text ---------- */

const opened = { type: "outreach_sent", at: iso(NOW - 3 * DAY), address: "129 St E, Bonney Lake, WA" };

test("the intro email waits a day when the follow-up text went this morning — 'Got your messages. Please take me off your list'", () => {
  const nudged = { type: "follow_up_sent", at: iso(NOW - 2 * 3600000), data: { kind: "outreach_nudge", step: 2 } };
  assert.deepEqual(introEmailDue({ events: [opened, nudged], day: 2, now: NOW }), { due: false, reason: "we texted them today — the email goes tomorrow" });
  const r = introEmailDue({ events: [opened, nudged], day: 2, now: NOW + DAY });
  assert.equal(r.due, true, r.reason);
});

test("the intro email goes on its day when no text went that day", () => {
  assert.equal(introEmailDue({ events: [opened], day: 2, now: NOW }).due, true);
});

test("the check-in email waits a day after the check-in text too", () => {
  const start = NOW - 16 * DAY;
  const events = [
    { type: "outreach_sent", at: iso(start), address: "1 Elm St" },
    { type: "outreach_email_queued", at: iso(start + 2 * DAY) },
    { type: "follow_up_sent", at: iso(NOW - 3600000), data: { kind: "outreach_nudge", step: 16 } },
  ];
  assert.equal(checkInEmailDue({ events, steps: [2], repeatEvery: 14, now: NOW }).due, false);
  assert.equal(checkInEmailDue({ events, steps: [2], repeatEvery: 14, now: NOW + DAY }).due, true);
});

/* ---------- the plain first texts can be Matt's choice ---------- */

test("the plain first texts, saved on purpose, are kept rather than swapped for the defaults", () => {
  assert.deepEqual(normalizeOpener({ examples: PLAIN_DEFAULT_OPENER_EXAMPLES }).examples, PLAIN_DEFAULT_OPENER_EXAMPLES);
  const o = outboundDescriptor({ kind: "outreach_open", offer: null, saved: { outreachAutopilot: { opener: { examples: PLAIN_DEFAULT_OPENER_EXAMPLES } } },
    subject: { address: "25738 215th Ct SE, Maple Valley, WA", city: "Maple Valley", variant: 1 } });
  const t = standardText({ kind: "outreach_open", outbound: o, name: "Kale" }).text;
  assert.ok(t.length <= 160, t);
  assert.doesNotMatch(t, /I'm in Seattle|next flip project/);
});
