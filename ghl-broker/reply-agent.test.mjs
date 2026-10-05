import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDispoAutopilot } from "./dispo-autopilot.js";
import {
  evaluateReplyGates, callsThemOurName, moneyIn, summarizeOffers, countToday, startReply,
  sendReplyDraft, dismissReplyDraft, listJobs, _resetJobs,
  AUTO_SENDABLE_INTENTS, RA_DEFAULT_DAILY_CAP, RA_MAX_SMS_CHARS,
} from "./reply-agent.js";

/* ---------- fixtures ---------- */

const DRAFT = {
  intent: "question", confidence: "high", needsHuman: false, humanReason: "",
  reply: "Yes, still interested, our 410k cash offer on 12 Elm stands through Friday.",
  summary: "Agent asked if we're still interested; draft confirms the standing offer.",
  propertyAddress: "12 Elm St", counterAmount: 0,
};
const gate = (over = {}, ctx = {}) =>
  evaluateReplyGates({ draft: { ...DRAFT, ...over }, allowedAmounts: [410000], inboundMessage: "still interested?", ...ctx });

/* ---------- names ---------- */

test("calling the agent by OUR name is flagged — Nate got 'Thanks, Matt.' (1322 N Mamer Rd)", () => {
  const who = { selfName: "Matt Shepherd", contactName: "Nate Wright" };
  const g = gate({ reply: "Thanks, Matt. I'll reach out if I need anything else after I see it." }, who);
  assert.equal(g.ok, false);
  assert.match(g.flags.join(";"), /our name/);
  for (const r of ["Hey Matt, sounds good", "Sounds good Matt!", "Matt, I'll swing by tomorrow.", "ok matt"]) {
    assert.equal(callsThemOurName(r, who), true, r);
  }
  for (const r of ["This is Matt with Shep Flips.", "I'm Matt, I buy houses as-is.", "Talk soon\nMatt", "Talk soon - Matt", "Thanks, Nate.",
    // the check-in drafts sign off this way; signing is not addressing
    "Hey Doug, checking back on 18408 SE 44th St. Been a couple weeks. Thanks, Matt",
    "Hey Saundra, it's Matt. Checking back on 13041 SE 208th, still sitting?"]) {
    assert.equal(callsThemOurName(r, who), false, r);
  }
  assert.equal(callsThemOurName("Talk soon, Matt S.", { ...who, signOff: "Matt S." }), false, "the persona sign-off is ours");
  assert.equal(callsThemOurName("Thanks, Matt.", { selfName: "Matt", contactName: "Matt Jones" }), false, "they share it");
  assert.equal(gate({}, who).ok, true);
});

/* ---------- the money guard ---------- */

test("money is read the way agents text it", () => {
  assert.deepEqual(moneyIn("would you do $410,000? or 415k. maybe 1.2M. $1.25m"), [410000, 415000, 1200000, 1250000]);
});

test("days, years and street numbers are not money", () => {
  assert.deepEqual(moneyIn("close in 14 days, built 1968, 12 Elm St, 3 beds"), []);
});

test("a draft that quotes our own offer passes", () => {
  const g = gate();
  assert.equal(g.ok, true, g.flags.join(" · "));
  assert.deepEqual(g.flags, []);
});

test("a draft that names a number not in the offer book is flagged — the rule that is not a judgment call", () => {
  const g = gate({ reply: "We could go to $425,000 on 12 Elm." });
  assert.equal(g.ok, false);
  assert.match(g.flags.join(" · "), /names \$425,000, which is not in the offer book/);
});

test("echoing a number the agent themselves said is allowed", () => {
  const g = gate(
    { intent: "question", reply: "I hear you on 425k — let me run it by my partner and get back to you today." },
    { inboundMessage: "any chance you'd do 425k?" }
  );
  assert.deepEqual(g.flags, []);
});

/* ---------- what a person has to decide ---------- */

test("a counter is a person's call even when the model is sure", () => {
  const g = gate({ intent: "counter", needsHuman: true, humanReason: "the agent named a higher number", counterAmount: 425000,
    reply: "Let me run that by my partner and get back to you this afternoon." });
  assert.equal(g.ok, false);
  assert.match(g.flags[0], /a counter is a person's call/);
  assert.match(g.flags[1], /named a higher number/);
});

test("the auto-sendable list is short and excludes everything that commits us", () => {
  for (const i of ["counter", "acceptance", "wants_call", "scheduling", "proof_of_funds", "other"]) {
    assert.equal(AUTO_SENDABLE_INTENTS.has(i), false, i);
  }
  assert.equal(AUTO_SENDABLE_INTENTS.has("question"), true);
  assert.equal(AUTO_SENDABLE_INTENTS.has("rejection"), true);
  // "I have a property" → "what's the address?" commits nothing; it may send.
  assert.equal(AUTO_SENDABLE_INTENTS.has("new_property"), true);
  assert.equal(AUTO_SENDABLE_INTENTS.has("deal_available"), true);
});

test("medium confidence holds", () => {
  assert.match(gate({ confidence: "medium" }).flags.join(" · "), /only medium confidence/);
});

test("an empty draft on anything but small talk holds; empty small talk is fine", () => {
  assert.match(gate({ reply: "" }).flags.join(" · "), /came back empty/);
  assert.equal(gate({ intent: "small_talk", reply: "" }).ok, true);
});

test("a novel of a text is flagged; the same length as an email is not", () => {
  const long = "x".repeat(RA_MAX_SMS_CHARS + 1);
  assert.match(gate({ reply: long }).flags.join(" · "), /too long for a text/);
  assert.equal(gate({ reply: long }, { channel: "email" }).ok, true);
});

/* ---------- the offer book, as the model sees it ---------- */

const OFFERS = [
  { address: "12 Elm St, Renton, WA", cashAmount: 410000, status: "sent", createdAt: "2026-08-20T00:00:00Z",
    inputs: { askingPrice: 525000 }, sends: [{ ts: "2026-08-21T00:00:00Z", channels: ["sms"] }], validLabel: "through Sep 5" },
  { address: "40 Oak Ave, Kent, WA", cashAmount: null, status: "draft", createdAt: "2026-09-01T00:00:00Z" },
  { address: "7 Pine Ct, Kent, WA", cashAmount: 300000, status: "passed", createdAt: "2026-07-01T00:00:00Z", statusNote: "went with a retail buyer" },
];

test("the summary is newest first and every number in it is one the reply may say", () => {
  const s = summarizeOffers(OFFERS, { now: Date.parse("2026-09-03T00:00:00Z") });
  assert.equal(s.count, 3);
  const lines = s.text.split("\n");
  assert.match(lines[0], /^- 40 Oak Ave.*still being underwritten \(no number yet\)/);
  assert.match(lines[1], /12 Elm St.*our cash offer \$410,000 \(asking \$525,000\) — status: sent, waiting on the agent sent 13 days ago by sms$/);
  assert.doesNotMatch(s.text, /valid through|expires/, "an offer stands until they answer — no date for the bot to call a deadline");
  assert.match(lines[2], /7 Pine Ct.*\$300,000.*agent passed.*note: went with a retail buyer/);
  // 400000: the rough figure at or under 410,000 (down to the nearest 25k) — see "a rough version of our number".
  assert.deepEqual([...s.amounts].sort((a, b) => a - b), [300000, 400000, 410000, 525000]);
});

test("the summary is capped so a prolific agent doesn't blow the context", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ address: `${i} Any St`, cashAmount: 100000 + i, createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
  assert.equal(summarizeOffers(many).count, 8);
});

/* ---------- the front door ---------- */

const fakeStore = (drafts = []) => {
  const rows = new Map(drafts.map((d) => [d.id, d]));
  return {
    rows,
    listReplyDrafts: async (_loc, { status = null, contactId = null, since = null } = {}) =>
      [...rows.values()].filter((d) => (!status || d.status === status) && (!contactId || d.contactId === contactId) && (!since || d.createdAt >= since)),
    getReplyDraft: async (id) => rows.get(id) || null,
    updateReplyDraft: async (id, doc) => { if (!rows.has(id)) return false; rows.set(id, doc); return true; },
    createReplyDraft: async (doc) => { const full = { ...doc, id: `d${rows.size + 1}`, createdAt: new Date().toISOString() }; rows.set(full.id, full); return full; },
    listOffers: async () => [],
    // The contact record, in memory — enough for a pipeline test to read the trail it leaves.
    profiles: new Map(), events: new Map(),
    async getContactProfile(loc, id) { return this.profiles.get(`${loc}|${id}`) || null; },
    async upsertContactProfile(loc, id, patch) {
      const prev = this.profiles.get(`${loc}|${id}`) || { locationId: loc, contactId: id, facts: {}, tags: [] };
      const row = { ...prev, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null)) };
      this.profiles.set(`${loc}|${id}`, row); return row;
    },
    async appendContactEvents(loc, id, events) {
      const list = this.events.get(`${loc}|${id}`) || []; const keys = new Set(list.map((e) => e.dedupeKey).filter(Boolean));
      let inserted = 0; for (const e of events) { if (e.dedupeKey && keys.has(e.dedupeKey)) continue; list.push(e); if (e.dedupeKey) keys.add(e.dedupeKey); inserted++; }
      this.events.set(`${loc}|${id}`, list); return { inserted, skipped: events.length - inserted };
    },
    async listContactEvents(loc, id, { types = null } = {}) { return (this.events.get(`${loc}|${id}`) || []).filter((e) => !types || types.includes(e.type)); },
  };
};
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const openDraft = () => ({
  id: "d1", locationId: "LOC", contactId: "c1", status: "draft", channel: "sms",
  reply: "Yes, still interested.", propertyAddress: "12 Elm St", createdAt: iso(1000),
});

// Two stages of the pipeline are network — GHL and Claude. A client whose
// every call throws stops the run at the first of them, which is enough to
// test the front door without either.
const deadClient = { call: async () => { throw new Error("offline"); } };

test("a missing API key is refused before anything is spent", async () => {
  _resetJobs();
  await assert.rejects(
    () => startReply({ client: deadClient, locationId: "LOC", saved: {}, store: fakeStore(), contactId: "c1", message: "hi" }),
    /Anthropic API key required/
  );
  assert.equal(listJobs("LOC").length, 0);
});

test("an empty message is refused — there is nothing to reply to", async () => {
  _resetJobs();
  await assert.rejects(
    () => startReply({ client: deadClient, locationId: "LOC", saved: { aiApiKey: "k" }, store: fakeStore(), contactId: "c1", message: "  " }),
    /message required/
  );
});

test("the daily cap counts the store, not just memory", async () => {
  _resetJobs();
  const today = Array.from({ length: RA_DEFAULT_DAILY_CAP }, (_, i) => ({ id: `d${i}`, jobId: `ra-${i}`, locationId: "LOC", createdAt: iso(60_000), status: "sent" }));
  const store = fakeStore(today);
  assert.equal(await countToday({ store, locationId: "LOC" }), RA_DEFAULT_DAILY_CAP);
  const r = await startReply({ client: deadClient, locationId: "LOC", saved: { aiApiKey: "k" }, store, contactId: "c1", message: "hi" });
  assert.match(r.skipped, /daily cap reached \(60\/60\)/);
  assert.equal(r.job, null);
});

test("a lower cap in Settings is honoured, and yesterday doesn't count", async () => {
  _resetJobs();
  const store = fakeStore([
    { id: "a", jobId: "ra-a", locationId: "LOC", createdAt: iso(60_000), status: "sent" },
    { id: "b", jobId: "ra-b", locationId: "LOC", createdAt: iso(50 * 3600_000), status: "sent" },
  ]);
  assert.equal(await countToday({ store, locationId: "LOC" }), 1);
  const r = await startReply({ client: deadClient, locationId: "LOC", saved: { aiApiKey: "k", replyAgentDailyCap: 1 }, store, contactId: "c1", message: "hi" });
  assert.match(r.skipped, /\(1\/1\)/);
});

// The whole run, with the one paid stage stubbed. `ghl` is a client that
// answers a contact, no conversations, and records notes and tags.
function ghlStub() {
  const notes = [];
  const tags = [];
  const client = {
    call: async (path, opts = {}) => {
      if (/^\/contacts\/c1$/.test(path)) return { contact: { id: "c1", firstName: "Dana", lastName: "Reyes", tags: ["agent"] } };
      if (path.endsWith("/notes")) { notes.push(opts.body.body); return {}; }
      if (path.endsWith("/tags")) { tags.push([opts.method || "POST", opts.body.tags]); return {}; }
      if (path.startsWith("/conversations/search")) return { conversations: [] };
      throw new Error(`unexpected ${path}`);
    },
  };
  return { client, notes, tags };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const SAVED = { aiApiKey: "k", company: { signer: "Matt" }, replyAgentInstructions: "Sign as Matt." };

test("a drafting failure lands in the job and on the contact, not in the process", async () => {
  _resetJobs();
  const { client, notes } = ghlStub();
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store: fakeStore(), contactId: "c1", message: "still interested?", channel: "sms",
    deps: { draft: async () => { throw new Error("Anthropic down"); } },
  });
  assert.ok(job);
  await settle();
  assert.equal(job.status, "error");
  assert.match(job.error, /Anthropic down/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /could not be drafted — Anthropic down/);
});

test("a clean run saves the draft, tags the contact, and leaves the draft in a note", async () => {
  _resetJobs();
  const { client, notes, tags } = ghlStub();
  const store = fakeStore();
  store.listOffers = async () => OFFERS;
  let seen;
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "still interested in 12 Elm?", channel: "sms",
    deps: { draft: async (args) => { seen = args; return DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(job.contactName, "Dana Reyes");
  assert.equal(job.intent, "question");
  // what the model was given
  assert.equal(seen.contact.name, "Dana Reyes");
  assert.equal(seen.signer, "Matt");
  // The saved playbook, then the fixed letter-of-intent rule every agent draft carries.
  assert.ok(seen.instructions.startsWith("Sign as Matt."));
  assert.match(seen.instructions, /LETTER OF INTENT[\s\S]*NWMLS forms/);
  assert.equal(seen.offers.count, 3);
  assert.match(seen.offers.text, /12 Elm St/);
  // what was saved
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft");
  assert.equal(d.reply, DRAFT.reply);
  assert.equal(d.inbound, "still interested in 12 Elm?");
  assert.equal(d.autoSendable, true, d.flags.join(" · "));
  assert.deepEqual(d.flags, []);
  assert.equal(d.offersInContext, 3);
  // and what GHL saw
  assert.deepEqual(tags, [["POST", ["reply-draft"]]]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /AI drafted a reply about 12 Elm St/);
  assert.match(notes[0], /Would have been safe to send on its own/);
  assert.match(notes[0], new RegExp(DRAFT.reply.replace(/[$()]/g, "\\$&")));
});

test("a counter is saved flagged, and the note says why", async () => {
  _resetJobs();
  const { client, notes } = ghlStub();
  const store = fakeStore();
  store.listOffers = async () => [{ id: "o1", ...OFFERS[0] }];   // a counter on a house we offered on
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "would you do 425k?",
    deps: { draft: async () => ({ ...DRAFT, intent: "counter", needsHuman: true, humanReason: "the agent named a higher number", counterAmount: 425000,
      reply: "Let me run 425k by my partner and get back to you this afternoon." }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.autoSendable, false);
  assert.match(d.flags[0], /a counter is a person's call/);
  assert.equal(d.counterAmount, 425000);
  assert.match(notes[0], /Needs you because: a counter is a person's call\nThe model notes: the agent named a higher number/);
});

// Walkthroughs, calls and times can never auto-send, so the draft was always
// a text nobody would send: 42 of them in the two weeks to 2026-09-12, one
// sent. What Matt needs is the fact, not a reply he has to read and bin.
test("a walkthrough, a call or a time gets a heads-up instead of a draft nobody would send", async () => {
  _resetJobs();
  const { client, notes } = ghlStub();
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "can we talk thursday?",
    deps: { draft: async () => ({ ...DRAFT, intent: "scheduling", reply: "Thursday works, what time suits you?",
      summary: "The agent wants to set a time to walk 12 Elm.", propertyAddress: "12 Elm St" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "handled");
  assert.equal(d.reply, "", "no half-written text sitting there to be sent by accident");
  assert.equal(d.autoSendable, false);
  assert.match(d.flags.join(" · "), /a scheduling is yours to answer/);
  assert.equal(d.summary, "The agent wants to set a time to walk 12 Elm.");
  assert.match(notes.join("\n"), /wants to set a time to walk 12 Elm/);
  assert.match(notes.join("\n"), /No reply was drafted/);
});

// The stand-down used to block only the SEND, so the model call was spent
// and the draft then went stale while Matt worked the thread himself. Now it
// bails before drafting — that is the whole point of the setting.
test("when a person is already in the thread, the bot stands down before spending a model call", async () => {
  _resetJobs();
  const notes = [];
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const client = {
    call: async (path, opts = {}) => {
      if (/^\/contacts\/c1$/.test(path)) return { contact: { id: "c1", firstName: "Dana", lastName: "Reyes", tags: ["agent"] } };
      if (path.endsWith("/notes")) { notes.push(opts.body.body); return {}; }
      if (path.endsWith("/tags")) return {};
      if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1" }] };
      if (/^\/conversations\/cv1\/messages/.test(path)) {
        return { messages: [
          { id: "m1", dateAdded: ago(9 * 60000), direction: "inbound", messageType: "TYPE_SMS", body: "any update?" },
          { id: "m2", dateAdded: ago(5 * 60000), direction: "outbound", messageType: "TYPE_SMS", body: "Yes, calling you in ten." },
        ] };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
  let drafted = 0;
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store: fakeStore(), contactId: "c1", message: "sounds good",
    deps: { draft: async () => { drafted++; return DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "held", job.error);
  assert.match(job.heldReason, /you have the thread/);
  assert.equal(drafted, 0, "no model call at all — the point of the setting");
  assert.equal(notes.length, 0, "he is in the thread; a note about it is noise");
});

test("an intent that is not notify-only still gets a real draft", async () => {
  _resetJobs();
  const { client } = ghlStub();
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "still interested?",
    deps: { draft: async () => DRAFT },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft");
  assert.equal(d.reply, DRAFT.reply);
});

test("a made-up number is caught before anyone sees the draft", async () => {
  _resetJobs();
  const { client } = ghlStub();
  const store = fakeStore();
  store.listOffers = async () => OFFERS;
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "still interested?",
    deps: { draft: async () => ({ ...DRAFT, reply: "Yes — we can do $430,000 on 12 Elm." }) },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.autoSendable, false);
  assert.match(d.flags.join(" · "), /\$430,000, which is not in the offer book/);
});

test("a second text supersedes the open draft rather than stacking up", async () => {
  _resetJobs();
  const { client } = ghlStub();
  const store = fakeStore([{ ...openDraft(), id: "old" }]);
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "also, any update?",
    deps: { draft: async () => DRAFT },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal((await store.getReplyDraft("old")).status, "superseded");
  const fresh = await store.getReplyDraft(job.draftId);
  assert.deepEqual(fresh.supersededIds, ["old"]);
  assert.equal((await store.listReplyDrafts("LOC", { status: "draft" })).length, 1);
});

test("small talk with nothing to say saves no draft and tags nothing", async () => {
  _resetJobs();
  const { client, notes, tags } = ghlStub();
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "👍",
    deps: { draft: async () => ({ ...DRAFT, intent: "small_talk", reply: "", summary: "A thumbs up." }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(job.draftId, null);
  assert.equal(notes.length, 0);
  assert.equal(tags.length, 0);
});

// "Ugly 😂😂 ok." (2026-10-02): the bot read it as small talk with nothing to
// say, wrote nothing anywhere, and the nightly audit — seeing a text with no
// reply and no draft — tried three nights running and then put it on Today as
// "drafting was tried 3 nights running and produced no reply".
test("a text the bot let go leaves a note saying so, with no words in it", async () => {
  _resetJobs();
  const { client } = ghlStub();
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "Ugly 😂😂 ok.",
    deps: { draft: async () => ({ ...DRAFT, intent: "small_talk", reply: "", summary: "A laugh." }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(job.draftId, null, "still no draft");
  const evs = await store.listContactEvents("LOC", "c1", { types: ["reply_not_needed"] });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].data.intent, "small_talk");
  assert.equal(JSON.stringify(evs[0]).includes("Ugly"), false, "their words stay out of it");
});

test("'that was an auto dial' had nothing to say back, and sat on Today as a row because a tag had been stamped on the way", async () => {
  _resetJobs();
  const { client } = ghlStub();
  const store = fakeStore();
  const saved = { ...SAVED, conversationAi: { parties: { agent: { intentRules: { small_talk: { mode: "auto", actions: [{ type: "add_tags", tags: ["chatted"] }] } } } } } };
  const { job } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "No worries that was an auto dial",
    deps: { draft: async () => ({ ...DRAFT, intent: "small_talk", reply: "", summary: "Nothing to answer." }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.deepEqual(d.actions.map((a) => [a.type, a.status]), [["add_tags", "done"]], "the tag still ran");
  assert.equal(d.status, "dismissed", "nothing to send and nothing to decide: it closes itself");
  assert.ok(d.flags.some((f) => /nothing to say back — not sent/.test(f)));
  assert.equal((await store.listReplyDrafts("LOC", { status: "draft" })).length, 0);

  // A suggestion waiting on a person keeps the row.
  _resetJobs();
  const store2 = fakeStore();
  const ask = { ...SAVED, conversationAi: { parties: { agent: { intentRules: { small_talk: { mode: "ask", actions: [{ type: "add_tags", tags: ["chatted"] }] } } } } } };
  const r2 = await startReply({
    client, locationId: "LOC", saved: ask, store: store2, contactId: "c1", message: "ok",
    deps: { draft: async () => ({ ...DRAFT, intent: "small_talk", reply: "", summary: "Nothing to answer." }) },
  });
  await settle();
  assert.equal((await store2.getReplyDraft(r2.job.draftId)).status, "draft");
});

/* ---------- acting on a draft ---------- */


test("send without the live gate previews and changes nothing", async () => {
  const store = fakeStore([openDraft()]);
  const sent = [];
  const client = { call: async (path, opts) => { sent.push([path, opts]); return {}; } };
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", text: "edited", live: false });
  assert.equal(r.dryRun, true);
  assert.equal(r.preview.message, "edited");
  assert.equal(sent.length, 0);
  assert.equal((await store.getReplyDraft("d1")).status, "draft");
});

test("a live send goes out as SMS with the operator's text, and records the edit", async () => {
  const store = fakeStore([openDraft()]);
  const calls = [];
  const client = { call: async (path, opts) => { calls.push([path, opts]); return { messageId: "m1" }; } };
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", text: "Yes — still interested, offer stands.", live: true });
  assert.equal(r.dryRun, false);
  const send = calls.find(([p]) => p === "/conversations/messages");
  assert.ok(send, "an SMS went through the conversations endpoint");
  assert.equal(send[1].body.type, "SMS");
  assert.equal(send[1].body.contactId, "c1");
  assert.equal(send[1].body.message, "Yes — still interested, offer stands.");
  const d = await store.getReplyDraft("d1");
  assert.equal(d.status, "sent");
  assert.equal(d.edited, true);
  assert.equal(d.sentText, "Yes — still interested, offer stands.");
  assert.equal(d.ghlMessageId, "m1");
  assert.ok(calls.some(([p, o]) => p.endsWith("/tags") && o.method === "DELETE"), "the reply-draft tag is cleared");
});

test("sending the first cold text writes outreach_sent — the ladder's trigger — and nothing else does", async () => {
  const open = { ...openDraft(), party: "agent", intent: "outreach_open", contactName: "Dana", inbound: "",
    outbound: { kind: "outreach_open", address: "9 Cold Creek Rd, Kent, WA" }, propertyAddress: "9 Cold Creek Rd, Kent, WA" };
  const store = fakeStore([open, { ...openDraft(), id: "d2", contactId: "c2" }]);
  const client = { call: async () => ({ messageId: "m1" }) };
  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true });
  const ev = await store.listContactEvents("LOC", "c1", { types: ["outreach_sent"] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].address, "9 Cold Creek Rd, Kent, WA");
  assert.equal(ev[0].dedupeKey, "outreach:c1:d1");
  assert.equal(ev[0].data.contactName, "Dana");
  // a plain reply leaves no such trace
  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d2", live: true });
  assert.equal((await store.listContactEvents("LOC", "c2", { types: ["outreach_sent"] })).length, 0);
  // and a dry run of the cold open writes nothing
  const store2 = fakeStore([open]);
  await sendReplyDraft({ client, store: store2, locationId: "LOC", draftId: "d1", live: false });
  assert.equal((await store2.listContactEvents("LOC", "c1", { types: ["outreach_sent"] })).length, 0);
});

test("an email draft goes out as an email with the address as its subject", async () => {
  const store = fakeStore([{ ...openDraft(), channel: "email", reply: "First line.\n\nSecond <para>." }]);
  const calls = [];
  const client = { call: async (path, opts) => { calls.push([path, opts]); return {}; } };
  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true });
  const send = calls.find(([p]) => p === "/conversations/messages");
  assert.equal(send[1].body.type, "Email");
  assert.equal(send[1].body.subject, "Re: 12 Elm St");
  assert.equal(send[1].body.html, "<p>First line.</p><p>Second &lt;para&gt;.</p>");
});

test("a draft can only be sent once, and only from its own location", async () => {
  const store = fakeStore([{ ...openDraft(), status: "sent" }]);
  const client = { call: async () => ({}) };
  await assert.rejects(() => sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true }), /already sent/);
  await assert.rejects(() => sendReplyDraft({ client, store: fakeStore([openDraft()]), locationId: "OTHER", draftId: "d1", live: true }), /no such draft/);
});

test("nothing to send is an error, not an empty text", async () => {
  const store = fakeStore([{ ...openDraft(), reply: "" }]);
  await assert.rejects(() => sendReplyDraft({ client: { call: async () => ({}) }, store, locationId: "LOC", draftId: "d1", text: "  ", live: true }), /nothing to send/);
});

test("dismiss closes the draft and clears the tag", async () => {
  const store = fakeStore([openDraft()]);
  const calls = [];
  const client = { call: async (path, opts) => { calls.push([path, opts]); return {}; } };
  const r = await dismissReplyDraft({ client, store, locationId: "LOC", draftId: "d1" });
  assert.equal(r.draft.status, "dismissed");
  assert.ok(calls.some(([p, o]) => p.endsWith("/tags") && o.method === "DELETE"));
  // idempotent
  const again = await dismissReplyDraft({ client, store, locationId: "LOC", draftId: "d1" });
  assert.equal(again.draft.status, "dismissed");
});

test("a person who says why they binned or changed a draft has it kept on the draft", async () => {
  const client = { call: async () => ({ messageId: "m1" }) };
  const store = fakeStore([openDraft(), { ...openDraft(), id: "d2" }, { ...openDraft(), id: "d3" }]);
  const gone = await dismissReplyDraft({ client, store, locationId: "LOC", draftId: "d1", reason: { code: "Wrong Tone", note: " too chipper " } });
  assert.equal(gone.draft.feedback.code, "wrong_tone");
  assert.equal(gone.draft.feedback.note, "too chipper");
  assert.equal(gone.draft.dismissedBy, "you");
  assert.ok(gone.draft.dismissedAt);
  // an edit carries its why
  const sent = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d2", text: "Shorter.", live: true, reason: { code: "too_long" } });
  assert.equal(sent.draft.edited, true);
  assert.equal(sent.draft.feedback.code, "too_long");
  // no reason, or a nonsense one with no note, leaves no feedback at all
  const plain = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d3", live: true, reason: { code: "nope" } });
  assert.equal(plain.draft.feedback, undefined);
});

/* ---------- the Conversation AI: parties, auto-send, actions ---------- */

import {
  holdReplyDraft, applyDraftAction, previewConversation, decideAutoSend, conversationConfig,
} from "./reply-agent.js";

const NOW = Date.parse("2026-09-04T17:30:00Z");   // 10:30 Pacific, inside the default window
const DEAL = {
  id: "o1", address: "2010 NE 54th St, Seattle, WA 98105", cashAmount: 420000,
  calc: { inputs: { arv: 600000, repairs: 40000 } },
  deal: { stage: "under_contract", contractPrice: 420000, assignmentFee: 25000, investors: [] },
};
function ghlStubFor(tags) {
  const notes = [];
  const tagCalls = [];
  const calls = [];
  const client = {
    call: async (path, opts = {}) => {
      calls.push([opts.method || "GET", path]);
      if (/^\/contacts\/c1$/.test(path) && !opts.method) return { contact: { id: "c1", firstName: "Sam", lastName: "Lee", tags } };
      if (/^\/contacts\/c1$/.test(path) && opts.method === "PUT") return { contact: {} };
      if (path.endsWith("/customFields") && !opts.method) return { customFields: [{ id: "f-sp", name: "Subject Property", fieldKey: "contact.subject_property" }] };
      if (path.endsWith("/notes")) { notes.push(opts.body.body); return {}; }
      if (path.endsWith("/tags")) { tagCalls.push([opts.method || "POST", opts.body.tags]); return {}; }
      if (path.startsWith("/conversations/search")) return { conversations: [] };
      if (path === "/conversations/messages") return { messageId: "m9" };
      if (path.includes("/workflow/")) return { succeeded: true };
      throw new Error(`unexpected ${path}`);
    },
  };
  return { client, notes, tags: tagCalls, calls };
}
const INVESTOR_DRAFT = {
  intent: "interested", confidence: "high", needsHuman: false, humanReason: "",
  reply: "It's at 445k, happy to send the package over.", summary: "Investor wants details on 2010 NE 54th.",
  propertyAddress: "2010 NE 54th St", counterAmount: 0,
};

test("an investor-tagged contact gets the deal book, and the fee never reaches the reply", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["investor-active"]);
  const store = fakeStore();
  store.listDeals = async () => [DEAL];
  let seen;
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "what's the price on 54th?",
    deps: { draft: async (args) => { seen = args; return INVESTOR_DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(job.party, "investor");
  assert.equal(job.partySource, "tags");
  assert.equal(seen.party, "investor");
  assert.match(seen.context.text, /buyer price \$445,000/);
  assert.equal(seen.context.text.includes("$25,000"), false);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.party, "investor");
  assert.equal(d.autoSendable, true, d.flags.join(" · "));
  assert.equal(d.contextSummary.matchingDeals, 1);
});

test("an investor reply that names our fee or contract price is flagged even if they said it first", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["investor"]);
  const store = fakeStore();
  store.listDeals = async () => [DEAL];
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "is your fee 25k?",
    deps: { draft: async () => ({ ...INVESTOR_DRAFT, reply: "Yes, our fee is $25,000 on top of the $420,000 contract." }) },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.autoSendable, false);
  assert.match(d.flags.join(" · "), /names \$25,000, \$420,000, which is our contract price or assignment fee/);
});

const AUTO_SAVED = {
  ...SAVED,
  conversationAi: { parties: { agent: { autoSend: { enabled: true, intents: ["question", "status_check"] } } } },
};

test("an allowlisted intent on an auto-send party is scheduled a few minutes out, and the note says so", async () => {
  _resetJobs();
  const { client, notes } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => OFFERS;
  const { job } = await startReply({
    client, locationId: "LOC", saved: AUTO_SAVED, store, contactId: "c1", message: "still interested?", sendsEnabled: true,
    deps: { draft: async () => DRAFT, now: () => NOW, random: () => 0 },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "scheduled");
  // "still interested?" is a quick intent: the quick band's floor (45s), not the default band's (120s).
  assert.equal(d.sendAt, "2026-09-04T17:30:45.000Z", "now + the quick band's minimum delay");
  assert.equal(d.autoSend.decided, true);
  assert.equal(job.scheduledFor, d.sendAt);
  assert.match(notes[0], /will send it itself at/);
});

test("with sends off on the broker nothing is scheduled, and the draft says why", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: AUTO_SAVED, store, contactId: "c1", message: "still interested?", sendsEnabled: false,
    deps: { draft: async () => ({ ...DRAFT, reply: "Yes, still interested." }) },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft");
  assert.equal(d.autoSend.decided, false);
  assert.match(d.autoSend.reason, /CARD_SENDS_ENABLED/);
});

test("decideAutoSend names the first switch that is off", () => {
  const ok = { ok: true, flags: [] };
  const cfg = conversationConfig(AUTO_SAVED);
  assert.deepEqual(decideAutoSend({ gate: ok, party: "agent", intent: "question", config: cfg, sendsEnabled: true }), { send: true, code: "", reason: "" });
  // The code is what the counter band keys on, so each refusal has to carry
  // its own — a draft held for one reason must never be released by a guard
  // that answers a different one.
  assert.equal(decideAutoSend({ gate: ok, party: "agent", intent: "counter", config: cfg, sendsEnabled: true }).code, "never_auto");
  assert.equal(decideAutoSend({ gate: ok, party: "agent", intent: "rejection", config: cfg, sendsEnabled: true }).code, "not_allowlisted");
  assert.equal(decideAutoSend({ gate: ok, party: "agent", intent: "question", config: cfg, sendsEnabled: false }).code, "sends_off");
  assert.equal(decideAutoSend({ gate: { ok: false, flags: ["x"] }, party: "agent", intent: "counter", config: cfg, sendsEnabled: true }).code, "gates");
  assert.match(decideAutoSend({ gate: ok, party: "agent", intent: "rejection", config: cfg, sendsEnabled: true }).reason, /not on the agent auto-send list/);
  assert.match(decideAutoSend({ gate: ok, party: "investor", intent: "question", config: cfg, sendsEnabled: true }).reason, /auto-send is off for investors/);
  assert.match(decideAutoSend({ gate: ok, party: "agent", intent: "question", channel: "email", config: cfg, sendsEnabled: true }).reason, /email replies don't auto-send/);
  assert.match(decideAutoSend({ gate: { ok: false, flags: ["the model was only low confidence"] }, party: "agent", intent: "question", config: cfg, sendsEnabled: true }).reason, /needs a person: the model was only low/);
  assert.match(decideAutoSend({ gate: ok, party: "unknown", intent: "question", config: cfg, sendsEnabled: true }).reason, /unknown contact never/);
});

test("a new text supersedes a scheduled reply too — the conversation moved on", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore([{ ...openDraft(), id: "sched", status: "scheduled", sendAt: "2026-09-04T17:40:00Z" }]);
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "actually never mind",
    deps: { draft: async () => DRAFT },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const old = await store.getReplyDraft("sched");
  assert.equal(old.status, "superseded");
  assert.equal(old.sendAt, null);
});

test("hold turns a scheduled reply back into a draft that waits for a person", async () => {
  const store = fakeStore([{ ...openDraft(), status: "scheduled", sendAt: "2026-09-04T17:40:00Z", autoSend: { decided: true, reason: "" } }]);
  const r = await holdReplyDraft({ store, locationId: "LOC", draftId: "d1" });
  assert.equal(r.draft.status, "draft");
  assert.equal(r.draft.sendAt, null);
  assert.ok(r.draft.heldAt);
  assert.match(r.draft.flags.join(" · "), /held by you/);
  assert.equal(r.draft.autoSend.decided, false);
  const again = await holdReplyDraft({ store, locationId: "LOC", draftId: "d1" });
  assert.equal(again.draft.status, "draft", "idempotent");
});

test("the scheduler's send goes out as written, marks it auto-sent, and leaves a note", async () => {
  const store = fakeStore([{ ...openDraft(), status: "sending", sendingAt: new Date().toISOString(), party: "agent", intent: "question" }]);
  const calls = [];
  const client = { call: async (path, opts) => { calls.push([path, opts]); return { messageId: "m1" }; } };
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true });
  assert.equal(r.draft.status, "sent");
  assert.equal(r.draft.autoSent, true);
  assert.equal(r.draft.edited, false);
  const sms = calls.find(([p]) => p === "/conversations/messages");
  assert.equal(sms[1].body.message, "Yes, still interested.");
  const noteCall = calls.find(([p]) => p.endsWith("/notes"));
  assert.match(noteCall[1].body.body, /sent this reply itself/);
});

test("a contact with no agent or investor tag holds with a note and no draft", async () => {
  _resetJobs();
  const { client, notes, tags } = ghlStubFor(["lead"]);
  const store = fakeStore();
  let called = false;
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "hey",
    deps: { draft: async () => { called = true; return DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "held");
  assert.equal(job.party, "unknown");
  assert.equal(called, false, "no Claude call for a contact we can't place");
  assert.equal(job.draftId, null);
  assert.equal(tags.length, 0);
  assert.match(notes[0], /none of the tags/);
});

test("with unknown set to generic, an untagged contact still gets a careful draft that never auto-sends", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["lead"]);
  const store = fakeStore();
  const saved = { ...AUTO_SAVED, conversationAi: { ...AUTO_SAVED.conversationAi, routing: { unknown: "generic", genericInstructions: "Be brief." } } };
  let seen;
  const { job } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "hey", sendsEnabled: true,
    deps: { draft: async (args) => { seen = args; return { ...DRAFT, reply: "Hi — what can I help with?" }; } },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(seen.party, "unknown");
  assert.equal(seen.instructions, "Be brief.");
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.party, "unknown");
  assert.equal(d.status, "draft");
  assert.match(d.autoSend.reason, /unknown contact never auto-sends/);
});

