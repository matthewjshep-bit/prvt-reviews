// opt-out-every-channel.test.mjs — an opt-out anywhere stops every machine
// text and email, for good; Matt's own texts still go (Matt, 2026-11-09).
//
// Until then each channel heard only itself: an agent who texted STOP still
// got the day-2 intro email and the check-in emails, and a buyer who
// unsubscribed from email still got deal texts. Real file store, fake GHL,
// the model stubbed. Every name, street and word here is invented.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opt-out-every-channel-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { normalizeConversationAi, starterConfig } = await import("./shared/conversation-ai.js");
const { runIntroEmails, runCheckInEmails } = await import("./outreach-email.js");
const { startReply, startProactive, sendReplyDraft, applyDraftAction, _resetJobs, listJobs } = await import("./reply-agent.js");
const { sendHandReply } = await import("./hand-reply.js");
const { queueBlastDrafts } = await import("./dispo-autopilot.js");
const { runOptOutBackfill, bookDnd } = await import("./opt-out.js");
const { introEmailDue } = await import("./shared/outreach-email.js");
await store.init();

const DAY = 86400000;
const NOW = Date.parse("2026-11-05T18:30:00Z");   // a Thursday, 10:30 Pacific
const ago = (d, now = NOW) => new Date(now - d * DAY).toISOString();
const LADDER = { steps: [2], repeatEvery: 14 };

/* ---------- a GHL that answers contacts, tags, notes and sends ---------- */

function ghl(contacts = {}, { search = [] } = {}) {
  const sent = []; const tags = []; const notes = [];
  const client = {
    call: async (p, opts = {}) => {
      const one = /^\/contacts\/([^/?]+)$/.exec(p);
      if (one && !opts.method) {
        const c = contacts[decodeURIComponent(one[1])];
        if (!c) throw Object.assign(new Error("GHL GET contact -> 404"), { status: 404 });
        return { contact: { id: one[1], tags: [], ...c } };
      }
      if (one) return { contact: {} };
      const tagged = /^\/contacts\/([^/?]+)\/tags$/.exec(p);
      if (tagged) { tags.push([decodeURIComponent(tagged[1]), opts.method || "POST", opts.body?.tags || []]); return {}; }
      if (/\/notes$/.test(p)) { notes.push(p); return {}; }
      if (p === "/conversations/messages") { sent.push({ type: opts.body?.type, contactId: opts.body?.contactId }); return { messageId: `m${sent.length}` }; }
      if (p.startsWith("/conversations/search")) return { conversations: [] };
      if (/customFields/.test(p)) return { customFields: [] };
      if (p === "/contacts/search") return { contacts: search, total: search.length };
      return {};
    },
  };
  return { client, sent, tags, notes };
}
const tagsOn = (calls, id) => calls.filter(([c, m]) => c === id && m === "POST").flatMap(([, , t]) => t);

const STARTER = starterConfig({ signer: "Matt" });
const AI = { ...STARTER, autoSend: { ...STARTER.autoSend, debounceSec: 0 } };
const SAVED = { aiApiKey: "k", company: { signer: "Matt" }, conversationAi: AI };

async function done(job, ms = 4000) {
  const until = Date.now() + ms;
  while (job && ["queued", "running", "waiting"].includes(job.status) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  return job;
}
const QUESTION = { intent: "question", confidence: "high", needsHuman: false, humanReason: "", summary: "Asked if we still buy around Kent.",
  reply: "Yes, still buying around Kent. Anything on your desk that needs work?", propertyAddress: "", counterAmount: 0 };

/* ---------- the emails to cold agents ---------- */

const ladderAi = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, ...LADDER } } } } } });
const emailSaved = (outreachAutopilot) => ({ aiApiKey: "k", conversationAi: ladderAi, outreachAutopilot: { enabled: true, ...outreachAutopilot } });
const noTouches = async () => null;

