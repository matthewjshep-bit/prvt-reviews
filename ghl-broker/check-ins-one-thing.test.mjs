// check-ins-one-thing.test.mjs — a check-in names one real thing, never a
// past house, and waits when there's nothing to say (shared/check-in.js, the
// composer, 2026-11-09).
//
// Matt, 2026-11-09: "check-ins need to sound more personable and not AI"; and
// at ~22:05, "make sure the checkins dont reference past properties, that
// gets confusing and annoying too". The composer ships off: shadow writes the
// model's check-in beside the fixed one, on lets it send for a share of
// agents. Real file store, fake GHL with a thread, the model stubbed. Every
// name, town, street and word here is invented.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-ins-one-thing-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { recordEvent, learnFacts } = await import("./contact-record.js");
const { normalizeConversationAi, starterConfig } = await import("./shared/conversation-ai.js");
const { startReply, startProactive, sendReplyDraft, _resetJobs } = await import("./reply-agent.js");
const { planAgentPulse } = await import("./agent-pulse.js");
const { openerVariant } = await import("./shared/outreach-opener.js");
const { CHECKIN_TEXTS, LEAD_CHECKIN_TEXTS, fillTemplate } = await import("./shared/standard-texts.js");
await store.init();

const DAY = 86400000;
const NOW = Date.now();
const ago = (d) => new Date(NOW - d * DAY).toISOString();

/* ---------- a GHL with a thread per contact ---------- */

function ghl(contacts = {}, threads = {}) {
  const sent = [];
  const client = {
    call: async (p, opts = {}) => {
      const one = /^\/contacts\/([^/?]+)$/.exec(p);
      if (one && !opts.method) {
        const c = contacts[decodeURIComponent(one[1])];
        if (!c) throw Object.assign(new Error("GHL GET contact -> 404"), { status: 404 });
        return { contact: { id: one[1], phone: "+12065550142", tags: [], ...c } };
      }
      if (one) return { contact: {} };
      if (/^\/contacts\/[^/?]+\/tags$/.test(p) || /\/notes$/.test(p)) return {};
      if (p === "/conversations/messages") { sent.push({ contactId: opts.body?.contactId, message: opts.body?.message }); return { messageId: `m${sent.length}` }; }
      if (p.startsWith("/conversations/search")) {
        const id = new URLSearchParams(p.split("?")[1] || "").get("contactId");
        return { conversations: threads[id] ? [{ id: `cv-${id}` }] : [] };
      }
      const msgs = /^\/conversations\/cv-([^/?]+)\/messages/.exec(p);
      if (msgs) {
        const list = (threads[decodeURIComponent(msgs[1])] || []).map(([d, who, body], i) => ({
          id: `m-${i}`, dateAdded: ago(d), direction: who === "THEM" ? "inbound" : "outbound", messageType: "TYPE_SMS", body }));
        return { messages: { messages: list, nextPage: false } };
      }
      if (/customFields/.test(p)) return { customFields: [] };
      return {};
    },
  };
  return { client, sent };
}

const STARTER = starterConfig({ signer: "Matt" });
const withCheckIns = (checkIns, extra = {}) => ({ aiApiKey: "k", company: { signer: "Matt" },
  conversationAi: normalizeConversationAi({ ...STARTER, autoSend: { ...STARTER.autoSend, debounceSec: 0 }, checkIns: { ...(STARTER.checkIns || {}), ...checkIns } }), ...extra });
// The check-ins they asked for run on the agent follow-up's switch.
const withFollowUp = (saved) => ({ ...saved, conversationAi: normalizeConversationAi({ ...saved.conversationAi, parties: { ...saved.conversationAi.parties,
  agent: { ...saved.conversationAi.parties.agent, followUp: { ...(saved.conversationAi.parties.agent.followUp || {}), enabled: true } } } }) });