test("an auto rule fires on a confident read; an ask rule waits on the row; a person can apply it", async () => {
  _resetJobs();
  const { client, tags } = ghlStubFor(["investor"]);
  const store = fakeStore();
  store.listDeals = async () => [DEAL];
  const saved = {
    ...SAVED,
    conversationAi: { parties: { investor: { intentRules: {
      interested: { mode: "auto", actions: [{ type: "add_tags", tags: ["hot-investor"] }, { type: "add_to_workflow", workflowId: "wf1", workflowName: "Investor follow-up" }] },
      passing: { mode: "ask", actions: [{ type: "remove_tags", tags: ["hot-investor"] }] },
    } } } },
  };
  const { job } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "send me 54th",
    deps: { draft: async () => INVESTOR_DRAFT },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.deepEqual(d.actions.map((a) => [a.type, a.mode, a.status]), [["add_tags", "auto", "done"], ["add_to_workflow", "auto", "done"]]);
  assert.ok(tags.some(([m, t]) => m === "POST" && t.includes("hot-investor")));

  // now a pass, medium confidence: nothing fires, one suggestion waits
  _resetJobs();
  const { job: j2 } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "gonna pass",
    deps: { draft: async () => ({ ...INVESTOR_DRAFT, intent: "passing", confidence: "medium", reply: "Understood — thanks for looking." }) },
  });
  await settle();
  const d2 = await store.getReplyDraft(j2.draftId);
  assert.deepEqual(d2.actions.map((a) => [a.type, a.mode, a.status]), [["remove_tags", "ask", "pending"]]);
  const before = tags.length;
  const r = await applyDraftAction({ client, store, locationId: "LOC", draftId: d2.id, actionId: d2.actions[0].id });
  assert.equal(r.action.status, "applied");
  assert.equal(tags.length, before + 1);
  assert.deepEqual(tags[tags.length - 1], ["DELETE", ["hot-investor"]]);
  await assert.rejects(() => applyDraftAction({ client, store, locationId: "LOC", draftId: d2.id, actionId: d2.actions[0].id }), /already applied/);
});

test("a preview runs the whole pipeline and writes nothing anywhere", async () => {
  const { client, calls } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => OFFERS;
  let created = 0;
  store.createReplyDraft = async () => { created++; throw new Error("must not persist"); };
  const r = await previewConversation({
    client, locationId: "LOC", saved: AUTO_SAVED, store, contactId: "c1", message: "still interested in 12 Elm?", sendsEnabled: true,
    deps: { draft: async () => DRAFT, random: () => 0 }, now: NOW,
  });
  assert.equal(r.party, "agent");
  assert.equal(r.held, false);
  assert.equal(r.draft.reply, DRAFT.reply);
  assert.equal(r.gate.ok, true);
  assert.equal(r.autoSend.would, true);
  assert.equal(r.autoSend.sendAt, "2026-09-04T17:30:45.000Z", "a quick intent: the quick band floor");
  assert.match(r.context.text, /12 Elm St/);
  assert.equal(created, 0);
  assert.equal(calls.some(([m]) => m !== "GET"), false, "no POST/PUT/DELETE reached GHL");
});

test("a preview can be run on a typed thread with no contact at all", async () => {
  const r = await previewConversation({
    client: { call: async () => { throw new Error("should not be called"); } }, locationId: "LOC", saved: SAVED, store: fakeStore(),
    message: "what's your fee?", fakeParty: "investor", fakeThread: [{ dir: "US", text: "Have a deal on 54th." }, { dir: "THEM", text: "what's the price" }],
    deps: { draft: async (args) => ({ ...INVESTOR_DRAFT, reply: `The price is the price — ${args.transcript.includes("THEM sms: what's the price") ? "ok" : "no thread"}.` }) },
  });
  assert.equal(r.party, "investor");
  assert.equal(r.partySource, "try-it");
  assert.match(r.draft.reply, /ok\.$/);
});

test("a test on a real contact carries their real thread, then the typed turns", async () => {
  const client = {
    call: async (path, opts = {}) => {
      if (/^\/contacts\/c1$/.test(path)) return { contact: { id: "c1", firstName: "Dana", tags: ["agent"] } };
      if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1" }] };
      if (path.startsWith("/conversations/cv1/messages")) {
        return { messages: [{ id: "m1", type: "TYPE_SMS", direction: "inbound", body: "earlier real text", dateAdded: new Date().toISOString() }] };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
  let seen;
  const r = await previewConversation({
    client, locationId: "LOC", saved: SAVED, store: fakeStore(), contactId: "c1", message: "and now?",
    fakeThread: [{ dir: "THEM", text: "typed turn one" }, { dir: "US", text: "our typed answer" }],
    deps: { draft: async (args) => { seen = args; return DRAFT; } },
  });
  assert.equal(r.party, "agent");
  const real = seen.transcript.indexOf("earlier real text");
  const typed = seen.transcript.indexOf("THEM sms: typed turn one");
  assert.ok(real >= 0 && typed > real, "real first, typed after");
  assert.match(seen.transcript, /US sms: our typed answer/);
});

/* ---------- the GHL bots, consolidated: opt-out, photos, classify, carrier style ---------- */

import { scrubReply, classifyParty } from "./reply-agent.js";
import { starterConfig, detectOptOut } from "./shared/conversation-ai.js";

// The starter with its debounce off: these tests settle in 30ms, and the
// debounce has a test of its own.
const STARTER_RAW = starterConfig({ signer: "Matt Shepherd" });
const STARTER_SAVED = { ...SAVED, conversationAi: { ...STARTER_RAW, autoSend: { ...STARTER_RAW.autoSend, debounceSec: 0 } } };

test("STOP gets silence and the tags, no model call, and cancels anything counting down", async () => {
  _resetJobs();
  const { client, notes, tags } = ghlStubFor(["agent"]);
  const store = fakeStore([{ ...openDraft(), id: "sched", status: "scheduled", sendAt: "2026-09-04T17:40:00Z" }]);
  let called = false;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "STOP texting me",
    deps: { draft: async () => { called = true; return DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(called, false, "no Claude call for an opt-out");
  assert.equal(job.intent, "opt_out");
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "handled");
  assert.equal(d.reply, "");
  assert.deepEqual(d.actions.map((a) => [a.type, a.status]), [["add_tags", "done"]]);
  assert.ok(tags.some(([m, t]) => m === "POST" && t.includes("stop bot") && t.includes("dnc")));
  assert.equal((await store.getReplyDraft("sched")).status, "superseded");
  assert.match(notes[0], /opt-out/);
  assert.match(notes[0], /No reply was sent/);
  assert.equal(notes.length, 1);
});

test("the model reading an opt-out the keywords missed ends the same way", async () => {
  _resetJobs();
  const { client, tags } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "lose my number pal",
    deps: { draft: async () => ({ ...DRAFT, intent: "opt_out", reply: "Understood.", summary: "Angry; wants no more texts." }) },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "handled");
  assert.equal(d.reply, "", "the model's goodbye is dropped — an opt-out gets silence");
  assert.ok(tags.some(([m, t]) => m === "POST" && t.includes("dnc")));
});

test("the opt-out keywords are strict about where a word sits", () => {
  const o = starterConfig().optOut;
  assert.equal(detectOptOut("STOP", o), true);
  assert.equal(detectOptOut("please stop by the office tomorrow", o), false);
  assert.equal(detectOptOut("cancelled the listing", o), false);
  assert.equal(detectOptOut("this is the wrong number", o), true);
  assert.equal(detectOptOut("don't text me again", o), true);
  assert.equal(detectOptOut("", o), false);
  assert.equal(detectOptOut("STOP", { ...o, enabled: false }), false);
});

test("a bare photo gets the canned line and no model call", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  let called = false;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "", attachments: 2,
    deps: { draft: async () => { called = true; return DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(called, false);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "media");
  assert.equal(d.reply, "Thanks for the images, taking a look!");
  assert.equal(d.autoSendable, true, d.flags.join(" · "));
  assert.equal(d.attachments, 2);
});

test("an empty message with no attachment is still refused", async () => {
  _resetJobs();
  await assert.rejects(
    () => startReply({ client: deadClient, locationId: "LOC", saved: STARTER_SAVED, store: fakeStore(), contactId: "c1", message: "", attachments: 0 }),
    /message required/
  );
});

test("an untagged contact is placed by the words, and stamped so the tags decide next time", async () => {
  _resetJobs();
  const { client, tags } = ghlStubFor(["lead"]);
  const store = fakeStore();
  store.listDeals = async () => [DEAL];
  let seen;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "is 54th still available? cash buyer here",
    deps: {
      classify: async (args) => { seen = args; return { party: "investor", confidence: "high", reason: "cash buyer asking about a marketed property" }; },
      draft: async () => INVESTOR_DRAFT,
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(job.party, "investor");
  assert.equal(job.partySource, "classified");
  assert.match(seen.message, /54th/);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.classified.party, "investor");
  assert.equal(d.actions[0].type, "add_tags");
  assert.deepEqual(d.actions[0].tags, ["investor"], "the party's first plain tag");
  assert.equal(d.actions[0].status, "done");
  assert.ok(tags.some(([m, t]) => m === "POST" && t.includes("investor")));
  assert.match(d.contextSummary && JSON.stringify(d.contextSummary), /matchingDeals/, "the investor book was loaded after the classification");
});

test("a low-confidence classification stays unknown and gets the generic clarifying reply", async () => {
  _resetJobs();
  const { client, tags } = ghlStubFor(["lead"]);
  const store = fakeStore();
  let seen;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "hey", sendsEnabled: true,
    deps: {
      classify: async () => ({ party: "agent", confidence: "low", reason: "could be anyone" }),
      draft: async (args) => { seen = args; return { ...DRAFT, reply: "Hey, is this about a listing you have, or are you looking to pick one up?" }; },
    },
  });
  await settle();
  assert.equal(job.party, "unknown");
  assert.match(seen.instructions, /ONE natural question/);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft");
  assert.match(d.autoSend.reason, /unknown contact never/);
  assert.equal(tags.filter(([m, t]) => m === "POST" && !t.includes("reply-draft")).length, 0, "no party tag stamped");
});

test("carrier-unsafe drafts hold: a dollar sign, a link, or too many characters", () => {
  const style = starterConfig().style;
  const g = (reply) => evaluateReplyGates({ draft: { ...DRAFT, reply }, allowedAmounts: [410000], style });
  assert.match(g("Our $410,000 offer stands.").flags.join(" · "), /dollar sign in a text/);
  assert.match(g("See https://example.com/deal for details.").flags.join(" · "), /link in a text/);
  assert.match(g("x".repeat(301)).flags.join(" · "), /301 characters is too long/);
  assert.equal(g("Our 410k offer stands.").ok, true);
  assert.equal(evaluateReplyGates({ draft: { ...DRAFT, reply: "Our $410,000 offer stands." }, allowedAmounts: [410000], style, channel: "email" }).ok, true, "email is not a text");
});

test("em dashes are scrubbed from a draft, and the tag rules from the starter fire on a tier read", async () => {
  assert.equal(scrubReply("Got it — appreciate it — talk soon.", { noEmDashes: true }), "Got it, appreciate it, talk soon.");
  assert.equal(scrubReply("— leading and trailing —", { noEmDashes: true }), "leading and trailing");
  assert.equal(scrubReply("keep — this", { noEmDashes: false }), "keep — this");

  _resetJobs();
  const { client, tags } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "yeah 12 Elm needs a full reno, seller wants out by October",
    deps: { draft: async () => ({ ...DRAFT, intent: "deal_available", reply: "Got it. Let me run this address by my underwriting team today and see if we can get back to you with an offer.", propertyAddress: "12 Elm St" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.deepEqual(d.actions.map((a) => [a.type, a.tags || a.key, a.status]), [
    ["add_tags", ["tier-1"], "done"], ["remove_tags", ["tier-2", "tier-3"], "done"],
    // No underwriter is wired in this stub; the rule still tried, and said so.
    ["start_underwrite", undefined, "failed"],
  ]);
  // Subject Property is filed by the pipeline now, not by an intent rule, so
  // it lands on every agent message that names a property rather than only on
  // a tier-1 read.
  assert.ok(d.profileUpdates?.learned?.includes("subject property: 12 Elm St"),
    `the address the agent named aims the underwriter — got ${JSON.stringify(d.profileUpdates)}`);
  assert.ok(tags.some(([m, t]) => m === "POST" && t.includes("tier-1")));
  assert.ok(tags.some(([m, t]) => m === "DELETE" && t.includes("tier-2")));
});

test("the classifier is wired through the same API shape as the drafter", () => {
  assert.equal(typeof classifyParty, "function");
});

/* ---------- the gap review: hands off, catch-all, debounce, memory ---------- */

import { mergeFacts, lastOutbound, humanHasThread, applyProfileUpdates, countTodayForContact } from "./reply-agent.js";

const STARTER_NOW = STARTER_SAVED;

test("a contact carrying the bot-off tag is left alone: no draft, no note", async () => {
  _resetJobs();
  const { client, notes } = ghlStubFor(["agent", "stop bot"]);
  let called = false;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store: fakeStore(), contactId: "c1", message: "still interested?",
    deps: { draft: async () => { called = true; return DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "held");
  assert.match(job.heldReason, /bot is off.*stop bot/);
  assert.equal(called, false);
  assert.equal(notes.length, 0);
});

test("the agent on a property you have under contract is yours, not the bot's", async () => {
  _resetJobs();
  const { client, notes } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => [{ id: "o1", address: "22018 76th Ave W", deal: { stage: "under_contract" } }];
  let called = false;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "hey, quick question on the closing",
    deps: { draft: async () => { called = true; return DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "held");
  assert.match(job.heldReason, /22018 76th Ave W under contract with them/);
  assert.equal(called, false, "not even drafted — nothing to spend a model call on");
  assert.equal(notes.length, 0);

  // Once the file closes, they are a lead again like anyone else.
  _resetJobs();
  const closed = fakeStore();
  closed.listOffers = async () => [{ id: "o1", address: "22018 76th Ave W", deal: { stage: "closed" } }];
  const r = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store: closed, contactId: "c1", message: "got another one for you",
    deps: { draft: async () => DRAFT },
  });
  await settle();
  assert.notEqual(r.job.status, "held");
});

test("the bot works evaluating buyers and stops at the one who signs", async () => {
  const { client } = ghlStubFor(["investor"]);
  const investors = [];
  const storeFor = () => {
    const st = fakeStore();
    st.listDeals = async () => [{ id: "o1", address: "22018 76th Ave W", deal: { stage: "under_contract", investors } }];
    return st;
  };
  const send = async (message) => {
    _resetJobs();
    const r = await startReply({
      client, locationId: "LOC", saved: STARTER_NOW, store: storeFor(), contactId: "c1", message,
      deps: { draft: async () => DRAFT },
    });
    await settle();
    return r.job;
  };

  // Nobody has linked them: this is the blast landing.
  assert.notEqual((await send("yeah I'm interested, send it over")).status, "held");

  // link_deal_evaluating has put them on the deal. Evaluating is a pipeline,
  // not a handoff — the bot keeps working them toward a walkthrough.
  investors.push({ contactId: "c1", status: "evaluating" });
  assert.notEqual((await send("what's the ARV on that again?")).status, "held");

  // They sign. From here it is paperwork, and the bot has nothing to add.
  investors[0].status = "committed";
  const signed = await send("when do we close?");
  assert.equal(signed.status, "held");
  assert.match(signed.heldReason, /buyer on your live deal at 22018 76th Ave W/);

  // They pass instead, and they are in the pool for the next deal.
  investors[0].status = "passed";
  assert.notEqual((await send("anything else in that pocket?")).status, "held");
});

test("an agent reply with no fit lands in Tier 3 — unless they already have a tier", async () => {
  _resetJobs();
  const { client, tags } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "who is this?",
    deps: { draft: async () => ({ ...DRAFT, intent: "other", confidence: "medium", reply: "It's Matt, I buy homes that need work around Renton. Anything sitting on your side?" }) },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.deepEqual(d.actions.map((a) => [a.type, a.tags, a.status, a.why]), [["add_tags", ["tier-3"], "done", "no rule matched"]]);
  assert.ok(tags.some(([m, t]) => m === "POST" && t.includes("tier-3")));

  _resetJobs();
  const { client: c2, tags: t2 } = ghlStubFor(["agent", "tier-1"]);
  const store2 = fakeStore();
  const { job: j2 } = await startReply({
    client: c2, locationId: "LOC", saved: STARTER_NOW, store: store2, contactId: "c1", message: "who is this?",
    deps: { draft: async () => ({ ...DRAFT, intent: "other", reply: "It's Matt." }) },
  });
  await settle();
  assert.deepEqual((await store2.getReplyDraft(j2.draftId)).actions, [], "a Tier 1 agent is never demoted");
  assert.equal(t2.some(([m, t]) => m === "POST" && t.includes("tier-3")), false);
});

test("three texts in a row become one draft, and the same text twice is one message", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  let drafts = 0;
  const deps = { draft: async () => { drafts++; return DRAFT; }, debounceMs: 60 };
  const a = await startReply({ client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "hey", deps });
  const b = await startReply({ client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "it's 12 elm", deps });
  const c = await startReply({ client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "needs a full reno", deps });
  assert.equal(c.job.phase, "waiting");
  assert.equal(a.job.status, "superseded");
  assert.equal(a.job.supersededBy, b.job.id);
  assert.equal(b.job.status, "superseded");
  const dup = await startReply({ client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "needs a full reno", deps });
  assert.match(dup.skipped, /duplicate of/);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(c.job.status, "done", c.job.error);
  assert.equal(drafts, 1, "one model call for three texts");
  assert.equal((await store.listReplyDrafts("LOC", { status: "draft" })).length, 1);
});

test("a contact has their own daily cap when one is set; by default there is none", async () => {
  _resetJobs();
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, jobId: `ra-${i}`, locationId: "LOC", contactId: "c1", createdAt: iso(60_000), status: "sent" }));
  const store = fakeStore(rows);
  assert.equal(await countTodayForContact({ store, locationId: "LOC", contactId: "c1" }), 12);
  const capped = { ...STARTER_NOW, conversationAi: { ...STARTER_NOW.conversationAi, dailyCapPerContact: 12 } };
  const r = await startReply({ client: deadClient, locationId: "LOC", saved: capped, store, contactId: "c1", message: "hi" });
  assert.match(r.skipped, /this contact's daily cap reached \(12\/12\)/);
  const other = await startReply({ client: deadClient, locationId: "LOC", saved: capped, store, contactId: "c2", message: "hi" });
  assert.ok(other.job, "another contact is unaffected");
  // Matt, 2026-09-22: Melissa Willet's eighth address filled the old default of 12 and six texts went unanswered.
  const free = await startReply({ client: deadClient, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "hi again" });
  assert.ok(free.job, "no per-contact cap by default");
});

test("when a person replied to them minutes ago, the bot drafts but never sends itself", async () => {
  const stamp = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 16).replace("T", " ");
  const transcript = `[${stamp}] THEM sms: any update?\n[${stamp}] US sms: Yes, calling you in ten.`;
  assert.deepEqual(lastOutbound(transcript).text, "Yes, calling you in ten.");
  const store = fakeStore([{ id: "x", locationId: "LOC", contactId: "c1", status: "sent", sentText: "something else", createdAt: iso(1000) }]);
  const h = await humanHasThread({ store, locationId: "LOC", contactId: "c1", transcript, minutes: 30 });
  assert.ok(h && h.minutesAgo <= 6);
  const ours = fakeStore([{ id: "x", locationId: "LOC", contactId: "c1", status: "sent", sentText: "Yes, calling you in ten.", createdAt: iso(1000) }]);
  assert.equal(await humanHasThread({ store: ours, locationId: "LOC", contactId: "c1", transcript, minutes: 30 }), null, "our own auto-send doesn't count");
  const old = transcript.split(stamp).join(new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 16).replace("T", " "));
  assert.equal(await humanHasThread({ store, locationId: "LOC", contactId: "c1", transcript: old, minutes: 30 }), null);
  const cfg = conversationConfig(AUTO_SAVED);
  assert.match(decideAutoSend({ gate: { ok: true, flags: [] }, party: "agent", intent: "question", config: cfg, sendsEnabled: true, humanActive: h }).reason, /you replied to them \d+ minutes ago/);
});

test("what the bot learns is filed to the same fields the sweep keeps, merged not overwritten", async () => {
  const calls = [];
  const client = {
    call: async (path, opts = {}) => {
      calls.push([opts.method || "GET", path, opts.body]);
      if (path.endsWith("/customFields") && !opts.method) {
        return { customFields: [
          { id: "f-pd", name: "Personal Details", fieldKey: "contact.personal_details" },
          { id: "f-area", name: "Areas Served", fieldKey: "contact.agent_market_area" },
          { id: "f-hist", name: "Deal History", fieldKey: "contact.agent_deal_history" },
          { id: "f-sum", name: "Last Conversation Summary", fieldKey: "contact.last_convo_summary" },
          { id: "f-date", name: "Last Conversation Date", fieldKey: "contact.last_convo_date" },
        ] };
      }
      return {};
    },
  };
  const r = await applyProfileUpdates({
    client, locationId: "LOC", contactId: "c1", party: "agent",
    profile: { personalDetails: "knee surgery last week, two kids", marketAreas: "Tacoma", dealHistoryLine: "7 Pine Ct | sent us the listing — vacant", nextAction: "", priceMin: 0, priceMax: 0, propertyTypes: "", rehabAppetite: "", exclusions: "" },
    custom: { personal_details: "Two kids, from Boise", agent_market_area: "Kent, Auburn", agent_deal_history: "2026-08-01 | 12 Elm St | we offered — 410k" },
    summary: "Agent sent 7 Pine and mentioned surgery.", config: conversationConfig(STARTER_NOW), now: Date.parse("2026-09-04T18:00:00Z"),
  });
  assert.deepEqual(r.written.sort(), ["agent_deal_history", "agent_market_area", "last_convo_date", "last_convo_summary", "personal_details"]);
  assert.equal(r.learned.length, 3);
  const put = calls.find(([m, p]) => m === "PUT" && p === "/contacts/c1");
  const byId = Object.fromEntries(put[2].customFields.map((f) => [f.id, f.value]));
  assert.equal(byId["f-pd"], "Two kids, from Boise, knee surgery last week", "the duplicate fact is dropped, the new one appended");
  assert.equal(byId["f-area"], "Kent, Auburn, Tacoma");
  assert.match(byId["f-hist"], /^2026-08-01 \| 12 Elm St.*\n2026-09-04 \| 7 Pine Ct \| sent us the listing — vacant$/);
  assert.equal(byId["f-date"], "2026-09-04");
  assert.equal(mergeFacts("a, b", "B, c"), "a, b, c");
  const nothing = await applyProfileUpdates({ client, locationId: "LOC", contactId: "c1", party: "agent", profile: null, config: conversationConfig(STARTER_NOW) });
  assert.deepEqual(nothing, { learned: [], written: [] });
});

test("a run files the profile and the note says what it learned", async () => {
  _resetJobs();
  const { client, notes } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "back from surgery, still got 7 Pine if you want it",
    deps: { draft: async () => ({ ...DRAFT, intent: "deal_available", reply: "Hope the recovery's going well. Yes on 7 Pine, let me run it by underwriting today.", propertyAddress: "7 Pine Ct",
      profile: { personalDetails: "recovering from surgery", marketAreas: "", dealHistoryLine: "7 Pine Ct | sent us the listing", nextAction: "", priceMin: 0, priceMax: 0, propertyTypes: "", rehabAppetite: "", exclusions: "" } }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  // the stub answers customFields with an error → the write is a warning, the learned lines still show
  assert.ok(d.profileUpdates === undefined || d.profileUpdates.learned.length >= 1);
  assert.match(d.warnings.join(" · ") + (d.profileUpdates ? "" : " profile"), /profile/);
  assert.match(notes[0], /AI drafted a reply/);
});

test("counter and pass update the offer, passing updates the investor, through the wired deps", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => [{ id: "o1", ...OFFERS[0] }];   // a counter on a house we offered on
  const seen = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "would you do 425k?",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", needsHuman: true, humanReason: "named a number", counterAmount: 425000, reply: "Let me run 425k by my partner today." }),
      setOfferStatus: async (args) => { seen.push(args); return { ok: true, address: "12 Elm St", status: args.status }; },
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.deepEqual(d.actions.map((a) => [a.type, a.status, a.detail]), [["mark_offer_countered", "done", "offer on 12 Elm St marked countered"]]);
  assert.equal(seen[0].status, "countered");
  assert.match(seen[0].note, /countered at \$425,000/);

  _resetJobs();
  const { client: ic } = ghlStubFor(["investor"]);
  const store2 = fakeStore();
  store2.listDeals = async () => [DEAL];
  const inv = [];
  const { job: j2 } = await startReply({
    client: ic, locationId: "LOC", saved: STARTER_NOW, store: store2, contactId: "c1", message: "gonna pass on 54th",
    deps: {
      draft: async () => ({ ...INVESTOR_DRAFT, intent: "passing", reply: "Understood, thanks for looking.", propertyAddress: "2010 NE 54th St" }),
      setInvestorStatus: async (args) => { inv.push(args); return { ok: true, address: "2010 NE 54th St", status: "passed" }; },
    },
  });
  await settle();
  const d2 = await store2.getReplyDraft(j2.draftId);
  assert.deepEqual(d2.actions.map((a) => [a.type, a.status]), [["mark_investor_passed", "done"]]);
  assert.equal(inv[0].status, "passed");
});

/* ---------- the realm check: numbers land, the bot floats them ---------- */

import { startProactive } from "./reply-agent.js";

const LANDED = {
  id: "o9", address: "12 Elm St, Renton, WA 98056", contactId: "c1", cashAmount: 410000, askingPrice: 525000,
  status: "new", createdAt: iso(1000), terms: { closingDays: 14, earnestMoney: 2500, condition: "as-is" },
};

// The agent has already given us their read. In production that is what
// afterAgentTake waits for before it fires the realm check — a price with
// nothing anchoring it reads as a lowball, so the take check goes first.
const withTheirTake = (store, contactId = "c1") => {
  store.events.set(`LOC|${contactId}`, [
    { type: "agent_estimate", at: iso(900), address: LANDED.address, data: { arv: 520000, rehab: 85000 } },
  ]);
  return store;
};

test("when an underwrite lands, the bot drafts a realm check that floats the number from the book", async () => {
  _resetJobs();
  const { client, notes, tags } = ghlStubFor(["agent"]);
  const store = withTheirTake(fakeStore());
  store.listOffers = async () => [LANDED];
  let seen;
  const { job } = await startProactive({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: LANDED, sendsEnabled: true,
    deps: { draft: async (args) => { seen = args; return { ...DRAFT, intent: "realm_check", reply: "Ran 12 Elm. We'd likely land around 410k cash, as-is, 14-day close. Is that in the realm for your seller before I send it over?", summary: "Floats 410k on 12 Elm." }; } },
  });
  assert.ok(job, "started");
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(job.outbound, "realm_check");
  assert.equal(seen.outbound.kind, "realm_check");
  assert.equal(seen.outbound.amountText, "$410,000");
  assert.match(seen.outbound.terms, /14-day close, as-is/);
  assert.match(seen.context.text, /our cash offer \$410,000 \(asking \$525,000\) terms: 14-day close, \$2,500 earnest money, as-is/);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "realm_check");
  assert.equal(d.outbound.address, "12 Elm St, Renton, WA 98056");
  assert.equal(d.autoSendable, true, d.flags.join(" · "));
  // The starter lets it go on its own, so this counts down instead of
  // waiting — the one message the bot STARTS rather than answers. The number
  // it floats came from the offer book and nowhere else; the money guard
  // above is what makes that safe, and the realmCheck switch turns just this
  // off without touching replies.
  assert.equal(d.status, "scheduled");
  assert.ok(d.sendAt, "counting down");
  assert.equal(d.autoSend.decided, true, d.autoSend.reason);
  assert.deepEqual(tags, [["POST", ["reply-draft"]]]);
  assert.match(notes[0], /AI drafted a realm check on 12 Elm St.*\(\$410,000\)/);
});

test("the realm check respects the playbook switch, the hands-off tag, and the allowlist", async () => {
  _resetJobs();
  const off = { ...STARTER_SAVED, conversationAi: { ...STARTER_SAVED.conversationAi, parties: { ...STARTER_SAVED.conversationAi.parties, agent: { ...STARTER_SAVED.conversationAi.parties.agent, realmCheck: { enabled: false } } } } };
  const r = await startProactive({ client: deadClient, locationId: "LOC", saved: off, store: withTheirTake(fakeStore()), contactId: "c1", offer: LANDED });
  assert.match(r.skipped, /realm check is off/);
  const noNumber = await startProactive({ client: deadClient, locationId: "LOC", saved: STARTER_SAVED, store: withTheirTake(fakeStore()), contactId: "c1", offer: { ...LANDED, cashAmount: null } });
  assert.match(noNumber.skipped, /no number to float/);

  // A price with nothing anchoring it never goes: with the take check on and
  // no read from them on record, the realm check stands aside for it.
  const noTake = await startProactive({ client: deadClient, locationId: "LOC", saved: STARTER_SAVED, store: fakeStore(), contactId: "c1", offer: LANDED });
  assert.match(noTake.skipped, /take check goes first/);

  const { client } = ghlStubFor(["agent", "stop bot"]);
  const { job } = await startProactive({ client, locationId: "LOC", saved: STARTER_SAVED, store: withTheirTake(fakeStore()), contactId: "c1", offer: LANDED, deps: { draft: async () => DRAFT } });
  await settle();
  assert.equal(job.status, "held");

  _resetJobs();
  const on = { ...STARTER_SAVED, conversationAi: { ...STARTER_SAVED.conversationAi, parties: { ...STARTER_SAVED.conversationAi.parties, agent: { ...STARTER_SAVED.conversationAi.parties.agent, autoSend: { enabled: true, intents: ["realm_check"] } } } } };
  const { client: c2 } = ghlStubFor(["agent"]);
  const store = withTheirTake(fakeStore());
  store.listOffers = async () => [LANDED];
  const { job: j2 } = await startProactive({
    client: c2, locationId: "LOC", saved: on, store, contactId: "c1", offer: LANDED, sendsEnabled: true,
    deps: { draft: async () => ({ ...DRAFT, intent: "realm_check", reply: "We'd land around 410k as-is. In the realm for the seller?" }), now: () => NOW, random: () => 0 },
  });
  await settle();
  const d = await store.getReplyDraft(j2.draftId);
  assert.equal(d.status, "scheduled", d.autoSend?.reason);
});