test("an agent who texted STOP gets no intro or check-in email", async () => {
  const loc = "loc-stop-email";
  const contacts = {
    "c-wren": { firstName: "Wren", email: "wren@example.com" },
    "c-tobias": { firstName: "Tobias", email: "tobias@example.com", dndSettings: { SMS: { status: "permanent" } } },
    "c-marisol": { firstName: "Marisol", email: "marisol@example.com" },
  };
  for (const id of Object.keys(contacts)) {
    await recordEvent({ store, locationId: loc, contactId: id, party: "agent", type: "outreach_sent", at: ago(2), address: "41 Lantern Way, Kent, WA 98031", source: "conversation", dedupeKey: `os:${id}` });
  }
  // Marisol's STOP was handled by the reply agent (the opt-out row), with no DND in GHL.
  await store.createReplyDraft({ locationId: loc, contactId: "c-marisol", status: "handled", channel: "sms", intent: "opt_out", inbound: "STOP", reply: "", flags: [], party: "agent" });
  const r = await runIntroEmails({ store, locationId: loc, saved: emailSaved({ introEmail: { enabled: true, autoSend: true } }), sendsEnabled: true, now: NOW,
    deps: { getContact: async (id) => contacts[id] || null, ourTouches: noTouches } });
  const by = Object.fromEntries(r.rows.map((x) => [x.contactId, x]));
  assert.equal(by["c-wren"].status, "scheduled");
  assert.equal(by["c-tobias"].status, "skipped");
  assert.equal(by["c-tobias"].reason, "they opted out (text or email)");
  assert.equal(by["c-marisol"].reason, "they opted out (text or email)");
  assert.equal((await store.listReplyDrafts(loc, { contactId: "c-tobias", limit: 5 })).length, 0);

  // The check-in emails, two weeks on: the same.
  const loc2 = "loc-stop-checkin";
  for (const id of Object.keys(contacts)) {
    await recordEvent({ store, locationId: loc2, contactId: id, party: "agent", type: "outreach_sent", at: ago(16), address: "41 Lantern Way, Kent, WA 98031", source: "conversation", dedupeKey: `os:${id}` });
    await recordEvent({ store, locationId: loc2, contactId: id, party: "agent", type: "outreach_email_queued", at: ago(14), source: "conversation", dedupeKey: `outreach_email:${id}` });
  }
  await store.createReplyDraft({ locationId: loc2, contactId: "c-marisol", status: "handled", channel: "sms", intent: "opt_out", inbound: "STOP", reply: "", flags: [], party: "agent" });
  const c = await runCheckInEmails({ store, locationId: loc2, saved: emailSaved({ checkInEmail: { enabled: true, autoSend: true } }), sendsEnabled: true, now: NOW,
    deps: { getContact: async (id) => contacts[id] || null, ourTouches: noTouches } });
  const cby = Object.fromEntries(c.rows.map((x) => [x.contactId, x]));
  assert.equal(cby["c-wren"].status, "scheduled");
  assert.equal(cby["c-tobias"].reason, "they opted out (text or email)");
  assert.equal(cby["c-marisol"].reason, "they opted out (text or email)");
});

test("an unsubscribed event ends the intro email the way an answer does", () => {
  const first = { type: "outreach_sent", at: ago(2), address: "41 Lantern Way" };
  assert.equal(introEmailDue({ events: [first], now: NOW }).due, true);
  assert.equal(introEmailDue({ events: [first, { type: "unsubscribed", at: ago(1) }], now: NOW }).due, false);
});

test("an agent who said take me off your list by text gets no check-in email", async () => {
  const loc = "loc-takeoff";
  _resetJobs();
  const contacts = { "c-ines": { firstName: "Ines", email: "ines@example.com", tags: ["agent"] } };
  const { client, tags } = ghl(contacts);
  await recordEvent({ store, locationId: loc, contactId: "c-ines", party: "agent", type: "outreach_sent", at: ago(16), address: "9 Quarry Rd, Auburn, WA 98002", source: "conversation", dedupeKey: "os:c-ines" });
  await recordEvent({ store, locationId: loc, contactId: "c-ines", party: "agent", type: "outreach_email_queued", at: ago(14), source: "conversation", dedupeKey: "outreach_email:c-ines" });
  let modelCalls = 0;
  const { job } = await startReply({ client, locationId: loc, saved: SAVED, store, contactId: "c-ines", message: "Please take me off your list, thanks",
    deps: { draft: async () => { modelCalls++; return QUESTION; } } });
  await done(job);
  assert.equal(job.intent, "opt_out", job.error || "");
  assert.equal(modelCalls, 0, "no model call for an opt-out");
  assert.ok(tagsOn(tags, "c-ines").includes("dnc"));
  const ev = await store.listContactEvents(loc, "c-ines", { types: ["unsubscribed"] });
  assert.equal(ev.length, 1, "the opt-out is on the record for good");
  assert.equal(ev[0].data.via, "sms_keyword");
  // Later: GHL says nothing (no DND, and say someone took the tag off).
  const r = await runCheckInEmails({ store, locationId: loc, saved: emailSaved({ checkInEmail: { enabled: true, autoSend: true } }), sendsEnabled: true, now: NOW,
    deps: { getContact: async () => ({ firstName: "Ines", email: "ines@example.com", tags: ["agent"] }), ourTouches: noTouches } });
  assert.equal(r.queued + r.drafted, 0);
});

test("a scheduled check-in email is dismissed when they opted out since it was queued", async () => {
  const loc = "loc-checkin-since";
  const { client, sent } = ghl({ "c-pell": { firstName: "Pell", email: "pell@example.com", tags: ["agent"] } });
  const d = await store.createReplyDraft({ locationId: loc, contactId: "c-pell", status: "scheduled", channel: "email", inbound: "", party: "agent",
    outbound: { kind: "checkin_email", address: "9 Quarry Rd", subject: "anything ugly lately", step: 16 }, reply: "Hi Pell,\n\nAnything ugly on your desk?\n\nMatt", intent: "checkin_email",
    flags: [], sendAt: ago(0.01) });
  await recordEvent({ store, locationId: loc, contactId: "c-pell", party: "agent", type: "unsubscribed", at: ago(0.5), source: "conversation", dedupeKey: "unsubscribed:c-pell", data: { via: "sms_keyword" } });
  const r = await sendReplyDraft({ client, store, locationId: loc, draftId: d.id, live: true, auto: true, readThread: async () => "", now: NOW });
  assert.equal(sent.length, 0, "nothing went");
  assert.match(String(r.skipped), /opted out/);
  const after = await store.getReplyDraft(d.id);
  assert.equal(after.status, "dismissed");
  assert.ok(after.flags.includes("they opted out, not sent"), after.flags.join(" | "));
});

