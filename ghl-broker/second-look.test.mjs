// second-look.test.mjs — the second look at a strong past offer, end to end:
// the morning sweep picks it, startProactive drafts it at our same number and
// no other, and the send leaves the record its next one is counted from.
// Offline: the model, GHL and the store are all stubbed.

import test from "node:test";
import assert from "node:assert/strict";
import { startFollowUpSweep, getFollowUpJob, secondLookCandidates, _resetJobs as resetSweeps } from "./follow-up-sweep.js";
import { startProactive, sendReplyDraft, _resetJobs as resetReplies } from "./reply-agent.js";
import { outboundOpening } from "./conversation-prompt.js";
import { normalizeConversationAi } from "./shared/conversation-ai.js";
import { effectiveStatus } from "./shared/offer-status.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-16T17:00:00Z");   // 10am Pacific, the sweep's morning
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const settleSweep = async () => {
  await pause(20);
  const until = Date.now() + 5000;
  while (getFollowUpJob("LOC")?.status === "running" && Date.now() < until) await pause(5);
};

const configWith = ({ secondLook = { enabled: true }, autoSend = { enabled: true, intents: ["question"] } } = {}) => normalizeConversationAi({
  enabled: true,
  autoSend: { channels: ["sms"], minConfidence: "medium", holdOnNeedsHuman: false, debounceSec: 0, weekends: "all" },
  parties: {
    agent: {
      autoSend,
      followUp: { enabled: true, ladders: { offer_nudge: { enabled: true, steps: [3, 7], repeatEvery: 0 } }, secondLook },
    },
  },
});
const SAVED = { aiApiKey: "k", company: { signer: "Matt Shepherd" }, conversationAi: configWith() };
const OFF = { ...SAVED, conversationAi: configWith({ secondLook: { enabled: false } }) };

// Invented agent and houses. Our 380K went out on paper; they passed a month
// ago at the seller's 410K.
const anOffer = (over = {}) => ({
  id: "o1", locationId: "LOC", contactId: "c1", contactName: "Dana Agent", address: "1418 Alder Ln, Kent, WA 98031",
  cashAmount: 380000, status: "passed", statusAt: ago(30), createdAt: ago(45),
  sends: [{ ts: ago(44), channels: ["sms"], results: { sms: { ok: true } } }],
  counter: { amount: 410000, at: ago(35) }, ...over,
});
const theirTexts = (contactId = "c1", street = "1418 Alder Ln") => [
  { id: `${contactId}-in1`, locationId: "LOC", contactId, status: "handled", inbound: "Seller is hoping for closer to 410", intent: "counter", propertyAddress: street, createdAt: ago(35) },
  { id: `${contactId}-in2`, locationId: "LOC", contactId, status: "handled", inbound: "They're going to pass for now", intent: "rejection", propertyAddress: street, createdAt: ago(30) },
];

/* ---------- a store with offers, drafts and a timeline ---------- */

const fakeStore = ({ offers = [], drafts = [], events = [] } = {}) => {
  const evRows = [...events];
  const rows = new Map(drafts.map((d) => [d.id, d]));
  const store = {
    offers: new Map(offers.map((o) => [o.id, o])),
    events: evRows, rows, cursors: new Map(),
    async listOffersForFollowUp(_loc, { statuses = [], before = null, since = null } = {}) {
      const want = new Set(statuses);
      const at = (o) => o.statusAt || o.createdAt || "";
      return [...store.offers.values()].filter((o) => want.has(effectiveStatus(o)))
        .filter((o) => !before || at(o) <= before).filter((o) => !since || at(o) >= since);
    },
    async listOffers(_loc, { contactId = null } = {}) { return [...store.offers.values()].filter((o) => !contactId || o.contactId === contactId); },
    async getOffer(id) { return store.offers.get(id) || null; },
    async updateOffer(id, doc) { store.offers.set(id, doc); return true; },
    async listContactEventsSince(_loc, since, { types = null } = {}) { return evRows.filter((e) => e.at >= since && (!types || types.includes(e.type))); },
    async listContactEvents(_loc, contactId, { types = null } = {}) {
      return evRows.filter((e) => e.contactId === contactId && (!types || types.includes(e.type))).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    },
    async appendContactEvents(_loc, contactId, list) {
      let inserted = 0;
      for (const r of list) {
        if (r.dedupeKey && evRows.some((e) => e.contactId === contactId && e.dedupeKey === r.dedupeKey)) continue;
        evRows.push({ ...r, contactId }); inserted++;
      }
      return { inserted, skipped: list.length - inserted };
    },
    async getContactProfile() { return null; },
    async upsertContactProfile() { return {}; },
    async getJobCursor(loc, name) { return store.cursors.get(`${loc}|${name}`) || null; },
    async setJobCursor(loc, name, v) { store.cursors.set(`${loc}|${name}`, v); return v; },
    async listReplyDrafts(_loc, { status = null, contactId = null, since = null } = {}) {
      const want = Array.isArray(status) ? new Set(status) : status ? new Set([status]) : null;
      return [...rows.values()].filter((d) => (!want || want.has(d.status)) && (!contactId || d.contactId === contactId) && (!since || d.createdAt >= since));
    },
    async getReplyDraft(id) { return rows.get(id) || null; },
    async updateReplyDraft(id, doc) { if (!rows.has(id)) return false; rows.set(id, doc); return true; },
    async createReplyDraft(doc) { const full = { ...doc, id: `d${rows.size + 1}`, createdAt: new Date().toISOString() }; rows.set(full.id, full); return full; },
  };
  return store;
};