const NO_MODEL = { draft: async () => { throw new Error("the model must not be called"); } };
const GENERAL = { reason: "general", segment: "engaged", address: "", listing: null, house: null };
const said = (reply, extra = {}) => ({ intent: "agent_pulse", confidence: "high", needsHuman: false, humanReason: "", summary: "A check-in.", reply, propertyAddress: "", counterAmount: 0, ...extra });

async function done(job, ms = 4000) {
  const until = Date.now() + ms;
  while (job && ["queued", "running", "waiting"].includes(job.status) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  return job;
}
const draftsOf = async (loc, id) => store.listReplyDrafts(loc, { contactId: id, limit: 20 });
const skipsOf = async (loc, id) => store.listContactEvents(loc, id, { types: ["checkin_skipped"], limit: 20 });
const trip = (loc, id, d = 20) => learnFacts({ store, locationId: loc, contactId: id, party: "agent",
  facts: [{ key: "personal_details", value: "heading to Maui with the kids", source: "conversation", at: ago(d) }] });
// A pool check-in, filled for this name.
const isPoolText = (text, first) => CHECKIN_TEXTS.some((t) => fillTemplate(t, { first }) === text);
// Two contact ids, one in each arm at a 50% share.
const idsByArm = () => {
  const ids = Array.from({ length: 200 }, (_, i) => `c-arm-${i}`);
  return { model: ids.find((id) => openerVariant(id, 100) < 50), control: ids.find((id) => openerVariant(id, 100) >= 50) };
};

/* ---------- shadow, then on ---------- */

test("composer shadow sends the pool text and keeps the model's draft beside it, unsent", async () => {
  const loc = "loc-shadow";
  _resetJobs();
  await trip(loc, "c-wren");
  const { client, sent } = ghl({ "c-wren": { firstName: "Wren", tags: ["agent"] } }, {
    "c-wren": [[40, "US", "Hey Wren, any estates or tired rentals coming up on your end?"], [39, "THEM", "ok thanks"]],
  });
  const asked = [];
  const draft = async (args) => { asked.push(args.outbound); return said("Hope Maui treated you well. Did any sellers call while you were gone?"); };
  const r = await startProactive({ client, locationId: loc, saved: withCheckIns({ composer: "shadow" }), store, contactId: "c-wren", kind: "agent_pulse", sendsEnabled: false,
    subject: { ...GENERAL, touch: 1 }, deps: { draft } });
  await done(r.job);
  const [d] = await draftsOf(loc, "c-wren");
  assert.ok(d, r.job?.heldReason || r.job?.error || "drafted");
  assert.ok(isPoolText(d.reply, "Wren"), `today's text goes: ${d.reply}`);
  assert.equal(d.checkInShadow.reply, "Hope Maui treated you well. Did any sellers call while you were gone?");
  assert.equal(d.checkInShadow.hook, "personal");
  assert.equal(d.checkInShadow.held, false, JSON.stringify(d.checkInShadow.flags));
  assert.deepEqual(d.outbound.checkIn, { arm: "shadow", hook: "personal", detailKind: "our notes", key: d.outbound.checkIn.key });
  assert.equal(asked.length, 1, "one model call, for the shadow");
  assert.equal(asked[0].oneThing.kind, "personal");
  // What goes is today's text, never the shadow.
  const s = await sendReplyDraft({ client, store, locationId: loc, draftId: d.id, live: true, readThread: async () => "" });
  assert.equal(s.ok, true, s.skipped);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message, d.reply);
  const [texted] = await store.listContactEvents(loc, "c-wren", { types: ["agent_pulse_texted"], limit: 5 });
  assert.equal(texted.data.checkIn.arm, "shadow");
});

