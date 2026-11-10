// voice-check.test.mjs — the one voice check where the machine's texts are
// written, queued and sent (shared/voice.js, 2026-11-09).
//
// Matt: check-ins have to read like him, not like AI. Until now each prompt
// carried its own banned list and only two outputs were checked after they
// were written; a check-in that sat queued while another text of ours went
// could say the same thing twice. A person pressing Send is never blocked.
//
// Every name, street and number below is invented. No port is bound.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-check-test-"));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { store: fileStore } = await import("./store.js");
const { recordEvent } = await import("./contact-record.js");
const { evaluateReplyGates, sendReplyDraft, walkStandard, callAskFor, voiceKindOf, voiceGateFlags,
  COUNTER_PASS_REPLY, NOT_OUR_KIND_REPLY, closedHoldReply, sentToSellerReply, deskFirstReply } = await import("./reply-agent.js");
const { buildUserContext, outboundOpening } = await import("./conversation-prompt.js");
const { runCheckInEmails, lintEmail } = await import("./outreach-email.js");
const { inviteMessage } = await import("./dataroom.js");
const { standardText } = await import("./shared/standard-texts.js");
const { VOICE_RULE, voiceFlags, hardVoiceKeys } = await import("./shared/voice.js");
const { normalizeConversationAi } = await import("./shared/conversation-ai.js");
const { DEFAULT_CHECK_IN_EMAILS, checkInEmailFor } = await import("./shared/outreach-email.js");
await fileStore.init();

const DAY = 86400000;
const NOW = Date.parse("2026-11-09T18:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const stamp = (t) => `${t.slice(0, 10)} ${t.slice(11, 16)}`;

/* ---------- a small store and GHL ---------- */

const fakeStore = (drafts = []) => {
  const rows = new Map(drafts.map((d) => [d.id, d]));
  const events = [];
  return {
    rows, events,
    async listReplyDrafts(_loc, { status = null, contactId = null } = {}) {
      const want = Array.isArray(status) ? new Set(status) : status ? new Set([status]) : null;
      return [...rows.values()].filter((d) => (!want || want.has(d.status)) && (!contactId || d.contactId === contactId))
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    },
    async getReplyDraft(id) { return rows.get(id) || null; },
    async updateReplyDraft(id, doc) { if (!rows.has(id)) return false; rows.set(id, doc); return true; },
    async createReplyDraft(doc) { const full = { ...doc, id: `n${rows.size + 1}`, createdAt: new Date(NOW).toISOString() }; rows.set(full.id, full); return full; },
    async listOffers() { return []; },
    async listContactEvents(_loc, contactId, { types = null } = {}) { return events.filter((e) => e.contactId === contactId && (!types || types.includes(e.type))); },
    async appendContactEvents(_loc, contactId, list) { for (const r of list) events.push({ ...r, contactId }); return { inserted: list.length, skipped: 0 }; },
    async getContactProfile() { return null; },
    async upsertContactProfile() { return {}; },
  };
};
function ghlStub() {
  const sent = [];
  const client = {
    call: async (p, opts = {}) => {
      if (/^\/contacts\/c1$/.test(p) && !opts.method) return { contact: { id: "c1", firstName: "Dana", lastName: "Quill", phone: "+12065550100", tags: ["agent"] } };
      if (p.endsWith("/notes") || p.endsWith("/tags")) return {};
      if (p.startsWith("/conversations/search")) return { conversations: [] };
      if (p === "/conversations/messages") { sent.push(opts.body); return { messageId: `m${sent.length}` }; }
      if (p.endsWith("/customFields")) return { customFields: [] };
      if (/^\/contacts\/c1$/.test(p)) return { contact: {} };
      throw new Error(`unexpected ${p}`);
    },
  };
  return { client, sent };
}
const checkIn = (over = {}) => ({
  id: "d1", locationId: "LOC", contactId: "c1", contactName: "Dana Quill", status: "scheduled", channel: "sms", party: "agent", intent: "agent_pulse", inbound: "",
  reply: "Hey Dana, anything new on your plate that needs real work?", outbound: { kind: "agent_pulse", reason: "general", segment: "engaged" },
  voiceKind: "agent_pulse", createdAt: new Date(NOW - 2 * 3600000).toISOString(), sendAt: new Date(NOW).toISOString(), flags: [], autoSend: { decided: true, reason: "" }, ...over,
});

/* ---------- the gate ---------- */

test("a dash, an exclamation mark or a sign-off in a machine check-in is held, but Matt pressing Send is never blocked", async () => {
  const draft = { intent: "agent_pulse", confidence: "high", needsHuman: false, reply: "Hey Dana — anything new that needs real work!" };
  const g = evaluateReplyGates({ draft, party: "agent", voice: { kind: "agent_pulse", prior: [] } });
  assert.equal(g.ok, false);
  assert.ok(g.flags.some((f) => /^reads like a machine: .*a dash.*an exclamation mark/.test(f)), g.flags.join(" · "));
  assert.deepEqual(evaluateReplyGates({ draft, party: "agent", voice: null }).flags.filter((f) => /reads like a machine/.test(f)), [], "the check off: nothing");
  const machineFlags = (g2) => g2.flags.filter((f) => /reads like a machine/.test(f));
  assert.deepEqual(machineFlags(evaluateReplyGates({ draft, party: "agent", voice: { kind: "agent_pulse", prior: [], machine: false } })), [], "Matt's own wording is only flagged on the page");

  // Leaving by itself: held, and it says why.
  const { client, sent } = ghlStub();
  const store = fakeStore([checkIn({ reply: "Hey Dana, anything new on your plate that needs real work? Thanks, Matt" })]);
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true, now: NOW, readThread: async () => "" });
  assert.match(r.skipped || "", /reads like a machine: a sign-off/);
  assert.equal(sent.length, 0);
  const held = await store.getReplyDraft("d1");
  assert.equal(held.status, "draft", "it waits for you, never binned");
  assert.ok(held.flags.some((f) => /^held: reads like a machine: a sign-off/.test(f)));

  // You pressing Send is you deciding.
  const r2 = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", text: "Hey Dana — anything new that needs real work? Thanks, Matt", live: true, now: NOW });
  assert.equal(r2.skipped, undefined, r2.skipped);
  assert.equal(sent.length, 1);
});