const spySweep = (store, saved = SAVED) => {
  const started = [];
  const job = startFollowUpSweep({
    client: {}, locationId: "LOC", saved, store, sendsEnabled: true, now: NOW,
    deps: { paceMs: 0, startProactive: async (args) => { started.push(args); return { skipped: null, job: { id: `j${started.length}` } }; } },
  });
  return { job, started };
};

/* ---------- the morning sweep picks it ---------- */

test("a passed offer the seller came close on, from an agent who talked to us, gets a second look on the morning sweep", async () => {
  resetSweeps();
  const store = fakeStore({ offers: [anOffer()], drafts: theirTexts() });
  const { job, started } = spySweep(store);
  await settleSweep();
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 1, JSON.stringify(job.results));
  const s = started[0];
  assert.equal(s.kind, "second_look");
  assert.equal(s.offer.id, "o1");
  assert.equal(s.subject.theirs, 410000);
  assert.equal(s.subject.source, "counter");
  assert.equal(s.subject.step, 1);
  // Its own switch is the say-so: a clean draft sends itself.
  assert.equal(s.deps.releaseHeld, true);
  // Claimed before it was started, with why, and the offer remembers it.
  const claim = store.events.find((e) => e.type === "follow_up_sent" && e.data?.kind === "second_look");
  assert.ok(claim, "claimed");
  assert.match(claim.data.why, /their counter 410K is 7\.9% over our 380K/);
  assert.equal(store.offers.get("o1").followUps.at(-1).kind, "second_look");

  // The same morning again: already claimed, nothing new.
  resetSweeps();
  const again = spySweep(store);
  await settleSweep();
  assert.equal(again.started.length, 0);
});

test("with the switch off, no past offer is asked about — the preview still shows who would be", async () => {
  resetSweeps();
  const store = fakeStore({ offers: [anOffer()], drafts: theirTexts() });
  const { job, started } = spySweep(store, OFF);
  await settleSweep();
  assert.equal(job.status, "done", job.error);
  assert.equal(started.length, 0);
  const config = normalizeConversationAi(OFF.conversationAi);
  assert.deepEqual(await secondLookCandidates({ store, locationId: "LOC", config, now: NOW }), []);
  const preview = await secondLookCandidates({ store, locationId: "LOC", config, now: NOW, ignoreSwitch: true });
  assert.equal(preview.length, 1);
  assert.equal(preview[0].offerId, "o1");
});

test("one house per agent: the one closest to our number, never a row the house moved past", async () => {
  resetSweeps();
  const far = anOffer({ id: "o-far", address: "22 Pine Pl, Kent, WA 98031", counter: { amount: 425000, at: ago(35) } });        // 11.8%
  const near = anOffer({ id: "o-near", address: "9 Spruce St, Kent, WA 98031", cashAmount: 300000, counter: { amount: 309000, at: ago(35) } }); // 3%
  // An older row on the near house, closer still — but a newer row replaced it.
  const old = anOffer({ id: "o-old", address: "9 Spruce St, Kent, WA 98031", cashAmount: 305000, counter: { amount: 306000, at: ago(70) },
    createdAt: ago(80), statusAt: ago(70), sends: [{ ts: ago(79), results: { sms: { ok: true } } }] });
  const store = fakeStore({ offers: [far, near, old], drafts: [...theirTexts("c1", "9 Spruce St")] });
  const { started } = spySweep(store);
  await settleSweep();
  assert.equal(started.length, 1);
  assert.equal(started[0].offer.id, "o-near");
});