test("composer on at share 50 splits agents by contact id and stamps the arm on the draft and the texted event", async () => {
  const loc = "loc-split";
  const { model, control } = idsByArm();
  const saved = withCheckIns({ composer: "on", composerShare: 50 });
  const run = async (id) => {
    _resetJobs();
    await trip(loc, id);
    const { client, sent } = ghl({ [id]: { firstName: "Wren", tags: ["agent"] } }, {
      [id]: [[40, "US", "Hey Wren, any estates or tired rentals coming up on your end?"], [39, "THEM", "ok thanks"]],
    });
    const asked = [];
    const draft = async (args) => { asked.push(args.outbound); return said("Hope Maui treated you well. Did any sellers call while you were gone?"); };
    const r = await startProactive({ client, locationId: loc, saved, store, contactId: id, kind: "agent_pulse", sendsEnabled: false, subject: { ...GENERAL, touch: 0 }, deps: { draft } });
    await done(r.job);
    const [d] = await draftsOf(loc, id);
    assert.ok(d, r.job?.heldReason || r.job?.error || "drafted");
    await sendReplyDraft({ client, store, locationId: loc, draftId: d.id, live: true, readThread: async () => "" });
    const [texted] = await store.listContactEvents(loc, id, { types: ["agent_pulse_texted"], limit: 5 });
    return { d, asked, sent, texted };
  };
  const m = await run(model);
  assert.equal(m.d.reply, "Hope Maui treated you well. Did any sellers call while you were gone?", "the model's arm sends the model's text");
  assert.equal(m.asked.length, 1);
  assert.match(m.asked[0].oneThing.line, /Maui/);
  assert.equal(m.d.outbound.checkIn.arm, "model");
  assert.equal(m.d.outbound.checkIn.hook, "personal");
  assert.equal(m.texted.data.checkIn.arm, "model");
  assert.equal(m.texted.data.checkIn.hook, "personal");
  const c = await run(control);
  assert.ok(isPoolText(c.d.reply, "Wren"), `the control arm sends today's text: ${c.d.reply}`);
  assert.equal(c.asked.length, 0, "no model call for the control");
  assert.equal(c.d.outbound.checkIn.arm, "control");
  assert.equal(c.texted.data.checkIn.arm, "control");
});

test("with the composer on and nothing real to say, a general check-in waits two weeks", async () => {
  const loc = "loc-nothing";
  _resetJobs();
  const { client, sent } = ghl({ "c-oak": { firstName: "Oakley", tags: ["agent"] } }, {
    "c-oak": [[40, "US", "Hey Oakley, any estates or tired rentals coming up on your end?"], [39, "THEM", "ok thanks"]],
  });
  const r = await startProactive({ client, locationId: loc, saved: withCheckIns({ composer: "on" }), store, contactId: "c-oak", kind: "agent_pulse", sendsEnabled: true,
    subject: { ...GENERAL, touch: 1 }, deps: NO_MODEL });
  await done(r.job);
  assert.equal(r.job.status, "held");
  assert.equal(r.job.heldReason, "waits, not sent: nothing real to say");
  assert.equal((await draftsOf(loc, "c-oak")).length, 0, "nothing on the Desk");
  assert.equal(sent.length, 0);
  const [skip] = await skipsOf(loc, "c-oak");
  assert.equal(skip.data.why, "nothing real to say");
  assert.equal(Math.round((Date.parse(skip.data.until) - Date.parse(skip.at)) / DAY), 14);
  // The model may decline too: a hook, and it says there's nothing real to say.
  _resetJobs();
  await trip(loc, "c-elm");
  const { client: c2 } = ghl({ "c-elm": { firstName: "Elm", tags: ["agent"] } }, { "c-elm": [[40, "US", "Hey Elm, anything off-market lately that needs work?"]] });
  const r2 = await startProactive({ client: c2, locationId: loc, saved: withCheckIns({ composer: "on" }), store, contactId: "c-elm", kind: "agent_pulse", sendsEnabled: true,
    subject: { ...GENERAL, touch: 1 }, deps: { draft: async () => said("", { needsHuman: true, humanReason: "nothing real to say" }) } });
  await done(r2.job);
  assert.equal(r2.job.heldReason, "waits, not sent: nothing real to say");
  assert.equal((await draftsOf(loc, "c-elm")).length, 0);
});