test("a check-in that sat queued while another text of ours went is held at send if it now repeats it", async () => {
  const went = "Hey Dana, any estates or tired rentals coming up on your end?";
  const at = new Date(NOW - 3600000).toISOString();
  const thread = `[${stamp(ago(20))}] US sms: Hi Dana, saw your listing on Alder Way.\n[${stamp(at)}] US sms: ${went}`;
  const { client, sent } = ghlStub();
  const store = fakeStore([
    { id: "d0", locationId: "LOC", contactId: "c1", status: "sent", channel: "sms", party: "agent", reply: went, sentText: went, sentAt: at, createdAt: at, outbound: { kind: "passed_checkin" } },
    checkIn({ reply: "Hi Dana, any estates or tired rentals coming up on your end?" }),
  ]);
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true, now: NOW, readThread: async () => thread });
  assert.match(r.skipped || "", /repeats us/);
  assert.equal(sent.length, 0);
  assert.equal((await store.getReplyDraft("d1")).status, "draft");
  // The same check-in against a thread that never said it goes.
  const { client: c2, sent: s2 } = ghlStub();
  const fresh = fakeStore([checkIn({ reply: "Hi Dana, any estates or tired rentals coming up on your end?" })]);
  const ok = await sendReplyDraft({ client: c2, store: fresh, locationId: "LOC", draftId: "d1", live: true, auto: true, now: NOW, readThread: async () => `[${stamp(ago(20))}] US sms: Hi Dana, saw your listing on Alder Way.` });
  assert.equal(ok.skipped, undefined, ok.skipped);
  assert.equal(s2.length, 1);
});