/* ---------- the draft: our same number, nothing else ---------- */

function ghlStub() {
  const sent = [];
  const client = {
    call: async (path, opts = {}) => {
      if (/^\/contacts\/c1$/.test(path) && !opts.method) return { contact: { id: "c1", firstName: "Dana", lastName: "Agent", phone: "+12065550100", tags: ["agent"] } };
      if (path.endsWith("/notes") || path.endsWith("/tags")) return {};
      if (path.startsWith("/conversations/search")) return { conversations: [] };
      if (path === "/conversations/messages") { sent.push(opts.body); return { messageId: "m1" }; }
      if (path.endsWith("/customFields")) return { customFields: [] };
      if (/^\/contacts\/c1$/.test(path)) return { contact: {} };
      throw new Error(`unexpected ${path}`);
    },
  };
  return { client, sent };
}
const draftSaying = (reply) => async () => ({ intent: "second_look", confidence: "high", needsHuman: false, humanReason: "", reply,
  summary: "Second look at 1418 Alder.", propertyAddress: "1418 Alder Ln", counterAmount: 0 });
const settle = () => pause(40);

test("the second look says our same number, the money guard lets exactly that through, and it sends itself under its switch", async () => {
  resetReplies();
  const { client } = ghlStub();
  const store = fakeStore({ offers: [anOffer()], drafts: theirTexts() });
  const r = await startProactive({ client, locationId: "LOC", saved: SAVED, store, contactId: "c1", kind: "second_look", offer: anOffer(),
    subject: { address: anOffer().address, step: 1, steps: [], theirs: 410000, source: "counter" }, sendsEnabled: true,
    deps: { draft: draftSaying("Hi Dana, on 1418 Alder, if the seller is still open to it we can still do 380K. Worth a quick call?"),
      releaseHeld: true, releaseReason: "the second look may send itself (followUp.secondLook)", now: () => NOW, random: () => 0 } });
  assert.equal(r.skipped, null, r.skipped);
  await settle();
  assert.equal(r.job.status, "done", r.job.error || r.job.heldReason);
  const d = await store.getReplyDraft(r.job.draftId);
  assert.equal(d.intent, "second_look");
  assert.equal(d.outbound.amount, 380000);
  assert.equal(d.outbound.offerStatus, "passed");
  assert.equal(d.gateClean, true, d.flags.join(" · "));
  assert.equal(d.status, "scheduled", d.autoSend?.reason);
  assert.match(d.summary, /1418 Alder/);
});

test("a second look that names more than our number never goes — not even the book rounded up", async () => {
  for (const [cash, says] of [[380000, "we could stretch to 395K"], [377552, "we can still do 378K"]]) {
    resetReplies();
    const { client } = ghlStub();
    const o = anOffer({ cashAmount: cash });
    const store = fakeStore({ offers: [o], drafts: theirTexts() });
    const r = await startProactive({ client, locationId: "LOC", saved: SAVED, store, contactId: "c1", kind: "second_look", offer: o,
      subject: { address: o.address, step: 1, steps: [] }, sendsEnabled: true,
      deps: { draft: draftSaying(`Hi Dana, on 1418 Alder ${says} if the seller is open. Worth a quick call?`), releaseHeld: true, now: () => NOW } });
    await settle();
    assert.equal(r.job.status, "held", `${says}: ${r.job.error || ""}`);
    assert.match(r.job.heldReason, /dropped, not sent/);
    assert.equal([...store.rows.values()].filter((x) => x.outbound?.kind === "second_look").length, 0, `${says}: nothing waits on the Desk`);
  }
});