test("the weekly deal-source check-in skips a week with nothing new", async () => {
  const loc = "loc-source-week";
  _resetJobs();
  const thread = { "c-fen": [[16, "THEM", "Will keep you in mind, Halden has been quiet lately"], [7, "US", "Hey Fen, anything turn up this week?"]] };
  const { client, sent } = ghl({ "c-fen": { firstName: "Fen", tags: ["agent"] } }, thread);
  const subject = { address: "", phrase: "", sourceKind: "source", week: 3, weeks: 6, said: "Will keep you in mind" };
  const r = await startProactive({ client, locationId: loc, saved: withFollowUp(withCheckIns({ composer: "on" })), store, contactId: "c-fen", kind: "checkin_due", sendsEnabled: true, subject, deps: NO_MODEL });
  assert.ok(r.job, r.skipped);
  await done(r.job);
  assert.equal(r.job.heldReason, "waits, not sent: nothing new since last week's check-in");
  assert.equal(sent.length, 0);
  const [skip] = await skipsOf(loc, "c-fen");
  assert.equal(Math.round((Date.parse(skip.data.until) - Date.parse(skip.at)) / DAY), 7, "next week's goes as usual");
  // Something new from them since last week: written, as week 3 of 6, in their own words.
  _resetJobs();
  const fresh = { "c-fen": [...thread["c-fen"], [2, "THEM", "Halden finally picked up, sellers are calling again"]] };
  const { client: c2 } = ghl({ "c-fen": { firstName: "Fen", tags: ["agent"] } }, fresh);
  const asked = [];
  const r2 = await startProactive({ client: c2, locationId: loc, saved: withFollowUp(withCheckIns({ composer: "on" })), store, contactId: "c-fen", kind: "checkin_due", sendsEnabled: true, subject,
    deps: { draft: async (args) => { asked.push(args.outbound); return said("Good to hear Halden picked up. Any of those callers have a place that needs real work?", { intent: "checkin_due" }); } } });
  await done(r2.job);
  assert.equal(asked.length, 1, r2.job.heldReason || r2.job.error || "");
  const { outboundOpening } = await import("./conversation-prompt.js");
  const brief = outboundOpening(asked[0]);
  assert.match(brief, /This is check-in 3 of 6/);
  assert.match(brief, /THE ONE THING, new since our last check-in: .*Halden finally picked up/);
});

/* ---------- never a past house ---------- */

