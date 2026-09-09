import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReplyGates, moneyIn, summarizeOffers, countToday, startReply,
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
  assert.match(lines[1], /12 Elm St.*our cash offer \$410,000 \(asking \$525,000\) — status: sent, waiting on the agent sent 13 days ago by sms valid through Sep 5/);
  assert.match(lines[2], /7 Pine Ct.*\$300,000.*agent passed.*note: went with a retail buyer/);
  assert.deepEqual([...s.amounts].sort((a, b) => a - b), [300000, 410000, 525000]);
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
  assert.equal(seen.instructions, "Sign as Matt.");
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

test("a contact has their own daily cap", async () => {
  _resetJobs();
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, jobId: `ra-${i}`, locationId: "LOC", contactId: "c1", createdAt: iso(60_000), status: "sent" }));
  const store = fakeStore(rows);
  assert.equal(await countTodayForContact({ store, locationId: "LOC", contactId: "c1" }), 12);
  const r = await startReply({ client: deadClient, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c1", message: "hi" });
  assert.match(r.skipped, /this contact's daily cap reached \(12\/12\)/);
  const other = await startReply({ client: deadClient, locationId: "LOC", saved: STARTER_NOW, store, contactId: "c2", message: "hi" });
  assert.ok(other.job, "another contact is unaffected");
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
  assert.match(seen2.context.text, /\[our math: ARV \$620,000, repairs \$55,000\]/);
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
  assert.deepEqual(calls.find((c) => c[0] === "afterAgentTake")[1], { contactId: "c1", address: "12 Elm St, Renton, WA 98056" });
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

test("an investor is never released by the band — it is an agent feature; only the calendar reaches investors", () => {
  assert.deepEqual(GUARDED_AUTO.investor, ["wants_call", "wants_walkthrough"]);
  const base = { send: false, code: "never_auto", reason: "price pushback is a person's call" };
  assert.equal(releaseUnderGuard({ base, party: "investor", intent: "price_pushback", config: bandOn(), guard: passing }).send, false);
  // a passing BAND guard on a scheduling intent is the wrong guard
  assert.equal(releaseUnderGuard({ base, party: "investor", intent: "wants_call", config: bandOn(), guard: passing }).send, false);
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
  cashAmount: 265000, arv: 500000, repairs: 85000, status: "sent", createdAt: iso(2000),
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

test("the band reads the offer book and opens on a counter inside the ceiling", async () => {
  const v = await evaluateBandFor({
    store: bandStore(), locationId: "LOC", party: "agent", config: bandCfg, saved: {},
    draft: { intent: "counter", counterAmount: 280000, confidence: "high", propertyAddress: BAND_OFFER.address },
    job: { contactId: "c1", message: "seller would do $280,000" }, now: Date.now(),
  });
  assert.equal(v.passed, true, v.reason);
  assert.ok(v.ceiling > 265000);
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
    draft: { intent: "counter", counterAmount: 280000, confidence: "high", propertyAddress: BAND_OFFER.address },
    job: { contactId: "c1", message: "$280,000" },
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