test("a check-in queued before the voice check existed is held at send only for a repeat", async () => {
  const { client, sent } = ghlStub();
  const store = fakeStore([checkIn({ voiceKind: undefined, reply: "Hi Dana, circling back. Anything new that needs work?" })]);
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true, now: NOW, readThread: async () => "" });
  assert.equal(r.skipped, undefined, r.skipped);
  assert.equal(sent.length, 1);
});

test("Matt's own saved first text with a tell still sends by itself", async () => {
  const { client, sent } = ghlStub();
  const mine = "Hi Dana, saw your listing at 1820 Alder Way. I'm local and fix up houses. If you've got other fixers on your radar, I'm all ears.";
  const store = fakeStore([checkIn({ intent: "outreach_open", reply: mine, outbound: { kind: "outreach_open", address: "1820 Alder Way, Kentwood, WA" }, voiceKind: "outreach_open", voiceOwn: true })]);
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true, now: NOW, readThread: async () => "" });
  assert.equal(r.skipped, undefined, r.skipped);
  assert.equal(sent.length, 1);
  // The app's own text with the same tell would have waited.
  assert.ok(hardVoiceKeys(voiceFlags({ text: mine, kind: "outreach_open" })).includes("I'm all ears"));
});

test("the voice check reads a cold agent's texts by their own length and day 2 by its own rule", () => {
  assert.equal(voiceKindOf("outreach_nudge", { stepIndex: 1 }), "day_two");
  assert.equal(voiceKindOf("outreach_nudge", { repeats: true, stepIndex: 0 }), "cold_ladder");
  assert.equal(voiceKindOf("agent_pulse", { segment: "cold", reason: "general" }), "agent_checkin_cold");
  assert.equal(voiceKindOf("agent_pulse", { segment: "cold", reason: "fresh_listing" }), "agent_listing_cold");
  assert.equal(voiceKindOf("agent_pulse", { segment: "engaged" }), "agent_pulse");
  const long = `Hi Dana, ${"anything around Kentwood that needs work ".repeat(4)}?`;
  assert.ok(voiceGateFlags(long, { kind: "agent_checkin_cold", prior: [] })[0].includes("over 160"));
  assert.deepEqual(voiceGateFlags("Hey Dana, circling back on 1820 Alder Way. Got anything rougher?", { kind: "day_two", prior: [] }), [], "day 2 may circle back, once");
  assert.ok(voiceGateFlags("Hey Dana, circling back on 1820 Alder Way. Got anything rougher?", { kind: "day_two", prior: [{ text: "Hey Dana, circling back on 9 Birch Ln." }] }).length);
  assert.deepEqual(voiceGateFlags("Anything new, Dana? Thanks, Matt", { kind: "agent_pulse", prior: [], signOff: "Thanks, Matt" }), [], "the persona's own sign-off is his setting");
});

test("a fixed check-in the voice check holds walks to the next one along, with no model call", () => {
  const outbound = { mode: "template", reason: "general", segment: "engaged", variant: 0 };
  const first = standardText({ kind: "agent_pulse", outbound, name: "Dana" });
  const prior = [{ text: first.text, at: ago(14) }];
  const gateFor = (d) => evaluateReplyGates({ draft: { confidence: "high", needsHuman: false, ...d }, party: "agent", voice: { kind: "agent_pulse", prior, now: NOW } });
  const held = gateFor({ ...first, reply: first.text, intent: "agent_pulse" });
  assert.ok(held.flags.some((f) => /repeats us/.test(f)), held.flags.join(" · "));
  const walked = walkStandard({ draft: { reply: first.text, standard: { set: first.set, index: first.index } }, kind: "agent_pulse", offer: null, outbound, name: "Dana", contactId: "c1", gateFor });
  assert.ok(walked, "a later variant passes");
  assert.notEqual(walked.draft.reply, first.text);
  assert.equal(walked.gate.clean, true, walked.gate.flags.join(" · "));
});

/* ---------- the canned replies ---------- */