test("a too-long second look is written again, and with the switch off none is started", async () => {
  resetReplies();
  const off = await startProactive({ client: ghlStub().client, locationId: "LOC", saved: OFF, store: fakeStore({ offers: [anOffer()] }), contactId: "c1",
    kind: "second_look", offer: anOffer(), subject: { address: anOffer().address } });
  assert.match(off.skipped, /second look is off/);

  resetReplies();
  const { client } = ghlStub();
  const store = fakeStore({ offers: [anOffer()], drafts: theirTexts() });
  let calls = 0;
  const long = `Hi Dana, ${"just wanted to circle back on this one again because we really liked it ".repeat(4)}we can still do 380K. Worth a call?`;
  const r = await startProactive({ client, locationId: "LOC", saved: SAVED, store, contactId: "c1", kind: "second_look", offer: anOffer(),
    subject: { address: anOffer().address }, sendsEnabled: true,
    deps: { draft: async (args) => { calls++; return (await draftSaying(args.outbound?.fix ? "Hi Dana, if the seller on 1418 Alder is still open we can still do 380K. Worth a quick call?" : long)()); },
      releaseHeld: true, now: () => NOW, random: () => 0 } });
  await settle();
  assert.equal(calls, 2, "written once more, told why");
  const d = await store.getReplyDraft(r.job.draftId);
  assert.ok(d.reply.length <= 240);
});

/* ---------- the prompt ---------- */

test("the second look prompt names the street and our same number, asks for a call, and never asks whether it sold", () => {
  const t = outboundOpening({ kind: "second_look", address: "1418 Alder Ln, Kent, WA 98031", street: "1418 Alder Ln", oursK: "380K", offerStatus: "passed", step: 1, maxChars: 240 });
  assert.match(t, /1418 Alder Ln/);
  assert.match(t, /we can still do 380K/);
  assert.match(t, /our same number/);
  assert.match(t, /worth a quick call/);
  assert.match(t, /Do NOT ask whether it sold/);
  assert.match(t, /never hint that we'd go higher/);
  assert.match(t, /under 240 characters/);
  assert.match(t, /Phone carriers block/, "carrier-checked like the check-ins");
  assert.match(t, /Set intent to second_look/);
  assert.match(outboundOpening({ kind: "second_look", address: "x", street: "x", oursK: "380K", offerStatus: "passed", step: 2 }), /asked once before/);
});

/* ---------- the send ---------- */

const lookDraft = (over = {}) => ({
  id: "s1", locationId: "LOC", contactId: "c1", status: "scheduled", channel: "sms", party: "agent", intent: "second_look", inbound: "",
  reply: "Hi Dana, on 1418 Alder, if the seller is still open to it we can still do 380K. Worth a quick call?",
  outbound: { kind: "second_look", offerId: "o1", address: "1418 Alder Ln, Kent, WA 98031", amount: 380000, offerStatus: "passed", statusAt: ago(30), step: 1 },
  propertyAddress: "1418 Alder Ln, Kent, WA 98031", createdAt: new Date(NOW - 3600000).toISOString(), sendAt: new Date(NOW).toISOString(), flags: [], ...over,
});

test("a second look that goes leaves second_look_sent, which the next one is counted from", async () => {
  const { client, sent } = ghlStub();
  const store = fakeStore({ offers: [anOffer()], drafts: [lookDraft()] });
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "s1", live: true, auto: true, now: NOW, readThread: async () => "" });
  assert.equal(r.skipped, undefined, r.skipped);
  assert.equal(sent.length, 1);
  const ev = store.events.find((e) => e.type === "second_look_sent");
  assert.ok(ev);
  assert.equal(ev.offerId, "o1");
  assert.equal(ev.data.amount, 380000);
});

test("a second look on our pass over their counter goes; one we passed on again since it was drafted doesn't", async () => {
  const pass = { status: "we_passed", statusAt: ago(30), statusNote: "held at 380K; 2 check-ins and they didn't move", counterHold: { at: ago(40), ours: 380000 } };
  const { client, sent } = ghlStub();
  const store = fakeStore({ offers: [anOffer(pass)], drafts: [lookDraft({ outbound: { ...lookDraft().outbound, offerStatus: "we_passed", statusAt: ago(30) } })] });
  const r = await sendReplyDraft({ client, store, locationId: "LOC", draftId: "s1", live: true, auto: true, now: NOW, readThread: async () => "" });
  assert.equal(r.skipped, undefined, r.skipped);
  assert.equal(sent.length, 1);

  // Marked we passed by hand after the second look was drafted: binned.
  const store2 = fakeStore({ offers: [anOffer({ ...pass, statusAt: new Date(NOW - 600000).toISOString() })], drafts: [lookDraft()] });
  const r2 = await sendReplyDraft({ client, store: store2, locationId: "LOC", draftId: "s1", live: true, auto: true, now: NOW, readThread: async () => "" });
  assert.match(r2.skipped, /we passed on 1418 Alder/);
  assert.equal(sent.length, 1, "nothing more went");
  assert.equal((await store2.getReplyDraft("s1")).status, "dismissed");
});