test("a check-in that names any past house or street is held, even a deal we closed together", async () => {
  const loc = "loc-no-house";
  // The composer's own text: written once more, told why, then dropped.
  _resetJobs();
  await trip(loc, "c-ivy");
  const { client, sent } = ghl({ "c-ivy": { firstName: "Ivy", tags: ["agent"] } }, { "c-ivy": [[40, "US", "Hey Ivy, anything off-market lately that needs work?"]] });
  const fixes = [];
  const naming = async (args) => { fixes.push(args.outbound.fix || null); return said("Hope Maui treated you well. Still thinking about the Corvid Ln deal we did together. Got another?"); };
  const r = await startProactive({ client, locationId: loc, saved: withCheckIns({ composer: "on" }), store, contactId: "c-ivy", kind: "agent_pulse", sendsEnabled: true,
    subject: { ...GENERAL, touch: 0 }, deps: { draft: naming } });
  await done(r.job);
  assert.equal(fixes.length, 2, "written once more");
  assert.match(String(fixes[1]), /named a house \(Corvid Ln/);
  assert.match(r.job.heldReason, /^dropped, not sent: named a house \(Corvid Ln/);
  assert.equal((await draftsOf(loc, "c-ivy")).length, 0, "never on the Desk");
  assert.equal(sent.length, 0);
  // With the composer off, the model's agent check-in is held the same way.
  _resetJobs();
  const { client: c2 } = ghl({ "c-yew": { firstName: "Yew", tags: ["agent"] } }, { "c-yew": [[40, "US", "Hey Yew, anything off-market lately that needs work?"]] });
  const r2 = await startProactive({ client: c2, locationId: loc, saved: withCheckIns({ composer: "off" }, { outreachAutopilot: { pulse: { mode: "ai" } } }), store, contactId: "c-yew", kind: "agent_pulse",
    sendsEnabled: true, subject: { ...GENERAL, touch: 0 }, deps: { draft: async () => said("Hey Yew, the deal we did together was a good one. Got another like it?") } });
  await done(r2.job);
  assert.match(r2.job.heldReason, /^dropped, not sent: named a house \(the deal we did/);
});

test("a check-in never says the place you called about", async () => {
  const loc = "loc-called-about";
  _resetJobs();
  const { client } = ghl({ "c-ash": { firstName: "Ash", tags: ["agent"] } }, { "c-ash": [[30, "US", "Hey Ash, anything off-market lately that needs work?"]] });
  const r = await startProactive({ client, locationId: loc, saved: withCheckIns({ composer: "off" }, { outreachAutopilot: { pulse: { mode: "ai" } } }), store, contactId: "c-ash", kind: "agent_pulse",
    sendsEnabled: true, subject: { ...GENERAL, touch: 0 }, deps: { draft: async () => said("Hey Ash, how did the place you called about turn out?") } });
  await done(r.job);
  assert.match(r.job.heldReason, /^dropped, not sent: named a house \(the place you called/);
});

test("an agent who called about her market is asked about that, and the check-in names no house", async () => {
  const loc = "loc-called-market";
  _resetJobs();
  await recordEvent({ store, locationId: loc, contactId: "c-lark", party: "agent", type: "call_summary", at: ago(9), source: "call", dedupeKey: "call:lark",
    data: { transcribed: true, summary: "She said the Halden market is slow and her sellers are holding out for spring. She also brought up 1412 Pine St, which is listed." } });
  const { client } = ghl({ "c-lark": { firstName: "Lark", tags: ["agent"] } }, { "c-lark": [[30, "US", "Hey Lark, anything off-market lately that needs work?"]] });
  const asked = [];
  const r = await startProactive({ client, locationId: loc, saved: withCheckIns({ composer: "on" }), store, contactId: "c-lark", kind: "agent_pulse", sendsEnabled: true,
    subject: { ...GENERAL, touch: 0 }, deps: { draft: async (args) => { asked.push(args.outbound); return said("Halden still holding out for spring, or are your sellers starting to move?"); } } });
  await done(r.job);
  assert.equal(asked.length, 1, r.job.heldReason || "");
  assert.equal(asked[0].oneThing.kind, "call");
  assert.match(asked[0].oneThing.line, /Halden market is slow/);
  assert.doesNotMatch(JSON.stringify(asked[0].oneThing), /Pine|1412/, "the call's topic, never its house");
  const [d] = await draftsOf(loc, "c-lark");
  assert.equal(d.reply, "Halden still holding out for spring, or are your sellers starting to move?");
  assert.equal(d.outbound.checkIn.detailKind, "a call");
});

test("a buyer pulse never names a deal we sent them", async () => {
  const loc = "loc-buyer-house";
  _resetJobs();
  const { client, sent } = ghl({ "c-moss": { firstName: "Moss", tags: ["investor"] } }, { "c-moss": [[20, "US", "Deal on 4410 Corvid Ln in Halden, 3 bed, needs a full redo."]] });
  const subject = { dealsSent: 1, conversed: false, cities: ["Halden"], missing: ["price range"], pastHouses: ["4410 Corvid Ln, Halden, WA"], touch: 0, variant: 0 };
  const fixes = [];
  const r = await startProactive({ client, locationId: loc, saved: withCheckIns({ composer: "off" }), store, contactId: "c-moss", kind: "buyer_pulse", sendsEnabled: false, subject,
    deps: { draft: async (args) => { fixes.push(args.outbound.fix || null); return said("It's Matt. Was Corvid not your kind of house? What would fit?", { intent: "buyer_pulse" }); } } });
  await done(r.job);
  assert.equal(fixes.length, 2);
  assert.match(r.job.heldReason, /^dropped, not sent: named a house \(Corvid/);
  assert.equal(sent.length, 0);
  assert.equal((await draftsOf(loc, "c-moss")).length, 0);
});

/* ---------- a lead with no day ---------- */

test("I may have one coming up is a lead with no date", async () => {
  const loc = "loc-undated-lead";
  _resetJobs();
  const { client } = ghl({ "c-rue": { firstName: "Rue", tags: ["agent"] } });
  const QUIET = { intent: "small_talk", confidence: "high", needsHuman: false, humanReason: "", summary: "Nothing yet.", reply: "Sounds good, thanks Rue.", propertyAddress: "", counterAmount: 0 };
  const { job } = await startReply({ client, locationId: loc, saved: withCheckIns({}), store, contactId: "c-rue", sendsEnabled: false,
    message: "Nothing right now, but I may have one coming up", deps: { draft: async () => QUIET } });
  await done(job);
  const [req] = await store.listContactEvents(loc, "c-rue", { types: ["checkin_requested"], limit: 5 });
  assert.ok(req, job.error || "booked");
  assert.equal(req.data.kind, "lead");
  assert.equal(req.data.dueAt, null);
  assert.equal(req.data.undated, true);
  assert.equal(req.data.lead.what, "the one coming up");
});

test("the check-in after an undated lead asks about that lead, once", async () => {
  const loc = "loc-lead-asked";
  _resetJobs();
  await store.upsertContactProfile(loc, "c-teal", { party: "agent", name: "Teal Brookfield" });
  await recordEvent({ store, locationId: loc, contactId: "c-teal", party: "agent", type: "text_summary", at: ago(40), source: "conversation", dedupeKey: "ts:teal", data: { inbound: "may have one coming up" } });
  // Their word was the lead, 25 days back: past the two-week wait and the check-in's own three weeks.
  await recordEvent({ store, locationId: loc, contactId: "c-teal", party: "agent", type: "checkin_requested", at: ago(25), source: "conversation", dedupeKey: "lead:teal",
    data: { kind: "lead", dueAt: null, undated: true, phrase: "have one coming", lead: { what: "the one coming up", said: "I may have one coming up", via: "text" } } });
  const saved = withCheckIns({}, { outreachAutopilot: { pulse: { enabled: true, dailyCap: 5 } } });
  const plan = await planAgentPulse({ locationId: loc, saved, store, now: NOW });
  const pick = plan.picks.find((p) => p.contactId === "c-teal");
  assert.ok(pick, JSON.stringify(plan.verdicts?.find((v) => v.contactId === "c-teal")));
  assert.equal(pick.subject.lead.what, "the one coming up");
  const { client } = ghl({ "c-teal": { firstName: "Teal", tags: ["agent"] } }, { "c-teal": [[40, "THEM", "may have one coming up"], [39, "US", "Sounds good, thanks Teal."]] });
  const r = await startProactive({ client, locationId: loc, saved, store, contactId: "c-teal", kind: "agent_pulse", sendsEnabled: false,
    subject: { ...pick.subject, touch: pick.touch ?? 0 }, deps: NO_MODEL });
  await done(r.job);
  const [d] = await draftsOf(loc, "c-teal");
  assert.ok(d, r.job?.heldReason || r.job?.error || "drafted");
  assert.ok(LEAD_CHECKIN_TEXTS.some((t) => fillTemplate(t, { first: "Teal" }) === d.reply), d.reply);
  assert.equal(d.outbound.leadAt, ago(25));
  await sendReplyDraft({ client, store, locationId: loc, draftId: d.id, live: true, readThread: async () => "" });
  const [texted] = await store.listContactEvents(loc, "c-teal", { types: ["agent_pulse_texted"], limit: 5 });
  assert.equal(texted.data.leadAt, ago(25));
  // Asked once.
  const next = await planAgentPulse({ locationId: loc, saved, store, now: NOW + 30 * DAY });
  assert.equal(next.picks.find((p) => p.contactId === "c-teal")?.subject?.lead, undefined);
});