test("a counter we pass on ends with the next-one question", () => {
  assert.match(COUNTER_PASS_REPLY, /Got anything else that needs work or would be a good flip\?$/);
  assert.doesNotMatch(COUNTER_PASS_REPLY, /keep me in mind|I'm here/i);
  assert.match(NOT_OUR_KIND_REPLY, /\?$/);
  for (const t of [COUNTER_PASS_REPLY, NOT_OUR_KIND_REPLY, closedHoldReply({ amount: "410k", where: "Alder Way" }), sentToSellerReply({ first: "Dana", forms: "NWMLS" }),
    sentToSellerReply({}), deskFirstReply({ street: "Alder Way", priced: true }), deskFirstReply({ street: "Alder Way" })]) {
    assert.deepEqual(voiceFlags({ text: t, kind: "reply" }), [], t);
  }
  assert.doesNotMatch(sentToSellerReply({ first: "Dana" }), /^Sounds good/, "no stock opener");
});

test("the package invite reads like Matt and opens on no name when there isn't one", () => {
  const room = { address: "1820 Alder Way, Kentwood, WA 98000", snapshot: { numbers: { investorPrice: 250000 } } };
  const t = inviteMessage({ room, invite: { name: "Dana Quill" }, link: "https://example.test/d/abc" });
  assert.match(t, /^Hi Dana, here's the package on 1820 Alder Way \(/);
  assert.deepEqual(hardVoiceKeys(voiceFlags({ text: t, kind: "canned" })).filter((k) => k !== "a dollar sign" && k !== "a link"), [], t);
  assert.match(inviteMessage({ room, invite: { name: "" }, link: "https://example.test/d/abc" }), /^Here's the package on 1820 Alder Way/);
});

/* ---------- the prompts ---------- */

test("every text the machine starts carries the one voice rule, and a redraft is told our last text", () => {
  const out = buildUserContext({ party: "agent", outbound: { kind: "agent_pulse", reason: "general", segment: "engaged" }, transcript: "" });
  assert.ok(out.includes(VOICE_RULE));
  assert.ok(!buildUserContext({ party: "agent", message: "Is it still available?", transcript: "" }).includes(VOICE_RULE), "an answer to them has HUMAN, not this");
  const again = outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged", fix: ["reads like a machine: repeats us"], ourLast: "Hey Dana, anything new on your plate?" });
  assert.match(again, /OUR LAST TEXT TO THEM SAID: "Hey Dana, anything new on your plate\?"\. Open differently/);
  assert.doesNotMatch(outboundOpening({ kind: "agent_pulse", reason: "general", segment: "engaged" }), /OUR LAST TEXT/);
});

// 2026-11-09 review: two prompts still handed the model a phrase the voice
// check holds: the cold ladder's "checking in … distressed or value-add …
// come across their desk", and a check-in they asked for with no phrase of
// theirs, "you'd mentioned circling back". The model said it, the check held
// it, and the redraft could drop the text.
test("no machine prompt hands the model a phrase the voice check holds", () => {
  const ladder = outboundOpening({ kind: "outreach_nudge", repeats: true, stepIndex: 0, address: "1820 Alder Way", home: "Seattle" });
  assert.doesNotMatch(ladder, /value-add|checking in|across their desk/i, ladder);
  for (const sourceKind of ["lead", "asked"]) {
    const due = outboundOpening({ kind: "checkin_due", sourceKind, phrase: "", lead: null });
    assert.doesNotMatch(due, /circling back/i, due);
  }
});

/* ---------- the first reply ---------- */

test("our first text's ask for other fixers, recorded or in the thread, means the first reply doesn't ask again", () => {
  const T0 = Date.parse("2026-11-07T17:00:00Z");
  const at = new Date(T0).toISOString();
  const open = [{ type: "outreach_sent", at }];
  assert.equal(callAskFor({ events: open, transcript: "", message: "it's turnkey" }).alreadyAsked, undefined);
  assert.equal(callAskFor({ events: [...open, { type: "fixers_asked", at }], transcript: "", message: "it's turnkey" }).alreadyAsked, true);
  // A first text the GHL workflow sent: only the thread shows it.
  const enrolled = [{ type: "outreach_enrolled", at, data: { kind: "open" } }];
  const thread = "[2026-11-07 17:01] US sms: Hi Dana, saw your listing on Alder Way. Any other fixers on your radar?\n[2026-11-07 19:00] THEM sms: it's turnkey";
  assert.equal(callAskFor({ events: enrolled, transcript: thread, message: "it's turnkey" }).alreadyAsked, true);
  assert.equal(callAskFor({ events: enrolled, transcript: thread.replace(" Any other fixers on your radar?", " Is it a project?"), message: "it's turnkey" }).alreadyAsked, undefined);
});

/* ---------- the agent emails at queue ---------- */

const AI = normalizeConversationAi({ enabled: true, parties: { agent: { followUp: { enabled: true, ladders: { outreach_nudge: { enabled: true, steps: [2], repeatEvery: 14 } } } } } });
const getContact = async (id) => ({ "c-email": { firstName: "Brenda", email: "brenda@example.com" } })[id] || null;

test("a check-in email whose body matches the last one we sent isn't queued as is, and the queued draft carries its flags", async () => {
  const loc = "loc-voice-email";
  await recordEvent({ store: fileStore, locationId: loc, contactId: "c-email", party: "agent", type: "outreach_sent", at: ago(16), address: "14820 SE 172nd St, Renton, WA", source: "conversation", dedupeKey: "os:c-email" });
  await recordEvent({ store: fileStore, locationId: loc, contactId: "c-email", party: "agent", type: "outreach_email_queued", at: ago(14), source: "conversation", dedupeKey: "oe:c-email" });
  // What it would have picked, already sent to them last time.
  const would = checkInEmailFor({ checkInEmail: {}, name: "Brenda", contactId: "c-email", n: 1, address: "14820 SE 172nd St, Renton, WA" });
  const prior = [{ text: would.body, at: ago(30) }];
  const saved = { aiApiKey: "k", conversationAi: AI, outreachAutopilot: { enabled: true, checkInEmail: { enabled: true, autoSend: true } } };
  const r = await runCheckInEmails({ store: fileStore, locationId: loc, saved, sendsEnabled: true, now: NOW, deps: { getContact, priorEmails: async () => prior } });
  assert.equal(r.queued, 1, JSON.stringify(r.rows));
  const [draft] = await fileStore.listReplyDrafts(loc, { contactId: "c-email", limit: 5 });
  assert.notEqual(draft.reply, would.body, "the next one along instead");
  assert.notEqual(draft.outbound.emailIndex, would.index);
  assert.deepEqual(draft.voiceFlags, []);
  assert.equal(draft.voiceKind, "checkin_email");

  // Nothing else to send instead: it waits for you, saying why.
  const l = lintEmail({ email: would, kind: "checkin_email", prior, walk: () => would });
  assert.ok(l.hard.some((k) => /repeats us/.test(k)));
  // Only our last six count: an email sent seven or more back is fair again.
  const six = DEFAULT_CHECK_IN_EMAILS.map((_, i) => ({ text: checkInEmailFor({ checkInEmail: {}, name: "Brenda", contactId: "c-email", n: 1, shift: i, address: "14820 SE 172nd St, Renton, WA" }).body, at: ago(30 + i) }));
  const walked = lintEmail({ email: would, kind: "checkin_email", prior: six, walk: (k) => checkInEmailFor({ checkInEmail: {}, name: "Brenda", contactId: "c-email", n: 1, shift: k, address: "14820 SE 172nd St, Renton, WA" }) });
  assert.deepEqual(walked.hard, []);
  // Matt's own wording is flagged, never held.
  const own = lintEmail({ email: would, kind: "checkin_email", prior, ours: false });
  assert.deepEqual(own.hard, []);
  assert.ok(own.flags.length > 0);
});