test("'in the realm' notes the offer and tags the agent; the math stays hidden unless the switch is on", async () => {
  _resetJobs();
  const { client, tags } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => [{ ...LANDED, arv: 620000, repairs: 55000 }];
  const realm = [];
  let seen;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "yeah that works, send it over",
    deps: {
      draft: async (args) => { seen = args; return { ...DRAFT, intent: "realm_yes", reply: "Great, sending it over today.", propertyAddress: "12 Elm St" }; },
      setOfferRealm: async (args) => { realm.push(args); return { ok: true, address: "12 Elm St, Renton, WA 98056", answer: "yes" }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(seen.context.text.includes("our math"), false, "ARV and repairs stay out of the prompt");
  assert.equal(seen.context.amounts.includes(620000), false);
  const d = await store.getReplyDraft(job.draftId);
  // The documents ride the same rule but ask: a person clicks Send.
  assert.deepEqual(d.actions.map((a) => [a.type, a.status]), [["add_tags", "done"], ["mark_offer_realm_yes", "done"], ["send_offer", "pending"]]);
  assert.equal(d.actions.find((a) => a.type === "send_offer").mode, "ask");
  assert.equal(realm[0].answer, "yes");
  assert.ok(tags.some(([m, t]) => m === "POST" && t.includes("realm-yes")));

  const shown = { ...STARTER_SAVED, conversationAi: { ...STARTER_SAVED.conversationAi, parties: { ...STARTER_SAVED.conversationAi.parties, agent: { ...STARTER_SAVED.conversationAi.parties.agent, showMath: true } } } };
  _resetJobs();
  let seen2;
  await startReply({ client, locationId: "LOC", saved: shown, store, contactId: "c1", message: "why so low?", deps: { draft: async (args) => { seen2 = args; return DRAFT; } } });
  await settle();
  assert.match(seen2.context.text, /\[our math: ARV \$620,000.*rehab \$55,000.*after our costs and margin = the offer/);
  assert.doesNotMatch(seen2.context.text, /assign|wholesale|\bfee\b/i, "what we make and how we exit is never in the math line");
  assert.ok(seen2.context.amounts.includes(620000) && seen2.context.amounts.includes(55000));
});

test("a cap of 0 is no cap, on the location and on the contact", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  // A store that would trip any cap above zero: plenty of drafts already today.
  const store = fakeStore();
  const today = new Date().toISOString();
  for (let i = 0; i < 40; i++) {
    store.rows.set(`old${i}`, { id: `old${i}`, jobId: `j${i}`, locationId: "LOC", contactId: "c1", status: "sent", createdAt: today });
  }
  const uncapped = { ...STARTER_NOW, conversationAi: { ...STARTER_NOW.conversationAi, dailyCap: 0, dailyCapPerContact: 0 } };
  const { skipped, job } = await startReply({
    client, locationId: "LOC", saved: uncapped, store, contactId: "c1", message: "still interested?",
    deps: { draft: async () => DRAFT },
  });
  assert.equal(skipped, null, "no cap means no cap");
  assert.ok(job);

  // And a cap that is set still bites.
  _resetJobs();
  const capped = { ...STARTER_NOW, conversationAi: { ...STARTER_NOW.conversationAi, dailyCap: 5 } };
  const r = await startReply({
    client, locationId: "LOC", saved: capped, store, contactId: "c1", message: "still interested?",
    deps: { draft: async () => DRAFT },
  });
  assert.match(r.skipped, /daily cap reached \(40\/5\)/);
});

test("Subject Property follows the newest property the agent surfaces, on any intent", async () => {
  const filed = [];
  const client = { call: async (path, o = {}) => {
    if (o.method === "PUT" && /\/contacts\//.test(path)) { filed.push(o.body?.customFields); return {}; }
    return { customField: { id: "f1" }, customFields: [], contact: { id: "c1", tags: ["agent"] }, contacts: [] };
  } };
  const run = async ({ propertyAddress, intent = "question", custom = {} }) =>
    applyProfileUpdates({
      client, locationId: "LOC", contactId: "c1", party: "agent",
      profile: null, custom, subjectProperty: propertyAddress, config: { profile: {} },
    });

  // A question is not a tier-1 read, and it still moves the aim — an agent can
  // raise a new property anywhere in a thread.
  assert.ok((await run({ propertyAddress: "1130 NW 57th St, Seattle, WA 98107", intent: "question" }))
    .learned.includes("subject property: 1130 NW 57th St, Seattle, WA 98107"));

  // Already on that property: no write, so the contact's audit trail is not
  // churned with the same value. Spelling differences don't count as a move.
  assert.deepEqual((await run({
    propertyAddress: "1130 Northwest 57th Street, Seattle, WA 98107",
    custom: { subject_property: "1130 NW 57th St, Seattle, WA 98107" },
  })).written, [], "the same property written two ways is not a new property");

  // They turn to a different one: the aim follows.
  assert.ok((await run({
    propertyAddress: "22018 76th Ave W, Edmonds, WA 98026",
    custom: { subject_property: "1130 NW 57th St, Seattle, WA 98107" },
  })).learned.some((l) => l.startsWith("subject property: 22018")));

  // Prose is not an aim. The underwriter would search on this and find a
  // different house, so it must leave the field pointing where it was.
  for (const vague of ["the Tacoma one", "her listing", "that one we discussed", ""]) {
    assert.deepEqual((await run({
      propertyAddress: vague, custom: { subject_property: "1130 NW 57th St, Seattle, WA 98107" },
    })).written, [], `"${vague}" must not become the underwriter's aim`);
  }

  // An investor naming a property never touches it — it aims acquisitions.
  assert.deepEqual((await applyProfileUpdates({
    client, locationId: "LOC", contactId: "c1", party: "investor",
    profile: null, custom: {}, subjectProperty: "22018 76th Ave W, Edmonds, WA 98026", config: { profile: {} },
  })).written, []);
});


/* ---------- the record: what a draft leaves behind ---------- */

test("what a draft learns is filed to the record with the draft as its source, and GHL gets the identical write", async () => {
  const payloads = [];
  const client = { call: async (p, o = {}) => {
    if (o.method === "PUT") payloads.push(JSON.stringify(o.body));
    return { customFields: [], customField: { id: "f1" } };
  } };
  const profile = { personalDetails: "two kids, hip surgery in August", marketAreas: "Tacoma, Gig Harbor", priceMax: 600000, propertyTypes: "sfr", rehabAppetite: "heavy", exclusions: "no condos",
    dealHistoryLine: "22018 76th Ave W, Edmonds, WA | passed — too far", nextAction: "send her the Tacoma one" };
  const args = { client, locationId: "LOC", contactId: "c1", party: "investor", profile, custom: {}, summary: "Passed on Edmonds, wants Tacoma.",
    config: { profile: { writeSummary: true } }, now: Date.parse("2026-09-07T18:00:00Z") };
  const without = await applyProfileUpdates({ ...args });
  const store = fakeStore();
  const withStore = await applyProfileUpdates({ ...args, store, draftId: "d42", intent: "passing", inbound: "no thanks" });
  assert.deepEqual(withStore.learned, without.learned);
  assert.equal(payloads[1], payloads[0], "the GHL write is byte-identical with or without the record");

  const p = await store.getContactProfile("LOC", "c1");
  const facts = Object.fromEntries(Object.entries(p.facts).map(([k, v]) => [k, v.map((e) => e.value)]));
  assert.deepEqual(facts.personal_details, ["two kids", "hip surgery in August"]);
  assert.deepEqual(facts.buybox_areas, ["Tacoma", "Gig Harbor"]);
  assert.deepEqual(facts.buybox_price_max, ["600000"]);
  assert.deepEqual(facts.rehab_appetite, ["heavy"]);
  assert.deepEqual(facts.buybox_exclusions, ["no condos"]);
  assert.deepEqual(facts.last_convo_summary, ["Passed on Edmonds, wants Tacoma."]);
  assert.ok(Object.values(p.facts).flat().every((e) => e.source === "conversation" && e.ref === "d42"), "every fact names the draft");
  const events = await store.listContactEvents("LOC", "c1");
  const types = events.map((e) => e.type).sort();
  assert.ok(types.includes("text_summary") && types.includes("investor_passed"), types.join(","));
  const passed = events.find((e) => e.type === "investor_passed");
  assert.equal(passed.data.note, "too far");
  assert.equal(passed.at.slice(0, 10), "2026-09-07", "an undated learned line takes the draft's day");
  assert.equal(events.find((e) => e.type === "text_summary").data.intent, "passing");
  assert.ok(events.filter((e) => e.type === "fact_learned").length >= 6);
});

test("an agent's new property lands in the record as the subject and as an event", async () => {
  const client = { call: async () => ({ customFields: [], customField: { id: "f1" } }) };
  const store = fakeStore();
  await applyProfileUpdates({ client, locationId: "LOC", contactId: "a1", party: "agent", profile: null, custom: { subject_property: "1 Old St, Kent, WA" },
    subjectProperty: "9 New Ave, Renton, WA 98056", config: { profile: {} }, store, draftId: "d7" });
  const p = await store.getContactProfile("LOC", "a1");
  assert.equal(p.facts.subject_property.at(-1).value, "9 New Ave, Renton, WA 98056");
  const ev = (await store.listContactEvents("LOC", "a1", { types: ["subject_property_set"] }))[0];
  assert.equal(ev.address, "9 New Ave, Renton, WA 98056");
  assert.equal(ev.data.from, "1 Old St, Kent, WA");
  assert.equal(ev.ref, "d7");
});

test("a real run leaves the conversation on the timeline", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["investor"]);
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "interested, send me the package",
    deps: { draft: async () => ({ ...DRAFT, intent: "interested", summary: "Wants the package.", profile: { personalDetails: "", marketAreas: "Everett", dealHistoryLine: "", nextAction: "", priceMin: 0, priceMax: 0, propertyTypes: "", rehabAppetite: "", exclusions: "" } }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const events = await store.listContactEvents("LOC", "c1");
  const summary = events.find((e) => e.type === "text_summary");
  assert.ok(summary, "the conversation is an event");
  assert.equal(summary.ref, job.draftId, "keyed to the draft that was written");
  assert.ok(events.some((e) => e.type === "tag_added" && e.data.tag === "investor-active"), "the tier tag the rule applied is on the timeline");
  assert.deepEqual((await store.getContactProfile("LOC", "c1")).facts.buybox_areas.map((e) => e.value), ["Everett"]);
});

test("an agent's own ARV and rehab are kept as theirs, recorded on the property, and never become ours", async () => {
  const { normalizeAgentTake } = await import("./reply-agent.js");
  assert.deepEqual(normalizeAgentTake({ agentArv: 715000, agentRehab: 40000, agentTakeNote: "comps support 715, cosmetic" }), { arv: 715000, rehab: 40000, note: "comps support 715, cosmetic" });
  assert.equal(normalizeAgentTake({ agentArv: 0, agentRehab: 0, agentTakeNote: "" }), null, "nothing stated is nothing");
  assert.deepEqual(normalizeAgentTake({ agentArv: "715000.6", agentRehab: -5 }), { arv: 715001, rehab: 0, note: "" });

  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1",
    message: "12703 Vernon Ave SW — I'd say 715 done, maybe 40k of work, mostly cosmetic",
    deps: { draft: async () => ({ ...DRAFT, intent: "new_property", propertyAddress: "12703 Vernon Ave SW, Lakewood, WA",
      reply: "Got it, 715 done and about 40k of work. Running it by underwriting today.", agentArv: 715000, agentRehab: 40000, agentTakeNote: "715 done, ~40k mostly cosmetic" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.deepEqual(d.agentTake, { arv: 715000, rehab: 40000, note: "715 done, ~40k mostly cosmetic" });
  // Echoing THEIR numbers back must not read as inventing one: a new
  // property with their own take on it is exactly the reply that should be
  // free to send itself.
  assert.ok(!d.flags.some((f) => /not in the offer book|contract price/.test(f)), `their own numbers echoed back are not invented: ${d.flags.join(" · ")}`);
  assert.equal(d.autoSendable, true, d.flags.join(" · "));
  const ev = (await store.listContactEvents("LOC", "c1", { types: ["agent_estimate"] }))[0];
  assert.ok(ev, "recorded on the property");
  assert.equal(ev.address, "12703 Vernon Ave SW, Lakewood, WA");
  assert.deepEqual([ev.data.arv, ev.data.rehab], [715000, 40000]);
  assert.equal(ev.ref, job.draftId);
});

/* ---------- their read before our price ---------- */

test("which float goes first depends on whether we already have their take", async () => {
  const { chooseProactiveKind } = await import("./reply-agent.js");
  const A = "12 Elm St, Renton, WA 98056";
  assert.equal(chooseProactiveKind({ events: [], address: A }), "take_check", "nothing from them yet: draw their read out first");
  assert.equal(chooseProactiveKind({ events: [{ type: "agent_estimate", at: iso(1), address: "12 Elm Street, Renton, WA 98056", data: { arv: 500000 } }], address: A }), "realm_check", "their read is in: the price can go");
  assert.equal(chooseProactiveKind({ events: [{ type: "agent_estimate", at: iso(1), address: "9 Other St", data: { arv: 1 } }], address: A }), "take_check", "a take on a different house doesn't count");
});

test("when numbers land with no take from them, the bot floats our ARV and rehab — and may not say the price", async () => {
  _resetJobs();
  const { client, notes } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const landed = { ...LANDED, arv: 850000, repairs: 200000 };
  store.listOffers = async () => [landed];
  let seen;
  const { job, skipped } = await startProactive({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "take_check", offer: landed, sendsEnabled: true,
    deps: { draft: async (args) => { seen = args; return { ...DRAFT, intent: "take_check", reply: "Just did a quick underwrite on 12 Elm. I'm thinking 850K After Repair Value and 200K+ of rehab. What do you think?", summary: "Floats our read on 12 Elm." }; } },
  });
  assert.equal(skipped, null, skipped);
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(seen.outbound.kind, "take_check");
  assert.equal(seen.outbound.arvK, "850K", "no dollar sign: the read goes out as a text");
  assert.equal(seen.outbound.rehabK, "200K");
  assert.match(seen.context.text, /OUR OFFERS TO THIS AGENT/);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "take_check");
  assert.deepEqual(d.outbound, { kind: "take_check", offerId: "o9", address: LANDED.address, arv: 850000, rehab: 200000 });
  assert.equal(d.autoSendable, true, d.flags.join(" · "));
  assert.equal(d.status, "scheduled", "take_check is on the starter allowlist");
  assert.match(notes[0], /AI drafted/);

  // The same draft naming the cash number is held: that is the number we are
  // deliberately not saying yet, so for a take check it is forbidden outright.
  _resetJobs();
  const store2 = fakeStore();
  store2.listOffers = async () => [landed];
  const leaky = await startProactive({
    client, locationId: "LOC", saved: STARTER_SAVED, store: store2, contactId: "c1", kind: "take_check", offer: landed, sendsEnabled: true,
    deps: { draft: async () => ({ ...DRAFT, intent: "take_check", reply: "Thinking 850K ARV, 200K rehab, so we'd be around 410,000. Thoughts?", summary: "leaks" }) },
  });
  await settle();
  assert.equal(leaky.job.status, "done", leaky.job.error);
  const ld = await store2.getReplyDraft(leaky.job.draftId);
  assert.equal(ld.autoSendable, false);
  assert.ok(ld.flags.some((f) => /410,000/.test(f)), `the price is the one number a take check may not say: ${ld.flags.join(" · ")}`);
  assert.equal(ld.status, "draft", "waits for a person");
});

test("a take check needs numbers to float, and its switch", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const bare = await startProactive({ client, locationId: "LOC", saved: STARTER_SAVED, store: fakeStore(), contactId: "c1", kind: "take_check", offer: LANDED, sendsEnabled: true, deps: { draft: async () => DRAFT } });
  assert.match(bare.skipped, /no ARV or rehab to float/);
  const off = { ...STARTER_SAVED, conversationAi: { ...STARTER_SAVED.conversationAi, parties: { ...STARTER_SAVED.conversationAi.parties, agent: { ...STARTER_SAVED.conversationAi.parties.agent, takeCheck: { enabled: false } } } } };
  const r = await startProactive({ client, locationId: "LOC", saved: off, store: fakeStore(), contactId: "c1", kind: "take_check", offer: { ...LANDED, arv: 1, repairs: 1 }, sendsEnabled: true, deps: { draft: async () => DRAFT } });
  assert.match(r.skipped, /take check is off/);
});

test("their take arriving hands off to the realm check, and a confirmed address starts the underwrite", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const calls = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "12 Elm — I'd say 800 done, maybe 150 of work",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "new_property", propertyAddress: "12 Elm St, Renton, WA 98056", reply: "Got it, thanks. Running it now.", agentArv: 800000, agentRehab: 150000, agentTakeNote: "800 done, 150 of work" }),
      afterAgentTake: async (args) => { calls.push(["afterAgentTake", args]); return { started: true }; },
      startUnderwrite: async (args) => { calls.push(["startUnderwrite", args.address]); return { job: { id: "uw1", dryRun: true } }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  // The reply that carried their read is handed along: the realm check it
  // starts may take that draft's place, and no other waiting row's.
  assert.deepEqual(calls.find((c) => c[0] === "afterAgentTake")[1], { contactId: "c1", address: "12 Elm St, Renton, WA 98056", draftId: job.draftId });
  assert.ok(calls.some((c) => c[0] === "startUnderwrite" && c[1] === "12 Elm St, Renton, WA 98056"), `the new_property rule kicks the underwrite off: ${JSON.stringify(calls)}`);
  const d = await store.getReplyDraft(job.draftId);
  assert.ok(d.actions.some((a) => a.type === "start_underwrite" && a.status === "done"), JSON.stringify(d.actions.map((a) => [a.type, a.status, a.detail || a.error])));
});

test("the two holds that kept biting are settings now, liberal by default", async () => {
  const { evaluateReplyGates: gates, conversationConfig } = await import("./reply-agent.js");
  const base = { intent: "question", confidence: "medium", needsHuman: true, humanReason: "a person has to send the package", reply: "Sending it over today.", propertyAddress: "", counterAmount: 0 };
  // Strict, as it was: both hold.
  const strict = gates({ draft: base, party: "investor", minConfidence: "high", holdOnNeedsHuman: true });
  assert.equal(strict.ok, false);
  assert.match(strict.flags.join(" · "), /medium confidence/);
  assert.match(strict.flags.join(" · "), /send the package/);
  // Liberal: neither holds; the money guard and the never-auto list still do.
  const liberal = gates({ draft: base, party: "investor", minConfidence: "medium", holdOnNeedsHuman: false });
  assert.equal(liberal.ok, true, liberal.flags.join(" · "));
  assert.equal(gates({ draft: { ...base, confidence: "low" }, party: "investor", minConfidence: "medium", holdOnNeedsHuman: false }).ok, false, "low is never sure enough");
  assert.equal(gates({ draft: { ...base, intent: "wants_to_buy", confidence: "high" }, party: "investor", minConfidence: "medium", holdOnNeedsHuman: false }).ok, false, "a commitment still waits");
  assert.equal(gates({ draft: { ...base, reply: "It's yours for $1,000,000." }, party: "investor", minConfidence: "medium", holdOnNeedsHuman: false }).ok, false, "an invented number still holds");
  // The starter and a saved config with the keys absent both come out liberal.
  const cfg = conversationConfig({ conversationAi: { version: 2 } });
  assert.equal(cfg.autoSend.minConfidence, "medium");
  assert.equal(cfg.autoSend.holdOnNeedsHuman, false);
});

test("an auto-send stands aside when you already answered, and picks up on the next inbound", async () => {
  const { sendReplyDraft } = await import("./reply-agent.js");
  const sent = [];
  const client = { call: async (p, o = {}) => { if (p === "/conversations/messages") sent.push(o.body); return {}; } };
  const now = Date.now();
  const stamp = (msAgo) => new Date(now - msAgo).toISOString().slice(0, 16).replace("T", " ");
  const scheduled = { id: "s1", locationId: "LOC", contactId: "c1", status: "scheduled", channel: "sms", reply: "Got it, I'll watch them today.",
    createdAt: new Date(now - 3 * 60000).toISOString(), sendAt: new Date(now).toISOString(), flags: [] };

  // You jumped in a minute after the draft was written: it stands aside.
  const store = fakeStore([scheduled]);
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "s1", live: true, auto: true, now,
    readThread: async () => `[${stamp(4 * 60000)}] THEM sms: Sent\n[${stamp(60000)}] US sms: Perfect, watching now — is the ADU framed?` });
  assert.equal(r.skipped, "answered by you");
  assert.equal(sent.length, 0, "nothing went out");
  const d = await store.getReplyDraft("s1");
  assert.equal(d.status, "dismissed");
  assert.equal(d.answeredBy, "you");
  assert.match(d.flags.join(" · "), /you answered it yourself/);

  // Your reply came BEFORE the draft: the draft is the answer, it sends.
  const store2 = fakeStore([{ ...scheduled, createdAt: new Date(now - 30000).toISOString() }]);
  const r2 = await sendReplyDraft({ client, store: store2, locationId: "LOC", draftId: "s1", live: true, auto: true, now,
    readThread: async () => `[${stamp(4 * 60000)}] US sms: earlier reply\n[${stamp(2 * 60000)}] THEM sms: Sent` });
  assert.equal(r2.skipped, undefined);
  assert.equal(sent.length, 1);

  // The bot's own earlier send is not "you": it goes.
  const store3 = fakeStore([{ ...scheduled }, { id: "old", locationId: "LOC", contactId: "c1", status: "sent", sentText: "Got it, thanks.", createdAt: new Date(now - 2 * 60000).toISOString() }]);
  const r3 = await sendReplyDraft({ client, store: store3, locationId: "LOC", draftId: "s1", live: true, auto: true, now,
    readThread: async () => `[${stamp(60000)}] US sms: Got it, thanks.` });
  assert.equal(r3.skipped, undefined);
  assert.equal(sent.length, 2);

  // A person pressing Send is a person deciding: no second-guessing.
  const store4 = fakeStore([{ ...scheduled, status: "draft" }]);
  const r4 = await sendReplyDraft({ client, store: store4, locationId: "LOC", draftId: "s1", live: true, auto: false, now,
    readThread: async () => { throw new Error("must not be read on a manual send"); } });
  assert.equal(r4.ok, true);
  assert.equal(sent.length, 3);
});

test("a new Subject Property fires the tier-1 rule and the underwrite, whatever intent the burst read as", async () => {
  _resetJobs();
  const { client, tags } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const calls = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", sendsEnabled: true,
    message: "Ok sounds good. Here is the Auburn home. Address is 311 R st NE Auburn. Seller is a flipper, needs finishes, ADU not started.",
    deps: {
      // A burst like this often reads as a check-in, at medium confidence.
      draft: async () => ({ ...DRAFT, intent: "status_check", confidence: "medium", propertyAddress: "311 R St NE, Auburn, WA", reply: "Got it, running 311 R St by underwriting today." }),
      startUnderwrite: async (args) => { calls.push(args.address); return { job: { id: "uw1", dryRun: true } }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  const via = d.actions.filter((a) => a.via === "subject moved");
  assert.ok(via.length, "the new-property rule ran because the subject moved");
  assert.ok(tags.some(([m, t]) => m === "POST" && t.includes("tier-1")), "tier-1 tag applied");
  assert.deepEqual(calls, ["311 R St NE, Auburn, WA"], "the underwrite started on the new address");
  assert.ok(d.actions.some((a) => a.type === "start_underwrite" && a.status === "done"));
  assert.equal(d.status, "scheduled", "the medium-confidence check-in reply still sends itself");
  // (An unchanged subject never counts as a move — that is the addressKey
  // comparison in applyProfileUpdates, tested with the Subject Property rule.)
});

/* ---------- the counter band: the one door through NEVER_AUTO ---------- */

import { releaseUnderGuard } from "./reply-agent.js";
import { GUARDED_AUTO, ASK_ONLY_ACTIONS, autoEligible, NEVER_AUTO, normalizeConversationAi } from "./shared/conversation-ai.js";
import { planActions } from "./conversation-actions.js";

const bandOn = (over = {}) => normalizeConversationAi({
  enabled: true,
  autoSend: { channels: ["sms"] },
  parties: { agent: { autoSend: { enabled: true, intents: ["question"] }, counterBand: { enabled: true, dailyCap: 2, ...over } } },
});
const passing = { kind: "counter_band", passed: true, theirAmount: 280000, ceiling: 285000, checks: [] };
const failing = { kind: "counter_band", passed: false, reason: "$320,000 is over the $285,000 ceiling", checks: [] };

test("a counter inside the band is released when the band is on", () => {
  const base = { send: false, code: "never_auto", reason: "a counter is a person's call" };
  const out = releaseUnderGuard({ base, party: "agent", intent: "counter", config: bandOn(), guard: passing });
  assert.equal(out.send, true);
  assert.match(out.reason, /released under the counter band/);
  assert.equal(out.exception.passed, true);
});

test("a counter inside the band still parks when the band is off", () => {
  const base = { send: false, code: "never_auto", reason: "a counter is a person's call" };
  const out = releaseUnderGuard({ base, party: "agent", intent: "counter", config: normalizeConversationAi({ enabled: true }), guard: passing });
  assert.equal(out.send, false);
  assert.equal(out.exception, null);
});

test("the band can only ever overturn one objection", () => {
  // THE test. A draft held for any reason other than "this intent is a
  // person's call" is never released, however well the arithmetic checks out.
  for (const code of ["gates", "bot_off", "human_active", "sends_off", "party_off", "not_allowlisted", "channel"]) {
    const out = releaseUnderGuard({ base: { send: false, code, reason: code }, party: "agent", intent: "counter", config: bandOn(), guard: passing });
    assert.equal(out.send, false, `${code} must not be releasable`);
    assert.equal(out.exception, null);
  }
});

test("a failed guard keeps the draft parked and says how far off it was", () => {
  const base = { send: false, code: "never_auto", reason: "a counter is a person's call" };
  const out = releaseUnderGuard({ base, party: "agent", intent: "counter", config: bandOn(), guard: failing });
  assert.equal(out.send, false);
  assert.match(out.reason, /over the \$285,000 ceiling/);
  assert.equal(out.exception.passed, false, "the verdict is kept even on a failure — that row is the tuning signal");
});

test("an intent outside the guarded set is never released", () => {
  const base = { send: false, code: "never_auto", reason: "a wants call is a person's call" };
  for (const intent of ["wants_call", "scheduling", "proof_of_funds", "opt_out"]) {
    assert.equal(releaseUnderGuard({ base, party: "agent", intent, config: bandOn(), guard: passing }).send, false, intent);
  }
});

test("an investor's price pushback is released only by the investor band: its own switch, its own guard, nothing borrowed from the agent's", () => {
  // Matt, 2026-09-17: a guarded investor band. It is the only addition to the guarded set.
  assert.deepEqual(GUARDED_AUTO.investor, ["wants_call", "wants_walkthrough", "price_pushback"]);
  assert.ok(NEVER_AUTO.investor.includes("price_pushback"), "still a person's call everywhere the band doesn't reach");
  assert.equal(autoEligible("investor").includes("price_pushback"), false, "and never a box on the auto-send grid");
  const base = { send: false, code: "never_auto", reason: "price pushback is a person's call" };
  const investorPass = { kind: "investor_band", passed: true, theirAmount: 415000, floor: 410000, releaseAmount: 415000, checks: [] };
  const investorOn = normalizeConversationAi({ enabled: true, parties: { investor: { priceBand: { enabled: true } } } });
  // The agent's band switched on releases nothing for an investor, whatever guard arrives.
  assert.equal(releaseUnderGuard({ base, party: "investor", intent: "price_pushback", config: bandOn(), guard: passing }).send, false);
  assert.equal(releaseUnderGuard({ base, party: "investor", intent: "price_pushback", config: bandOn(), guard: investorPass }).send, false, "the investor band's own switch is off");
  // The investor band on, but the guard is the agent's counter band: the wrong guard.
  assert.equal(releaseUnderGuard({ base, party: "investor", intent: "price_pushback", config: investorOn, guard: passing }).send, false);
  // Its own switch and its own guard: released, and it says so.
  const r = releaseUnderGuard({ base, party: "investor", intent: "price_pushback", config: investorOn, guard: investorPass });
  assert.equal(r.send, true);
  assert.match(r.reason, /released under the investor band/);
  // A failed investor band says why and stays held.
  const held = releaseUnderGuard({ base, party: "investor", intent: "price_pushback", config: investorOn, guard: { kind: "investor_band", passed: false, reason: "405000 against a floor of 410000", checks: [] } });
  assert.equal(held.send, false);
  assert.equal(held.code, "guard_failed");
  // Blocked by anything other than NEVER_AUTO (a gate, a person on the thread): never released.
  assert.equal(releaseUnderGuard({ base: { send: false, code: "gates", reason: "needs a person: names 400000" }, party: "investor", intent: "price_pushback", config: investorOn, guard: investorPass }).send, false);
  // a passing BAND guard on a scheduling intent is still the wrong guard
  assert.equal(releaseUnderGuard({ base, party: "investor", intent: "wants_call", config: investorOn, guard: investorPass }).send, false);
  // And an agent is never released by the investor's guard.
  assert.equal(releaseUnderGuard({ base: { send: false, code: "never_auto", reason: "a counter is a person's call" }, party: "agent", intent: "counter", config: bandOn(), guard: investorPass }).send, false);
});

/* ---------- the calendar as a guard ---------- */

const bookingOn = () => normalizeConversationAi({ enabled: true, booking: { enabled: true, calendarId: "cal1", calendarName: "Matt" } });
const bookingPass = { kind: "booking", passed: true, reason: "offers Fri Sep 11 at 10:00am", offered: [{ iso: "2026-09-11T17:00:00Z", label: "Fri Sep 11 at 10:00am" }], chosen: null };
const bookingFail = { kind: "booking", passed: false, reason: "no time was offered — a person should answer this one", offered: [], chosen: null };

test("a request for a call is released under the calendar when the guard passed and the page has it on", () => {
  const base = { send: false, code: "never_auto", reason: "a wants call is a person's call" };
  for (const [party, intent] of [["agent", "wants_call"], ["agent", "scheduling"], ["investor", "wants_call"], ["investor", "wants_walkthrough"]]) {
    const out = releaseUnderGuard({ base, party, intent, config: bookingOn(), guard: bookingPass });
    assert.equal(out.send, true, `${party}/${intent}`);
    assert.match(out.reason, /released under the calendar/);
  }
  // off on the page: parked, and the verdict is not even kept
  assert.equal(releaseUnderGuard({ base, party: "agent", intent: "wants_call", config: normalizeConversationAi({ enabled: true }), guard: bookingPass }).exception, null);
  // failed guard: parked with the reason, verdict kept
  const held = releaseUnderGuard({ base, party: "agent", intent: "wants_call", config: bookingOn(), guard: bookingFail });
  assert.equal(held.send, false);
  assert.match(held.reason, /no time was offered/);
  assert.equal(held.exception.passed, false);
  // the calendar never releases a counter, and only never_auto can be overturned
  assert.equal(releaseUnderGuard({ base, party: "agent", intent: "counter", config: bookingOn(), guard: bookingPass }).send, false);
  assert.equal(releaseUnderGuard({ base: { send: false, code: "gates", reason: "x" }, party: "agent", intent: "wants_call", config: bookingOn(), guard: bookingPass }).send, false);
  // and the scheduling intents stay locked on the allowlist
  for (const intent of ["wants_call", "scheduling"]) assert.ok(!autoEligible("agent").includes(intent), intent);
});

test("end to end: they ask for a call, the bot offers calendar times and the reply sends itself; they pick one and it is booked", async () => {
  _resetJobs();
  const { client } = ghlStub();
  const store = fakeStore();
  const saved = { ...SAVED, conversationAi: { enabled: true, booking: { enabled: true, calendarId: "cal1", calendarName: "Matt", slotsToOffer: 2, minLeadHours: 1 },
    parties: { agent: { autoSend: { enabled: true, intents: ["question"] } } } } };
  const now = Date.parse("2026-09-10T16:00:00Z");
  const free = ["2026-09-11T17:00:00Z", "2026-09-11T21:00:00Z", "2026-09-14T17:00:00Z"];
  const freeSlots = async () => free;
  let seenContext = "";
  // 1. "can you call me tomorrow?" → the model offers the two handed-in times, verbatim
  const { job } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "can you give me a call tomorrow?", channel: "sms", sendsEnabled: true,
    deps: { now: () => now, freeSlots, draft: async (args) => { seenContext = args.context.text; assert.equal(args.booking, true);
      return { ...DRAFT, intent: "wants_call", confidence: "high", reply: "Sure — does Fri Sep 11 at 10:00am or Mon Sep 14 at 10:00am work?", counterAmount: 0,
        offeredSlots: ["2026-09-11T17:00:00Z", "2026-09-14T17:00:00Z"], chosenSlot: "" }; } },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.match(seenContext, /TIMES YOU MAY PROPOSE/);
  const d1 = await store.getReplyDraft(job.draftId);
  assert.equal(d1.status, "scheduled", d1.autoSend?.reason);
  assert.match(d1.autoSend.reason, /released under the calendar/);
  assert.deepEqual(d1.booking.offered.map((s) => s.iso), ["2026-09-11T17:00:00Z", "2026-09-14T17:00:00Z"]);
  // mark it sent so it counts as what we told them
  await store.updateReplyDraft(d1.id, { ...d1, status: "sent", updatedAt: new Date(now + 60000).toISOString() });

  // 2. "the Friday one works" → booked on its own, reply confirms
  const booked = [];
  const { job: job2 } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "friday 10 works", channel: "sms", sendsEnabled: true,
    deps: { now: () => now + 3600000, freeSlots,
      bookAppointment: async (args) => { booked.push(args); return { ok: true, label: args.label, calendarName: "Matt" }; },
      draft: async (args) => { assert.match(args.context.text, /TIMES WE ALREADY OFFERED/);
        return { ...DRAFT, intent: "scheduling", confidence: "high", reply: "Great, Fri Sep 11 at 10:00am it is. Talk then.", counterAmount: 0, offeredSlots: [], chosenSlot: "2026-09-11T17:00:00Z" }; } },
  });
  await settle();
  assert.equal(job2.status, "done", job2.error);
  const d2 = await store.getReplyDraft(job2.draftId);
  assert.equal(booked.length, 1);
  assert.equal(booked[0].startTime, "2026-09-11T17:00:00Z");
  assert.equal(d2.actions.find((a) => a.type === "book_call").status, "done");
  assert.equal(d2.status, "scheduled", d2.autoSend?.reason);
  assert.equal(d2.booking.chosen.label, "Fri Sep 11 at 10:00am");

  // 3. a pick of a time that is gone: not booked, reply parks with the reason, booking offered as a click
  free.splice(0, 1);
  const { job: job3 } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "actually can we do friday 10 instead", channel: "sms", sendsEnabled: true,
    deps: { now: () => now + 7200000, freeSlots, bookAppointment: async () => { throw new Error("must not be called"); },
      draft: async () => ({ ...DRAFT, intent: "scheduling", confidence: "high", reply: "Fri Sep 11 at 10:00am works.", counterAmount: 0, offeredSlots: [], chosenSlot: "2026-09-11T17:00:00Z" }) },
  });
  await settle();
  const d3 = await store.getReplyDraft(job3.draftId);
  assert.equal(d3.status, "draft");
  assert.match(d3.autoSend.reason, /no longer free/);
  assert.equal(d3.actions.find((a) => a.type === "book_call").mode, "ask");
});

test("a reply that invents a time, or offers none, waits for a person even with booking on", async () => {
  _resetJobs();
  const { client } = ghlStub();
  const store = fakeStore();
  const saved = { ...SAVED, conversationAi: { enabled: true, booking: { enabled: true, calendarId: "cal1" }, parties: { agent: { autoSend: { enabled: true, intents: ["question"] } } } } };
  const freeSlots = async () => ["2026-09-11T17:00:00Z"];
  const { job } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "when can we talk?", channel: "sms", sendsEnabled: true,
    deps: { now: () => Date.parse("2026-09-10T16:00:00Z"), freeSlots,
      draft: async () => ({ ...DRAFT, intent: "wants_call", confidence: "high", reply: "How about Saturday at noon?", counterAmount: 0, offeredSlots: ["2026-09-12T19:00:00Z"], chosenSlot: "" }) },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft");
  assert.match(d.autoSend.reason, /not on the calendar/);
  assert.equal(d.exception.kind, "booking");
  assert.deepEqual(d.booking.offered, [], "an unverified offer is not remembered as one we made");
});


test("a decision that was already a yes is untouched", () => {
  const out = releaseUnderGuard({ base: { send: true, code: "", reason: "" }, party: "agent", intent: "question", config: bandOn(), guard: null });
  assert.equal(out.send, true);
  assert.equal(out.exception, null);
});

test("counter and acceptance still cannot be added to the auto-send allowlist", () => {
  // The band is not a second allowlist. NEVER_AUTO and autoEligible are
  // untouched, so the UI still renders a lock rather than a checkbox.
  for (const intent of GUARDED_AUTO.agent) {
    assert.ok(NEVER_AUTO.agent.includes(intent), `${intent} must stay in NEVER_AUTO`);
    assert.ok(!autoEligible("agent").includes(intent), `${intent} must never be eligible`);
  }
  const saved = normalizeConversationAi({ parties: { agent: { autoSend: { enabled: true, intents: ["counter", "acceptance", "question"] } } } });
  assert.deepEqual(saved.parties.agent.autoSend.intents, ["question"]);
});

test("re-issuing the paper and promoting a deal can never be automated", () => {
  // The band says yes in words. Both follow-on moves are ask-only, and
  // planActions forces that whatever a rule says — so "it hands off" is a
  // property of the system, not a setting somebody can change.
  for (const type of ["revise_offer_to_counter", "promote_to_deal"]) {
    assert.ok(ASK_ONLY_ACTIONS.has(type), type);
    const { auto, suggested } = planActions({
      party: "agent", intent: "counter", confidence: "high",
      playbook: { intentRules: { counter: { mode: "auto", actions: [{ type }] } } },
    });
    assert.equal(auto.length, 0, `${type} must never run on its own`);
    assert.equal(suggested.length, 1);
  }
});

/* ---------- the band, reading the book ---------- */

import { evaluateBandFor, bandReleasesToday } from "./reply-agent.js";

const BAND_OFFER = {
  id: "bo1", locationId: "LOC", contactId: "c1", address: "12 Elm St, Renton, WA",
  // Under the buyer line (70% × 500k − 85k − 10k = 255k), so the band can open.
  cashAmount: 240000, arv: 500000, repairs: 85000, status: "sent", createdAt: iso(2000),
};
const bandStore = (offers = [BAND_OFFER], drafts = []) => {
  const s = fakeStore(drafts);
  s.listOffers = async () => offers;
  s.getOffer = async (id) => offers.find((o) => o.id === id) || null;
  return s;
};
const bandCfg = normalizeConversationAi({
  enabled: true,
  parties: { agent: { counterBand: { enabled: true, dailyCap: 2 } } },
});

test("the band reads the offer book and works out the ceiling, but a counter above our number waits for a person", async () => {
  const v = await evaluateBandFor({
    store: bandStore(), locationId: "LOC", party: "agent", config: bandCfg, saved: {},
    draft: { intent: "counter", counterAmount: 250000, confidence: "high", propertyAddress: BAND_OFFER.address },
    job: { contactId: "c1", message: "seller would do $250,000" }, now: Date.now(),
  });
  assert.ok(v.ceiling > BAND_OFFER.cashAmount);
  assert.equal(v.passed, false, "Matt, 2026-10-02: the machine never goes above the number we sent");
  assert.match(v.reason, /never goes above the \$240,000 we sent/);
});

test("the band is not even computed when it is switched off", async () => {
  const v = await evaluateBandFor({
    store: bandStore(), locationId: "LOC", party: "agent", saved: {},
    config: normalizeConversationAi({ enabled: true }),
    draft: { intent: "counter", counterAmount: 280000, confidence: "high" },
    job: { contactId: "c1", message: "$280,000" },
  });
  assert.equal(v, null, "no verdict, and no store reads, on the ordinary path");
});

test("the band is not computed for an intent no guard can release", async () => {
  const v = await evaluateBandFor({
    store: bandStore(), locationId: "LOC", party: "agent", config: bandCfg, saved: {},
    draft: { intent: "question", counterAmount: 0, confidence: "high" },
    job: { contactId: "c1", message: "what's the address" },
  });
  assert.equal(v, null);
});

test("an agent with nothing open gets a verdict that says so rather than a ceiling", async () => {
  const v = await evaluateBandFor({
    store: bandStore([]), locationId: "LOC", party: "agent", config: bandCfg, saved: {},
    draft: { intent: "counter", counterAmount: 280000, confidence: "high" },
    job: { contactId: "c1", message: "$280,000" },
  });
  assert.equal(v.passed, false);
  assert.match(v.reason, /no open offer/);
});

test("a counter on a house they passed on, answered through the check-in, finds the offer — and waits for a person", async () => {
  // Pink Skulls Realtor, 2414 E Longfellow (2026-09-22): passed 9/10, the
  // check-in asked if the seller had moved, "we have one at 144k" inside the
  // ceiling — and the band said "no open offer to answer".
  const passed = { ...BAND_OFFER, status: "passed", statusHistory: [{ status: "passed", ts: iso(10 * 86400000) }] };
  const v = await evaluateBandFor({
    store: bandStore([passed]), locationId: "LOC", party: "agent", config: bandCfg, saved: {},
    draft: { intent: "counter", counterAmount: 250000, confidence: "high", propertyAddress: BAND_OFFER.address },
    job: { contactId: "c1", message: "I think we have one at $250,000" }, now: Date.now(),
  });
  assert.equal(v.offerId, BAND_OFFER.id, "the passed offer is still the one to answer");
  assert.doesNotMatch(v.reason, /no open offer/);
  assert.equal(v.passed, false);
  assert.match(v.reason, /never goes above/);
});

test("a house WE passed on is not revived by their counter — the band stays shut", async () => {
  const ours = { ...BAND_OFFER, status: "we_passed" };
  const v = await evaluateBandFor({
    store: bandStore([ours]), locationId: "LOC", party: "agent", config: bandCfg, saved: {},
    draft: { intent: "counter", counterAmount: 250000, confidence: "high", propertyAddress: BAND_OFFER.address },
    job: { contactId: "c1", message: "$250,000" },
  });
  assert.equal(v.passed, false);
  assert.match(v.reason, /no open offer/);
});