/* ---------- machine texts after an email unsubscribe ---------- */

test("an agent who clicked unsubscribe on our email gets no machine text", async () => {
  const loc = "loc-email-unsub";
  _resetJobs();
  const contacts = { "c-oriel": { firstName: "Oriel", tags: ["agent"], dndSettings: { Email: { status: "active" } } } };
  const { client, sent } = ghl(contacts);
  let modelCalls = 0;
  const r = await startProactive({ client, locationId: loc, saved: SAVED, store, contactId: "c-oriel", kind: "agent_pulse", sendsEnabled: true,
    subject: { reason: "general", segment: "engaged", address: "", listing: null, house: null },
    deps: { draft: async () => { modelCalls++; return QUESTION; } } });
  await done(r.job);
  const held = r.job ? r.job.heldReason : r.skipped;
  assert.match(String(held), /they opted out \(unsubscribed from email\): the machine starts nothing; your own texts still go/);
  assert.equal(modelCalls, 0);
  assert.equal((await store.listReplyDrafts(loc, { contactId: "c-oriel", limit: 5 })).length, 0, "nothing drafted");

  // A check-in already counting down when they unsubscribed: binned at the send.
  const d = await store.createReplyDraft({ locationId: loc, contactId: "c-oriel", status: "scheduled", channel: "sms", inbound: "", party: "agent",
    outbound: { kind: "agent_pulse" }, reply: "Hey Oriel, anything coming up that needs work?", intent: "agent_pulse", flags: [], sendAt: ago(0.01) });
  const s = await sendReplyDraft({ client, store, locationId: loc, draftId: d.id, live: true, auto: true, readThread: async () => "", now: NOW });
  assert.equal(sent.length, 0);
  assert.match(String(s.skipped), /opted out/);
  assert.equal((await store.getReplyDraft(d.id)).status, "dismissed");
});

test("a cold agent who unsubscribed from email gets no ladder text", async () => {
  const loc = "loc-ladder-unsub";
  _resetJobs();
  const saved = { ...SAVED, conversationAi: { ...AI, parties: { ...AI.parties, agent: { ...AI.parties.agent,
    followUp: { ...(AI.parties.agent.followUp || {}), enabled: true, ladders: { outreach_nudge: { enabled: true, ...LADDER } } } } } } };
  const { client } = ghl({ "c-saoirse": { firstName: "Saoirse", tags: ["agent"], dndSettings: { Email: { status: "permanent" } } } });
  let modelCalls = 0;
  const r = await startProactive({ client, locationId: loc, saved, store, contactId: "c-saoirse", kind: "outreach_nudge", sendsEnabled: true,
    subject: { address: "77 Fennel Ct, Renton, WA 98058", step: 16, steps: [2, 16] },
    deps: { draft: async () => { modelCalls++; return QUESTION; } } });
  await done(r.job);
  assert.match(String(r.job ? r.job.heldReason : r.skipped), /they opted out/);
  assert.equal(modelCalls, 0);
  assert.equal((await store.listReplyDrafts(loc, { contactId: "c-saoirse", limit: 5 })).length, 0);
});

/* ---------- they write back after opting out ---------- */

test("an agent who opted out and writes back gets a draft that waits for Matt", async () => {
  const loc = "loc-writes-back";
  _resetJobs();
  const { client } = ghl({
    "c-ok": { firstName: "Bram", tags: ["agent"] },
    "c-dnc": { firstName: "Liesl", tags: ["agent", "dnc"] },
  });
  const run = async (contactId) => {
    const { job } = await startReply({ client, locationId: loc, saved: SAVED, store, contactId, sendsEnabled: true, message: "Are you still buying around Kent?",
      deps: { draft: async () => QUESTION } });
    await done(job);
    assert.equal(job.status, "done", job.error || job.heldReason || "");
    return store.getReplyDraft(job.draftId);
  };
  const ok = await run("c-ok");
  assert.equal(ok.status, "scheduled", "the same reply to anyone else sends itself");
  const held = await run("c-dnc");
  assert.equal(held.status, "draft");
  assert.equal(held.autoSend.decided, false);
  assert.equal(held.autoSendable, false);
  assert.ok(held.flags.includes("they opted out earlier: this waits for you"), held.flags.join(" | "));
  assert.equal(held.reply, QUESTION.reply, "drafted all the same: yours to send");
});

