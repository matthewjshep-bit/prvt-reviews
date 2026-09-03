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
  reply: "Yes, still interested — our $410,000 cash offer on 12 Elm stands through Friday.",
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
  for (const i of ["counter", "acceptance", "wants_call", "scheduling", "proof_of_funds", "new_property", "other"]) {
    assert.equal(AUTO_SENDABLE_INTENTS.has(i), false, i);
  }
  assert.equal(AUTO_SENDABLE_INTENTS.has("question"), true);
  assert.equal(AUTO_SENDABLE_INTENTS.has("rejection"), true);
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
  assert.match(notes[0], /Needs you because: a counter is a person's call; the agent named a higher number/);
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