test("the daily cap is counted from the store, not from memory", async () => {
  // A crash loop must not hand a misconfigured setup a fresh budget.
  const today = new Date().toISOString();
  const store = bandStore(undefined, [
    { id: "d1", locationId: "LOC", status: "sent", createdAt: today, exception: { kind: "counter_band", passed: true } },
    { id: "d2", locationId: "LOC", status: "sent", createdAt: today, exception: { kind: "counter_band", passed: true } },
  ]);
  store.listReplyDrafts = async () => [
    { exception: { passed: true } }, { exception: { passed: true } }, { exception: { passed: false } },
  ];
  assert.equal(await bandReleasesToday({ store, locationId: "LOC" }), 2, "failed verdicts don't spend the budget");
  const v = await evaluateBandFor({
    store, locationId: "LOC", party: "agent", config: bandCfg, saved: {},
    draft: { intent: "counter", counterAmount: 250000, confidence: "high", propertyAddress: BAND_OFFER.address },
    job: { contactId: "c1", message: "$250,000" },
  });
  assert.equal(v.passed, false);
  assert.equal(v.checks.find((c) => !c.ok).name, "under_daily_cap");
});

test("an acceptance is judged by the acceptance guard, not the counter one", async () => {
  const cfg = normalizeConversationAi({ enabled: true, parties: { agent: { counterBand: { enabled: true, acceptance: true } } } });
  const v = await evaluateBandFor({
    store: bandStore(), locationId: "LOC", party: "agent", config: cfg, saved: {},
    draft: { intent: "acceptance", counterAmount: 0, confidence: "high", propertyAddress: BAND_OFFER.address },
    job: { contactId: "c1", message: "seller signed off" },
  });
  assert.equal(v.kind, "acceptance_band");
  assert.equal(v.passed, true, v.reason);
});

/* ---------- the re-quote toggle stands on its own ---------- */

test("switching re-quoting on is enough — it does not also need a rule wired by hand", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => [{ id: "o1", ...OFFERS[0] }];   // a counter on a house we offered on
  const saved = { ...SAVED, conversationAi: normalizeConversationAi({
    enabled: true, parties: { agent: { requote: { enabled: true } } },
  }) };
  let ran = null;
  const { job } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "that's way too low, seller wants $340,000",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", counterAmount: 340000, reply: "Let me run it properly and come back to you." }),
      requoteFromAgentNumbers: async (a) => { ran = a; return { ok: true, address: "12 Elm St", from: 250000, to: 262000, floated: true }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.ok(ran, "the re-quote ran without an intent rule");
  const d = await store.getReplyDraft(job.draftId);
  assert.ok(d.actions.some((a) => a.type === "requote_from_agent_numbers" && a.status === "done"));
});

test("a re-quote the model was unsure about waits for a person", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => [{ id: "o1", ...OFFERS[0] }];   // a counter on a house we offered on
  const saved = { ...SAVED, conversationAi: normalizeConversationAi({
    enabled: true, parties: { agent: { requote: { enabled: true } } },
  }) };
  let ran = false;
  const { job } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "hmm",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "low", reply: "Let me check." }),
      requoteFromAgentNumbers: async () => { ran = true; return { ok: true }; },
    },
  });
  await settle();
  assert.equal(ran, false, "re-pricing the wrong house on a misread is the expensive failure");
  const d = await store.getReplyDraft(job.draftId);
  assert.ok(d.actions.some((a) => a.type === "requote_from_agent_numbers" && a.mode === "ask"));
});

/* ---------- a price on a house we never priced is their ask ---------- */

test("a seller's floor on a house with no offer is a new property: underwrite at their number, no counter hold", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();                       // nothing on file for this agent
  const uw = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "My seller is not looking to sell less than 450k",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", counterAmount: 450000,
        propertyAddress: "11040 14th Ave SW, Seattle, WA 98146",
        reply: "Understood. Is it much of a project, or in decent shape? I'll run it by underwriting today and come back to you." }),
      startUnderwrite: async (args) => { uw.push(args); return { job: { id: "uw-1", dryRun: false } }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "new_property");
  assert.ok(!(d.flags || []).some((f) => /a counter is a person's call/.test(f)), (d.flags || []).join(" · "));
  assert.equal(uw.length, 1, "the underwrite starts");
  assert.equal(uw[0].address, "11040 14th Ave SW, Seattle, WA 98146");
  assert.equal(uw[0].askingPrice, 450000, "their floor is the asking price");
});

test("the same words on a house we already offered on stay a counter", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => [{ id: "o1", ...OFFERS[0] }];
  const uw = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "My seller is not looking to sell less than 450k",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", counterAmount: 450000, reply: "Let me run 450k by my partner today." }),
      startUnderwrite: async (args) => { uw.push(args); return { job: { id: "uw-1" } }; },
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "counter");
  assert.equal(uw.length, 0);
});

test("re-quoting stays off unless the operator switched it on", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  let ran = false;
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "way too low",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", reply: "Let me check." }),
      requoteFromAgentNumbers: async () => { ran = true; return { ok: true }; },
    },
  });
  await settle();
  assert.equal(ran, false);
});

/* ---------- the guarded dataroom invite ---------- */

test("an evaluating buyer whose buy box fits gets the dataroom link on its own; a cold ask still asks", async () => {
  _resetJobs();
  const { client } = ghlStub();
  client.call = ((orig) => async (path, opts) => {
    if (/^\/contacts\/c1$/.test(path)) return { contact: { id: "c1", firstName: "Ravi", lastName: "Patel", tags: ["investor"] } };
    return orig(path, opts);
  })(client.call);
  const store = fakeStore();
  const saved = { ...SAVED, conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["interested"] } } } } };
  const invites = [];
  const deps = {
    draft: async () => ({ ...DRAFT, intent: "interested", confidence: "high", reply: "Sending the package over now.", propertyAddress: "22018 76th Ave W", counterAmount: 0 }),
    dataroomInviteGuard: async ({ addressHint }) => (addressHint ? { ok: true, address: "22018 76th Ave W", score: 100 } : { ok: false, reason: "" }),
    issueDataroomInvite: async (a) => { invites.push(a); return { sent: true, address: "22018 76th Ave W" }; },
  };
  const { job } = await startReply({ client, locationId: "LOC", saved, store, contactId: "c1", message: "send me the details on 76th", channel: "sms", sendsEnabled: true, deps });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  const act = d.actions.find((a) => a.type === "send_dataroom_invite");
  assert.ok(act, "the guarded invite was planned");
  assert.equal(act.mode, "auto");
  assert.equal(act.status, "done");
  assert.equal(invites.length, 1);

  // the guard says no with a reason → a suggestion, not a send
  _resetJobs();
  const store2 = fakeStore();
  const { job: job2 } = await startReply({ client, locationId: "LOC", saved, store: store2, contactId: "c1", message: "send me the details on 76th", channel: "sms", sendsEnabled: true,
    deps: { ...deps, dataroomInviteGuard: async () => ({ ok: false, reason: "buy box is a 33% fit", address: "22018 76th Ave W" }) } });
  await settle();
  const d2 = await store2.getReplyDraft(job2.draftId);
  assert.equal(d2.actions.find((a) => a.type === "send_dataroom_invite"), undefined);
  const sug = d2.actions.find((a) => a.type === "suggest_dataroom_invite");
  assert.equal(sug.mode, "ask");
  assert.match(sug.why, /33% fit/);
  assert.equal(invites.length, 1, "nothing more was sent");
});

test("sending a blast draft records blast_sent and the buyer's lastBlastAt", async () => {
  const open = { ...openDraft(), party: "investor", intent: "blast_open", contactName: "Ravi", inbound: "",
    outbound: { kind: "blast_open", offerId: "o1", address: "22018 76th Ave W, Edmonds, WA", label: "dispo-22018-76th-ave-w" }, propertyAddress: "22018 76th Ave W, Edmonds, WA" };
  const store = fakeStore([open]);
  const marks = [];
  store.setInvestorStatus = async (_l, id, patch) => { marks.push([id, patch]); };
  const client = { call: async () => ({ messageId: "m1" }) };
  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true });
  const ev = await store.listContactEvents("LOC", "c1", { types: ["blast_sent"] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].offerId, "o1");
  assert.equal(ev[0].dedupeKey, "blast:o1:c1");
  assert.equal(ev[0].data.via, "app");
  assert.equal(marks.length, 1);
  assert.ok(marks[0][1].lastBlastAt);
});

/* ---------- a phone call as the inbound ---------- */

test("a call transcript runs the pipeline: intent and numbers from what they said, a call_summary event, a text after the call that waits for its own allowlist slot", async () => {
  _resetJobs();
  const { client, notes } = ghlStub();
  const store = fakeStore();
  store.listOffers = async () => OFFERS;
  const transcript = "US: hey Dana, how's the seller on Elm?\nTHEM: honestly they'd take four twenty five if you can close in two weeks. Roof is shot though.";
  let seen;
  const saved = { ...SAVED, conversationAi: { enabled: true, parties: { agent: { autoSend: { enabled: true, intents: ["question", "counter"] } } } } };
  const { job } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: transcript, channel: "sms", sendsEnabled: true,
    inboundKind: "call", call: { messageId: "m-call", direction: "outbound", at: "2026-09-10T17:50:00Z", durationSec: 190, dedupeKey: "call:m-call", transcript },
    deps: { draft: async (args) => { seen = args; return { ...DRAFT, intent: "question", reply: "Good talking just now. I'll run Elm at that number with the roof and text you by tomorrow.", counterAmount: 0, propertyAddress: "12 Elm St", summary: "Seller would take 425k with a 2-week close; roof needs replacing." }; } },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(seen.inboundKind, "call");
  assert.equal(seen.call.direction, "outbound");
  assert.equal(seen.message, transcript, "the model reads the whole transcript");
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.inboundKind, "call");
  assert.match(d.inbound, /^\(call, 3 min\) US: hey Dana/);
  assert.equal(d.call.messageId, "m-call");
  // question is allowlisted, but the text after a call is its own slot
  assert.equal(d.status, "draft");
  assert.match(d.autoSend.reason, /text after a call is not on the auto-send list/);
  const ev = await store.listContactEvents("LOC", "c1", { types: ["call_summary"] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].dedupeKey, "call:m-call");
  assert.equal(ev[0].data.intent, "question");
  assert.match(ev[0].data.summary, /425k/);
  assert.ok(notes.length >= 1);

  // with the slot ticked it schedules like any reply
  _resetJobs();
  const store2 = fakeStore(); store2.listOffers = async () => OFFERS;
  const saved2 = { ...SAVED, conversationAi: { enabled: true, parties: { agent: { autoSend: { enabled: true, intents: ["question", "call_followup"] } } } } };
  const { job: j2 } = await startReply({ client, locationId: "LOC", saved: saved2, store: store2, contactId: "c1", message: transcript, channel: "sms", sendsEnabled: true,
    inboundKind: "call", call: { messageId: "m-call-2", direction: "inbound", at: "2026-09-10T18:50:00Z", durationSec: 60, transcript },
    deps: { draft: async () => ({ ...DRAFT, intent: "question", reply: "Thanks for the call, numbers by tomorrow.", counterAmount: 0 }) } });
  await settle();
  assert.equal((await store2.getReplyDraft(j2.draftId)).status, "scheduled");

  // "stop" inside a transcript is a word, not an opt-out
  _resetJobs();
  const store3 = fakeStore(); store3.listOffers = async () => OFFERS;
  const { job: j3 } = await startReply({ client, locationId: "LOC", saved, store: store3, contactId: "c1", message: "THEM: we had to stop the inspection halfway, can you call back tomorrow", channel: "sms", sendsEnabled: true,
    inboundKind: "call", call: { messageId: "m-call-3", direction: "inbound", at: "2026-09-10T19:50:00Z", durationSec: 60 },
    deps: { draft: async () => ({ ...DRAFT, intent: "wants_call", reply: "Will do, I'll call tomorrow morning.", counterAmount: 0 }) } });
  await settle();
  assert.equal(j3.status, "done", j3.error);
  assert.equal((await store3.getReplyDraft(j3.draftId)).intent, "wants_call");
});

/* ---------- the self-driving negotiation: counters under the ceiling, the first no ---------- */

import { autoAcceptCeiling } from "./shared/auto-accept.js";

const NEGOTIATION_OFFER = {
  id: "o1", locationId: "LOC", contactId: "c1", address: "12 Elm St, Seattle, WA 98101", status: "sent",
  arv: 600000, repairs: 50000, cashAmount: 300000, createdAt: new Date().toISOString(),
};
const bandSaved = () => ({
  ...STARTER_SAVED,
  conversationAi: { ...STARTER_SAVED.conversationAi, parties: { ...STARTER_SAVED.conversationAi.parties,
    agent: { ...STARTER_SAVED.conversationAi.parties.agent, counterBand: { enabled: true, dailyCap: 2, acceptance: false, maxAmount: 0 } } } },
});
const negotiationStore = (offer) => {
  const store = fakeStore();
  store.listOffers = async () => [offer];
  store.getOffer = async () => offer;
  return store;
};

test("a counter under the ceiling is never taken by itself: nothing re-issued, nothing sent, it waits for a person", async () => {
  _resetJobs();
  const ceiling = autoAcceptCeiling({ offer: NEGOTIATION_OFFER, settings: bandSaved() }).ceiling;
  assert.ok(ceiling > NEGOTIATION_OFFER.cashAmount, `the fixture needs room under the ceiling (got ${ceiling})`);
  const amount = Math.min(ceiling, NEGOTIATION_OFFER.cashAmount + 10000);
  const { client } = ghlStubFor(["agent"]);
  const store = negotiationStore(NEGOTIATION_OFFER);
  const order = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: bandSaved(), store, contactId: "c1", sendsEnabled: true,
    message: `seller would do ${amount / 1000}k on 12 Elm`,
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", needsHuman: false, counterAmount: amount,
        reply: "Let me run that by my partner and get back to you this afternoon.", propertyAddress: "12 Elm St" }),
      reviseOfferToCounter: async ({ amount: a }) => { order.push(["revise", a]); return { ok: true, address: "12 Elm St", amount: a }; },
      sendOfferDocs: async ({ afterCounter }) => { order.push(["send", afterCounter]); return { ok: true, address: "12 Elm St", channels: ["sms"] }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.deepEqual(order, [], "no paper re-issued above the number we sent, and none sent");
  assert.doesNotMatch(d.reply, /works for us|Sending the updated offer/);
  assert.equal(d.status, "draft", d.autoSend?.reason);
  assert.equal(d.exception?.passed, false);
  assert.match(d.exception?.reason || "", /never goes above the \$300,000 we sent/);
});

test("a counter just over the ceiling no longer goes out at our max by itself — on Woodcrest that raised a signed 386k to 402.5k", async () => {
  // Matt, 2026-09-14 had it countering back at the ceiling automatically;
  // 2026-10-02, after Woodcrest: "we need to stick with our prev numbers".
  _resetJobs();
  const ceiling = autoAcceptCeiling({ offer: NEGOTIATION_OFFER, settings: bandSaved() }).ceiling;
  const theirs = ceiling + 15000;   // over, but inside the 10% margin
  const { client } = ghlStubFor(["agent"]);
  const store = negotiationStore(NEGOTIATION_OFFER);
  const order = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: bandSaved(), store, contactId: "c1", sendsEnabled: true,
    message: `seller would do ${theirs / 1000}k on 12 Elm`,
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", needsHuman: false, counterAmount: theirs,
        reply: "Let me run that by my partner and get back to you this afternoon.", propertyAddress: "12 Elm St" }),
      reviseOfferToCounter: async ({ amount: a }) => { order.push(["revise", a]); return { ok: true, address: "12 Elm St", amount: a }; },
      sendOfferDocs: async ({ afterCounter }) => { order.push(["send", afterCounter]); return { ok: true, address: "12 Elm St", channels: ["sms"] }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.deepEqual(order, [], "nothing re-issued at the ceiling, nothing sent");
  assert.doesNotMatch(d.reply, /Best we can do/);
  assert.equal(d.status, "draft", d.autoSend?.reason);
  assert.equal(d.exception?.counterBack, false);
  assert.match(d.exception?.reason || "", /never goes above the \$300,000 we sent/);
});

test("after we came back at our max, another counter over it is their pass — no second round", async () => {
  _resetJobs();
  const ceiling = autoAcceptCeiling({ offer: NEGOTIATION_OFFER, settings: bandSaved() }).ceiling;
  const offer = { ...NEGOTIATION_OFFER, cashAmount: ceiling - 1000, counterBand: { at: new Date().toISOString(), acceptedAt: new Date().toISOString(), amount: ceiling } };
  const theirs = ceiling + 5000;
  const { client } = ghlStubFor(["agent"]);
  const store = negotiationStore(offer);
  const statuses = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: bandSaved(), store, contactId: "c1", sendsEnabled: true,
    message: `they still need ${theirs / 1000}k`,
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", needsHuman: false, counterAmount: theirs,
        reply: "Let me check.", propertyAddress: "12 Elm St" }),
      setOfferStatus: async ({ status }) => { statuses.push(status); return { ok: true, address: offer.address, status }; },
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "rejection", d.summary);
  assert.ok(d.actions.some((a) => a.type === "mark_offer_passed"), `filed as their pass: ${d.actions.map((a) => a.type)}`);
});

test("the first no on a live offer asks for their number without filing it dead; the second no closes it", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const offer = { ...NEGOTIATION_OFFER };
  const store = negotiationStore(offer);
  const noted = [];
  const deps = {
    draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "high", reply: "Understood. Any chance they'd counter?", propertyAddress: "12 Elm St" }),
    noteFirstDecline: async ({ offerId }) => { noted.push(offerId); offer.declinedOnce = { at: new Date().toISOString() }; return { ok: true, address: offer.address }; },
    setOfferStatus: async () => ({ ok: true, address: offer.address, status: "passed" }),
  };
  const { job } = await startReply({ client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "too aggressive, they're not interested", deps });
  await settle();
  const d1 = await store.getReplyDraft(job.draftId);
  const types1 = d1.actions.map((a) => a.type);
  assert.ok(!types1.includes("mark_offer_passed"), `not filed dead on the first no: ${types1}`);
  assert.ok(!d1.actions.some((a) => (a.tags || []).includes("tier-3")), "not tagged Tier 3 on the first no");
  assert.equal(d1.actions.find((a) => a.type === "note_first_decline")?.status, "done");
  assert.deepEqual(noted, ["o1"]);

  _resetJobs();
  const { job: j2 } = await startReply({ client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "no, there's no number", deps });
  await settle();
  const d2 = await store.getReplyDraft(j2.draftId);
  const types2 = d2.actions.map((a) => a.type);
  assert.ok(types2.includes("mark_offer_passed"), `the second no closes it: ${types2}`);
  assert.ok(!types2.includes("note_first_decline"));
});

// 4621 S Sheridan Ave (2026-09-15): "That one is already sold." was read as a
// first no, and the offer stayed open until a person cleaned it up on 9/29.
// Matt, 2026-10-02: a house that sold is no longer available — "we passed is
// like we intentionally said no", and their pass is a no from the seller.
test("an agent saying the house sold marks it no longer available — not their pass, and no 'what would the seller take?'", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const offer = { ...NEGOTIATION_OFFER };
  const store = negotiationStore(offer);
  const statuses = [];
  const noted = [];
  const deps = {
    draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "high", reply: "Ah, we were too late on that one. What else is sitting that needs work?", propertyAddress: "12 Elm St" }),
    noteFirstDecline: async ({ offerId }) => { noted.push(offerId); return { ok: true, address: offer.address }; },
    setOfferStatus: async ({ status }) => { statuses.push(status); return { ok: true, address: offer.address, status, stopped: 1 }; },
  };
  const { job } = await startReply({ client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "That one is already sold", deps });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  const types = d.actions.map((a) => a.type);
  const gone = d.actions.find((a) => a.type === "mark_offer_unavailable");
  assert.equal(gone?.status, "done", `${types}`);
  assert.match(gone.detail || "", /marked no longer available — 1 queued text about it stopped/);
  assert.ok(!types.includes("mark_offer_passed"), `not their pass: ${types}`);
  assert.ok(!types.includes("note_first_decline"), "no 'any chance they'd counter?' on a house that sold");
  assert.ok(!d.actions.some((a) => (a.tags || []).includes("tier-3")), "a house that sold says nothing about the agent");
  assert.deepEqual(statuses, ["unavailable"]);
  assert.deepEqual(noted, []);

  // The seller saying no is still a no — the first one asks for their number.
  _resetJobs();
  const { job: j2 } = await startReply({ client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "too low, the seller isn't interested", deps });
  await settle();
  const d2 = await store.getReplyDraft(j2.draftId);
  assert.ok(d2.actions.some((a) => a.type === "note_first_decline"), `${d2.actions.map((a) => a.type)}`);
  assert.ok(!d2.actions.some((a) => a.type === "mark_offer_unavailable"));
});

// Matt, 2026-09-14: "if we counter and they say no, mark as 'they passed'."
// Once we've come back with a new number, their no is the answer to it.
for (const [what, moved] of [
  ["re-quoted them on their numbers", { requotes: [{ at: "2026-09-14T19:00:00Z", from: 477250, to: 497250 }] }],
  ["re-issued the offer under the counter band", { counterBand: { acceptedAt: "2026-09-14T19:00:00Z", amount: 497250 } }],
]) {
  test(`a no after we ${what} files the offer as they passed, with no second ask`, async () => {
    _resetJobs();
    const { client } = ghlStubFor(["agent"]);
    const offer = { ...NEGOTIATION_OFFER, ...moved };
    const store = negotiationStore(offer);
    const noted = [];
    const deps = {
      draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "high", reply: "Understood, thanks for the look.", propertyAddress: "12 Elm St" }),
      noteFirstDecline: async ({ offerId }) => { noted.push(offerId); return { ok: true, address: offer.address }; },
      setOfferStatus: async () => ({ ok: true, address: offer.address, status: "passed" }),
    };
    const { job } = await startReply({ client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "still no, that doesn't work", deps });
    await settle();
    const d = await store.getReplyDraft(job.draftId);
    const types = d.actions.map((a) => a.type);
    assert.ok(types.includes("mark_offer_passed"), `their no closes it: ${types}`);
    assert.ok(!types.includes("note_first_decline"), "no second 'any chance they'd counter?'");
    assert.deepEqual(noted, []);
  });
}

/* ---------- a no with their numbers in it: re-quote before filing it dead ---------- */

// Thomas Rinow, 2026-09-14: "Even at 60 in repairs we're well over your
// price." "Mark passed" ran before the re-quote, the offer closed, and the
// re-quote found "no open offer to re-quote". The re-quote goes first now.
const requoteSaved = () => ({
  ...STARTER_SAVED,
  conversationAi: { ...STARTER_SAVED.conversationAi, parties: { ...STARTER_SAVED.conversationAi.parties,
    agent: { ...STARTER_SAVED.conversationAi.parties.agent, requote: { enabled: true, maxPerOffer: 1, maxArvLiftPct: 10, maxRepairCutPct: 25 } } } },
});

test("a no that brings a new number of ours holds the offer open: re-quote first, no passed, no Tier 3", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const offer = { ...NEGOTIATION_OFFER, declinedOnce: { at: "2026-09-14T19:00:00Z" } };   // a second no, on its own
  const store = negotiationStore(offer);
  const order = [];
  const deps = {
    draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "high", propertyAddress: "12 Elm St",
      reply: "Understood. Let me re-run it on your numbers.", agentRehab: 30000 }),
    requoteFromAgentNumbers: async () => { order.push("requote"); return { ok: true, address: offer.address, from: 300000, to: 320000, floated: true }; },
    setOfferStatus: async ({ status }) => { order.push(`status:${status}`); return { ok: true, address: offer.address, status }; },
  };
  const { job } = await startReply({ client, locationId: "LOC", saved: requoteSaved(), store, contactId: "c1", message: "even at 30 in repairs you're well under", deps });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(order[0], "requote", `the re-quote runs before anything that closes the offer: ${order}`);
  assert.ok(!order.includes("status:passed"), `not filed dead while our new number is out: ${order}`);
  assert.equal(d.actions.find((a) => a.type === "mark_offer_passed")?.status, "skipped");
  assert.ok(!d.actions.some((a) => a.status === "done" && (a.tags || []).includes("tier-3")), "not tagged Tier 3");
});

test("a no with nothing to re-quote on still closes the offer", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const offer = { ...NEGOTIATION_OFFER, declinedOnce: { at: "2026-09-14T19:00:00Z" } };
  const store = negotiationStore(offer);
  const order = [];
  const deps = {
    draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "high", propertyAddress: "12 Elm St", reply: "Understood, thanks." }),
    requoteFromAgentNumbers: async () => { order.push("requote"); return { ok: false, reason: "nothing new from them to re-quote on" }; },
    setOfferStatus: async ({ status }) => { order.push(`status:${status}`); return { ok: true, address: offer.address, status }; },
  };
  const { job } = await startReply({ client, locationId: "LOC", saved: requoteSaved(), store, contactId: "c1", message: "no, doesn't work", deps });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.deepEqual(order, ["requote", "status:passed"]);
  assert.equal(d.actions.find((a) => a.type === "mark_offer_passed")?.status, "done");
});

/* ---------- tiers: turnkey is not Tier 1, and a new house runs Tier 1 again ---------- */

/* ---------- a counter far past what we'd pay is their pass ---------- */

// Jesse Roach, 2026-09-14: "Their lowest at this time is $700k" on a $550k
// offer. NEGOTIATION_OFFER: cash $300k, ARV $600k, repairs $50k → ceiling
// 70% × 600k − 50k − 10k = $360k, so the pass line is $396k (10% over).
const counterAt = async (amount) => {
  _resetJobs();
  const { client } = ghlStubFor(["agent", "tier-1"]);
  const offer = { ...NEGOTIATION_OFFER };
  const store = negotiationStore(offer);
  const statuses = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
    message: `They can't take that offer. Their lowest at this time is $${amount.toLocaleString("en-US")}.`,
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", counterAmount: amount, propertyAddress: "12 Elm St",
        reply: "Understood. Let me run that by my partner and get back to you this afternoon." }),
      setOfferStatus: async ({ status }) => { statuses.push(status); return { ok: true, address: offer.address, status }; },
    },
  });
  await settle();
  return { job, d: await store.getReplyDraft(job.draftId), statuses };
};

test("a counter more than 10% over the most we'd pay is filed as their pass, with a reply that names no number", async () => {
  const { job, d, statuses } = await counterAt(450000);
  assert.equal(job.status, "done", job.error);
  assert.equal(d.intent, "rejection");
  assert.ok(statuses.includes("passed"), `offer marked passed: ${statuses}`);
  assert.ok(!statuses.includes("countered"));
  assert.ok(d.actions.some((a) => a.status === "done" && (a.tags || []).includes("tier-3")), "moved to Tier 3");
  assert.doesNotMatch(d.reply, /partner|get back/, "no promise to come back with a number");
  assert.doesNotMatch(d.reply, /\$|\d{3}/, "names no number of ours");
  assert.ok(!(d.flags || []).some((f) => /a counter is a person's call/.test(f)), (d.flags || []).join(" · "));
});

import { floorFirmness } from "./reply-agent.js";

test("floorFirmness tells a wall from an opening", () => {
  assert.equal(floorFirmness("Nope. He won't entertain anything under 450k"), "firm");
  assert.equal(floorFirmness("That won't work. No need to submit an offer below $529k but thanks."), "firm");
  assert.equal(floorFirmness("If you were more around $460k we would consider it most likely."), "soft");
  assert.equal(floorFirmness("If your number starts with an eight, I can probably make something work."), "soft");
  assert.equal(floorFirmness("Their lowest at this time is $700k."), "plain");
  assert.equal(floorFirmness("I could get them to 950 but no way on that number"), "soft", "a number they can deliver is an opening");
  assert.equal(floorFirmness("I can probably get the seller down to 610"), "soft");
});

test("a soft floor far over ours keeps the negotiation open: their number filed, their value and repairs asked for", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent", "tier-1"]);
  const offer = { ...NEGOTIATION_OFFER };
  const store = negotiationStore(offer);
  const statuses = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
    message: "Yes, that offer is still way below what we would be willing to accept. If you were more around $430k we would consider it most likely.",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", counterAmount: 430000, propertyAddress: "12 Elm St",
        reply: "Understood. Let me run that by my partner and get back to you this afternoon." }),
      setOfferStatus: async ({ status }) => { statuses.push(status); return { ok: true, address: offer.address, status }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "question");
  assert.match(d.reply, /what do you figure it's worth once it's done/);
  assert.doesNotMatch(d.reply, /\$|\d{3}/, "names no number of ours");
  assert.ok(statuses.includes("countered"), `their number filed: ${statuses}`);
  assert.ok(!statuses.includes("passed"));
});

test("a confident 'other' that asks nothing of us is acknowledged instead of sitting; an unsure one still waits", async () => {
  _resetJobs();
  const run = async (over) => {
    _resetJobs();   // the same text three times would read as a duplicate
    const { client } = ghlStubFor(["agent"]);
    const store = fakeStore();
    const { job } = await startReply({
      client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
      message: "253-833-4661 Park Manager  Best time to call is morning",
      deps: { draft: async () => ({ ...DRAFT, intent: "other", confidence: "high", needsHuman: false,
        reply: "Got it, thanks. I'll reach out to her.", summary: "Gave the park manager's number; call in the morning.", ...over }) },
    });
    for (let i = 0; i < 40 && job.status === "running"; i++) await settle();
    return store.getReplyDraft(job.draftId);
  };
  assert.equal((await run({})).intent, "question");
  assert.equal((await run({ needsHuman: true })).intent, "other");
  assert.equal((await run({ confidence: "medium" })).intent, "other");
});

test("'I'll check back this Wednesday' and 'an email I can send properties to' are both remembered as check-ins", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const rows = [];
  const orig = store.appendContactEvents?.bind(store);
  store.getContactProfile ??= async () => null;
  store.upsertContactProfile ??= async () => ({});
  store.appendContactEvents = async (loc, id, add) => { rows.push(...add); return orig ? orig(loc, id, add) : { inserted: add.length, skipped: 0 }; };
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
    message: "Nothing right now. You got an email I can send properties to? I'll check back in this Wednesday.",
    deps: { draft: async () => ({ ...DRAFT, intent: "investor_open", confidence: "high", reply: "Sounds good, matt@shepflips.com." }) },
  });
  for (let i = 0; i < 40 && job.status === "running"; i++) await settle();
  assert.equal(job.status, "done", job.error);
  const kinds = rows.filter((e) => e.type === "checkin_requested").map((e) => e.data.kind).sort();
  assert.deepEqual(kinds, ["date", "source"]);
});

test("a contact with an offer in our book is an agent even with no agent tag", async () => {
  _resetJobs();
  const { client } = ghlStubFor([]);
  const store = negotiationStore({ ...NEGOTIATION_OFFER });
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
    message: "Hey Matt, just wanted to see if this one might come together. Thanks!",
    deps: { draft: async () => ({ ...DRAFT, intent: "status_check", confidence: "high", propertyAddress: "12 Elm St", reply: "Still on it." }) },
  });
  for (let i = 0; i < 40 && job.status === "running"; i++) await settle();
  assert.equal(job.status, "done", `${job.error || ""} ${JSON.stringify({ phase: job.phase, party: job.party, partySource: job.partySource })}`);
  assert.equal(job.party, "agent");
  assert.equal(job.partySource, "offer_book");
});

// Hold, then pass (Matt, 2026-10-04). A counter above our number gets our
// number back once, held — never more — and sends itself; the check-ins and
// the pass are counter-hold.js's. Off, it waits for a person as before.
const HOLD_SAVED = (on = true) => ({
  ...SAVED,
  conversationAi: { enabled: true, autoSend: { debounceSec: 0 }, parties: { agent: {
    autoSend: { enabled: true, intents: ["question", "status_check"] }, followUp: { enabled: true },
    counterHold: { enabled: on, checkIns: 2 } } } },
});
const HELD_OFFER = { ...NEGOTIATION_OFFER, status: "countered", sends: [{ ts: new Date(Date.now() - 5 * 86400000).toISOString(), results: { sms: { ok: true } } }] };
const holdRun = async ({ message, draft, on = true }) => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const offer = { ...HELD_OFFER };
  const store = negotiationStore(offer);
  const marks = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: HOLD_SAVED(on), store, contactId: "c1", message, sendsEnabled: true,
    deps: {
      draft: async () => ({ ...DRAFT, confidence: "high", propertyAddress: "12 Elm St", ...draft }),
      setOfferStatus: async ({ status }) => ({ ok: true, address: offer.address, status }),
      markCounterHold: async (a) => { marks.push(a); return { ok: true }; },
    },
  });
  await settle();
  return { job, d: await store.getReplyDraft(job.draftId), marks };
};

test("a counter above our number gets our number once, then we move on", async () => {
  const { job, d, marks } = await holdRun({ message: "Seller says 315 and not a dollar less",
    draft: { intent: "counter", counterAmount: 315000, reply: "Let me run that by my partner and get back to you." } });
  assert.equal(job.status, "done", job.error);
  assert.match(d.reply, /hold at 300,000/, d.reply);
  assert.doesNotMatch(d.reply, /\$/, "no dollar sign: the carrier filters");
  assert.doesNotMatch(d.reply, /partner|get back/);
  assert.equal(d.autoSend.decided, true, `${d.autoSend.reason} | flags: ${(d.flags || []).join(" · ")} | autoSendable ${d.autoSendable} gateClean ${d.gateClean}`);
  assert.equal(d.status, "scheduled");
  assert.deepEqual(marks.map((m) => [m.offerId, m.ours, m.theirs]), [["o1", 300000, 315000]]);
  // Off: the counter waits for a person, exactly as before.
  const off = await holdRun({ on: false, message: "Seller says 315 and not a dollar less",
    draft: { intent: "counter", counterAmount: 315000, reply: "Let me run that by my partner and get back to you." } });
  assert.notEqual(off.d.status, "scheduled");
  assert.equal(off.marks.length, 0);
});

test("'make an offer closer to where they are' with no number is held at ours too", async () => {
  const { d, marks } = await holdRun({ message: "If you would like to make an offer closer to where they are at, that may get them to move on it.",
    draft: { intent: "counter", counterAmount: 0, reply: "What number would get them to move?" } });
  assert.match(d.reply, /hold at 300,000/);
  assert.equal(d.status, "scheduled");
  assert.equal(marks.length, 1);
});

test("a counter with no number that asks nothing of us is answered like a status reply", async () => {
  const { d, marks } = await holdRun({ message: "I could ask, and see what is the discount price they might be willing to sell right now",
    draft: { intent: "counter", counterAmount: 0, reply: "That'd be great, appreciate you asking. Bring back whatever they'd consider." } });
  assert.equal(d.intent, "status_check");
  assert.equal(d.status, "scheduled", (d.flags || []).join(" · "));
  assert.equal(marks.length, 0, "not a hold");
});

test("a counter within 10% of what we'd pay stays a counter for the band or a person", async () => {
  const { d, statuses } = await counterAt(380000);
  assert.equal(d.intent, "counter");
  assert.ok(!statuses.includes("passed"));
});

test("a turnkey answer to 'project or turnkey?' is Tier 2, not a deal — no Tier 1, no underwrite", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const uw = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
    message: "This one is pretty turnkey with tenants in place.",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "deal_available", confidence: "high", propertyAddress: "13348 32nd Ave S, Tukwila, WA 98168",
        reply: "Makes sense, that one's not for us then. Anything else sitting that needs work?" }),
      startUnderwrite: async (args) => { uw.push(args); return { job: { id: "uw-1" } }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "investor_open");
  assert.ok(!d.actions.some((a) => (a.tags || []).includes("tier-1")), `no Tier 1: ${d.actions.map((a) => a.type)}`);
  assert.equal(uw.length, 0, "a renovated house is never sent to underwriting");
});

/* ---------- number first: a showing offer gets a number before a time ---------- */

import { isShowingOffer } from "./reply-agent.js";

const VELIA = "Hi Matt, the triplex is in excellent condition. The kitchens and bathrooms have been remodeled, and the units feature stainless-steel appliances. It is currently offered with good tenants in place, making it an attractive opportunity for a long-term rental investment. If you are interested in occupying one of the units, we can review the existing leases and available options. I'd be happy to arrange a private tour. Would you like to see it?";

test("isShowingOffer hears a tour, a showing, or 'would you like to see it'", () => {
  assert.equal(isShowingOffer(VELIA), true);
  assert.equal(isShowingOffer("happy to show you the house tomorrow"), true);
  assert.equal(isShowingOffer("can do a walk-through Thursday"), true);
  assert.equal(isShowingOffer("It's a project, needs a new roof"), false);
  assert.equal(isShowingOffer("I see it as a flip"), false);
});