test("Matt can still send a hand text to an agent who opted out", async () => {
  const loc = "loc-hand";
  const contacts = { "c-thea": { firstName: "Thea", tags: ["agent", "dnc"], dndSettings: { Email: { status: "active" } } } };
  const { client, sent } = ghl(contacts);
  await recordEvent({ store, locationId: loc, contactId: "c-thea", party: "agent", type: "unsubscribed", at: ago(3), source: "conversation", dedupeKey: "unsubscribed:c-thea", data: { via: "sms_keyword" } });
  // The composer's dry run says so; the send still goes.
  const dry = await sendHandReply({ client, store, locationId: loc, contactId: "c-thea", text: "Hi Thea, quick one on 3 Birch Ln", live: false });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.optedOut?.via, "email_dnd");
  const smsSent = [];
  const live = await sendHandReply({ client, store, locationId: loc, contactId: "c-thea", text: "Hi Thea, quick one on 3 Birch Ln", live: true,
    deps: { sendSms: async (_c, x) => { smsSent.push(x.contactId); return { messageId: "h1" }; } } });
  assert.equal(live.ok, true);
  assert.deepEqual(smsSent, ["c-thea"]);
  // A held reply pressed Send by a person goes too.
  const d = await store.createReplyDraft({ locationId: loc, contactId: "c-thea", status: "draft", channel: "sms", inbound: "Is 3 Birch still yours?", party: "agent",
    reply: "Still ours, want the numbers?", intent: "question", flags: ["they opted out earlier: this waits for you"] });
  const pressed = await sendReplyDraft({ client, store, locationId: loc, draftId: d.id, live: true, auto: false, now: NOW });
  assert.equal(pressed.ok, true);
  assert.equal(sent.length, 1);
  assert.equal((await store.getReplyDraft(d.id)).status, "sent");
});

/* ---------- what counts, live ---------- */

test("an owner who says stop texting me inside a longer text, then sends one more word, gets silence", async () => {
  const loc = "loc-burst";
  _resetJobs();
  const { client, tags } = ghl({ "c-ober": { firstName: "Ober", tags: ["agent"] } });
  let modelCalls = 0;
  const deps = { debounceMs: 40, draft: async () => { modelCalls++; return QUESTION; } };
  const first = await startReply({ client, locationId: loc, saved: SAVED, store, contactId: "c-ober", message: "We're keeping the place in the family, so please stop texting me about it", deps });
  const second = await startReply({ client, locationId: loc, saved: SAVED, store, contactId: "c-ober", message: "Thanks", deps });
  await done(second.job);
  assert.equal(first.job.status, "superseded");
  assert.equal(second.job.intent, "opt_out", second.job.error || second.job.heldReason || "");
  assert.equal(modelCalls, 0, "silence, and nothing spent");
  assert.ok(tagsOn(tags, "c-ober").includes("dnc"));
  assert.equal((await store.listContactEvents(loc, "c-ober", { types: ["unsubscribed"] })).length, 1);
});

test("an agent who says stop by anytime it's vacant gets an answer, not an opt-out", async () => {
  const loc = "loc-stop-by";
  _resetJobs();
  const { client, tags } = ghl({ "c-vesna": { firstName: "Vesna", tags: ["agent"] } });
  let modelCalls = 0;
  const { job } = await startReply({ client, locationId: loc, saved: SAVED, store, contactId: "c-vesna", message: "Stop by anytime, it's vacant and on a lockbox",
    deps: { draft: async () => { modelCalls++; return { ...QUESTION, reply: "Great, I'll swing by this week." }; } } });
  await done(job);
  assert.equal(modelCalls, 1);
  assert.notEqual(job.intent, "opt_out");
  assert.ok(!tagsOn(tags, "c-vesna").includes("dnc"));
  assert.equal((await store.listContactEvents(loc, "c-vesna", { types: ["unsubscribed"] })).length, 0);
});