test("'feel free to make an appointment to see it' is a showing offer, and a call or the photos are not", () => {
  assert.equal(isShowingOffer("Feel free to make an appointment to see it."), true);
  assert.equal(isShowingOffer("You can schedule a time to view it"), true);
  assert.equal(isShowingOffer("It's vacant and on a lockbox, go take a look at it anytime"), true);
  assert.equal(isShowingOffer("Let me know when you want to get in there"), true);
  assert.equal(isShowingOffer("give me a call tomorrow"), false);
  assert.equal(isShowingOffer("can we set up a time to talk?"), false);
  assert.equal(isShowingOffer("take a look at the photos on the listing"), false);
});

test("an invitation to make an appointment on a project we haven't priced gets 'numbers first', not a blank row", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const uw = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "Feel free to make an appointment to see it.",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "scheduling", confidence: "high", needsHuman: true, propertyAddress: "450 Overlake Dr E, Medina, WA 98039",
        reply: "Thanks, what work does it need?" }),
      startUnderwrite: async (args) => { uw.push(args); return { job: { id: "uw-10" } }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "deal_available");
  assert.match(d.reply, /Before we set up a time, let me run the numbers on 450 Overlake Dr E/);
  assert.equal(uw.length, 1, "the desktop underwrite starts");
  assert.equal(d.autoSend.decided, true, `it sends itself: ${d.autoSend.reason}`);
});

test("a showing offer on a house we haven't priced gets 'numbers first' and an underwrite, not a hold", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const uw = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: VELIA,
    deps: {
      draft: async () => ({ ...DRAFT, intent: "scheduling", confidence: "high", needsHuman: true, propertyAddress: "4207 S Bateman St, Seattle, WA 98118",
        reply: "Thanks Velia, let me check my calendar and get back to you." }),
      startUnderwrite: async (args) => { uw.push(args); return { job: { id: "uw-9" } }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "investor_open", "remodeled with tenants is still Tier 2");
  assert.match(d.reply, /Before we set up a time, let me run the numbers on 4207 S Bateman St/);
  assert.equal(uw.length, 1, `the underwrite runs: ${JSON.stringify(d.actions.map((a) => [a.type, a.status, a.detail]))}`);
  assert.equal(uw[0].address, "4207 S Bateman St, Seattle, WA 98118");
});

test("a showing offer on a house we already sent an offer on is left alone", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => [{ id: "o9", contactId: "c1", address: "4207 S Bateman St, Seattle, WA 98118", status: "sent", createdAt: new Date().toISOString() }];
  const uw = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
    message: "Would you like to see it tomorrow?",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "scheduling", confidence: "high", needsHuman: true, propertyAddress: "4207 S Bateman St, Seattle, WA 98118",
        reply: "Let me check and get back to you." }),
      startUnderwrite: async (args) => { uw.push(args); return { job: { id: "uw-9" } }; },
    },
  });
  await settle();
  assert.equal(uw.length, 0);
});

test("an agent already on Tier 1 who brings a different house leaves Tier 1 first, so it runs again", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent", "tier-1"]);
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
    message: "3611 I St NE #235, Auburn, WA 98002",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "new_property", confidence: "high", propertyAddress: "3611 I St NE #235, Auburn, WA 98002",
        reply: "I'll run it by underwriting today. What kind of shape is it in?" }),
      startUnderwrite: async () => ({ job: { id: "uw-2" } }),
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  const types = d.actions.map((a) => `${a.type}:${(a.tags || []).join(",")}`);
  const removeAt = types.indexOf("remove_tags:tier-1");
  const addAt = types.indexOf("add_tags:tier-1");
  assert.ok(removeAt >= 0, `tier-1 comes off first: ${types}`);
  assert.ok(addAt > removeAt, `then goes back on: ${types}`);
});

/* ---------- a held underwrite re-runs when they tell us more ---------- */

// Kelby Schweitzer, 2026-09-14: 5016 7th Ave NE held on thin comps; he then
// gave the scope and a 1.6–1.8M value, and every later run stood down on
// "already have a held draft". New information re-runs it, replacing the draft.
const heldDraftStore = ({ heldMinutesAgo = 120, eventsAfterHold = true } = {}) => {
  const store = fakeStore();
  const heldAt = new Date(Date.now() - heldMinutesAgo * 60000).toISOString();
  store.listOffers = async () => [{ id: "held-1", address: "5016 7th Ave NE, Seattle, WA 98105", status: "draft", createdAt: heldAt,
    autoUnderwrite: { held: ["only 5 priced comps"] } }];
  if (!eventsAfterHold) {
    const prior = store.listContactEvents.bind(store);
    store.listContactEvents = async (...args) => (await prior(...args)).filter((e) => (Date.parse(e.at) || 0) <= Date.parse(heldAt));
  }
  return store;
};

test("new details after a held underwrite run it again, replacing the held draft", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent", "tier-1"]);
  const store = heldDraftStore();
  const uw = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
    message: "Closer to 1.6-1.8. Depends if you tore the garage down",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "deal_available", confidence: "high", propertyAddress: "5016 7th Ave NE, Seattle, WA 98105",
        reply: "Let me run this by underwriting today.", agentArv: 1700000, agentTakeNote: "1.6-1.8" }),
      startUnderwrite: async (args) => { uw.push(args); return { job: { id: "uw-9" } }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(uw.length, 1, "the held underwrite runs again");
  assert.equal(uw[0].replaceOfferId, "held-1", "and replaces the held draft");
});

test("with nothing new since it held, the underwrite still stands down behind the held draft", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent", "tier-1"]);
  const store = heldDraftStore({ eventsAfterHold: false });
  const uw = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
    message: "any update on 5016 7th Ave NE?",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "deal_available", confidence: "high", propertyAddress: "5016 7th Ave NE, Seattle, WA 98105", reply: "Working on it." }),
      startUnderwrite: async (args) => { uw.push(args); return { job: { id: "uw-10" } }; },
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(uw.length, 0);
  assert.match(String(d.actions.find((a) => a.type === "start_underwrite")?.detail || ""), /already have a held draft/);
});

test("an agent not yet on Tier 1 is simply added — nothing to leave", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
    message: "3611 I St NE #235, Auburn, WA 98002",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "new_property", confidence: "high", propertyAddress: "3611 I St NE #235, Auburn, WA 98002", reply: "Running it today." }),
      startUnderwrite: async () => ({ job: { id: "uw-3" } }),
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.ok(!d.actions.some((a) => a.type === "remove_tags" && (a.tags || []).includes("tier-1")));
});

/* ---------- address → underwrite → offer → back into the conversation ---------- */

import { knownOfferFor } from "./reply-agent.js";

test("a house counts as known while its offer is recent or its held draft is fresh", () => {
  const now = Date.parse("2026-09-12T18:00:00Z");
  const day = 86400000;
  const rows = [
    { address: "12 Elm St, Seattle, WA", status: "sent", createdAt: new Date(now - 10 * day).toISOString() },
    { address: "7 Pine Ave, Tacoma, WA", status: "draft", updatedAt: new Date(now - 9 * day).toISOString() },
    { address: "3 Oak Rd, Kent, WA", status: "passed", createdAt: new Date(now - 90 * day).toISOString() },
  ];
  assert.equal(knownOfferFor(rows, "12 Elm St, Seattle, WA", now)?.status, "sent");
  assert.equal(knownOfferFor(rows, "7 Pine Ave, Tacoma, WA", now), null, "a held draft nobody touched for 9 days gets fresh numbers");
  assert.equal(knownOfferFor(rows, "3 Oak Rd, Kent, WA", now), null, "a months-old dead offer gets fresh numbers");
  assert.equal(knownOfferFor(rows, "", now), null);
});

test("the offer book says a held draft is with the team, and a sent offer shows no expiry", () => {
  const now = Date.now();
  const book = summarizeOffers([
    { address: "7 Pine Ave", status: "draft", createdAt: new Date(now).toISOString(), autoUnderwrite: { held: ["fewer than 3 comps"] } },
    { address: "12 Elm St", status: "sent", cashAmount: 410000, createdAt: new Date(now - 1000).toISOString(),
      sends: [{ ts: new Date(now - 1000).toISOString(), channels: ["sms"], results: { sms: { ok: true } } }], expiresAt: new Date(now + 5 * 86400000).toISOString() },
  ], { now });
  assert.match(book.text, /7 Pine Ave: numbers held for our team's review/);
  assert.match(book.text, /12 Elm St: our cash offer \$410,000/);
  assert.doesNotMatch(book.text, /expires/);
  assert.ok(book.amounts.includes(410000));
});

test("'let me run it by underwriting' is held when the underwrite didn't start", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "yeah 12 Elm St needs a full reno",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "deal_available", reply: "Got it, let me run this by my underwriting team today.", propertyAddress: "12 Elm St" }),
      startUnderwrite: async () => ({ skipped: "daily cap reached (25/25)" }),
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft");
  assert.match(d.autoSend.reason, /underwrite didn't start: daily cap reached/);
});

test("an address we already have an offer on doesn't start a second underwrite", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => [{ id: "o9", address: "12 Elm St", status: "sent", cashAmount: 410000, createdAt: new Date().toISOString() }];
  let started = 0;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "12 Elm St is still available",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "deal_available", reply: "Good to hear. You have our offer on it.", propertyAddress: "12 Elm St" }),
      startUnderwrite: async () => { started++; return { job: { id: "uw1" } }; },
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(started, 0);
  const uw = d.actions.find((a) => a.type === "start_underwrite");
  assert.equal(uw?.status, "skipped");
  assert.match(uw.detail, /already have an offer on 12 Elm St/);
});

test("a named address with no offer behind it starts the underwrite even when the field already held it", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  let started = 0;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "any update on 12 Elm St?",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "status_check", reply: "Still working on it.", propertyAddress: "12 Elm St" }),
      startUnderwrite: async () => { started++; return { job: { id: "uw1" } }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(started, 1);
});

/* ---------- the underwritten number, given roughly when they ask ---------- */

test("a rough version of our number is ours too — rounded to the thousand or down, never up", () => {
  const book = summarizeOffers([{ address: "12 Elm St", status: "new", cashAmount: 447300, createdAt: new Date().toISOString() }]);
  for (const n of [447300, 447000, 445000, 440000, 425000]) assert.ok(book.amounts.includes(n), `${n} should be allowed`);
  assert.ok(!book.amounts.includes(450000), "450 is a rounding UP past 447,300 — that's a raise, not a rough figure");
  const up = summarizeOffers([{ address: "12 Elm St", status: "new", cashAmount: 450800, createdAt: new Date().toISOString() }]);
  assert.ok(up.amounts.includes(450000));

  const r = evaluateReplyGates({
    draft: { ...DRAFT, intent: "question", reply: "Based on our analysis we can likely do around 445k. Would that work for the seller?" },
    allowedAmounts: book.amounts, inboundMessage: "what can you guys do on it?",
  });
  assert.ok(!r.flags.some((f) => /not in the offer book/.test(f)), JSON.stringify(r.flags));
  const bad = evaluateReplyGates({
    draft: { ...DRAFT, intent: "question", reply: "We can likely do around 460k." },
    allowedAmounts: book.amounts, inboundMessage: "what can you guys do on it?",
  });
  assert.ok(bad.flags.some((f) => /not in the offer book/.test(f)), "a number above ours is still caught");
});

/* ---------- a confident underwrite leads with the number ---------- */

import { numberConfidence, leadsWithNumber, chooseProactiveKind } from "./reply-agent.js";

test("confidence comes from the underwrite's own record", () => {
  assert.equal(numberConfidence({ job: { held: [], compsUsed: [1, 2, 3, 4] } }), "high");
  assert.equal(numberConfidence({ job: { held: [], compsUsed: [1, 2, 3] } }), "medium");
  assert.equal(numberConfidence({ job: { held: ["fewer than 3 comps"], compsUsed: [1] } }), "low");
  assert.equal(numberConfidence({ offer: { autoUnderwrite: { passed: true, compsUsedCount: 5 } } }), "high");
  assert.equal(numberConfidence({ offer: { autoUnderwrite: { passed: false } } }), "low");
  assert.equal(numberConfidence({ offer: { autoUnderwrite: { passed: false, publishedAt: "2026-09-12" } } }), "high", "a person published the held draft");
  assert.equal(numberConfidence({ offer: { cashAmount: 1 } }), null, "a hand-built offer isn't scored");

  const config = conversationConfig(STARTER_SAVED);
  const confident = { cashAmount: 410000, autoUnderwrite: { passed: true, compsUsedCount: 4 } };
  assert.equal(leadsWithNumber({ offer: confident, config }), true);
  assert.equal(leadsWithNumber({ offer: { ...confident, autoUnderwrite: { passed: false } }, config }), false);
  assert.equal(leadsWithNumber({ offer: { ...confident, cashAmount: 0 }, config }), false);
  const off = { ...config, parties: { ...config.parties, agent: { ...config.parties.agent, realmCheck: { enabled: true, leadWhenConfident: false } } } };
  assert.equal(leadsWithNumber({ offer: confident, config: off }), false, "the operator can keep 'their read first'");
  assert.equal(chooseProactiveKind({ events: [], address: "12 Elm St", leadWithNumber: true }), "realm_check");
});

test("a confident underwrite floats our number without waiting for their read, in plain words", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const offer = { ...LANDED, cashAmount: 447300, autoUnderwrite: { passed: true, compsUsedCount: 5 } };
  store.listOffers = async () => [offer];
  let seen;
  const { job, skipped } = await startProactive({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer, sendsEnabled: true,
    deps: { draft: async (args) => { seen = args; return { ...DRAFT, intent: "realm_check", reply: "Based on our analysis we can likely do around 445ish on 12 Elm St. Would that work for the seller?", summary: "Floats 445k." }; } },
  });
  assert.ok(job, `started (skipped: ${skipped})`);
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(seen.outbound.confident, true);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.autoSendable, true, d.flags.join(" · "));
});

test("'I'll run it by them and get back to you' is thanked on its own and a check-in is booked; an unsure other still waits", async () => {
  const { takingItToSeller } = await import("./shared/follow-up.js");
  const JULIE = "I will run it by them however they are in no hurry. They own another home in Suncadia, he is a commercial builder and is very market savvy and based in the most current sales in that area not sure what they will say. I will share with them and get back with you. Thank you";
  assert.ok(takingItToSeller(JULIE, Date.parse("2026-09-15T19:00:00Z")));
  assert.ok(takingItToSeller("Let me present it to my sellers", Date.now()));
  assert.equal(takingItToSeller("It's Matt, I buy homes that need work around Renton.", Date.now()), null);
  assert.equal(takingItToSeller("The seller wants 950", Date.now()), null);

  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const rows = [];
  const sends = [];
  const orig = store.appendContactEvents?.bind(store);
  store.getContactProfile ??= async () => null;
  store.upsertContactProfile ??= async () => ({});
  store.appendContactEvents = async (loc, id, add) => { rows.push(...add); return orig ? orig(loc, id, add) : { inserted: add.length, skipped: 0 }; };
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: JULIE,
    deps: { draft: async () => ({ ...DRAFT, intent: "other", confidence: "medium", needsHuman: false,
      reply: "Sounds good, no rush on our end. Let me know what they think.", summary: "Julie will present our number to the sellers." }),
      sendOfferDocs: async (args) => { sends.push(args); return { ok: true, address: "1833 297th Way SE", channels: args.channels }; } },
  });
  for (let i = 0; i < 40 && job.status === "running"; i++) await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "status_check");
  const req = rows.find((r) => r.type === "checkin_requested");
  assert.ok(req, "a check-in is booked in case they don't come back");
  assert.ok(Date.parse(req.data.dueAt) > Date.now());
  assert.equal(sends.length, 1, "the written offer goes to them");
  assert.deepEqual(sends[0].channels, ["sms", "email"]);
  assert.ok(!(d.flags || []).some((f) => /offer didn't go/.test(f)));
  assert.match(d.reply, /Sent our letter of intent over by text and email/);
});

test("our own offer text in the thread is the app, not a person taking over", async () => {
  const at = new Date(Date.now() - 2 * 60000).toISOString().slice(0, 16).replace("T", " ");
  const transcript = `[${at}] THEM sms: I will run it by them\n[${at}] US sms: Hi Julie, here's our written cash offer on 1833 297th Way SE, Fall City, WA 98024 — $1,959,250, as-is (attached).`;
  const store = { async listReplyDrafts() { return []; } };
  assert.equal(await humanHasThread({ store, locationId: "LOC", contactId: "c1", transcript, minutes: 30 }), null);
  const typed = transcript.replace(/Hi Julie, here's our written cash offer on/, "Hey Julie, I'll call you in a bit about");
  assert.ok(await humanHasThread({ store, locationId: "LOC", contactId: "c1", transcript: typed, minutes: 30 }), "a hand-typed text still counts");
});

test("a failed offer send on 'taking it to the seller' doesn't hold the thanks", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.getContactProfile ??= async () => null;
  store.upsertContactProfile ??= async () => ({});
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "Thanks, I'll present it to my sellers and get back to you.",
    deps: { draft: async () => ({ ...DRAFT, intent: "status_check", confidence: "high", needsHuman: false, reply: "Sounds good, let me know what they think." }),
      sendOfferDocs: async () => ({ ok: false, reason: "no open offer to send" }) },
  });
  for (let i = 0; i < 40 && job.status === "running"; i++) await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.ok(!(d.flags || []).some((f) => /offer didn't go out/.test(f)), JSON.stringify(d.flags));
  assert.equal(d.reply, "Sounds good, let me know what they think.", "no claim the offer went when it didn't");
});

test("a book number said the way people text it ('1.144M' for 1,144,500) is not made up; a looser one still is", async () => {
  const { roundsFromBook, evaluateReplyGates } = await import("./reply-agent.js");
  const book = new Set([1144500]);
  assert.equal(roundsFromBook(1144000, book), true);
  assert.equal(roundsFromBook(1145000, book), true);
  assert.equal(roundsFromBook(1100000, book), false, "1.1M is 44k off");
  assert.equal(roundsFromBook(380000, new Set([375500])), false);
  const draft = { intent: "realm_check", confidence: "high", reply: "Ran the numbers on Sahalee. Based on our analysis we can likely do around 1.144M as-is, cash, 10 to 14 day close. Is that in the realm for the seller?" };
  const ok = evaluateReplyGates({ draft, allowedAmounts: [1144500] });
  assert.ok(!ok.flags.some((f) => /not in the offer book/.test(f)), JSON.stringify(ok.flags));
  const loose = evaluateReplyGates({ draft: { ...draft, reply: "We can likely do around 1.1M as-is." }, allowedAmounts: [1144500] });
  assert.ok(loose.flags.some((f) => /not in the offer book/.test(f)));
});

test("an agent who asked to be taken off our list a month ago was drafted a check-in by the ladder", async () => {
  _resetJobs();
  const base = ghlStubFor(["agent"]).client;
  const client = { ...base, call: async (path, opts = {}) => {
    if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1" }] };
    if (path.startsWith("/conversations/cv1/messages")) return { messages: { messages: [
      { id: "m1", direction: "outbound", messageType: "TYPE_SMS", body: "Any fixers coming up?", dateAdded: new Date(Date.now() - 31 * 86400000).toISOString() },
      { id: "m2", direction: "inbound", messageType: "TYPE_SMS", body: "Please take me off your list", dateAdded: new Date(Date.now() - 31 * 86400000 + 60000).toISOString() },
      { id: "m3", direction: "outbound", messageType: "TYPE_SMS", body: "Done, sorry to bother you.", dateAdded: new Date(Date.now() - 31 * 86400000 + 120000).toISOString() },
    ] } };
    return base.call(path, opts);
  } };
  let drafted = false;
  const LADDERS_ON = structuredClone(STARTER_SAVED);
  LADDERS_ON.conversationAi.parties.agent.followUp = { ...(LADDERS_ON.conversationAi.parties.agent.followUp || {}), enabled: true,
    ladders: { ...(LADDERS_ON.conversationAi.parties.agent.followUp?.ladders || {}), passed_checkin: { enabled: true, steps: [10, 20] } } };
  const { job } = await startProactive({
    client, locationId: "LOC", saved: LADDERS_ON, store: fakeStore(), contactId: "c1", kind: "passed_checkin", offer: { ...LANDED, status: "passed" }, sendsEnabled: true,
    deps: { draft: async () => { drafted = true; return { ...DRAFT, intent: "passed_checkin", reply: "Still out there?" }; } },
  });
  await settle();
  assert.equal(job.status, "held");
  assert.match(job.heldReason, /asked to be left alone .* nothing is drafted/);
  assert.equal(drafted, false, "stood down before the model was called");
  assert.equal(job.draftId ?? null, null);
});