test("an agent who says stop, not interested gets a draft held for Matt and no stop tag", async () => {
  const loc = "loc-maybe";
  _resetJobs();
  const { client, tags } = ghl({ "c-runa": { firstName: "Runa", tags: ["agent"] } });
  const { job } = await startReply({ client, locationId: loc, saved: SAVED, store, contactId: "c-runa", sendsEnabled: true, message: "Stop, not interested",
    deps: { draft: async () => ({ ...QUESTION, intent: "rejection", reply: "Understood, thanks for letting me know.", summary: "Not interested." }) } });
  await done(job);
  assert.equal(job.status, "done", job.error || job.heldReason || "");
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft", "never sent by itself");
  assert.equal(d.autoSend.decided, false);
  assert.equal(d.needsHuman, true);
  assert.equal(d.humanReason, "this may be an opt-out: press Opt out if it is");
  assert.equal(d.optOutMaybe, true);
  assert.ok(!tagsOn(tags, "c-runa").includes("dnc"), "no stop tag");
  assert.equal((await store.listContactEvents(loc, "c-runa", { types: ["unsubscribed"] })).length, 0);
  const button = d.actions.find((a) => a.type === "mark_opted_out");
  assert.ok(button, "an Opt out button on the row");
  assert.equal(button.mode, "ask");
  // Matt presses it: on the record for good, and the reply doesn't go.
  await applyDraftAction({ client, store, locationId: loc, draftId: d.id, actionId: button.id });
  const ev = await store.listContactEvents(loc, "c-runa", { types: ["unsubscribed"] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.via, "you");
  assert.equal((await store.getReplyDraft(d.id)).status, "dismissed");
});

test("a second text after a maybe keeps the Opt out button and still waits for Matt", async () => {
  const loc = "loc-maybe-twice";
  _resetJobs();
  const { client, tags } = ghl({ "c-isolde": { firstName: "Isolde", tags: ["agent"] } });
  const deps = { draft: async () => ({ ...QUESTION, reply: "Still buying, yes. Which one did you have in mind?" }) };
  const first = await startReply({ client, locationId: loc, saved: SAVED, store, contactId: "c-isolde", sendsEnabled: true, message: "Stop, we went another way", deps });
  await done(first.job);
  assert.equal((await store.getReplyDraft(first.job.draftId)).optOutMaybe, true);
  const second = await startReply({ client, locationId: loc, saved: SAVED, store, contactId: "c-isolde", sendsEnabled: true, message: "Are you still buying around Kent though?", deps });
  await done(second.job);
  assert.equal(second.job.status, "done", second.job.error || second.job.heldReason || "");
  const d = await store.getReplyDraft(second.job.draftId);
  assert.equal(d.status, "draft", "never sent by itself");
  assert.equal(d.optOutMaybe, true, "the maybe carries over");
  assert.equal(d.humanReason, "this may be an opt-out: press Opt out if it is");
  assert.ok(d.actions.some((a) => a.type === "mark_opted_out" && a.mode === "ask"), "the Opt out button is still there");
  assert.ok(!tagsOn(tags, "c-isolde").includes("dnc"));
});

/* ---------- email ---------- */

test("an email that quotes an old message asking off is answered, not read as their opt-out", async () => {
  const loc = "loc-email-quoted";
  _resetJobs();
  const { client, tags } = ghl({ "c-halden": { firstName: "Halden", tags: ["agent"] } });
  let modelCalls = 0;
  const deps = { draft: async () => { modelCalls++; return QUESTION; } };
  const quoted = "Yes, 7 Thistle Ct is still available. Call me after 3.\n\nOn Tue, Nov 3, 2026 at 10:02 AM Corwin wrote:\n> Please take me off your list.";
  const { job } = await startReply({ client, locationId: loc, saved: SAVED, store, contactId: "c-halden", channel: "email", message: quoted, deps });
  await done(job);
  assert.equal(modelCalls, 1, "the model reads their words");
  assert.notEqual(job.intent, "opt_out");
  assert.ok(!tagsOn(tags, "c-halden").includes("dnc"));
  assert.equal((await store.listContactEvents(loc, "c-halden", { types: ["unsubscribed"] })).length, 0);

  // Said above the quote, it is theirs: an opt-out by email, for good.
  _resetJobs();
  const own = "Please take me off your list.\n\nOn Tue, Nov 3, 2026 at 10:02 AM Matt wrote:\n> Hi Halden, anything coming up that needs work?";
  const r = await startReply({ client, locationId: loc, saved: SAVED, store, contactId: "c-halden", channel: "email", message: own, deps });
  await done(r.job);
  assert.equal(r.job.intent, "opt_out", r.job.error || "");
  assert.equal(modelCalls, 1, "no model call for an opt-out");
  const ev = await store.listContactEvents(loc, "c-halden", { types: ["unsubscribed"] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.via, "email");
  assert.equal(ev[0].data.channel, "email");
});

/* ---------- buyers ---------- */

const OFFER = { id: "o-lantern", locationId: "loc-x", address: "41 Lantern Way, Kent, WA 98031", cashAmount: 300000, arv: 450000, repairs: 60000,
  deal: { stage: "under_contract", contractPrice: 300000, assignmentFee: 25000, investors: [] } };
const DISPO_SAVED = { aiApiKey: "k", conversationAi: { ...AI, parties: { ...AI.parties, investor: { ...AI.parties.investor, autoSend: { enabled: true, intents: ["blast_open"] } } } },
  dispoAutopilot: { spreadSec: 30 } };
const buyer = (contactId, name, over = {}) => ({ contactId, name, phone: "555-0100", tags: ["investor"], ...over });

test("a buyer who unsubscribed from email doesn't get the deal by text", async () => {
  const loc = "loc-buyer-email";
  // The book row carries it once the sync reads Email DND.
  assert.equal(bookDnd({ dndSettings: { Email: { status: "active" } } }), true);
  assert.equal(bookDnd({ dndSettings: { SMS: { status: "permanent" } } }), true);
  assert.equal(bookDnd({ id: "b-1" }, new Set(["b-1"])), true, "an unsubscribed event counts");
  assert.equal(bookDnd({ id: "b-2" }, new Set(["b-1"])), false);
  // A deal text already counting down when they unsubscribed: binned at the send. The deal is
  // live on the store: a deal text whose offer is gone reads as a deal taken back instead.
  await store.createOffer({ ...OFFER, id: "o-lantern-email", locationId: loc });
  const { client, sent } = ghl({ "b-ferro": { firstName: "Ferro", tags: ["investor"], dndSettings: { Email: { status: "active" } } } });
  const d = await store.createReplyDraft({ locationId: loc, contactId: "b-ferro", status: "scheduled", channel: "sms", inbound: "", party: "investor",
    outbound: { kind: "blast_open", offerId: "o-lantern-email", address: "41 Lantern Way" }, reply: "Hey Ferro, got 41 Lantern Way in Kent under contract.", intent: "blast_open", flags: [], sendAt: ago(0.01) });
  const r = await sendReplyDraft({ client, store, locationId: loc, draftId: d.id, live: true, auto: true, readThread: async () => "", now: NOW });
  assert.equal(sent.length, 0);
  assert.match(String(r.skipped), /opted out/);
  assert.equal((await store.getReplyDraft(d.id)).status, "dismissed");
});

test("a buyer who replied wrong number never gets a deal text", async () => {
  const loc = "loc-wrong-number";
  _resetJobs();
  const { client } = ghl({ "b-odile": { firstName: "Odile", tags: ["investor"] } });
  const { job } = await startReply({ client, locationId: loc, saved: SAVED, store, contactId: "b-odile", message: "wrong number",
    deps: { draft: async () => QUESTION } });
  await done(job);
  assert.equal(job.intent, "opt_out", job.error || "");
  const r = await queueBlastDrafts({ store, locationId: loc, offer: { ...OFFER, locationId: loc }, investors: [buyer("b-odile", "Odile"), buyer("b-kasimir", "Kasimir")],
    saved: DISPO_SAVED, now: NOW, sendsEnabled: true, blastsEnabled: true });
  const by = Object.fromEntries(r.rows.map((x) => [x.contactId, x]));
  assert.equal(by["b-odile"].status, "skipped");
  assert.equal(by["b-odile"].reason, "they opted out (text or email)");
  assert.equal(by["b-kasimir"].status, "scheduled");
  assert.equal((await store.listReplyDrafts(loc, { contactId: "b-odile", status: "scheduled", limit: 5 })).length, 0);
});

test("a buyer the bot told it would stop texting isn't sent the next deal", async () => {
  const loc = "loc-told-stop";
  const { client, sent } = ghl({ "b-junot": { firstName: "Junot", tags: ["investor"] } });
  const d = await store.createReplyDraft({ locationId: loc, contactId: "b-junot", status: "scheduled", channel: "sms", party: "investor",
    inbound: "these aren't my area at all", reply: "Understood, I won't text you again.", intent: "passing", flags: [], sendAt: ago(0.01) });
  const r = await sendReplyDraft({ client, store, locationId: loc, draftId: d.id, live: true, auto: true, readThread: async () => "", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1, "the reply itself goes");
  const ev = await store.listContactEvents(loc, "b-junot", { types: ["unsubscribed"] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.via, "asked_left_alone");
  const q = await queueBlastDrafts({ store, locationId: loc, offer: { ...OFFER, locationId: loc }, investors: [buyer("b-junot", "Junot")],
    saved: DISPO_SAVED, now: NOW, sendsEnabled: true, blastsEnabled: true });
  assert.equal(q.rows[0].status, "skipped");
  assert.equal(q.queued + q.drafted, 0);
});

test("a buyer who opted out and then asks for the deal gets it drafted, waiting for Matt", async () => {
  const loc = "loc-asked-after";
  const r = await queueBlastDrafts({ store, locationId: loc, offer: { ...OFFER, locationId: loc },
    investors: [buyer("b-tamsin", "Tamsin", { tags: ["investor", "dnc"], asked: true })],
    saved: DISPO_SAVED, now: NOW, sendsEnabled: true, blastsEnabled: true });
  assert.equal(r.queued, 0, "never sent by itself");
  assert.equal(r.rows[0].status, "draft");
  const d = await store.getReplyDraft(r.rows[0].draftId);
  assert.equal(d.status, "draft");
  assert.equal(d.autoSend.reason, "they opted out earlier — it waits for you");
});

test("a Find buyers blast skips a buyer tagged do-not-text", async () => {
  const loc = "loc-find-buyers";
  const r = await queueBlastDrafts({ store, locationId: loc, offer: { ...OFFER, locationId: loc },
    investors: [buyer("b-ysolde", "Ysolde", { tags: ["investor", "do-not-text"] }), buyer("b-dunstan", "Dunstan", { dnd: true }), buyer("b-perrin", "Perrin")],
    saved: DISPO_SAVED, now: NOW, sendsEnabled: true, blastsEnabled: true, label: "dispo-41-lantern-way" });
  const by = Object.fromEntries(r.rows.map((x) => [x.contactId, x]));
  assert.equal(by["b-ysolde"].status, "skipped");
  assert.equal(by["b-dunstan"].status, "skipped");
  assert.equal(by["b-perrin"].status, "scheduled");
  assert.equal(r.queued, 1);
});

test("a tag blast to buyers leaves off the ones who opted out", async () => {
  const { default: express } = await import("express");
  const { default: createDispoRouter } = await import("./routes/dispo.js");
  const loc = "loc-tag-blast";
  const row = (contactId, name, doc = {}) => ({ contactId, name, doc: { name, phone: "+12065550142", tags: ["investor"], ...doc }, buyboxText: "" });
  await store.upsertInvestors(loc, [
    row("b-amsel", "Amsel"),
    row("b-brannock", "Brannock", { dnd: true }),
    row("b-calloway", "Calloway", { tags: ["investor", "do-not-text"] }),
    row("b-dovecote", "Dovecote"),
  ]);
  // Dovecote said "wrong number" to the bot: on the record, nothing in GHL.
  await recordEvent({ store, locationId: loc, contactId: "b-dovecote", party: "investor", type: "unsubscribed", at: ago(2), source: "conversation", dedupeKey: "unsubscribed:b-dovecote", data: { via: "sms_keyword" } });
  const app = express();
  app.use(express.json());
  app.use("/api/dispo", createDispoRouter({ resolveLocation: () => ({ locationId: loc, client: ghl({}).client }) }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/dispo/blast`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactIds: ["b-amsel", "b-brannock", "b-calloway", "b-dovecote"], label: "41-lantern-way" }) }).then((x) => x.json());
    const by = Object.fromEntries(r.results.map((x) => [x.contactId, x]));
    assert.equal(by["b-amsel"].ok, true, JSON.stringify(by["b-amsel"]));
    for (const id of ["b-brannock", "b-calloway", "b-dovecote"]) {
      assert.equal(by[id].ok, false, id);
      assert.equal(by[id].skipped, true, id);
      assert.equal(by[id].error, "they opted out (text or email)", id);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ---------- gatekeepers ---------- */

test("an attorney who asked by email to be removed gets no gatekeeper text or email", async () => {
  const { runGatekeeperSweep } = await import("./gatekeeper-sweep.js");
  const loc = "loc-gatekeeper";
  const T = Date.parse("2026-11-03T17:05:00Z");
  await store.upsertGatekeepers(loc, [
    { gkKey: "wsba:90001", kind: "probate_attorney", doc: { name: "Hollis Brackwater", firstName: "Hollis", firm: "Brackwater Law", email: "hollis@example.com", phone: "2065550199" } },
  ]);
  await store.setGatekeeperStatus(loc, "wsba:90001", { status: "imported", contactId: "g-hollis", importedAt: new Date(T - DAY).toISOString() });
  await store.upsertGatekeeperHooks(loc, [{ hookKey: "probate:king:26-4-00001-1-sea", gkKey: "wsba:90001", kind: "estate",
    doc: { decedent: "Ada Example", county: "King", caseNo: "26-4-00001-1 SEA", firstPublished: "2026-10-28", house: { address: "5 Wicket Ln, Kent, WA 98032" } } }]);
  await recordEvent({ store, locationId: loc, contactId: "g-hollis", party: "gatekeeper", type: "import", at: new Date(T - DAY).toISOString(), source: "gatekeeper-import", ref: "gatekeeper:wsba:90001", dedupeKey: "import:g-hollis" });
  // Their "remove me" came by email; GHL has no DND on either channel.
  await store.createReplyDraft({ locationId: loc, contactId: "g-hollis", status: "handled", channel: "email", intent: "opt_out", inbound: "remove me", reply: "", flags: [], party: "gatekeeper" });
  const writes = [];
  const r = await runGatekeeperSweep({ locationId: loc, store, now: T,
    saved: { aiApiKey: "k", conversationAi: { enabled: true }, company: { name: "Shep Flips", signer: "Matt" }, outreachAutopilot: { gatekeepers: { enabled: true, dryRun: false } } },
    deps: { write: async (x) => { writes.push(x.step); return { subject: "Estate of Ada Example", body: "Hi Hollis", flags: [] }; },
      getContact: async () => ({ id: "g-hollis", email: "hollis@example.com", phone: "+12065550199" }) } });
  assert.equal(writes.length, 0, "nothing written");
  assert.equal(r.steps.drafted + r.steps.scheduled, 0);
  assert.equal(r.rows[0].waiting, "they opted out (text or email)");
});

/* ---------- the backfill ---------- */

test("the opt-out backfill dry run counts without writing and names no one", async () => {
  const loc = "loc-backfill";
  // Two handled opt-outs (one already marked), one hand dnc tag in GHL, one
  // bot-off tag only (not an opt-out), and a stranger.
  await store.createReplyDraft({ locationId: loc, contactId: "c-albin", contactName: "Albin Quarrington", status: "handled", channel: "sms", intent: "opt_out", inbound: "STOP", reply: "", flags: [], party: "agent" });
  await store.createReplyDraft({ locationId: loc, contactId: "c-brisa", contactName: "Brisa Tallowmere", status: "handled", channel: "sms", intent: "opt_out", inbound: "remove me", reply: "", flags: [], party: "agent" });
  await recordEvent({ store, locationId: loc, contactId: "c-brisa", party: "agent", type: "unsubscribed", at: ago(4), source: "ghl", dedupeKey: "unsubscribed:c-brisa", data: { via: "dnd" } });
  // Machine texts still waiting for the opted out, and one reply that isn't the machine's.
  const nudge = await store.createReplyDraft({ locationId: loc, contactId: "c-albin", status: "scheduled", channel: "sms", inbound: "", party: "agent", outbound: { kind: "outreach_nudge" }, reply: "Hi Albin, anything that needs work?", intent: "outreach_nudge", flags: [] });
  const email = await store.createReplyDraft({ locationId: loc, contactId: "c-cosmo", status: "draft", channel: "email", inbound: "", party: "agent", outbound: { kind: "checkin_email" }, reply: "Hi Cosmo", intent: "checkin_email", flags: [] });
  const reply = await store.createReplyDraft({ locationId: loc, contactId: "c-cosmo", status: "draft", channel: "sms", inbound: "who is this?", party: "agent", reply: "It's Matt.", intent: "question", flags: [] });
  const stranger = await store.createReplyDraft({ locationId: loc, contactId: "c-delphine", status: "scheduled", channel: "sms", inbound: "", party: "agent", outbound: { kind: "outreach_nudge" }, reply: "Hi Delphine", intent: "outreach_nudge", flags: [] });
  const search = [
    { id: "c-cosmo", firstName: "Cosmo", lastName: "Vellacourt", tags: ["agent", "DNC"] },
    { id: "c-eamon", firstName: "Eamon", lastName: "Pikeholt", tags: ["agent", "stop bot"] },
  ];
  const searched = [];
  const deps = { searchByTags: async (tags) => { searched.push(tags); return { contacts: search, truncated: false }; } };
  const optOutTags = ["dnc"];

  const dry = await runOptOutBackfill({ store, locationId: loc, optOutTags, dryRun: true, deps });
  assert.deepEqual({ contacts: dry.contacts, eventsWritten: dry.eventsWritten, draftsDismissed: dry.draftsDismissed }, { contacts: 3, eventsWritten: 2, draftsDismissed: 2 });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(searched[0].sort(), ["dnc", "unsubscribed"], "a bot-off tag is yours to take off again: not a permanent opt-out");
  const text = JSON.stringify(dry);
  for (const word of ["Albin", "Brisa", "Cosmo", "Eamon", "c-albin", "c-cosmo", "Quarrington", "Vellacourt"]) assert.ok(!text.includes(word), `names no one: ${word}`);
  assert.equal((await store.listContactEvents(loc, "c-albin", { types: ["unsubscribed"] })).length, 0, "a dry run writes nothing");
  assert.equal((await store.getReplyDraft(nudge.id)).status, "scheduled");

  const live = await runOptOutBackfill({ store, locationId: loc, optOutTags, dryRun: false, deps });
  assert.deepEqual({ contacts: live.contacts, eventsWritten: live.eventsWritten, draftsDismissed: live.draftsDismissed }, { contacts: 3, eventsWritten: 2, draftsDismissed: 2 });
  const ev = await store.listContactEvents(loc, "c-cosmo", { types: ["unsubscribed"] });
  assert.equal(ev[0].data.via, "backfill");
  assert.equal((await store.getReplyDraft(nudge.id)).status, "dismissed");
  assert.equal((await store.getReplyDraft(nudge.id)).dismissedBy, "opt_out");
  assert.equal((await store.getReplyDraft(email.id)).status, "dismissed");
  assert.equal((await store.getReplyDraft(reply.id)).status, "draft", "a reply to them is yours: left alone");
  assert.equal((await store.getReplyDraft(stranger.id)).status, "scheduled");
  assert.equal((await store.listContactEvents(loc, "c-eamon", { types: ["unsubscribed"] })).length, 0);
  const again = await runOptOutBackfill({ store, locationId: loc, optOutTags, dryRun: false, deps });
  assert.equal(again.eventsWritten + again.draftsDismissed, 0, "run twice, nothing twice");
});

test("the backfill route is dry unless told otherwise, and answers in counts", async () => {
  const { default: express } = await import("express");
  const { default: createOutreachRouter } = await import("./routes/outreach.js");
  const loc = "loc-backfill-route";
  await store.createReplyDraft({ locationId: loc, contactId: "c-fenwick", contactName: "Fenwick Lorrimer", status: "handled", channel: "sms", intent: "opt_out", inbound: "STOP", reply: "", flags: [], party: "agent" });
  const app = express();
  app.use(express.json());
  const router = createOutreachRouter({ resolveLocation: () => ({ locationId: loc, client: null }) });
  router.optOutBackfillDeps = { searchByTags: async () => ({ contacts: [], truncated: false }) };
  app.use("/api/outreach", router);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/outreach/opt-outs/backfill`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const dry = await post({});
    assert.equal(dry.ok, true, JSON.stringify(dry));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.contacts, 1);
    assert.ok(!JSON.stringify(dry).includes("Fenwick") && !JSON.stringify(dry).includes("c-fenwick"));
    assert.equal((await store.listContactEvents(loc, "c-fenwick", { types: ["unsubscribed"] })).length, 0);
    const live = await post({ dryRun: false });
    assert.equal(live.eventsWritten, 1);
    assert.equal((await store.listContactEvents(loc, "c-fenwick", { types: ["unsubscribed"] })).length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