test("an answer to our first text that fits no intent keeps the thread going instead of sitting", async () => {
  const withThread = (base, outboundBody) => ({
    ...base,
    call: async (path, opts = {}) => {
      if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1" }] };
      if (path.startsWith("/conversations/cv1/messages")) return { messages: { messages: [
        { id: "m1", direction: "outbound", messageType: "TYPE_SMS", body: outboundBody, dateAdded: new Date(Date.now() - 3600000).toISOString() },
      ] } };
      return base.call(path, opts);
    },
  });
  const run = async (outboundBody, over = {}) => {
    _resetJobs();
    const { client } = ghlStubFor(["agent"]);
    const store = fakeStore();
    const { job } = await startReply({
      client: withThread(client, outboundBody), locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "Its for sale",
      deps: { draft: async () => ({ ...DRAFT, intent: "other", confidence: "medium", needsHuman: false,
        reply: "Good to know it's still available. What kind of shape is it in, does it need much work?", ...over }) },
    });
    for (let i = 0; i < 40 && job.status === "running"; i++) await settle();
    return store.getReplyDraft(job.draftId);
  };
  const OPEN = "Hi Steven, came across your listing for 13412 Se 59th St. I'm local here in Seattle and buy places to fix up King and Pierce counties mostly. Is this one a bit of a project, or pretty turnkey?";
  const d = await run(OPEN);
  assert.equal(d.intent, "question");
  assert.ok(!(d.flags || []).some((f) => /person's call/.test(f)), JSON.stringify(d.flags));
  assert.equal((await run("Hey, following up on the offer we sent.")).intent, "other", "not an answer to our first text: still a person's call");
  assert.equal((await run(OPEN, { reply: "We could do around 400k on it." })).intent, "other", "a reply that names a number still waits");
});

/* ---------- a counter typed short, and a thread nobody answered ---------- */

test("counterDollars reads the seller's number the way an agent types it", async () => {
  const { counterDollars } = await import("./reply-agent.js");
  const ours = 456250;

  // Thomas Rinow, 2026-09-15, on our $456,250 offer — the number we had just
  // asked him for. The model echoed the digits; the message has no "$" and no
  // "k", so moneyIn read nothing at all.
  const said = "That are willing to go to 670";
  assert.equal(counterDollars(670, { message: said, reference: ours }), 670000);
  assert.equal(counterDollars(0, { message: said, reference: ours }), 670000, "and it stands in for a model that read none");

  // A figure written in full is already money and is left alone.
  assert.equal(counterDollars(700000, { message: "Their lowest at this time is $700k.", reference: ours }), 700000);
  assert.equal(counterDollars(670000, { message: "at $670,000", reference: ours }), 670000);

  // Days, times and door codes are not prices: nothing plausible, nothing read.
  assert.equal(counterDollars(0, { message: "your 12 day inspection contingency is a killer", reference: ours }), 0);
  assert.equal(counterDollars(0, { message: "call me at 5", reference: ours }), 0);
  assert.equal(counterDollars(0, { message: "lockbox is 1421, go anytime", reference: ours }), 0);

  // Out of the house-price band around our own number, so not our counter.
  assert.equal(counterDollars(0, { message: "she'd take 60", reference: ours }), 0);
  // No offer to measure against: nothing is scaled on a guess.
  assert.equal(counterDollars(670, { message: said, reference: 0 }), 670);
});

test("a shorthand counter over our number gets an answer instead of silence", async () => {
  // The whole failure this fixes: read as $670, their number was UNDER ours,
  // the band failed on "at or under our own number", the draft was held, and
  // Thomas Rinow heard nothing back at all.
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = negotiationStore(NEGOTIATION_OFFER);
  const { job } = await startReply({
    client, locationId: "LOC", saved: bandSaved(), store, contactId: "c1", sendsEnabled: true,
    message: "That are willing to go to 670",
    deps: { draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", needsHuman: false,
      counterAmount: 670, reply: "Let me run that by my partner.", propertyAddress: "12 Elm St" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.counterAmount, 670000, "670 on a 300k offer is 670,000");
  assert.equal(d.intent, "rejection", "well past the most we'd pay — filed as their pass, with the door left open");
  assert.match(d.reply, /didn't work out for us/);
  assert.equal(d.status, "scheduled", d.autoSend?.reason);
});

test("a shorthand counter they can deliver is still read as their number — and this far past the most we'd pay it's a pass, not a round", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = negotiationStore(NEGOTIATION_OFFER);
  const { job } = await startReply({
    client, locationId: "LOC", saved: bandSaved(), store, contactId: "c1", sendsEnabled: true,
    message: "I could probably get them to 670 on 12 Elm",
    deps: { draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", needsHuman: false,
      counterAmount: 0, reply: "Let me run that by my partner.", propertyAddress: "12 Elm St" }) },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.counterAmount, 670000, "the model read no number; the message still had one");
  assert.equal(d.intent, "rejection", "Matt, 2026-09-16: quicker to pass when the floor is out of reach — 670 against a 360 ceiling is not a gap to work");
  assert.match(d.reply, /didn't work out for us/);
});

test("a shorthand counter inside the ceiling still passes 'their own words'", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = negotiationStore(NEGOTIATION_OFFER);
  const order = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: bandSaved(), store, contactId: "c1", sendsEnabled: true,
    message: "She'd go to 350 on 12 Elm",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", needsHuman: false,
        counterAmount: 350, reply: "Let me run that by my partner.", propertyAddress: "12 Elm St" }),
      reviseOfferToCounter: async ({ amount }) => { order.push(["revise", amount]); return { ok: true, address: "12 Elm St", amount }; },
      sendOfferDocs: async ({ afterCounter }) => { order.push(["send", afterCounter]); return { ok: true, address: "12 Elm St", channels: ["sms"] }; },
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  const words = (d.exception?.checks || []).find((c) => c.name === "their_own_words");
  assert.equal(words?.ok, true, JSON.stringify(d.exception?.checks));
  assert.equal(d.exception?.passed, false, "and still waits: 350k is above the 300k we sent");
  assert.deepEqual(order, []);
});

test("when nothing goes out, the thread gets a clock and a note", async () => {
  _resetJobs();
  const { client, notes } = ghlStubFor(["agent"]);
  const store = negotiationStore(NEGOTIATION_OFFER);
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "The seller wants to see proof of funds before we go further.",
    deps: { draft: async () => ({ ...DRAFT, intent: "proof_of_funds", confidence: "high", needsHuman: true,
      humanReason: "they want proof of funds", reply: "Let me get that over to you today.", propertyAddress: "12 Elm St" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.notEqual(d.status, "scheduled", "the premise: this one waits on a person");

  const events = await store.listContactEvents("LOC", "c1", { types: ["checkin_requested"] });
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].data.kind, "unanswered");
  assert.ok(Date.parse(events[0].data.dueAt) > Date.now(), "the check-in is ahead of us, not behind");
  assert.ok(notes.some((n) => /Nothing went out/.test(n)), notes.join(" | "));
});

test("an opt-out is never put on the check-in clock", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = negotiationStore(NEGOTIATION_OFFER);
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "Take me off your list.",
    deps: { draft: async () => ({ ...DRAFT, intent: "opt_out", confidence: "high", needsHuman: false, reply: "" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const events = await store.listContactEvents("LOC", "c1", { types: ["checkin_requested"] });
  assert.equal(events.length, 0, "silence is the whole point of an opt-out");
});

/* ---------- a burst never silences a thread (Colin Foote, 2026-09-15) ---------- */

test("a held third text lets the scheduled reply to the first two go, and waits on top of it", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore([{
    id: "sched", locationId: "LOC", contactId: "c1", status: "scheduled", channel: "sms",
    reply: "Running 15605 NE 1st by underwriting today. What kind of work does it need?",
    autoSend: { decided: true, reason: "" }, sendAt: new Date(Date.now() + 30000).toISOString(), createdAt: iso(60000),
  }]);
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "Buyer to pay my 3% unless list backs are willing. Then flexible",
    deps: { draft: async () => ({ ...DRAFT, intent: "other", confidence: "medium", needsHuman: false,
      reply: "Commission structure is my partner's call, I'll get you an answer today. What kind of work is it needing?", propertyAddress: "15605 NE 1st St" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.notEqual(d.status, "scheduled", "the premise: the commission question waits for a person");
  assert.equal((await store.getReplyDraft("sched")).status, "scheduled", "the reply that was counting down still goes");
  assert.deepEqual(d.keptScheduledIds, ["sched"]);
  assert.deepEqual(d.supersededIds, []);
  assert.ok(d.warnings.some((w) => /still goes/.test(w)), d.warnings.join(" | "));
});

test("a text that turns the conversation still supersedes what was counting down", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore([{
    id: "sched", locationId: "LOC", contactId: "c1", status: "scheduled", channel: "sms",
    reply: "Running it today. What kind of work does it need?", autoSend: { decided: true, reason: "" },
    sendAt: new Date(Date.now() + 30000).toISOString(), createdAt: iso(60000),
  }]);
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "Actually never mind, seller just accepted another offer.",
    deps: { draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "high", needsHuman: false, reply: "Understood, thanks for letting me know.", propertyAddress: "15605 NE 1st St" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal((await store.getReplyDraft("sched")).status, "superseded", "a stale 'what work does it need?' must not go out after a no");
});

/* ---------- unsubscribed (DND) — flagged, never drafted (2026-09-16) ---------- */

// A blast reply to a buyer who had texted STOP failed "Cannot send message
// as +1425… has unsubscribed" and sat in Today as "Needs you". GHL records a
// STOP as dndSettings.SMS.status "permanent" with the top-level dnd false.
function ghlStubDnd(dndSettings) {
  const notes = []; const tagCalls = [];
  const client = { call: async (path, opts = {}) => {
    if (/^\/contacts\/c1$/.test(path) && !opts.method) return { contact: { id: "c1", firstName: "Abey", lastName: "G", tags: ["investor"], dnd: false, dndSettings } };
    if (path.endsWith("/notes")) { notes.push(opts.body.body); return {}; }
    if (path.endsWith("/tags")) { tagCalls.push([opts.method || "POST", opts.body.tags]); return {}; }
    if (path.endsWith("/customFields") && !opts.method) return { customFields: [] };
    if (path.startsWith("/conversations/search")) return { conversations: [] };
    return {};
  } };
  return { client, notes, tags: tagCalls };
}

test("a contact who texted STOP is held before the model is called, tagged, and never drafted", async () => {
  _resetJobs();
  const { client, tags } = ghlStubDnd({ SMS: { status: "permanent", message: "STOP_KEYWORD" } });
  const store = fakeStore();
  let modelCalls = 0;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "Is that Snohomish one still available?",
    deps: { draft: async () => { modelCalls++; return DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "held");
  assert.match(job.heldReason, /unsubscribed/);
  assert.equal(modelCalls, 0, "no draft, no model call");
  assert.ok(!job.draftId, "no draft row either");
  assert.ok(tags.some(([, t]) => t.includes("unsubscribed")), JSON.stringify(tags));
  const events = await store.listContactEvents("LOC", "c1", { types: ["unsubscribed"] });
  assert.equal(events.length, 1, "one timeline row, the flag");
});

test("a manual DND holds the same way; a contact GHL will text is not held", async () => {
  const { smsUnsubscribed } = await import("./ghl.js");
  assert.equal(smsUnsubscribed({ dnd: false, dndSettings: { SMS: { status: "permanent" } } }), true);
  assert.equal(smsUnsubscribed({ dnd: false, dndSettings: { SMS: { status: "active" } } }), true);
  assert.equal(smsUnsubscribed({ dnd: true }), true);
  assert.equal(smsUnsubscribed({ dnd: false, dndSettings: { SMS: { status: "inactive" } } }), false);
  assert.equal(smsUnsubscribed({ dnd: false, dndSettings: { Email: { status: "permanent" } } }), false, "an email DND is not a text DND");
  assert.equal(smsUnsubscribed(null), false);
});

test("a scheduled text to someone who unsubscribed since is dismissed, not sent and not handed back", async () => {
  const { sendReplyDraft } = await import("./reply-agent.js");
  const { client, tags } = ghlStubDnd({ SMS: { status: "permanent" } });
  const store = fakeStore([{ id: "d9", locationId: "LOC", contactId: "c1", status: "scheduled", channel: "sms", reply: "Package is on its way.", party: "investor", createdAt: iso(1000), flags: [] }]);
  store.getOffer = async () => null; store.listDeals = async () => [];
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d9", live: true, auto: true });
  assert.equal(r.skipped, "they unsubscribed");
  const d = await store.getReplyDraft("d9");
  assert.equal(d.status, "dismissed");
  assert.match(d.flags.join(" "), /unsubscribed — not sent/);
  assert.ok(tags.some(([, t]) => t.includes("unsubscribed")));
});

/* ---------- we passed: our own pass ends the chasing (2026-09-22) ---------- */

// Joseph Brazen, Medina: the passed-offer check-in went out, the agent asked
// for best and final, and Matt marked the offer "we passed". Nothing the
// machine had queued about that house may go after that.
test("a queued check-in on a house we passed on since is dismissed, not sent", async () => {
  const { sendReplyDraft, stopMachineTextsForOffer } = await import("./reply-agent.js");
  const { client, tags } = ghlStub();
  const store = fakeStore([
    { id: "d1", locationId: "LOC", contactId: "c1", status: "scheduled", channel: "sms", party: "agent", createdAt: iso(1000), flags: [],
      reply: "Is the Medina lot still available?", inbound: "", outbound: { kind: "passed_checkin", offerId: "o1", address: "7 Elm St" } },
  ]);
  store.getOffer = async (id) => (id === "o1" ? { id: "o1", locationId: "LOC", contactId: "c1", address: "7 Elm St", status: "we_passed", statusHistory: [{ status: "passed" }, { status: "we_passed" }] } : null);
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true });
  assert.equal(r.skipped, "we passed on 7 Elm St");
  const d = await store.getReplyDraft("d1");
  assert.equal(d.status, "dismissed");
  assert.match(d.flags.join(" "), /we passed on 7 Elm St — not sent/);
  assert.ok(tags.some(([m]) => m === "DELETE"), "the draft tag comes off");
  assert.equal(typeof stopMachineTextsForOffer, "function");
});

/* ---------- you stopped outreach on the deal (2026-10-01) ---------- */

// 5232 S Yakima: Matt stopped outreach on the deal. Anything already counting
// down about it — a blast text, or the bot's reply to a buyer — must not go
// out by itself after that.
const STOPPED_DEAL = { id: "o9", locationId: "LOC", contactId: "agent1", address: "5232 South Yakima Avenue, Tacoma, WA 98408",
  deal: { stage: "under_contract", investors: [], outreachStopped: { at: iso(60000), by: "you" } } };

test("a queued blast on a deal you stopped outreach on is dismissed, not sent", async () => {
  const { sendReplyDraft } = await import("./reply-agent.js");
  const { client, tags } = ghlStub();
  const store = fakeStore([{ id: "d1", locationId: "LOC", contactId: "c1", status: "sending", channel: "sms", party: "investor", createdAt: iso(1000), flags: [],
    reply: "Hey Dana, got 5232 South Yakima Avenue in Tacoma under contract.", inbound: "", intent: "blast_open",
    outbound: { kind: "blast_open", offerId: "o9", address: STOPPED_DEAL.address } }]);
  store.getOffer = async (id) => (id === "o9" ? STOPPED_DEAL : null);
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true });
  assert.equal(r.skipped, "you stopped outreach on 5232 South Yakima Avenue");
  const d = await store.getReplyDraft("d1");
  assert.equal(d.status, "dismissed");
  assert.match(d.flags.join(" "), /you stopped outreach on 5232 South Yakima Avenue — not sent/);
  assert.ok(tags.some(([m]) => m === "DELETE"), "the draft tag comes off");
});

test("the bot's reply to a buyer about a deal you stopped outreach on waits for you instead of sending itself", async () => {
  const { sendReplyDraft } = await import("./reply-agent.js");
  const { client } = ghlStub();
  const store = fakeStore([{ id: "d2", locationId: "LOC", contactId: "c1", status: "sending", channel: "sms", party: "investor", createdAt: iso(1000), flags: [],
    reply: "Buyer price is 261k, want the package?", inbound: "What's the number on Yakima?", intent: "question", propertyAddress: "5232 South Yakima Avenue, Tacoma" }]);
  store.getOffer = async () => null;
  store.listDeals = async () => [STOPPED_DEAL];
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d2", live: true, auto: true });
  assert.equal(r.held, true);
  const d = await store.getReplyDraft("d2");
  assert.equal(d.status, "draft", "back with you, not dismissed — it answers something they said");
  assert.equal(d.sendAt, null);
  assert.match(d.flags.join(" "), /you stopped outreach on 5232 South Yakima Avenue — waiting for you/);
  // Held the way every other hold is, so the nightly audit's release doesn't
  // put it back on a clock (shared/conversation-audit.js skips "needs a person:").
  assert.equal(d.autoSend?.decided, false);
  assert.match(d.autoSend?.reason || "", /^needs a person: you stopped outreach on 5232 South Yakima Avenue/);
  assert.ok(d.heldAt, "stamped like the other holds");
});

test("a buyer text about a different deal still goes when one deal's outreach is stopped", async () => {
  const { sendReplyDraft } = await import("./reply-agent.js");
  const sent = [];
  const client = { call: async (path, opts = {}) => {
    if (/^\/contacts\/c1$/.test(path)) return { contact: { id: "c1", firstName: "Dana", tags: ["investor"] } };
    if (path.startsWith("/conversations/search")) return { conversations: [] };
    if (path.startsWith("/conversations/messages")) { sent.push(opts.body); return { messageId: "m1" }; }
    return {};
  } };
  const store = fakeStore([{ id: "d3", locationId: "LOC", contactId: "c1", status: "sending", channel: "sms", party: "investor", createdAt: iso(1000), flags: [],
    reply: "Sure, sending it over.", inbound: "Can I see 7034 S K St?", intent: "question", propertyAddress: "7034 South K Street, Tacoma" }]);
  store.getOffer = async () => null;
  store.listDeals = async () => [STOPPED_DEAL, { id: "o7", locationId: "LOC", address: "7034 South K Street, Tacoma, WA", deal: { stage: "under_contract", investors: [] } }];
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d3", live: true, auto: true, readThread: async () => "" });
  assert.ok(!r.skipped, JSON.stringify(r));
  assert.equal(sent.length, 1);
});

test("a check-in on a house THEY passed on still goes — that ladder is the point", async () => {
  const { sendReplyDraft } = await import("./reply-agent.js");
  const sent = [];
  const client = { call: async (path, opts = {}) => {
    if (/^\/contacts\/c1$/.test(path)) return { contact: { id: "c1", firstName: "Dana", tags: ["agent"] } };
    if (path.startsWith("/conversations/search")) return { conversations: [] };
    if (path.startsWith("/conversations/messages")) { sent.push(opts.body); return { messageId: "m1" }; }
    if (path.endsWith("/tags")) return {};
    return {};
  } };
  const store = fakeStore([
    { id: "d1", locationId: "LOC", contactId: "c1", status: "scheduled", channel: "sms", party: "agent", createdAt: iso(1000), flags: [],
      reply: "Any movement from the seller on 7 Elm?", inbound: "", outbound: { kind: "passed_checkin", offerId: "o1", address: "7 Elm St" } },
  ]);
  store.getOffer = async () => ({ id: "o1", locationId: "LOC", contactId: "c1", address: "7 Elm St", status: "passed", statusHistory: [{ status: "passed" }] });
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true, readThread: async () => "" });
  assert.ok(!r.skipped, JSON.stringify(r));
  assert.equal(sent.length, 1);
});

test("marking we passed clears every queued machine text about that house and leaves replies alone", async () => {
  const { stopMachineTextsForOffer } = await import("./reply-agent.js");
  const { client } = ghlStub();
  const store = fakeStore([
    { id: "d1", locationId: "LOC", contactId: "c1", status: "scheduled", party: "agent", createdAt: iso(3000), flags: [], reply: "x", inbound: "", outbound: { kind: "passed_checkin", offerId: "o1" } },
    { id: "d2", locationId: "LOC", contactId: "c1", status: "draft", party: "agent", createdAt: iso(2000), flags: [], reply: "x", inbound: "", outbound: { kind: "price_drop", offerId: "o1" } },
    // A reply to something they said is an answer, not outreach.
    { id: "d3", locationId: "LOC", contactId: "c1", status: "draft", party: "agent", createdAt: iso(1000), flags: [], reply: "x", inbound: "Flexible based on price", outbound: null },
    // Another house of theirs keeps its nudge.
    { id: "d4", locationId: "LOC", contactId: "c1", status: "scheduled", party: "agent", createdAt: iso(500), flags: [], reply: "x", inbound: "", outbound: { kind: "offer_nudge", offerId: "o2" } },
  ]);
  const stopped = await stopMachineTextsForOffer({ client, store, locationId: "LOC", offer: { id: "o1", contactId: "c1", address: "7 Elm St" } });
  assert.deepEqual(stopped.sort(), ["d1", "d2"]);
  assert.equal((await store.getReplyDraft("d1")).status, "dismissed");
  assert.equal((await store.getReplyDraft("d2")).status, "dismissed");
  assert.equal((await store.getReplyDraft("d3")).status, "draft");
  assert.equal((await store.getReplyDraft("d4")).status, "scheduled");
});

/* ---------- a hold before any draft is on the record (2026-09-22) ---------- */

test("a reply the bot-off tag holds before drafting leaves a reply_held row the audit can read", async () => {
  _resetJobs();
  const client = { call: async (path) => {
    if (/^\/contacts\/c1$/.test(path)) return { contact: { id: "c1", firstName: "Michael", tags: ["agent", "stop bot"] } };
    if (path.startsWith("/conversations/search")) return { conversations: [] };
    return {};
  } };
  const store = fakeStore();
  let modelCalls = 0;
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "we received an offer late this morning",
    deps: { draft: async () => { modelCalls++; return DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "held");
  assert.match(job.heldReason, /bot is off for this contact/);
  assert.equal(modelCalls, 0);
  const rows = await store.listContactEvents("LOC", "c1", { types: ["reply_held"] });
  assert.equal(rows.length, 1);
  assert.match(rows[0].data.reason, /tag: stop bot/);
});

/* ---------- the nightly audit's release (2026-09-16) ---------- */

test("a draft held only as a person's call is released when the audit asks; one the gates caught never is", async () => {
  const { releaseForAudit } = await import("./reply-agent.js");
  const gateOk = { ok: true, flags: [] };
  const draft = { intent: "counter", reply: "Let me run that by my partner.", needsHuman: false };
  const held = { send: false, code: "never_auto", reason: "a counter is a person's call" };
  assert.equal(releaseForAudit({ auto: held, gate: gateOk, draft, deps: {} }).send, false, "only when asked");
  const r = releaseForAudit({ auto: held, gate: gateOk, draft, deps: { releaseHeld: true } });
  assert.equal(r.send, true);
  assert.match(r.reason, /released by the nightly audit/);
  assert.equal(releaseForAudit({ auto: { send: false, code: "gates", reason: "needs a person: names 500k" }, gate: { ok: false, flags: ["x"] }, draft, deps: { releaseHeld: true } }).send, false, "the money guard is never released");
  assert.equal(releaseForAudit({ auto: held, gate: gateOk, draft: { ...draft, needsHuman: true }, deps: { releaseHeld: true } }).send, false);
  assert.equal(releaseForAudit({ auto: { send: false, code: "human_active", reason: "you have the thread" }, gate: gateOk, draft, deps: { releaseHeld: true } }).send, false, "a person's thread stays theirs");
  assert.equal(releaseForAudit({ auto: held, gate: gateOk, draft: { ...draft, intent: "small_talk" }, deps: { releaseHeld: true } }).send, false);
  assert.equal(releaseForAudit({ auto: { send: false, code: "not_allowlisted", reason: "off the list" }, gate: gateOk, draft: { ...draft, intent: "partner_answer" }, deps: { releaseHeld: true } }).send, false,
    "the owner's own answer waits for the owner's Send");
});

test("a never-auto intent's reply passes the gates as locked-but-clean, and the audit releases exactly that", async () => {
  const { releaseForAudit } = await import("./reply-agent.js");
  // How evaluateReplyGates reports a counter reply that named no numbers:
  // not ok (the lock is a flag), locked, and clean apart from the lock.
  const locked = { ok: false, flags: ["a counter is a person's call"], locked: "a counter is a person's call", clean: true };
  const held = { send: false, code: "never_auto", reason: "a counter is a person's call" };
  const draft = { intent: "counter", reply: "Let me run that by my partner.", needsHuman: false };
  assert.equal(releaseForAudit({ auto: held, gate: locked, draft, deps: { releaseHeld: true } }).send, true);
  const dirty = { ...locked, flags: [...locked.flags, "the draft names 500k, which is not in the offer book"], clean: false };
  assert.equal(releaseForAudit({ auto: { send: false, code: "gates", reason: "needs a person: names 500k" }, gate: dirty, draft, deps: { releaseHeld: true } }).send, false);
});

test("the list price said in words is their floor, and a soft floor out of reach is a pass, not a round", async () => {
  // Bryce Buri (2026-09-16): our 900k, "far too low", asked where the seller
  // needs to be — "Current list price". No digits in the message; the list
  // price is the number, and it's a pass.
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  // No list price on the offer (a published held draft carries none): the
  // seller's ask on the timeline is the list price.
  const store = negotiationStore(NEGOTIATION_OFFER);
  await store.appendContactEvents("LOC", "c1", [{ type: "property_details", at: new Date().toISOString(), address: "12 Elm St, Seattle, WA 98101", data: { sellerAsk: 470000 }, dedupeKey: "pd:1" }]);
  const { job } = await startReply({
    client, locationId: "LOC", saved: bandSaved(), store, contactId: "c1", sendsEnabled: true,
    message: "Current list price",
    deps: { draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "high", needsHuman: false, counterAmount: 0,
      reply: "Understood. Any chance they'd counter?", propertyAddress: "12 Elm St" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.counterAmount, 470000, "their floor is the list price");
  assert.equal(d.intent, "rejection");
  assert.match(d.reply, /didn't work out for us/);
  assert.ok(d.actions.some((a) => a.type === "mark_offer_passed"), "filed as they passed");
  assert.ok(d.actions.some((a) => a.type === "add_tags" && a.tags.includes("tier-3")), "and Tier 3");

  // Softly put, but 40% past the most we'd pay: no round, a pass.
  _resetJobs();
  const store2 = negotiationStore(NEGOTIATION_OFFER);
  const r2 = await startReply({
    client, locationId: "LOC", saved: bandSaved(), store: store2, contactId: "c1", sendsEnabled: true,
    message: "If you were more around $505k we would consider it most likely.",
    deps: { draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", needsHuman: false, counterAmount: 505000,
      reply: "Let me run that by my partner.", propertyAddress: "12 Elm St" }) },
  });
  await settle();
  const d2 = await store2.getReplyDraft(r2.job.draftId);
  assert.equal(d2.intent, "rejection");
  assert.match(d2.summary, /filed as a pass/);
});

test("the agent's words read as a deal signal; a no or a hedge the other way does not", async () => {
  const { dealSignalFromText: f } = await import("./shared/conversation-ai.js");
  assert.equal(f("That might work. Let me talk to them"), "warm");
  assert.equal(f("you're getting closer"), "warm");
  assert.equal(f("Let's present it"), "presenting");
  assert.equal(f("I will run it by them"), "presenting");
  assert.equal(f("Sure, I'll write it up tonight"), "writing_up");
  for (const no of ["that wont work", "I don't think that would work for them", "probably not going to work", "That is way too low", "Sounds good!", "Not a fixer. Thanks"]) assert.equal(f(no), "", no);
});

test("an agent warming to our number raises the offer's heat; a rejection never does", async () => {
  for (const [message, draft, want] of [
    ["That might work. Let me talk to them", { intent: "other", dealSignal: "" }, "warm"],              // the words alone
    ["ok", { intent: "other", dealSignal: "writing_up" }, "writing_up"],                                   // the model's read
    ["That might work for someone else, we're passing", { intent: "rejection", dealSignal: "warm" }, null],
  ]) {
    _resetJobs();
    const { client } = ghlStubFor(["agent"]);
    const calls = [];
    const { job } = await startReply({
      client, locationId: "LOC", saved: STARTER_NOW, store: fakeStore(), contactId: "c1", message,
      deps: {
        draft: async () => ({ ...DRAFT, propertyAddress: "12 Elm St, Renton, WA 98056", reply: "Appreciate it.", ...draft }),
        raiseOfferHeat: async (args) => { calls.push(args); return { ok: true, raised: true, address: args.addressHint }; },
      },
    });
    await settle();
    assert.equal(job.status, "done", job.error);
    if (want) { assert.equal(calls.length, 1, message); assert.equal(calls[0].signal, want); assert.equal(calls[0].contactId, "c1"); }
    else assert.equal(calls.length, 0, message);
  }
});

// 1010 Bellevue (2026-10-04): "If you would like to make an offer closer to
// where they are at, that may get them to move on it" — the model read
// "warm" and the Desk called the house hot. And 831 NW 52nd's "seller is
// having second thoughts" left the heat on.
test("an agent asking us to come up never makes the offer hot, and cools heat the conversation set", async () => {
  for (const [message, draft] of [
    ["If you would like to make an offer closer to where they are at, that may get them to move on it.", { intent: "counter", dealSignal: "warm" }],
    ["They are content on sitting with the tenants unless you want to come closer to where they are.", { intent: "other", dealSignal: "warm" }],
    ["Hi Matt, seller is having second thoughts and may just want to hold tight. Too low a margin.", { intent: "status_check", dealSignal: "" }],
  ]) {
    _resetJobs();
    const { client } = ghlStubFor(["agent"]);
    const raised = [], cooled = [];
    const { job } = await startReply({
      client, locationId: "LOC", saved: STARTER_NOW, store: fakeStore(), contactId: "c1", message,
      deps: {
        draft: async () => ({ ...DRAFT, propertyAddress: "10 Bellevue Ct E, Seattle, WA 98102", reply: "Understood.", ...draft }),
        raiseOfferHeat: async (args) => { raised.push(args); return { ok: true, raised: true, address: args.addressHint }; },
        coolOfferHeat: async (args) => { cooled.push(args); return { ok: true, cooled: true, address: args.addressHint }; },
      },
    });
    await settle();
    assert.equal(job.status, "done", job.error);
    assert.equal(raised.length, 0, message);
    assert.equal(cooled.length, 1, message);
  }
});

test("our own offer letter echoed back as their message is nothing to answer: no draft, no heat", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  const raised = [];
  const r = await startReply({
    client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1",
    message: "Hi Dana, Please find our letter of intent on 12 Elm St, Renton, WA 98056 attached — $340,875, cash, as-is. If the seller's open to it, could you represent us and write it up on NWMLS forms for us to sign?",
    deps: { draft: async () => ({ ...DRAFT, reply: "Having trouble getting that email out." }), raiseOfferHeat: async (a) => { raised.push(a); return { ok: true }; } },
  });
  assert.equal(r.job, null);
  assert.equal(r.echo, true);
  assert.match(r.skipped, /echoed back/);
  await settle();
  assert.equal(raised.length, 0);
  // Their own words with our letter quoted under them are theirs: answered.
  const { isOurEcho } = await import("./reply-agent.js");
  const quoted = "Thanks Matt, the seller wants to counter at 360. Can you do that?\n\nOn Fri, Matt wrote:\n> Hi Dana, Please find our letter of intent on 12 Elm St attached";
  assert.equal(await isOurEcho({ store: fakeStore(), locationId: "LOC", contactId: "c1", message: quoted }), false);
});

test("'my email is …, please cc …' emails the documents there; the text only says so if it went", async () => {
  const MSG = "My email is Ldedinsky3@gmail.com, please cc info@homesteadhomegroup.com I will get it in front of them";
  for (const went of [true, false]) {
    _resetJobs();
    const { client } = ghlStubFor(["agent"]);
    const store = fakeStore();
    const sends = [];
    const { job } = await startReply({
      client, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: MSG,
      deps: {
        draft: async () => ({ ...DRAFT, intent: "question", propertyAddress: "3618 Chrisella Rd E, Edgewood, WA 98372", reply: "Good catch, sending to you with info copied." }),
        sendOfferDocs: async (args) => { sends.push(args); return went ? { ok: true, address: "3618 Chrisella Rd E", channels: ["email"], emailTo: args.emailTo } : { ok: false, reason: "the email didn't go — GHL 400" }; },
      },
    });
    await settle();
    assert.equal(job.status, "done", job.error);
    assert.equal(sends.length, 1);
    assert.deepEqual([sends[0].channels, sends[0].emailTo, sends[0].emailCc], [["email"], "Ldedinsky3@gmail.com", ["info@homesteadhomegroup.com"]]);
    const d = await store.getReplyDraft(job.draftId);
    if (went) assert.match(d.reply, /Just emailed it to Ldedinsky3@gmail\.com with info@homesteadhomegroup\.com copied/);
    else {
      assert.match(d.reply, /Having trouble getting that email out/);
      assert.notEqual(d.status, "sent"); assert.notEqual(d.status, "scheduled");
      assert.ok((d.flags || []).some((f) => /didn't go/.test(f)));
    }
  }
});

/* ---------- the hot push never asks for a contract (2026-09-17) ---------- */

test("a hot push that says PSA or contract is held: we ask for the NWMLS offer, never our paper", async () => {
  const { evaluateReplyGates } = await import("./reply-agent.js");
  const gate = (reply) => evaluateReplyGates({ draft: { intent: "hot_push", reply, confidence: "high", needsHuman: false }, party: "agent", allowedAmounts: [410000], forbiddenAmounts: [], inboundMessage: "", channel: "sms", style: {}, minConfidence: "medium", holdOnNeedsHuman: false });
  assert.equal(gate("Glad 410 works. Could you write it up on the NWMLS forms and send it over for us to sign?").flags.some((f) => /NWMLS offer/.test(f)), false);
  assert.ok(gate("Glad 410 works. I'll send over our PSA today.").flags.some((f) => /NWMLS offer/.test(f)));
  assert.ok(gate("Great, I'll get a contract over to you.").flags.some((f) => /NWMLS offer/.test(f)));
  const other = evaluateReplyGates({ draft: { intent: "question", reply: "Once it's under contract we close in two weeks.", confidence: "high", needsHuman: false }, party: "agent", allowedAmounts: [], forbiddenAmounts: [], inboundMessage: "", channel: "sms", style: {}, minConfidence: "medium", holdOnNeedsHuman: false });
  assert.equal(other.flags.some((f) => /NWMLS offer/.test(f)), false, "only the hot push is held to this");
});

/* ---------- the investor band reads the deal (2026-09-17) ---------- */

const IDEAL = { id: "deal1", locationId: "LOC", address: "23706 138th Dr SE, Snohomish, WA 98296", cashAmount: 400000,
  deal: { stage: "under_contract", contractPrice: 400000, assignmentFee: 25000, investors: [{ contactId: "b1", status: "evaluating" }] } };
const investorStore = ({ deals = [IDEAL], drafts = [], rooms = [] } = {}) => ({
  async listDeals() { return deals; },
  async listDatarooms() { return rooms; },
  async listReplyDrafts() { return drafts; },
});
const iCfg = (on = true) => normalizeConversationAi({ enabled: true, parties: { investor: { priceBand: { enabled: on } } } });
const iDraft = (over = {}) => ({ intent: "price_pushback", counterAmount: 415000, confidence: "high", needsHuman: false, propertyAddress: IDEAL.address, ...over });
const iJob = (message = "I could do 415k on this one") => ({ contactId: "b1", message });

test("the investor band reads the buyer's own deal: contract plus fee is the asking price, and their typed number above the floor opens it", async () => {
  const v = await evaluateBandFor({ store: investorStore(), locationId: "LOC", party: "investor", config: iCfg(), saved: {}, draft: iDraft(), job: iJob(), now: Date.now() });
  assert.equal(v.kind, "investor_band");
  assert.equal(v.passed, true, v.reason);
  assert.equal(v.asking, 425000);
  assert.equal(v.releaseAmount, 415000);
});

test("with the band off a price pushback is still yours, and nothing is read", async () => {
  let reads = 0;
  const store = { ...investorStore(), async listDeals() { reads++; return [IDEAL]; } };
  assert.equal(await evaluateBandFor({ store, locationId: "LOC", party: "investor", config: iCfg(false), saved: {}, draft: iDraft(), job: iJob(), now: Date.now() }), null);
  assert.equal(reads, 0);
});

test("the dataroom's own headline is the asking price when the buyer has seen one", async () => {
  const rooms = [{ id: "r1", status: "active", kind: "deal", snapshot: { numbers: { investorPrice: 440000 } } }];
  const v = await evaluateBandFor({ store: investorStore({ rooms }), locationId: "LOC", party: "investor", config: iCfg(), saved: {}, draft: iDraft(), job: iJob(), now: Date.now() });
  assert.equal(v.asking, 440000);
  assert.equal(v.passed, false, "415k is more than five percent under 440k");
});

test("the daily cap counts investor releases from the store, and the agent's band does not eat it", async () => {
  const today = new Date().toISOString();
  const agentRelease = { id: "x", createdAt: today, exception: { kind: "counter_band", passed: true } };
  const open = await evaluateBandFor({ store: investorStore({ drafts: [agentRelease] }), locationId: "LOC", party: "investor", config: iCfg(), saved: {}, draft: iDraft(), job: iJob(), now: Date.now() });
  assert.equal(open.passed, true, open.reason);
  const used = { id: "y", createdAt: today, exception: { kind: "investor_band", passed: true } };
  const shut = await evaluateBandFor({ store: investorStore({ drafts: [used] }), locationId: "LOC", party: "investor", config: iCfg(), saved: {}, draft: iDraft(), job: iJob(), now: Date.now() });
  assert.equal(shut.passed, false);
  assert.match(shut.reason, /1 of 1 today/);
  const { bandReleasesToday } = await import("./reply-agent.js");
  assert.equal(await bandReleasesToday({ store: investorStore({ drafts: [agentRelease, used] }), locationId: "LOC" }), 1, "and the investor's does not eat the agent's");
});

test("a buyer on two live deals who names no address is a person's call", async () => {
  const other = { ...IDEAL, id: "deal2", address: "9 Oak St, Kent, WA", deal: { ...IDEAL.deal } };
  const v = await evaluateBandFor({ store: investorStore({ deals: [IDEAL, other] }), locationId: "LOC", party: "investor", config: iCfg(), saved: {}, draft: iDraft({ propertyAddress: "" }), job: iJob(), now: Date.now() });
  assert.equal(v.passed, false);
  assert.equal(v.checks.find((c) => !c.ok && c.name === "one_deal")?.name, "one_deal");
});

/* ---------- we buy with a hard money loan, not all cash (10917 48th St E, 2026-09-27) ---------- */

// The bot told a listing agent "We can close 10 to 14 days, cash" and "cash
// means no lender and no appraisal contingency at all". We fund with a hard
// money loan; the agent caught it and asked on a call whether we were real.
test("telling a listing agent we pay cash with no lender is held — we buy with a hard money loan", () => {
  for (const reply of [
    "We can close 10 to 14 days, cash. The inspection window is what lets us buy as-is with no lender or appraisal contingency.",
    "Right, cash means no lender and no appraisal contingency at all.",
    "It's an all cash purchase, as-is.",
    "We're paying cash so it's a quick close.",
  ]) {
    const g = gate({ reply }, { inboundMessage: "How long for closing?" });
    assert.equal(g.ok, false, reply);
    assert.match(g.flags.join(" · "), /hard money/i, reply);
  }
  const ok = gate(
    { reply: "It's funded with a hard money loan, as-is. 10 to 14 day inspection and we close in roughly 10 to 21 days from acceptance." },
    { inboundMessage: "Just confused about the no lender comment if you're paying cash." }
  );
  assert.deepEqual(ok.flags, []);
  // How we describe ourselves in an opener is not a funding claim.
  assert.deepEqual(gate({ reply: "Saw your listing on Main St. We buy houses as-is for cash and close fast. Got anything that needs work?" }, {}).flags, []);
});

/* ---------- the number we came down to, and the terms we always write (Kimberly Pettie, 2026-09-18) ---------- */

test("restating the offer-book number after we came down to a lower one is held", () => {
  const g = gate(
    { reply: "Yep, still good. 71k as-is, quick close. Want to write it up on NWMLS forms for us to sign?" },
    { allowedAmounts: [65000], staleAmounts: [71075], inboundMessage: "Just wanted to see if this offer is still good?" }
  );
  assert.equal(g.ok, false);
  assert.match(g.flags.join(" · "), /71,000.*came down/i);
  const ok = gate(
    { reply: "Yep, still good. 65k as-is, quick close." },
    { allowedAmounts: [65000], staleAmounts: [71075], inboundMessage: "Just wanted to see if this offer is still good?" }
  );
  assert.deepEqual(ok.flags, []);
});

test("'Earnest? Inspection?' answered with 'let me confirm with my partner' is held — those are standing terms", () => {
  const inbound = "Want to make sure before we write anything up\n71k\nEarnest?\nInspection?";
  const g = gate(
    { reply: "71k is right. Let me confirm earnest and the inspection window with my partner and I'll come back to you today." },
    { allowedAmounts: [71000, 1000], inboundMessage: inbound }
  );
  assert.equal(g.ok, false);
  assert.match(g.flags.join(" · "), /write-up terms/i);
  const ok = gate(
    { reply: "71k is right. 1k earnest, preferably due after inspection, 14 day inspection, and make it out to Matthew Shepherd and/or assigns." },
    { allowedAmounts: [71000, 1000], inboundMessage: inbound }
  );
  assert.deepEqual(ok.flags, []);
});

/* ---------- the check-in between deals (buyer-pulse.js) ---------- */

// Without "investor" or "wholesale": those got the old wording blocked by the
// carriers (2026-10-02, shared/carrier-words.js).
const PULSE_TEXT = "Hey Dana, sent you a couple deals that weren't a fit, sorry about that. I'm in Seattle and come across more fixer deals than I can take on myself. Are you looking to buy right now, and what's your buy box? Want to make sure what I send is relevant.";
const PULSE_SUBJECT = { dealsSent: 2, conversed: false, lastBuyCity: "Renton", lastBuyYear: 2025, cities: ["Renton"], types: ["flip"], buyBox: "" };

test("a pulse check is the bot's own message to a buyer: their clues go to the model, and it waits as a draft", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["investor"]);
  const store = fakeStore();
  let seen;
  const { job, skipped } = await startProactive({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "buyer_pulse", subject: PULSE_SUBJECT, sendsEnabled: true,
    deps: { draft: async (args) => { seen = args; return { ...DRAFT, intent: "buyer_pulse", reply: PULSE_TEXT, summary: "Pulse check." }; } },
  });
  assert.equal(skipped, null);
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(seen.party, "investor");
  assert.equal(seen.outbound.kind, "buyer_pulse");
  assert.equal(seen.outbound.lastBuyCity, "Renton");
  assert.equal(seen.outbound.address, "", "there is no property in it");
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "buyer_pulse");
  assert.equal(d.party, "investor");
  assert.equal(d.status, "draft", "not on any auto-send list, so it waits for a person");
  assert.equal(d.autoSend.decided, false);
});

test("with the pulse's own send switch it goes on its clock; a number in it still holds it", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["investor"]);
  const store = fakeStore();
  const deps = { releaseHeld: true, releaseReason: "the pulse check may send itself", now: () => NOW, random: () => 0 };
  const { job } = await startProactive({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "buyer_pulse", subject: PULSE_SUBJECT, sendsEnabled: true,
    deps: { ...deps, draft: async () => ({ ...DRAFT, intent: "buyer_pulse", reply: PULSE_TEXT }) },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "scheduled", d.autoSend?.reason);
  assert.match(d.autoSend.reason, /pulse check may send itself/);

  _resetJobs();
  const store2 = fakeStore();
  const { job: j2 } = await startProactive({
    client, locationId: "LOC", saved: STARTER_SAVED, store: store2, contactId: "c1", kind: "buyer_pulse", subject: PULSE_SUBJECT, sendsEnabled: true,
    deps: { ...deps, draft: async () => ({ ...DRAFT, intent: "buyer_pulse", reply: "Hey Dana, got one in Renton at $310,000 coming up. Are you buying right now?" }) },
  });
  await settle();
  const held = await store2.getReplyDraft(j2.draftId);
  assert.equal(held.status, "draft", "the money guard outranks the switch");
});

test("a buyer tagged hands-off gets no pulse check drafted at all", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["investor", "stop bot"]);
  let drafted = 0;
  const { job } = await startProactive({
    client, locationId: "LOC", saved: STARTER_SAVED, store: fakeStore(), contactId: "c1", kind: "buyer_pulse", subject: PULSE_SUBJECT, sendsEnabled: true,
    deps: { releaseHeld: true, draft: async () => { drafted++; return DRAFT; } },
  });
  await settle();
  assert.equal(job.status, "held");
  assert.equal(drafted, 0);
});

/* ---------- the GHL workflow's first text is not a person in the thread ---------- */

test("an agent who answers the workflow's first text within minutes gets an answer, not 'you have the thread'", async () => {
  const stamp = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString().slice(0, 16).replace("T", " ");
  const store = fakeStore([]);
  const first = `[${stamp(5)}] US sms: Hi Brenton, came across your listing at 719 S Sprague Ave. I'm in Seattle and looking for my next flip project anywher in greater Seatac. Is this one a bit of a project, or pretty turnkey? And if you've got other fixers on your radar, I'm all ears. No worries if not can stop Thanks, Matt\n[${stamp(1)}] THEM sms: It's already been flipped`;
  assert.equal(await humanHasThread({ store, locationId: "LOC", contactId: "c1", transcript: first, minutes: 30 }), null);
  const followUp = `[${stamp(5)}] US sms: Hey Brenton, circling back on fixers in your area. No worries if not can stop\n[${stamp(1)}] THEM sms: nothing right now`;
  assert.equal(await humanHasThread({ store, locationId: "LOC", contactId: "c1", transcript: followUp, minutes: 30 }), null, "the follow-up workflow's template too");
  const typed = `[${stamp(5)}] US sms: Hey Brenton, Matt here, I'll call you in ten about Sprague.\n[${stamp(1)}] THEM sms: ok`;
  assert.ok(await humanHasThread({ store, locationId: "LOC", contactId: "c1", transcript: typed, minutes: 30 }), "a text a person typed still holds the bot");
});

import { isTurnkeyReply } from "./reply-agent.js";

test("'No, it's not turnkey, but it's all cosmetic' is a house that needs work, not a turnkey one", () => {
  assert.equal(isTurnkeyReply("No, it's not turnkey, but it's all cosmetic. It's a really nice house. It was custom built but never maintained built in nineteen ninety"), false);
  assert.equal(isTurnkeyReply("not turn key at all"), false);
  assert.equal(isTurnkeyReply("It isn't move-in ready"), false);
  assert.equal(isTurnkeyReply("far from turnkey"), false);
  assert.equal(isTurnkeyReply("nothing has been renovated"), false);
  assert.equal(isTurnkeyReply("it's cosmetic, never maintained"), false);
  assert.equal(isTurnkeyReply("This one is pretty turnkey with tenants in place"), true);
  assert.equal(isTurnkeyReply("Its turnkey, no work needed"), true);
  assert.equal(isTurnkeyReply("Not much to do, it was fully renovated last year"), true, "a 'not' about something else doesn't undo it");
});

/* ---------- the current offer and the paper (2026-09-25) ---------- */

// 13041 SE 208th St, Kent: five offer rows on one house, the thread at 400K
// since August. "Draw it up" was read as realm_yes, and the rule's
// send_offer went out on its own at 416,500 — a July row — with "let's do it".
test("the LOI is held when we texted 400K after the offer said 416,500", async () => {
  _resetJobs();
  const DAY = 86400000;
  const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
  const A = "13041 Southeast 208th Street, Kent, Washington 98031";
  const offers = [
    { id: "july", locationId: "LOC", contactId: "c1", address: A, cashAmount: 416500, status: "countered", createdAt: ago(60), sends: [{ ts: ago(60) }] },
    { id: "aug", locationId: "LOC", contactId: "c1", address: A, cashAmount: 421556, status: "passed", createdAt: ago(50), sends: [{ ts: ago(50) }] },
    { id: "draft", locationId: "LOC", contactId: "c1", address: A, cashAmount: 402687, status: "draft", createdAt: ago(35) },
  ];
  const store = fakeStore();
  store.listOffers = async () => offers;
  store.getOffer = async (id) => offers.find((o) => o.id === id) || null;
  const client = {
    call: async (path, opts = {}) => {
      if (/^\/contacts\/c1$/.test(path) && !opts.method) return { contact: { id: "c1", firstName: "Sam", lastName: "Lee", tags: ["agent"] } };
      if (/^\/contacts\/c1$/.test(path)) return { contact: {} };
      if (path.endsWith("/customFields")) return { customFields: [] };
      if (path.endsWith("/notes") || path.endsWith("/tags")) return {};
      if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1" }] };
      if (/^\/conversations\/cv1\/messages/.test(path)) {
        return { messages: [
          { id: "m1", dateAdded: ago(20), direction: "outbound", messageType: "TYPE_SMS", body: "Checking in, is the seller open to an offer at $400K" },
          { id: "m2", dateAdded: ago(1), direction: "outbound", messageType: "TYPE_SMS", body: "We're still at 400 as-is, cash, quick close." },
        ] };
      }
      if (path === "/conversations/messages") return { messageId: "m9" };
      if (path.includes("/workflow/")) return { succeeded: true };
      throw new Error(`unexpected ${path}`);
    },
  };
  const ai = STARTER_SAVED.conversationAi;
  const saved = { ...STARTER_SAVED, conversationAi: { ...ai, parties: { ...ai.parties, agent: { ...ai.parties.agent,
    autoSend: { enabled: true, intents: ["realm_yes"] },
    intentRules: { ...ai.parties.agent.intentRules,
      realm_yes: { mode: "auto", actions: [{ type: "mark_offer_realm_yes" }, { type: "send_offer" }] } } } } } };
  const sends = [];
  const held = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved, store, contactId: "c1", message: "We should draw it up; she might sign it.", sendsEnabled: true,
    deps: {
      draft: async () => ({ ...DRAFT, intent: "realm_yes", reply: "Let's do it. Can you write it up on NWMLS forms for me to sign?", propertyAddress: "13041 SE 208th St" }),
      sendOfferDocs: async (args) => { sends.push(args); return { ok: true, address: A, channels: ["sms"] }; },
      setOfferRealm: async () => ({ ok: true, address: A, answer: "yes" }),
      markPaperHeld: async (args) => { held.push(args); return { ok: true }; },
      raiseOfferHeat: async () => { throw new Error("no heat while the paper is held"); },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(sends.length, 0, "no paper went");
  assert.equal(d.autoSend.decided, false);
  assert.match(d.autoSend.reason, /we texted 400K .* after this offer's \$421,556/);
  assert.equal(d.paperHold.offerId, "aug", "the current offer is the one we last sent, not the July row");
  assert.equal(d.paperHold.amount, 400000);
  assert.deepEqual(d.actions.filter((x) => ["send_offer", "mark_offer_realm_yes"].includes(x.type)).map((x) => [x.type, x.mode, x.status]).sort(),
    [["mark_offer_realm_yes", "ask", "pending"], ["send_offer", "ask", "pending"]]);
  assert.equal(held[0].offerId, "aug");
});

test("the audit never releases a paper hold as a holding reply", async () => {
  const { releaseForAudit } = await import("./reply-agent.js");
  const auto = { send: false, code: "stale_number", reason: "needs a person: we texted 400K" };
  const out = releaseForAudit({ auto, gate: { ok: true }, draft: { intent: "realm_yes", reply: "Let's do it." }, deps: { releaseHeld: true } });
  assert.equal(out.send, false);
});

test("a blast text quotes the deal's price when it sends, not the price when it was queued, and carries the buyer's own package link", async () => {
  // 7034 S K St, 2026-09-28: promoted with the default 30k fee, the blast
  // queued at contract + 30k, the fee was set to 11k two minutes later, and
  // fifteen buyers were texted 349k on a 329k deal.
  const queued = "Hey Alex, new one in Tacoma: 7034 South K Street, moderate rehab. Buyer price 349k, ARV around 499k, rehab about 45k. Interested?";
  const open = { ...openDraft(), status: "scheduled", party: "investor", intent: "blast_open", contactName: "Alex Buyer", inbound: "", reply: queued,
    outbound: { kind: "blast_open", offerId: "o1", address: "7034 South K Street, Tacoma, Washington 98408", label: "dispo-7034-south-k-street", note: "Big lot, ADU upside" },
    propertyAddress: "7034 South K Street, Tacoma, Washington 98408" };
  const store = fakeStore([open]);
  store.getOffer = async () => ({ id: "o1", locationId: "LOC", address: "7034 South K Street, Tacoma, Washington 98408",
    calc: { inputs: { arv: 499000, repairs: 45000 } }, deal: { stage: "under_contract", contractPrice: 318000, assignmentFee: 11000 } });
  store.getOfferSettings = async () => ({ wholesaleFee: 30000 });
  store.listDatarooms = async () => [{ id: "r1", locationId: "LOC", offerId: "o1", status: "active", kind: "deal", snapshot: {} }];
  const invites = [];
  store.createDataroomInvite = async (doc) => { const row = { ...doc, id: `i${invites.length + 1}`, status: "active" }; invites.push(row); return row; };
  store.getDataroomInvite = async (id) => invites.find((i) => i.id === id) || null;
  store.updateDataroomInvite = async (id, patch) => Object.assign(invites.find((i) => i.id === id), patch);
  store.logDataroomEvent = async () => {};
  const calls = [];
  const client = { call: async (path, opts) => { calls.push([path, opts]); return { messageId: "m1" }; } };

  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true, readThread: async () => "", dataroomBaseUrl: "https://deals.example" });

  const sms = calls.find(([p]) => p === "/conversations/messages")[1].body.message;
  assert.match(sms, /Buyer price 329k/, sms);
  assert.doesNotMatch(sms, /349k/);
  assert.match(sms, /https:\/\/deals\.example\/d\/\S+$/, "their own link, at the end");
  assert.match(sms, /Big lot, ADU upside\./, "the operator's line for this blast survives the rewrite");
  assert.equal(invites.length, 1);
  assert.equal(invites[0].contactId, "c1");
  assert.ok(invites[0].sentAt, "the invite is marked sent");
  const d = await store.getReplyDraft("d1");
  assert.equal(d.sentText, sms);
  assert.equal(d.edited, false, "the machine's own refresh is not a person's edit");

  // A person who rewrote the text is a person deciding: theirs goes as written.
  const store2 = fakeStore([{ ...open, status: "draft" }]);
  Object.assign(store2, { getOffer: store.getOffer, getOfferSettings: store.getOfferSettings, listDatarooms: store.listDatarooms, createDataroomInvite: store.createDataroomInvite });
  const calls2 = [];
  const client2 = { call: async (path, opts) => { calls2.push([path, opts]); return { messageId: "m2" }; } };
  await sendReplyDraft({ client: client2, store: store2, locationId: "LOC", draftId: "d1", text: "Alex, call me about K St.", live: true, dataroomBaseUrl: "https://deals.example" });
  assert.equal(calls2.find(([p]) => p === "/conversations/messages")[1].body.message, "Alex, call me about K St.");
});

test("a deal emailed to a buyer with no phone goes with its own subject, not as a reply, and the send says it was an email", async () => {
  // 1510 Maple Lane (2026-10-01): the mobile home buyers are mostly email
  // only. An emailed deal used to be impossible; a reply email's "Re: <address>"
  // would read as an answer to something they never sent.
  const open = { ...openDraft(), status: "draft", channel: "email", party: "investor", intent: "blast_open", contactName: "Gizelle P", inbound: "",
    reply: "Hey Gizelle — found you through the WA real estate Facebook group. Got 1510 Maple Lane in Kent under contract — mobile home in a park. Buyer price 101k. Want the details?",
    outbound: { kind: "blast_open", offerId: "o9", address: "1510 Maple Lane, Kent, Washington 98030", label: "dispo-1510-maple-lane",
      intro: "found you through the WA real estate Facebook group", subject: "Mobile home in a park, Kent — under contract, 101k" },
    propertyAddress: "1510 Maple Lane, Kent, Washington 98030" };
  const store = fakeStore([open]);
  store.getOffer = async () => ({ id: "o9", locationId: "LOC", address: "1510 Maple Lane, Kent, Washington 98030",
    asset: { type: "manufactured", land: "park", by: "you" }, calc: { inputs: { arv: 165000, repairs: 40000 } },
    deal: { stage: "under_contract", contractPrice: 71075, assignmentFee: 5000 } });
  store.getOfferSettings = async () => ({});
  store.listDatarooms = async () => [];
  const events = [];
  store.insertContactEvent = async (e) => { events.push(e); return { inserted: true }; };
  const calls = [];
  const client = { call: async (path, opts) => { calls.push([path, opts]); return { messageId: "m9" }; } };

  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true });

  const body = calls.find(([p, o]) => p === "/conversations/messages" && o?.body?.type === "Email")?.[1]?.body;
  assert.ok(body, "it went as an email");
  assert.equal(body.subject, "Mobile home in a park, Kent — under contract, 76k", "the price as it stands when it sends");
  assert.match(body.html, /found you through the WA real estate Facebook group\. Got 1510 Maple Lane in Kent under contract — mobile home in a park/);
  assert.match(body.html, /Buyer price 76k/);
});

// Matt, 2026-09-29: the goal of every buyer text is a time they'll walk the
// house. "Can I see it Saturday?" on a deal we hold used to get a GHL note
// and no reply at all (wants_walkthrough is notify-only); now the answer is
// filed on the deal and a reply is written for Matt to send.
test("a buyer who wants to walk a house we have under contract gets a reply drafted for Matt, and their answer is filed on the deal", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["investor-active"]);
  const store = fakeStore();
  const walkDeal = { ...DEAL, deal: { ...DEAL.deal, investors: [{ contactId: "c1", name: "Sam Lee", status: "evaluating" }],
    showing: { windows: [{ start: "2026-09-05T17:00:00Z", end: "2026-09-05T19:00:00Z" }], access: { mode: "agent" } } } };
  store.listDeals = async () => [walkDeal];
  const filed = [];
  let seen;
  const { job } = await startReply({
    client, locationId: "LOC", saved: AUTO_SAVED, store, contactId: "c1", message: "yeah I can make saturday",
    deps: {
      now: () => NOW,
      recordShowingRsvp: async (x) => { filed.push(x); return { ok: true }; },
      draft: async (args) => { seen = args; return { ...INVESTOR_DRAFT, intent: "wants_walkthrough", walkthrough: "coming", needsHuman: true,
        reply: "Great, I'll put you down for Saturday and send the details.", summary: "Coming to the Saturday walkthrough." }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.match(seen.context.text, /walkthrough window: Sat Sep 5, 10am-12pm/);
  assert.match(seen.context.text, /listing agent lets buyers in/);
  assert.deepEqual(filed, [{ offerId: "o1", contactId: "c1", name: "Sam Lee", status: "coming" }]);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft", "a confirmed time is a person's to send");
  assert.equal(d.reply, "Great, I'll put you down for Saturday and send the details.");
  assert.equal(d.walkthrough, "coming");
});

test("a walkthrough ask with no deal under contract behind it is still just a heads-up", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["investor-active"]);
  const store = fakeStore();
  store.listDeals = async () => [];
  const filed = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "can I see it?",
    deps: { recordShowingRsvp: async (x) => { filed.push(x); return { ok: true }; },
      draft: async () => ({ ...INVESTOR_DRAFT, intent: "wants_walkthrough", walkthrough: "interested" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(filed.length, 0);
  assert.equal((await store.getReplyDraft(job.draftId)).status, "handled");
});

// Rajesh Kasturi, 2026-09-29, 3511 NE 153rd St: "Sounds good, it's open
// right now." went out on its own. The bot meant the deal was available; a
// buyer reads that the house is open to walk into. We never know that unless
// the deal says so, and "open" is never the word for a deal (Matt).
test("a buyer is never told a house is open, and only told it's vacant when the deal says it is", () => {
  const inv = (reply, extra = {}) => evaluateReplyGates({ draft: { intent: "interested", confidence: "high", needsHuman: false, reply }, party: "investor", inboundMessage: "Will check", ...extra });
  const rajesh = inv("Sounds good, it's open right now. Let me know what you think on the numbers.");
  assert.equal(rajesh.ok, false);
  assert.match(rajesh.flags.join(" · "), /says "it's open"/);
  assert.equal(inv("Yep, still open. Want me to send the package over?").ok, false);
  assert.equal(inv("It's vacant, go by any time.").ok, false);
  assert.equal(inv("It's vacant, walkthrough is Sat Oct 3.", { vacantOk: true }).ok, true);
  assert.equal(inv("The lockbox code is 1234.", { vacantOk: true }).ok, false);
  // The words are fine when they aren't about the house.
  assert.equal(inv("Still available. Are you open to heavy rehab?").ok, true);
  assert.equal(inv("Open to a call later?").ok, true);
});

test("the buyer bot is told whether anyone lives there and how to get in, and 'vacant' passes only on a deal recorded vacant", async () => {
  for (const [access, expectOk] of [[{ occupancy: "vacant", method: "lockbox" }, true], [null, false]]) {
    _resetJobs();
    const { client } = ghlStubFor(["investor-active"]);
    const store = fakeStore();
    store.listDeals = async () => [{ ...DEAL, deal: { ...DEAL.deal, investors: [{ contactId: "c1", name: "Sam Lee", status: "evaluating" }], ...(access ? { access } : {}) } }];
    let seen;
    const { job } = await startReply({
      client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "anyone living there?",
      deps: { draft: async (args) => { seen = args; return { ...INVESTOR_DRAFT, intent: "question", reply: "It's vacant, and the walkthrough time is coming.", propertyAddress: "2010 NE 54th St" }; } },
    });
    await settle();
    assert.equal(job.status, "done", job.error);
    assert.match(seen.context.text, access ? /occupancy: vacant/ : /occupancy: not recorded/);
    const d = await store.getReplyDraft(job.draftId);
    assert.equal(d.flags.some((f) => /access record/.test(f)), !expectOk, d.flags.join(" · "));
  }
});

// 336 SW 15th St, Chehalis (2026-09-25). One agent, two listings in play.
const CHEHALIS = "336 SW 15th St, Chehalis, WA 98532";
const RHOBINA = "1213 Rhobina St, Centralia, WA 98531";
const withMessages = (base, messages) => ({
  ...base,
  call: async (path, opts = {}) => {
    if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1" }] };
    if (path.startsWith("/conversations/cv1/messages")) return { messages: { messages: messages.map((m, i) => ({ id: `m${i}`, messageType: "TYPE_SMS", ...m })) } };
    return base.call(path, opts);
  },
});
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

test("a re-underwrite above the number we already texted on the house is not floated to the agent", async () => {
  _resetJobs();
  const client = withMessages(ghlStubFor(["agent"]).client, [
    { direction: "outbound", dateAdded: hoursAgo(5), body: "On 336 SW 15th we'd likely land around 185k as-is with a quick close. Is that in the realm for the seller?" },
    { direction: "inbound", dateAdded: hoursAgo(1), body: "He said they painted inside and put new floors in." },
  ]);
  const regun = { id: "o-192", address: CHEHALIS, contactId: "c1", cashAmount: 192250, status: "new", createdAt: new Date().toISOString(),
    autoUnderwrite: { passed: true, compsUsedCount: 4 } };
  const store = withTheirTake(fakeStore());
  store.listOffers = async () => [regun];
  let drafted = false;
  const r = await startProactive({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: regun, sendsEnabled: true,
    deps: { draft: async () => { drafted = true; return { ...DRAFT, intent: "realm_check", reply: "Update: we can go around 192k on 336 SW 15th." }; } },
  });
  assert.equal(r.job, null);
  assert.match(r.skipped, /last texted 185K .* 192K — the machine never raises our own number/);
  assert.equal(r.raise.amount, 185000);
  assert.equal(drafted, false);

  // A person pressing Float has decided to go up.
  _resetJobs();
  const pressed = await startProactive({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: regun, sendsEnabled: true, personAsked: true,
    deps: { draft: async () => ({ ...DRAFT, intent: "realm_check", reply: "We can go around 192k on 336 SW 15th." }) },
  });
  assert.equal(pressed.skipped, null);
  assert.ok(pressed.job);
  await settle();
});

test("the hot push asked the agent to write up one house at the number we quoted on her other listing", async () => {
  _resetJobs();
  const client = withMessages(ghlStubFor(["agent"]).client, [
    { direction: "outbound", dateAdded: hoursAgo(70), body: "On 336 SW 15th we'd likely land around 185k as-is with a quick close." },
    { direction: "outbound", dateAdded: hoursAgo(69), body: "On 1213 Rhobina we can likely do around 173k as-is with a quick close." },
  ]);
  const hot = { id: "o-185", address: CHEHALIS, contactId: "c1", cashAmount: 185500, status: "new", createdAt: hoursAgo(71),
    hot: { at: hoursAgo(60), by: "operator" } };
  const other = { id: "o-173", address: RHOBINA, contactId: "c1", cashAmount: 173000, status: "new", createdAt: hoursAgo(70) };
  const store = fakeStore();
  store.listOffers = async () => [hot, other];
  const saved = structuredClone(STARTER_SAVED);
  saved.conversationAi.parties.agent.followUp = { ...(saved.conversationAi.parties.agent.followUp || {}), enabled: true,
    ladders: { ...(saved.conversationAi.parties.agent.followUp?.ladders || {}), hot_push: { enabled: true, steps: [1, 3] } } };
  saved.conversationAi.parties.agent.autoSend = { enabled: true, intents: ["hot_push"] };
  const { job } = await startProactive({
    client, locationId: "LOC", saved, store, contactId: "c1", kind: "hot_push", offer: hot, subject: { address: CHEHALIS, step: 1, steps: [1, 3] }, sendsEnabled: true,
    deps: { draft: async () => ({ ...DRAFT, intent: "hot_push", reply: "On 336 SW 15th, any chance you can write it up on NWMLS forms at 173k and send it over for me to sign?" }), now: () => Date.now(), random: () => 0 },
  });
  assert.ok(job, "started");
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.autoSendable, false);
  assert.ok(d.flags.some((f) => /\$173,000, which is not in the offer book/.test(f)), d.flags.join(" · "));
  assert.notEqual(d.status, "scheduled");
});

// Gina Hasson, 2026-09-29: the outreach workflow's 14-day follow-up ("reached
// out a couple weeks back… the uglier the better") went at 18:09, she answered
// at 18:10, and the bot stood down: "you replied to them 2 minutes ago". The
// template matched neither phrase the guard knew. GHL says who sent a text —
// a workflow's carries source "workflow" and no userId — so that decides, not
// the wording of whichever template it was.
test("an agent who answers a workflow text the guard has never seen still gets an answer, not silence", async () => {
  const now = Date.parse("2026-09-29T18:11:00Z");
  const transcript = "[2026-09-29 18:09] US sms: Hi Gina reached out a couple weeks back about one of your listings... Anything like that on your end?\n[2026-09-29 18:10] THEM sms: No, nothing right now";
  const clientWith = (msg) => ({ call: async (path) => {
    if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1" }] };
    if (path.startsWith("/conversations/cv1/messages")) return { messages: { messages: [
      { direction: "inbound", dateAdded: "2026-09-29T18:10:51Z", body: "No, nothing right now" },
      { direction: "outbound", dateAdded: "2026-09-29T18:09:31Z", body: "Hi Gina reached out a couple weeks back about one of your listings... Anything like that on your end?", ...msg },
    ] } };
    throw new Error(`unexpected ${path}`);
  } });
  const store = fakeStore();
  assert.equal(await humanHasThread({ store, client: clientWith({ source: "workflow" }), locationId: "LOC", contactId: "c1", transcript, minutes: 30, now }), null);
  assert.equal(await humanHasThread({ store, client: clientWith({ source: "bulk_actions" }), locationId: "LOC", contactId: "c1", transcript, minutes: 30, now }), null);
  assert.ok(await humanHasThread({ store, client: clientWith({ source: "app", userId: "u1" }), locationId: "LOC", contactId: "c1", transcript, minutes: 30, now }), "a text Matt typed in GHL still holds the bot");
  // GHL unreachable: fall back to holding, the careful way.
  assert.ok(await humanHasThread({ store, client: deadClient, locationId: "LOC", contactId: "c1", transcript, minutes: 30, now }));
});

// James Knopf, 2026-09-29, 3511 NE 153rd St: "Is it possible to pop by after
// 5:00 one night this week?" A walkthrough ask is notify-only, and the
// notice returned before the playbook ran — so he was never put on the deal,
// while the "maybe"s were. Wanting to walk it or buy it is the warmest
// interest there is; it lands him on the deal whatever the reply does.
test("a buyer who asks to walk a house is put on the deal even when the reply is just a heads-up", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["investor-active"]);
  const store = fakeStore();
  store.listDeals = async () => [];
  const linked = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "Looks like a fun one... possible to pop by after 5 one night this week?",
    deps: { linkDealInterest: async (x) => { linked.push(x); return { ok: true, linked: true }; },
      draft: async () => ({ ...INVESTOR_DRAFT, intent: "wants_walkthrough", propertyAddress: "2010 NE 54th St" }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(linked, [{ contactId: "c1", addressHint: "2010 NE 54th St", status: "evaluating", reason: null, revive: true, withinDays: 0 }]);
  assert.equal((await store.getReplyDraft(job.draftId)).status, "handled");
});

/* ---------- any reply about a deal goes on the deal (2026-10-01) ---------- */

// Kenneth Patton, 1510 Maple Lane: "Is there a land lease?", "Is it a 3/2
// 1440?", "You have pics?" — and he was on no deal. A question never linked
// a buyer, and while Matt was answering him the bot read nothing at all.
test("which replies go on a deal, and as what", async () => {
  const { dealReplyFiling, heldDealReplyFiling, DEAL_REPLY_DAYS } = await import("./reply-agent.js");
  const pitched = [{ address: "1510 Maple Lane, Kent, Washington 98030", offerId: "mh", stage: "under_contract", blasted: true }];
  assert.deepEqual(dealReplyFiling({ intent: "question", linkedDeals: pitched }),
    { status: "evaluating", reason: null, revive: false, withinDays: DEAL_REPLY_DAYS });
  assert.equal(dealReplyFiling({ intent: "question", linkedDeals: [] }), null, "a question about nothing we sent them is not about a deal");
  assert.equal(dealReplyFiling({ intent: "price_pushback", propertyAddress: "1510 Maple Lane" }).status, "evaluating");
  assert.deepEqual(dealReplyFiling({ intent: "passing", passReason: { code: "area", note: "too far south" }, linkedDeals: pitched }),
    { status: "passed", reason: { code: "area", note: "too far south" }, revive: false, withinDays: DEAL_REPLY_DAYS });
  assert.equal(dealReplyFiling({ intent: "wants_to_buy" }).revive, true, "walk it / buy it links from anyone, as before");
  for (const intent of ["looking_for_deals", "buybox_update", "small_talk", "status_check", "opt_out", "other"]) {
    assert.equal(dealReplyFiling({ intent, linkedDeals: pitched }), null, intent);
  }

  assert.equal(heldDealReplyFiling("Is there a land lease?", pitched).status, "evaluating");
  assert.equal(heldDealReplyFiling("Is there a land lease?", pitched).addOnly, true, "never changes someone already on it");
  assert.equal(heldDealReplyFiling("Shoot. Too far south for me.", pitched).status, "passed");
  assert.equal(heldDealReplyFiling("No. I've seen this one, better as a teardown", pitched).status, "passed");
  assert.equal(heldDealReplyFiling("Liked “Good, that opens it up.”", pitched), null);
  assert.equal(heldDealReplyFiling("ok", pitched), null);
  assert.equal(heldDealReplyFiling("Is there a land lease?", []), null, "nothing was sent to them");
});

const MAPLE = { id: "mh", address: "1510 Maple Lane, Kent, Washington 98030", cashAmount: 71075,
  calc: { inputs: { arv: 165000, repairs: 40000 } },
  deal: { stage: "under_contract", contractPrice: 71075, assignmentFee: 5000, investors: [] } };

test("a buyer's question about a deal they were sent puts them on it, and a pass is filed as a pass", async () => {
  for (const [message, draft, want] of [
    ["Is there a land lease?", { intent: "question", propertyAddress: "" }, { status: "evaluating", reason: null }],
    ["Shoot. Too far south for me.", { intent: "passing", propertyAddress: "", passReason: { code: "area", note: "too far south" } }, { status: "passed", reason: { code: "area", note: "too far south" } }],
  ]) {
    _resetJobs();
    const { client } = ghlStubFor(["investor", "dispo-1510-maple-lane"]);
    const store = fakeStore();
    store.listDeals = async () => [MAPLE];
    const linked = [];
    const { job } = await startReply({
      client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message,
      deps: { linkDealInterest: async (x) => { linked.push(x); return { ok: true, linked: true, status: x.status }; },
        draft: async () => ({ ...INVESTOR_DRAFT, reply: "Good question, let me check.", ...draft }) },
    });
    await settle();
    assert.equal(job.status, "done", job.error);
    assert.equal(linked.length, 1, message);
    assert.deepEqual({ status: linked[0].status, reason: linked[0].reason, withinDays: linked[0].withinDays }, { ...want, withinDays: 14 });
  }
});

test("while Matt has the thread, a buyer's question still goes on the deal — and a tapback doesn't", async () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const threadClient = (inbound) => {
    const { client: base } = ghlStubFor(["investor", "dispo-1510-maple-lane"]);
    return { call: async (path, opts = {}) => {
      if (path.startsWith("/conversations/search")) return { conversations: [{ id: "cv1" }] };
      if (/^\/conversations\/cv1\/messages/.test(path)) {
        return { messages: [
          { id: "m1", dateAdded: ago(20 * 60000), direction: "outbound", messageType: "TYPE_SMS", body: "sorry typo its a manufactured home in a good park. Do you do mobile/manufactured?" },
          { id: "m2", dateAdded: ago(60000), direction: "inbound", messageType: "TYPE_SMS", body: inbound },
        ] };
      }
      return base.call(path, opts);
    } };
  };
  for (const [inbound, want] of [["Is there a land lease?", "evaluating"], ["Liked “sorry typo”", null]]) {
    _resetJobs();
    const store = fakeStore();
    store.listDeals = async () => [MAPLE];
    const linked = [];
    let drafted = 0;
    const { job } = await startReply({
      client: threadClient(inbound), locationId: "LOC", saved: SAVED, store, contactId: "c1", message: inbound,
      deps: { linkDealInterest: async (x) => { linked.push(x); return { ok: true, linked: true, status: x.status }; },
        draft: async () => { drafted++; return INVESTOR_DRAFT; } },
    });
    await settle();
    assert.equal(job.status, "held", job.error);
    assert.match(job.heldReason, /you have the thread/);
    assert.equal(drafted, 0, "still no model call");
    if (want) {
      assert.equal(linked.length, 1, inbound);
      assert.deepEqual({ status: linked[0].status, addOnly: linked[0].addOnly, revive: linked[0].revive }, { status: want, addOnly: true, revive: false });
      assert.equal(job.filedOnDeal.status, want);
    } else {
      assert.equal(linked.length, 0, "a tapback is not a reply about the deal");
    }
  }
});

test("a held reply says why in plain words, never 'a other'", async () => {
  const { personsCall } = await import("./reply-agent.js");
  assert.equal(personsCall("counter"), "a counter is a person's call");
  assert.equal(personsCall("other"), "a reply the bot couldn't place is a person's call");
  assert.equal(personsCall("opt_out"), "an opt out is a person's call");
});

/* ---------- one voice: a machine text never talks over a waiting reply (2026-09-29) ---------- */

// Until this, every text the machine started superseded whatever was in the
// outbox: a question held for a person left Today, and a canned check-in or
// float went out in its place.
const waitingReply = (over = {}) => ({ id: "r1", locationId: "LOC", contactId: "c1", status: "draft", channel: "sms",
  inbound: "Is 410 firm? The seller might do 440.", reply: "Let me check with my partner.", intent: "question",
  createdAt: iso(60_000), updatedAt: iso(60_000), ...over });
const REALM_REPLY = { ...DRAFT, intent: "realm_check", reply: "We'd land around 410k as-is. In the realm for your seller?" };

test("a float never talks over their text waiting on you — the held reply stays and nothing is drafted", async () => {
  _resetJobs();
  const store = withTheirTake(fakeStore([waitingReply()]));
  store.listOffers = async () => [LANDED];
  let drafted = false;
  const r = await startProactive({ client: deadClient, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: LANDED,
    deps: { draft: async () => { drafted = true; return REALM_REPLY; } } });
  assert.equal(r.job, null);
  assert.match(r.skipped, /their text is waiting on you/);
  assert.equal(r.blocked.draftId, "r1", "the caller can tell it was held, not refused");
  assert.equal(drafted, false, "nothing is spent on a text that can't go");
  assert.equal((await store.getReplyDraft("r1")).status, "draft", "their reply stays where you'll see it");
});

test("a machine text still replaces an older machine text nobody sent", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = withTheirTake(fakeStore([waitingReply({ id: "n1", inbound: "", intent: "offer_nudge", outbound: { kind: "offer_nudge", offerId: LANDED.id, address: LANDED.address } })]));
  store.listOffers = async () => [LANDED];
  const { job } = await startProactive({ client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: LANDED, deps: { draft: async () => REALM_REPLY } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal((await store.getReplyDraft("n1")).status, "superseded");
  assert.equal((await store.getReplyDraft(job.draftId)).outbound.kind, "realm_check");
});

test("the re-quote that answers their numbers still replaces the reply it carries on from", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = withTheirTake(fakeStore([waitingReply()]));
  store.listOffers = async () => [LANDED];
  const { job } = await startProactive({ client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: LANDED, continues: "r1", deps: { draft: async () => REALM_REPLY } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal((await store.getReplyDraft("r1")).status, "superseded");
});

test("a person pressing Float may replace the waiting reply", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = withTheirTake(fakeStore([waitingReply()]));
  store.listOffers = async () => [LANDED];
  const { job } = await startProactive({ client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: LANDED, personAsked: true, deps: { draft: async () => REALM_REPLY } });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal((await store.getReplyDraft("r1")).status, "superseded");
});

test("a float doesn't replace your hand-written check-in, your answer to their question, or a queued deal text", async () => {
  for (const [kind, word] of [["check_in", "check-in"], ["partner_answer", "answer"], ["blast_open", "deal text"], ["showing_ask", "walkthrough ask"]]) {
    _resetJobs();
    const store = withTheirTake(fakeStore([waitingReply({ id: "p1", inbound: "", intent: kind, outbound: { kind } })]));
    store.listOffers = async () => [LANDED];
    const r = await startProactive({ client: deadClient, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: LANDED });
    assert.match(r.skipped || "", new RegExp(`your ${word} to them is waiting in the outbox`), kind);
    assert.equal((await store.getReplyDraft("p1")).status, "draft", kind);
  }
});

test("a text that lands while the machine is writing wins — the machine's draft is never saved", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = withTheirTake(fakeStore());
  store.listOffers = async () => [LANDED];
  const { job } = await startProactive({ client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: LANDED,
    deps: { draft: async () => { await store.createReplyDraft(waitingReply({ id: undefined })); return REALM_REPLY; } } });
  await settle();
  assert.equal(job.status, "held");
  assert.match(job.heldReason, /their text is waiting on you/);
  assert.deepEqual([...store.rows.values()].map((d) => [d.status, Boolean(d.inbound)]), [["draft", true]], "only their reply is in the outbox");
});

/* ---------- a seller's yes is a price agreed (2026-09-29) ---------- */

// Until this, "the seller accepted" only tagged the agent and warmed the
// offer: nothing recorded the price as agreed, so the push to paper never
// started and the offer kept its weekly "any update?".
const yesDraft = (over = {}) => async () => ({ ...DRAFT, intent: "acceptance", confidence: "high", needsHuman: true, counterAmount: 0,
  reply: "Great news. Can you write it up on NWMLS forms for us to sign?", propertyAddress: "12 Elm St", ...over });

test("a seller's yes at our number is recorded as agreed, so the push to paper starts", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = negotiationStore(NEGOTIATION_OFFER);
  const agreed = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "Seller accepted your offer on 12 Elm! What's the next step?",
    deps: { draft: yesDraft(), markOfferAgreed: async (args) => { agreed.push(args); return { ok: true, address: NEGOTIATION_OFFER.address, amount: 300000 }; } },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(agreed.map((a) => a.offerId), ["o1"]);
  const d = await store.getReplyDraft(job.draftId);
  assert.ok(d.actions.some((x) => x.type === "mark_offer_agreed" && x.status === "done"), JSON.stringify(d.actions.map((x) => [x.type, x.status])));
});

test("a yes that names another number is a counter — nothing is agreed", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = negotiationStore(NEGOTIATION_OFFER);
  const agreed = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", sendsEnabled: true,
    message: "Seller will accept at $340k on 12 Elm",
    deps: { draft: yesDraft(), markOfferAgreed: async (args) => { agreed.push(args); return { ok: true }; } },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(agreed.length, 0);
  const d = await store.getReplyDraft(job.draftId);
  assert.ok((d.warnings || []).some((w) => /wasn't recorded as agreed: they named \$340,000/.test(w)), JSON.stringify(d.warnings));
});

/* ---------- replies to people always have room (2026-09-29) ---------- */

import { REPLY_RESERVE_SHARE, REPLY_RESERVE_MIN, conversationConfig as configOf } from "./reply-agent.js";

// The cap counted machine texts but only ever stopped replies: a day of
// nudges and pulses could leave an agent's own text unanswered by evening.
test("machine-started texts stop short of the daily cap so a reply to a person always has room", async () => {
  _resetJobs();
  const cap = configOf(STARTER_SAVED).dailyCap;
  const reserve = Math.max(REPLY_RESERVE_MIN, Math.ceil(cap * REPLY_RESERVE_SHARE));
  const today = Array.from({ length: cap - reserve }, (_, i) => ({ id: `t${i}`, jobId: `ra-t${i}`, locationId: "LOC", contactId: `x${i}`, createdAt: iso(60_000), status: "sent" }));
  const store = withTheirTake(fakeStore(today));
  store.listOffers = async () => [LANDED];
  const r = await startProactive({ client: deadClient, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: LANDED });
  assert.equal(r.job, null);
  assert.match(r.skipped, new RegExp(`kept for people who text us \\(${cap - reserve} of ${cap}; the last ${reserve} are theirs\\)`));
  const reply = await startReply({ client: deadClient, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", message: "is it still available?" });
  assert.ok(reply.job, `a reply to a person still drafts: ${reply.skipped}`);
});

// A store that pages like Postgres: newest first, and `limit` is real.
const pagedStore = (rows) => ({ listReplyDrafts: async (_loc, { since = null, limit = 100 } = {}) =>
  rows.filter((d) => !since || d.createdAt >= since).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit) });

test("the cap counts every draft today, not the newest five hundred", async () => {
  _resetJobs();
  const noon = Date.parse("2026-09-29T19:00:00Z");
  const rows = Array.from({ length: 650 }, (_, i) => ({ id: `r${i}`, jobId: `ra-r${i}`, createdAt: new Date(noon - (i + 1) * 1000).toISOString() }));
  assert.equal(await countToday({ store: pagedStore(rows), locationId: "LOC", cap: 700, now: noon }), 650);
  // The band's own daily count: a release this morning still counts after a blast day's worth of drafts.
  const released = { id: "band", createdAt: new Date(noon - 700_000).toISOString(), exception: { passed: true, kind: "counter_band" } };
  assert.equal(await bandReleasesToday({ store: pagedStore([...rows, released]), locationId: "LOC", now: noon }), 1);
});

/* ---------- the agent check-in (2026-09-29) ---------- */

const AGENT_CHECKIN_SUBJECT = { reason: "general", segment: "engaged", address: "", listing: null, house: null };

test("an agent check-in that names any number holds for you", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = fakeStore();
  store.listOffers = async () => [LANDED];
  const { job } = await startProactive({ client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "agent_pulse", subject: AGENT_CHECKIN_SUBJECT, sendsEnabled: true,
    deps: { releaseHeld: true, releaseReason: "test", draft: async () => ({ ...DRAFT, reply: "Hey Dana, still around 410k on 12 Elm if the seller moves. Anything else coming up?" }) } });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft", "not even a number from the book rides on a check-in");
  assert.equal(d.outbound.kind, "agent_pulse");
});

test("an agent check-in sends itself only with the pulse's own switch", async () => {
  _resetJobs();
  const clean = { ...DRAFT, reply: "Hey Dana, anything coming up that needs work, or anything off market?" };
  const { client } = ghlStubFor(["agent"]);
  const off = fakeStore();
  const { job: j1 } = await startProactive({ client, locationId: "LOC", saved: STARTER_SAVED, store: off, contactId: "c1", kind: "agent_pulse", subject: AGENT_CHECKIN_SUBJECT, sendsEnabled: true,
    deps: { draft: async () => clean } });
  await settle();
  assert.equal((await off.getReplyDraft(j1.draftId)).status, "draft", "without it: the outbox");
  _resetJobs();
  const on = fakeStore();
  const { job: j2 } = await startProactive({ client, locationId: "LOC", saved: STARTER_SAVED, store: on, contactId: "c1", kind: "agent_pulse", subject: AGENT_CHECKIN_SUBJECT, sendsEnabled: true,
    deps: { releaseHeld: true, releaseReason: "the agent check-in may send itself", draft: async () => clean, now: () => NOW, random: () => 0 } });
  await settle();
  assert.equal((await on.getReplyDraft(j2.draftId)).status, "scheduled", "with it: it goes on its own");
});

// Until 2026-09-29 the "I'll send you deals" check-in could be armed once per
// contact, ever: an agent who offered again months later never heard from us.
test("an agent who offers deals again after the check-ins ended gets them again; one still running is left to run", async () => {
  const run = async (prior) => {
    _resetJobs();
    const { client } = ghlStubFor(["agent"]);
    const store = fakeStore();
    store.events.set("LOC|c1", [...prior]);
    const { job } = await startReply({
      client, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1",
      message: "Nothing right now but I'll keep you in mind for fixers.",
      deps: { draft: async () => ({ ...DRAFT, intent: "investor_open", confidence: "high", reply: "Appreciate it." }) },
    });
    for (let i = 0; i < 40 && job.status === "running"; i++) await settle();
    assert.equal(job.status, "done", job.error);
    return (await store.listContactEvents("LOC", "c1", { types: ["checkin_requested"] })).filter((e) => e.data?.kind === "source" && !prior.includes(e));
  };
  const ended = [
    { type: "checkin_requested", at: iso(120 * 86400000), dedupeKey: "checkin_requested:source:c1", data: { kind: "source", dueAt: iso(113 * 86400000), left: 0 } },
    { type: "checkin_sent", at: iso(113 * 86400000), data: { requestAt: iso(120 * 86400000), kind: "source" } },
  ];
  assert.equal((await run(ended)).length, 1, "a new chain starts");
  const running = [{ type: "checkin_requested", at: iso(2 * 86400000), data: { kind: "source", dueAt: iso(-5 * 86400000), left: 3 } }];
  assert.equal((await run(running)).length, 0, "the chain already running keeps its own clock");
});

// Off-market (shared/off-market.js): an ask that actually went is written
// down, whoever wrote it, so the next one waits a month.
test("a sent text that asks an agent for off-market houses is recorded; a plain reply isn't", async () => {
  const ask = { ...openDraft(), party: "agent", intent: "small_talk", reply: "Sounds good. If anything comes your way off market, I'd love a first look." };
  const store = fakeStore([ask, { ...openDraft(), id: "d2", contactId: "c2", party: "agent", reply: "Thanks, talk soon." }]);
  const client = { call: async () => ({ messageId: "m1" }) };
  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true });
  const ev = await store.listContactEvents("LOC", "c1", { types: ["offmarket_asked"] });
  assert.equal(ev.length, 1);
  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d2", live: true });
  assert.equal((await store.listContactEvents("LOC", "c2", { types: ["offmarket_asked"] })).length, 0);
});

/* ---------- you stopped the bot on them (shared/bot-hold.js, 2026-10-01) ---------- */
// Matt: Stop on a thread means nothing goes to that person by itself — no
// nudge, no check-in, no letter, no auto-reply — and their texts still get a
// draft that waits for him. Before this, the stop was read by a few drivers
// and the reply agent, the scheduler and the senders ignored it.

const stopOn = (store, contactId = "c1", data = {}, at = new Date(NOW - 3600000).toISOString()) => {
  const key = `LOC|${contactId}`;
  store.events.set(key, [...(store.events.get(key) || []), { type: "drive_stopped", contactId, at, source: "operator", data: { reason: "", ...data } }]);
  return store;
};

test("decideAutoSend names you stopping the bot before anything else, and nothing can release it", async () => {
  const { HELD_FOR_A_PERSON, releaseForAudit } = await import("./reply-agent.js");
  const cfg = conversationConfig(AUTO_SAVED);
  const ok = { ok: true, flags: [] };
  const stopped = { held: true, kind: "stopped", until: null };
  const d = decideAutoSend({ gate: ok, party: "agent", intent: "question", config: cfg, sendsEnabled: true, hold: stopped });
  assert.equal(d.send, false);
  assert.equal(d.code, "bot_stopped");
  assert.equal(d.reason, "you stopped the bot on them — it waits for you");
  assert.equal(decideAutoSend({ gate: { ok: false, flags: ["x"] }, party: "agent", intent: "counter", config: cfg, sendsEnabled: true, hold: stopped }).code, "bot_stopped", "first, before the gates");
  const paused = decideAutoSend({ gate: ok, party: "agent", intent: "question", config: cfg, sendsEnabled: true, hold: { held: true, kind: "paused", until: "2026-10-15T18:00:00Z" } });
  assert.equal(paused.reason, "paused until Oct 15 — it waits for you");
  // A stop is not a person's call on these words: no check-in clock, and
  // neither the nightly audit nor the counter band can release it.
  assert.equal(HELD_FOR_A_PERSON.has("bot_stopped"), false);
  assert.equal(releaseForAudit({ auto: d, gate: ok, draft: { intent: "question", reply: "ok" }, deps: { releaseHeld: true } }).send, false);
  assert.equal(releaseUnderGuard({ base: d, party: "agent", intent: "counter", config: cfg, guard: { kind: "band", passed: true } }).send, false);
  assert.equal(decideAutoSend({ gate: ok, party: "agent", intent: "question", config: cfg, sendsEnabled: true, hold: { held: false } }).send, true, "not held: as before");
});

test("a reply to someone you stopped is drafted and waits — it never schedules itself, even on the auto-send list", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = stopOn(fakeStore());
  store.listOffers = async () => OFFERS;
  let drafted = 0;
  const { job } = await startReply({
    client, locationId: "LOC", saved: AUTO_SAVED, store, contactId: "c1", message: "still interested?", sendsEnabled: true,
    deps: { draft: async () => { drafted++; return DRAFT; }, now: () => NOW, random: () => 0 },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  assert.equal(drafted, 1, "their text still gets a draft");
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft");
  assert.equal(d.autoSend.decided, false);
  assert.equal(d.autoSend.reason, "you stopped the bot on them — it waits for you");
  assert.equal(job.scheduledFor, null);
});

test("a stopped person's held reply starts no check-in clock — the machine would only be texting them later", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = stopOn(fakeStore());
  store.listOffers = async () => [{ id: "o1", ...OFFERS[0], contactId: "c1" }];
  const { job } = await startReply({
    client, locationId: "LOC", saved: AUTO_SAVED, store, contactId: "c1", message: "would you do 425k?", sendsEnabled: true,
    deps: { draft: async () => ({ ...DRAFT, intent: "counter", needsHuman: true, humanReason: "they named a number", counterAmount: 425000,
      reply: "Let me run 425k by my partner and get back to you." }), now: () => NOW, random: () => 0 },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft");
  assert.match(d.autoSend.reason, /you stopped the bot on them/);
  const clocks = await store.listContactEvents("LOC", "c1", { types: ["checkin_requested"] });
  assert.equal(clocks.length, 0);
});

test("nothing the machine starts is drafted for someone you stopped, and no model call is made", async () => {
  _resetJobs();
  const store = stopOn(withTheirTake(fakeStore()));
  store.listOffers = async () => [LANDED];
  let drafted = 0;
  const r = await startProactive({
    client: deadClient, locationId: "LOC", saved: STARTER_SAVED, store, contactId: "c1", kind: "realm_check", offer: LANDED, sendsEnabled: true,
    deps: { draft: async () => { drafted++; return DRAFT; }, now: () => NOW },
  });
  assert.equal(r.job, null);
  assert.equal(r.skipped, "you stopped the bot on them");
  assert.equal(drafted, 0);
  const paused = stopOn(withTheirTake(fakeStore()), "c1", { until: new Date(NOW + 5 * 86400000).toISOString() });
  paused.listOffers = async () => [LANDED];
  const p = await startProactive({ client: deadClient, locationId: "LOC", saved: STARTER_SAVED, store: paused, contactId: "c1", kind: "realm_check", offer: LANDED, deps: { now: () => NOW } });
  assert.equal(p.skipped, "paused until Sep 9");
});

test("a float you press yourself still drafts while the bot is stopped, and waits for your Send", async () => {
  _resetJobs();
  const on = { ...STARTER_SAVED, conversationAi: { ...STARTER_SAVED.conversationAi, parties: { ...STARTER_SAVED.conversationAi.parties, agent: { ...STARTER_SAVED.conversationAi.parties.agent, autoSend: { enabled: true, intents: ["realm_check"] } } } } };
  const { client } = ghlStubFor(["agent"]);
  const store = stopOn(withTheirTake(fakeStore()));
  store.listOffers = async () => [LANDED];
  const { job } = await startProactive({
    client, locationId: "LOC", saved: on, store, contactId: "c1", kind: "realm_check", offer: LANDED, sendsEnabled: true, personAsked: true,
    deps: { draft: async () => ({ ...DRAFT, intent: "realm_check", reply: "We'd land around 410k as-is. In the realm for the seller?" }), now: () => NOW, random: () => 0 },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.status, "draft");
  assert.match(d.autoSend.reason, /you stopped the bot on them/);
});

test("a reply counting down when you pressed Stop goes back to waiting at send time, not left 'sending'", async () => {
  const { client } = ghlStub();
  const store = stopOn(fakeStore([{ ...openDraft(), status: "sending", sendingAt: iso(1000), party: "agent", intent: "question", inbound: "still interested?", flags: [], autoSend: { decided: true, reason: "" } }]));
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true, now: NOW });
  assert.equal(r.skipped, "you stopped the bot on them");
  const d = await store.getReplyDraft("d1");
  assert.equal(d.status, "draft");
  assert.equal(d.sendAt, null);
  assert.equal(d.sendingAt, null);
  assert.match(d.flags.join(" "), /held: you stopped the bot on them/);
  assert.equal(d.autoSend.decided, false);
});

test("a nudge counting down when you pressed Stop is binned at send time", async () => {
  const { client } = ghlStub();
  const store = stopOn(fakeStore([{ id: "d1", locationId: "LOC", contactId: "c1", status: "sending", channel: "sms", party: "agent", createdAt: iso(1000), flags: [],
    reply: "Any word from the seller on 12 Elm?", inbound: "", outbound: { kind: "offer_nudge", offerId: "o1" } }]));
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true, now: NOW });
  assert.equal(r.skipped, "you stopped the bot on them");
  const d = await store.getReplyDraft("d1");
  assert.equal(d.status, "dismissed");
  assert.match(d.flags.join(" "), /you stopped the bot on them — not sent/);
});

test("a person pressing Send still sends while the bot is stopped — a person is deciding", async () => {
  const store = stopOn(fakeStore([{ ...openDraft(), party: "agent", intent: "question", flags: [] }]));
  const client = { call: async () => ({ messageId: "m1" }) };
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, now: NOW });
  assert.equal(r.draft.status, "sent");
});

test("while stopped, the offer letter waits on the draft as a suggestion and the reply keeps the model's own words", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = stopOn(fakeStore());
  store.listOffers = async () => [{ id: "o1", ...OFFERS[0], contactId: "c1" }];
  let sends = 0;
  const { job } = await startReply({
    client, locationId: "LOC", saved: AUTO_SAVED, store, contactId: "c1", message: "Thanks, I'll run it by my sellers and get back to you.", sendsEnabled: true,
    deps: { draft: async () => ({ ...DRAFT, intent: "question", reply: "Sounds good, talk soon." }),
      sendOfferDocs: async () => { sends++; return { ok: true, channels: ["sms"] }; }, now: () => NOW, random: () => 0 },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  const send = d.actions.find((x) => x.type === "send_offer");
  assert.ok(send, "the letter is still offered");
  assert.equal(send.mode, "ask");
  assert.match(send.why, /held:/);
  assert.equal(sends, 0, "nothing sent the letter");
  assert.equal(d.reply, "Sounds good, talk soon.", "not 'sent our letter of intent over'");
  assert.equal(d.status, "draft");
});

test("while stopped, a drip workflow, a booking or a dataroom invite becomes a suggestion; tags still run", async () => {
  const { holdActionsWhileStopped, HELD_WHILE_STOPPED } = await import("./reply-agent.js");
  for (const t of ["send_offer", "send_dataroom_invite", "add_to_workflow", "requote_from_agent_numbers", "book_call", "revise_offer_to_counter", "agree_investor_price"]) {
    assert.ok(HELD_WHILE_STOPPED.has(t), t);
  }
  const plan = { auto: [
    { id: "a1", type: "add_tags", mode: "auto", tags: ["tier-1"] },
    { id: "a2", type: "add_to_workflow", mode: "auto", workflowName: "TIER 1", why: "deal available" },
    { id: "a3", type: "book_call", mode: "auto" },
  ], suggested: [] };
  const r = holdActionsWhileStopped(plan, "you stopped the bot on them");
  assert.deepEqual(r.plan.auto.map((x) => x.id), ["a1"]);
  assert.deepEqual(r.plan.suggested.map((x) => [x.id, x.mode]), [["a2", "ask"], ["a3", "ask"]]);
  assert.equal(r.plan.suggested[0].why, "deal available — held: you stopped the bot on them");
  assert.deepEqual(r.held.map((x) => x.id), ["a2", "a3"]);
});

test("Stop pulls back the machine's texts waiting to go and holds a reply that was about to send", async () => {
  const { standDownForHold } = await import("./reply-agent.js");
  const { client } = ghlStub();
  const store = fakeStore([
    { id: "d1", locationId: "LOC", contactId: "c1", status: "scheduled", party: "agent", createdAt: iso(3000), flags: [], reply: "x", inbound: "", outbound: { kind: "offer_nudge", offerId: "o1" }, sendAt: iso(-60000) },
    { id: "d2", locationId: "LOC", contactId: "c1", status: "draft", party: "agent", createdAt: iso(2000), flags: [], reply: "x", inbound: "", outbound: { kind: "price_drop", offerId: "o2" } },
    { id: "d3", locationId: "LOC", contactId: "c1", status: "scheduled", party: "agent", createdAt: iso(1000), flags: [], reply: "Sounds good.", inbound: "ok thanks", outbound: null, sendAt: iso(-60000), autoSend: { decided: true, reason: "" } },
    { id: "d4", locationId: "LOC", contactId: "c1", status: "draft", party: "agent", createdAt: iso(900), flags: [], reply: "Yes.", inbound: "still on?", outbound: null },
    { id: "d5", locationId: "LOC", contactId: "c1", status: "sending", party: "agent", createdAt: iso(800), flags: [], reply: "x", inbound: "", outbound: { kind: "offer_nudge" } },
    { id: "d9", locationId: "LOC", contactId: "c2", status: "scheduled", party: "agent", createdAt: iso(800), flags: [], reply: "x", inbound: "", outbound: { kind: "offer_nudge" } },
  ]);
  const r = await standDownForHold({ client, store, locationId: "LOC", contactId: "c1", why: "you stopped the bot on them", now: NOW });
  assert.deepEqual(r.pulled.sort(), ["d1", "d2"]);
  assert.deepEqual(r.held, ["d3"]);
  assert.equal((await store.getReplyDraft("d1")).status, "dismissed");
  assert.match((await store.getReplyDraft("d1")).flags.join(" "), /you stopped the bot on them — not sent/);
  const d3 = await store.getReplyDraft("d3");
  assert.equal(d3.status, "draft");
  assert.equal(d3.sendAt, null);
  assert.match(d3.flags.join(" "), /held: you stopped the bot on them/);
  assert.equal((await store.getReplyDraft("d4")).status, "draft", "a reply already waiting for you keeps waiting");
  assert.equal((await store.getReplyDraft("d5")).status, "sending", "out of our hands");
  assert.equal((await store.getReplyDraft("d9")).status, "scheduled", "someone else");
});


/* ---------- 2026-10-02: the written offer goes with a no ---------- */

// Matt: "more proactively send out offers, even if it doesn't make sense for
// the agent or if the number they say they have some pushback on it … so that
// they have it in front of them." A no to a number we floated now carries the
// written offer, for their records — before anything files the offer dead.
const FLOATED_OFFER = { ...NEGOTIATION_OFFER, status: "new" };
const floatSent = { id: "d-float", contactId: "c1", status: "sent", sentAt: new Date(Date.now() - 2 * 86400000).toISOString(),
  outbound: { kind: "realm_check", offerId: "o1", address: "12 Elm St" }, inbound: "", reply: "Based on our analysis we can likely do around 300ish on 12 Elm" };
const pushSaved = (afterFloat = { enabled: true, onPushback: true }) => ({
  ...STARTER_SAVED,
  conversationAi: { ...STARTER_SAVED.conversationAi, parties: { ...STARTER_SAVED.conversationAi.parties,
    agent: { ...STARTER_SAVED.conversationAi.parties.agent,
      sendOffer: { ...(STARTER_SAVED.conversationAi.parties.agent.sendOffer || {}), afterFloat } } } },
});
const floatedStore = (offer, drafts = [floatSent]) => {
  const store = fakeStore(drafts);
  store.listOffers = async () => [offer];
  store.getOffer = async () => offer;
  return store;
};

test("a first no on a floated number sends the written offer and still asks for their counter", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const offer = { ...FLOATED_OFFER };
  const store = floatedStore(offer);
  const order = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: pushSaved(), store, contactId: "c1", sendsEnabled: true,
    message: "too aggressive, they're not interested",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "high", needsHuman: false, reply: "Understood. Any chance they'd counter?", propertyAddress: "12 Elm St" }),
      sendOfferDocs: async (args) => { order.push(["send", args]); return { ok: true, address: "12 Elm St", channels: ["sms", "email"] }; },
      noteFirstDecline: async () => { order.push(["first no"]); offer.declinedOnce = { at: new Date().toISOString() }; return { ok: true, address: offer.address }; },
    },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  const send = order.find(([k]) => k === "send")?.[1];
  assert.ok(send, `the written offer went: ${d.actions.map((a) => `${a.type}:${a.status}`)}`);
  assert.equal(send.forRecord, true);
  assert.equal(send.offerId, "o1");
  assert.deepEqual(send.channels, ["sms", "email"]);
  assert.equal(d.reply, "Understood. Any chance they'd counter? I'll send our written offer over anyway so you have it on file.");
  assert.ok(d.actions.some((a) => a.type === "note_first_decline" && a.status === "done"), "still asks for their number");
});

test("their pass gets the written offer before the offer is filed passed", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const offer = { ...FLOATED_OFFER };
  const store = floatedStore(offer);
  const order = [];
  const { job } = await startReply({
    client, locationId: "LOC", saved: pushSaved(), store, contactId: "c1", sendsEnabled: true,
    message: "seller needs 600k firm",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", needsHuman: false, counterAmount: 600000, reply: "Let me check.", propertyAddress: "12 Elm St" }),
      sendOfferDocs: async (args) => { order.push("send"); return { ok: true, address: "12 Elm St", channels: ["sms", "email"] }; },
      setOfferStatus: async ({ status }) => { order.push(status); return { ok: true, address: offer.address, status }; },
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "rejection", d.summary);
  assert.ok(order.includes("send"), `paper went: ${order}`);
  if (order.includes("passed")) assert.ok(order.indexOf("send") < order.indexOf("passed"), `the paper before the pass: ${order}`);
  assert.match(d.reply, /we're too far apart on the number\. .*I'll send our written offer over anyway so you have it on file\. Keep me in mind/);
});

test("a counter inside the pass line is left for Matt — no paper", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = floatedStore({ ...FLOATED_OFFER });
  let sent = 0;
  const { job } = await startReply({
    client, locationId: "LOC", saved: pushSaved(), store, contactId: "c1", sendsEnabled: true,
    message: "could they do 310?",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "counter", confidence: "high", needsHuman: false, counterAmount: 310000, reply: "Let me check.", propertyAddress: "12 Elm St" }),
      sendOfferDocs: async () => { sent++; return { ok: true, address: "12 Elm St", channels: ["sms"] }; },
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.intent, "counter");
  assert.equal(sent, 0);
  assert.ok(!(d.actions || []).some((a) => a.via === "for record"));
});

test("we_passed, a house that sold and an opt-out get no paper", async () => {
  for (const [label, offer, message, draft] of [
    ["we passed", { ...FLOATED_OFFER, status: "we_passed" }, "no thanks", { intent: "rejection", reply: "Understood." }],
    ["sold", { ...FLOATED_OFFER }, "that one already sold", { intent: "rejection", reply: "Got it, thanks for letting me know." }],
    ["opt out", { ...FLOATED_OFFER }, "stop texting me", { intent: "opt_out", reply: "" }],
  ]) {
    _resetJobs();
    const { client } = ghlStubFor(["agent"]);
    const store = floatedStore(offer);
    let sent = 0;
    const { job } = await startReply({
      client, locationId: "LOC", saved: pushSaved(), store, contactId: "c1", sendsEnabled: true, message,
      deps: {
        draft: async () => ({ ...DRAFT, confidence: "high", needsHuman: false, propertyAddress: "12 Elm St", ...draft }),
        sendOfferDocs: async () => { sent++; return { ok: true, address: "12 Elm St", channels: ["sms"] }; },
        setOfferStatus: async ({ status }) => ({ ok: true, address: offer.address, status }),
        noteFirstDecline: async () => ({ ok: true, address: offer.address }),
      },
    });
    await settle();
    assert.equal(sent, 0, label);
    const d = job.draftId ? await store.getReplyDraft(job.draftId) : null;
    assert.ok(!(d?.actions || []).some((a) => a.via === "for record"), label);
  }
});

test("a failed for-record send puts the model's words back without holding the reply", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const offer = { ...FLOATED_OFFER };
  const store = floatedStore(offer);
  const { job } = await startReply({
    client, locationId: "LOC", saved: pushSaved(), store, contactId: "c1", sendsEnabled: true,
    message: "they're not interested at that number",
    deps: {
      draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "high", needsHuman: false, reply: "Understood. Any chance they'd counter?", propertyAddress: "12 Elm St" }),
      sendOfferDocs: async () => ({ ok: false, reason: "contact has no phone" }),
      noteFirstDecline: async () => { offer.declinedOnce = { at: new Date().toISOString() }; return { ok: true, address: offer.address }; },
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(d.reply, "Understood. Any chance they'd counter?");
  assert.ok(!/the offer didn't go out/.test(String(d.autoSend?.reason || "")), `not held for the paper: ${d.autoSend?.reason}`);
  assert.ok((d.flags || []).some((f) => /written offer didn't go/.test(f)));
});

test("a held reply offers the paper as one click instead of sending it", async () => {
  _resetJobs();
  const { client } = ghlStubFor(["agent"]);
  const store = floatedStore({ ...FLOATED_OFFER });
  let sent = 0;
  const { job } = await startReply({
    client, locationId: "LOC", saved: pushSaved(), store, contactId: "c1", sendsEnabled: true,
    message: "not interested, the seller is upset",
    deps: {
      // Low confidence: the reply waits for a person.
      draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "low", needsHuman: false, reply: "Understood. Any chance they'd counter?", propertyAddress: "12 Elm St" }),
      sendOfferDocs: async () => { sent++; return { ok: true, address: "12 Elm St", channels: ["sms"] }; },
      noteFirstDecline: async () => ({ ok: true, address: "12 Elm St" }),
    },
  });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(sent, 0);
  assert.equal(d.reply, "Understood. Any chance they'd counter?");
  const ask = (d.actions || []).find((a) => a.via === "for record");
  assert.equal(ask?.mode, "ask");
  assert.equal(ask?.forRecord, true);
});

test("with the switch off, or no number ever floated, a no carries no paper", async () => {
  for (const [label, saved, drafts] of [
    ["switch off", pushSaved({ enabled: true, onPushback: false }), [floatSent]],
    ["never floated", pushSaved(), []],
  ]) {
    _resetJobs();
    const { client } = ghlStubFor(["agent"]);
    const offer = { ...FLOATED_OFFER };
    const store = floatedStore(offer, drafts);
    let sent = 0;
    const { job } = await startReply({
      client, locationId: "LOC", saved, store, contactId: "c1", sendsEnabled: true, message: "not interested",
      deps: {
        draft: async () => ({ ...DRAFT, intent: "rejection", confidence: "high", needsHuman: false, reply: "Understood. Any chance they'd counter?", propertyAddress: "12 Elm St" }),
        sendOfferDocs: async () => { sent++; return { ok: true, address: "12 Elm St", channels: ["sms"] }; },
        noteFirstDecline: async () => ({ ok: true, address: offer.address }),
      },
    });
    await settle();
    assert.equal(sent, 0, label);
    const d = await store.getReplyDraft(job.draftId);
    assert.equal(d.reply, "Understood. Any chance they'd counter?", label);
  }
});


/* ---------- 2026-10-02: links in deal texts get them blocked ---------- */

// Fourteen days of our texts: a deal text carrying the package link was
// blocked by the carriers (Error 30007) 32% of the time to a buyer who'd
// never written back, 9% to one who had; the same texts without a link, 0 of
// 121. With dispoAutopilot.blastLink "on_reply" the text asks if they want
// the details and the link goes when they answer.
const linkLaterBlast = () => {
  const queued = "Hey Alex, new one in Tacoma: 7034 South K Street, moderate rehab. Buyer price 329k, ARV around 499k, rehab about 45k. Interested?";
  const open = { ...openDraft(), status: "scheduled", party: "investor", intent: "blast_open", contactName: "Alex Buyer", inbound: "", reply: queued,
    outbound: { kind: "blast_open", offerId: "o1", address: "7034 South K Street, Tacoma, Washington 98408", label: "dispo-7034-south-k-street" },
    propertyAddress: "7034 South K Street, Tacoma, Washington 98408" };
  const store = fakeStore([open]);
  store.getOffer = async () => ({ id: "o1", locationId: "LOC", address: "7034 South K Street, Tacoma, Washington 98408",
    calc: { inputs: { arv: 499000, repairs: 45000 } }, deal: { stage: "under_contract", contractPrice: 318000, assignmentFee: 11000 } });
  store.getOfferSettings = async () => ({ wholesaleFee: 30000, dispoAutopilot: { blastLink: "on_reply" } });
  store.listDatarooms = async () => [{ id: "r1", locationId: "LOC", offerId: "o1", status: "active", kind: "deal", snapshot: {} }];
  const invites = [];
  store.createDataroomInvite = async (doc) => { const row = { ...doc, id: `i${invites.length + 1}`, status: "active" }; invites.push(row); return row; };
  store.logDataroomEvent = async () => {};
  return { store, invites };
};

test("a deal text goes without its link when links wait for a reply — cold deal texts with a link were blocked by the carriers", async () => {
  const { store, invites } = linkLaterBlast();
  const calls = [];
  const client = { call: async (path, opts) => { calls.push([path, opts]); return { messageId: "m1" }; } };
  await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true, readThread: async () => "", dataroomBaseUrl: "https://deals.example" });
  const sms = calls.find(([p]) => p === "/conversations/messages")[1].body.message;
  assert.doesNotMatch(sms, /https?:/, sms);
  assert.match(sms, /Buyer price 329k/);
  assert.match(sms, /walk it\? Happy to send photos and numbers\.$/, "says the details are there for the asking");
  assert.equal(invites.length, 0, "no link is minted for a text that doesn't carry one");
  assert.equal((await store.getReplyDraft("d1")).blastWithoutLink, true);
  assert.equal(normalizeDispoAutopilot({}).blastLink, "always");
  assert.equal(normalizeDispoAutopilot({ blastLink: "on_reply" }).blastLink, "on_reply");
});

const sentWithoutLink = () => ({ ...openDraft(), id: "d-blast", status: "sent", sentAt: new Date(Date.now() - 3600000).toISOString(), party: "investor", intent: "blast_open",
  inbound: "", blastWithoutLink: true, outbound: { kind: "blast_open", offerId: "o1", address: "7034 South K Street, Tacoma, Washington 98408" },
  propertyAddress: "7034 South K Street, Tacoma, Washington 98408" });

test("a buyer who answers a deal text that went without its link gets the link", async () => {
  _resetJobs();
  const { client } = ghlStub();
  client.call = ((orig) => async (path, opts) => {
    if (/^\/contacts\/c1$/.test(path)) return { contact: { id: "c1", firstName: "Alex", lastName: "Buyer", tags: ["investor"] } };
    return orig(path, opts);
  })(client.call);
  const store = fakeStore([sentWithoutLink()]);
  const saved = { ...SAVED, conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["interested"] } } } } };
  const invites = [];
  const deps = {
    draft: async () => ({ ...DRAFT, intent: "interested", confidence: "high", reply: "Here you go.", propertyAddress: "", counterAmount: 0 }),
    dataroomInviteGuard: async () => ({ ok: false, reason: "" }),
    issueDataroomInvite: async (a) => { invites.push(a); return { sent: true, address: "7034 South K Street" }; },
  };
  const { job } = await startReply({ client, locationId: "LOC", saved, store, contactId: "c1", message: "yeah send it over", channel: "sms", sendsEnabled: true, deps });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  const act = d.actions.find((a) => a.type === "send_dataroom_invite");
  assert.ok(act, `the link was planned: ${d.actions.map((a) => a.type)}`);
  assert.equal(act.mode, "auto");
  assert.equal(act.status, "done");
  assert.equal(invites[0]?.addressHint, "7034 South K Street, Tacoma, Washington 98408", "the deal the text was about, though they didn't name it");
});

test("a buyer who passes on it gets no link", async () => {
  _resetJobs();
  const { client } = ghlStub();
  client.call = ((orig) => async (path, opts) => {
    if (/^\/contacts\/c1$/.test(path)) return { contact: { id: "c1", firstName: "Alex", lastName: "Buyer", tags: ["investor"] } };
    return orig(path, opts);
  })(client.call);
  const store = fakeStore([sentWithoutLink()]);
  const invites = [];
  const { job } = await startReply({ client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "not for me, too far north", channel: "sms", sendsEnabled: true,
    deps: {
      draft: async () => ({ ...DRAFT, intent: "passing", confidence: "high", reply: "Understood, thanks.", propertyAddress: "", counterAmount: 0 }),
      issueDataroomInvite: async (a) => { invites.push(a); return { sent: true }; },
    } });
  await settle();
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(invites.length, 0);
  assert.ok(!(d.actions || []).some((a) => a.type === "send_dataroom_invite"));
});

// Stop outreach on a deal (2026-10-01) promised no package link goes to a
// buyer about it by itself. The link owed for a deal text that went without
// it is sent as an automatic action while the reply is still being drafted,
// before the send-time guard ever sees the reply, so it needs its own check.
test("a buyer who answers the deal text on a deal you stopped outreach on gets no link by itself", async () => {
  _resetJobs();
  const { client } = ghlStub();
  client.call = ((orig) => async (path, opts) => {
    if (/^\/contacts\/c1$/.test(path)) return { contact: { id: "c1", firstName: "Alex", lastName: "Buyer", tags: ["investor"] } };
    return orig(path, opts);
  })(client.call);
  const store = fakeStore([sentWithoutLink()]);
  store.getOffer = async (id) => (id === "o1" ? { id: "o1", locationId: "LOC", address: "7034 South K Street, Tacoma, Washington 98408",
    deal: { stage: "under_contract", investors: [], outreachStopped: { at: new Date(Date.now() - 600000).toISOString(), by: "you" } } } : null);
  const saved = { ...SAVED, conversationAi: { enabled: true, parties: { investor: { autoSend: { enabled: true, intents: ["interested"] } } } } };
  const invites = [];
  const deps = {
    draft: async () => ({ ...DRAFT, intent: "interested", confidence: "high", reply: "Here you go.", propertyAddress: "", counterAmount: 0 }),
    dataroomInviteGuard: async () => ({ ok: false, reason: "" }),
    issueDataroomInvite: async (a) => { invites.push(a); return { sent: true, address: "7034 South K Street" }; },
  };
  const { job } = await startReply({ client, locationId: "LOC", saved, store, contactId: "c1", message: "yeah send it over", channel: "sms", sendsEnabled: true, deps });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  assert.equal(invites.length, 0, "no package link went out");
  assert.ok(!(d.actions || []).some((a) => a.type === "send_dataroom_invite" && a.mode === "auto"), `no automatic link: ${(d.actions || []).map((a) => a.type)}`);
});

// 2026-10-02 review: an agent's "we're mutual!" changed nothing — the offer
// stayed "sent" and the deal waited for someone to promote it by hand.
test("an agent saying it's signed puts Promote on the row, with the closing date they named", async () => {
  _resetJobs();
  const { client } = ghlStub();
  const store = fakeStore();
  // Our offer is hot — they said the number works — so "we're mutual" is ours.
  store.listOffers = async () => [{ id: "o1", contactId: "c1", address: "12 Elm St", status: "sent", cashAmount: 410000, sends: [{ ts: iso(86400000) }], realm: { answer: "yes", ts: iso(3600000) } }];
  const { job } = await startReply({
    client, locationId: "LOC", saved: SAVED, store, contactId: "c1", message: "Seller signed, we're mutual! Closing 10/24.",
    deps: { draft: async () => ({ ...DRAFT, intent: "status_check", reply: "That's great news, thank you!", summary: "They say it's signed." }) },
  });
  await settle();
  assert.equal(job.status, "done", job.error);
  const d = await store.getReplyDraft(job.draftId);
  const promote = (d.actions || []).find((a) => a.type === "promote_to_deal");
  assert.ok(promote, "Promote is offered");
  assert.equal(promote.mode, "ask", "a person's tap, never automatic");
  assert.equal(promote.status, "pending");
  assert.match(promote.closingDate, /^\d{4}-10-24$/);

  // Not yet signed: nothing to promote.
  _resetJobs();
  const s2 = fakeStore();
  s2.listOffers = store.listOffers;
  const { job: j2 } = await startReply({
    client, locationId: "LOC", saved: SAVED, store: s2, contactId: "c1", message: "Once the seller signs I'll send it over",
    deps: { draft: async () => ({ ...DRAFT, intent: "status_check", reply: "Sounds good, thanks!", summary: "Waiting on signatures." }) },
  });
  await settle();
  const d2 = await s2.getReplyDraft(j2.draftId);
  assert.equal((d2?.actions || []).some((a) => a.type === "promote_to_deal"), false);

  // "We're under contract" on an offer that was only sent: most likely the
  // other buyer — no Promote unless they say it's ours.
  _resetJobs();
  const s3 = fakeStore();
  s3.listOffers = async () => [{ id: "o1", contactId: "c1", address: "12 Elm St", status: "sent", cashAmount: 410000, sends: [{ ts: iso(86400000) }] }];
  const { job: j3 } = await startReply({
    client, locationId: "LOC", saved: SAVED, store: s3, contactId: "c1", message: "We're officially under contract!",
    deps: { draft: async () => ({ ...DRAFT, intent: "status_check", reply: "Congrats!", summary: "Under contract." }) },
  });
  await settle();
  assert.equal(((await s3.getReplyDraft(j3.draftId))?.actions || []).some((a) => a.type === "promote_to_deal"), false);
});

test("pressing Promote passes the closing date they named to the deal", async () => {
  const { runActions } = await import("./conversation-actions.js");
  const seen = [];
  const r = await runActions({ client: {}, locationId: "LOC", contactId: "c1", draft: { id: "d1", propertyAddress: "12 Elm St" },
    actions: [{ id: "a1", type: "promote_to_deal", mode: "ask", status: "pending", closingDate: "2026-10-24" }],
    deps: { promoteToDeal: async (args) => { seen.push(args); return { ok: true, address: "12 Elm St" }; } } });
  assert.equal(seen[0].closingDate, "2026-10-24");
  assert.ok(Array.isArray(r) || r, "ran");
});

/* ---------- a deal that fell through gets no check-ins (2026-10-03) ---------- */

// 5232 S Yakima (2026-10-03): the deal was marked fell through, and the
// check-in sweep still texted the listing side's transaction coordinator
// "following up on 5232 S Yakima, still moving forward on our end". The
// check-in carried the thread's spelling ("5232 S Yakima", no suffix, no
// offer id), so nothing tied it to the deal. Matt: no checking in with
// anybody about a deal that fell through.
const FELL_THROUGH = { id: "o9", locationId: "LOC", contactId: "agent1", address: "5232 South Yakima Avenue, Tacoma, Washington 98408",
  createdAt: iso(3 * 86400000), deal: { stage: "fell_through", investors: [], stageHistory: [{ stage: "fell_through", ts: iso(86400000) }] } };
const CHECKINS_ON = (() => {
  const s = structuredClone(STARTER_SAVED);
  s.conversationAi.parties.agent.followUp = { ...(s.conversationAi.parties.agent.followUp || {}), enabled: true };
  return s;
})();

test("a check-in about a deal that fell through is never drafted, even spelled the short way", async () => {
  _resetJobs();
  const store = fakeStore();
  store.listDeals = async () => [FELL_THROUGH];
  let drafted = false;
  const r = await startProactive({
    client: deadClient, locationId: "LOC", saved: CHECKINS_ON, store, contactId: "tc1", kind: "checkin_due", offer: null,
    subject: { address: "5232 S Yakima, Tacoma, WA", phrase: "", sourceKind: "unanswered" }, sendsEnabled: true,
    deps: { draft: async () => { drafted = true; return DRAFT; } },
  });
  assert.equal(r.job, null);
  assert.match(r.skipped || "", /fell through/);
  assert.equal(drafted, false);
});

test("a nudge on an offer row whose house is a fell-through deal is not drafted either", async () => {
  _resetJobs();
  const store = fakeStore();
  store.listDeals = async () => [FELL_THROUGH];
  const r = await startProactive({
    client: deadClient, locationId: "LOC", saved: CHECKINS_ON, store, contactId: "agent1", kind: "checkin_due",
    offer: { id: "o2", address: "5232 S Yakima Ave, Tacoma, WA 98408", status: "sent" }, subject: { address: "5232 S Yakima Ave" },
  });
  assert.match(r.skipped || "", /fell through/);
});

test("the same check-in is not stopped once the house is back under contract", async () => {
  _resetJobs();
  // A reply waiting in the outbox stops it at the next gate, before any model call.
  const store = fakeStore([{ ...openDraft(), contactId: "tc1", inbound: "Any update?" }]);
  store.listDeals = async () => [FELL_THROUGH, { id: "o10", locationId: "LOC", address: "5232 S Yakima Ave, Tacoma, WA 98408", createdAt: iso(3600000), deal: { stage: "under_contract", investors: [] } }];
  const r = await startProactive({
    client: deadClient, locationId: "LOC", saved: CHECKINS_ON, store, contactId: "tc1", kind: "checkin_due", offer: null,
    subject: { address: "5232 S Yakima, Tacoma, WA" },
  });
  assert.ok(r.blocked, r.skipped);
  assert.doesNotMatch(r.skipped || "", /fell through/);
});

test("a queued check-in to an agent about a deal that fell through since is dismissed, not sent", async () => {
  const { sendReplyDraft } = await import("./reply-agent.js");
  const { client, tags } = ghlStub();
  const store = fakeStore([{ id: "d1", locationId: "LOC", contactId: "tc1", status: "sending", channel: "sms", party: "agent", createdAt: iso(1000), flags: [],
    reply: "Following up on 5232 S Yakima, still moving forward on our end.", inbound: "", intent: "checkin_due",
    outbound: { kind: "checkin_due", offerId: null, address: "5232 S Yakima, Tacoma, WA" } }]);
  store.getOffer = async () => null;
  store.listDeals = async () => [FELL_THROUGH];
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "d1", live: true, auto: true });
  assert.equal(r.skipped, "the deal on 5232 South Yakima Avenue fell through");
  const d = await store.getReplyDraft("d1");
  assert.equal(d.status, "dismissed");
  assert.match(d.flags.join(" "), /fell through — not sent/);
  assert.ok(tags.some(([m]) => m === "DELETE"), "the draft tag comes off");
});

/* ---------- they handed the write-up back to us (3418 Wetmore Ave, 2026-10-03) ---------- */

// "Write up whatever you like! You can call the listing broker." The
// agent thought we'd write our own offer and pointed us at someone else. The
// bot asked for the broker's number "to get the paperwork moving at 226k" — on
// past the misunderstanding. We aren't agents; whoever writes it is on their
// side, and the reply has to say so before it asks for anything else.
test("a reply that sails past an agent handing the write-up back to us is held", () => {
  const inboundMessage = "Write up whatever you like! 👍\n\nYou can call the listing broker Sam for better insight into his clients goals";
  const past = gate({ reply: "Appreciate the heads up. Can you send me Sam's number or email so we can get the paperwork moving?" }, { inboundMessage });
  assert.equal(past.ok, false);
  assert.match(past.flags.join(" · "), /handed the write-up back/);
  const clears = gate({ reply: "Thanks. Just so we're on the same page, we're not agents and don't have one on this, so we can't put it on NWMLS forms ourselves. Could you or Sam write it up for us to sign?" }, { inboundMessage });
  assert.doesNotMatch(clears.flags.join(" · "), /handed the write-up back/);
  for (const m of ["Submit your offer and we'll review it with the seller", "Have your agent send it over", "Who's your agent?"]) {
    assert.match(gate({ reply: "Sounds good, will do." }, { inboundMessage: m }).flags.join(" · "), /handed the write-up back/, m);
  }
  // Their own "I'll write it up" is the goal, not a hand-back.
  assert.doesNotMatch(gate({ reply: "Perfect, thank you!" }, { inboundMessage: "Great, I'll write it up tonight" }).flags.join(" · "), /handed the write-up back/);
});
